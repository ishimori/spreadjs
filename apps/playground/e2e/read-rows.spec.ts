// DD-070-5 E2E: 表のデータを読む（GridInstance.getRows）。単独モードと共同編集モード（統合サーバー）。

import { expect, test, type Page } from '@playwright/test';

import * as ih from './integration-helpers';
import * as sa from './standalone-helpers';

type Row = { rowId: string; cells: Record<string, string> };
type Grid = {
  getRows(options?: { columnIds?: string[]; rowIds?: string[] }): Row[];
  setData(data: { rows: Row[] }): void;
};

async function getRows(page: Page, options?: { columnIds?: string[]; rowIds?: string[] }): Promise<Row[]> {
  return page.evaluate((o) => (window as Window & { __gridInstance?: Grid }).__gridInstance!.getRows(o), options);
}

test('AC1・AC3: 単独モードで確定した値を読め、setData の直後に同じ処理の中で読むと新しい行。getRows の結果を setData に渡すと同じ表', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    await sa.composeCommitAtCell(page, 2, 1, '１２３'); // 全角は数値として確定（表示は 123）
    await expect.poll(async () => (await getRows(page, { rowIds: ['r2'] }))[0]?.cells['col-b']).toBe('123');
    const all = await getRows(page);
    expect(all[0]).toEqual({ rowId: 'r0', cells: { 'col-a': '行0' } });
    expect(all.length).toBe(await sa.rowCount(page));

    const result = await page.evaluate(() => {
      const g = (window as Window & { __gridInstance?: Grid }).__gridInstance!;
      const before = g.getRows();
      g.setData({ rows: [{ rowId: 'x1', cells: { 'col-a': 'A' } }] });
      const after = g.getRows();
      g.setData({ rows: before });
      return { after, restored: g.getRows() };
    });
    expect(result.after).toEqual([{ rowId: 'x1', cells: { 'col-a': 'A' } }]);
    expect(result.restored).toEqual(all);
  } finally {
    await context.close();
  }
});

test('AC4: 共同編集モードで、他の参加者の確定も getRows で読める', async ({ browser }) => {
  const a = await ih.openClient(browser, `dd0705-a-${Date.now()}`);
  const b = await ih.openClient(browser, `dd0705-b-${Date.now()}`);
  try {
    const rowId = await ih.rowIdAt(a.page, 3);
    const columnId = await ih.colIdAt(a.page, 1);
    expect(rowId).toBeDefined();
    expect(columnId).toBeDefined();
    const value = `rr${Date.now() % 100000}`;
    await ih.selectCell(a.page, 3, 1);
    await ih.plainTypeAndCommit(a.page, value);
    await expect
      .poll(async () => (await getRows(b.page, { rowIds: [rowId!], columnIds: [columnId!] }))[0]?.cells[columnId!], { timeout: 15_000 })
      .toBe(value);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
