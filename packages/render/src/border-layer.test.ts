import { describe, expect, it } from 'vitest';
import { createColumnId, createRowId } from '@nanairo-sheet/types';
import { createAxis } from './axis';
import { createViewportTransform } from './viewport';
import { borderBand, drawBorders } from './border-layer';
import { nearestLeftNonEmpty, overflowRightExtent } from './text-overflow';

describe('DD-047 device geometry / overflow', () => {
  it.each([1, 1.25, 2])('DPR %sでは辺がdevice整数・幅はround(CSS*DPR)', (dpr) => {
    for (const width of [0.1, 1, 2, 3, 8]) {
      const band = borderBand(132.3, width, dpr);
      expect(band.start * dpr).toBeCloseTo(Math.round(band.start * dpr));
      expect(band.size * dpr).toBe(Math.max(1, Math.round(width * dpr)));
    }
  });
  it('縦境界でoverflowと左外流入を止め、境界なしなら従来通り', () => {
    expect(overflowRightExtent(0, 8, () => true, (i) => i === 2)).toEqual({ endColExclusive: 2, blocked: true });
    expect(overflowRightExtent(0, 2, () => true, (i) => i === 2)).toEqual({ endColExclusive: 2, blocked: true });
    expect(overflowRightExtent(0, 8, () => true)).toEqual({ endColExclusive: 8, blocked: false });
    expect(nearestLeftNonEmpty(4, 0, 20, (i) => i !== 0, (i) => i === 2)).toBeNull();
    expect(nearestLeftNonEmpty(4, 0, 20, (i) => i !== 0)).toBe(0);
  });
  it('全50k行を走査せず、固定境界は1回だけ全幅、交点は幅→横線順', () => {
    const transform = createViewportTransform({
      rowAxis: createAxis({ ids: Array.from({ length: 50000 }, (_, i) => createRowId(`r${i}`)), defaultSize: 22 }),
      colAxis: createAxis({ ids: Array.from({ length: 200 }, (_, i) => createColumnId(`c${i}`)), defaultSize: 80 }),
      headerWidth: 52, headerHeight: 24, frozenRowCount: 1, frozenColCount: 5,
      viewportWidth: 800, viewportHeight: 400, scrollLeft: 333, scrollTop: 151, overscanX: 0, overscanY: 0,
    });
    const calls: Array<{ color: string; x: number; y: number; w: number; h: number }> = [];
    const ctx = {
      fillStyle: '', save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      fillRect(x: number, y: number, w: number, h: number) { calls.push({ color: this.fillStyle, x, y, w, h }); },
    };
    let reads = 0;
    drawBorders(ctx as unknown as CanvasRenderingContext2D, { transform, viewportWidth: 800, viewportHeight: 400, dpr: 1 }, 52, 24, {
      columnBorder: (i) => { reads += 1; return i === 5 ? { color: 'red', width: 2 } : undefined; },
      rowBorder: (i) => { reads += 1; return i === 1 ? { color: 'blue', width: 2 } : undefined; },
    });
    expect(reads).toBeLessThan(50);
    expect(calls).toEqual([
      { color: 'red', x: 451, y: 24, w: 2, h: 376 },
      { color: 'blue', x: 52, y: 45, w: 748, h: 2 },
    ]);
  });
});
