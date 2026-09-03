// DD-033-2 E2E: 列見出しキャプション（columnCaptions）＋数値/日付の表示書式（columnDisplayFormats）。
//
// キャプション/表示書式は URL パラメータ `?caption=`・`?display=`（?select=/?format= と同方式・main.ts）で宣言する。
// Canvas に描かれる文字は DOM から読めないため、①描画テキスト（display）は debug API cellRenderText/columnHeaderText で
// 観測し、②実際に描かれていること・クリップ・色（右寄せ数値色/columnFormats 文字色）は base canvas のピクセル走査で
// 確認する。書式の裁定細目は unit（display-format.test.ts）が担保し、ここでは「実ブラウザーで描画が display・契約は raw」
// を検証する（判定は raw・描画は display）。
//
// 構文（main.ts の parseColumnCaptions / parseColumnDisplayFormats）:
//   ?caption=<列>:<表示名>,<列>:<表示名>
//   ?display=<列>:number;group;dec2;pre¥;suf円  ／  <列>:date;YYYY/MM/DD

import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  cellRectAt,
  cellRenderText,
  colIdAt,
  columnHeaderRectAt,
  columnHeaderText,
  columnWidthOverrides,
  committedCell,
  dispatchSyntheticPaste,
  displayCell,
  grantClipboard,
  openClient,
  readClipboard,
  rowIdAt,
  selectCell,
  snapshot,
  WS_ORIGIN,
} from './integration-helpers';
import type { CellRect } from './integration-helpers';

test.describe.configure({ mode: 'serial' });

/** 対象セルへ値を注入する（空セルへ selectCell→paste。paste は editor validator を通らず raw 素通し）。 */
async function seedCell(page: Page, row: number, col: number, value: string): Promise<{ rowId: string; columnId: string }> {
  const rowId = (await rowIdAt(page, row))!;
  const columnId = (await colIdAt(page, col))!;
  await selectCell(page, row, col);
  const consumed = await dispatchSyntheticPaste(page, value);
  expect(consumed).toBe(true);
  await expect.poll(async () => committedCell(page, rowId, columnId), { message: `値注入 ${value}` }).toBe(value);
  return { rowId, columnId };
}

async function clearCell(page: Page, row: number, col: number): Promise<void> {
  const rowId = (await rowIdAt(page, row))!;
  const columnId = (await colIdAt(page, col))!;
  await selectCell(page, row, col);
  await page.keyboard.press('Delete');
  await expect.poll(async () => committedCell(page, rowId, columnId)).toBe('');
}

/** base canvas の指定矩形（CSS px）に target 色（±tol）のピクセルが 1px でもあるか。 */
async function hasColor(page: Page, rect: CellRect, target: [number, number, number], tol = 40): Promise<boolean> {
  return page.evaluate(
    ({ r, t, tol }: { r: CellRect; t: [number, number, number]; tol: number }) => {
      const canvas = document.querySelector('#int-stage canvas');
      if (!(canvas instanceof HTMLCanvasElement)) {
        return false;
      }
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        return false;
      }
      const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
      const x = Math.max(0, Math.floor(r.x * dpr));
      const y = Math.max(0, Math.floor(r.y * dpr));
      const w = Math.max(1, Math.floor(r.width * dpr));
      const h = Math.max(1, Math.floor(r.height * dpr));
      const data = ctx.getImageData(x, y, w, h).data;
      for (let i = 0; i < data.length; i += 4) {
        if (
          data[i + 3] > 0 &&
          Math.abs(data[i] - t[0]) <= tol &&
          Math.abs(data[i + 1] - t[1]) <= tol &&
          Math.abs(data[i + 2] - t[2]) <= tol
        ) {
          return true;
        }
      }
      return false;
    },
    { r: rect, t: target, tol },
  );
}

/** ヘッダー文字色（#555 系のグレー文字）。キャプション/列記号の描画有無の走査に使う。 */
const HEADER_TEXT: [number, number, number] = [85, 85, 85];
/** 数値セルの既定文字色（#1a4f8a・右寄せ数値の色）。 */
const NUMBER_TEXT: [number, number, number] = [26, 79, 138];

