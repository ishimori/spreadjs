// DD-063 E2E: 確定前の検証（mount オプション validateCell）。拒否された入力は捨てられ（文書・Undo・サーバーは変わらない）、
// cell-invalid が出ることを、単独グリッド（standalone.html）と共同編集（poc-integration.html）で確かめる。
// 規則はクエリ `validate=<列>:<規則>`（apps/playground/src/integration/validate-options.ts）。呼ばれた回数は window.__validateCalls。

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { colIdAt as collabColIdAt, grantClipboard, openClient, rowIdAt as collabRowIdAt, selectCell as collabSelectCell, writeClipboard } from './integration-helpers';
import * as sa from './standalone-helpers';

interface InvalidEvent {
  type: 'cell-invalid';
  source: string;
  cells: Array<{ rowId: string; columnId: string; value: string; message: string }>;
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/standalone.html?${query}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
  await page.evaluate(() => window.__standalone?.clearSaved());
}

async function invalidEvents(page: Page): Promise<InvalidEvent[]> {
  return (await sa.events(page)).filter((e) => e.type === 'cell-invalid') as unknown as InvalidEvent[];
}

async function typeAndEnter(page: Page, row: number, col: number, text: string): Promise<void> {
  await sa.selectCell(page, row, col);
  await page.locator('textarea.int-cell-editor').focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

async function validateCalls(page: Page): Promise<number> {
  return page.evaluate(() => window.__validateCalls ?? 0);
}

async function diagnosticCodes(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ((window as unknown as { __standalone?: { diagnostics: Array<{ code: string }> } }).__standalone?.diagnostics ?? []).map((d) => d.code),
  );
}

test('入力の確定（textarea・IME の synthetic 経路）で拒否すると値は元のまま、cell-invalid が出て Undo にも積まれない。正しい値は確定する（AC1・AC2）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, 'validate=col-b:len8');
    const undoBefore = await sa.undoDepth(page);
    const commitsBefore = (await sa.events(page)).filter((e) => e.type === 'cell-commit').length;

    await typeAndEnter(page, 2, 1, '123456789');
    await expect.poll(async () => (await invalidEvents(page)).length).toBe(1);
    expect((await invalidEvents(page))[0]).toEqual({
      type: 'cell-invalid',
      source: 'edit',
      cells: [{ rowId: 'r2', columnId: 'col-b', value: '123456789', message: '8桁を超えています' }],
    });
    expect(await sa.displayCell(page, 'r2', 'col-b')).toBe('');
    expect(await sa.undoDepth(page)).toBe(undoBefore);
    expect((await sa.events(page)).filter((e) => e.type === 'cell-commit')).toHaveLength(commitsBefore);
    expect(await sa.isComposing(page)).toBe(false);

    // IME の確定（synthetic composition）でも同じく拒否される。次の入力は通常どおり始まる。
    await sa.composeCommitAtCell(page, 3, 1, '１２３４５６７８９');
    await expect.poll(async () => (await invalidEvents(page)).length).toBe(2);
    expect((await invalidEvents(page))[1]!.cells[0]).toMatchObject({ rowId: 'r3', columnId: 'col-b' });
    expect(await sa.displayCell(page, 'r3', 'col-b')).toBe('');

    await typeAndEnter(page, 2, 1, '12345');
    await expect.poll(async () => sa.displayCell(page, 'r2', 'col-b')).toBe('12345');
    expect(await sa.undoDepth(page)).toBe(undoBefore + 1);
    expect(await invalidEvents(page)).toHaveLength(2);
  } finally {
    await context.close();
  }
});

