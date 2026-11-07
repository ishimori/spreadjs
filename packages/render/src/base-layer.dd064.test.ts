// DD-064 unit: 結合範囲の描画（範囲の中を飛ばす・はみ出しを止める・1 つのセルとして描き直す）・罫線層の抜き・2段の見出し。

import { describe, expect, it } from 'vitest';

import { createMergeIndex, type CellRange, type MergeIndex } from '@nanairo-sheet/selection';
import { createColumnId, createRowId, type ColumnId, type RowId } from '@nanairo-sheet/types';

import { createAxis } from './axis';
import { CELL_STATUS_COLORS, createBaseLayer, mergedCellRect, type CellStatusMark, type ColumnGroupBand } from './base-layer';
import { subtractIntervals, type BoundaryBorder } from './border-layer';
import { createChunkStore } from './chunk-store';
import { createViewportTransform } from './viewport';

type Call =
  | { readonly kind: 'fillRect'; readonly style: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  | { readonly kind: 'fillText'; readonly style: string; readonly text: string; readonly x: number; readonly y: number }
  | { readonly kind: 'line'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number };

function createCtxStub(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  let fillStyle = '';
  let cursor = { x: 0, y: 0 };
  const ctx = {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      fillStyle = String(value);
    },
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    rect: () => {},
    clip: () => {},
    moveTo(x: number, y: number) {
      cursor = { x, y };
    },
    lineTo(x: number, y: number) {
      calls.push({ kind: 'line', x1: cursor.x, y1: cursor.y, x2: x, y2: y });
      cursor = { x, y };
    },
    arcTo: () => {},
    fill: () => {},
    stroke: () => {},
    clearRect: () => {},
    setLineDash: () => {},
    measureText: (text: string) => ({ width: text.length * 7 }),
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ kind: 'fillRect', style: String(this.fillStyle), x, y, w, h });
    },
    fillText(text: string, x: number, y: number) {
      calls.push({ kind: 'fillText', style: String(this.fillStyle), text, x, y });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const HEADER_W = 52;
const HEADER_H = 24;
const ROW_H = 22;
const COL_W = 80;
const VIEW_W = 600;
const VIEW_H = 300;
const PANE_BG = '#ffffff'; // DEFAULT_BASE_COLORS.cellBackground（body pane）

const range = (rowStart: number, rowEnd: number, colStart: number, colEnd: number): CellRange => ({
  rowStart,
  rowEnd,
  colStart,
  colEnd,
});

function setup(options: {
  merges?: readonly CellRange[];
  values?: Readonly<Record<string, string>>;
  rowBackground?: (row: number) => string | undefined;
  statuses?: Readonly<Record<number, readonly CellStatusMark[]>>;
  rowBorder?: (boundaryIndex: number) => BoundaryBorder | undefined;
  groups?: ColumnGroupBand;
  headerHeight?: number;
  isWrapColumn?: (col: number) => boolean;
}): Call[] {
  const { ctx, calls } = createCtxStub();
  const store = createChunkStore();
  for (const [key, value] of Object.entries(options.values ?? {})) {
    const [row, col] = key.split(',').map(Number);
    store.set(row!, col!, value);
  }
  const headerHeight = options.headerHeight ?? HEADER_H;
  const rowAxis = createAxis<RowId>({ ids: Array.from({ length: 10 }, (_v, i) => createRowId(`r${i}`)), defaultSize: ROW_H });
  const colAxis = createAxis<ColumnId>({ ids: Array.from({ length: 6 }, (_v, i) => createColumnId(`c${i}`)), defaultSize: COL_W });
  const mergeIndex: MergeIndex | undefined = options.merges === undefined ? undefined : createMergeIndex(options.merges);
  const statuses = options.statuses;
  const layer = createBaseLayer({
    ctx,
    store,
    headerWidth: HEADER_W,
    headerHeight,
    frozenColCount: 0,
    ...(mergeIndex !== undefined ? { mergedRanges: () => mergeIndex } : {}),
    ...(options.rowBackground !== undefined ? { rowBackground: options.rowBackground } : {}),
    ...(statuses !== undefined ? { cellStatusesInRow: (row: number) => statuses[row] } : {}),
    ...(options.rowBorder !== undefined ? { rowBorder: options.rowBorder } : {}),
    ...(options.groups !== undefined ? { columnGroupBand: options.groups } : {}),
    ...(options.isWrapColumn !== undefined ? { isWrapColumn: options.isWrapColumn } : {}),
  });
  const transform = createViewportTransform({
    rowAxis,
    colAxis,
    headerWidth: HEADER_W,
    headerHeight,
    frozenRowCount: 0,
    frozenColCount: 0,
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    scrollLeft: 0,
    scrollTop: 0,
    overscanX: 0,
    overscanY: 0,
  });
  layer.draw({ transform, viewportWidth: VIEW_W, viewportHeight: VIEW_H, dpr: 1 });
  return calls;
}

const cellX = (col: number): number => HEADER_W + col * COL_W;
const cellY = (row: number): number => HEADER_H + row * ROW_H;
const texts = (calls: readonly Call[]): Array<Extract<Call, { kind: 'fillText' }>> =>
  calls.filter((c): c is Extract<Call, { kind: 'fillText' }> => c.kind === 'fillText');
const fills = (calls: readonly Call[], style: string): Array<Extract<Call, { kind: 'fillRect' }>> =>
  calls.filter((c): c is Extract<Call, { kind: 'fillRect' }> => c.kind === 'fillRect' && c.style === style);

describe('DD-064: 結合範囲の描画', () => {
  it('3行×1列の結合: 範囲の中を pane 背景で覆い（左・上の罫線を残す 1px 内側から）、左上の値を範囲の縦の中央に 1 回だけ描く', () => {
    const calls = setup({
      merges: [range(1, 4, 1, 2)],
      values: { '1,1': 'ビル', '2,1': '隠れる値', '1,2': '隣' },
    });
    // 範囲を覆う塗り（グリッド線を描いた後）＝範囲の中の横線は見えない。
    const cover = fills(calls, PANE_BG).filter((c) => c.x === cellX(1) + 1 && c.y === cellY(1) + 1);
    expect(cover).toEqual([{ kind: 'fillRect', style: PANE_BG, x: cellX(1) + 1, y: cellY(1) + 1, w: COL_W - 1, h: ROW_H * 3 - 1 }]);
    const drawn = texts(calls).map((c) => c.text);
    expect(drawn.filter((t) => t === 'ビル')).toHaveLength(1);
    expect(drawn).not.toContain('隠れる値'); // 左上以外の値は描かない
    expect(drawn).toContain('隣');
    const anchor = texts(calls).find((c) => c.text === 'ビル')!;
    expect(anchor.y).toBe(cellY(1) + (ROW_H * 3) / 2);
  });

  it('結合範囲の文字は範囲の中だけ（右隣が空でもはみ出さず … で切る）。左のセルの文字も結合の手前で止まる', () => {
    const long = 'あいうえおかきくけこさしすせそ'; // 15 文字 × 7px = 105px（列幅 80 − 余白 10 に収まらない）
    const calls = setup({
      merges: [range(0, 2, 2, 3)],
      values: { '0,2': long, '1,1': long },
    });
    const drawn = texts(calls).map((c) => c.text);
    // 結合の左上: 右隣（列 3）は空でもはみ出さない＝ … で切った文字。
    expect(drawn.some((t) => t.endsWith('…') && t.length < long.length)).toBe(true);
    // 列 1 の行 1: 右隣の列 2 は結合範囲（空セルとして扱わない）→ 結合の手前で … で切る（全文を描かない）。
    expect(drawn.filter((t) => t === long)).toHaveLength(0);
  });

  it('背景は左上の行のもの（範囲の中の別の行の背景で縞にならない）', () => {
    const calls = setup({
      merges: [range(1, 4, 0, 1)],
      values: { '1,0': 'x' },
      rowBackground: (row) => (row === 1 ? '#ffeeee' : row === 2 ? '#eeeeff' : undefined),
    });
    const cover = fills(calls, '#ffeeee').filter((c) => c.x === cellX(0) + 1);
    expect(cover).toEqual([{ kind: 'fillRect', style: '#ffeeee', x: cellX(0) + 1, y: cellY(1) + 1, w: COL_W - 1, h: ROW_H * 3 - 1 }]);
  });

  it('状態表示は左上のセルのものを範囲全体に描く（背景と内側の枠）', () => {
    const calls = setup({
      merges: [range(1, 3, 1, 2)],
      values: { '1,1': 'x' },
      statuses: { 1: [{ colIndex: 1, level: 'error' }] },
    });
    const background = fills(calls, CELL_STATUS_COLORS.error.background).filter((c) => c.h === ROW_H * 2 - 1);
    expect(background).toHaveLength(1);
    const frame = fills(calls, CELL_STATUS_COLORS.error.frame);
    // 結合の枠: 上・下・左・右の 4 本。下の辺は範囲の下端（行 3 の上端）の手前。
    const bottomEdge = frame.find((c) => c.w === COL_W - 1 && c.y + c.h === cellY(3));
    expect(bottomEdge).toBeDefined();
  });

  it('折り返しの列でも範囲の幅で折り返して描く（範囲を 1 つのセルとして扱う）', () => {
    const calls = setup({
      merges: [range(0, 3, 0, 2)],
      values: { '0,0': 'あいうえおかきくけこさしすせそたちつてとなに' }, // 22 文字 × 7 = 154px（範囲 160 − 10 に収まらない）
      isWrapColumn: (col) => col === 0,
    });
    const lines = texts(calls).filter((c) => c.x === cellX(0) + 5);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]!.y).toBe(cellY(0) + 5 + 8); // 2 行以上は上から（CELL_TEXT_PADDING + 行高の半分）
  });

  it('結合が無ければ追加の描画をしない（現行と同じ呼び出し列）', () => {
    const plain = setup({ values: { '1,1': 'ビル' } });
    const empty = setup({ merges: [], values: { '1,1': 'ビル' } });
    expect(empty).toEqual(plain);
  });

  it('mergedCellRect は左上から右下までの矩形', () => {
    const rowAxis = createAxis<RowId>({ ids: [createRowId('a'), createRowId('b'), createRowId('c')], defaultSize: ROW_H });
    const colAxis = createAxis<ColumnId>({ ids: [createColumnId('x'), createColumnId('y')], defaultSize: COL_W });
    const transform = createViewportTransform({
      rowAxis,
      colAxis,
      headerWidth: HEADER_W,
      headerHeight: HEADER_H,
      frozenRowCount: 0,
      frozenColCount: 0,
      viewportWidth: VIEW_W,
      viewportHeight: VIEW_H,
      scrollLeft: 0,
      scrollTop: 0,
      overscanX: 0,
      overscanY: 0,
    });
    expect(mergedCellRect(transform, range(1, 3, 0, 2))).toEqual({ x: HEADER_W, y: HEADER_H + ROW_H, width: COL_W * 2, height: ROW_H * 2 });
  });
});

