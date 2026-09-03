// DD-035 R6 E2E: 命令 API `scrollToRow(rowId)` / `setActiveCell(rowId, columnId)`（単独モード・standalone.html）。
//
// 松下 DD-012-1 の実測課題「setData 再注入後に先頭へ入った追加行が画面外のまま」を再現し、再注入**直後**の呼び出し
// （行 Axis 未再構築＝構造 dirty 中）でも保留→flush 後適用で成立することを検証する。値は Canvas に描かれ DOM から
// 読めないため、debug API（scrollTop/cellRectAt/activeCell・test-support 経由）と診断エントリで観測する。

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import * as sa from './standalone-helpers';

test.describe.configure({ mode: 'serial' });

const VIEWPORT_H = 800;

async function api<R>(page: Page, method: string, args: unknown[] = []): Promise<R> {
  return page.evaluate(
    (payload: { method: string; args: unknown[] }) => {
      const a = (window as unknown as { __integrationTestApi?: Record<string, (...x: unknown[]) => unknown> })
        .__integrationTestApi;
      if (a === undefined) {
        throw new Error('__integrationTestApi 未初期化');
      }
      return a[payload.method]!.apply(a, payload.args);
    },
    { method, args },
  ) as Promise<R>;
}

async function scrollTop(page: Page): Promise<number> {
  return api<number>(page, 'scrollTop');
}
async function rowIndexOf(page: Page, rowId: string): Promise<number> {
  return api<number>(page, 'rowIndexOf', [rowId]);
}
async function diagnosticCodes(page: Page): Promise<string[]> {
  return page.evaluate(
    () => ((window as unknown as { __standalone?: { diagnostics: Array<{ code: string }> } }).__standalone?.diagnostics ?? []).map((d) => d.code),
  );
}

/** 200 行を再注入する（r0..r199・col-a=行ラベル）。 */
async function reinjectRows(page: Page, count: number): Promise<void> {
  await page.evaluate((n: number) => {
    const rows = Array.from({ length: n }, (_, i) => ({ rowId: `r${i}`, cells: { 'col-a': `行${i}` } }));
    window.__standalone?.reinject({ rows });
  }, count);
}

/** 行 index のセル矩形が body viewport 内に完全に入っているか。 */
async function rowVisible(page: Page, rowIndex: number): Promise<boolean> {
  const rect = await sa.cellRectAt(page, rowIndex, 0);
  if (rect === null) {
    return false;
  }
  return rect.y >= 24 && rect.y + rect.height <= VIEWPORT_H;
}

test('AC6-1: setData 再注入直後の scrollToRow → 保留→flush 後に対象行が可視化される（横スクロール不変）', async ({
  browser,
}) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    expect(await scrollTop(page)).toBe(0);
    // 再注入と scrollToRow を同一 evaluate 内で連続呼び出し（rAF flush 前＝構造 dirty 中）。
    await page.evaluate(() => {
      const rows = Array.from({ length: 200 }, (_, i) => ({ rowId: `r${i}`, cells: { 'col-a': `行${i}` } }));
      window.__standalone?.reinject({ rows });
      window.__gridInstance?.scrollToRow('r150');
    });
    await expect.poll(async () => sa.rowCount(page)).toBe(200);
    await expect.poll(async () => scrollTop(page), { message: 'scrollToRow で scrollTop が進む' }).toBeGreaterThan(0);
    const idx = await rowIndexOf(page, 'r150');
    expect(idx).toBe(150);
    await expect.poll(async () => rowVisible(page, idx), { message: 'r150 が可視域に入る' }).toBe(true);
    expect(await api<number>(page, 'scrollLeft')).toBe(0);
    // 可視行への scrollToRow はスクロールを動かさない（最小スクロール＝クリックで勝手に飛ばない規約）。
    const before = await scrollTop(page);
    await page.evaluate(() => window.__gridInstance?.scrollToRow('r150'));
    await page.waitForTimeout(100);
    expect(await scrollTop(page)).toBe(before);
    await page.screenshot({ path: sa.evidencePath('../DD-035/e2e-imperative-1-scroll-to-row.png') });
  } finally {
    await context.close();
  }
});

