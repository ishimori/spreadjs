import { expect, it } from 'vitest';
import { createColumnId, createRowId } from '@nanairo-sheet/types';
import { createAxis } from './axis';
import { createBaseLayer, DEFAULT_BASE_COLORS } from './base-layer';
import { createChunkStore } from './chunk-store';
import { createViewportTransform } from './viewport';

it.each([
  { dpr: 1, headerHeight: 48, rows: 30 },
  { dpr: 1.25, headerHeight: 48, rows: 30 },
  { dpr: 2, headerHeight: 48, rows: 30 },
  { dpr: 1, headerHeight: 24, rows: 0 },
])('DD-068: 下端の太線は最後に全幅へ描く（%j）', ({ dpr, headerHeight, rows }) => {
  const fills: { color: string; x: number; y: number; width: number; height: number }[] = [];
  const ctx = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'left', textBaseline: 'middle',
    save() {}, restore() {}, beginPath() {}, closePath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, arcTo() {}, fill() {}, clearRect() {}, stroke() {},
    measureText(text: string) { return { width: text.length * 7 }; }, fillText() {},
    fillRect(x: number, y: number, width: number, height: number) { fills.push({ color: this.fillStyle, x, y, width, height }); },
  };
  const transform = createViewportTransform({
    rowAxis: createAxis({ ids: Array.from({ length: rows }, (_, i) => createRowId(`r${i}`)), defaultSize: 22 }),
    colAxis: createAxis({ ids: Array.from({ length: 8 }, (_, i) => createColumnId(`c${i}`)), defaultSize: 80 }),
    headerWidth: 52, headerHeight, frozenRowCount: 0, frozenColCount: 1,
    viewportWidth: 600, viewportHeight: 300, scrollLeft: 93, scrollTop: 180, overscanX: 0, overscanY: 0,
  });
  createBaseLayer({
    ctx: ctx as unknown as CanvasRenderingContext2D, store: createChunkStore(), headerWidth: 52, headerHeight,
    colors: { ...DEFAULT_BASE_COLORS, headerText: '#234567' },
    columnBorder: () => ({ color: '#ff0000', width: 8 }),
    ...(headerHeight === 48 ? { columnGroupBand: { height: 24, groups: [{ caption: '上期', colStart: 1, colEnd: 4 }] } } : {}),
  }).draw({ transform, viewportWidth: 600, viewportHeight: 300, dpr });
  const rule = fills.at(-1);
  expect(rule).toMatchObject({ color: '#234567', x: 0, width: 600 });
  expect(rule?.y).toBeLessThan(headerHeight);
  expect((rule?.y ?? 0) + (rule?.height ?? 0)).toBeGreaterThan(headerHeight);
  expect((rule?.height ?? 0) * dpr).toBeCloseTo(Math.round(3 * dpr));
  expect((rule?.y ?? 0) * dpr).toBeCloseTo(Math.round((rule?.y ?? 0) * dpr));
});
