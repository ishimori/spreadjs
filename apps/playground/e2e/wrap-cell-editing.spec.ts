// DD-052-1 E2E（RC1: セル内改行・RC2: 長文編集欄）: wrap 列の編集中に Alt+Enter がセル内改行になり、
// textarea が内容に合わせて下へ伸びることを実ブラウザーで確認する。非 wrap 列は Alt+Enter も通常の
// Enter と同じ確定＋移動のまま変わらないことも合わせて確認する（既存 consumer への互換性）。

import { expect, test } from '@playwright/test';

import { cellRectAt, committedCell, editorProbe, openClient, rowIdAt, colIdAt, selectCell } from './integration-helpers';

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
