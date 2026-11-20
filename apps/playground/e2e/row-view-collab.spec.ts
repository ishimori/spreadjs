// DD-070-9 E2E: 見せる行と並び（setRowView・visibleRowIds）を共同編集モードの 2 クライアントで確かめる。
//
// 共有文書（50,000 行シード・spec をまたいで同じ）を壊さないため、B が先頭へ新しい行を 4 行挿してから、その行だけを
// 使う（最後に消す＝行数は差し引きで変わらない）。拒否の巻き戻し（AC4）は認可フック E2E 用サーバー（lock 中はすべての
// 操作を拒否・authorize-operation.spec.ts と同じ）で、サーバーの文書は変わらない。

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import * as ih from './integration-helpers';

test.describe.configure({ mode: 'serial' });

const WS_ORIGIN_AUTHORIZE = 'http://127.0.0.1:8803';
const CONTROL_ORIGIN = 'http://127.0.0.1:8804';

type Grid = {
  setRowView(ids: readonly string[] | null): void;
  visibleRowIds(): readonly string[];
  insertRows(o: { afterRowId: string | null; count?: number }): void;
  deleteRows(ids: readonly string[]): void;
  setActiveCell(rowId: string, columnId: string): void;
  selection(): { activeCell: { rowId: string; columnId: string } | null };
  getRows(o?: { rowIds?: readonly string[]; columnIds?: readonly string[] }): Array<{ rowId: string; cells: Record<string, string> }>;
};

/** setRowView を呼び、行の Axis が作り直される次の描画まで待つ（visibleRowIds は描画を待たずに新しい並びを返す）。 */
const view = (page: Page, ids: readonly string[] | null) =>
  page.evaluate((list) => {
    (window as unknown as { __gridInstance: Grid }).__gridInstance.setRowView(list);
    return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, ids);
const visible = (page: Page) => page.evaluate(() => [...(window as unknown as { __gridInstance: Grid }).__gridInstance.visibleRowIds()]);
const insertAfter = (page: Page, afterRowId: string | null, count = 1) =>
  page.evaluate((o) => (window as unknown as { __gridInstance: Grid }).__gridInstance.insertRows(o), { afterRowId, count });
const remove = (page: Page, ids: readonly string[]) => page.evaluate((list) => (window as unknown as { __gridInstance: Grid }).__gridInstance.deleteRows(list), ids);
const setActive = (page: Page, rowId: string, columnId: string) =>
  page.evaluate((o) => (window as unknown as { __gridInstance: Grid }).__gridInstance.setActiveCell(o.rowId, o.columnId), { rowId, columnId });
const activeRow = (page: Page) => page.evaluate(() => (window as unknown as { __gridInstance: Grid }).__gridInstance.selection().activeCell?.rowId);
const readRows = (page: Page, rowIds: string[], columnIds: string[]) =>
  page.evaluate((o) => (window as unknown as { __gridInstance: Grid }).__gridInstance.getRows(o), { rowIds, columnIds });

/** 先頭へ count 行を挿し、両方のクライアントに届いた新しい行 ID（文書の並び）を返す。 */
async function insertFreshTop(writer: Page, other: Page, count: number): Promise<string[]> {
  const before = await ih.rowIdAt(writer, 0);
  await insertAfter(writer, null, count);
  await expect.poll(() => ih.rowIdAt(writer, 0)).not.toBe(before);
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) ids.push((await ih.rowIdAt(writer, i))!);
  await expect.poll(() => ih.rowIndexOf(other, ids[count - 1]!)).not.toBe(-1);
  await expect.poll(async () => (await ih.snapshot(writer)).pendingCount).toBe(0);
  return ids;
}

async function overlayOpaque(page: Page): Promise<number> {
  return page.evaluate(() => {
    const overlay = document.querySelectorAll('.nsheet-stage canvas')[1] as HTMLCanvasElement;
    const data = overlay.getContext('2d')!.getImageData(0, 0, overlay.width, overlay.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) count += 1;
    return count;
  });
}

