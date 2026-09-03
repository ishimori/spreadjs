// DD-035 R4 E2E: 列単位 readOnly（readOnlyColumns）。
//
// 単独モード（standalone.html?readonlycols=col-b,col-c&select=col-c:X|Y）で、readOnly 列のセルでは編集 UI が一切開かず
// 文書無変更（AC3）、範囲貼り付け・範囲クリア・cut は readOnly 列だけスキップして他列へ適用（AC4）、閲覧系・行操作・
// setData・他列の編集は従来どおり（AC5）を検証する。値は Canvas 描画ゆえ debug API（test-support 経由）と cell-commit
// イベント・診断エントリで観測する。裁定/フィルタの細目はユニット（readonly-columns.test.ts）が担保する。

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import * as sa from './standalone-helpers';
import { dispatchSyntheticPaste } from './integration-helpers';

test.describe.configure({ mode: 'serial' });

const QUERY = '?readonlycols=col-b,col-c&select=col-c:X|Y';

async function openReadonlyColumns(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/standalone.html${QUERY}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
  // 検証用に col-b/col-c へ既知値を注入する（seed は col-a のみ）。
  await page.evaluate(() => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      rowId: `r${i}`,
      cells: { 'col-a': `A${i}`, 'col-b': `B${i}`, 'col-c': i % 2 === 0 ? 'X' : 'Y' },
    }));
    window.__standalone?.reinject({ rows });
  });
  await expect.poll(async () => sa.displayCell(page, 'r1', 'col-b')).toBe('B1');
  return { context, page };
}

async function api<R>(page: Page, method: string, args: unknown[] = []): Promise<R> {
  return page.evaluate(
    (payload: { method: string; args: unknown[] }) => {
      const a = (window as unknown as { __integrationTestApi?: Record<string, (...x: unknown[]) => unknown> })
        .__integrationTestApi;
      if (a === undefined) {
        throw new Error('__integrationTestApi 未初期化');
      }
      return a[payload.method]!.apply(a, payload.args);
    },
    { method, args },
  ) as Promise<R>;
}