describe('DD-064: 罫線層は結合範囲の中を通る区間を描かない', () => {
  it('全行の下端の線（defaultRowBorder 相当）は、結合の中の行の境界では範囲の幅だけ抜ける', () => {
    const color = '#123456';
    const calls = setup({
      merges: [range(0, 3, 1, 2)],
      rowBorder: (boundary) => (boundary > 0 ? { color, width: 1 } : undefined),
    });
    const lines = fills(calls, color);
    // 境界 1・2（結合の中）は 2 本に分かれ、列 1（x=132..212）を通らない。境界 3（結合の下端）は全幅のまま。
    const at = (boundary: number) => lines.filter((c) => c.y === cellY(boundary));
    // 線の右端はデータ領域の右端（6 列の右端＝cellX(6)。ビューポートの右端ではない）。
    expect(at(1).map((c) => [c.x, c.x + c.w])).toEqual([
      [HEADER_W, cellX(1)],
      [cellX(2), cellX(6)],
    ]);
    expect(at(2)).toHaveLength(2);
    expect(at(3).map((c) => [c.x, c.x + c.w])).toEqual([[HEADER_W, cellX(6)]]);
  });

  it('点線も結合の中の点を描かない', () => {
    const color = '#654321';
    const calls = setup({
      merges: [range(0, 3, 0, 6)],
      rowBorder: (boundary) => (boundary === 1 ? { color, width: 1, style: 'dotted' } : undefined),
    });
    // 結合が全列にまたがるので、境界 1 の点は 1 つも描かれない。
    expect(fills(calls, color)).toEqual([]);
  });

  it('subtractIntervals は残りの区間を昇順で返す', () => {
    expect(subtractIntervals(0, 100, [])).toEqual([[0, 100]]);
    expect(subtractIntervals(0, 100, [[60, 80], [10, 20]])).toEqual([
      [0, 10],
      [20, 60],
      [80, 100],
    ]);
    expect(subtractIntervals(0, 100, [[0, 100]])).toEqual([]);
    expect(subtractIntervals(0, 100, [[-5, 30], [90, 120]])).toEqual([[30, 90]]);
  });
});