interface Pair {
  a: { context: BrowserContext; page: Page };
  b: { context: BrowserContext; page: Page };
  fresh: string[];
  /** 後片付けで消す行（fresh と、テストの中で挿した行）。 */
  cleanup: string[];
}

async function openPair(browser: Browser, tag: string): Promise<Pair> {
  const a = await ih.openClient(browser, `rv-a-${tag}`);
  const b = await ih.openClient(browser, `rv-b-${tag}`);
  const fresh = await insertFreshTop(b.page, a.page, 4);
  return { a, b, fresh, cleanup: [...fresh] };
}

async function closePair(pair: Pair): Promise<void> {
  try {
    const alive: string[] = [];
    for (const id of pair.cleanup) if ((await ih.rowIndexOf(pair.b.page, id)) !== -1) alive.push(id);
    if (alive.length > 0) {
      await remove(pair.b.page, alive);
      await expect.poll(async () => (await ih.snapshot(pair.b.page)).pendingCount).toBe(0);
    }
  } finally {
    await pair.a.context.close();
    await pair.b.context.close();
  }
}

test('AC1: A の並べ替えは B の並び・Undo を変えない（view-local）', async ({ browser }) => {
  const pair = await openPair(browser, 'ac1');
  const { a, b, fresh } = pair;
  try {
    const [f0, f1, , f3] = fresh as [string, string, string, string];
    const col = (await ih.colIdAt(a.page, 0))!;
    await view(a.page, [f3, f1, f0]);
    await expect.poll(() => visible(a.page)).toEqual([f3, f1, f0]);
    expect(await ih.rowIdAt(b.page, 0)).toBe(f0); // B は文書の並びのまま
    expect((await visible(b.page)).length).toBe((await ih.snapshot(b.page)).rowCount);
    const bUndo = await ih.undoDepth(b.page);
    // A が並べ替えたまま先頭（f3）を編集し、Undo で戻す。B の Undo の深さは変わらない。
    const value = `rv1-${Date.now()}`;
    await ih.selectCell(a.page, 0, 0);
    await ih.plainTypeAndCommit(a.page, value);
    await expect.poll(() => ih.committedCell(b.page, f3, col)).toBe(value);
    expect(await ih.undoDepth(b.page)).toBe(bUndo);
    await a.page.keyboard.press('Control+z');
    await expect.poll(() => ih.committedCell(b.page, f3, col)).toBe('');
    expect(await visible(a.page)).toEqual([f3, f1, f0]); // 並びは残る
  } finally {
    await closePair(pair);
  }
});

test('AC2: A の並べ替え中に B が挿した行は一つ前の見えている行のすぐ後に出て、消した行は抜ける。選択中の行が消えたら近くの見えている行へ', async ({ browser }) => {
  const pair = await openPair(browser, 'ac2');
  const { a, b, fresh } = pair;
  try {
    const [f0, f1, , f3] = fresh as [string, string, string, string];
    const col = (await ih.colIdAt(a.page, 0))!;
    await view(a.page, [f3, f1, f0]);
    await expect.poll(() => visible(a.page)).toEqual([f3, f1, f0]);
    await insertAfter(b.page, f0, 1); // 文書の並び: f0, n, f1, f2, f3
    await expect.poll(async () => (await visible(a.page)).length).toBe(4);
    const n = (await visible(a.page))[3]!;
    pair.cleanup.push(n);
    expect(await visible(a.page)).toEqual([f3, f1, f0, n]);
    // A が f1 を選んでいるときに B が f1 を消す → A の選択は前の並びで下の f0 へ。
    await setActive(a.page, f1, col);
    await expect.poll(() => activeRow(a.page)).toBe(f1);
    await remove(b.page, [f1]);
    await expect.poll(() => visible(a.page)).toEqual([f3, f0, n]);
    await expect.poll(() => activeRow(a.page)).toBe(f0);
  } finally {
    await closePair(pair);
  }
});

