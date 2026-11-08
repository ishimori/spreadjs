// DD-069 E2E: セルごとの背景色（行データの cellBackgrounds・setCellBackgrounds）。
//
// 単独モード（standalone.html?rowbg=…&colbg=…&format=…&merged=…）で、指定したセルだけがその色で描かれ、行・列の背景より
// 勝ち、値ベース書式・状態表示（cellStatus）には負けること、結合したセルは左上のセルの色になること、setRows・
// setCellBackgrounds で描き直り {} で消えること、不正な色は診断 warn だけで描かないこと、文書を変えないことを実ピクセルで確かめる。

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import * as sa from './standalone-helpers';

test.describe.configure({ mode: 'serial' });

const ROW_COLOR = '229,231,235'; // ?rowbg=r5:e5e7eb
const COLUMN_COLOR = '255,232,232'; // ?colbg=col-c:ffe8e8
const VALUE_COLOR = '0,255,0'; // ?format=col-b:HIT=bg#00ff00
const WARNING_BG = '254,247,224'; // base-layer の CELL_STATUS_COLORS.warning.background
const CELL_COLOR = '0,170,255'; // #00aaff
const CELL_COLOR_2 = '170,255,0'; // #aaff00
const PANE_COLOR = '255,255,255';

const MERGE = [{ rowId: 'r10', columnId: 'col-b', rowSpan: 2 }];
const QUERY =
  '?rowbg=r5:e5e7eb&colbg=col-c:ffe8e8&format=col-b:HIT=bg%2300ff00' +
  `&merged=${encodeURIComponent(JSON.stringify(MERGE))}`;

interface BackgroundWindow {
  __standalone?: {
    events: Array<{ type: string }>;
    diagnostics: Array<{ code: string }>;
    reinject(data: unknown): void;
    applyRows(rows: unknown): void;
  };
  __gridInstance?: { setCellBackgrounds(rows: unknown): void };
  __integrationTestApi?: { committedHash(): string };
}

