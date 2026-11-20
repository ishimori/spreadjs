// DD-070-2 E2E: 選択の変更の通知（selection-change）・今の選択（selection()）・セルのダブルクリックの通知（cell-dblclick）。

import { expect, test, type Page } from '@playwright/test';

import * as sa from './standalone-helpers';

type Selection = { activeCell: { rowId: string; columnId: string } | null; range: unknown };

async function currentSelection(page: Page): Promise<Selection> {
  return page.evaluate(
    () => (window as Window & { __gridInstance?: { selection(): Selection } }).__gridInstance!.selection(),
  );
}

async function selectionEvents(page: Page): Promise<sa.StandaloneEvent[]> {
  return (await sa.events(page)).filter((e) => e.type === 'selection-change');
}

async function dblclickCell(page: Page, row: number, col: number): Promise<void> {
  const rect = await sa.cellRectAt(page, row, col);
  if (rect === null) {
    throw new Error(`セル (${row},${col}) が可視範囲にない`);
  }
  await page.locator('.nsheet-scroller').dblclick({ position: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } });
}

test('AC1・AC3: クリック・矢印・Shift＋矢印・setActiveCell で selection-change が新しい選択で届き、同じ選択では届かない', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    // 初回のデータの描画の後に、最初の選択が 1 回届く。
    await expect.poll(async () => (await selectionEvents(page)).length).toBe(1);
    const r0 = await sa.rowIdAt(page, 0);
    const r2 = await sa.rowIdAt(page, 2);
    const r3 = await sa.rowIdAt(page, 3);
    const c1 = await sa.colIdAt(page, 1);
    const c2 = await sa.colIdAt(page, 2);
    expect((await selectionEvents(page))[0]!.activeCell).toEqual({ rowId: r0, columnId: await sa.colIdAt(page, 0) });

    await sa.selectCell(page, 2, 1);
    await expect.poll(async () => (await selectionEvents(page)).at(-1)?.activeCell).toEqual({ rowId: r2, columnId: c1 });
    expect((await selectionEvents(page)).at(-1)!.range).toEqual({ startRowId: r2, startColumnId: c1, endRowId: r2, endColumnId: c1 });
    const afterClick = (await selectionEvents(page)).length;

    // 同じセルをもう一度クリックしても届かない（数フレーム待つ）。
    await sa.selectCell(page, 2, 1);
    await page.waitForTimeout(150);
    expect((await selectionEvents(page)).length).toBe(afterClick);

    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await selectionEvents(page)).at(-1)?.activeCell).toEqual({ rowId: r3, columnId: c1 });

    await page.keyboard.press('Shift+ArrowRight');
    await expect
      .poll(async () => (await selectionEvents(page)).at(-1)?.range)
      .toEqual({ startRowId: r3, startColumnId: c1, endRowId: r3, endColumnId: c2 });
    expect(await currentSelection(page)).toEqual({
      activeCell: { rowId: r3, columnId: c1 },
      range: { startRowId: r3, startColumnId: c1, endRowId: r3, endColumnId: c2 },
    });

    await page.evaluate(
      ({ rowId, columnId }) => (window as Window & { __gridInstance?: { setActiveCell(r: string, c: string): void } }).__gridInstance!.setActiveCell(rowId, columnId),
      { rowId: r0, columnId: c2 },
    );
    await expect.poll(async () => (await selectionEvents(page)).at(-1)?.activeCell).toEqual({ rowId: r0, columnId: c2 });
    expect((await currentSelection(page)).activeCell).toEqual({ rowId: r0, columnId: c2 });
  } finally {
    await context.close();
  }
});

test('AC4: 本体のセルのダブルクリックで cell-dblclick が 1 回届き、既定の編集の開始は止まらない', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    const r1 = await sa.rowIdAt(page, 1);
    const c1 = await sa.colIdAt(page, 1);
    // Codex P3: 通知を受けた時点で既定の編集の開始が済んでいる（編集中だけ textarea が pointer を受ける）ことを記録する。
    await page.evaluate(() => {
      const w = window as Window & { __gridInstance?: { subscribe(l: (e: { type: string }) => void): () => void }; __dblStates?: string[] };
      w.__dblStates = [];
      w.__gridInstance!.subscribe((e) => {
        if (e.type === 'cell-dblclick') {
          w.__dblStates!.push((document.querySelector('textarea.int-cell-editor') as HTMLTextAreaElement).style.pointerEvents);
        }
      });
    });
    await dblclickCell(page, 1, 1);
    await expect
      .poll(async () => (await sa.events(page)).filter((e) => e.type === 'cell-dblclick'))
      .toEqual([{ type: 'cell-dblclick', rowId: r1, columnId: c1 }]);
    // 既定の動き（編集の開始）はそのまま。
    await expect
      .poll(async () => page.evaluate(() => (document.querySelector('textarea.int-cell-editor') as HTMLTextAreaElement).style.display))
      .toBe('block');
    expect(await page.evaluate(() => (window as Window & { __dblStates?: string[] }).__dblStates)).toEqual(['auto']);
  } finally {
    await context.close();
  }
});

