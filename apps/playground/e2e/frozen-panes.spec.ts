// DD-036 C1/C2 E2E: 固定行列数（frozenRowCount / frozenColumnCount）と静的列背景（columnBackgrounds）。
//
// 単独モード（standalone.html?extracols=24&frozencols=5&frozenrows=1&colbg=...）で
//   AC1: 先頭 5 列が横スクロールしても画面左に残り、固定バンド内のヒットテスト（クリック→activeCell）がずれない
//   AC2: 未指定なら現行（1/1）と同じ（既定ページで先頭 1 列だけが固定）
//   AC3/AC4: 指定列は**空セルも**塗られ、値ベース書式（columnFormats）があるセルはそちらが勝つ
// を検証する。色は Canvas 描画ゆえ base canvas の getImageData で実ピクセルを読む（値の観測は debug API）。

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import * as sa from './standalone-helpers';

test.describe.configure({ mode: 'serial' });

/** 固定 5 列＋24 列追加。col-c（index 2・固定バンド内）と col-x0（index 4・固定バンド内最終列）に網掛け。 */
const QUERY =
  '?extracols=24&frozencols=5&frozenrows=1&colbg=col-c:eef3ff,col-x2:ffe8e8&format=col-b:HIT=bg%23ff0000';

async function open(browser: Browser, query: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/standalone.html${query}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
  return { context, page };
}

/** base canvas の CSS 座標 (x,y) の実ピクセル色を "r,g,b" で返す（DPR を加味する）。 */
async function pixelAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(
    ({ px, py }: { px: number; py: number }) => {
      const canvas = document.querySelector('.nsheet-stage canvas');
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('base canvas が見つからない');
      }
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        throw new Error('2d context が取れない');
      }
      const dpr = canvas.width / canvas.clientWidth;
      const data = ctx.getImageData(Math.floor(px * dpr), Math.floor(py * dpr), 1, 1).data;
      return `${data[0]},${data[1]},${data[2]}`;
    },
    { px: x, py: y },
  );
}

async function scrollLeft(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('.nsheet-scroller')?.scrollLeft ?? -1);
}

async function scrollTop(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('.nsheet-scroller')?.scrollTop ?? -1);
}

/**
 * DD-039: 指定矩形（CSS 座標）の実ピクセルを読み、内容を表す指紋（FNV-1a）で返す。
 * ヘッダー帯は「スクロールしても固定側は 1 ピクセルも変わらない」ことが期待値なので、
 * 個別の文字位置ではなく帯まるごとの同一性で検証する。
 */
async function regionSignature(page: Page, x: number, y: number, w: number, h: number): Promise<string> {
  return page.evaluate(
    ({ rx, ry, rw, rh }: { rx: number; ry: number; rw: number; rh: number }) => {
      const canvas = document.querySelector('.nsheet-stage canvas');
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('base canvas が見つからない');
      }
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        throw new Error('2d context が取れない');
      }
      const dpr = canvas.width / canvas.clientWidth;
      const data = ctx.getImageData(
        Math.round(rx * dpr),
        Math.round(ry * dpr),
        Math.max(1, Math.round(rw * dpr)),
        Math.max(1, Math.round(rh * dpr)),
      ).data;
      let hash = 0x811c9dc5;
      for (let i = 0; i < data.length; i += 1) {
        hash ^= data[i] ?? 0;
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16);
    },
    { rx: x, ry: y, rw: w, rh: h },
  );
}

test('AC1: frozenColumnCount=5 で先頭 5 列が横スクロールしても画面左に残る（ヒットテストも pane 境界でずれない）', async ({
  browser,
}) => {
  const { context, page } = await open(browser, QUERY);
  try {
    const before = await Promise.all([0, 4, 6].map((col) => sa.cellRectAt(page, 1, col)));
    expect(before[0]!.x).toBeGreaterThan(0);

    // 横スクロール（固定列 5 列＝400px の右側を大きく送る）。
    await page.evaluate(() => {
      const scroller = document.querySelector('.nsheet-scroller');
      if (scroller instanceof HTMLElement) {
        scroller.scrollLeft = 800;
      }
    });
    await expect.poll(async () => scrollLeft(page)).toBe(800);
    await expect
      .poll(async () => (await sa.cellRectAt(page, 1, 6))?.x, { message: 'スクロール列は左へ流れる' })
      .toBeLessThan(before[2]!.x);

    // 固定列（index 0..4）の矩形はスクロール前後で不変。
    const after = await Promise.all([0, 4].map((col) => sa.cellRectAt(page, 1, col)));
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);

    // 固定バンド内（index 4）のクリックが index 4 に当たる（ヒットテストがスクロール量に影響されない）。
    await sa.selectCell(page, 3, 4);
    await expect.poll(async () => sa.activeCell(page)).toEqual({ row: 3, col: 4 });
    // 固定バンドより右に描かれている body 列（scrollLeft=800・固定幅 400px ゆえ可視は index 15 以降）も
    // その位置に描かれている列に当たる（固定/本体の pane 境界でヒットテストがずれない）。
    const bodyRect = (await sa.cellRectAt(page, 3, 16))!;
    expect(bodyRect.x).toBeGreaterThan(52 + 5 * 80); // 固定バンドの右側に出ている
    await page
      .locator('.nsheet-scroller')
      .click({ position: { x: bodyRect.x + bodyRect.width / 2, y: bodyRect.y + bodyRect.height / 2 } });
    await expect.poll(async () => sa.activeCell(page)).toEqual({ row: 3, col: 16 });
    await page.screenshot({ path: sa.evidencePath('../DD-036/e2e-frozen-1-columns.png') });
  } finally {
    await context.close();
  }
});