async function openDisplayClient(
  browser: Browser,
  name: string,
  query: Record<string, string>,
): Promise<{ context: BrowserContext; page: Page }> {
  return openClient(browser, name, query);
}

test('AC1: columnCaptions 指定列のヘッダーがキャプションで描画され、未指定列は列記号・行番号ヘッダーは従来どおり', async ({
  browser,
}) => {
  const { context, page } = await openDisplayClient(browser, 'caption-basic', { caption: 'col-4:受注金額' });
  try {
    // 描画テキスト（display）: col-4 はキャプション・col-3 は列記号（E/D は columnLabel）。
    expect(await columnHeaderText(page, 4)).toBe('受注金額');
    expect(await columnHeaderText(page, 3)).toBe('D'); // 未指定列は A/B/C…（col index 3 = D）
    // ピクセル: キャプション列ヘッダーに文字（#555 系）が描かれている。
    const capRect = (await columnHeaderRectAt(page, 4))!;
    await expect
      .poll(async () => hasColor(page, capRect, HEADER_TEXT, 60), { message: 'キャプションがヘッダーに描画される' })
      .toBe(true);
    await page.screenshot({ path: evidencePath('caption-basic.png') });
  } finally {
    await context.close();
  }
});

test('AC2: 長いキャプションは自ヘッダーセル幅で省略記号クリップされ、隣接ヘッダーの左端へはみ出さない', async ({
  browser,
}) => {
  const longCaption = 'これは非常に長い列見出しテキストで隣にはみ出さないことを確認する見出し';
  const { context, page } = await openDisplayClient(browser, 'caption-clip', { caption: `col-4:${longCaption}` });
  try {
    expect(await columnHeaderText(page, 4)).toBe(longCaption);
    const capRect = (await columnHeaderRectAt(page, 4))!;
    const neighborRect = (await columnHeaderRectAt(page, 5))!;
    // 自ヘッダーには文字が描かれている（正のコントロール）。
    await expect
      .poll(async () => hasColor(page, capRect, HEADER_TEXT, 60), { message: '自ヘッダーにキャプション描画' })
      .toBe(true);
    // 隣接ヘッダー（col-5）の左端 12px にはキャプション文字がはみ出さない（自セル内 fitText クリップ・AC2）。
    // col-5 の列記号は中央寄せゆえ左端ストリップは背景のみ。はみ出せばここに文字ピクセルが出る。
    const neighborLeftStrip: CellRect = { x: neighborRect.x + 1, y: neighborRect.y, width: 12, height: neighborRect.height };
    expect(await hasColor(page, neighborLeftStrip, HEADER_TEXT, 60)).toBe(false);
  } finally {
    await context.close();
  }
});

test('AC5: 数値/日付が書式済みテキストで描画され（数値色維持）、committed/display/コピー TSV は raw のまま', async ({
  browser,
}) => {
  const { context, page } = await openDisplayClient(browser, 'display-render', {
    display: 'col-4:number;group,col-5:date;YYYY/MM/DD',
  });
  await grantClipboard(context);
  try {
    const num = await seedCell(page, 8, 4, '1234567');
    const date = await seedCell(page, 8, 5, '2026-07-21');
    await selectCell(page, 2, 1);

    // 描画テキストは display（書式済み）。
    await expect
      .poll(async () => cellRenderText(page, num.rowId, num.columnId), { message: '数値 display=1,234,567' })
      .toBe('1,234,567');
    expect(await cellRenderText(page, date.rowId, date.columnId)).toBe('2026/07/21');

    // 契約面は raw のまま（cell-commit round-trip・view.cellDisplay）。
    expect(await committedCell(page, num.rowId, num.columnId)).toBe('1234567');
    expect(await displayCell(page, num.rowId, num.columnId)).toBe('1234567');
    expect(await committedCell(page, date.rowId, date.columnId)).toBe('2026-07-21');
    expect(await displayCell(page, date.rowId, date.columnId)).toBe('2026-07-21');

    // コピー TSV は raw（書式適用前）。
    await selectCell(page, 8, 4);
    await page.keyboard.press('Control+c');
    await expect.poll(async () => readClipboard(page), { message: 'コピー TSV=raw' }).toBe('1234567');

    // 数値は右寄せ＋数値色（#1a4f8a）で描かれる（display でも右寄せ判定は raw で維持）。
    await selectCell(page, 2, 1);
    const numRect = (await cellRectAt(page, 8, 4))!;
    const rightHalf: CellRect = { x: numRect.x + numRect.width / 2, y: numRect.y, width: numRect.width / 2, height: numRect.height };
    await expect
      .poll(async () => hasColor(page, rightHalf, NUMBER_TEXT, 60), { message: '数値が右寄せ＋数値色で描画' })
      .toBe(true);
    await page.screenshot({ path: evidencePath('display-render.png') });
  } finally {
    await clearCell(page, 8, 4).catch(() => {});
    await clearCell(page, 8, 5).catch(() => {});
    await context.close();
  }
});

