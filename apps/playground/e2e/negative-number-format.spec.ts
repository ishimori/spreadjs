// DD-059 E2E: 負の数の表示書式（columnDisplayFormats の number.negative）を単独グリッド（standalone.html・OFIC と同じモード）で確かめる。
//
//   ① 括弧・▲ の描画テキスト（debug API cellRenderText＝描画経路と同じ formatText）
//   ② 負の数の色と、columnFormats の文字色が勝つこと（base canvas のピクセル走査）
//   ③ 括弧表記の列の正の数の右余白（同じ値を余白なしの列と並べ、文字の右端の差が `)` 1文字分になる）
//   ④ 列境界ダブルクリックの自動列幅が余白込みになる
//   ⑤ cell-commit・コピー TSV・セルの値は raw のまま（DD-033-2 の契約）
//   ⑥ 不正な negative は mount 時に column-display-invalid
// 書式の細目（丸め・0 に丸まる負数・prefix/suffix の位置）は unit（display-format.test.ts・base-layer.dd059.test.ts）が担保する。

import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { cellRenderText, columnWidthOverrides, grantClipboard, readClipboard } from './integration-helpers';
import * as sa from './standalone-helpers';

/** col-b=括弧＋赤・col-c=書式は同じで負の数の指定なし（余白なしの比較対象）・col-d=▲。col-b の "-500" だけ columnFormats で青。 */
const QUERY = new URLSearchParams({
  display: 'col-b:number;group;dec0;negparentheses;negcolor#cc0000,col-c:number;group;dec0,col-d:number;group;dec0;negtriangle',
  format: 'col-b:-500=fg#0000ff',
}).toString();

const RED: [number, number, number] = [204, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];
/** grid の CELL_FONT（mount-controller）と同じ。右余白の幅（`)`）をこのフォントで測る。 */
const CELL_FONT = '13px system-ui, sans-serif';