test('AC2: 未指定なら固定は先頭 1 行 1 列のまま（現行挙動）', async ({ browser }) => {
  const { context, page } = await open(browser, '?extracols=24');
  try {
    const col0Before = (await sa.cellRectAt(page, 1, 0))!;
    const col1Before = (await sa.cellRectAt(page, 1, 1))!;
    await page.evaluate(() => {
      const scroller = document.querySelector('.nsheet-scroller');
      if (scroller instanceof HTMLElement) {
        scroller.scrollLeft = 400;
      }
    });
    await expect.poll(async () => scrollLeft(page)).toBe(400);
    await expect.poll(async () => (await sa.cellRectAt(page, 1, 1))?.x).toBeLessThan(col1Before.x);
    // 先頭 1 列だけが固定＝動かない。
    expect(await sa.cellRectAt(page, 1, 0)).toEqual(col0Before);
  } finally {
    await context.close();
  }
});

test('AC3/AC4: columnBackgrounds は空セルも塗り、値ベース書式（columnFormats）が同一セルでは勝つ', async ({
  browser,
}) => {
  const { context, page } = await open(browser, QUERY);
  try {
    // seed は col-a のみ＝col-c は空セル。空セルでも指定色（#eef3ff = 238,243,255）で塗られる。
    const emptyCell = (await sa.cellRectAt(page, 4, 2))!;
    expect(await sa.displayCell(page, 'r4', 'col-c')).toBe('');
    expect(await pixelAt(page, emptyCell.x + emptyCell.width / 2, emptyCell.y + emptyCell.height / 2)).toBe(
      '238,243,255',
    );

    // 未指定列（col-a・index 0）は従来の背景のまま（網掛け色ではない）。
    const plain = (await sa.cellRectAt(page, 4, 0))!;
    expect(await pixelAt(page, plain.x + plain.width / 2, plain.y + plain.height / 2)).not.toBe('238,243,255');

    // 網掛け列（col-x2・index 6）にも値を入れて、値ベース書式のない値なら列色のままであることを見る。
    await page.evaluate(() => {
      window.__standalone?.reinject({
        rows: Array.from({ length: 20 }, (_v, i) => ({
          rowId: `r${i}`,
          cells: { 'col-a': `A${i}`, 'col-b': i === 5 ? 'HIT' : 'MISS', 'col-x2': `X${i}` },
        })),
      });
    });
    await expect.poll(async () => sa.displayCell(page, 'r4', 'col-x2')).toBe('X4');
    const shaded = (await sa.cellRectAt(page, 4, 6))!;
    await expect
      .poll(async () => pixelAt(page, shaded.x + 3, shaded.y + shaded.height / 2), { message: '網掛け列の再描画待ち' })
      .toBe('255,232,232');

    // col-b（値ベース書式 'HIT'→背景 #ff0000）は網掛け列ではないが、値ベース書式が効く＝優先順位の実証。
    const hit = (await sa.cellRectAt(page, 5, 1))!;
    // セル中央は文字が描かれているため、文字より左（padding 手前）の背景ピクセルを読む。
    await expect.poll(async () => pixelAt(page, hit.x + 3, hit.y + hit.height / 2)).toBe('255,0,0');
    // 同じ列の他行（'MISS'＝書式なし）は既定背景。
    const miss = (await sa.cellRectAt(page, 4, 1))!;
    expect(await pixelAt(page, miss.x + 3, miss.y + miss.height / 2)).not.toBe('255,0,0');
    await page.screenshot({ path: sa.evidencePath('../DD-036/e2e-column-background-1.png') });
  } finally {
    await context.close();
  }
});

test('AC4-2: 網掛け列に値ベース書式を重ねると、そのセルだけ値ベース色が勝つ', async ({ browser }) => {
  const { context, page } = await open(
    browser,
    '?extracols=8&colbg=col-c:eef3ff&format=col-c:HIT=bg%2300ff00',
  );
  try {
    await page.evaluate(() => {
      window.__standalone?.reinject({
        rows: [
          { rowId: 'r0', cells: { 'col-c': 'HIT' } },
          { rowId: 'r1', cells: {} },
        ],
      });
    });
    await expect.poll(async () => sa.displayCell(page, 'r0', 'col-c')).toBe('HIT');
    const hit = (await sa.cellRectAt(page, 0, 2))!;
    const empty = (await sa.cellRectAt(page, 1, 2))!;
    // 値の反映（displayCell）と Canvas 再描画は別フレームゆえ、ピクセルは poll で待つ。
    await expect
      .poll(async () => pixelAt(page, hit.x + 3, hit.y + hit.height / 2), { message: '値ベース書式の再描画待ち' })
      .toBe('0,255,0');
    expect(await pixelAt(page, empty.x + empty.width / 2, empty.y + empty.height / 2)).toBe('238,243,255');
  } finally {
    await context.close();
  }
});