test('AC6: columnFormats（DD-027-3）併用時、match は raw のまま効き（書式済み文字列では match しない）', async ({
  browser,
}) => {
  // col-4 に number;group（表示 "1,234,567"）＋columnFormats で raw "1234567" に赤文字。display では match しない。
  const { context, page } = await openDisplayClient(browser, 'display-columnformats', {
    display: 'col-4:number;group',
    format: 'col-4:1234567=fg#ff0000',
  });
  try {
    const cell = await seedCell(page, 9, 4, '1234567');
    await selectCell(page, 2, 1);
    // 描画は display。
    await expect
      .poll(async () => cellRenderText(page, cell.rowId, cell.columnId), { message: '描画=1,234,567' })
      .toBe('1,234,567');
    // columnFormats の赤文字が効いている＝match は raw "1234567" で行われた（display "1,234,567" では match しない）。
    const rect = (await cellRectAt(page, 9, 4))!;
    await expect
      .poll(async () => hasColor(page, rect, [255, 0, 0], 50), { message: 'raw match の赤文字が display に適用' })
      .toBe(true);
  } finally {
    await clearCell(page, 9, 4).catch(() => {});
    await context.close();
  }
});

test('AC8: 列境界 dblclick の auto-fit が書式済み内容幅＋キャプション幅で列幅を決める', async ({ browser }) => {
  const longCaption = 'とても長いキャプション見出しテキスト列';
  const { context, page } = await openDisplayClient(browser, 'display-autofit', {
    display: 'col-4:number;group',
    caption: `col-5:${longCaption}`,
  });
  try {
    const box = (await page.locator('.nsheet-scroller').boundingBox())!;
    // --- col-4: 書式済み内容幅（"123,456,789" は raw "123456789" より広い）で auto-fit する ---
    const numCell = await seedCell(page, 12, 4, '123456789');
    // 一旦狭める。
    const start4 = (await columnHeaderRectAt(page, 4))!;
    const y4 = box.y + start4.y + start4.height / 2;
    await page.mouse.move(box.x + start4.x + start4.width - 2, y4);
    await page.mouse.down();
    await page.mouse.move(box.x + start4.x + 24, y4, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await columnHeaderRectAt(page, 4))!.width, { message: 'col-4 一旦狭く' }).toBeLessThan(start4.width);
    const narrow4 = (await columnHeaderRectAt(page, 4))!;
    await page
      .locator('.nsheet-scroller')
      .dblclick({ position: { x: narrow4.x + narrow4.width - 2, y: narrow4.y + narrow4.height / 2 } });
    // 書式済み内容（"123,456,789"）が入る幅へ広がる。
    await expect
      .poll(async () => (await columnHeaderRectAt(page, 4))!.width, { message: 'col-4 auto-fit で内容幅へ' })
      .toBeGreaterThan(narrow4.width + 30);
    expect(Object.keys(await columnWidthOverrides(page))).toContain(numCell.columnId);

    // --- col-5: 長いキャプション幅で auto-fit する（空セル列でもヘッダー幅が効く） ---
    const start5 = (await columnHeaderRectAt(page, 5))!;
    const y5 = box.y + start5.y + start5.height / 2;
    await page.mouse.move(box.x + start5.x + start5.width - 2, y5);
    await page.mouse.down();
    await page.mouse.move(box.x + start5.x + 24, y5, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await columnHeaderRectAt(page, 5))!.width, { message: 'col-5 一旦狭く' }).toBeLessThan(start5.width);
    const narrow5 = (await columnHeaderRectAt(page, 5))!;
    await page
      .locator('.nsheet-scroller')
      .dblclick({ position: { x: narrow5.x + narrow5.width - 2, y: narrow5.y + narrow5.height / 2 } });
    // キャプション（十数文字の日本語）を収める幅＝narrow より大幅に広い（列記号 "F" だけなら細い）。
    await expect
      .poll(async () => (await columnHeaderRectAt(page, 5))!.width, { message: 'col-5 auto-fit でキャプション幅へ' })
      .toBeGreaterThan(narrow5.width + 80);
  } finally {
    await clearCell(page, 12, 4).catch(() => {});
    await context.close();
  }
});

