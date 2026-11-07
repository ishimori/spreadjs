// DD-064 E2E: セルの結合（mergedCells・setMergedCells）と 2段の見出し（columnGroups）を単独グリッド（standalone.html・
// consumer の hiroshima-keikaku と同じモード）で確かめる。
//
//   AC1 3行×1列の結合が 1 つのセルとして描かれる（範囲の中の横線なし・背景は左上の行）。base canvas の画素
//   AC2 範囲の中のクリック・矢印キー・Tab・Enter（編集中の確定と移動を含む）で左上に正規化され、範囲を 1 セルとして抜ける
//   AC3 結合範囲で印字キー・F2・Delete・ダブルクリック・貼り付けをしても文書は変わらない（貼り付けは範囲だけ飛ばす）
//   AC4 コピーは左上に値・残りは空。Shift＋矢印の範囲は結合を含むまで広がる
//   AC5 形の誤りは mount で error（merged-cells-invalid）。setMergedCells の誤り・重なり・未知の行・入れ直しで消えた行は warn
//   AC6 固定列の中の結合を縦・横に動かしても崩れず、pane の外へ描き漏れない
//   AC9 columnGroups で見出しが 2 段になり、上の段のクリックは header-click を出さない
//   AC10 setData と setMergedCells の呼ぶ順によらず新しい行に張られ、範囲の上の挿入では動き、中の挿入では捨てる
// 描画の細目（重ね順・罫線の抜き・折り返し・状態表示）は unit（render の base-layer.dd064.test.ts）が担保する。

import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { grantClipboard, readClipboard, writeClipboard } from './integration-helpers';
import * as sa from './standalone-helpers';

const GRID_LINE: [number, number, number] = [0xd4, 0xd4, 0xd4]; // DEFAULT_BASE_COLORS.gridLine
const ANCHOR_BG: [number, number, number] = [0xff, 0xee, 0xaa]; // ?rowbg=r1:ffeeaa
const MERGE = [{ rowId: 'r1', columnId: 'col-b', rowSpan: 3 }];
const MERGE_QUERY = `merged=${encodeURIComponent(JSON.stringify(MERGE))}`;

interface Range4 {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}
/** ブラウザー側の window（standalone-main.ts が公開するもの。e2e は tsc の対象外なので形をここで宣言する）。 */
interface MergeWindow {
  __standalone?: {
    events: Array<{ type: string; phase?: string; code?: string; columnId?: string }>;
    diagnostics: Array<{ code: string }>;
    reinject(data: { rows: Row[] }): void;
    clearSaved(): void;
  };
  __gridInstance?: {
    setData(data: unknown): void;
    setMergedCells(mergedCells: unknown): void;
    insertRows(options: { afterRowId: string | null; count?: number }): void;
  };
  __integrationTestApi?: {
    mergedRanges(): Range4[];
    selectionRange(): Range4 | null;
    headerHeight(): number;
  };
}