test('DD-039 AC1: 横スクロールしても固定列の見出し帯が変化しない（スクロール列の見出しが重ならない）', async ({
  browser,
}) => {
  const { context, page } = await open(browser, QUERY);
  try {
    // 固定 5 列。row0/col0 の矩形からヘッダー帯の寸法を得る（x=headerWidth・y=headerHeight）。
    const first = (await sa.cellRectAt(page, 0, 0))!;
    const lastFrozen = (await sa.cellRectAt(page, 0, 4))!;
    const band = { x: first.x, w: lastFrozen.x + lastFrozen.width - first.x, h: first.y };
    const scrollBandX = band.x + band.w;
    const frozenBefore = await regionSignature(page, band.x, 0, band.w, band.h);
    const scrollBefore = await regionSignature(page, scrollBandX, 0, 200, band.h);

    await page.evaluate(() => {
      const scroller = document.querySelector('.nsheet-scroller');
      if (scroller instanceof HTMLElement) {
        scroller.scrollLeft = 800;
      }
    });
    await expect.poll(async () => scrollLeft(page)).toBe(800);
    // まずスクロール側の見出し帯が変わったこと＝ヘッダーが再描画されたことを確認する。
    await expect
      .poll(async () => regionSignature(page, scrollBandX, 0, 200, band.h), { message: 'ヘッダー再描画待ち' })
      .not.toBe(scrollBefore);
    // 本題: 固定側の見出し帯は 1 ピクセルも変わらない（修正前はここへスクロール列の見出しが重なっていた）。
    expect(await regionSignature(page, band.x, 0, band.w, band.h)).toBe(frozenBefore);
    await page.screenshot({ path: sa.evidencePath('../DD-039/e2e-header-clip-columns.png') });
  } finally {
    await context.close();
  }
});

test('DD-039 AC2: 縦スクロールしても固定行の行番号帯が変化しない', async ({ browser }) => {
  const { context, page } = await open(browser, QUERY);
  try {
    // スクロール余地を作る（既定シードは行数が少なく scrollTop を取れない）。
    await page.evaluate(() => {
      window.__standalone?.reinject({
        rows: Array.from({ length: 60 }, (_v, i) => ({ rowId: `r${i}`, cells: { 'col-a': `A${i}` } })),
      });
    });
    await expect.poll(async () => sa.rowCount(page)).toBe(60);

    const first = (await sa.cellRectAt(page, 0, 0))!;
    // 固定 1 行ぶんの行番号帯（x=0..headerWidth・y=headerHeight..+行高）。
    const band = { y: first.y, w: first.x, h: first.height };
    const scrollBandY = band.y + band.h;
    const frozenBefore = await regionSignature(page, 0, band.y, band.w, band.h);
    const scrollBefore = await regionSignature(page, 0, scrollBandY, band.w, 120);

    await page.evaluate(() => {
      const scroller = document.querySelector('.nsheet-scroller');
      if (scroller instanceof HTMLElement) {
        scroller.scrollTop = 300;
      }
    });
    await expect.poll(async () => scrollTop(page)).toBe(300);
    await expect
      .poll(async () => regionSignature(page, 0, scrollBandY, band.w, 120), { message: '行番号帯の再描画待ち' })
      .not.toBe(scrollBefore);
    expect(await regionSignature(page, 0, band.y, band.w, band.h)).toBe(frozenBefore);
    await page.screenshot({ path: sa.evidencePath('../DD-039/e2e-header-clip-rows.png') });
  } finally {
    await context.close();
  }
});

test('Codex P2: 列数を超える frozenColumnCount（全列固定）でも setData・行挿入で描画が止まらない', async ({
  browser,
}) => {
  const { context, page } = await open(browser, '?frozencols=99&frozenrows=1');
  try {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // 全列固定（4 列 < 99）の状態で構造変更（setData → 行挿入）を起こす＝flushStructural の captureAnchor 経路。
    await page.evaluate(() => {
      const rows = Array.from({ length: 30 }, (_v, i) => ({ rowId: `r${i}`, cells: { 'col-a': `A${i}` } }));
      window.__standalone?.reinject({ rows });
    });
    await expect.poll(async () => sa.rowCount(page)).toBe(30);
    await page.evaluate(() => window.__gridInstance?.insertRows({ afterRowId: 'r5', count: 2 }));
    await expect.poll(async () => sa.rowCount(page)).toBe(32);
    // 描画ループが生きている（セル矩形が取れる・値が読める）＋ page error なし。
    expect(await sa.cellRectAt(page, 3, 0)).not.toBeNull();
    expect(await sa.displayCell(page, 'r7', 'col-a')).toBe('A7');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