test('貼り付けは 1 件でも不正なら全体を拒否し、不正なセルを全部載せる。正しい値だけなら確定する（AC3）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await grantClipboard(context);
  const page = await context.newPage();
  try {
    await open(page, 'validate=col-b:len8,col-c:ng');
    await sa.selectCell(page, 5, 1);
    await writeClipboard(page, '123456789\tok\n22\tNG');
    await page.keyboard.press('Control+v');
    await expect.poll(async () => (await invalidEvents(page)).length).toBe(1);
    const event = (await invalidEvents(page))[0]!;
    expect(event.source).toBe('paste');
    expect(event.cells.map((c) => `${c.rowId}/${c.columnId}:${c.message}`)).toEqual([
      'r5/col-b:8桁を超えています',
      'r6/col-c:NG は使えません',
    ]);
    for (const [rowId, columnId] of [['r5', 'col-b'], ['r5', 'col-c'], ['r6', 'col-b'], ['r6', 'col-c']] as const) {
      expect(await sa.displayCell(page, rowId, columnId), `${rowId}/${columnId} は変わらない`).toBe('');
    }

    await writeClipboard(page, '1234\tok\n22\tyes');
    await page.keyboard.press('Control+v');
    await expect.poll(async () => sa.displayCell(page, 'r6', 'col-c')).toBe('yes');
    expect(await sa.displayCell(page, 'r5', 'col-b')).toBe('1234');
    expect(await invalidEvents(page)).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test('Delete・範囲クリア・Undo・setRows では validateCell を呼ばない（AC4）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, 'validate=col-b:len8');
    await typeAndEnter(page, 2, 1, '123');
    await expect.poll(async () => sa.displayCell(page, 'r2', 'col-b')).toBe('123');
    const calls = await validateCalls(page);
    expect(calls).toBe(1);

    await page.evaluate(() => window.__gridInstance?.setRows([{ rowId: 'r2', cells: { 'col-b': '123456789' } }]));
    await expect.poll(async () => sa.displayCell(page, 'r2', 'col-b'), { message: 'setRows は検証しない' }).toBe('123456789');
    await page.keyboard.press('Control+z');
    await expect.poll(async () => sa.displayCell(page, 'r2', 'col-b'), { message: 'Undo は検証しない' }).toBe('123');
    await sa.selectCell(page, 2, 1);
    await page.keyboard.press('Delete');
    await expect.poll(async () => sa.displayCell(page, 'r2', 'col-b'), { message: 'Delete は検証しない' }).toBe('');

    // 範囲クリア（2 行を選んで Delete）。
    await page.evaluate(() =>
      window.__gridInstance?.setRows([
        { rowId: 'r2', cells: { 'col-b': 'aaa' } },
        { rowId: 'r3', cells: { 'col-b': 'bbb' } },
      ]),
    );
    await expect.poll(async () => sa.displayCell(page, 'r3', 'col-b')).toBe('bbb');
    await sa.selectCell(page, 2, 1);
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Delete');
    await expect.poll(async () => sa.displayCell(page, 'r3', 'col-b'), { message: '範囲クリアは検証しない' }).toBe('');
    expect(await sa.displayCell(page, 'r2', 'col-b')).toBe('');
    expect(await validateCalls(page)).toBe(calls);
    expect(await invalidEvents(page)).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test('選択式の候補・日付のカレンダーの確定も検証される（AC5）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, `select=${encodeURIComponent('col-b:OK|NG')}&date=col-c&validate=col-b:ng,col-c:date2000`);
    await sa.selectCell(page, 3, 1);
    await page.keyboard.press('F2');
    await page.locator('.ns-select-option', { hasText: 'NG' }).click();
    await expect.poll(async () => (await invalidEvents(page)).at(-1)?.source).toBe('select');
    expect(await sa.displayCell(page, 'r3', 'col-b')).toBe('');

    await page.evaluate(() => window.__gridInstance?.setRows([{ rowId: 'r4', cells: { 'col-c': '1999-12-01' } }]));
    await expect.poll(async () => sa.displayCell(page, 'r4', 'col-c')).toBe('1999-12-01');
    await sa.selectCell(page, 4, 2);
    await page.keyboard.press('F2');
    await page.locator('.ns-date-day[data-date="1999-12-15"]').click();
    await expect.poll(async () => (await invalidEvents(page)).at(-1)?.source).toBe('date');
    expect((await invalidEvents(page)).at(-1)!.cells[0]).toMatchObject({ value: '1999-12-15', message: '2000年より前は入力できません' });
    expect(await sa.displayCell(page, 'r4', 'col-c')).toBe('1999-12-01');
  } finally {
    await context.close();
  }
});

test('validateCell が例外を投げたら確定を通し、validate-cell-threw を出す（AC7）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, 'validate=col-b:throw');
    await typeAndEnter(page, 2, 1, '123');
    await expect.poll(async () => sa.displayCell(page, 'r2', 'col-b')).toBe('123');
    expect(await diagnosticCodes(page)).toContain('validate-cell-threw');
    expect(await invalidEvents(page)).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test('共同編集モードでも拒否され、cell-invalid が出て、サーバー・他の参加者へは送られない（AC6）', async ({ browser }) => {
  const probe = await openClient(browser, 'probe');
  const colId = (await collabColIdAt(probe.page, 1))!;
  await probe.context.close();
  const a = await openClient(browser, 'A', { validate: `${colId}:len8` });
  const b = await openClient(browser, 'B');
  try {
    const rowId = (await collabRowIdAt(a.page, 4))!;
    const read = (page: Page) =>
      page.evaluate(
        ({ rowId, colId }) =>
          (window as unknown as { __integrationTestApi?: { displayCell(r: string, c: string): string } }).__integrationTestApi?.displayCell(rowId, colId),
        { rowId, colId },
      );
    const before = await read(b.page);
    await collabSelectCell(a.page, 4, 1);
    await a.page.locator('textarea.int-cell-editor').focus();
    await a.page.keyboard.type('123456789');
    await a.page.keyboard.press('Enter');
    await expect
      .poll(async () =>
        a.page.evaluate(() => ((window as unknown as { __gridEvents?: Array<{ type: string; source?: string }> }).__gridEvents ?? []).filter((e) => e.type === 'cell-invalid').map((e) => e.source)),
      )
      .toEqual(['edit']);
    await a.page.waitForTimeout(300);
    expect(await read(a.page)).toBe(before);
    expect(await read(b.page), 'B へは届かない').toBe(before);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
