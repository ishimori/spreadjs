// DD-021-3 E2E: K3 選択・activeCell 再ベース（AC1〜4）と Undo 生存整合（AC5/6）。
//
// 再ベースは grid 層 hook（mount-controller の構造 flush 時）で RowId 追従する（状態機械無変更）。ローカル/リモートの
// 行 Insert/Delete で同一コード経路（masterLoop の captureRebaseState→applyRebaseState）が走るため、主検証は
// standalone（単一クライアント・決定的・低 flake）で AC1〜6 を、リモート起因の同経路確認を collab 1 本で行う。
// view 状態（rowIdAt/activeCell/rowCount）は描画 flush 時に再構築されるため expect.poll でゲートする（DD-021-1 教訓）。

import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { openClient, rowIdAt as collabRowIdAt, rowIndexOf as collabRowIndexOf, selectCell as collabSelectCell, snapshot } from './integration-helpers';
import {
  activeCell,
  composeOpen,
  displayCell,
  draft,
  isComposing,
  openStandalone,
  rowCount,
  rowIdAt,
  selectCell,
  undoDepth,
} from './standalone-helpers';

function evidencePath(fileName: string): string {
  return fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-021-3/${fileName}`, import.meta.url));
}

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

async function apiDeleteRows(page: Page, rowIds: readonly string[]): Promise<void> {
  await page.evaluate((ids: readonly string[]) => {
    const inst = (window as unknown as { __gridInstance?: { deleteRows(ids: readonly string[]): void } }).__gridInstance;
    if (inst === undefined) {
      throw new Error('__gridInstance 未初期化');
    }
    inst.deleteRows(ids);
  }, rowIds);
}

/** standalone の debug API（__integrationTestApi）の任意メソッドを呼ぶ（helpers 未export のものを補う）。 */
async function api<R>(page: Page, method: string, args: unknown[] = []): Promise<R> {
  return page.evaluate(
    (p: { method: string; args: unknown[] }) => {
      const a = (window as unknown as { __integrationTestApi?: Record<string, (...x: unknown[]) => unknown> })
        .__integrationTestApi;
      if (a === undefined) {
        throw new Error('__integrationTestApi 未初期化');
      }
      return a[p.method]!(...p.args);
    },
    { method, args },
  ) as Promise<R>;
}

const standaloneRowIndexOf = (page: Page, rowId: string): Promise<number> => api<number>(page, 'rowIndexOf', [rowId]);
const editingTarget = (page: Page): Promise<{ rowId: string; columnId: string } | null> =>
  api<{ rowId: string; columnId: string } | null>(page, 'editingTarget');

test.describe('DD-021-3 選択・activeCell 再ベース（K3・standalone）', () => {
  test('AC1 activeCell の上へ行挿入 → activeCell が同じ行実体（RowId）を指し続ける', async ({ browser }) => {
    const { context, page } = await openStandalone(browser);
    try {
      await selectCell(page, 5, 1);
      expect(await activeCell(page)).toEqual({ row: 5, col: 1 });
      const activeRowId = (await rowIdAt(page, 5))!;
      const anchorAbove = (await rowIdAt(page, 4))!; // active の直上行の直後へ挿入＝active の上

      await apiInsertRows(page, anchorAbove, 1);
      // 挿入行が index 5 に入り、旧 active（activeRowId）は index 6 へ押し下げられる。
      await expect.poll(async () => rowIdAt(page, 6), { message: '旧 active 行が 1 つ下へ' }).toBe(activeRowId);
      // activeCell は表示 index ではなく RowId を追従して index 6 を指す（列は不変）。
      await expect.poll(async () => (await activeCell(page)).row, { message: 'activeCell が RowId 追従' }).toBe(6);
      expect((await activeCell(page)).col).toBe(1);
      expect(await standaloneRowIndexOf(page, activeRowId)).toBe(6);
      await page.screenshot({ path: evidencePath('e2e-ac1-active-rebase.png') });
    } finally {
      await context.close();
    }
  });

  test('AC2 挿入後の Enter 確定 → 移動先が表示上の直下行（RowId とずれない）', async ({ browser }) => {
    const { context, page } = await openStandalone(browser);
    try {
      await selectCell(page, 5, 1);
      const activeRowId = (await rowIdAt(page, 5))!;
      await apiInsertRows(page, (await rowIdAt(page, 4))!, 1);
      await expect.poll(async () => (await activeCell(page)).row).toBe(6); // 再ベース完了を待つ
      const belowRowId = (await rowIdAt(page, 7))!; // 再ベース後 active（6）の表示直下

      await page.keyboard.press('Enter');
      // Enter は再ベース後 index を基準に 1 つ下（index 7）＝表示直下の行実体へ移る。
      await expect.poll(async () => (await activeCell(page)).row, { message: 'Enter で表示直下へ' }).toBe(7);
      expect(await rowIdAt(page, 7)).toBe(belowRowId);
      expect(await standaloneRowIndexOf(page, activeRowId)).toBe(6); // 挿入元の行は動かない
    } finally {
      await context.close();
    }
  });

  test('AC3 activeCell の行が削除 → 最近傍生存行（下優先）へ縮退・列保持', async ({ browser }) => {
    const { context, page } = await openStandalone(browser);
    try {
      await selectCell(page, 5, 2);
      const activeRowId = (await rowIdAt(page, 5))!;
      const belowRowId = (await rowIdAt(page, 6))!;

      await apiDeleteRows(page, [activeRowId]);
      // 旧 row6 が新 row5 へ繰り上がり、activeCell は生存行（下優先）へ縮退する。
      await expect.poll(async () => rowIdAt(page, 5), { message: '旧 row6 が新 row5 へ' }).toBe(belowRowId);
      await expect.poll(async () => (await activeCell(page)).row, { message: 'activeCell が生存行へ縮退' }).toBe(5);
      expect((await activeCell(page)).col).toBe(2); // 列は保持
      expect(await standaloneRowIndexOf(page, activeRowId)).toBe(-1); // 削除済み
    } finally {
      await context.close();
    }
  });

  test('AC4 編集中（IME）の上へ行挿入 → 編集セルの描画が RowId 追従・ドラフト非破壊', async ({ browser }) => {
    const { context, page } = await openStandalone(browser);
    try {
      await selectCell(page, 5, 1);
      const editRowId = (await rowIdAt(page, 5))!;
      // 変換を開始して Composing のまま留める（編集セル = editRowId/col1）。
      await page.locator('textarea.int-cell-editor').focus();
      await composeOpen(page, 'にほん');
      await expect.poll(async () => isComposing(page), { message: '変換中に入る' }).toBe(true);
      expect((await editingTarget(page))?.rowId).toBe(editRowId);

      // 編集セルの上へリモート相当の行挿入（公開 API）。
      await apiInsertRows(page, (await rowIdAt(page, 4))!, 1);
      // 編集セルの描画位置は editingTarget（RowId）で追従＝index 6 へ。activeCell（状態機械）は変換中ゆえ触らない（I-3）。
      await expect
        .poll(async () => standaloneRowIndexOf(page, editRowId), { message: '編集セルが RowId 追従' })
        .toBe(6);
      // ドラフト・変換状態は非破壊。
      expect(await isComposing(page)).toBe(true);
      expect(await draft(page)).toBe('にほん');
      expect((await editingTarget(page))?.rowId).toBe(editRowId);
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
});

test.describe('DD-021-3 Undo 生存整合（AC5/6・standalone）', () => {
  test('AC5 削除行に触れる Undo → 実行前検査で拒否・スタック除去・行は復活しない', async ({ browser }) => {
    const { context, page } = await openStandalone(browser);
    try {
      // セルを編集して Undo エントリを 1 つ積む。
      await selectCell(page, 5, 0);
      const editRowId = (await rowIdAt(page, 5))!;
      await page.keyboard.type('hello');
      await page.keyboard.press('Enter');
      await expect.poll(async () => undoDepth(page), { message: 'Undo エントリが積まれる' }).toBe(1);
      expect(await displayCell(page, editRowId, 'col-a')).toBe('hello');

      // その行を削除 → Undo エントリは削除行を対象に含む。
      const before = await rowCount(page);
      await apiDeleteRows(page, [editRowId]);
      await expect.poll(async () => rowCount(page)).toBe(before - 1);

      // Undo（Ctrl+Z）→ 実行前検査（target-row-deleted）で拒否され、エントリはスタックから除去される。
      await page.keyboard.press('Control+z');
      await expect.poll(async () => undoDepth(page), { message: '削除行の Undo エントリは除去' }).toBe(0);
      // 行は復活しない（サイレントな行復活/上書きなし）。
      expect(await rowCount(page)).toBe(before - 1);
      expect(await standaloneRowIndexOf(page, editRowId)).toBe(-1);
    } finally {
      await context.close();
    }
  });

  test('AC6 行挿入は既存 Undo エントリへ無影響（挿入後も Undo が正しい前値へ戻す）', async ({ browser }) => {
    const { context, page } = await openStandalone(browser);
    try {
      await selectCell(page, 5, 0);
      const editRowId = (await rowIdAt(page, 5))!;
      const prevValue = await displayCell(page, editRowId, 'col-a'); // 編集前の値（seed 由来でも空でも可）
      await page.keyboard.type('world');
      await page.keyboard.press('Enter');
      await expect.poll(async () => undoDepth(page)).toBe(1);
      await expect.poll(async () => displayCell(page, editRowId, 'col-a')).toBe('world');

      // 別の場所（先頭）へ行挿入 → Undo エントリは RowId ベースゆえ無影響。
      await apiInsertRows(page, null, 1);
      await expect.poll(async () => (await rowIdAt(page, 0)) !== editRowId).toBe(true);

      // Undo → editRowId のセルが挿入前の値へ正しく戻る（挿入で index がずれても RowId で正しく復元）。
      await page.keyboard.press('Control+z');
      await expect
        .poll(async () => displayCell(page, editRowId, 'col-a'), { message: '挿入後も Undo が前値へ戻す' })
        .toBe(prevValue);
      await expect.poll(async () => undoDepth(page)).toBe(0);
    } finally {
      await context.close();
    }
  });
});

test.describe('DD-021-3 リモート起因の再ベース（collab・同一 hook 確認）', () => {
  test('AC1(remote) 他クライアントが activeCell の上へ挿入 → activeCell が RowId を追従', async ({ browser }) => {
    const a = await openClient(browser, 'rebase-a');
    const b = await openClient(browser, 'rebase-b');
    try {
      // A が本体行を選択（先頭 frozen 行を避け body 行 10 を使う）。
      await collabSelectCell(a.page, 10, 1);
      const activeRow0 = (await snapshot(a.page)).activeCell.row;
      const activeRowId = (await collabRowIdAt(a.page, activeRow0))!;

      // B が先頭へ 1 行挿入（additive・共有 50k 文書を壊さない）→ A の全 body 行が 1 つ下へずれる。
      await apiInsertRows(b.page, null, 1);
      await expect
        .poll(async () => collabRowIndexOf(a.page, activeRowId), { timeout: 15_000, message: 'A が B の挿入を catch-up し行がずれる' })
        .toBeGreaterThan(activeRow0);

      // A の activeCell は表示 index ではなく RowId を追従して新 index を指す（別行を指さない）。
      await expect
        .poll(async () => {
          const snap = await snapshot(a.page);
          const idx = await collabRowIndexOf(a.page, activeRowId);
          return snap.activeCell.row === idx;
        }, { timeout: 15_000, message: 'activeCell が RowId 追従（別行を指さない）' })
        .toBe(true);
      expect((await snapshot(a.page)).activeCell.col).toBe(1);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });
});