test('AC3: A の絞り込み中に B が隠れている行・見えている行の値を変える → 並びは同じ、隠れている行は出ず、getRows には両方入る', async ({ browser }) => {
  const pair = await openPair(browser, 'ac3');
  const { a, b, fresh } = pair;
  try {
    const [f0, , f2, f3] = fresh as [string, string, string, string];
    const col = (await ih.colIdAt(a.page, 0))!;
    await view(a.page, [f3, f0]);
    await expect.poll(() => visible(a.page)).toEqual([f3, f0]);
    const hiddenValue = `rv3h-${Date.now()}`;
    const shownValue = `rv3s-${Date.now()}`;
    // B の先頭へ挿した行は scroll の位置の補正で画面の上に外れているので、クリックでなく行 ID で選ぶ。
    await setActive(b.page, f2, col);
    await ih.plainTypeAndCommit(b.page, hiddenValue);
    await setActive(b.page, f3, col);
    await ih.plainTypeAndCommit(b.page, shownValue);
    await expect.poll(() => ih.displayCell(a.page, f3, col)).toBe(shownValue);
    expect(await visible(a.page)).toEqual([f3, f0]);
    const rows = await readRows(a.page, [f2, f3], [col]);
    expect(Object.fromEntries(rows.map((r) => [r.rowId, r.cells[col]]))).toEqual({ [f2]: hiddenValue, [f3]: shownValue });
  } finally {
    await closePair(pair);
  }
});

test('AC5: A の並べ替え中に切断・再接続 → 並びは残り、切れている間に B が挿した行は一つ前の見えている行のすぐ後に出る', async ({ browser }) => {
  const pair = await openPair(browser, 'ac5');
  const { a, b, fresh } = pair;
  try {
    const [f0, f1, , f3] = fresh as [string, string, string, string];
    await view(a.page, [f3, f1, f0]);
    await expect.poll(() => visible(a.page)).toEqual([f3, f1, f0]);
    await ih.simulateDrop(a.page);
    await expect.poll(() => ih.connectionState(a.page)).not.toBe('online');
    await insertAfter(b.page, f3, 1); // 文書の並び: f0, f1, f2, f3, n
    await expect.poll(async () => (await ih.snapshot(b.page)).pendingCount).toBe(0);
    const n = (await ih.rowIdAt(b.page, (await ih.rowIndexOf(b.page, f3)) + 1))!;
    pair.cleanup.push(n);
    await ih.simulateReconnect(a.page);
    await expect.poll(() => ih.connectionState(a.page), { timeout: 30_000 }).toBe('online');
    await expect.poll(() => visible(a.page), { timeout: 30_000 }).toEqual([f3, n, f1, f0]);
  } finally {
    await closePair(pair);
  }
});

test('AC6: B が A で隠れている行を選んでいるとき、A に B の枠が描かれない', async ({ browser }) => {
  const pair = await openPair(browser, 'ac6');
  const { a, b, fresh } = pair;
  try {
    const [f0, , f2, f3] = fresh as [string, string, string, string];
    const col = (await ih.colIdAt(a.page, 0))!;
    await view(a.page, [f3, f0]);
    await expect.poll(() => visible(a.page)).toEqual([f3, f0]);
    await ih.selectCell(a.page, 1, 3); // A 自身の選択は B の枠と重ならないセルに置く
    await setActive(b.page, f2, col); // A では隠れている行
    await expect.poll(async () => (await ih.snapshot(a.page)).presences.length).toBeGreaterThan(0);
    await a.page.waitForTimeout(300);
    const hiddenCount = await overlayOpaque(a.page);
    await setActive(b.page, f3, col); // A で見えている行 → 枠が描かれる（測り方の感度の確認）
    await expect.poll(() => overlayOpaque(a.page)).toBeGreaterThan(hiddenCount);
    await setActive(b.page, f2, col); // 隠れている行へ戻る → 枠は消える
    await expect.poll(() => overlayOpaque(a.page)).toBe(hiddenCount);
  } finally {
    await closePair(pair);
  }
});

