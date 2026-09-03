// DD-021-1 E2E: 行操作 Command・公開 API（insertRows/deleteRows・ショートカット・row-structure-change）。
//
// 公開 API は window.__gridInstance（GridInstance）経由で駆動する（test-support の submit* ではなく
// **利用者が触る公開面**を検証する）。standalone.html を主対象に AC1〜6/8 を、collab（poc-integration.html・
// 2 クライアント）で AC7 の伝播 smoke を確認する。row-structure-change は standalone-main が __standalone.events へ
// 記録する（consumer 保存材料）。実 IME は Manual Gate（親 Phase 4）で、ここでは synthetic composition の回帰確認。

import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import {
  composeFinalizeAndCommit,
  composeOpen as collabComposeOpen,
  editorProbe,
  openClient,
  rowIdAt as collabRowIdAt,
  rowIndexOf,
  selectCell as collabSelectCell,
  snapshot,
} from './integration-helpers';
import {
  activeCell,
  composeOpen,
  displayCell,
  openStandalone,
  rowCount,
  rowIdAt,
  selectCell,
  waitReady,
} from './standalone-helpers';

/** DD-021-1 はアーカイブ済みのため、再生成する証跡は git 追跡外の test-results 配下へ保存する。 */
function evidencePath(fileName: string): string {
  return fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-021-1/${fileName}`, import.meta.url));
}

/** 公開 API insertRows を __gridInstance 経由で呼ぶ。 */
async function apiInsertRows(page: Page, afterRowId: string | null, count?: number): Promise<void> {
  await page.evaluate(
    (opts: { afterRowId: string | null; count?: number }) => {
      const inst = (window as unknown as { __gridInstance?: { insertRows(o: unknown): void } }).__gridInstance;
      if (inst === undefined) {
        throw new Error('__gridInstance 未初期化');
      }
      inst.insertRows(opts.count === undefined ? { afterRowId: opts.afterRowId } : opts);
    },
    { afterRowId, ...(count === undefined ? {} : { count }) },
  );
}

/** 公開 API deleteRows を __gridInstance 経由で呼ぶ。 */
async function apiDeleteRows(page: Page, rowIds: readonly string[]): Promise<void> {
  await page.evaluate((ids: readonly string[]) => {
    const inst = (window as unknown as { __gridInstance?: { deleteRows(ids: readonly string[]): void } }).__gridInstance;
    if (inst === undefined) {
      throw new Error('__gridInstance 未初期化');
    }
    inst.deleteRows(ids);
  }, rowIds);
}

/** row-structure-change イベントだけ抜き出す（standalone-main が events へ記録）。 */
async function rowStructureEvents(
  page: Page,
): Promise<Array<{ change: { kind: string; afterRowId?: string | null; rowIds: string[] } }>> {
  return page.evaluate(() =>
    ((window.__standalone?.events ?? []) as Array<{ type: string; change?: unknown }>)
      .filter((e) => e.type === 'row-structure-change')
      .map((e) => ({ change: e.change })) as Array<{
      change: { kind: string; afterRowId?: string | null; rowIds: string[] };
    }>,
  );
}

test.describe('DD-021-1 行操作 Command・公開 API', () => {
  test('AC1 insertRows(count:2) で 2 行挿入・row-structure-change(insert) が発火する', async ({ browser }) => {
    const { context, page } = await openStandalone(browser);
    try {
      const before = await rowCount(page); // 20
      const anchor = await rowIdAt(page, 2); // r2 の直後へ 2 行
      await apiInsertRows(page, anchor ?? null, 2);
      await expect.poll(async () => rowCount(page), { message: '2 行挿入で行数 +2' }).toBe(before + 2);

      const evs = await rowStructureEvents(page);
      expect(evs).toHaveLength(1);
      expect(evs[0]!.change.kind).toBe('insert');
      expect(evs[0]!.change.afterRowId).toBe(anchor);
      expect(evs[0]!.change.rowIds).toHaveLength(2);
      // 返された新 rowId が表示上アンカー直後に並ぶ（r2 の次が新 rowId）。
      expect(await rowIdAt(page, 3)).toBe(evs[0]!.change.rowIds[0]);
      expect(await rowIdAt(page, 4)).toBe(evs[0]!.change.rowIds[1]);
      await page.screenshot({ path: evidencePath('e2e-ac1-insert.png') });
    } finally {
      await context.close();
    }
  });

  test('AC2 deleteRows で行が消え・row-structure-change(delete) が発火する', async ({ browser }) => {
    const { context, page } = await openStandalone(browser);
    try {
      const before = await rowCount(page);
      const target = await rowIdAt(page, 3);
      const belowId = await rowIdAt(page, 4); // 削除後は index 3 へ繰り上がる
      await apiDeleteRows(page, [target!]);
      await expect.poll(async () => rowCount(page), { message: '1 行削除で行数 -1' }).toBe(before - 1);
      // tombstone 化で表示行順から消える（直下行が index 3 へ繰り上がる）。cell データ自体は tombstone 下でも残る。
      expect(await rowIdAt(page, 3)).toBe(belowId);
      const deletedStillVisible = await page.evaluate(
        (id: string) =>
          Array.from({ length: 40 }, (_, i) => i).some(
            (i) =>
              (window as unknown as { __integrationTestApi?: { rowIdAt(n: number): string | undefined } })
                .__integrationTestApi?.rowIdAt(i) === id,
          ),
        target!,
      );
      expect(deletedStillVisible).toBe(false);

      const evs = await rowStructureEvents(page);
      expect(evs).toHaveLength(1);
      expect(evs[0]!.change.kind).toBe('delete');
      expect(evs[0]!.change.rowIds).toEqual([target]);
    } finally {
      await context.close();
    }
  });

  test('AC3 Ctrl+Shift+"+" でアクティブ行の上へ挿入・Ctrl+"-" で選択行を削除', async ({ browser }) => {
    const { context, page } = await openStandalone(browser);
    try {
      const before = await rowCount(page);
      // 行 5 を選択 → Ctrl+Shift+'+' → 行 5 の上（=行 4 の直後）に 1 行挿入。挿入行が新しい行 5 になる。
      const row5Id = await rowIdAt(page, 5);
      await selectCell(page, 5, 0);
      await page.keyboard.press('Control+Shift+Equal'); // '=' + Shift = '+'（key='+'）
      await expect.poll(async () => rowCount(page), { message: '挿入で行数 +1' }).toBe(before + 1);
      // 元の行 5 は 1 つ下（行 6）へ押し下げられる。
      expect(await rowIdAt(page, 6)).toBe(row5Id);

      // Ctrl+'-' で現在の選択（activeCell の行）を削除。
      const countBeforeDelete = await rowCount(page);
      await page.keyboard.press('Control+Minus');
      await expect.poll(async () => rowCount(page), { message: '削除で行数 -1' }).toBe(countBeforeDelete - 1);
      await page.screenshot({ path: evidencePath('e2e-ac3-shortcuts.png') });
    } finally {
      await context.close();
    }
  });

  test('AC4 Composing 中の行操作ショートカットは発火しない（composition 非破壊）', async ({ browser }) => {
    const { context, page } = await openStandalone(browser);
    try {
      // セルを開いて synthetic composition を開始（isComposing=true のまま留める）。
      await selectCell(page, 2, 0);
      await page.locator('textarea.int-cell-editor').focus();
      await composeOpen(page, 'にほん');
      const before = await rowCount(page);

      // 変換中に Ctrl+Shift+'+' / Ctrl+'-' → 行操作は発火しない（decideRowStructureKey が none・I-3）。
      await page.keyboard.press('Control+Shift+Equal');
      await page.keyboard.press('Control+Minus');
      // 少し待って rAF 反映後も行数不変を確認。
      await page.waitForTimeout(150);
      expect(await rowCount(page)).toBe(before);
      // row-structure-change は 1 件も出ていない。
      expect(await rowStructureEvents(page)).toHaveLength(0);
      // draft（変換中テキスト）が保持されている（composition 非破壊）。
      expect(
        await page.evaluate(() => {
          const ta = document.querySelector('textarea.int-cell-editor');
          return ta instanceof HTMLTextAreaElement ? ta.value : '';
        }),
      ).toBe('にほん');
    } finally {
      await context.close();
    }
  });

  test('AC5 削除でアクティブ行が消えたら最近傍生存行（下優先）へ縮退する', async ({ browser }) => {
    const { context, page } = await openStandalone(browser);
    try {
      const row5Id = await rowIdAt(page, 5);
      const row6Id = await rowIdAt(page, 6);
      await selectCell(page, 5, 1);
      expect(await activeCell(page)).toEqual({ row: 5, col: 1 });

      // アクティブ行（row 5）を削除 → activeCell は下の生存行（旧 row6）＝新 row 5 へ縮退する。
      await apiDeleteRows(page, [row5Id!]);
      await expect
        .poll(async () => rowIdAt(page, 5), { message: '旧 row6 が新 row5 になる' })
        .toBe(row6Id);
      await expect
        .poll(async () => (await activeCell(page)).row, { message: 'activeCell が生存行へ縮退' })
        .toBe(5);
      expect((await activeCell(page)).col).toBe(1); // 列は保持
    } finally {
      await context.close();
    }
  });

  test('AC6 standalone: row-structure-change の rowIds で行構造を再構成でき setData と整合する', async ({
    browser,
  }) => {
    const { context, page } = await openStandalone(browser);
    try {
      // 先頭へ 1 行挿入 → イベントの rowIds が実際の表示先頭行と一致する（consumer が保存材料にできる）。
      await apiInsertRows(page, null, 1);
      await expect.poll(async () => (await rowStructureEvents(page)).length).toBe(1);
      const evs = await rowStructureEvents(page);
      const newRowId = evs[0]!.change.rowIds[0]!;
      expect(evs[0]!.change.afterRowId).toBeNull(); // 先頭挿入
      // rowIdAt は view の行 Axis（描画 flush 時に再構築）を読むため、モデル/イベント同期後も反映は rAF 遅延しうる。
      // consumer 契約はイベントの rowIds（同期・正）を使うのが正だが、表示先頭との一致は settle を待って検証する。
      await expect.poll(async () => rowIdAt(page, 0), { message: '挿入行が表示先頭に反映' }).toBe(newRowId);

      // setData 再注入で行構造ごと差し替え → 整合する（イベントは発火しない＝再注入は保存材料ではない）。
      await page.evaluate((id: string) => {
        window.__standalone?.reinject({ rows: [{ rowId: id, cells: { 'col-a': '再' } }, { rowId: 'z9', cells: {} }] });
      }, newRowId);
      await expect.poll(async () => rowCount(page), { message: '再注入で行数 2' }).toBe(2);
      expect(await displayCell(page, newRowId, 'col-a')).toBe('再');
      // 再注入は row-structure-change を増やさない（先の insert の 1 件のまま）。
      expect(await rowStructureEvents(page)).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  test('AC8 不正入力（未知アンカー・削除対象なし・count≦0）は文書無変更・クラッシュしない', async ({
    browser,
  }) => {
    const { context, page } = await openStandalone(browser);
    try {
      const before = await rowCount(page);
      await apiInsertRows(page, 'ghost-anchor', 1); // 未知アンカー
      await apiInsertRows(page, null, 0); // count≦0
      await apiInsertRows(page, null, -3); // count≦0
      await apiInsertRows(page, null, 1.5); // 非整数
      await apiInsertRows(page, null, 100_001); // 上限超過（Fable P2: 巨大 count の実行前拒否・RangeError/フリーズなし）
      await apiDeleteRows(page, ['ghost-row']); // 削除対象なし
      await apiDeleteRows(page, []); // 空
      await page.waitForTimeout(150);
      expect(await rowCount(page)).toBe(before); // 文書無変更
      // standalone は client 実行前拒否を rejected 経路へ混ぜない（診断のみ）→ row-structure-change も出ない。
      expect(await rowStructureEvents(page)).toHaveLength(0);
      // ページは生存（ready のまま）。
      await waitReady(page);
    } finally {
      await context.close();
    }
  });

  test('AC7 collab: 公開 API の行挿入が ACK され他クライアントへ伝播する（2 クライアント smoke）', async ({
    browser,
  }) => {
    // 共有文書は additive（insert のみ）に留める（他 spec は rowCount>=50000 前提のため delete しない）。
    const a = await openClient(browser, 'row-a');
    const b = await openClient(browser, 'row-b');
    try {
      const beforeB = (await snapshot(b.page)).rowCount;
      // client A の公開 API で先頭へ 1 行挿入。
      await apiInsertRows(a.page, null, 1);
      // A は楽観適用で即 +1、ACK 後 pending 0。
      await expect
        .poll(async () => (await snapshot(a.page)).pendingCount, { message: 'A の pending が ACK で 0 に戻る' })
        .toBe(0);
      // B へ伝播して行数が +1 になる。
      await expect
        .poll(async () => (await snapshot(b.page)).rowCount, { message: 'B へ行挿入が伝播する' })
        .toBe(beforeB + 1);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });
});

// DD-021-2: collab 2 クライアントの行操作競合・K4（IME 変換中の対象行削除）。
// 共有文書（50,000 行シード）を壊さないため、A が **新規行を先頭へ挿入**してからその行だけを対象にする
// （insert→delete で net 中立・base 行数は非減少）。view 読みは expect.poll でゲート（DD-021-1 教訓）。
test.describe('DD-021-2 collab 行操作 競合・K4', () => {
  /** A が先頭へ 1 行挿入し、B へ伝播した新 rowId を返す（view 軸 settle を待つ）。 */
  async function insertFreshTopRow(a: Page, b: Page): Promise<string> {
    const beforeTop = await collabRowIdAt(a, 0);
    await apiInsertRows(a, null, 1);
    await expect
      .poll(async () => collabRowIdAt(a, 0), { message: 'A の先頭に新規行が反映' })
      .not.toBe(beforeTop);
    const newRowId = await collabRowIdAt(a, 0);
    expect(newRowId).toBeDefined();
    await expect
      .poll(async () => rowIndexOf(b, newRowId!), { message: 'B へ新規行が伝播' })
      .not.toBe(-1);
    return newRowId!;
  }

  test('AC7 K4: A が IME 変換中の行を B が削除 → A の draft/composition 非破壊・行消失インジケーター', async ({
    browser,
  }) => {
    const a = await openClient(browser, 'k4-a');
    const b = await openClient(browser, 'k4-b');
    try {
      const newRowId = await insertFreshTopRow(a.page, b.page);

      // A が新規行（表示 index 0）の col-0 で日本語変換を開始する。
      await collabSelectCell(a.page, 0, 0);
      await collabComposeOpen(a.page, ['にほん']);
      await expect.poll(async () => (await snapshot(a.page)).isComposing, { message: 'A が変換中' }).toBe(true);
      expect((await editorProbe(a.page)).value).toBe('にほん');

      // B がその行を削除（公開 API）。
      await apiDeleteRows(b.page, [newRowId]);

      // A の committed が削除を取り込む（行が表示から消える）。
      await expect
        .poll(async () => rowIndexOf(a.page, newRowId), { timeout: 15_000, message: 'A が B の削除を catch-up' })
        .toBe(-1);

      // K4: A は変換継続・draft/textarea 非破壊・行消失インジケーターが立つ（強制破棄なし）。
      await expect
        .poll(async () => (await snapshot(a.page)).isTargetLost, { timeout: 15_000, message: 'A に行消失インジケーター' })
        .toBe(true);
      const snapA = await snapshot(a.page);
      expect(snapA.isComposing, 'A は変換継続').toBe(true);
      expect(snapA.draft, 'A の draft 保持').toBe('にほん');
      expect((await editorProbe(a.page)).value, 'A の textarea 値 非破壊').toBe('にほん');
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test('AC3 K4: 行消失後に A が commit → target-deleted で退避（ドラフト保持＝reject 通知）・サイレント喪失なし', async ({
    browser,
  }) => {
    const a = await openClient(browser, 'ac3-a');
    const b = await openClient(browser, 'ac3-b');
    try {
      const newRowId = await insertFreshTopRow(a.page, b.page);
      await collabSelectCell(a.page, 0, 0);
      await collabComposeOpen(a.page, ['めも']);
      await expect.poll(async () => (await snapshot(a.page)).isComposing).toBe(true);

      const divertedBefore = (await snapshot(a.page)).divertedCount;
      await apiDeleteRows(b.page, [newRowId]);
      await expect
        .poll(async () => rowIndexOf(a.page, newRowId), { timeout: 15_000, message: 'A が削除を catch-up' })
        .toBe(-1);
      await expect.poll(async () => (await snapshot(a.page)).isTargetLost, { timeout: 15_000 }).toBe(true);

      // A が変換を確定 → commit。削除済み行へは submit せず退避（divertedDrafts が増える＝ドラフト保持・reject 通知）。
      await composeFinalizeAndCommit(a.page, 'めも');
      await expect
        .poll(async () => (await snapshot(a.page)).divertedCount, {
          timeout: 15_000,
          message: 'commit で target-deleted 退避（ドラフト保持）',
        })
        .toBe(divertedBefore + 1);
      // 削除は保持され行は復活しない（サイレントな行復活なし）。
      expect(await rowIndexOf(a.page, newRowId)).toBe(-1);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });
});
