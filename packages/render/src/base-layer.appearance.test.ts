import { expect, it } from 'vitest';
import { createColumnId, createRowId, type ColumnId, type RowId } from '@nanairo-sheet/types';
import { createAxis } from './axis';
import { createBaseLayer } from './base-layer';
import { createChunkStore } from './chunk-store';
import { createViewportTransform } from './viewport';

it('列の強調fontを測定と描画の両方に使い、次列へ漏らさない', () => {
  const measured: string[] = [];
  const drawn: { text: string; font: string }[] = [];
  const ctx = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'left', textBaseline: 'middle',
    save() {}, restore() {}, beginPath() {}, closePath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, arcTo() {}, fill() {}, clearRect() {}, fillRect() {}, stroke() {},
    measureText(text: string) { measured.push(this.font); return { width: text.length * (this.font.startsWith('600') ? 10 : 7) }; },
    fillText(text: string) { drawn.push({ text, font: this.font }); },
  };
  const store = createChunkStore(); store.set(0, 0, '強調'); store.set(0, 1, '通常');
  const rowAxis = createAxis<RowId>({ ids: [createRowId('r')], defaultSize: 39 });
  const colAxis = createAxis<ColumnId>({ ids: [createColumnId('a'), createColumnId('b')], defaultSize: 100 });
  const transform = createViewportTransform({ rowAxis, colAxis, headerWidth: 40, headerHeight: 24, frozenRowCount: 0, frozenColCount: 0, viewportWidth: 300, viewportHeight: 100, scrollLeft: 0, scrollTop: 0, overscanX: 0, overscanY: 0 });
  createBaseLayer({ ctx: ctx as unknown as CanvasRenderingContext2D, store, headerWidth: 40, headerHeight: 24, cellFont: '14px sans-serif', headerFont: '600 14px sans-serif', columnFont: (col) => col === 0 ? '600 14px sans-serif' : undefined }).draw({ transform, viewportWidth: 300, viewportHeight: 100, dpr: 1 });
  expect(drawn).toContainEqual({ text: '強調', font: '600 14px sans-serif' });
  expect(drawn).toContainEqual({ text: '通常', font: '14px sans-serif' });
  expect(measured).toContain('600 14px sans-serif'); expect(measured).toContain('14px sans-serif');
});