async function open(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/standalone.html${QUERY}`);
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

/** セルの右端寄り（左寄せの文字の無い所）の色。状態表示の枠（内側 2px）を避けるため、縦は中央・横は枠の内側。 */
async function pixelInCell(page: Page, row: number, col: number): Promise<string> {
  const rect = await sa.cellRectAt(page, row, col);
  if (rect === null) throw new Error(`cell (${row},${col}) が見つからない`);
  return pixelAt(page, rect.x + rect.width - 6, rect.y + rect.height / 2);
}

async function committedHash(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as BackgroundWindow).__integrationTestApi?.committedHash() ?? '');
}

test('K8: 指定したセルだけがその色。行・列の背景より勝ち、値ベース書式・状態表示に負け、結合は左上の色', async ({ browser }) => {
  const { context, page } = await open(browser);
  try {
    await page.evaluate(() => {
      (window as unknown as BackgroundWindow).__standalone?.reinject({
        rows: Array.from({ length: 20 }, (_v, i) => ({
          rowId: `r${i}`,
          ...(i === 7 ? { cells: { 'col-b': 'HIT' } } : {}),
          ...(i === 4 ? { cellBackgrounds: { 'col-c': '#00aaff' } } : {}),
          ...(i === 5 ? { cellBackgrounds: { 'col-a': '#00aaff' } } : {}),
          ...(i === 7 ? { cellBackgrounds: { 'col-b': '#00aaff' } } : {}),
          ...(i === 8 ? { cellBackgrounds: { 'col-b': '#00aaff' }, cellStatus: { 'col-b': { level: 'warning' } } } : {}),
          ...(i === 10 ? { cellBackgrounds: { 'col-b': '#00aaff' } } : {}),
          ...(i === 11 ? { cellBackgrounds: { 'col-b': '#aaff00' } } : {}),
          ...(i === 12 ? { cellBackgrounds: { 'col-d': '#00aaff' } } : {}),
        })),
      });
    });
    await expect.poll(async () => sa.rowCount(page)).toBe(20);
    const hashBefore = await committedHash(page);

    // 行の背景（r5）の上でも、固定列（col-a）のセルの色が勝つ。同じ行の他のセルは行の色のまま。
    await expect.poll(async () => pixelInCell(page, 5, 0)).toBe(CELL_COLOR);
    expect(await pixelInCell(page, 5, 1)).toBe(ROW_COLOR);
    // 列の背景（col-c）の上でも、セルの色が勝つ。同じ列の他の行は列の色のまま。
    expect(await pixelInCell(page, 4, 2)).toBe(CELL_COLOR);
    expect(await pixelInCell(page, 3, 2)).toBe(COLUMN_COLOR);
    // 行も列も背景の無い所（r12 col-d）にも付く。隣は pane の白。
    expect(await pixelInCell(page, 12, 3)).toBe(CELL_COLOR);
    expect(await pixelInCell(page, 13, 3)).toBe(PANE_COLOR);
    // 値ベース書式（HIT=緑）と状態表示（warning の薄黄）はセルの色より勝つ。
    expect(await pixelInCell(page, 7, 1)).toBe(VALUE_COLOR);
    expect(await pixelInCell(page, 8, 1)).toBe(WARNING_BG);
    // 結合（r10..r11 × col-b）は左上のセルの色で全体を塗る（r11 の指定は覆われて出ない）。
    expect(await pixelInCell(page, 10, 1)).toBe(CELL_COLOR);
    expect(await pixelInCell(page, 11, 1)).toBe(CELL_COLOR);
    await page.screenshot({ path: sa.evidencePath('../DD-069/e2e-cell-backgrounds.png') });

    // 文書は変わらない（view-local）。
    expect(await committedHash(page)).toBe(hashBefore);
    expect((await sa.events(page)).filter((e) => e.type === 'cell-commit')).toEqual([]);
  } finally {
    await context.close();
  }
});

test('K8: setRows・setCellBackgrounds で描き直り、{} で消え、不正な色は診断 warn だけで描かない', async ({ browser }) => {
  const { context, page } = await open(browser);
  try {
    await page.evaluate(() => {
      (window as unknown as BackgroundWindow).__standalone?.reinject({
        rows: Array.from({ length: 20 }, (_v, i) => ({
          rowId: `r${i}`,
          cells: { 'col-a': `A${i}` },
          ...(i === 4 ? { cellBackgrounds: { 'col-c': '#00aaff' } } : {}),
          ...(i === 5 ? { cellBackgrounds: { 'col-a': '#00aaff' } } : {}),
        })),
      });
    });
    await expect.poll(async () => pixelInCell(page, 5, 0)).toBe(CELL_COLOR);
    const hashBefore = await committedHash(page);

    // setRows: 渡した行を丸ごと置き換える（r5 の col-a は消え、col-b に付く）。値の変更を伴わない。
    await page.evaluate(() => {
      (window as unknown as BackgroundWindow).__standalone?.applyRows([{ rowId: 'r5', cellBackgrounds: { 'col-b': '#aaff00' } }]);
    });
    await expect.poll(async () => pixelInCell(page, 5, 1)).toBe(CELL_COLOR_2);
    expect(await pixelInCell(page, 5, 0)).toBe(ROW_COLOR);

    // setCellBackgrounds（両モード共通）: {} で消すと列の色へ戻る。
    await page.evaluate(() => {
      (window as unknown as BackgroundWindow).__gridInstance?.setCellBackgrounds([{ rowId: 'r4', cellBackgrounds: {} }]);
    });
    await expect.poll(async () => pixelInCell(page, 4, 2)).toBe(COLUMN_COLOR);
    await page.evaluate(() => {
      (window as unknown as BackgroundWindow).__gridInstance?.setCellBackgrounds([{ rowId: 'r6', cellBackgrounds: { 'col-d': '#aaff00' } }]);
    });
    await expect.poll(async () => pixelInCell(page, 6, 3)).toBe(CELL_COLOR_2);

    // 空白だけの色は捨てて診断 warn（例外にしない）。その行の他のセルは付く。
    await page.evaluate(() => {
      (window as unknown as BackgroundWindow).__standalone?.applyRows([
        { rowId: 'r9', cellBackgrounds: { 'col-b': '  ', 'col-d': '#00aaff' } },
      ]);
    });
    await expect.poll(async () => pixelInCell(page, 9, 3)).toBe(CELL_COLOR);
    expect(await pixelInCell(page, 9, 1)).toBe(PANE_COLOR); // 本体の列（固定列は地の色が違う）
    const codes = await page.evaluate(() =>
      ((window as unknown as BackgroundWindow).__standalone?.diagnostics ?? []).map((d) => d.code),
    );
    expect(codes).toContain('cell-background-invalid');
    // ここまでの背景の付け外しでは文書は変わらない（view-local）。
    expect(await committedHash(page)).toBe(hashBefore);

    // setData で作り直す（省略した再注入では前の色を引きずらない）。
    await page.evaluate(() => {
      (window as unknown as BackgroundWindow).__standalone?.reinject({
        rows: Array.from({ length: 20 }, (_v, i) => ({ rowId: `r${i}`, cells: { 'col-a': `A${i}` } })),
      });
    });
    await expect.poll(async () => pixelInCell(page, 6, 3)).toBe(PANE_COLOR);
    expect(await pixelInCell(page, 5, 1)).toBe(ROW_COLOR);

    expect((await sa.events(page)).filter((e) => e.type === 'cell-commit')).toEqual([]);
  } finally {
    await context.close();
  }
});
