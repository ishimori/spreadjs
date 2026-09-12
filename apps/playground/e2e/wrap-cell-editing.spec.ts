// DD-052-1 E2E（RC1: セル内改行・RC2: 長文編集欄）: wrap 列の編集中に Alt+Enter がセル内改行になり、
// textarea が内容に合わせて下へ伸びることを実ブラウザーで確認する。非 wrap 列は Alt+Enter も通常の
// Enter と同じ確定＋移動のまま変わらないことも合わせて確認する（既存 consumer への互換性）。

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  cellRectAt,
  committedCell,
  editorProbe,
  emulateScrollbars,
  evidencePathDD055,
  highlightCell,
  highlightSelector,
  lastFullyVisibleRow,
  openClient,
  overlayGeometry,
  rowIdAt,
  colIdAt,
  saveEvidenceJsonDD055,
  scrollTo,
  selectCell,
} from './integration-helpers';
import * as sa from './standalone-helpers';

test('wrap 列で Alt+Enter → セル内改行（確定・移動しない）。Enter で確定すると改行を含む値になる（RC1）', async ({
  browser,
}) => {
  const { context, page } = await openClient(browser, 'RC1改行', { wrap: 'col-2' });
  try {
    const row = 5;
    const wrapCol = 2; // col-2（wrap 列・text-display.spec.ts と同じ配線）
    const rowId = (await rowIdAt(page, row))!;
    const columnId = (await colIdAt(page, wrapCol))!;

    await selectCell(page, row, wrapCol);
    await page.keyboard.type('line1');
    await page.keyboard.press('Alt+Enter'); // RC1: セル内改行（確定しない）
    await page.keyboard.type('line2');

    // 確定前: draft は改行を含み、まだ編集継続（committed は変わっていない）。
    await expect
      .poll(async () => (await editorProbe(page)).value, { message: 'Alt+Enter は draft に改行を挿入する' })
      .toBe('line1\nline2');
    expect(await committedCell(page, rowId, columnId), 'Alt+Enter では確定しない').not.toBe('line1\nline2');

    await page.keyboard.press('Enter'); // 通常の Enter で確定
    await expect
      .poll(async () => committedCell(page, rowId, columnId), { message: '確定値に改行が保持される' })
      .toBe('line1\nline2');
  } finally {
    await context.close();
  }
});

test('wrap 列でない列（col-0）の Alt+Enter は通常の Enter と同じ確定＋下移動のまま変わらない（互換性）', async ({
  browser,
}) => {
  const { context, page } = await openClient(browser, 'RC1非wrap', { wrap: 'col-2' }); // col-0 は wrap 対象外
  try {
    const row = 5;
    const plainCol = 0;
    const rowId = (await rowIdAt(page, row))!;
    const columnId = (await colIdAt(page, plainCol))!;

    await selectCell(page, row, plainCol);
    await page.keyboard.type('abc');
    await page.keyboard.press('Alt+Enter'); // wrap 列でないので通常の Enter と同じ扱い

    await expect
      .poll(async () => committedCell(page, rowId, columnId), { message: '非wrap列の Alt+Enter は確定する' })
      .toBe('abc');
    // 確定＋下移動＝アクティブセルが次行の同じ列に進む（改行は挿入されない＝1行のまま）。
    expect((await editorProbe(page)).value).not.toContain('\n');
  } finally {
    await context.close();
  }
});

test('wrap 列の長文編集中は textarea が内容に応じて下へ伸びる（RC2・列幅は変わらない）', async ({ browser }) => {
  const { context, page } = await openClient(browser, 'RC2伸長', { wrap: 'col-2' });
  try {
    const row = 5;
    const wrapCol = 2;
    const before = (await cellRectAt(page, row, wrapCol))!;

    await selectCell(page, row, wrapCol);
    const singleLineHeight = (await editorProbe(page)).height;

    await page.keyboard.type('1行目');
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Alt+Enter');
      await page.keyboard.type(`${i + 2}行目`);
    }

    await expect
      .poll(
        async () => {
          const probe = await editorProbe(page);
          return parseFloat(probe.height) > parseFloat(singleLineHeight);
        },
        { message: '複数行入力で textarea の高さが単一行より伸びる' },
      )
      .toBe(true);

    // 列幅（横方向のセル矩形）は変わらない。
    const afterEditingRect = await cellRectAt(page, row, wrapCol);
    expect(afterEditingRect?.width).toBe(before.width);

    await page.keyboard.press('Escape'); // 変更を確定せずに終了（他テストへの副作用を避ける）
  } finally {
    await context.close();
  }
});

// ---- DD-055（ReadyCrew RC17）: 行が高いセル・可視域の下端での編集欄の高さ --------------------------------
// 単独モード（共有文書を汚さない）で値を reinject して行の高さを作る。証跡は失敗しうる検証より前に保存する。

