// consumer-app E2E ヘルパー（DD-016-2 Phase 3）。
//
// 【重要・S1-3】この E2E は **consumer の公開 API と DOM/WebSocket の外部観測だけ**で検証する:
//   - @nanairo-sheet/grid/test-support（getDebugApi 等の introspection）は使わない。
//   - leak 計測は addInitScript で window.WebSocket/rAF/setInterval を計装して外部から数える（consumer コードは無改変）。
//   - 状態は window.__consumer（GridInstance の公開イベント/connectionState）だけから読む。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, type Browser, type Page } from '@playwright/test';

/** 証跡の格納先（test-results/dd-evidence/DD-016-2/ 直下・絶対パス。scripts/consumer-app.sh の EVID と一致させること）。 */
export function evidencePath(fileName: string): string {
  const here = dirname(fileURLToPath(import.meta.url)); // consumer-app/e2e
  return join(here, '..', '..', 'test-results', 'dd-evidence', 'DD-016-2', fileName);
}

// consumer-app/src/main.ts が公開する観測ハンドル（テスト側の最小 ambient 宣言・test-support は使わない）。
interface ConsumerEvent {
  type: string;
  pendingCount?: number;
}
interface ConsumerHandle {
  events: ConsumerEvent[];
  connectionState(): string;
  mount(): void;
  destroy(): void;
}
declare global {
  interface Window {
    __consumer?: ConsumerHandle;
  }
}

const SERVE_PORT = 8791;
export const SERVE_ORIGIN = `http://127.0.0.1:${SERVE_PORT}`;

/** WebSocket / requestAnimationFrame / setInterval を計装して leak を外部観測可能にする（page 初期化前に注入）。 */
export function instrumentation(): void {
  interface LeakState {
    sockets: WebSocket[]; // 生成された全ソケット（open 数は readyState から算出＝close イベント取りこぼしに強い）
    totalSockets: number;
    activeRaf: number;
    activeIntervals: number;
  }
  const w = window as unknown as { __leakState: LeakState };
  const leak: LeakState = { sockets: [], totalSockets: 0, activeRaf: 0, activeIntervals: 0 };
  w.__leakState = leak;

  const OrigWS = window.WebSocket;
  class CountingWS extends OrigWS {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      leak.totalSockets += 1;
      leak.sockets.push(this);
    }
  }
  window.WebSocket = CountingWS as unknown as typeof WebSocket;

  const rafIds = new Set<number>();
  const origRAF = window.requestAnimationFrame.bind(window);
  const origCAF = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = origRAF((t) => {
      rafIds.delete(id);
      leak.activeRaf = rafIds.size;
      cb(t);
    });
    rafIds.add(id);
    leak.activeRaf = rafIds.size;
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => {
    rafIds.delete(id);
    leak.activeRaf = rafIds.size;
    origCAF(id);
  };

  const intervalIds = new Set<number>();
  const origSI = window.setInterval.bind(window);
  const origCI = window.clearInterval.bind(window);
  // @ts-expect-error テスト計装のため setInterval を薄くラップする（型は元と同等）。
  window.setInterval = (handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
    const id = origSI(handler, timeout, ...args);
    intervalIds.add(id);
    leak.activeIntervals = intervalIds.size;
    return id;
  };
  window.clearInterval = (id?: number): void => {
    if (id !== undefined) {
      intervalIds.delete(id);
      leak.activeIntervals = intervalIds.size;
    }
    origCI(id);
  };
}

export interface Counts {
  canvas: number;
  textarea: number;
  stage: number;
  openSockets: number;
  totalSockets: number;
  activeRaf: number;
  activeIntervals: number;
}