async function openNegative(page: Page, query: string): Promise<void> {
  await page.goto(`/standalone.html?${query}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
}

/** 単独グリッドへ値を入れる（setData＝全置換）。 */
async function seed(page: Page, rows: Record<string, Record<string, string>>): Promise<void> {
  await page.evaluate((cells: Record<string, Record<string, string>>) => {
    window.__standalone?.reinject({
      rows: Array.from({ length: 20 }, (_v, i) => ({ rowId: `r${i}`, cells: cells[`r${i}`] ?? {} })),
    });
  }, rows);
}

/** base canvas の矩形（CSS px）に target 色（±tol）の画素が 1 つでもあるか。 */
async function hasColor(page: Page, rect: sa.CellRect, target: [number, number, number], tol = 50): Promise<boolean> {
  return page.evaluate(
    ({ r, t, tol }: { r: sa.CellRect; t: [number, number, number]; tol: number }) => {
      const canvas = document.querySelectorAll('.nsheet-stage canvas')[0];
      if (!(canvas instanceof HTMLCanvasElement)) {
        return false;
      }
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        return false;
      }
      const d = window.devicePixelRatio;
      const data = ctx.getImageData(
        Math.floor(r.x * d),
        Math.floor(r.y * d),
        Math.max(1, Math.floor(r.width * d)),
        Math.max(1, Math.floor(r.height * d)),
      ).data;
      for (let i = 0; i < data.length; i += 4) {
        if (
          data[i + 3]! > 0 &&
          Math.abs(data[i]! - t[0]) <= tol &&
          Math.abs(data[i + 1]! - t[1]) <= tol &&
          Math.abs(data[i + 2]! - t[2]) <= tol
        ) {
          return true;
        }
      }
      return false;
    },
    { r: rect, t: target, tol },
  );
}

/**
 * セル内で文字のインク（背景・罫線より十分暗い画素）がある最も右の位置（CSS px・セル右端からの距離）。
 * 左右の罫線を避けるため内側 2px を走査対象から外す。インクが無ければ null。
 */
async function inkGapFromRight(page: Page, rect: sa.CellRect): Promise<number | null> {
  return page.evaluate((r: sa.CellRect) => {
    const canvas = document.querySelectorAll('.nsheet-stage canvas')[0];
    if (!(canvas instanceof HTMLCanvasElement)) {
      return null;
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      return null;
    }
    const d = window.devicePixelRatio;
    const x0 = Math.ceil((r.x + 2) * d);
    const x1 = Math.floor((r.x + r.width - 2) * d);
    const y0 = Math.ceil((r.y + 2) * d);
    const y1 = Math.floor((r.y + r.height - 2) * d);
    const w = x1 - x0;
    const h = y1 - y0;
    const data = ctx.getImageData(x0, y0, w, h).data;
    for (let x = w - 1; x >= 0; x -= 1) {
      for (let y = 0; y < h; y += 1) {
        const i = (y * w + x) * 4;
        const lum = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
        if (data[i + 3]! > 0 && lum < 160) {
          return r.x + r.width - (x0 + x + 1) / d;
        }
      }
    }
    return null;
  }, rect);
}

/** CELL_FONT での `)` の幅（右余白の幅）。 */
async function padWidth(page: Page): Promise<number> {
  return page.evaluate((font: string) => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = font;
    return ctx.measureText(')').width;
  }, CELL_FONT);
}

test('負の数が括弧＋赤・▲ で描かれ、columnFormats の文字色が勝ち、値は raw のまま（AC1〜3・AC6）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await grantClipboard(context);
  const page = await context.newPage();
  try {
    await openNegative(page, QUERY);
    await seed(page, {
      r2: { 'col-b': '-1234.5', 'col-c': '-1234.5', 'col-d': '-1234.5' },
      r3: { 'col-b': '1234', 'col-c': '1234' },
      r4: { 'col-b': '0' },
      r5: { 'col-b': '-500' },
      r6: { 'col-b': '-0.4' },
    });
    await sa.selectCell(page, 10, 0); // 選択枠を検査対象のセルから外す

    // ① 描画テキスト（AC1・AC2）。
    await expect.poll(async () => cellRenderText(page, 'r2', 'col-b'), { message: '括弧' }).toBe('(1,235)');
    expect(await cellRenderText(page, 'r2', 'col-c')).toBe('-1,235'); // 未指定は従来どおり
    expect(await cellRenderText(page, 'r2', 'col-d')).toBe('▲1,235');
    expect(await cellRenderText(page, 'r3', 'col-b')).toBe('1,234');
    expect(await cellRenderText(page, 'r4', 'col-b')).toBe('0');
    expect(await cellRenderText(page, 'r5', 'col-b')).toBe('(500)');
    expect(await cellRenderText(page, 'r6', 'col-b')).toBe('0'); // 0 に丸まる負数は負として扱わない

    // ② 色（AC1・AC6）: 負の数だけ赤。columnFormats が一致した "-500" は青が勝つ。
    const neg = (await sa.cellRectAt(page, 2, 1))!;
    await expect.poll(async () => hasColor(page, neg, RED), { message: '負の数が赤' }).toBe(true);
    expect(await hasColor(page, (await sa.cellRectAt(page, 3, 1))!, RED), '正の数は赤くしない').toBe(false);
    expect(await hasColor(page, (await sa.cellRectAt(page, 2, 2))!, RED), '色の指定がない列は赤くしない').toBe(false);
    expect(await hasColor(page, (await sa.cellRectAt(page, 6, 1))!, RED), '0 に丸まる負数は赤くしない').toBe(false);
    const overridden = (await sa.cellRectAt(page, 5, 1))!;
    expect(await hasColor(page, overridden, BLUE), 'columnFormats の文字色').toBe(true);
    expect(await hasColor(page, overridden, RED), '負の数の色は columnFormats に負ける').toBe(false);
    await page.screenshot({ path: evidencePath('negative-format.png') });

    // ⑤ 値は raw のまま（AC3）: セルの値・コピー TSV・cell-commit。
    expect(await sa.displayCell(page, 'r2', 'col-b')).toBe('-1234.5');
    await sa.selectCell(page, 2, 1);
    await page.keyboard.press('Control+c');
    await expect.poll(async () => readClipboard(page), { message: 'コピー TSV は raw' }).toBe('-1234.5');
    await sa.selectCell(page, 7, 1);
    await page.locator('textarea.int-cell-editor').focus();
    await page.keyboard.type('-42');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await sa.events(page)).filter((e) => e.type === 'cell-commit').at(-1)?.changes?.[0]?.value, {
        message: 'cell-commit は raw',
      })
      .toBe('-42');
    expect(await cellRenderText(page, 'r7', 'col-b')).toBe('(42)');
  } finally {
    await context.close();
  }
});

test('括弧表記の列は正の数の右に `)` 1文字分あき、自動列幅も余白込み（AC7）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await openNegative(page, QUERY);
    await seed(page, { r3: { 'col-b': '1234', 'col-c': '1234' } });
    await sa.selectCell(page, 10, 0);
    const pad = await padWidth(page);
    expect(pad).toBeGreaterThan(1);

    // 同じ値・同じ書式・同じ列幅で、col-b（括弧表記）だけ文字の右端が `)` 1文字分内側に来る。
    const withPad = (await sa.cellRectAt(page, 3, 1))!;
    const withoutPad = (await sa.cellRectAt(page, 3, 2))!;
    expect(withPad.width).toBe(withoutPad.width);
    let gapWith: number | null = null;
    let gapWithout: number | null = null;
    await expect
      .poll(
        async () => {
          gapWith = await inkGapFromRight(page, withPad);
          gapWithout = await inkGapFromRight(page, withoutPad);
          return gapWith !== null && gapWithout !== null;
        },
        { message: '両セルに文字が描かれる' },
      )
      .toBe(true);
    expect(Math.abs(gapWith! - gapWithout! - pad), `右余白=${gapWith! - gapWithout!}px・期待=${pad}px`).toBeLessThanOrEqual(1);

    // 自動列幅: 同じ内容の 2 列をダブルクリックで合わせると、括弧表記の列が `)` 1文字分広い。
    await seed(page, { r3: { 'col-b': '123456789', 'col-c': '123456789' } });
    for (const col of [1, 2]) {
      const header = (await sa.columnHeaderRectAt(page, col))!;
      await page
        .locator('.nsheet-scroller')
        .dblclick({ position: { x: header.x + header.width - 2, y: header.y + header.height / 2 } });
    }
    let widths: Record<string, number> = {};
    await expect
      .poll(
        async () => {
          widths = await columnWidthOverrides(page);
          return widths['col-b'] !== undefined && widths['col-c'] !== undefined;
        },
        { message: '2 列とも自動列幅が入る' },
      )
      .toBe(true);
    const diff = widths['col-b']! - widths['col-c']!;
    expect(Math.abs(diff - pad), `列幅の差=${diff}px・期待=${pad}px`).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});

test('不正な negative.style は column-display-invalid で mount を止める（AC4）', async ({ page }) => {
  await page.goto(`/standalone.html?${new URLSearchParams({ display: 'col-b:number;negbrackets' })}`);
  await expect
    .poll(() =>
      page.evaluate(() => window.__standalone?.events.some((e) => e.type === 'error' && e.code === 'column-display-invalid')),
    )
    .toBe(true);
  await expect(page.locator('textarea.int-cell-editor')).toHaveCount(0);
});

/** DD-059 証跡（スクショ）の保存先（test-results 配下・doc/DD を汚さない）。 */
function evidencePath(fileName: string): string {
  return fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-059/${fileName}`, import.meta.url));
}
