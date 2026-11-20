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

/** このクライアントが挿した行（row-structure-change の insert が知らせた行 ID）を、知らせた順に返す。 */
async function insertedIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ((window as unknown as { __gridEvents?: Array<{ type: string; change?: { kind: string; rowIds: string[] } }> }).__gridEvents ?? [])
      .filter((e) => e.type === 'row-structure-change' && e.change?.kind === 'insert')
      .flatMap((e) => e.change!.rowIds),
  );
}

/** afterRowId の後へ count 行を挿し、挿した行 ID（文書の並び）を返す。ACK まで待つ。 */
async function insertAndGet(writer: Page, afterRowId: string | null, count: number): Promise<string[]> {
  const before = (await insertedIds(writer)).length;
  await insertAfter(writer, afterRowId, count);
  await expect.poll(async () => (await insertedIds(writer)).length).toBe(before + count);
  await expect.poll(async () => (await ih.snapshot(writer)).pendingCount).toBe(0);
  return (await insertedIds(writer)).slice(before);
}

/** 先頭へ count 行を挿し、相手にも届いた新しい行 ID（文書の並び）を返す。 */
async function insertFreshTop(writer: Page, other: Page, count: number): Promise<string[]> {
  const ids = await insertAndGet(writer, null, count);
  await expect.poll(() => ih.rowIndexOf(other, ids[count - 1]!)).not.toBe(-1);
  return ids;
}

/** 描画に使っている行の Axis の並び（visibleRowIds は描画を待たずに文書から組み立てるので、描かれた並びはこちらで見る）。 */
async function drawnRows(page: Page): Promise<string[]> {
  const count = (await ih.snapshot(page)).rowCount;
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push((await ih.rowIdAt(page, i))!);
  return out;
}

/** overlay（選択・在席の枠）の不透明な画素の数。except（CSS 座標の矩形・A 自身の選択）の中は数えない。 */
async function overlayOpaqueOutside(page: Page, except: { x: number; y: number; width: number; height: number }): Promise<number> {
  return page.evaluate((r) => {
    const overlay = document.querySelectorAll('.nsheet-stage canvas')[1] as HTMLCanvasElement;
    const dpr = overlay.width / overlay.clientWidth;
    const data = overlay.getContext('2d')!.getImageData(0, 0, overlay.width, overlay.height).data;
    const margin = 8;
    let count = 0;
    for (let y = 0; y < overlay.height; y += 1) {
      for (let x = 0; x < overlay.width; x += 1) {
        if ((data[(y * overlay.width + x) * 4 + 3] ?? 0) === 0) continue;
        const cx = x / dpr;
        const cy = y / dpr;
        if (cx >= r.x - margin && cx <= r.x + r.width + margin && cy >= r.y - margin && cy <= r.y + r.height + margin) continue;
        count += 1;
      }
    }
    return count;
  }, except);
}

const nextFrames = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

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
    // Codex P3: B の Undo の深さと並びは A が並べ替える前に採る。
    const bUndo = await ih.undoDepth(b.page);
    const bRowsBefore = await visible(b.page);
    await view(a.page, [f3, f1, f0]);
    await expect.poll(() => drawnRows(a.page)).toEqual([f3, f1, f0]);
    expect(await visible(b.page)).toEqual(bRowsBefore); // B は文書の並びのまま
    expect(await ih.undoDepth(b.page)).toBe(bUndo);
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
    await expect.poll(() => drawnRows(a.page)).toEqual([f3, f1, f0]);
    const [n] = (await insertAndGet(b.page, f0, 1)) as [string]; // 文書の並び: f0, n, f1, f2, f3
    pair.cleanup.push(n);
    await expect.poll(() => drawnRows(a.page)).toEqual([f3, f1, f0, n]);
    // A が f1 を選んでいるときに B が f1 を消す → A の選択は前の並びで下の f0 へ。
    await setActive(a.page, f1, col);
    await expect.poll(() => activeRow(a.page)).toBe(f1);
    await remove(b.page, [f1]);
    await expect.poll(() => drawnRows(a.page)).toEqual([f3, f0, n]);
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
    await expect.poll(() => drawnRows(a.page)).toEqual([f3, f0]);
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
    await expect.poll(() => drawnRows(a.page)).toEqual([f3, f1, f0]);
    await ih.simulateDrop(a.page);
    await expect.poll(() => ih.connectionState(a.page)).not.toBe('online');
    const [n] = (await insertAndGet(b.page, f3, 1)) as [string]; // 文書の並び: f0, f1, f2, f3, n（差分の tail で届く）
    pair.cleanup.push(n);
    await ih.simulateReconnect(a.page);
    await expect.poll(() => ih.connectionState(a.page), { timeout: 30_000 }).toBe('online');
    await expect.poll(() => drawnRows(a.page), { timeout: 30_000 }).toEqual([f3, n, f1, f0]);
  } finally {
    await closePair(pair);
  }
});