export async function counts(page: Page): Promise<Counts> {
  return page.evaluate(() => {
    const app = document.getElementById('app');
    const l = (
      window as unknown as {
        __leakState: { sockets: WebSocket[]; totalSockets: number; activeRaf: number; activeIntervals: number };
      }
    ).__leakState;
    // SDK（grid transport）の WS だけを数える（pathname==='/ws'）。vite dev の HMR WebSocket は
    // dev ツール由来のノイズ（本番不在）ゆえ除外する。open = readyState が CLOSED(3) でない数。
    const isSdkSocket = (url: string): boolean => {
      try {
        return new URL(url).pathname === '/ws';
      } catch {
        return false;
      }
    };
    const sdkSockets = l.sockets.filter((s) => isSdkSocket(s.url));
    const openSockets = sdkSockets.filter((s) => s.readyState !== 3).length;
    return {
      canvas: app?.querySelectorAll('canvas').length ?? 0,
      textarea: app?.querySelectorAll('textarea').length ?? 0,
      stage: app?.querySelectorAll('.nsheet-stage').length ?? 0,
      openSockets,
      totalSockets: sdkSockets.length,
      activeRaf: l.activeRaf,
      activeIntervals: l.activeIntervals,
    };
  });
}

/** consumer の公開 connectionState() を読む。 */
export async function connState(page: Page): Promise<string> {
  return page.evaluate(() => window.__consumer?.connectionState() ?? 'none');
}

/** GridInstance の公開イベントから最新の pendingCount を得る（無ければ -1）。 */
export async function pendingCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const evs = window.__consumer?.events ?? [];
    for (let i = evs.length - 1; i >= 0; i -= 1) {
      const e = evs[i] as { pendingCount?: number };
      if (typeof e.pendingCount === 'number') {
        return e.pendingCount;
      }
    }
    return -1;
  });
}

/** error / divergence の公開イベントを受けたか（受けたら異常）。 */
export async function hasErrorOrDivergence(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    (window.__consumer?.events ?? []).some((e) => e.type === 'error' || e.type === 'divergence'),
  );
}

/** base canvas（#app 内の最初の canvas＝セル値レイヤ）の描画シグネチャ（toDataURL）。反映で変化する。 */
export async function baseCanvasSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const app = document.getElementById('app');
    const canvas = app?.querySelector('canvas');
    return canvas instanceof HTMLCanvasElement ? canvas.toDataURL() : '';
  });
}

export async function waitOnline(page: Page, timeout = 30_000): Promise<void> {
  await expect
    .poll(async () => connState(page), { timeout, message: 'grid が online にならない' })
    .toBe('online');
}

/** 新しい独立クライアント（別 context）を開き、計装を注入して consumer-app をロードする。 */
export async function openClient(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript(instrumentation);
  await page.goto(`/?server=${encodeURIComponent(SERVE_ORIGIN)}&name=${encodeURIComponent(name)}`);
  return page;
}

/**
 * body セルをダブルクリックして常駐 textarea を開き、日本語 IME（synthetic composition）で value を入力し確定 Commit する。
 * ⚠️ synthetic composition は「状態遷移・配線が実ブラウザーで成立する」ことの回帰確認であって実 IME 成立ではない（実 IME は Phase 4 実機ゲート）。
 */
export async function composeCommitAtBodyCell(page: Page, value: string): Promise<void> {
  const scroller = page.locator('.nsheet-scroller');
  // 凍結列(col-a 幅80+header52)より右・凍結行より下の body セル。seedRows=60 で十分な行がある。
  await scroller.click({ position: { x: 180, y: 100 } });
  await scroller.dblclick({ position: { x: 180, y: 100 } });
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const ta = document.querySelector('textarea.int-cell-editor');
        return ta instanceof HTMLTextAreaElement ? ta.style.display : 'none';
      }),
    )
    .toBe('block');

  await page.evaluate((v: string) => {
    const ta = document.querySelector('textarea.int-cell-editor');
    if (!(ta instanceof HTMLTextAreaElement)) {
      throw new Error('int-cell-editor が見つからない');
    }
    ta.focus();
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    ta.value = v;
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: v, bubbles: true }));
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: v, bubbles: true }));
    ta.value = v;
    ta.dispatchEvent(
      new InputEvent('input', { inputType: 'insertCompositionText', data: v, isComposing: false, bubbles: true }),
    );
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', isComposing: false, bubbles: true }));
  }, value);
  await page.keyboard.press('Enter');
}