test.describe('拒否の巻き戻し（認可フック E2E 用サーバー）', () => {
  async function openAuthorize(browser: Browser, name: string): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(`/poc-integration.html?name=${encodeURIComponent(name)}&server=${encodeURIComponent(WS_ORIGIN_AUTHORIZE)}`);
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await expect.poll(async () => (await ih.snapshot(page)).ready, { timeout: 30_000 }).toBe(true);
    return { context, page };
  }

  async function rejectedCount(page: Page): Promise<number> {
    return page.evaluate(
      () => ((window as unknown as { __gridEvents?: Array<{ type: string }> }).__gridEvents ?? []).filter((e) => e.type === 'rejected').length,
    );
  }

  test('AC4: 並べ替え中の自分の挿入・削除が拒否される → 挿した行は抜け、消した行は元の並びの位置に戻る', async ({ browser, request }) => {
    await request.post(`${CONTROL_ORIGIN}/unlock`);
    const a = await openAuthorize(browser, 'rv-a-ac4');
    try {
      const [x0, x1, x2] = [(await ih.rowIdAt(a.page, 0))!, (await ih.rowIdAt(a.page, 1))!, (await ih.rowIdAt(a.page, 2))!];
      await view(a.page, [x2, x0]); // x1 は隠れている
      await expect.poll(() => visible(a.page)).toEqual([x2, x0]);
      expect((await request.post(`${CONTROL_ORIGIN}/lock`)).ok()).toBe(true);
      let rejected = await rejectedCount(a.page);
      await insertAfter(a.page, x0, 1);
      // 楽観で出た行（x0 のすぐ後）は、localhost では拒否がすぐ届くので見えている間を捕まえない（位置は単体で確かめる）。
      await expect.poll(() => rejectedCount(a.page), { timeout: 10_000 }).toBeGreaterThan(rejected);
      await expect.poll(() => visible(a.page)).toEqual([x2, x0]); // 巻き戻しで抜ける
      rejected = await rejectedCount(a.page);
      await remove(a.page, [x2]);
      await expect.poll(() => rejectedCount(a.page), { timeout: 10_000 }).toBeGreaterThan(rejected);
      await expect.poll(() => visible(a.page)).toEqual([x2, x0]); // 巻き戻しで元の位置に戻る（x1 は隠れたまま）
      expect(x1).not.toBe(x0);
    } finally {
      await request.post(`${CONTROL_ORIGIN}/unlock`);
      await a.context.close();
    }
  });
});

test('Codex P2: A が選択中の先頭の行を隠して同じ番号の別の行になったら、B に見える A の在席も新しい行へ移る', async ({ browser }) => {
  const pair = await openPair(browser, 'presence');
  const { a, b, fresh } = pair;
  try {
    const [f0, f1] = fresh as [string, string, string, string];
    const col = (await ih.colIdAt(a.page, 0))!;
    await view(a.page, [f0, f1]);
    await expect.poll(() => visible(a.page)).toEqual([f0, f1]);
    await setActive(a.page, f0, col);
    const presenceRow = async (): Promise<string | undefined> => {
      const presences = (await ih.snapshot(b.page)).presences;
      return presences.find((p) => p.displayName === 'rv-a-presence')?.activeCell?.rowId;
    };
    await expect.poll(presenceRow).toBe(f0);
    await view(a.page, [f1]); // A の選択は同じ番号 0 の f1 になる
    await expect.poll(() => activeRow(a.page)).toBe(f1);
    await expect.poll(presenceRow).toBe(f1);
  } finally {
    await closePair(pair);
  }
});

test('DD-070-9: mount の直後（サーバーの初回の状態を受け取る前）に呼んだ setRowView は、初回の状態を受け取った後に効く', async ({ browser }) => {
  const pair = await openPair(browser, 'initial');
  const { fresh } = pair;
  const [f0, , f2] = fresh as [string, string, string, string];
  // openClient は 50,000 行が見えることを確かめるので使わない（見えるのは 2 行）。
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto(`/poc-integration.html?name=rv-c-initial&server=${encodeURIComponent(ih.WS_ORIGIN)}&rowview=${f2},${f0}`);
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await expect.poll(async () => (await ih.snapshot(page)).ready, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => visible(page)).toEqual([f2, f0]);
  } finally {
    await context.close();
    await closePair(pair);
  }
});
