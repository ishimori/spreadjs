// DD-012-4 E2E: 列幅・行高リサイズ（ヘッダー境界の実ドラッグ）。
//
// 実ブラウザーで pointerdown→move→up の実ドラッグを発生させ、①列幅・行高が変わる（セル矩形が追従する）
// ②確定時の layout が override のみを保持する（AC3）③リロードで復元される（AC4＝利用側 localStorage 保存→
// 次回 mount の初期値注入）を検証する。座標変換・クランプ・hit 判定の細目はユニット（resize-interaction.test.ts）
// が担保するため、ここでは「実ブラウザーで配線が成立する」ことに集中する。

import { expect, test } from '@playwright/test';

import {
  cellRectAt,
  colIdAt,
  columnHeaderRectAt,
  columnWidthOverrides,
  committedCell,
  dispatchSyntheticPaste,
  openClient,
  rowHeaderRectAt,
  rowHeightOverrides,
  rowIdAt,
  selectCell,
  snapshot,
} from './integration-helpers';

test.describe.configure({ mode: 'serial' });

test('列ヘッダー境界のドラッグで列幅が広がり、セル矩形が追従する（AC1）', async ({ browser }) => {
  const { context, page } = await openClient(browser, 'リサイズ-列');
  try {
    const box = (await page.locator('.nsheet-scroller').boundingBox())!;
    const col = 2;
    const before = (await columnHeaderRectAt(page, col))!;
    // 右端境界の掴み代内（width-2px）へ。stage-local → page 座標へ変換。
    const startX = box.x + before.x + before.width - 2;
    const y = box.y + before.y + before.height / 2;

    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + 100, y, { steps: 6 });
    await page.mouse.up();

    await expect
      .poll(async () => (await columnHeaderRectAt(page, col))!.width, { message: '列幅が広がる' })
      .toBeGreaterThan(before.width + 60);

    // セル矩形の幅も同じだけ広がる（ヘッダー/セル/選択枠が同一座標系で追従・AC1）。
    const cell = (await cellRectAt(page, 3, col))!;
    expect(cell.width).toBe((await columnHeaderRectAt(page, col))!.width);
  } finally {
    await context.close();
  }
});

test('行ヘッダー境界のドラッグで行高が広がる（AC2）', async ({ browser }) => {
  const { context, page } = await openClient(browser, 'リサイズ-行');
  try {
    const box = (await page.locator('.nsheet-scroller').boundingBox())!;
    const row = 3;
    const before = (await rowHeaderRectAt(page, row))!;
    const x = box.x + before.x + before.width / 2;
    const startY = box.y + before.y + before.height - 2;

    await page.mouse.move(x, startY);
    await page.mouse.down();
    await page.mouse.move(x, startY + 50, { steps: 6 });
    await page.mouse.up();

    await expect
      .poll(async () => (await rowHeaderRectAt(page, row))!.height, { message: '行高が広がる' })
      .toBeGreaterThan(before.height + 30);
  } finally {
    await context.close();
  }
});

test('確定 layout は override のみを保持し、リロードで復元される（AC3・AC4）', async ({ browser }) => {
  const { context, page } = await openClient(browser, 'リサイズ-復元');
  try {
    const box = (await page.locator('.nsheet-scroller').boundingBox())!;
    const col = 2;
    const before = (await columnHeaderRectAt(page, col))!;
    const startX = box.x + before.x + before.width - 2;
    const y = box.y + before.y + before.height / 2;

    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + 120, y, { steps: 6 });
    await page.mouse.up();

    // override は 1 列だけ（既定値の列は含まない・AC3）。行は未変更ゆえ空。
    const cw = await columnWidthOverrides(page);
    expect(Object.keys(cw)).toHaveLength(1);
    expect(await rowHeightOverrides(page)).toEqual({});
    const resizedWidth = (await columnHeaderRectAt(page, col))!.width;
    expect(resizedWidth).toBeGreaterThan(before.width + 80);

    // 利用側（playground）が layout イベントを localStorage へ保存済み。リロードで初期値注入され復元される（AC4）。
    await page.reload();
    await expect
      .poll(async () => (await snapshot(page)).ready, { timeout: 30_000, message: 'reload 後 ready' })
      .toBe(true);
    await expect
      .poll(async () => (await columnHeaderRectAt(page, col))!.width, { message: 'リロードで列幅が復元される' })
      .toBe(resizedWidth);
  } finally {
    await context.close();
  }
});

// ---- DD-027-3: ダブルクリック auto-fit（C級・AC6/AC7）----

