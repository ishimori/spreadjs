// DD-052-4 E2E（RC4: 行単位の部分更新 setRows）。setData と違い、渡した行だけを置換・追加し、言及しなかった
// 行・既存の Undo 履歴はそのまま残ることを確認する。

import { expect, test } from '@playwright/test';

import * as sa from './standalone-helpers';

test('RC4: setRows は言及した行だけ更新し、他の行・既存の Undo 履歴に触れない', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    // 通常の編集で Undo 履歴を1件作る（別の行）。
    await sa.selectCell(page, 5, 0);
    await page.keyboard.type('normal-edit');
    await page.keyboard.press('Enter');
    expect(await sa.canUndo(page)).toBe(true);
    const undoDepthBefore = await sa.undoDepth(page);

    // setRows で別の行（row 3）だけを部分更新する。
    const rowId3 = await sa.rowIdAt(page, 3);
    await page.evaluate(
      (id) => window.__standalone?.applyRows([{ rowId: id!, cells: { 'col-a': 'via-setRows' } }]),
      rowId3,
    );
    await expect.poll(async () => sa.displayCell(page, rowId3!, 'col-a')).toBe('via-setRows');

    // 既存の Undo 履歴は消えていない（setData と違い setRows は Undo をクリアしない）。
    expect(await sa.canUndo(page)).toBe(true);
    expect(await sa.undoDepth(page)).toBeGreaterThanOrEqual(undoDepthBefore);

    // 言及しなかった行（row 5 の normal-edit）はそのまま。
    const rowId5 = await sa.rowIdAt(page, 5);
    expect(await sa.displayCell(page, rowId5!, 'col-a')).toBe('normal-edit');
  } finally {
    await context.close();
  }
});

test('RC4: setRows で新規行を追加すると末尾に現れる', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    const before = await sa.rowCount(page);
    await page.evaluate(() => window.__standalone?.applyRows([{ rowId: 'set-rows-new', cells: { 'col-a': 'new-row' } }]));
    await expect.poll(async () => sa.rowCount(page)).toBe(before + 1);
    await expect.poll(async () => sa.displayCell(page, 'set-rows-new', 'col-a')).toBe('new-row');
    expect(await sa.rowIdAt(page, before)).toBe('set-rows-new'); // 末尾（既存行の後）
  } finally {
    await context.close();
  }
});

test('RC4: setRows 直後の Undo は変更したセルだけを戻す', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    const rowId = await sa.rowIdAt(page, 4);
    const before = await sa.displayCell(page, rowId!, 'col-a');
    await page.evaluate(
      (id) => window.__standalone?.applyRows([{ rowId: id!, cells: { 'col-a': 'set-rows-value' } }]),
      rowId,
    );
    await expect.poll(async () => sa.displayCell(page, rowId!, 'col-a')).toBe('set-rows-value');

    await sa.selectCell(page, 0, 0); // フォーカスを textarea へ戻す（Ctrl+Z を効かせるため）
    await page.keyboard.press('Control+z');
    await expect.poll(async () => sa.displayCell(page, rowId!, 'col-a')).toBe(before);
  } finally {
    await context.close();
  }
});

test('Codex[P1]回帰: boot 前に setRows→setData の順で同期呼び出しても、実際の呼び出し順どおりに適用される', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    // ?prebootorder=1: standalone-main.ts が mount() 直後（同一 tick・boot の microtask 完了前）に
    // setRows({from-setRows}) → setData({from-setData}) を同期実行する（修正前は起動処理が setData を
    // 常に先に適用したため実際の呼び出し順が逆転し、最後に呼んだ setData の値が古い setRows の値で
    // 上書きされたまま固定されてしまっていた）。
    await page.goto('/standalone.html?prebootorder=1');
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);

    // 実際の呼び出し順どおりなら、最後に呼んだ setData が最終状態になる（setRows の値は残らない）。
    await expect.poll(async () => sa.displayCell(page, 'r0', 'col-a')).toBe('from-setData');
  } finally {
    await context.close();
  }
});

test('Codex[P2]回帰: setRows は無関係な行の Redo 履歴を破棄しない', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    // row 5 を編集して Undo → Redo 可能な状態を作る。
    await sa.selectCell(page, 5, 0);
    await page.keyboard.type('typed-then-undone');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+z');
    const rowId5 = await sa.rowIdAt(page, 5);
    const seedValue5 = await sa.displayCell(page, rowId5!, 'col-a'); // undo 後の値（シード値）
    expect(await sa.canRedo(page), 'undo 直後は redo 可能').toBe(true);

    // 無関係な行（row 3）を setRows で更新する。
    const rowId3 = await sa.rowIdAt(page, 3);
    await page.evaluate(
      (id) => window.__standalone?.applyRows([{ rowId: id!, cells: { 'col-a': 'via-setRows' } }]),
      rowId3,
    );
    await expect.poll(async () => sa.displayCell(page, rowId3!, 'col-a')).toBe('via-setRows');

    // row 5 の redo はそのまま残る（Codex[P2] 修正前は setRows が redo スタック全体を破棄していた）。
    expect(await sa.canRedo(page), 'setRows 後も無関係な行の redo が残る').toBe(true);
    await sa.selectCell(page, 5, 0);
    await page.keyboard.press('Control+y');
    await expect.poll(async () => sa.displayCell(page, rowId5!, 'col-a')).toBe('typed-then-undone');
    expect(seedValue5).not.toBe('typed-then-undone');
  } finally {
    await context.close();
  }
});