test('AC4: 読むだけの表でも cell-dblclick が届き（edit-blocked の後）、見出しのダブルクリックでは届かない', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto('/standalone.html?readonly=1');
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);
    const r2 = await sa.rowIdAt(page, 2);
    const c0 = await sa.colIdAt(page, 0);
    await dblclickCell(page, 2, 0);
    await expect
      .poll(async () => (await sa.events(page)).filter((e) => e.type === 'cell-dblclick' || e.type === 'edit-blocked').map((e) => e.type))
      .toEqual(['edit-blocked', 'cell-dblclick']);
    expect((await sa.events(page)).find((e) => e.type === 'cell-dblclick')).toMatchObject({ rowId: r2, columnId: c0 });

    const header = await sa.columnHeaderRectAt(page, 1);
    expect(header).not.toBeNull();
    await page
      .locator('.nsheet-scroller')
      .dblclick({ position: { x: header!.x + header!.width / 2, y: header!.y + header!.height / 2 } });
    await page.waitForTimeout(150);
    expect((await sa.events(page)).filter((e) => e.type === 'cell-dblclick')).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test('Codex P1: 表の下の余白のダブルクリックでは、最終行の cell-dblclick を出さない', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    const rows = await sa.rowCount(page);
    const last = await sa.cellRectAt(page, rows - 1, 1);
    const box = await page.locator('.nsheet-scroller').boundingBox();
    expect(last).not.toBeNull();
    expect(box).not.toBeNull();
    const y = last!.y + last!.height + 30;
    expect(y).toBeLessThan(box!.height - 30); // 表の下に余白がある前提（既定の 20 行）
    await page.locator('.nsheet-scroller').dblclick({ position: { x: last!.x + last!.width / 2, y } });
    await page.waitForTimeout(150);
    expect((await sa.events(page)).filter((e) => e.type === 'cell-dblclick')).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Codex P2: setData の直後に同じ処理の中で読む selection() は、新しい行で返す', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    await sa.selectCell(page, 3, 1);
    const result = await page.evaluate(() => {
      const g = (window as Window & { __gridInstance?: { setData(d: unknown): void; selection(): { activeCell: unknown } } }).__gridInstance!;
      g.setData({ rows: [] });
      const empty = g.selection();
      g.setData({ rows: [{ rowId: 'n0', cells: {} }, { rowId: 'n1', cells: {} }] });
      const replaced = g.selection();
      return { empty, replaced };
    });
    expect(result.empty).toEqual({ activeCell: null, range: null });
    expect((result.replaced.activeCell as { rowId: string } | null)?.rowId).toMatch(/^n[01]$/);
  } finally {
    await context.close();
  }
});

test('AC4: 結合範囲の中のダブルクリックは左上のセルとして届く', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    const merged = encodeURIComponent(JSON.stringify([{ rowId: 'r2', columnId: 'col-b', rowSpan: 2, columnSpan: 2 }]));
    await page.goto(`/standalone.html?frozenrows=0&merged=${merged}`);
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);
    // 結合の右下（r3・col-c）をダブルクリック → 左上（r2・col-b）として届く。
    const row = await page.evaluate(() => {
      const api = (window as Window & { __integrationTestApi?: { rowIdAt(i: number): string | undefined } }).__integrationTestApi!;
      for (let i = 0; i < 50; i += 1) if (api.rowIdAt(i) === 'r3') return i;
      return -1;
    });
    expect(row).toBeGreaterThanOrEqual(0);
    await dblclickCell(page, row, 2);
    await expect
      .poll(async () => (await sa.events(page)).filter((e) => e.type === 'cell-dblclick'))
      .toEqual([{ type: 'cell-dblclick', rowId: 'r2', columnId: 'col-b' }]);
  } finally {
    await context.close();
  }
});