function evidencePath(fileName: string): string {
  return fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-064/${fileName}`, import.meta.url));
}

interface Row {
  rowId: string;
  cells?: Record<string, string>;
}

/** 行 r0..r(n-1)。values は rowId → 列 → 値。 */
function rowsOf(count: number, values: Record<string, Record<string, string>> = {}, prefix = 'r'): Row[] {
  return Array.from({ length: count }, (_v, i) => {
    const rowId = `${prefix}${i}`;
    return { rowId, cells: { 'col-a': `行${i}`, ...(values[rowId] ?? {}) } };
  });
}

const SEED_VALUES = { r1: { 'col-b': 'ビル' }, r2: { 'col-b': '隠れる値' }, r4: { 'col-b': '下' } };

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/standalone.html?${query}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
}

/** 行を入れ直す（localStorage の保存モックを消して決定的にする）。 */
async function reinject(page: Page, rows: Row[]): Promise<void> {
  await page.evaluate((r: Row[]) => {
    const w = window as unknown as MergeWindow;
    w.__standalone?.clearSaved();
    w.__standalone?.reinject({ rows: r });
  }, rows);
  await nextFrame(page);
}

async function setMerged(page: Page, merges: unknown): Promise<void> {
  await page.evaluate((m: unknown) => {
    (window as unknown as MergeWindow).__gridInstance?.setMergedCells(m);
  }, merges);
  await nextFrame(page);
}

/** 描画を 2 フレーム待つ（結合を張るのは描画の時）。 */
async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function mergedRanges(page: Page): Promise<Range4[]> {
  return page.evaluate(() => (window as unknown as MergeWindow).__integrationTestApi?.mergedRanges() ?? []);
}

async function diagnosticCodes(page: Page): Promise<string[]> {
  return page.evaluate(() => ((window as unknown as MergeWindow).__standalone?.diagnostics ?? []).map((d) => d.code));
}

/** error イベントの `phase:code`。 */
async function errorEvents(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ((window as unknown as MergeWindow).__standalone?.events ?? [])
      .filter((e) => e.type === 'error')
      .map((e) => `${e.phase ?? ''}:${e.code ?? ''}`),
  );
}

/** クリップボードの text/plain（TSV の行区切り CRLF を LF にそろえる・clipboard.spec.ts と同じ）。 */
async function clipboardText(page: Page): Promise<string> {
  return (await readClipboard(page)).replace(/\r\n/g, '\n');
}

async function clickCell(page: Page, row: number, col: number, options: { shift?: boolean } = {}): Promise<void> {
  const rect = await sa.cellRectAt(page, row, col);
  if (rect === null) {
    throw new Error(`セル (${row},${col}) が無い`);
  }
  await page.locator('.nsheet-scroller').click({
    position: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    ...(options.shift === true ? { modifiers: ['Shift'] } : {}),
  });
}

async function expectActive(page: Page, row: number, col: number): Promise<void> {
  await expect.poll(async () => sa.activeCell(page)).toEqual({ row, col });
}

/** base canvas の矩形（CSS px）の中で target 色（±tol）の画素数。 */
async function countColor(page: Page, rect: sa.CellRect, target: [number, number, number], tol = 6): Promise<number> {
  return page.evaluate(
    ({ r, t, tol }: { r: sa.CellRect; t: [number, number, number]; tol: number }) => {
      const canvas = document.querySelectorAll('.nsheet-stage canvas')[0];
      if (!(canvas instanceof HTMLCanvasElement)) {
        return 0;
      }
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        return 0;
      }
      const d = window.devicePixelRatio;
      const data = ctx.getImageData(
        Math.floor(r.x * d),
        Math.floor(r.y * d),
        Math.max(1, Math.floor(r.width * d)),
        Math.max(1, Math.floor(r.height * d)),
      ).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          data[i + 3]! > 0 &&
          Math.abs(data[i]! - t[0]) <= tol &&
          Math.abs(data[i + 1]! - t[1]) <= tol &&
          Math.abs(data[i + 2]! - t[2]) <= tol
        ) {
          count += 1;
        }
      }
      return count;
    },
    { r: rect, t: target, tol },
  );
}

async function cell(page: Page, row: number, col: number): Promise<sa.CellRect> {
  const rect = await sa.cellRectAt(page, row, col);
  if (rect === null) {
    throw new Error(`セル (${row},${col}) が無い`);
  }
  return rect;
}

test('AC1: 3行×1列の結合が 1 つのセルとして描かれる（範囲の中の横線なし・背景は左上の行のもの）', async ({ page }) => {
  await open(page, `frozenrows=0&frozencols=0&rowbg=r1:ffeeaa&${MERGE_QUERY}`);
  await reinject(page, rowsOf(20, SEED_VALUES));
  expect(await mergedRanges(page)).toEqual([{ rowStart: 1, rowEnd: 4, colStart: 1, colEnd: 2 }]);

  // 行 1 と行 2 の境界（結合の中）にグリッド線が無い。隣の列（結合の外）には有る。
  const inside = await cell(page, 2, 1);
  const outside = await cell(page, 2, 2);
  const lineBand = (r: sa.CellRect) => ({ x: r.x + 4, y: r.y - 1, width: r.width - 8, height: 3 });
  expect(await countColor(page, lineBand(inside), GRID_LINE, 3)).toBe(0);
  expect(await countColor(page, lineBand(outside), GRID_LINE, 3)).toBeGreaterThan(0);

  // 範囲は左上の行（r1）の背景で塗られ、行 2・3 の結合の外（列 2）は塗られない（縞にならない）。
  const lower = await cell(page, 3, 1);
  const lowerOutside = await cell(page, 3, 2);
  const body = (r: sa.CellRect) => ({ x: r.x + 3, y: r.y + 3, width: r.width - 6, height: r.height - 6 });
  expect(await countColor(page, body(lower), ANCHOR_BG)).toBeGreaterThan(100);
  expect(await countColor(page, body(lowerOutside), ANCHOR_BG)).toBe(0);

  // 左上以外の値（隠れる値）は描かず、範囲の中を空として扱わない（cellRenderText は値そのもの＝描画は canvas）。
  expect(await sa.displayCell(page, 'r2', 'col-b')).toBe('隠れる値');
  await page.screenshot({ path: evidencePath('ac1-merged-3x1.png') });
});

test('AC2: 範囲の中のクリックで左上を選び、矢印キー・Tab・Enter で範囲を 1 つのセルとして動く', async ({ page }) => {
  await open(page, `frozenrows=0&frozencols=0&${MERGE_QUERY}`);
  await reinject(page, rowsOf(20, SEED_VALUES));

  await clickCell(page, 3, 1);
  await expectActive(page, 1, 1);
  await page.keyboard.press('ArrowDown');
  await expectActive(page, 4, 1); // 結合の下端の次の行
  await page.keyboard.press('ArrowUp');
  await expectActive(page, 1, 1); // 結合の中へ入ったら左上
  await page.keyboard.press('ArrowRight');
  await expectActive(page, 1, 2);
  await clickCell(page, 2, 2);
  await page.keyboard.press('ArrowLeft');
  await expectActive(page, 1, 1);
  await page.keyboard.press('Tab');
  await expectActive(page, 1, 2);
  await clickCell(page, 1, 1);
  await page.keyboard.press('Enter');
  await expectActive(page, 4, 1);
  await page.keyboard.press('Shift+Enter');
  await expectActive(page, 1, 1);

  // 編集中の Tab（確定して右へ）で結合の中へ入っても左上になる（入力は確定される）。
  await clickCell(page, 2, 0);
  await page.keyboard.type('ok');
  await page.keyboard.press('Tab');
  await expectActive(page, 1, 1);
  await expect.poll(async () => sa.displayCell(page, 'r2', 'col-a')).toBe('ok');
});

test('AC3: 結合範囲は読むだけ（印字キー・F2・Delete・ダブルクリックで文書は変わらず、貼り付けは範囲のセルだけ飛ばす）', async ({
  page,
  context,
}) => {
  await grantClipboard(context);
  await open(page, `frozenrows=0&frozencols=0&${MERGE_QUERY}`);
  await reinject(page, rowsOf(20, SEED_VALUES));

  await clickCell(page, 2, 1);
  await expectActive(page, 1, 1);
  await page.keyboard.type('zz');
  await page.keyboard.press('F2');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  const rect = await cell(page, 2, 1);
  await page.locator('.nsheet-scroller').dblclick({ position: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } });
  expect(await sa.draft(page)).toBe('');
  expect(await sa.displayCell(page, 'r1', 'col-b')).toBe('ビル');
  expect(await diagnosticCodes(page)).toContain('merged-cell-blocked');

  // 3×3 を (0,0) へ貼る → 結合範囲（行 1・2 の列 1）だけ飛ばし、残りへ入る。
  await clickCell(page, 0, 0);
  await writeClipboard(page, 'a\tb\tc\nd\te\tf\ng\th\ti');
  await page.keyboard.press('Control+v');
  await expect.poll(async () => sa.displayCell(page, 'r0', 'col-b')).toBe('b');
  expect(await sa.displayCell(page, 'r1', 'col-a')).toBe('d');
  expect(await sa.displayCell(page, 'r1', 'col-c')).toBe('f');
  expect(await sa.displayCell(page, 'r1', 'col-b')).toBe('ビル');
  expect(await sa.displayCell(page, 'r2', 'col-b')).toBe('隠れる値');
  expect(await diagnosticCodes(page)).toContain('merged-cell-skipped');
});

test('AC4: コピーは左上に値・残りは空。Shift＋矢印の範囲は結合を含むまで広がる', async ({ page, context }) => {
  await grantClipboard(context);
  await open(page, `frozenrows=0&frozencols=0&${MERGE_QUERY}`);
  await reinject(page, rowsOf(20, SEED_VALUES));

  await clickCell(page, 0, 1);
  await page.keyboard.press('Shift+ArrowDown');
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as MergeWindow).__integrationTestApi?.selectionRange() ?? null))
    .toEqual({ rowStart: 0, rowEnd: 4, colStart: 1, colEnd: 2 });
  await page.keyboard.press('Control+c');
  await expect.poll(async () => clipboardText(page)).toBe('\nビル\n\n');

  // 結合だけを選んだ状態（左上のクリック）のコピーも範囲全体（左上に値・残りは空）。
  await clickCell(page, 1, 1);
  await page.keyboard.press('Control+c');
  await expect.poll(async () => clipboardText(page)).toBe('ビル\n\n');
});

test('AC5: 形の誤りは mount で error、setMergedCells の誤り・重なり・未知の行・入れ直しで消えた行は warn', async ({ page }) => {
  const bad = encodeURIComponent(JSON.stringify([{ rowId: 'r1', columnId: 'col-z', rowSpan: 2 }]));
  await page.goto(`/standalone.html?frozenrows=0&merged=${bad}`);
  await expect.poll(async () => errorEvents(page)).toEqual(['config:merged-cells-invalid']);

  await open(page, 'frozenrows=0&frozencols=0');
  await reinject(page, rowsOf(20, SEED_VALUES));
  await setMerged(page, [
    { rowId: 'r1', columnId: 'col-b', rowSpan: 3 },
    { rowId: 'r2', columnId: 'col-b', rowSpan: 2 }, // 先の結合と重なる
    { rowId: 'r5', columnId: 'col-z', rowSpan: 2 }, // 形の誤り（未知の列）
    { rowId: 'missing', columnId: 'col-c', rowSpan: 2 }, // 未知の行
  ]);
  expect(await mergedRanges(page)).toEqual([{ rowStart: 1, rowEnd: 4, colStart: 1, colEnd: 2 }]);
  const codes = await diagnosticCodes(page);
  expect(codes).toContain('merged-cells-invalid');
  expect(codes).toContain('merged-cell-conflict');
  expect(codes).toContain('merged-cell-unresolved');

  // 結合の行を入れ直しで消す → 壊れたとして捨てる。
  await reinject(page, rowsOf(20, SEED_VALUES, 'x'));
  expect(await mergedRanges(page)).toEqual([]);
  expect(await diagnosticCodes(page)).toContain('merged-cell-broken');
});

test('AC6: 固定列の中の結合を縦・横に動かしても崩れず、pane の外（スクロール側・見出し）へ描き漏れない', async ({ page }) => {
  await open(page, `frozenrows=0&frozencols=2&extracols=30&rowbg=r1:ffeeaa&${MERGE_QUERY}`);
  await reinject(page, rowsOf(80, SEED_VALUES)); // 縦にスクロールできる行数
  // アクティブセルはスクロールで隠れない所（固定列の行 10）へ置く（隠れると scroll-follow が戻すため。結合とは無関係）。
  await clickCell(page, 10, 0);
  const before = await cell(page, 3, 1);
  await page.evaluate(() => {
    const scroller = document.querySelector('.nsheet-scroller');
    if (scroller instanceof HTMLElement) {
      scroller.scrollLeft = 600;
      scroller.scrollTop = 30; // 行 0 と行 1 の上 8px が隠れる（結合の上の端が隠れる）
    }
  });
  await nextFrame(page);
  const after = await cell(page, 3, 1);
  expect(after.x).toBe(before.x); // 固定列は横に動かない
  expect(after.y).toBe(before.y - 30);
  expect(await mergedRanges(page)).toEqual([{ rowStart: 1, rowEnd: 4, colStart: 1, colEnd: 2 }]);

  const merged = { x: after.x + 3, y: after.y - 20, width: after.width - 6, height: 40 };
  expect(await countColor(page, merged, ANCHOR_BG)).toBeGreaterThan(100); // 範囲は描かれている
  // 固定列の右（スクロール側）の行 2・3 には左上の行の背景が漏れない。
  const scrollSide = { x: after.x + after.width + 4, y: after.y - 20, width: 60, height: 40 };
  expect(await countColor(page, scrollSide, ANCHOR_BG)).toBe(0);
  // 見出しの帯へ漏れない。
  const header = { x: after.x, y: 0, width: after.width, height: 23 };
  expect(await countColor(page, header, ANCHOR_BG)).toBe(0);
  await page.screenshot({ path: evidencePath('ac6-frozen-scrolled.png') });
});

test('AC9: columnGroups で見出しが 2 段になり、上の段のクリックは header-click を出さない', async ({ page }) => {
  const groups = encodeURIComponent(JSON.stringify([{ caption: '上期', columnIds: ['col-c', 'col-d'] }]));
  await open(page, `frozenrows=0&frozencols=0&colgroups=${groups}`);
  expect(await page.evaluate(() => (window as unknown as MergeWindow).__integrationTestApi?.headerHeight())).toBe(48);
  expect((await cell(page, 0, 0)).y).toBe(48);

  const headerClicks = async () =>
    page.evaluate(() =>
      ((window as unknown as MergeWindow).__standalone?.events ?? [])
        .filter((e) => e.type === 'header-click')
        .map((e) => e.columnId ?? ''),
    );
  const colC = await sa.columnHeaderRectAt(page, 2);
  const colA = await sa.columnHeaderRectAt(page, 0);
  if (colC === null || colA === null) {
    throw new Error('見出しが無い');
  }
  await page.locator('.nsheet-scroller').click({ position: { x: colC.x + colC.width / 2, y: 12 } }); // 上の段（まとまり）
  await page.locator('.nsheet-scroller').click({ position: { x: colC.x + colC.width / 2, y: 36 } }); // 下の段（列）
  await page.locator('.nsheet-scroller').click({ position: { x: colA.x + colA.width / 2, y: 12 } }); // まとめていない列
  await expect.poll(headerClicks).toEqual(['col-c', 'col-a']);

  // 上の段のまとまりの中の境界（col-c と col-d の間）では列幅を変えられない（下の段では変えられる）。
  const box = await page.locator('.nsheet-scroller').boundingBox();
  if (box === null) {
    throw new Error('scroller が無い');
  }
  const boundaryX = box.x + colC.x + colC.width;
  const cursor = async () => page.evaluate(() => (document.querySelector('.nsheet-scroller') as HTMLElement).style.cursor);
  await page.mouse.move(boundaryX, box.y + 12);
  expect(await cursor()).toBe('');
  await page.mouse.move(boundaryX, box.y + 36);
  expect(await cursor()).toBe('col-resize');
  await page.screenshot({ path: evidencePath('ac9-column-groups.png'), clip: { x: 0, y: 0, width: 700, height: 160 } });

  // 形の誤り（隣り合っていない列）は mount で error（column-display-invalid）。
  const bad = encodeURIComponent(JSON.stringify([{ caption: 'x', columnIds: ['col-a', 'col-c'] }]));
  await page.goto(`/standalone.html?colgroups=${bad}`);
  await expect.poll(async () => errorEvents(page)).toEqual(['config:column-display-invalid']);
});

test('AC10: setData と setMergedCells の呼ぶ順によらず新しい行に張られ、範囲の上の挿入では動き、中の挿入では捨てる', async ({ page }) => {
  await open(page, 'frozenrows=0&frozencols=0');
  // 同じ処理の中で setData → setMergedCells。
  await page.evaluate(() => {
    const grid = (window as unknown as MergeWindow).__gridInstance;
    grid?.setData({ rows: Array.from({ length: 10 }, (_v, i) => ({ rowId: `a${i}`, cells: { 'col-a': `a${i}` } })) });
    grid?.setMergedCells([{ rowId: 'a2', columnId: 'col-a', rowSpan: 2 }]);
  });
  await nextFrame(page);
  expect(await mergedRanges(page)).toEqual([{ rowStart: 2, rowEnd: 4, colStart: 0, colEnd: 1 }]);

  // 逆の順（setMergedCells → setData）でも、新しい行に張られる（古い行の並びで張らない・warn も出さない）。
  const before = (await diagnosticCodes(page)).length;
  await page.evaluate(() => {
    const grid = (window as unknown as MergeWindow).__gridInstance;
    grid?.setMergedCells([{ rowId: 'b5', columnId: 'col-b', rowSpan: 3 }]);
    grid?.setData({ rows: Array.from({ length: 10 }, (_v, i) => ({ rowId: `b${i}`, cells: { 'col-a': `b${i}` } })) });
  });
  await nextFrame(page);
  expect(await mergedRanges(page)).toEqual([{ rowStart: 5, rowEnd: 8, colStart: 1, colEnd: 2 }]);
  expect((await diagnosticCodes(page)).slice(before).filter((c) => c.startsWith('merged-cell'))).toEqual([]);

  // 範囲の上に行を入れる → 範囲は 1 行下へ動き、結合の左上を選んでいたアクティブセルも結合と一緒に動く
  // （再ベースの正規化が古い結合の位置で左上を選んで、挿入された行へ寄せない）。範囲の中に入れる → 壊れたとして捨てる。
  await clickCell(page, 6, 1);
  await expectActive(page, 5, 1);
  await page.evaluate(() => (window as unknown as MergeWindow).__gridInstance?.insertRows({ afterRowId: 'b0' }));
  await nextFrame(page);
  expect(await mergedRanges(page)).toEqual([{ rowStart: 6, rowEnd: 9, colStart: 1, colEnd: 2 }]);
  await expectActive(page, 6, 1);
  await page.evaluate(() => (window as unknown as MergeWindow).__gridInstance?.insertRows({ afterRowId: 'b6' }));
  await nextFrame(page);
  expect(await mergedRanges(page)).toEqual([]);
  expect(await diagnosticCodes(page)).toContain('merged-cell-broken');
});
