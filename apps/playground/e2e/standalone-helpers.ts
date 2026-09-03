// 単独グリッドモード（DD-024）E2E の共有ヘルパー（testMatch 外・*.spec.ts のみがテスト本体）。
//
// 対象は standalone.html（共同編集サーバー不要）。値は Canvas に描かれ DOM から読めないため、
// window.__integrationTestApi（standalone-main.ts が getDebugApi で公開する読み取り introspection）で検証する。
// synthetic composition は「配線が実ブラウザーで成立する」ことの回帰確認であり実 IME ではない（実 IME は Manual Gate）。

import { fileURLToPath } from 'node:url';

import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 単独モードイベント（consumer 記録の最小 shape）。 */
export interface StandaloneEvent {
  type: string;
  changes?: Array<{ rowId: string; columnId: string; value: string; previousValue: string }>;
  phase?: string;
  message?: string;
  /** DD-027-2 link-open（type==='link-open' のとき）。 */
  rowId?: string;
  columnId?: string;
  value?: string;
}

async function callApi<R>(page: Page, method: string, args: unknown[] = []): Promise<R> {
  return page.evaluate(
    (payload: { method: string; args: unknown[] }) => {
      const api = (window as unknown as { __integrationTestApi?: Record<string, (...a: unknown[]) => unknown> })
        .__integrationTestApi;
      if (api === undefined) {
        throw new Error('window.__integrationTestApi 未初期化（boot 未完了）');
      }
      const fn = api[payload.method];
      if (typeof fn !== 'function') {
        throw new Error(`window.__integrationTestApi.${payload.method} が無い`);
      }
      return fn.apply(api, payload.args);
    },
    { method, args },
  ) as Promise<R>;
}

/** standalone.html を開き、初回描画（ready）まで待つ。 */
export async function openStandalone(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto('/standalone.html');
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await waitReady(page);
  return { context, page };
}

export async function waitReady(page: Page): Promise<void> {
  await expect
    .poll(async () => callApi<boolean>(page, 'ready'), { timeout: 30_000, message: '単独モードが ready にならない' })
    .toBe(true);
}

export async function connectionState(page: Page): Promise<string> {
  return page.evaluate(() => window.__standalone?.connectionState() ?? 'none');
}

export async function rowCount(page: Page): Promise<number> {
  return callApi<number>(page, 'rowCount');
}

export async function displayCell(page: Page, rowId: string, columnId: string): Promise<string> {
  return callApi<string>(page, 'displayCell', [rowId, columnId]);
}

export async function rowIdAt(page: Page, index: number): Promise<string | undefined> {
  return callApi<string | undefined>(page, 'rowIdAt', [index]);
}
export async function colIdAt(page: Page, index: number): Promise<string | undefined> {
  return callApi<string | undefined>(page, 'colIdAt', [index]);
}
export async function cellRectAt(page: Page, row: number, col: number): Promise<CellRect | null> {
  return callApi<CellRect | null>(page, 'cellRectAt', [row, col]);
}
export async function activeCell(page: Page): Promise<{ row: number; col: number }> {
  return callApi<{ row: number; col: number }>(page, 'activeCell');
}

// ---- DD-020-3 Undo/Redo introspection ----
export async function undoDepth(page: Page): Promise<number> {
  return callApi<number>(page, 'undoDepth');
}
export async function redoDepth(page: Page): Promise<number> {
  return callApi<number>(page, 'redoDepth');
}
export async function canUndo(page: Page): Promise<boolean> {
  return callApi<boolean>(page, 'canUndo');
}
export async function isComposing(page: Page): Promise<boolean> {
  return callApi<boolean>(page, 'isComposing');
}
export async function draft(page: Page): Promise<string> {
  return callApi<string>(page, 'draft');
}

/** 常駐 textarea で synthetic composition を開始し変換中のまま留める（isComposing:true・確定しない）。 */
export async function composeOpen(page: Page, value: string): Promise<void> {
  await page.evaluate((v: string) => {
    const ta = document.querySelector('textarea.int-cell-editor');
    if (!(ta instanceof HTMLTextAreaElement)) {
      throw new Error('int-cell-editor が見つからない');
    }
    ta.focus();
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    ta.value = v;
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: v, bubbles: true }));
  }, value);
}

export async function events(page: Page): Promise<StandaloneEvent[]> {
  return page.evaluate(() => (window.__standalone?.events ?? []) as StandaloneEvent[]);
}

/** 表示 (row,col) を選択して常駐 textarea を開く。 */
export async function selectCell(page: Page, row: number, col: number): Promise<void> {
  const rect = await cellRectAt(page, row, col);
  if (rect === null) {
    throw new Error(`セル (${row},${col}) が可視範囲にない`);
  }
  await page
    .locator('.nsheet-scroller')
    .click({ position: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } });
}

/** 表示 (row,col) セルを synthetic 日本語 IME で入力・確定する（consumer-app helpers と同型）。 */
export async function composeCommitAtCell(page: Page, row: number, col: number, value: string): Promise<void> {
  const rect = await cellRectAt(page, row, col);
  if (rect === null) {
    throw new Error(`セル (${row},${col}) が可視範囲にない`);
  }
  const pos = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const scroller = page.locator('.nsheet-scroller');
  await scroller.click({ position: pos });
  await scroller.dblclick({ position: pos });
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

/** 証跡（スクショ）の保存先絶対パス（doc/DD/DD-024/ 直下）。 */
export function evidencePath(fileName: string): string {
  return fileURLToPath(new URL(`../../../doc/DD/DD-024/${fileName}`, import.meta.url));
}

declare global {
  interface Window {
    __standalone?: {
      events: StandaloneEvent[];
      connectionState(): string;
      mount(): void;
      destroy(): void;
      reinject(data: { rows: Array<{ rowId: string; cells?: Record<string, string> }> }): void;
      clearSaved(): void;
    };
  }
}