test('AC6-2: insertRows 直後の新 RowId へ scrollToRow / setActiveCell → 可視化・activeCell 移動・focus', async ({
  browser,
}) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    await reinjectRows(page, 200);
    await expect.poll(async () => sa.rowCount(page)).toBe(200);
    // 末尾付近へスクロールしておく（先頭に挿入した行は画面外＝松下の実測状況）。
    await page.evaluate(() => {
      const sc = document.querySelector('.nsheet-scroller');
      if (sc !== null) {
        sc.scrollTop = 3000;
        sc.dispatchEvent(new Event('scroll'));
      }
    });
    await expect.poll(async () => scrollTop(page)).toBeGreaterThan(2000);

    // 先頭行 r0 の直後（index 1＝body 先頭。index 0 は frozen 行で常に可視）へ 1 行挿入 → row-structure-change の新 RowId を
    // 拾い、直後（同一 evaluate 内・Axis 再構築前）に setActiveCell。
    const { newId, activeNow } = await page.evaluate(() => {
      const inst = window.__gridInstance!;
      inst.insertRows({ afterRowId: 'r0', count: 1 });
      const ev = [...(window.__standalone?.events ?? [])].reverse().find((e) => e.type === 'row-structure-change') as
        | { change: { kind: string; rowIds: string[] } }
        | undefined;
      const id = ev?.change.rowIds[0] ?? '';
      inst.setActiveCell(id, 'col-c');
      // Codex P1: 構造 dirty 中でも同期的に flush→適用される（次 rAF を待たない＝直後の打鍵が旧セルへ届かない）。
      return { newId: id, activeNow: window.__integrationTestApi!.activeCell() };
    });
    expect(newId).not.toBe('');
    expect(activeNow).toEqual({ row: 1, col: 2 });
    await expect.poll(async () => sa.rowCount(page)).toBe(201);
    await expect.poll(async () => rowIndexOf(page, newId)).toBe(1);
    await expect.poll(async () => sa.activeCell(page), { message: 'activeCell が新行の col-c へ' }).toEqual({ row: 1, col: 2 });
    await expect.poll(async () => scrollTop(page), { message: '新行が可視化される（先頭付近へ戻る）' }).toBeLessThan(100);
    await expect.poll(async () => rowVisible(page, 1)).toBe(true);
    // 常駐 textarea へ focus（ボタン起点で入力開始できる）。
    expect(await page.evaluate(() => document.activeElement?.className ?? '')).toBe('int-cell-editor');
    // そのまま印字 → 新行 col-c へ確定される（cell-commit）。
    await page.keyboard.type('abc');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await sa.events(page)).filter((e) => e.type === 'cell-commit').at(-1)?.changes?.[0])
      .toMatchObject({ rowId: newId, columnId: 'col-c', value: 'abc' });
    await page.screenshot({ path: sa.evidencePath('../DD-035/e2e-imperative-2-set-active-cell.png') });
  } finally {
    await context.close();
  }
});

test('AC6-3: 未知 RowId/ColumnId は診断 warn のみで無視（文書・activeCell 不変）／編集中の setActiveCell は確定して移動', async ({
  browser,
}) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    await sa.selectCell(page, 3, 1);
    const activeBefore = await sa.activeCell(page);
    const topBefore = await scrollTop(page);
    await page.evaluate(() => {
      window.__gridInstance?.scrollToRow('no-such-row');
      window.__gridInstance?.setActiveCell('r1', 'no-such-col');
      window.__gridInstance?.setActiveCell('no-such-row', 'col-a');
    });
    await expect.poll(async () => diagnosticCodes(page)).toContain('scroll-row-unknown');
    await expect.poll(async () => (await diagnosticCodes(page)).filter((c) => c === 'active-cell-unknown').length).toBe(2);
    expect(await sa.activeCell(page)).toEqual(activeBefore);
    expect(await scrollTop(page)).toBe(topBefore);

    // 編集中（Editing 位相・非 composition）に setActiveCell → クリックと同じく確定して移動する。
    await page.keyboard.type('xyz');
    await expect.poll(async () => sa.draft(page)).toBe('xyz');
    await page.evaluate(() => window.__gridInstance?.setActiveCell('r10', 'col-d'));
    await expect.poll(async () => sa.activeCell(page)).toEqual({ row: 10, col: 3 });
    await expect.poll(async () => sa.displayCell(page, 'r3', 'col-b'), { message: '編集中の値は確定される' }).toBe('xyz');
    expect(await sa.draft(page)).toBe('');
  } finally {
    await context.close();
  }
});

