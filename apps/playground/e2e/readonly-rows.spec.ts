// DD-036 C3 E2E: 行単位 readOnly（readOnlyRows）。
//
// 単独モード（standalone.html?readonlyrows=r2,r6,r10,r12,r14&select=col-c:X|Y）で、readOnly 行のセルでは編集 UI が
// 一切開かず文書無変更（AC5）、範囲貼り付け・範囲クリア・cut は readOnly 行だけスキップして他行へ適用（AC6）、
// 閲覧系・行操作・setData・他行の編集・未知 rowId の warn は従来どおり（AC7）を検証する。
// 列版（readonly-columns.spec.ts・DD-035 R4）の鏡像。値は Canvas 描画ゆえ debug API・cell-commit・診断で観測する。

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import * as sa from './standalone-helpers';
import { dispatchSyntheticPaste } from './integration-helpers';

test.describe.configure({ mode: 'serial' });

const READONLY_ROWS = ['r2', 'r6', 'r10', 'r12', 'r14'];
const QUERY = `?readonlyrows=${READONLY_ROWS.join(',')},r999&select=col-c:X|Y`;

async function openReadonlyRows(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/standalone.html${QUERY}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
  // 検証用に既知値を注入する（seed は col-a のみ）。
  await page.evaluate(() => {
    const rows = Array.from({ length: 20 }, (_v, i) => ({
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
    () =>
      ((window as unknown as { __standalone?: { diagnostics: Array<{ code: string }> } }).__standalone?.diagnostics ?? [])
        .map((d) => d.code),
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
async function dispatchSyntheticCut(page: Page): Promise<string> {
  return page.evaluate(() => {
    const ta = document.querySelector('textarea.int-cell-editor');
    if (!(ta instanceof HTMLTextAreaElement)) {
      throw new Error('int-cell-editor が見つからない');
    }
    ta.focus();
    const dt = new DataTransfer();
    ta.dispatchEvent(new ClipboardEvent('cut', { clipboardData: dt, bubbles: true, cancelable: true }));
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
    ta.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData('text/plain');
  });
}
async function cellCenter(page: Page, row: number, col: number): Promise<{ x: number; y: number }> {
  const rect = await sa.cellRectAt(page, row, col);
  if (rect === null) {
    throw new Error(`セル (${row},${col}) が可視範囲にない`);
  }
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

test('AC5: readOnly 行のセルでは印字/F2/Delete/Backspace/dblclick/synthetic IME のいずれでも編集 UI が開かず文書無変更・他行は編集できる', async ({
  browser,
}) => {
  const { context, page } = await openReadonlyRows(browser);
  try {
    const hash0 = await committedHash(page);
    // r2（readOnly 行）へ移動 → textarea は readOnly 属性（物理遮断）。
    await sa.selectCell(page, 2, 1);
    await expect
      .poll(async () => (await textareaState(page)).readOnly, { message: 'readOnly 行で textarea.readOnly' })
      .toBe(true);
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
    expect(codes.filter((c) => c === 'readonly-row-blocked').length).toBeGreaterThanOrEqual(4); // F2/Delete/Backspace/dblclick

    // 選択式列（col-c）でも readOnly 行ならドロップダウンが開かない。
    await sa.selectCell(page, 2, 2);
    await page.keyboard.press('F2');
    await page.waitForTimeout(100);
    expect(await api<boolean>(page, 'selectOpen')).toBe(false);
    expect(await committedHash(page)).toBe(hash0);

    // 直上の可編集行（r1）へ移ると textarea.readOnly が解け、印字→確定できる。
    await sa.selectCell(page, 1, 1);
    await expect.poll(async () => (await textareaState(page)).readOnly).toBe(false);
    await page.keyboard.type('edit');
    await page.keyboard.press('Enter');
    await expect.poll(async () => sa.displayCell(page, 'r1', 'col-b')).toBe('edit');
    expect(await committedHash(page)).not.toBe(hash0);
    await page.screenshot({ path: sa.evidencePath('../DD-036/e2e-readonly-rows-1-blocked.png') });
  } finally {
    await context.close();
  }
});

test('AC6: 貼り付け・範囲クリア・cut は readOnly 行だけスキップして他行へ適用（TSV 行位置不変・全件スキップは no-op）', async ({
  browser,
}) => {
  const { context, page } = await openReadonlyRows(browser);
  try {
    // 貼り付け 3×1（r5,r6,r7 の col-a）→ r6（readOnly）だけスキップ・行位置はずれない。
    await sa.selectCell(page, 5, 0);
    expect(await dispatchSyntheticPaste(page, 'p1\np2\np3')).toBe(true);
    await expect.poll(async () => sa.displayCell(page, 'r5', 'col-a')).toBe('p1');
    expect(await sa.displayCell(page, 'r6', 'col-a')).toBe('A6'); // スキップ（p2 は捨てられ、下へずれない）
    expect(await sa.displayCell(page, 'r7', 'col-a')).toBe('p3');
    expect(await diagCodes(page)).toContain('readonly-row-skipped');
    let changes = await commitChanges(page);
    expect(changes.every((c) => c.rowId !== 'r6')).toBe(true);

    // 貼り付け 1×2 @ (r10,col-a) → 行全体が readOnly＝全件スキップ → no-op（消費はする）。
    const commitsBefore = (await commitChanges(page)).length;
    await sa.selectCell(page, 10, 0);
    expect(await dispatchSyntheticPaste(page, 'q1\tq2')).toBe(true);
    await page.waitForTimeout(150);
    expect(await sa.displayCell(page, 'r10', 'col-a')).toBe('A10');
    expect(await sa.displayCell(page, 'r10', 'col-b')).toBe('B10');
    expect((await commitChanges(page)).length).toBe(commitsBefore);

    // 範囲クリア: (r11..r12) × col-a を Shift+↓ で選択 → Delete → r11 だけ blank・r12（readOnly）不変。
    await sa.selectCell(page, 11, 0);
    await page.keyboard.press('Shift+ArrowDown');
    await expect
      .poll(async () => api<unknown>(page, 'selectionRange'))
      .toEqual({ rowStart: 11, rowEnd: 13, colStart: 0, colEnd: 1 });
    await page.keyboard.press('Delete');
    await expect.poll(async () => sa.displayCell(page, 'r11', 'col-a')).toBe('');
    expect(await sa.displayCell(page, 'r12', 'col-a')).toBe('A12');

    // readOnly 行（r14）をアンカーに Shift+↑ で可編集行（r13）へ広げた範囲の Delete → r13 はクリアされる
    // （列版の Codex P2 と同型: レンジがあるなら裁定を通さず範囲クリアへ流す）。
    await sa.selectCell(page, 14, 0);
    await page.keyboard.press('Shift+ArrowUp');
    await expect
      .poll(async () => api<unknown>(page, 'selectionRange'))
      .toEqual({ rowStart: 13, rowEnd: 15, colStart: 0, colEnd: 1 });
    await page.keyboard.press('Delete');
    await expect.poll(async () => sa.displayCell(page, 'r13', 'col-a')).toBe('');
    expect(await sa.displayCell(page, 'r14', 'col-a')).toBe('A14');

    // cut: (r15..r16) × col-a → TSV は両行を含み、クリアは r15/r16（どちらも可編集）。
    await sa.selectCell(page, 15, 0);
    await page.keyboard.press('Shift+ArrowDown');
    const tsv = await dispatchSyntheticCut(page);
    expect(tsv).toBe('A15\r\nA16'); // 行区切りは CRLF（Excel 互換・DD-020-2）
    await expect.poll(async () => sa.displayCell(page, 'r15', 'col-a')).toBe('');
    // Undo で戻る（readOnly 行を含まない補償）。
    await page.keyboard.press('Control+z');
    await expect.poll(async () => sa.displayCell(page, 'r15', 'col-a')).toBe('A15');
    changes = await commitChanges(page);
    expect(changes.every((c) => !READONLY_ROWS.includes(c.rowId))).toBe(true);
    await page.screenshot({ path: sa.evidencePath('../DD-036/e2e-readonly-rows-2-paste-skip.png') });
  } finally {
    await context.close();
  }
});

test('AC7: readOnly 行でも範囲選択・コピー・行挿入削除・setData・scrollToRow は従来どおり／未知 rowId は warn のみ', async ({
  browser,
}) => {
  const { context, page } = await openReadonlyRows(browser);
  try {
    // 未知 rowId（r999）は mount 成功のまま診断 warn 1 件だけ。
    expect(await diagCodes(page)).toContain('readonly-row-unknown');
    expect(await sa.rowCount(page)).toBe(20);

    // コピー（readOnly 行を含む範囲）→ TSV は全行そのまま（閲覧系）。
    await sa.selectCell(page, 1, 0);
    await page.keyboard.press('Shift+ArrowDown');
    await expect
      .poll(async () => api<unknown>(page, 'selectionRange'))
      .toEqual({ rowStart: 1, rowEnd: 3, colStart: 0, colEnd: 1 });
    expect(await dispatchSyntheticCopy(page)).toBe('A1\r\nA2');

    // 行操作は行 readOnly と直交（readOnly 行の直後にも挿入でき、削除もできる）。
    const before = await sa.rowCount(page);
    await page.evaluate(() => window.__gridInstance?.insertRows({ afterRowId: 'r2', count: 2 }));
    await expect.poll(async () => sa.rowCount(page)).toBe(before + 2);
    await page.evaluate(() => window.__gridInstance?.deleteRows(['r3']));
    await expect.poll(async () => sa.rowCount(page)).toBe(before + 1);

    // setData は許可（readOnly 行の値も差し替わる＝プログラム的な表示更新は止めない）。
    await page.evaluate(() => window.__standalone?.reinject({ rows: [{ rowId: 'r2', cells: { 'col-b': 'NEW' } }] }));
    await expect.poll(async () => sa.displayCell(page, 'r2', 'col-b')).toBe('NEW');
    // 行 Axis の再構築は次の構造 flush（rAF）ゆえ rowCount も poll で待つ。
    await expect.poll(async () => sa.rowCount(page)).toBe(1);
  } finally {
    await context.close();
  }
});
