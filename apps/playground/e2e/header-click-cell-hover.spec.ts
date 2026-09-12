// DD-052-5 E2E（RC5: 列見出しのクリック通知・RC6: セルのホバー通知）。

import { expect, test } from '@playwright/test';

import * as sa from './standalone-helpers';

test('RC5: 列見出しをクリックすると header-click{columnId} が発火し、セル選択は変わらない', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    const headerRect = await sa.columnHeaderRectAt(page, 1);
    expect(headerRect).not.toBeNull();
    const before = await sa.activeCell(page);

    await page
      .locator('.nsheet-scroller')
      .click({ position: { x: headerRect!.x + headerRect!.width / 2, y: headerRect!.y + headerRect!.height / 2 } });

    const columnId = await sa.colIdAt(page, 1);
    await expect
      .poll(async () => (await sa.events(page)).some((e) => e.type === 'header-click' && e.columnId === columnId))
      .toBe(true);
    // 見出しクリックはセル選択・編集を起こさない（既存挙動は変わらない）。
    expect(await sa.activeCell(page)).toEqual(before);
  } finally {
    await context.close();
  }
});

test('RC5: セルクリックでは header-click は発火しない', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    await sa.selectCell(page, 2, 1);
    expect((await sa.events(page)).some((e) => e.type === 'header-click')).toBe(false);
  } finally {
    await context.close();
  }
});

test('RC6: セル間でポインタを動かすと cell-hover が出入りで発火し、同一セル内では再発火しない', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    const rectA = await sa.cellRectAt(page, 3, 0);
    const rectB = await sa.cellRectAt(page, 3, 1);
    expect(rectA).not.toBeNull();
    expect(rectB).not.toBeNull();
    const rowId = await sa.rowIdAt(page, 3);
    const colA = await sa.colIdAt(page, 0);
    const colB = await sa.colIdAt(page, 1);
    const scrollerBox = await page.locator('.nsheet-scroller').boundingBox();
    expect(scrollerBox).not.toBeNull();

    const centerOf = (rect: { x: number; y: number; width: number; height: number }) => ({
      x: scrollerBox!.x + rect.x + rect.width / 2,
      y: scrollerBox!.y + rect.y + rect.height / 2,
    });

    const a = centerOf(rectA!);
    await page.mouse.move(a.x, a.y);
    await expect
      .poll(async () => (await sa.events(page)).filter((e) => e.type === 'cell-hover').at(-1))
      .toMatchObject({ rowId, columnId: colA });

    // 同じセル内で微小移動しても再発火しない。
    const countAfterFirst = (await sa.events(page)).filter((e) => e.type === 'cell-hover').length;
    await page.mouse.move(a.x + 1, a.y + 1);
    await page.waitForTimeout(100);
    expect((await sa.events(page)).filter((e) => e.type === 'cell-hover').length).toBe(countAfterFirst);

    // 隣のセルへ移動すると発火する。
    const b = centerOf(rectB!);
    await page.mouse.move(b.x, b.y);
    await expect
      .poll(async () => (await sa.events(page)).filter((e) => e.type === 'cell-hover').at(-1))
      .toMatchObject({ rowId, columnId: colB });

    // グリッド外へ出るとホバー終了（null）が発火する。
    await page.mouse.move(scrollerBox!.x - 20, scrollerBox!.y - 20);
    await expect
      .poll(async () => (await sa.events(page)).filter((e) => e.type === 'cell-hover').at(-1))
      .toMatchObject({ rowId: null, columnId: null, rect: null });
  } finally {
    await context.close();
  }
});
