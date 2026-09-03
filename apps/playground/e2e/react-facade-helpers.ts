// React Facade（DD-025）E2E の共有ヘルパー（testMatch 外・*.spec.ts のみがテスト本体）。
//
// 対象は react-standalone.html（@nanairo-sheet/react の <NanairoSheetView> を StrictMode 下で mount）。
// GridInstance は React Facade が隠蔽するため、getDebugApi は使わず **公開契約のみ**で検証する:
//   - 値の確認は onCellCommit.previousValue の round-trip（初期注入/再注入が表示に landed したかを間接検証）。
//   - セル座標は grid 既定 geometry（HEADER_WIDTH=52・HEADER_HEIGHT=24・ROW_HEIGHT=22・COL_WIDTH=80）から
//     r0/col-a 中心 =（92, 35）を決定的に算出してクリックする（cellRectAt に依らない）。
// synthetic composition は「配線が実ブラウザーで成立する」回帰確認であり実 IME ではない（実 IME は Manual Gate）。

import { fileURLToPath } from 'node:url';

import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** grid 既定 geometry から算出した r0/col-a 中心（scroller ローカル座標・無スクロール時）。 */
export const R0_COL_A = { x: 52 + 80 / 2, y: 24 + 22 / 2 } as const; // (92, 35)

/** react-standalone.html を開き、grid の初回描画（canvas 2 + 常駐 textarea）まで待つ。 */
export async function openReactStandalone(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto('/react-standalone.html');
  await waitReactReady(page);
  return { context, page };
}

/** StrictMode の二重 mount が settle し、#react-root に base+overlay canvas(2) と textarea(1) が揃うまで待つ。 */
export async function waitReactReady(page: Page): Promise<void> {
  await expect(page.locator('#react-root textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await expect
    .poll(async () => reactRootCounts(page).then((c) => `${c.canvas}/${c.textarea}`), {
      timeout: 30_000,
      message: 'React harness の grid が ready（canvas 2 / textarea 1）にならない',
    })
    .toBe('2/1');
}

export interface RootCounts {
  canvas: number;
  textarea: number;
  scroller: number;
}

/** #react-root 内の grid DOM 要素数（StrictMode/leak 検証用）。 */
export async function reactRootCounts(page: Page): Promise<RootCounts> {
  return page.evaluate(() => {
    const rootHost = document.getElementById('react-root');
    return {
      canvas: rootHost?.querySelectorAll('canvas').length ?? 0,
      textarea: rootHost?.querySelectorAll('textarea').length ?? 0,
      scroller: rootHost?.querySelectorAll('.nsheet-scroller').length ?? 0,
    };
  });
}

export interface CommitChange {
  rowId: string;
  columnId: string;
  value: string;
  previousValue: string;
}

export async function commitCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__reactStandalone?.commitCount() ?? -1);
}

export async function lastCommit(page: Page): Promise<CommitChange[] | null> {
  return page.evaluate(() => (window.__reactStandalone?.lastCommit() ?? null) as CommitChange[] | null);
}

export async function eventTypes(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.__reactStandalone?.events ?? []).map((e) => e.type));
}

export async function connectionState(page: Page): Promise<string> {
  return page.evaluate(() => window.__reactStandalone?.connectionState() ?? 'none');
}

/** r0/col-a を synthetic 日本語 IME で入力・確定する（standalone-helpers.composeCommitAtCell と同型・固定座標）。 */
export async function composeCommitR0ColA(page: Page, value: string): Promise<void> {
  const scroller = page.locator('#react-root .nsheet-scroller');
  await scroller.click({ position: { x: R0_COL_A.x, y: R0_COL_A.y } });
  await scroller.dblclick({ position: { x: R0_COL_A.x, y: R0_COL_A.y } });
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const ta = document.querySelector('#react-root textarea.int-cell-editor');
        return ta instanceof HTMLTextAreaElement ? ta.style.display : 'none';
      }),
    )
    .toBe('block');
  await page.evaluate((v: string) => {
    const ta = document.querySelector('#react-root textarea.int-cell-editor');
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

/** 証跡（スクショ）の保存先絶対パス（test-results/dd-evidence/DD-025/ 直下）。 */
export function evidencePath(fileName: string): string {
  return fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-025/${fileName}`, import.meta.url));
}

declare global {
  interface Window {
    __reactStandalone?: {
      readonly events: Array<{ type: string }>;
      readonly apiVersion: string;
      commitCount(): number;
      lastCommit(): CommitChange[] | null;
      mount(): void;
      unmount(): void;
      reinject(data: { rows: Array<{ rowId: string; cells?: Record<string, string> }> }): void;
      connectionState(): string;
      clearSaved(): void;
      resetCommits(): void;
      // DD-035 R7/R6: ref handle の命令 API（react-main.ts のブリッジ）。
      insertRows(options: { readonly afterRowId: string | null; readonly count?: number }): void;
      deleteRows(rowIds: readonly string[]): void;
      scrollToRow(rowId: string): void;
      setActiveCell(rowId: string, columnId: string): void;
      lastRowStructureChange(): unknown;
    };
  }
}
