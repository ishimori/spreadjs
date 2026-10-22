// DD-060 unit: セルの状態表示（cellStatusesInRow フック）の背景・内側の枠の描画と合成順。

import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId, type ColumnId, type RowId } from '@nanairo-sheet/types';

import { createAxis } from './axis';
import { CELL_STATUS_COLORS, createBaseLayer, type CellStatusMark } from './base-layer';
import type { BoundaryBorder } from './border-layer';
import { createChunkStore } from './chunk-store';
import { createViewportTransform } from './viewport';

type Call =
  | { readonly kind: 'fillRect'; readonly style: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  | { readonly kind: 'stroke'; readonly style: string }
  | { readonly kind: 'fillText'; readonly style: string; readonly text: string };

function createCtxStub(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  let fillStyle = '';
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
    moveTo: () => {},
    lineTo: () => {},
    arcTo: () => {},
    fill: () => {},
    clearRect: () => {},
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
const ROW_COLOR = '#e5e7eb';
const VALUE_BG = '#00ff00';
const ERROR = CELL_STATUS_COLORS.error;
const WARNING = CELL_STATUS_COLORS.warning;

type FillRect = Extract<Call, { kind: 'fillRect' }>;

function setup(options: {
  statuses?: Readonly<Record<number, readonly CellStatusMark[]>>;
  values?: Readonly<Record<string, string>>;
  dpr?: number;
  frozenRowCount?: number;
  frozenColCount?: number;
  rowBorder?: (boundaryIndex: number) => BoundaryBorder | undefined;
  columnBorder?: (boundaryIndex: number) => BoundaryBorder | undefined;
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
  const statuses = options.statuses;
  const layer = createBaseLayer({
    ctx,
    store,
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    frozenColCount,
    rowBackground: (row) => (row === 2 ? ROW_COLOR : undefined),
    getCellStyle: (_col, value) => (value === 'HIT' ? { cellBackground: VALUE_BG } : undefined),
    ...(statuses !== undefined ? { cellStatusesInRow: (row: number) => statuses[row] } : {}),
    ...(options.rowBorder !== undefined ? { rowBorder: options.rowBorder } : {}),
    ...(options.columnBorder !== undefined ? { columnBorder: options.columnBorder } : {}),
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
  layer.draw({ transform, viewportWidth: VIEW_W, viewportHeight: VIEW_H, dpr: options.dpr ?? 1 });
  return calls;
}

const cellX = (col: number): number => HEADER_W + col * COL_W;
const cellY = (row: number): number => HEADER_H + row * ROW_H;
const fills = (calls: readonly Call[], style: string): FillRect[] =>
  calls.filter((c): c is FillRect => c.kind === 'fillRect' && c.style === style);

describe('DD-060: セルの状態表示（cellStatusesInRow）', () => {
  it('error は薄赤の背景をセル全体に、赤の枠を罫線の内側に 2px で描く（空のセルにも付く）', () => {
    const calls = setup({ statuses: { 3: [{ colIndex: 2, level: 'error' }] } });
    const backgrounds = fills(calls, ERROR.background);
    expect(backgrounds).toEqual([{ kind: 'fillRect', style: ERROR.background, x: cellX(2), y: cellY(3), w: COL_W, h: ROW_H }]);
    // 枠: 上・下・左・右の 4 本。左上の罫線（1px）の内側から、右下の罫線（隣のセルの左上の罫線）の手前まで。
    const left = cellX(2) + 1;
    const top = cellY(3) + 1;
    const right = cellX(3);
    const bottom = cellY(4);
    expect(fills(calls, ERROR.frame)).toEqual([
      { kind: 'fillRect', style: ERROR.frame, x: left, y: top, w: right - left, h: 2 },
      { kind: 'fillRect', style: ERROR.frame, x: left, y: bottom - 2, w: right - left, h: 2 },
      { kind: 'fillRect', style: ERROR.frame, x: left, y: top, w: 2, h: bottom - top },
      { kind: 'fillRect', style: ERROR.frame, x: right - 2, y: top, w: 2, h: bottom - top },
    ]);
  });

  it('warning は橙の枠と薄黄の背景で描き、error と混ざらない', () => {
    const calls = setup({ statuses: { 1: [{ colIndex: 0, level: 'warning' }, { colIndex: 4, level: 'error' }] } });
    expect(fills(calls, WARNING.background)).toEqual([
      { kind: 'fillRect', style: WARNING.background, x: cellX(0), y: cellY(1), w: COL_W, h: ROW_H },
    ]);
    expect(fills(calls, WARNING.frame)).toHaveLength(4);
    expect(fills(calls, WARNING.frame).every((c) => c.x >= cellX(0) && c.x + c.w <= cellX(1))).toBe(true);
    expect(fills(calls, ERROR.background)).toEqual([
      { kind: 'fillRect', style: ERROR.background, x: cellX(4), y: cellY(1), w: COL_W, h: ROW_H },
    ]);
  });

  it('行背景 → 状態の背景 → 罫線 → 文字 → 枠の順に描き、値の書式の背景は状態のあるセルでは塗らない', () => {
    const calls = setup({
      statuses: { 2: [{ colIndex: 1, level: 'error' }] },
      values: { '2,1': 'HIT', '2,3': 'HIT' },
    });
    const rowBand = calls.findIndex((c) => c.kind === 'fillRect' && c.style === ROW_COLOR);
    const statusBg = calls.findIndex((c) => c.kind === 'fillRect' && c.style === ERROR.background);
    const stroke = calls.findIndex((c) => c.kind === 'stroke');
    const text = calls.findIndex((c) => c.kind === 'fillText' && c.text === 'HIT');
    const frame = calls.findIndex((c) => c.kind === 'fillRect' && c.style === ERROR.frame);
    expect(rowBand).toBeGreaterThanOrEqual(0);
    expect(statusBg).toBeGreaterThan(rowBand);
    expect(stroke).toBeGreaterThan(statusBg);
    expect(text).toBeGreaterThan(stroke);
    expect(frame).toBeGreaterThan(text);
    // 値の書式の背景（HIT）は状態のない (2,3) にだけ塗られ、状態のある (2,1) の背景を上書きしない。
    const valueBgs = fills(calls, VALUE_BG);
    expect(valueBgs).toHaveLength(1);
    expect(valueBgs[0]!.x).toBeGreaterThanOrEqual(cellX(3));
    // 状態のあるセルの文字も描かれる。
    expect(calls.filter((c) => c.kind === 'fillText' && c.text === 'HIT')).toHaveLength(2);
  });

  it('固定行・固定列の中のセルにも描き、pane の境界で重複して描かない', () => {
    const calls = setup({
      frozenRowCount: 1,
      frozenColCount: 1,
      statuses: {
        0: [{ colIndex: 0, level: 'error' }, { colIndex: 3, level: 'warning' }], // corner と top
        4: [{ colIndex: 0, level: 'warning' }, { colIndex: 2, level: 'error' }], // left と body
      },
    });
    expect(fills(calls, ERROR.background).map((c) => [c.x, c.y])).toEqual(
      expect.arrayContaining([
        [cellX(0), cellY(0)],
        [cellX(2), cellY(4)],
      ]),
    );
    expect(fills(calls, ERROR.background)).toHaveLength(2);
    expect(fills(calls, WARNING.background)).toHaveLength(2);
    expect(fills(calls, ERROR.frame)).toHaveLength(8);
    expect(fills(calls, WARNING.frame)).toHaveLength(8);
  });

  it('DPR 1.5 でも枠は実画素の境界にそろい、太さは 3 device px（2 CSS px）', () => {
    const dpr = 1.5;
    const calls = setup({ dpr, statuses: { 3: [{ colIndex: 1, level: 'error' }] } });
    const frame = fills(calls, ERROR.frame);
    expect(frame).toHaveLength(4);
    for (const bar of frame) {
      for (const v of [bar.x, bar.y, bar.x + bar.w, bar.y + bar.h]) {
        expect(Math.abs(v * dpr - Math.round(v * dpr))).toBeLessThan(1e-9);
      }
    }
    expect(Math.round(frame[0]!.h * dpr)).toBe(3);
    // 外周は罫線（device 1px）の内側から始まる。
    expect(Math.round(frame[0]!.x * dpr)).toBe(Math.round(cellX(1) * dpr) + 1);
    expect(Math.round(frame[0]!.y * dpr)).toBe(Math.round(cellY(3) * dpr) + 1);
  });

  it('指定罫線（rowBorders/columnBorders）が太いセルでは、その罫線帯の内端から枠を描く（罫線に上書きされない・Codex P2）', () => {
    // 罫線帯は borderBand と同じく境界の device px から floor(幅/2) 手前で始まり、幅ぶん続く。
    // 左上の境界（列 2・行 3）は 8px、右の境界（列 3）は 3px、下の境界（行 4）は指定なし（グリッド線 1px）。
    const calls = setup({
      statuses: { 3: [{ colIndex: 2, level: 'error' }] },
      columnBorder: (index) => (index === 2 ? { color: '#000', width: 8 } : index === 3 ? { color: '#000', width: 3 } : undefined),
      rowBorder: (index) => (index === 3 ? { color: '#000', width: 8 } : undefined),
    });
    const left = cellX(2) - 4 + 8; // 8px 帯の右端
    const top = cellY(3) - 4 + 8;
    const right = cellX(3) - 1; // 3px 帯の左端（floor(3/2)=1 手前）
    const bottom = cellY(4); // グリッド線（1px）は境界の device px から下へ
    expect(fills(calls, ERROR.frame)).toEqual([
      { kind: 'fillRect', style: ERROR.frame, x: left, y: top, w: right - left, h: 2 },
      { kind: 'fillRect', style: ERROR.frame, x: left, y: bottom - 2, w: right - left, h: 2 },
      { kind: 'fillRect', style: ERROR.frame, x: left, y: top, w: 2, h: bottom - top },
      { kind: 'fillRect', style: ERROR.frame, x: right - 2, y: top, w: 2, h: bottom - top },
    ]);
  });

  it('罫線帯でセルの内側が埋まるほど細いセルでは枠を描かない（背景は描く）', () => {
    const calls = setup({
      statuses: { 3: [{ colIndex: 2, level: 'warning' }] },
      rowBorder: (index) => (index === 3 || index === 4 ? { color: '#000', width: 24 } : undefined),
    });
    expect(fills(calls, WARNING.frame)).toEqual([]);
    expect(fills(calls, WARNING.background)).toHaveLength(1);
  });

  it('可視範囲外の行・列の印は描かない', () => {
    const calls = setup({ statuses: { 3: [{ colIndex: 99, level: 'error' }], 999: [{ colIndex: 1, level: 'error' }] } });
    expect(fills(calls, ERROR.background)).toEqual([]);
    expect(fills(calls, ERROR.frame)).toEqual([]);
  });

  it('フック未指定なら状態の色は一切描かれない（現行描画と同じ）', () => {
    const calls = setup({ values: { '2,1': 'HIT' } });
    for (const color of [ERROR.background, ERROR.frame, WARNING.background, WARNING.frame]) {
      expect(fills(calls, color)).toEqual([]);
    }
    expect(fills(calls, VALUE_BG)).toHaveLength(1);
  });
});