describe('DD-064 K4: 2段の見出し', () => {
  const groups: ColumnGroupBand = { height: 24, groups: [{ colStart: 2, colEnd: 4, caption: '上期' }] };

  it('まとめた列は下の段、まとめていない列は 2 段ぶんの中央、まとまりの名前は上の段のまとまりの中央', () => {
    const calls = setup({ groups, headerHeight: 48 });
    const label = (text: string) => texts(calls).find((c) => c.text === text)!;
    expect(label('A').y).toBe(24); // まとめていない列: 48 の中央
    expect(label('C').y).toBe(24 + 12); // まとめた列: 下の段の中央
    expect(label('D').y).toBe(36);
    const caption = label('上期');
    expect(caption.y).toBe(12);
    expect(caption.x).toBe(cellX(2) + COL_W); // 列 2〜3 の中央
  });

  it('まとまりの下と左右に区切りの線を引く（上の段だけ）', () => {
    const calls = setup({ groups, headerHeight: 48 });
    const lines = calls.filter((c): c is Extract<Call, { kind: 'line' }> => c.kind === 'line');
    expect(lines).toContainEqual({ kind: 'line', x1: cellX(2), y1: 24.5, x2: cellX(4), y2: 24.5 });
    expect(lines).toContainEqual({ kind: 'line', x1: cellX(2) + 0.5, y1: 0, x2: cellX(2) + 0.5, y2: 24 });
    expect(lines).toContainEqual({ kind: 'line', x1: cellX(4) + 0.5, y1: 0, x2: cellX(4) + 0.5, y2: 24 });
  });

  it('まとまりが無ければ見出しは 1 段（現行と同じ）', () => {
    const plain = setup({});
    const empty = setup({ groups: { height: 24, groups: [] } });
    expect(empty).toEqual(plain);
  });
});
