// DD-069 E2E: 読むだけのセルへの編集を止めたときの通知（edit-blocked・cells-skipped）。
//
// 単独モード（standalone.html?readonlycols=col-b&readonlyrows=r6&merged=…・行データの readOnlyColumns）で、読むだけの列・行・
// 行データのセル・結合・表全体の readOnly を作り、印字キー・F2・Delete・Backspace・ダブルクリック・貼り付け・切り取り・
// 範囲の消去が、位置と操作つきで 1 回だけ届くこと・読むだけのセルの値は変わらないことを確かめる。入力できるセルの編集・
// 移動キー・コピー・setRows では届かない。実 IME（日本語入力オン）の確認は Manual Gate（synthetic の打鍵は単体テスト）。

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { dispatchSyntheticPaste } from './integration-helpers';
import * as sa from './standalone-helpers';

test.describe.configure({ mode: 'serial' });

const MERGE = [{ rowId: 'r10', columnId: 'col-c', rowSpan: 2, columnSpan: 2 }];
const QUERY = `?readonlycols=col-b&readonlyrows=r6&merged=${encodeURIComponent(JSON.stringify(MERGE))}`;

/** 通知だけを取り出した形（比べやすいように type ごとに必要な項目だけ）。 */
type Notice =
  | { type: 'edit-blocked'; rowId: string; columnId: string; input: string; reason: string }
  | { type: 'cells-skipped'; operation: string; cells: Array<{ rowId: string; columnId: string }> };

interface EventWindow {
  __standalone?: {
    events: Array<Record<string, unknown> & { type: string }>;
    reinject(data: unknown): void;
    applyRows(rows: unknown): void;
  };
  __integrationTestApi?: { committedHash(): string; selectionRange(): unknown };
}

async function open(browser: Browser, query: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/standalone.html${query}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
  // 検証用に既知値を注入する。r3 の col-c だけを行データで読むだけにする（RC3）。
  await page.evaluate(() => {
    (window as unknown as EventWindow).__standalone?.reinject({
      rows: Array.from({ length: 20 }, (_v, i) => ({
        rowId: `r${i}`,
        cells: { 'col-a': `A${i}`, 'col-b': `B${i}`, 'col-c': `C${i}`, 'col-d': `D${i}` },
        ...(i === 3 ? { readOnlyColumns: ['col-c'] } : {}),
      })),
    });
  });
  await expect.poll(async () => sa.displayCell(page, 'r1', 'col-b')).toBe('B1');
  return { context, page };
}

/** これまでに届いた通知（edit-blocked・cells-skipped）だけを、届いた順に返す。 */
async function notices(page: Page): Promise<Notice[]> {
  return page.evaluate(() =>
    ((window as unknown as EventWindow).__standalone?.events ?? [])
      .filter((e) => e.type === 'edit-blocked' || e.type === 'cells-skipped')
      .map((e) => JSON.parse(JSON.stringify(e)) as Notice),
  );
}

/** 最後の通知の数を覚え、それより後に届いた通知を返す関数を作る。 */
async function since(page: Page): Promise<() => Promise<Notice[]>> {
  const start = (await notices(page)).length;
  return async () => (await notices(page)).slice(start);
}

async function committedHash(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as EventWindow).__integrationTestApi?.committedHash() ?? '');
}

async function cellCenter(page: Page, row: number, col: number): Promise<{ x: number; y: number }> {
  const rect = await sa.cellRectAt(page, row, col);
  if (rect === null) {
    throw new Error(`セル (${row},${col}) が可視範囲にない`);
  }
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function textareaReadOnly(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ta = document.querySelector('textarea.int-cell-editor');
    return ta instanceof HTMLTextAreaElement && ta.readOnly;
  });
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

async function selectionRange(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as unknown as EventWindow).__integrationTestApi?.selectionRange());
}

const blocked = (rowId: string, columnId: string, input: string, reason: string): Notice => ({
  type: 'edit-blocked',
  rowId,
  columnId,
  input,
  reason,
});

