// DD-066: 結合セルの Navigation 枠（textarea）は全体の矩形に置き、pane の中だけに表示する。
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as sa from './standalone-helpers';

interface Merge {
  rowId: string;
  columnId: string;
  rowSpan: number;
  columnSpan?: number;
}

const BODY: Merge = { rowId: 'r2', columnId: 'col-b', rowSpan: 3 };

async function open(page: Page, merge: Merge = BODY, frozenRows = 1, frozenCols = 1): Promise<void> {
  const query = new URLSearchParams({ seedrows: '80', extracols: '16', autofocus: '0', frozenrows: String(frozenRows), frozencols: String(frozenCols), merged: JSON.stringify([merge]) });
  await page.goto(`/standalone.html?${query}`);
  await sa.waitReady(page);
}

async function frame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function textarea(page: Page) {
  return page.locator('textarea.int-cell-editor').evaluate((element) => {
    if (!(element instanceof HTMLTextAreaElement)) throw new Error('textarea missing');
    const parts = element.style.clipPath.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    return {
      x: parseFloat(element.style.left), y: parseFloat(element.style.top),
      width: parseFloat(element.style.width), height: parseFloat(element.style.height),
      display: element.style.display, clipPath: element.style.clipPath,
      topClip: parts[0] ?? 0, leftClip: parts[3] ?? parts[1] ?? parts[0] ?? 0,
    };
  });
}

async function activate(page: Page, rowId: string, columnId: string): Promise<void> {
  await page.evaluate(({ rowId, columnId }) => {
    window.__gridInstance?.setActiveCell(rowId, columnId);
    window.__gridInstance?.focus();
  }, { rowId, columnId });
  await frame(page);
}

test('AC2: focus なしの初期選択でも、結合3行の枠を置く', async ({ page }) => {
  await open(page, { rowId: 'r0', columnId: 'col-a', rowSpan: 3 }, 0, 0);
  expect(await sa.activeCell(page)).toEqual({ row: 0, col: 0 });
  expect(await textarea(page)).toMatchObject({ x: 52, y: 24, width: 80, height: 66, display: 'block' });
  await expect(page.locator('textarea.int-cell-editor')).not.toBeFocused();
});

test('AC1/3: 結合の下側をクリックすると全体を囲み、矢印で外へ出ると1セルへ戻って日本語を確定できる', async ({ page }) => {
  await open(page);
  await sa.selectCell(page, 4, 1);
  expect(await sa.activeCell(page)).toEqual({ row: 2, col: 1 });
  expect(await textarea(page)).toMatchObject({ width: 80, height: 66 });
  await page.keyboard.press('ArrowDown');
  expect(await sa.activeCell(page)).toEqual({ row: 5, col: 1 });
  expect(await textarea(page)).toMatchObject({ width: 80, height: 22, clipPath: '' });
  await sa.composeCommitAtCell(page, 5, 1, '隣のセルに入力');
  expect(await sa.displayCell(page, 'r5', 'col-b')).toBe('隣のセルに入力');
});

test('AC4: 結合の上端が固定行へ隠れても実矩形を動かさず、枠だけを pane で clip する', async ({ page }) => {
  await open(page);
  await activate(page, 'r2', 'col-b');
  await page.locator('.nsheet-scroller').evaluate((element) => { element.scrollTop = 33; });
  await frame(page);
  const actual = await textarea(page);
  const anchor = await sa.cellRectAt(page, 2, 1);
  expect(actual.height).toBe(66);
  expect(actual.y).toBeCloseTo(anchor?.y ?? Number.NaN, 2);
  expect(actual.y).toBeLessThan(46);
  expect(actual.y + actual.topClip).toBeCloseTo(46, 2);
});

test('AC4: 左上セルが全部隠れても結合の下側が見えれば focus を失わず、スクロールも戻らない', async ({ page }) => {
  await open(page);
  await activate(page, 'r2', 'col-b');
  await page.locator('.nsheet-scroller').evaluate((element) => { element.scrollTop = 50; });
  await frame(page);
  expect(await textarea(page)).toMatchObject({ y: 18, height: 66, display: 'block', topClip: 28 });
  await expect(page.locator('textarea.int-cell-editor')).toBeFocused();
  expect(await page.locator('.nsheet-scroller').evaluate((element) => element.scrollTop)).toBeCloseTo(50, 1);
});

test('AC4: 固定列内の3行×2列の結合は、横スクロールしても160×66の枠を保つ', async ({ page }) => {
  await open(page, { rowId: 'r0', columnId: 'col-a', rowSpan: 3, columnSpan: 2 }, 0, 2);
  await activate(page, 'r0', 'col-a');
  await page.locator('.nsheet-scroller').evaluate((element) => { element.scrollLeft = 120; });
  await frame(page);
  expect(await textarea(page)).toMatchObject({ x: 52, y: 24, width: 160, height: 66, leftClip: 0 });
});

test('AC4: スクロール列の左上セルが固定列の裏へ隠れても、残りの結合は可視', async ({ page }) => {
  await open(page, { rowId: 'r2', columnId: 'col-c', rowSpan: 3, columnSpan: 2 });
  await activate(page, 'r2', 'col-c');
  await page.locator('.nsheet-scroller').evaluate((element) => { element.scrollLeft = 190; });
  await frame(page);
  const actual = await textarea(page);
  expect(actual).toMatchObject({ x: 22, width: 160, height: 66, display: 'block', leftClip: 110 });
  expect(actual.x + actual.leftClip).toBe(132);
  await expect(page.locator('textarea.int-cell-editor')).toBeFocused();
});

test('AC5: 結合を外すと同じアクティブセルの枠・clip・入力ロックが通常へ戻る', async ({ page }) => {
  await open(page);
  await activate(page, 'r2', 'col-b');
  await page.evaluate(() => window.__gridInstance?.setMergedCells([]));
  await frame(page);
  expect(await textarea(page)).toMatchObject({ width: 80, height: 22, clipPath: '' });
  await page.keyboard.type('normal');
  await page.keyboard.press('Enter');
  expect(await sa.displayCell(page, 'r2', 'col-b')).toBe('normal');
});

test('AC5/I-3: 変換中に結合が届いても、確定前の textarea を結合の枠へ変えない', async ({ page }) => {
  await open(page);
  await activate(page, 'r6', 'col-b');
  await sa.composeOpen(page, '変換中');
  await page.evaluate(() => window.__gridInstance?.setMergedCells([{ rowId: 'r6', columnId: 'col-b', rowSpan: 3 }]));
  await frame(page);
  expect(await sa.isComposing(page)).toBe(true);
  expect(await textarea(page)).toMatchObject({ width: 80, height: 22, clipPath: '' });
  await expect(page.locator('textarea.int-cell-editor')).toHaveValue('変換中');
});
