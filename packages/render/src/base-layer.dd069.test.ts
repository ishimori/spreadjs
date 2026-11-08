// DD-069 unit: セルごとの背景色（cellBackgroundsInRow フック）の塗り方と重ね順。
// 列 → 行 → セル → 状態表示・値ベース書式の背景 → 罫線 → 文字の順で、結合範囲は左上のセルの背景で描き直す。

import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId, type ColumnId, type RowId } from '@nanairo-sheet/types';
import { createMergeIndex, type CellRange } from '@nanairo-sheet/selection';

import { createAxis } from './axis';
import type { CellBackgroundMark } from './background-bands';
import { CELL_STATUS_COLORS, createBaseLayer, DEFAULT_BASE_COLORS, type CellStatusMark } from './base-layer';
import { createChunkStore } from './chunk-store';
import { createViewportTransform } from './viewport';

type Call =
  | { readonly kind: 'fillRect'; readonly style: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  | { readonly kind: 'stroke'; readonly style: string }
  | { readonly kind: 'fillText'; readonly style: string; readonly text: string };
type FillRect = Extract<Call, { kind: 'fillRect' }>;

function createCtxStub(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  let fillStyle = '';
  const noop = (): void => {};
  const ctx = {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      // Canvas 2D と同じく、構文不正な色の代入は無視して直前値を保つ。
      if (value !== 'not-a-color') fillStyle = String(value);
    },
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    rect: noop,
    clip: noop,
    moveTo: noop,
    lineTo: noop,
    arcTo: noop,
    fill: noop,
    clearRect: noop,
    measureText: (text: string) => ({ width: text.length * 7 }),
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ kind: 'fillRect', style: String(this.fillStyle), x, y, w, h });
    },
    stroke() {
      calls.push({ kind: 'stroke', style: String(this.strokeStyle) });
    },
    fillText(text: string) {
      calls.push({ kind: 'fillText', style: String(this.fillStyle), text });
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
const COLUMN_COLOR = '#dbeafe';
const ROW_COLOR = '#e5e7eb';
const CELL_COLOR = '#e6eaee';
const VALUE_BG = '#00ff00';
const ERROR = CELL_STATUS_COLORS.error;

function setup(options: {
  backgrounds: Readonly<Record<number, readonly CellBackgroundMark[]>>;
  statuses?: Readonly<Record<number, readonly CellStatusMark[]>>;
  values?: Readonly<Record<string, string>>;
  frozenRowCount?: number;
  frozenColCount?: number;
  merges?: readonly CellRange[];
}): Call[] {
  const { ctx, calls } = createCtxStub();
  const store = createChunkStore();
  for (const [key, value] of Object.entries(options.values ?? {})) {
    const [row, col] = key.split(',').map(Number);
    store.set(row!, col!, value);
  }
  const rowAxis = createAxis<RowId>({ ids: Array.from({ length: 10 }, (_v, i) => createRowId(`r${i}`)), defaultSize: ROW_H });
  const colAxis = createAxis<ColumnId>({ ids: Array.from({ length: 6 }, (_v, i) => createColumnId(`c${i}`)), defaultSize: COL_W });
  const frozenRowCount = options.frozenRowCount ?? 0;
  const frozenColCount = options.frozenColCount ?? 0;
  const { backgrounds, statuses } = options;
  const mergeIndex = options.merges === undefined ? undefined : createMergeIndex(options.merges);
  const layer = createBaseLayer({
    ctx,
    store,
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    frozenColCount,
    columnBackground: (col) => (col === 1 ? COLUMN_COLOR : undefined),
    rowBackground: (row) => (row === 2 ? ROW_COLOR : undefined),
    cellBackgroundsInRow: (row) => backgrounds[row],
    getCellStyle: (_col, value) => (value === 'HIT' ? { cellBackground: VALUE_BG } : undefined),
    ...(statuses !== undefined ? { cellStatusesInRow: (row: number) => statuses[row] } : {}),
    ...(mergeIndex !== undefined ? { mergedRanges: () => mergeIndex } : {}),
  });
  const transform = createViewportTransform({
    rowAxis,
    colAxis,
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    frozenRowCount,
    frozenColCount,
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
const fills = (calls: readonly Call[], style: string): FillRect[] =>
  calls.filter((c): c is FillRect => c.kind === 'fillRect' && c.style === style);
const indexOf = (calls: readonly Call[], match: (c: Call) => boolean): number => calls.findIndex(match);

describe('DD-069: セルごとの背景色（cellBackgroundsInRow）', () => {
  it('指定したセルだけをセル全体で塗る（空のセルにも付く）', () => {
    const calls = setup({ backgrounds: { 3: [{ colIndex: 2, color: CELL_COLOR }, { colIndex: 4, color: CELL_COLOR }] } });
    expect(fills(calls, CELL_COLOR)).toEqual([
      { kind: 'fillRect', style: CELL_COLOR, x: cellX(2), y: cellY(3), w: COL_W, h: ROW_H },
      { kind: 'fillRect', style: CELL_COLOR, x: cellX(4), y: cellY(3), w: COL_W, h: ROW_H },
    ]);
  });

  it('列の帯 → 行の帯 → セルの背景 → 状態表示の背景 → 罫線 → 文字の順に塗る（交差は後が勝つ）', () => {
    const calls = setup({
      backgrounds: { 2: [{ colIndex: 1, color: CELL_COLOR }] },
      statuses: { 2: [{ colIndex: 1, level: 'error' }] },
      values: { '2,1': 'v' },
    });
    const column = indexOf(calls, (c) => c.kind === 'fillRect' && c.style === COLUMN_COLOR);
    const row = indexOf(calls, (c) => c.kind === 'fillRect' && c.style === ROW_COLOR);
    const cell = indexOf(calls, (c) => c.kind === 'fillRect' && c.style === CELL_COLOR);
    const status = indexOf(calls, (c) => c.kind === 'fillRect' && c.style === ERROR.background);
    const stroke = indexOf(calls, (c) => c.kind === 'stroke');
    const text = indexOf(calls, (c) => c.kind === 'fillText' && c.text === 'v');
    expect(column).toBeGreaterThanOrEqual(0);
    expect(row).toBeGreaterThan(column);
    expect(cell).toBeGreaterThan(row);
    expect(status).toBeGreaterThan(cell);
    expect(stroke).toBeGreaterThan(status);
    expect(text).toBeGreaterThan(stroke);
  });

  it('値ベース書式の背景は、セルの背景の上に塗る（状態表示の無いセル）', () => {
    const calls = setup({ backgrounds: { 4: [{ colIndex: 3, color: CELL_COLOR }] }, values: { '4,3': 'HIT' } });
    const cell = indexOf(calls, (c) => c.kind === 'fillRect' && c.style === CELL_COLOR);
    const value = indexOf(calls, (c) => c.kind === 'fillRect' && c.style === VALUE_BG);
    expect(cell).toBeGreaterThanOrEqual(0);
    expect(value).toBeGreaterThan(cell);
  });

  it('固定行・固定列の中のセルにも塗り、pane の境界で同じセルを二重に塗らない', () => {
    const calls = setup({
      frozenRowCount: 1,
      frozenColCount: 1,
      backgrounds: {
        0: [{ colIndex: 0, color: CELL_COLOR }, { colIndex: 3, color: CELL_COLOR }], // corner と top
        4: [{ colIndex: 0, color: CELL_COLOR }, { colIndex: 2, color: CELL_COLOR }], // left と body
      },
    });
    expect(fills(calls, CELL_COLOR).map((c) => [c.x, c.y])).toEqual(
      expect.arrayContaining([
        [cellX(0), cellY(0)],
        [cellX(3), cellY(0)],
        [cellX(0), cellY(4)],
        [cellX(2), cellY(4)],
      ]),
    );
    expect(fills(calls, CELL_COLOR)).toHaveLength(4);
  });

  it('不正な色のセルは、前のセルの色を引き継がずに pane の背景で塗る', () => {
    const calls = setup({ backgrounds: { 5: [{ colIndex: 2, color: CELL_COLOR }, { colIndex: 3, color: 'not-a-color' }] } });
    const atNext = calls.filter((c): c is FillRect => c.kind === 'fillRect' && c.x === cellX(3) && c.y === cellY(5) && c.h === ROW_H);
    expect(atNext.map((c) => c.style)).toEqual([DEFAULT_BASE_COLORS.cellBackground]);
    expect(fills(calls, CELL_COLOR)).toHaveLength(1);
  });

  it('結合範囲は左上のセルの背景で、範囲の矩形 1 つとして描き直す', () => {
    const calls = setup({
      backgrounds: { 6: [{ colIndex: 3, color: CELL_COLOR }] },
      merges: [{ rowStart: 6, rowEnd: 8, colStart: 3, colEnd: 4 }],
    });
    // 罫線を残すため、左・上の 1px（グリッド線）の内側から塗る。
    expect(fills(calls, CELL_COLOR)).toContainEqual({
      kind: 'fillRect',
      style: CELL_COLOR,
      x: cellX(3) + 1,
      y: cellY(6) + 1,
      w: COL_W - 1,
      h: ROW_H * 2 - 1,
    });
  });
});