test('K11: 選択中のセルで止めた印字キー・F2・Delete・Backspace・ダブルクリックが、位置と理由つきで 1 回ずつ届く', async ({ browser }) => {
  const { context, page } = await open(browser, QUERY);
  try {
    const hash0 = await committedHash(page);
    const scroller = page.locator('.nsheet-scroller');

    // 読むだけの列（col-b）。
    await sa.selectCell(page, 1, 1);
    await expect.poll(async () => textareaReadOnly(page)).toBe(true);
    let read = await since(page);
    await page.keyboard.type('z');
    await page.keyboard.press('F2');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Backspace');
    await scroller.dblclick({ position: await cellCenter(page, 1, 1) });
    await expect.poll(read).toHaveLength(5);
    expect(await read()).toEqual([
      blocked('r1', 'col-b', 'key', 'readonly-column'),
      blocked('r1', 'col-b', 'f2', 'readonly-column'),
      blocked('r1', 'col-b', 'delete', 'readonly-column'),
      blocked('r1', 'col-b', 'delete', 'readonly-column'),
      blocked('r1', 'col-b', 'dblclick', 'readonly-column'),
    ]);

    // 読むだけの行（r6）・行データで読むだけにしたセル（r3 col-c）。
    await sa.selectCell(page, 6, 0);
    await expect.poll(async () => textareaReadOnly(page)).toBe(true);
    read = await since(page);
    await page.keyboard.type('z');
    await sa.selectCell(page, 3, 2);
    await expect.poll(async () => textareaReadOnly(page)).toBe(true);
    await page.keyboard.type('z');
    await expect.poll(read).toHaveLength(2);
    expect(await read()).toEqual([blocked('r6', 'col-a', 'key', 'readonly-row'), blocked('r3', 'col-c', 'key', 'readonly-cell')]);

    // 結合範囲（r10..r11 × col-c..col-d）は、中のどこを触っても左上のセルとして知らせる。
    await sa.selectCell(page, 11, 3);
    await expect.poll(async () => textareaReadOnly(page)).toBe(true);
    read = await since(page);
    await page.keyboard.type('z');
    await scroller.dblclick({ position: await cellCenter(page, 11, 3) });
    await expect.poll(read).toHaveLength(2);
    expect(await read()).toEqual([blocked('r10', 'col-c', 'key', 'merged'), blocked('r10', 'col-c', 'dblclick', 'merged')]);

    // 読むだけのセルの上でも、移動キー・コピーでは届かない。
    await sa.selectCell(page, 1, 1);
    read = await since(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Escape');

    // 入力できるセル（r1 col-a）の編集では届かない。打って取り消す。
    await sa.selectCell(page, 1, 0);
    await expect.poll(async () => textareaReadOnly(page)).toBe(false);
    await page.keyboard.type('q');
    await page.keyboard.press('Escape');
    await page.keyboard.press('F2');
    await page.keyboard.press('Escape');
    await scroller.dblclick({ position: await cellCenter(page, 2, 0) });
    await page.keyboard.press('Escape');

    // setRows（プログラムからの書き込み）では、読むだけのセルを書いても届かない。
    await page.evaluate(() => {
      (window as unknown as EventWindow).__standalone?.applyRows([{ rowId: 'r1', cells: { 'col-b': 'API' } }]);
    });
    await expect.poll(async () => sa.displayCell(page, 'r1', 'col-b')).toBe('API');
    await page.waitForTimeout(150);
    expect(await read()).toEqual([]);

    // 利用者の操作では文書は変わっていない（変わったのは setRows の 1 セルだけ）。
    expect(await sa.displayCell(page, 'r1', 'col-a')).toBe('A1');
    expect(await sa.displayCell(page, 'r6', 'col-a')).toBe('A6');
    expect(await sa.displayCell(page, 'r3', 'col-c')).toBe('C3');
    expect(await sa.displayCell(page, 'r10', 'col-c')).toBe('C10');
    expect(hash0).not.toBe('');
  } finally {
    await context.close();
  }
});

test('K11: 範囲の貼り付け・範囲の消去・切り取りで飛ばしたセルを cells-skipped で 1 回知らせ、書き込みの後に届く', async ({ browser }) => {
  const { context, page } = await open(browser, QUERY);
  try {
    // 貼り付け 3×1（r5..r7 の col-a）→ r6（読むだけの行）だけ飛ばし、他は書く。通知は cell-commit の後。
    await sa.selectCell(page, 5, 0);
    let read = await since(page);
    expect(await dispatchSyntheticPaste(page, 'p1\np2\np3')).toBe(true);
    await expect.poll(async () => sa.displayCell(page, 'r5', 'col-a')).toBe('p1');
    expect(await sa.displayCell(page, 'r6', 'col-a')).toBe('A6');
    expect(await sa.displayCell(page, 'r7', 'col-a')).toBe('p3');
    expect(await read()).toEqual([{ type: 'cells-skipped', operation: 'paste', cells: [{ rowId: 'r6', columnId: 'col-a' }] }]);
    const order = await page.evaluate(() =>
      ((window as unknown as EventWindow).__standalone?.events ?? [])
        .map((e) => e.type)
        .filter((t) => t === 'cell-commit' || t === 'cells-skipped'),
    );
    expect(order.slice(-2)).toEqual(['cell-commit', 'cells-skipped']);

    // 読むだけのセル 1 つへの貼り付け（全部飛ばす）も cells-skipped。文書は変わらない。
    const commitsBefore = (await sa.events(page)).filter((e) => e.type === 'cell-commit').length;
    await sa.selectCell(page, 1, 1);
    read = await since(page);
    expect(await dispatchSyntheticPaste(page, 'x')).toBe(true);
    await expect.poll(read).toHaveLength(1);
    expect(await read()).toEqual([{ type: 'cells-skipped', operation: 'paste', cells: [{ rowId: 'r1', columnId: 'col-b' }] }]);
    expect(await sa.displayCell(page, 'r1', 'col-b')).toBe('B1');
    expect((await sa.events(page)).filter((e) => e.type === 'cell-commit').length).toBe(commitsBefore);

    // 範囲の消去: r5..r6 × col-a → r6 だけ飛ばす。
    await sa.selectCell(page, 5, 0);
    await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(async () => selectionRange(page)).toEqual({ rowStart: 5, rowEnd: 7, colStart: 0, colEnd: 1 });
    read = await since(page);
    await page.keyboard.press('Delete');
    await expect.poll(async () => sa.displayCell(page, 'r5', 'col-a')).toBe('');
    expect(await read()).toEqual([{ type: 'cells-skipped', operation: 'clear', cells: [{ rowId: 'r6', columnId: 'col-a' }] }]);

    // 切り取り: r1 × col-a..col-b → クリップボードには両方、col-b（読むだけの列）だけ消さない。
    await sa.selectCell(page, 1, 0);
    await page.keyboard.press('Shift+ArrowRight');
    read = await since(page);
    expect(await dispatchSyntheticCut(page)).toBe('A1\tB1');
    await expect.poll(async () => sa.displayCell(page, 'r1', 'col-a')).toBe('');
    expect(await sa.displayCell(page, 'r1', 'col-b')).toBe('B1');
    expect(await read()).toEqual([{ type: 'cells-skipped', operation: 'cut', cells: [{ rowId: 'r1', columnId: 'col-b' }] }]);

    // 読むだけのセルを含まない範囲の操作では届かない。
    await sa.selectCell(page, 15, 2);
    await page.keyboard.press('Shift+ArrowDown');
    read = await since(page);
    await page.keyboard.press('Delete');
    await expect.poll(async () => sa.displayCell(page, 'r15', 'col-c')).toBe('');
    expect(await dispatchSyntheticPaste(page, 'n1\nn2')).toBe(true);
    await expect.poll(async () => sa.displayCell(page, 'r16', 'col-c')).toBe('n2');
    await page.waitForTimeout(150);
    expect(await read()).toEqual([]);
    await page.screenshot({ path: sa.evidencePath('../DD-069/e2e-edit-blocked-range.png') });
  } finally {
    await context.close();
  }
});

test('K11: 表全体が読み取り専用なら、キー・ダブルクリック・貼り付け・切り取りを grid-readonly で 1 回ずつ知らせる', async ({ browser }) => {
  const { context, page } = await open(browser, '?readonly=1');
  try {
    const hash0 = await committedHash(page);
    await sa.selectCell(page, 2, 0);
    await expect.poll(async () => textareaReadOnly(page)).toBe(true);
    const read = await since(page);
    await page.keyboard.type('z');
    await page.keyboard.press('F2');
    await page.keyboard.press('Delete');
    await page.locator('.nsheet-scroller').dblclick({ position: await cellCenter(page, 2, 0) });
    expect(await dispatchSyntheticPaste(page, 'x')).toBe(true);
    await dispatchSyntheticCut(page);
    // 範囲を選んだ Delete も、表全体の段で 1 回（範囲の消去へは流れない）。
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Delete');
    // 移動・コピーでは届かない。
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Control+c');
    await expect.poll(read).toHaveLength(7);
    await page.waitForTimeout(150);
    expect(await read()).toEqual([
      blocked('r2', 'col-a', 'key', 'grid-readonly'),
      blocked('r2', 'col-a', 'f2', 'grid-readonly'),
      blocked('r2', 'col-a', 'delete', 'grid-readonly'),
      blocked('r2', 'col-a', 'dblclick', 'grid-readonly'),
      blocked('r2', 'col-a', 'paste', 'grid-readonly'),
      blocked('r2', 'col-a', 'cut', 'grid-readonly'),
      blocked('r2', 'col-a', 'delete', 'grid-readonly'),
    ]);
    expect(await committedHash(page)).toBe(hash0);
  } finally {
    await context.close();
  }
});
