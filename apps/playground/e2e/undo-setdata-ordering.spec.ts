// DD-052-4 E2E（RC13回帰）: onCellCommit 内で consumer が同期的に setData を呼んでも、Undo スタックに
// 幽霊エントリが残らないことを確認する。修正前は「捕捉した逆値パッチ→submit（内部で同期 cell-commit 通知→
// consumer の setData→undoCtrl.clear()）→Undo記録」の順で、記録が消去済みスタックへ積まれ canUndo()=true の
// まま（Ctrl+Z しても実体のない操作になる）幽霊エントリが残った。修正後は記録が通知より前に完了するため、
// setData の Undo 全消去が正しく効く。

import { expect, test } from '@playwright/test';

import * as sa from './standalone-helpers';

test('RC13: onCellCommit 内で同期的に setData → Undo に幽霊エントリが残らない（canUndo=false）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto('/standalone.html?rc13sync=1');
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);

    expect(await sa.canUndo(page), '確定前は Undo 不可').toBe(false);

    await sa.selectCell(page, 3, 0);
    await page.keyboard.type('rc13-value');
    await page.keyboard.press('Enter');

    // 確定値が反映されている（consumer の同期 setData 再注入後も値は保持される＝データ自体は正しい）。
    const rowId = await sa.rowIdAt(page, 3);
    const colId = await sa.colIdAt(page, 0);
    await expect.poll(async () => sa.displayCell(page, rowId!, colId!)).toBe('rc13-value');

    // 幽霊エントリが無ければ canUndo=false のまま（setData 直後は Undo スタック空＝RC13 修正前は true になっていた）。
    expect(await sa.canUndo(page), '幽霊エントリが残っていない').toBe(false);
    expect(await sa.undoDepth(page)).toBe(0);
  } finally {
    await context.close();
  }
});

test('rc13sync 未指定（既定）は従来どおり Undo が効く（回帰確認の対照群）', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    await sa.selectCell(page, 3, 0);
    await page.keyboard.type('normal-value');
    await page.keyboard.press('Enter');
    const rowId = await sa.rowIdAt(page, 3);
    const colId = await sa.colIdAt(page, 0);
    await expect.poll(async () => sa.displayCell(page, rowId!, colId!)).toBe('normal-value');

    expect(await sa.canUndo(page)).toBe(true);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => sa.displayCell(page, rowId!, colId!)).toBe('行3'); // 元のシード値（col-a既定ラベル）
  } finally {
    await context.close();
  }
});
