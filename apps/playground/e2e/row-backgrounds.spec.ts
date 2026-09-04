// DD-045 E2E: RowId 指定の静的行背景、優先順位、固定 pane、横スクロール、構造変更追従、未知 RowId 診断。

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import * as sa from './standalone-helpers';

test.describe.configure({ mode: 'serial' });

const ROW_COLOR = '229,231,235'; // #e5e7eb
const COLUMN_COLOR = '255,232,232'; // #ffe8e8
const VALUE_COLOR = '0,255,0'; // #00ff00

async function open(browser: Browser, query: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/standalone.html${query}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
  return { context, page };
}

async function pixelAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(
    ({ px, py }) => {
      const canvas = document.querySelector('.nsheet-stage canvas');
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('base canvas が見つからない');
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('2d context が取れない');
      const dpr = canvas.width / canvas.clientWidth;
      const data = ctx.getImageData(Math.floor(px * dpr), Math.floor(py * dpr), 1, 1).data;
      return `${data[0]},${data[1]},${data[2]}`;
    },
    { px: x, py: y },
  );
}

async function pixelInCell(page: Page, row: number, col: number): Promise<string> {
  const rect = await sa.cellRectAt(page, row, col);
  if (rect === null) throw new Error(`cell (${row},${col}) が見つからない`);
  return pixelAt(page, rect.x + 3, rect.y + rect.height / 2);
}

async function committedHash(page: Page): Promise<string> {
  return page.evaluate(() => window.__integrationTestApi?.committedHash() ?? '');
}

async function rowIndexOf(page: Page, rowId: string): Promise<number> {
  return page.evaluate((id) => window.__integrationTestApi?.rowIndexOf(id) ?? -1, rowId);
}

test('AC1〜5/7: 空セル・固定 pane・横スクロールを含む行帯と優先順位を実ピクセルで確認し、文書 hash は不変', async ({
  browser,
}) => {
  const { context, page } = await open(
    browser,
    '?extracols=201&frozencols=5&frozenrows=1&rowbg=r5:e5e7eb&colbg=col-x2:ffe8e8&format=col-b:HIT=bg%2300ff00',
  );
  try {
    await page.evaluate(() => {
      window.__standalone?.reinject({
        rows: Array.from({ length: 60 }, (_v, i) => ({
          rowId: `r${i}`,
          cells: { 'col-a': `A${i}`, ...(i === 5 ? { 'col-b': 'HIT' } : {}) },
        })),
      });
    });
    await expect.poll(async () => sa.rowCount(page)).toBe(60);
    const hashBefore = await committedHash(page);

    // 固定 pane の col-a と body の空セル col-c が同じ行色になる。
    await expect.poll(async () => pixelInCell(page, 5, 0)).toBe(ROW_COLOR);
    expect(await pixelInCell(page, 5, 2)).toBe(ROW_COLOR);
    // col-x2（index 6）の列背景との交差では行が勝ち、他行では列色のまま。
    expect(await pixelInCell(page, 5, 6)).toBe(ROW_COLOR);
    expect(await pixelInCell(page, 4, 6)).toBe(COLUMN_COLOR);
    // 値ベース書式は静的行背景より勝つ。
    expect(await pixelInCell(page, 5, 1)).toBe(VALUE_COLOR);

    await page.evaluate(() => {
      const scroller = document.querySelector('.nsheet-scroller');
      if (scroller instanceof HTMLElement) scroller.scrollLeft = 6000;
    });
    await expect.poll(async () => documentScrollLeft(page)).toBe(6000);
    const farRect = await sa.cellRectAt(page, 5, 80);
    expect(farRect).not.toBeNull();
    expect(farRect!.x).toBeGreaterThan(450);
    expect(farRect!.x).toBeLessThan(1200);
    await expect.poll(async () => pixelInCell(page, 5, 80)).toBe(ROW_COLOR);

    expect(await committedHash(page)).toBe(hashBefore);
    expect((await sa.events(page)).filter((event) => event.type === 'cell-commit')).toHaveLength(0);
    await page.screenshot({ path: sa.evidencePath('../DD-045/e2e-row-background-scroll.png') });
  } finally {
    await context.close();
  }
});

async function documentScrollLeft(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('.nsheet-scroller')?.scrollLeft ?? -1);
}

test('AC3: 行挿入・削除で index が変わっても RowId r5 の帯が追従する', async ({ browser }) => {
  const { context, page } = await open(browser, '?rowbg=r5:e5e7eb');
  try {
    await expect.poll(async () => pixelInCell(page, 5, 0)).toBe(ROW_COLOR);
    await page.evaluate(() => window.__gridInstance?.insertRows({ afterRowId: 'r3', count: 2 }));
    await expect.poll(async () => rowIndexOf(page, 'r5')).toBe(7);
    expect(await pixelInCell(page, 5, 0)).not.toBe(ROW_COLOR);
    await expect.poll(async () => pixelInCell(page, 7, 0)).toBe(ROW_COLOR);

    const inserted = await Promise.all([sa.rowIdAt(page, 4), sa.rowIdAt(page, 5)]);
    expect(inserted.every((id) => typeof id === 'string')).toBe(true);
    await page.evaluate((ids) => window.__gridInstance?.deleteRows(ids as string[]), inserted);
    await expect.poll(async () => rowIndexOf(page, 'r5')).toBe(5);
    await expect.poll(async () => pixelInCell(page, 5, 0)).toBe(ROW_COLOR);
  } finally {
    await context.close();
  }
});

test('AC6: 未知 RowId は warn 1回のみで mount 成功し、後から同じ RowId が現れれば塗られる', async ({ browser }) => {
  const { context, page } = await open(browser, '?rowbg=r999:e5e7eb');
  try {
    const diagnostics = async (): Promise<Array<{ code: string }>> =>
      page.evaluate(() => window.__standalone?.diagnostics ?? []);
    await expect.poll(async () => (await diagnostics()).filter((d) => d.code === 'row-background-unknown').length).toBe(1);
    expect(await sa.connectionState(page)).toBe('standalone');

    await page.evaluate(() => {
      window.__standalone?.reinject({
        rows: [
          { rowId: 'r999', cells: { 'col-a': '後から到着' } },
          { rowId: 'r0', cells: { 'col-a': '通常行' } },
        ],
      });
    });
    await expect.poll(async () => sa.rowIdAt(page, 0)).toBe('r999');
    await expect.poll(async () => pixelInCell(page, 0, 0)).toBe(ROW_COLOR);
    expect((await diagnostics()).filter((d) => d.code === 'row-background-unknown')).toHaveLength(1);
  } finally {
    await context.close();
  }
});