const EDITOR = 'textarea.int-cell-editor';

/** 単独モードを wrap 列 col-b・60 行で開き、指定行の col-b に「N 行の値」を入れる（行の高さは行数で自動的に決まる）。 */
async function openWrapStandalone(
  browser: Browser,
  tallRows: Record<string, number> = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto('/standalone.html?wrap=col-b&seedrows=60');
  await expect(page.locator(EDITOR)).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
  await page.evaluate((tall: Record<string, number>) => {
    const rows = Array.from({ length: 60 }, (_, i) => {
      const rowId = `r${i}`;
      const lines = tall[rowId];
      const cells: Record<string, string> = { 'col-a': `行${i}` };
      if (lines !== undefined) {
        cells['col-b'] = Array.from({ length: lines }, (_, n) => `${n + 1}行目`).join('\n');
      }
      return { rowId, cells };
    });
    window.__standalone?.reinject({ rows });
  }, tallRows);
  return { context, page };
}

async function editorLineCount(page: Page): Promise<number> {
  return (await editorProbe(page)).value.split('\n').length;
}

test('DD-055 AC6: 行の高さが 128px を超える wrap 列のセルを編集 → 編集欄がセルの上端から下端まで覆い、内容がセルより長くなるとセルの高さで内部スクロール', async ({
  browser,
}) => {
  const { context, page } = await openWrapStandalone(browser, { r2: 15 });
  try {
    const row = 2;
    const col = 1;
    await expect
      .poll(async () => (await sa.cellRectAt(page, row, col))?.height ?? 0, {
        message: '15 行の値で行が 128px より高くなる',
      })
      .toBeGreaterThan(128);
    const cell = (await sa.cellRectAt(page, row, col))!;
    await sa.selectCell(page, row, col);
    await page.keyboard.press('F2');
    await expect.poll(async () => editorLineCount(page), { message: 'F2 で既存の 15 行を編集し始める' }).toBe(15);
    const geometry = await overlayGeometry(page, EDITOR);
    await highlightCell(page, row, col);
    await highlightSelector(page, EDITOR);
    await page.screenshot({ path: evidencePathDD055('bug2-tall-row.png') });
    saveEvidenceJsonDD055('bug2-tall-row.json', { row, col, cell, editor: geometry });
    expect(Math.abs(geometry.rect!.y - cell.y), '編集欄の上端がセルの上端').toBeLessThanOrEqual(1);
    expect(
      Math.abs(geometry.rect!.y + geometry.rect!.height - (cell.y + cell.height)),
      '編集欄の下端がセルの下端（128px で切り詰めない）',
    ).toBeLessThanOrEqual(1);

    for (let i = 1; i <= 6; i += 1) {
      await page.keyboard.press('Alt+Enter');
      await page.keyboard.type(`追加${i}`);
    }
    await expect.poll(async () => editorLineCount(page)).toBe(21);
    await expect
      .poll(async () => (await overlayGeometry(page, EDITOR)).overflowY, { message: '内容がセルより長いと内部スクロール' })
      .toBe('auto');
    const grown = await overlayGeometry(page, EDITOR);
    expect(Math.abs(grown.rect!.height - cell.height), '高さはセルの高さのまま').toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});

test('DD-055 AC7: 1 行の高さの wrap 列で長文を入力 → 従来どおり 128px まで伸びて内部スクロール（DD-052-1 AC4 の回帰なし）', async ({
  browser,
}) => {
  const { context, page } = await openWrapStandalone(browser);
  try {
    const row = 3;
    const col = 1;
    const cell = (await sa.cellRectAt(page, row, col))!;
    expect(cell.height, '前提: 1 行の高さのセル').toBeLessThan(128);
    await sa.selectCell(page, row, col);
    await page.keyboard.type('1行目');
    for (let i = 2; i <= 10; i += 1) {
      await page.keyboard.press('Alt+Enter');
      await page.keyboard.type(`${i}行目`);
    }
    await expect.poll(async () => editorLineCount(page)).toBe(10);
    await expect
      .poll(async () => (await overlayGeometry(page, EDITOR)).overflowY, { message: '上限を超えると内部スクロール' })
      .toBe('auto');
    const geometry = await overlayGeometry(page, EDITOR);
    expect(Math.abs(geometry.rect!.y - cell.y), '編集欄の上端はセルの上端').toBeLessThanOrEqual(1);
    expect(geometry.rect!.height, '上限は 128px（8 行相当）のまま').toBe(128);
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});

test('DD-055 AC8: 可視域の下端近くの 1 行のセルで長文を入力 → 編集欄の下端が可視域の下端を越えず内部スクロールになる', async ({
  browser,
}) => {
  const { context, page } = await openWrapStandalone(browser);
  try {
    await emulateScrollbars(page);
    const col = 1;
    const row = await lastFullyVisibleRow(page, col);
    const cell = (await sa.cellRectAt(page, row, col))!;
    await sa.selectCell(page, row, col);
    await page.keyboard.type('1行目');
    for (let i = 2; i <= 6; i += 1) {
      await page.keyboard.press('Alt+Enter');
      await page.keyboard.type(`${i}行目`);
    }
    await expect.poll(async () => editorLineCount(page)).toBe(6);
    const geometry = await overlayGeometry(page, EDITOR);
    await highlightSelector(page, EDITOR);
    await page.screenshot({ path: evidencePathDD055('bug2-bottom-low-row.png') });
    saveEvidenceJsonDD055('bug2-bottom-low-row.json', { row, col, cell, editor: geometry });
    expect(Math.abs(geometry.rect!.y - cell.y), '編集欄の上端はセルの上端').toBeLessThanOrEqual(1);
    expect(geometry.rect!.y + geometry.rect!.height, '編集欄の下端が可視域の下端を越えない').toBeLessThanOrEqual(
      geometry.visibleHeight + 1,
    );
    expect(geometry.rect!.height, '1 行分の高さは下回らない').toBeGreaterThanOrEqual(20);
    expect(geometry.overflowY, '縮めた分は内部スクロール').toBe('auto');
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});

test('DD-055 AC8: 高い行を編集したままセルが可視域の下端にかかるまでスクロール → 編集欄を可視域の下端で縮める', async ({
  browser,
}) => {
  const { context, page } = await openWrapStandalone(browser, { r30: 15 });
  try {
    await emulateScrollbars(page);
    const row = 30;
    const col = 1;
    const area = await overlayGeometry(page, EDITOR);
    // r30 を可視域の上寄り（y=100）までスクロールしてから編集を始める（全体が見えているのでスクロール追従は起きない）。
    await expect
      .poll(async () => (await sa.cellRectAt(page, row, col))?.height ?? 0, { message: '15 行の値で行が高くなる' })
      .toBeGreaterThan(128);
    const initial = (await sa.cellRectAt(page, row, col))!;
    await scrollTo(page, initial.y - 100, 0);
    await expect.poll(async () => Math.round((await sa.cellRectAt(page, row, col))?.y ?? -1)).toBe(100);
    await sa.selectCell(page, row, col);
    await page.keyboard.press('F2');
    await expect.poll(async () => editorLineCount(page)).toBe(15);

    // 編集したまま上へスクロールし、セルの上端を可視域の下端から 60px 上へ移す（セルの残りは可視域の外）。
    const scrollTop = await page.evaluate(() => document.querySelector('.nsheet-scroller')?.scrollTop ?? 0);
    const editingCell = (await sa.cellRectAt(page, row, col))!;
    const targetTop = area.visibleHeight - 60;
    await scrollTo(page, scrollTop - (targetTop - editingCell.y), 0);
    await expect
      .poll(async () => {
        const rect = (await overlayGeometry(page, EDITOR)).rect;
        return rect === null ? null : Math.round(rect.y);
      })
      .toBe(Math.round(targetTop));
    const cell = (await sa.cellRectAt(page, row, col))!;
    const geometry = await overlayGeometry(page, EDITOR);
    await highlightSelector(page, EDITOR);
    await page.screenshot({ path: evidencePathDD055('bug2-bottom-tall-row.png') });
    saveEvidenceJsonDD055('bug2-bottom-tall-row.json', { row, col, cell, editor: geometry });
    expect(geometry.rect!.y + geometry.rect!.height, '編集欄の下端が可視域の下端を越えない').toBeLessThanOrEqual(
      geometry.visibleHeight + 1,
    );
    expect(geometry.rect!.height, '1 行分の高さは下回らない').toBeGreaterThanOrEqual(20);
    expect(geometry.overflowY, '縮めた分は内部スクロール').toBe('auto');

    // 縮めたまま再配置されても内部スクロール位置を失わない（高さを測り直すたびに先頭へ戻ると末尾の行が見えなくなる）。
    // 入力するとセルの追従でセル全体が可視域へ戻るため、入力せずにグリッドを 1px 動かして配置だけを更新させる。
    await page.locator(EDITOR).evaluate((el) => {
      el.scrollTop = el.scrollHeight; // 利用者が編集欄の中を末尾までスクロールした状態
    });
    const shrunkScrollTop = await page.evaluate(() => document.querySelector('.nsheet-scroller')?.scrollTop ?? 0);
    await scrollTo(page, shrunkScrollTop - 1, 0);
    await expect
      .poll(async () => (await overlayGeometry(page, EDITOR)).rect?.y ?? null, { message: '1px 動かした位置へ再配置される' })
      .toBe(Math.round(targetTop) + 1);
    expect(
      await page
        .locator(EDITOR)
        .evaluate((el) => el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2),
      '再配置の後も編集欄の中は末尾までスクロールしたまま',
    ).toBe(true);
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});