test('AC10: readOnly と併用してもキャプション・表示書式が有効（親AC7 デモ構成）', async ({ browser }) => {
  // まず編集可能クライアントで col-4 row10 に値を入れる（readOnly では注入できないため）。
  const seeder = await openDisplayClient(browser, 'ro-seed', {});
  const rowId = (await rowIdAt(seeder.page, 10))!;
  const columnId = (await colIdAt(seeder.page, 4))!;
  try {
    await seedCell(seeder.page, 10, 4, '5000000');
  } finally {
    await seeder.context.close();
  }

  const { context, page } = await openDisplayClient(browser, 'ro-display', {
    display: 'col-4:number;group',
    caption: 'col-4:受注金額',
    readonly: '1',
  });
  try {
    // readOnly でもキャプション・表示書式が効く。
    expect(await columnHeaderText(page, 4)).toBe('受注金額');
    await expect
      .poll(async () => cellRenderText(page, rowId, columnId), { message: 'readOnly でも display=5,000,000' })
      .toBe('5,000,000');
    // 契約は raw のまま。
    expect(await committedCell(page, rowId, columnId)).toBe('5000000');
    // readOnly の実効: 編集開始不能（committedHash 不変）。dblclick しても textarea 編集は開かない。
    const before = (await snapshot(page)).committedHash;
    await selectCell(page, 10, 4);
    await page.keyboard.press('F2');
    await page.keyboard.type('999');
    await page.keyboard.press('Enter');
    expect((await snapshot(page)).committedHash).toBe(before);
    expect(await committedCell(page, rowId, columnId)).toBe('5000000');
  } finally {
    // 後始末は編集可能クライアントで行う。
    const cleaner = await openDisplayClient(browser, 'ro-clean', {});
    try {
      await clearCell(cleaner.page, 10, 4).catch(() => {});
    } finally {
      await cleaner.context.close();
    }
    await context.close();
  }
});

test('AC7: 不正 columnDisplayFormats（未知列）→ config error（column-display-invalid）・配線しない', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto(
      `/poc-integration.html?server=${encodeURIComponent(WS_ORIGIN)}&display=${encodeURIComponent('col-zzz:number;group')}`,
    );
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const events = (window as unknown as { __gridEvents?: Array<{ type: string; code?: string }> }).__gridEvents ?? [];
            return events.find((ev) => ev.type === 'error')?.code ?? null;
          }),
        { message: 'column-display-invalid が config error として通知される' },
      )
      .toBe('column-display-invalid');
    expect((await snapshot(page)).ready).toBe(false); // 未配線（session を作らない）
  } finally {
    await context.close();
  }
});

test('AC7: 空キャプション → config error（column-display-invalid）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    // ?caption=col-4:%20（空白のみ）→ empty-caption。
    await page.goto(
      `/poc-integration.html?server=${encodeURIComponent(WS_ORIGIN)}&caption=${encodeURIComponent('col-4:   ')}`,
    );
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const events = (window as unknown as { __gridEvents?: Array<{ type: string; code?: string }> }).__gridEvents ?? [];
            return events.find((ev) => ev.type === 'error')?.code ?? null;
          }),
        { message: '空/空白キャプションで column-display-invalid' },
      )
      .toBe('column-display-invalid');
    expect((await snapshot(page)).ready).toBe(false);
  } finally {
    await context.close();
  }
});

/** DD-033-2 証跡（スクショ）の保存先（active な doc/DD を汚さず test-results 配下）。 */
function evidencePath(fileName: string): string {
  return fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-033-2/${fileName}`, import.meta.url));
}
