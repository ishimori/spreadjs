import { describe, expect, it } from 'vitest';
import { createRowId, createColumnId } from '@nanairo-sheet/types';
import { createAxis } from './axis';
import { createViewportTransform } from './viewport';
import { createChunkStore } from './chunk-store';
import { createBaseLayer } from './base-layer';
import { drawBorders, type BoundaryBorder } from './border-layer';

function context() {
  const rects: Array<{ color: string; x: number; y: number; w: number; h: number }> = [];
  const moves: Array<[number, number]> = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    save() {}, restore() {}, beginPath() {}, closePath() {}, rect() {}, clip() {}, clearRect() {},
    stroke() {}, fill() {}, arcTo() {}, fillText() {}, lineTo() {},
    moveTo(x: number, y: number) { moves.push([x, y]); },
    measureText(text: string) { return { width: text.length * 7 }; },
    fillRect(x: number, y: number, w: number, h: number) { rects.push({ color: this.fillStyle, x, y, w, h }); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects, moves };
}

function frame(rows: number, dpr: number, frozen = 0, scroll = 0) {
  return {
    transform: createViewportTransform({
      rowAxis: createAxis({ ids: Array.from({ length: rows }, (_, i) => createRowId(`r${i * 71}`)), defaultSize: 22 }),
      colAxis: createAxis({ ids: Array.from({ length: 200 }, (_, i) => createColumnId(`c${i}`)), defaultSize: 80 }),
      headerWidth: 52, headerHeight: 24, frozenRowCount: frozen, frozenColCount: frozen,
      viewportWidth: 800, viewportHeight: 400, scrollLeft: scroll, scrollTop: scroll, overscanX: 0, overscanY: 0,
    }), viewportWidth: 800, viewportHeight: 400, dpr,
  };
}

describe('DD-048 Canvas composition', () => {
  it.each(['dotted', 'dashed'] as const)('%sは格子pathを抑止して値背景の上/左insetも除去、他の背景も消さない', (style) => {
    const { ctx, moves, rects } = context();
    const store = createChunkStore();
    store.set(2, 2, 'HIT');
    const line = { color: 'red', width: 1, style };
    createBaseLayer({ ctx, store, headerWidth: 52, headerHeight: 24,
      columnBorder: (i) => i === 2 ? line : undefined,
      rowBorder: (i) => i === 2 ? line : undefined,
      columnBackground: () => 'pink', rowBackground: (i) => i === 2 ? 'gray' : undefined,
      getCellStyle: () => ({ cellBackground: 'lime' }),
    }).draw(frame(10, 1));
    expect(moves).not.toContainEqual([212.5, 24]);
    expect(moves).not.toContainEqual([52, 68.5]);
    expect(moves).toContainEqual([132.5, 24]); // 無指定の格子は残る
    expect(rects).toContainEqual({ color: 'lime', x: 212, y: 68, w: 80, h: 22 });
    const colors = rects.map((r) => r.color);
    expect(colors.indexOf('pink')).toBeLessThan(colors.indexOf('gray'));
    expect(colors.indexOf('gray')).toBeLessThan(colors.indexOf('lime'));
    expect(colors.indexOf('lime')).toBeLessThan(colors.indexOf('red'));
  });
  it.each([1, 1.25, 2])('DPR %s: patternはdevice整数、固定境界の周期/alphaは重複せず可視境界だけ解決', (dpr) => {
    for (const style of ['dotted', 'dashed'] as const) {
      const { ctx, rects } = context();
      let reads = 0;
      drawBorders(ctx, frame(50000, dpr, 2, 150), 52, 24, {
        rowBorder: (i) => { reads++; return i === 2 ? { color: 'rgba(0,0,0,.5)', width: 1, style } : undefined; },
      });
      expect(reads).toBeLessThan(30);
      const w = Math.max(1, Math.round(dpr));
      expect(rects.length).toBeGreaterThan(10);
      rects.forEach((r, i) => {
        expect(r.x * dpr).toBeCloseTo(Math.round(52 * dpr) + i * w * (style === 'dotted' ? 3 : 6));
        expect(r.y * dpr).toBeCloseTo(Math.round(r.y * dpr));
        expect(r.h * dpr).toBeCloseTo(w);
        if (i < rects.length - 1) expect(r.w * dpr).toBeCloseTo(w * (style === 'dotted' ? 1 : 4));
      });
    }
  });
  it.each([0, 1])('%s行: 0行は描画なし、1行は最終下端の1device pxを内側へ残す', (rows) => {
    for (const frozen of [0, 2]) {
      const { ctx, rects } = context();
      drawBorders(ctx, frame(rows, 1, frozen), 52, 24, { rowBorder: (i) => i > 0 ? { color: 'red', width: 1, style: 'dotted' } : undefined });
      if (rows === 0) expect(rects).toHaveLength(0);
      else {
        expect(rects.length).toBeGreaterThan(0);
        for (const r of rects) { expect(r.y).toBe(45); expect(r.h).toBe(1); }
      }
    }
  });
  it('solid省略と明示は同一描画', () => {
    const render = (style?: BoundaryBorder['style']) => {
      const { ctx, rects } = context();
      drawBorders(ctx, frame(10, 1), 52, 24, { rowBorder: () => ({ color: 'red', width: 2, style }) });
      return rects;
    };
    expect(render()).toEqual(render('solid'));
  });
});