// ---- DD-036 C4: scrollToColumn（scrollToRow の鏡像・縦は動かさない）----

/** 列 index のセル矩形が body viewport（固定バンドの右側）に完全に入っているか。 */
async function columnVisible(page: Page, colIndex: number, frozenRight: number): Promise<boolean> {
  const rect = await sa.cellRectAt(page, 1, colIndex);
  if (rect === null) {
    return false;
  }
  return rect.x >= frozenRight && rect.x + rect.width <= 1280;
}

test('AC8-1: scrollToColumn で画面外の列が可視化される（縦スクロールは動かない・最小スクロール・setData 直後でも成立）', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: VIEWPORT_H } });
  const page = await context.newPage();
  try {
    await page.goto('/standalone.html?extracols=40');
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);

    // 縦にもスクロールしておき、scrollToColumn が縦を動かさないことを見る。
    await page.evaluate(() => {
      const rows = Array.from({ length: 200 }, (_, i) => ({ rowId: `r${i}`, cells: { 'col-a': `行${i}` } }));
      window.__standalone?.reinject({ rows });
      window.__gridInstance?.scrollToRow('r120');
    });
    await expect.poll(async () => scrollTop(page)).toBeGreaterThan(0);
    const topBefore = await scrollTop(page);
    expect(await api<number>(page, 'scrollLeft')).toBe(0);

    // 画面外の列（col-x35＝index 39）へ。
    await page.evaluate(() => window.__gridInstance?.scrollToColumn('col-x35'));
    await expect
      .poll(async () => api<number>(page, 'scrollLeft'), { message: 'scrollToColumn で scrollLeft が進む' })
      .toBeGreaterThan(0);
    await expect.poll(async () => columnVisible(page, 39, 52 + 80)).toBe(true);
    expect(await scrollTop(page)).toBe(topBefore); // 縦は動かない

    // 可視列への再呼び出しは動かさない（最小スクロール）。
    const leftBefore = await api<number>(page, 'scrollLeft');
    await page.evaluate(() => window.__gridInstance?.scrollToColumn('col-x35'));
    await page.waitForTimeout(100);
    expect(await api<number>(page, 'scrollLeft')).toBe(leftBefore);

    // 固定列（index 0）は常に可視ゆえ動かない。
    await page.evaluate(() => window.__gridInstance?.scrollToColumn('col-a'));
    await page.waitForTimeout(100);
    expect(await api<number>(page, 'scrollLeft')).toBe(leftBefore);

    // setData 再注入の直後（構造 dirty 中）でも成立する。
    await page.evaluate(() => {
      const rows = Array.from({ length: 50 }, (_, i) => ({ rowId: `n${i}`, cells: { 'col-a': `新${i}` } }));
      window.__standalone?.reinject({ rows });
      window.__gridInstance?.scrollToColumn('col-a'); // 先頭へ戻す（固定列＝最小スクロールで 0 へは戻らない）
      window.__gridInstance?.scrollToColumn('col-x2'); // index 6 → 左端へ寄る
    });
    await expect.poll(async () => sa.rowCount(page)).toBe(50);
    await expect.poll(async () => api<number>(page, 'scrollLeft')).toBeLessThan(leftBefore);
    await page.screenshot({ path: sa.evidencePath('../DD-036/e2e-imperative-3-scroll-to-column.png') });
  } finally {
    await context.close();
  }
});

test('AC8-2: 未知 ColumnId は診断 warn（scroll-column-unknown）のみで無視（スクロール不変）', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    const leftBefore = await api<number>(page, 'scrollLeft');
    const topBefore = await scrollTop(page);
    await page.evaluate(() => window.__gridInstance?.scrollToColumn('no-such-column'));
    await expect.poll(async () => diagnosticCodes(page)).toContain('scroll-column-unknown');
    expect(await api<number>(page, 'scrollLeft')).toBe(leftBefore);
    expect(await scrollTop(page)).toBe(topBefore);
  } finally {
    await context.close();
  }
});