test('DD-027-3 AC6: 列境界のダブルクリックで列幅が内容に合い、layout イベントが発火する', async ({ browser }) => {
  const { context, page } = await openClient(browser, 'auto-fit-列');
  try {
    const col = 3;
    // まず内容を短くするため列を最小へ手動リサイズ（狭い状態から auto-fit で広がることを見る）。
    const box = (await page.locator('.nsheet-scroller').boundingBox())!;
    const start = (await columnHeaderRectAt(page, col))!;
    const startX = box.x + start.x + start.width - 2;
    const y = box.y + start.y + start.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(box.x + start.x + 24, y, { steps: 6 }); // かなり狭める
    await page.mouse.up();
    await expect
      .poll(async () => (await columnHeaderRectAt(page, col))!.width, { message: '一旦狭くなる' })
      .toBeLessThan(start.width);
    const narrowWidth = (await columnHeaderRectAt(page, col))!.width;

    // 長い内容を入れて auto-fit の効果を明確にする。
    const rowId = (await rowIdAt(page, 12))!;
    const columnId = (await colIdAt(page, col))!;
    const longValue = 'auto-fit-content-very-long-cell-value-1234567890';
    await selectCell(page, 12, col);
    expect(await dispatchSyntheticPaste(page, longValue)).toBe(true);
    await expect.poll(async () => committedCell(page, rowId, columnId)).toBe(longValue);

    // 列境界をダブルクリック（右端境界の掴み代内）。
    const beforeAutoFit = (await columnHeaderRectAt(page, col))!;
    await page
      .locator('.nsheet-scroller')
      .dblclick({ position: { x: beforeAutoFit.x + beforeAutoFit.width - 2, y: beforeAutoFit.y + beforeAutoFit.height / 2 } });

    // 幅が内容に合わせて広がる（狭めた幅より広い）。
    await expect
      .poll(async () => (await columnHeaderRectAt(page, col))!.width, { message: 'auto-fit で内容幅へ広がる' })
      .toBeGreaterThan(narrowWidth + 40);
    // layout イベントで override が保存される（利用側 localStorage 保存契約・reload で復元される）。
    const cw = await columnWidthOverrides(page);
    expect(Object.keys(cw)).toContain(columnId);
    const fitted = (await columnHeaderRectAt(page, col))!.width;

    await page.reload();
    await expect.poll(async () => (await snapshot(page)).ready, { timeout: 30_000 }).toBe(true);
    await expect
      .poll(async () => (await columnHeaderRectAt(page, col))!.width, { message: 'auto-fit 幅が reload で復元' })
      .toBe(fitted);
  } finally {
    await context.close();
  }
});

test('DD-027-3 AC7: wrap 列の境界ダブルクリック → 幅変更なし（対象外・診断のみ）', async ({ browser }) => {
  const { context, page } = await openClient(browser, 'auto-fit-wrap', { wrap: 'col-2' });
  try {
    const wrapCol = 2;
    const wrapColId = (await colIdAt(page, wrapCol))!;
    const wrapBefore = (await columnHeaderRectAt(page, wrapCol))!;
    // wrap 列の右境界をダブルクリック（auto-fit 対象外＝no-op のはず）。
    await page
      .locator('.nsheet-scroller')
      .dblclick({ position: { x: wrapBefore.x + wrapBefore.width - 2, y: wrapBefore.y + wrapBefore.height / 2 } });

    // 正のコントロール（Fable P3・時間依存の排除）: 非 wrap 列 col-3 に長い値を入れて auto-fit し、幅が広がるのを poll で
    // 待つ。dblclick は FIFO 処理ゆえ「コントロールの auto-fit が観測できた」時点で先行の wrap 列 dblclick も処理済み＝
    // wrap 列の非変化は settled（固定 waitForTimeout に依存しない）。
    const ctrlCol = 3;
    const ctrlRowId = (await rowIdAt(page, 12))!;
    const ctrlColId = (await colIdAt(page, ctrlCol))!;
    const longValue = 'auto-fit-control-very-long-cell-value-1234567890';
    await selectCell(page, 12, ctrlCol);
    expect(await dispatchSyntheticPaste(page, longValue)).toBe(true);
    await expect.poll(async () => committedCell(page, ctrlRowId, ctrlColId)).toBe(longValue);
    const ctrlBefore = (await columnHeaderRectAt(page, ctrlCol))!;
    await page
      .locator('.nsheet-scroller')
      .dblclick({ position: { x: ctrlBefore.x + ctrlBefore.width - 2, y: ctrlBefore.y + ctrlBefore.height / 2 } });
    await expect
      .poll(async () => (await columnHeaderRectAt(page, ctrlCol))!.width, { message: '非 wrap 列は auto-fit で幅が広がる（コントロール）' })
      .toBeGreaterThan(ctrlBefore.width);

    // wrap 列は auto-fit 対象外＝幅は不変・override も付かない（コントロール変化後に確認＝処理順で確定）。
    expect((await columnHeaderRectAt(page, wrapCol))!.width).toBe(wrapBefore.width);
    expect(Object.keys(await columnWidthOverrides(page))).not.toContain(wrapColId);
  } finally {
    await context.close();
  }
});
