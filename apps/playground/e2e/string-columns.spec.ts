// DD-052-2 E2E（RC12: 文字列として保つ列）: stringColumns 指定列は先頭ゼロ付き数字がそのまま保持され、
// 未指定列は従来どおり型変換されることを実ブラウザーで確認する。

import { expect, test } from '@playwright/test';

import { colIdAt, committedCell, openClient, plainTypeAndCommit, rowIdAt, selectCell } from './integration-helpers';

test('stringColumns 指定列は先頭ゼロが失われず、未指定列は従来どおり数値化される（RC12）', async ({ browser }) => {
  const { context, page } = await openClient(browser, 'RC12文字列列', { stringCol: 'col-0' });
  try {
    const row = 6;
    const stringCol = 0; // col-0（stringColumns 指定）
    const plainCol = 1; // col-1（対象外・従来どおり）
    const stringColumnId = (await colIdAt(page, stringCol))!;
    const plainColumnId = (await colIdAt(page, plainCol))!;
    const rowId = (await rowIdAt(page, row))!;

    await selectCell(page, row, stringCol);
    await plainTypeAndCommit(page, '09012345678');
    await expect
      .poll(async () => committedCell(page, rowId, stringColumnId), { message: 'stringColumns 列は先頭ゼロを保つ' })
      .toBe('09012345678');

    await selectCell(page, row, plainCol);
    await plainTypeAndCommit(page, '09012345678');
    await expect
      .poll(async () => committedCell(page, rowId, plainColumnId), { message: '対象外の列は従来どおり数値化される' })
      .toBe('9012345678');
  } finally {
    await context.close();
  }
});