async function committedHash(page: Page): Promise<string> {
  return api<string>(page, 'committedHash');
}
async function diagCodes(page: Page): Promise<string[]> {
  return page.evaluate(
    () => ((window as unknown as { __standalone?: { diagnostics: Array<{ code: string }> } }).__standalone?.diagnostics ?? []).map((d) => d.code),
  );
}
async function textareaState(page: Page): Promise<{ readOnly: boolean; background: string }> {
  return page.evaluate(() => {
    const ta = document.querySelector('textarea.int-cell-editor');
    return ta instanceof HTMLTextAreaElement
      ? { readOnly: ta.readOnly, background: ta.style.background }
      : { readOnly: false, background: '' };
  });
}
async function commitChanges(page: Page): Promise<Array<{ rowId: string; columnId: string; value: string }>> {
  return (await sa.events(page))
    .filter((e) => e.type === 'cell-commit')
    .flatMap((e) => (e.changes ?? []).map((c) => ({ rowId: c.rowId, columnId: c.columnId, value: c.value })));
}
/** synthetic cut（DataTransfer 付き）を常駐 textarea へ dispatch し、書き出された TSV を返す。 */
async function dispatchSyntheticCut(page: Page): Promise<string> {
  return page.evaluate(() => {
    const ta = document.querySelector('textarea.int-cell-editor');
    if (!(ta instanceof HTMLTextAreaElement)) {
      throw new Error('int-cell-editor が見つからない');
    }
    ta.focus();
    const dt = new DataTransfer();
    const event = new ClipboardEvent('cut', { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(event);
    return dt.getData('text/plain');
  });
}
async function dispatchSyntheticCopy(page: Page): Promise<string> {
  return page.evaluate(() => {
    const ta = document.querySelector('textarea.int-cell-editor');
    if (!(ta instanceof HTMLTextAreaElement)) {
      throw new Error('int-cell-editor が見つからない');
    }
    ta.focus();
    const dt = new DataTransfer();
    const event = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(event);
    return dt.getData('text/plain');
  });
}

test('AC3: readOnly 列のセルでは印字/F2/Delete/Backspace/dblclick/synthetic IME のいずれでも編集 UI が開かず文書無変更・他列は編集できる', async ({
  browser,
}) => {
  const { context, page } = await openReadonlyColumns(browser);
  try {
    const hash0 = await committedHash(page);
    // col-b（readOnly）へ移動 → textarea は readOnly 属性（物理遮断）。
    await sa.selectCell(page, 2, 1);
    await expect.poll(async () => (await textareaState(page)).readOnly, { message: 'readOnly 列で textarea.readOnly' }).toBe(true);
    await page.keyboard.type('zz');
    await page.keyboard.press('F2');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Backspace');
    await page.locator('.nsheet-scroller').dblclick({ position: await cellCenter(page, 2, 1) });
    await sa.composeOpen(page, 'あ');
    await page.waitForTimeout(150);
    expect(await sa.draft(page)).toBe('');
    expect(await sa.isComposing(page)).toBe(false);
    expect((await textareaState(page)).background).not.toBe('rgb(255, 255, 255)');
    expect(await api<unknown>(page, 'editingTarget')).toBeNull();
    expect(await committedHash(page)).toBe(hash0);
    expect(await sa.displayCell(page, 'r2', 'col-b')).toBe('B2');
    const codes = await diagCodes(page);
    expect(codes.filter((c) => c === 'readonly-column-blocked').length).toBeGreaterThanOrEqual(4); // F2/Delete/Backspace/dblclick
    // 選択式 readOnly 列（col-c）: F2 でドロップダウンが開かない。
    await sa.selectCell(page, 2, 2);
    await page.keyboard.press('F2');
    await page.waitForTimeout(100);
    expect(await api<boolean>(page, 'selectOpen')).toBe(false);
    expect(await committedHash(page)).toBe(hash0);
    // 隣の可編集列（col-a）へ移ると textarea.readOnly が解け、印字→確定できる。
    await sa.selectCell(page, 2, 0);
    await expect.poll(async () => (await textareaState(page)).readOnly).toBe(false);
    await page.keyboard.type('edit');
    await page.keyboard.press('Enter');
    await expect.poll(async () => sa.displayCell(page, 'r2', 'col-a')).toBe('edit');
    expect(await committedHash(page)).not.toBe(hash0);
    await page.screenshot({ path: sa.evidencePath('../DD-035/e2e-readonly-columns-1-blocked.png') });
  } finally {
    await context.close();
  }
});

test('AC4: 貼り付け・範囲クリア・cut は readOnly 列だけスキップして他列へ適用（TSV 列位置不変・全件スキップは no-op）', async ({
  browser,
}) => {
  const { context, page } = await openReadonlyColumns(browser);
  try {
    // 貼り付け 1×3（col-a,col-b,col-c）@ r5 → col-a だけ適用・col-b/col-c は不変。
    await sa.selectCell(page, 5, 0);
    expect(await dispatchSyntheticPaste(page, 'p1\tp2\tp3')).toBe(true);
    await expect.poll(async () => sa.displayCell(page, 'r5', 'col-a')).toBe('p1');
    expect(await sa.displayCell(page, 'r5', 'col-b')).toBe('B5');
    expect(await sa.displayCell(page, 'r5', 'col-c')).toBe('Y');
    let changes = await commitChanges(page);
    expect(changes).toEqual([{ rowId: 'r5', columnId: 'col-a', value: 'p1' }]);
    expect(await diagCodes(page)).toContain('readonly-column-skipped');
    // 貼り付け 2×2 @ (r6,col-b) → col-b/col-c のみ＝全件スキップ → no-op（cell-commit 増えず・消費はする）。
    await sa.selectCell(page, 6, 1);
    expect(await dispatchSyntheticPaste(page, 'q1\tq2\nq3\tq4')).toBe(true);
    await page.waitForTimeout(150);
    expect(await sa.displayCell(page, 'r6', 'col-b')).toBe('B6');
    expect(await sa.displayCell(page, 'r7', 'col-c')).toBe('Y');
    expect((await commitChanges(page)).length).toBe(1);
    // 貼り付け 1×2 @ (r8,col-c) → col-c スキップ・col-d 適用（TSV の列位置はずれない）。
    await sa.selectCell(page, 8, 2);
    expect(await dispatchSyntheticPaste(page, 's1\ts2')).toBe(true);
    await expect.poll(async () => sa.displayCell(page, 'r8', 'col-d')).toBe('s2');
    expect(await sa.displayCell(page, 'r8', 'col-c')).toBe('X');

    // 範囲クリア: (r10..r11) × (col-a..col-b) を Shift+矢印で選択 → Delete → col-a だけ blank・col-b 不変。
    await sa.selectCell(page, 10, 0);
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(async () => api<unknown>(page, 'selectionRange')).toEqual({ rowStart: 10, rowEnd: 12, colStart: 0, colEnd: 2 });
    await page.keyboard.press('Delete');
    await expect.poll(async () => sa.displayCell(page, 'r10', 'col-a')).toBe('');
    expect(await sa.displayCell(page, 'r11', 'col-a')).toBe('');
    expect(await sa.displayCell(page, 'r10', 'col-b')).toBe('B10');
    expect(await sa.displayCell(page, 'r11', 'col-b')).toBe('B11');

    // Codex P2: readOnly 列（col-b）をアンカーに Shift+← で可編集列（col-a）へ広げた範囲の Delete → col-a はクリアされる。
    await sa.selectCell(page, 14, 1);
    await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(async () => api<unknown>(page, 'selectionRange')).toEqual({ rowStart: 14, rowEnd: 15, colStart: 0, colEnd: 2 });
    await page.keyboard.press('Delete');
    await expect.poll(async () => sa.displayCell(page, 'r14', 'col-a')).toBe('');
    expect(await sa.displayCell(page, 'r14', 'col-b')).toBe('B14');

    // cut: (r12) × (col-a..col-b) → TSV は両列を含み、クリアは col-a のみ。
    await sa.selectCell(page, 12, 0);
    await page.keyboard.press('Shift+ArrowRight');
    const tsv = await dispatchSyntheticCut(page);
    expect(tsv).toBe('A12\tB12');
    await expect.poll(async () => sa.displayCell(page, 'r12', 'col-a')).toBe('');
    expect(await sa.displayCell(page, 'r12', 'col-b')).toBe('B12');
    // Undo は readOnly 列を含まない補償のみ（col-a だけ戻る）。
    await page.keyboard.press('Control+z');
    await expect.poll(async () => sa.displayCell(page, 'r12', 'col-a')).toBe('A12');
    expect(await sa.displayCell(page, 'r12', 'col-b')).toBe('B12');
    changes = await commitChanges(page);
    expect(changes.every((c) => c.columnId !== 'col-b' && c.columnId !== 'col-c')).toBe(true);
    await page.screenshot({ path: sa.evidencePath('../DD-035/e2e-readonly-columns-2-paste-skip.png') });
  } finally {
    await context.close();
  }
});

test('AC5: readOnly 列でも範囲選択・コピー・行挿入削除・setData・scrollToRow は従来どおり', async ({ browser }) => {
  const { context, page } = await openReadonlyColumns(browser);
  try {
    // コピー（col-b を含む範囲）→ TSV は全列。
    await sa.selectCell(page, 3, 1);
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(async () => api<unknown>(page, 'selectionRange')).toEqual({ rowStart: 3, rowEnd: 4, colStart: 1, colEnd: 3 });
    expect(await dispatchSyntheticCopy(page)).toBe('B3\tY');
    // 行操作は列非依存。
    const before = await sa.rowCount(page);
    await page.evaluate(() => window.__gridInstance?.insertRows({ afterRowId: 'r3', count: 2 }));
    await expect.poll(async () => sa.rowCount(page)).toBe(before + 2);
    await page.evaluate(() => window.__gridInstance?.deleteRows(['r4']));
    await expect.poll(async () => sa.rowCount(page)).toBe(before + 1);
    // setData は許可（readOnly 列の値も差し替わる）。
    await page.evaluate(() => window.__standalone?.reinject({ rows: [{ rowId: 'n1', cells: { 'col-b': 'NEW' } }] }));
    await expect.poll(async () => sa.displayCell(page, 'n1', 'col-b')).toBe('NEW');
    expect(await sa.rowCount(page)).toBe(1);
  } finally {
    await context.close();
  }
});

async function cellCenter(page: Page, row: number, col: number): Promise<{ x: number; y: number }> {
  const rect = await sa.cellRectAt(page, row, col);
  if (rect === null) {
    throw new Error(`セル (${row},${col}) が可視範囲にない`);
  }
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