/** 同じ行の後へ 1 行ずつ count 回挿す（1 回ごとに別の操作）。 */
async function page_insertMany(page: Page, afterRowId: string, count: number): Promise<void> {
  await page.evaluate(
    (o) => {
      const g = (window as unknown as { __gridInstance: Grid }).__gridInstance;
      for (let i = 0; i < o.count; i += 1) g.insertRows({ afterRowId: o.afterRowId, count: 1 });
    },
    { afterRowId, count },
  );
}

test('AC6: B が A で隠れている行を選んでいるとき、A に B の枠が描かれない', async ({ browser }) => {
  const pair = await openPair(browser, 'ac6');
  const { a, b, fresh } = pair;
  try {
    const [f0, , f2, f3] = fresh as [string, string, string, string];
    const col = (await ih.colIdAt(a.page, 0))!;
    await view(a.page, [f3, f0]);
    await expect.poll(() => visible(a.page)).toEqual([f3, f0]);
    await ih.selectCell(a.page, 1, 3); // A 自身の選択は B の枠と重ならないセルに置く
    const own = (await ih.cellRectAt(a.page, 1, 3))!;
    await a.page.mouse.move(5, 5); // ホバーの描画を残さない
    const bAt = async (): Promise<string | undefined> =>
      (await ih.snapshot(a.page)).presences.find((p) => p.displayName === 'rv-b-ac6')?.activeCell?.rowId;
    await setActive(b.page, f2, col); // A では隠れている行
    await expect.poll(bAt).toBe(f2); // A が B の在席を受け取った
    await nextFrames(a.page);
    expect(await overlayOpaqueOutside(a.page, own)).toBe(0); // A 自身の選択の外に何も描かれていない（枠も名前タグも）
    await setActive(b.page, f3, col); // A で見えている行 → 枠が描かれる（測り方の感度の確認）
    await expect.poll(bAt).toBe(f3);
    await expect.poll(() => overlayOpaqueOutside(a.page, own)).toBeGreaterThan(0);
    await setActive(b.page, f2, col); // 隠れている行へ戻る → 枠は消える
    await expect.poll(bAt).toBe(f2);
    await expect.poll(() => overlayOpaqueOutside(a.page, own)).toBe(0);
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

  /** サーバーの認可の拒否（permission-denied）の数（クライアントの実行前の拒否は数えない）。 */
  async function deniedCount(page: Page): Promise<number> {
    return page.evaluate(
      () =>
        ((window as unknown as { __gridEvents?: Array<{ type: string; conflict?: { code: string } }> }).__gridEvents ?? []).filter(
          (e) => e.type === 'rejected' && e.conflict?.code === 'permission-denied',
        ).length,
    );
  }

  test('AC5（Codex P2）: 切れている間の差分が多く、再接続で文書を丸ごと受け取り直しても（snapshot の bootstrap）並びは残る', async ({ browser, request }) => {
    // 共有の 50,000 行の文書では操作のたびに文書を丸ごと複製する（DD-070-1）ため 1,001 回の操作が遅い。小さい文書の認可サーバー
    // （lock を解いて使う）で、閾値（1,000 件）を超える差分を作る。挿した行は最後に消す（行数は差し引きで変わらない）。
    test.setTimeout(120_000);
    await request.post(`${CONTROL_ORIGIN}/unlock`);
    const a = await openAuthorize(browser, 'rv-a-ac5b');
    const b = await openAuthorize(browser, 'rv-b-ac5b');
    const cleanup: string[] = [];
    try {
      const fresh = await insertAndGet(b.page, null, 4);
      cleanup.push(...fresh);
      const [f0, f1, , f3] = fresh as [string, string, string, string];
      await expect.poll(() => ih.rowIndexOf(a.page, f3)).not.toBe(-1);
      await view(a.page, [f3, f1, f0]);
      await expect.poll(() => drawnRows(a.page)).toEqual([f3, f1, f0]);
      const bootstrapBefore = await ih.bootstrapRevision(a.page);
      await ih.simulateDrop(a.page);
      await expect.poll(() => ih.connectionState(a.page)).not.toBe('online');
      // f3 の後へ 1 行ずつ 1,001 回挿す（1 回ごとに別の操作。文書の並びは f3 の後に新しい順）。一度に送ると B の未送信が積み上がって
      // 接続が止まることがあるので、100 回ずつ ACK を待って送る。
      const before = (await insertedIds(b.page)).length;
      for (let sent = 0; sent < 1_001; sent += 100) {
        await page_insertMany(b.page, f3, Math.min(100, 1_001 - sent));
        await expect.poll(async () => (await ih.snapshot(b.page)).pendingCount, { timeout: 30_000 }).toBe(0);
      }
      expect((await insertedIds(b.page)).length).toBe(before + 1_001);
      const added = (await insertedIds(b.page)).slice(before);
      cleanup.push(...added);
      const addedSet = new Set(added);
      const addedInDocOrder = (await visible(b.page)).filter((id) => addedSet.has(id));
      await ih.simulateReconnect(a.page);
      await expect.poll(() => ih.connectionState(a.page), { timeout: 30_000 }).toBe('online');
      await expect.poll(() => ih.bootstrapRevision(a.page), { timeout: 30_000 }).toBeGreaterThan(bootstrapBefore); // 丸ごと受け取り直した
      await expect.poll(() => visible(a.page), { timeout: 30_000 }).toEqual([f3, ...addedInDocOrder, f1, f0]);
      expect((await drawnRows(a.page)).length).toBe(addedInDocOrder.length + 3);
    } finally {
      try {
        if (cleanup.length > 0) {
          await remove(b.page, cleanup);
          await expect.poll(async () => (await ih.snapshot(b.page)).pendingCount, { timeout: 30_000 }).toBe(0);
        }
      } finally {
        await a.context.close();
        await b.context.close();
      }
    }
  });

  test('AC4: 並べ替え中の自分の挿入・削除が拒否される → 挿した行は抜け、消した行は元の並びの位置に戻る', async ({ browser, request }) => {
    await request.post(`${CONTROL_ORIGIN}/unlock`);
    const a = await openAuthorize(browser, 'rv-a-ac4');
    try {
      const [x0, x1, x2] = [(await ih.rowIdAt(a.page, 0))!, (await ih.rowIdAt(a.page, 1))!, (await ih.rowIdAt(a.page, 2))!];
      await view(a.page, [x2, x0]); // x1 は隠れている
      await expect.poll(() => drawnRows(a.page)).toEqual([x2, x0]);
      expect((await request.post(`${CONTROL_ORIGIN}/lock`)).ok()).toBe(true);
      let denied = await deniedCount(a.page);
      // 挿す: 楽観の並び（x0 のすぐ後）は同じ処理の中で読む（localhost では拒否がすぐ届くので、後から画面を見ても捕まえられない）。
      const optimistic = await a.page.evaluate((after) => {
        const g = (window as unknown as { __gridInstance: Grid }).__gridInstance;
        g.insertRows({ afterRowId: after, count: 1 });
        return [...g.visibleRowIds()];
      }, x0);
      expect(optimistic.slice(0, 2)).toEqual([x2, x0]);
      expect(optimistic).toHaveLength(3);
      await expect.poll(() => deniedCount(a.page), { timeout: 10_000 }).toBeGreaterThan(denied);
      await expect.poll(() => drawnRows(a.page)).toEqual([x2, x0]); // 巻き戻しで抜ける（描かれた並び）
      denied = await deniedCount(a.page);
      await remove(a.page, [x2]);
      await expect.poll(() => deniedCount(a.page), { timeout: 10_000 }).toBeGreaterThan(denied);
      await expect.poll(() => drawnRows(a.page)).toEqual([x2, x0]); // 巻き戻しで元の位置に戻る（x1 は隠れたまま）
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
    await expect.poll(() => drawnRows(a.page)).toEqual([f0, f1]);
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
    await expect.poll(() => drawnRows(page)).toEqual([f2, f0]);
  } finally {
    await context.close();
    await closePair(pair);
  }
});
