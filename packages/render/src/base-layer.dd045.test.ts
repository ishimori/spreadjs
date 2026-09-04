// DD-045 unit: 静的行背景（rowBackground フック）の横バンド描画と合成順。

import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId, type ColumnId, type RowId } from '@nanairo-sheet/types';

import { createAxis } from './axis';
import { createBaseLayer } from './base-layer';
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
      // Canvas 2D と同じく、構文不正な色の代入は無視して直前値を保つ。
      if (value !== 'not-a-color') fillStyle = String(value);
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
const BG_ROW = 2;
const BG_COL = 2;
const ROW_COLOR = '#e5e7eb';
const COLUMN_COLOR = '#ffe8e8';
const VALUE_COLOR = '#00ff00';

function setup(options: {
  withRowBackground: boolean;
  rowBackgroundOf?: (row: number) => string | undefined;
}): Call[] {
  const { ctx, calls } = createCtxStub();
  const store = createChunkStore();
  store.set(BG_ROW, BG_COL, 'HIT');
  const rowAxis = createAxis<RowId>({
    ids: Array.from({ length: 10 }, (_v, i) => createRowId(`r${i}`)),
    defaultSize: ROW_H,
  });
  const colAxis = createAxis<ColumnId>({
    ids: Array.from({ length: 6 }, (_v, i) => createColumnId(`c${i}`)),
    defaultSize: COL_W,
  });
  const layer = createBaseLayer({
    ctx,
    store,
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    frozenColCount: 1,
    columnBackground: (col) => (col === BG_COL ? COLUMN_COLOR : undefined),
    ...(options.withRowBackground
      ? { rowBackground: options.rowBackgroundOf ?? ((row: number) => (row === BG_ROW ? ROW_COLOR : undefined)) }
      : {}),
    getCellStyle: (_col, value) => (value === 'HIT' ? { cellBackground: VALUE_COLOR } : undefined),
  });
  const transform = createViewportTransform({
    rowAxis,
    colAxis,
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    frozenRowCount: 1,
    frozenColCount: 1,
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

describe('DD-045: 静的行背景（rowBackground）', () => {
  it('指定行は空セルを含む横バンドとして固定列 pane と body pane の両方に塗られる', () => {
    const bands = setup({ withRowBackground: true }).filter((c) => c.kind === 'fillRect' && c.style === ROW_COLOR);
    expect(bands).toHaveLength(2);
    for (const band of bands) {
      expect(band.kind === 'fillRect' && band.y).toBe(HEADER_H + BG_ROW * ROW_H);
      expect(band.kind === 'fillRect' && band.h).toBe(ROW_H);
    }
    expect(bands.some((band) => band.kind === 'fillRect' && band.w === COL_W)).toBe(true);
    expect(bands.some((band) => band.kind === 'fillRect' && band.w > COL_W)).toBe(true);
  });

  it('同一 pane では列背景 → 行背景 → 罫線 → 値ベース背景の順に描き、優先順位を固定する', () => {
    const calls = setup({ withRowBackground: true });
    const columnBand = calls.findIndex((c) => c.kind === 'fillRect' && c.style === COLUMN_COLOR);
    const rowBand = calls.findIndex((c) => c.kind === 'fillRect' && c.style === ROW_COLOR);
    const stroke = calls.findIndex((c) => c.kind === 'stroke');
    const valueBackground = calls.findIndex((c) => c.kind === 'fillRect' && c.style === VALUE_COLOR);
    expect(columnBand).toBeGreaterThanOrEqual(0);
    expect(rowBand).toBeGreaterThan(columnBand);
    expect(stroke).toBeGreaterThan(rowBand);
    expect(valueBackground).toBeGreaterThan(stroke);
  });

  it('フック未指定なら行バンド描画は起きない', () => {
    expect(setup({ withRowBackground: false }).some((c) => c.kind === 'fillRect' && c.style === ROW_COLOR)).toBe(false);
  });

  it('不正色の行は直前行の色を継承せず pane 背景へ縮退する', () => {
    const calls = setup({
      withRowBackground: true,
      rowBackgroundOf: (row) => (row === 2 ? '#ff0000' : row === 3 ? 'not-a-color' : undefined),
    });
    const invalidRowY = HEADER_H + 3 * ROW_H;
    const invalidBands = calls.filter((c) => c.kind === 'fillRect' && c.y === invalidRowY && c.h === ROW_H);
    expect(invalidBands).toHaveLength(2);
    expect(invalidBands.every((band) => band.kind === 'fillRect' && band.style !== '#ff0000')).toBe(true);
  });
});
