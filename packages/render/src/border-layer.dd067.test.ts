import { describe, expect, it } from 'vitest';
import { createColumnId, createRowId } from '@nanairo-sheet/types';
import { createAxis } from './axis';
import { drawBorders, type BoundaryBorder } from './border-layer';
import { createViewportTransform } from './viewport';

interface Fill { color: string; x: number; y: number; w: number; h: number }

function render(options: { dpr?: number; rows?: number; scroll?: number; columnWidth?: number; borders?: boolean; dashed?: boolean } = {}): Fill[] {
  const calls: Fill[] = [];
  const ctx = {
    fillStyle: '', save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    fillRect(x: number, y: number, w: number, h: number) { calls.push({ color: this.fillStyle, x, y, w, h }); },
  };
  const ids = Array.from({ length: 8 }, (_, i) => createColumnId(`c${i}`));
  const colAxis = createAxis({ ids, defaultSize: 80 });
  if (options.columnWidth !== undefined) colAxis.setSize(1, options.columnWidth);
  const transform = createViewportTransform({
    rowAxis: createAxis({ ids: Array.from({ length: options.rows ?? 20 }, (_, i) => createRowId(`r${i}`)), defaultSize: 22 }),
    colAxis, headerWidth: 52, headerHeight: 48, frozenRowCount: 0, frozenColCount: 1,
    viewportWidth: 600, viewportHeight: 300, scrollLeft: options.scroll ?? 0, scrollTop: 0, overscanX: 0, overscanY: 0,
  });
  const border = (index: number): BoundaryBorder => ({ color: `#00000${index}`, width: index === 1 || index === 4 ? 2 : 1, ...(options.dashed && index === 2 ? { style: 'dashed' as const } : {}) });
  drawBorders(ctx as unknown as CanvasRenderingContext2D, { transform, viewportWidth: 600, viewportHeight: 300, dpr: options.dpr ?? 1 }, 52, 48, {
    ...(options.borders === false ? {} : { columnBorder: border }),
    columnGroupBand: { height: 24, groups: [{ caption: '上期', colStart: 1, colEnd: 4 }] },
  });
  return calls;
}

describe('DD-067 列見出しの縦罫線', () => {
  it.each([1, 1.25, 2])('DPR %s: 本文と見出しの位置・線幅・色が一致し、グループ内だけ下段にする', dpr => {
    const calls = render({ dpr });
    for (const boundary of [1, 2, 3, 4]) {
      const color = `#00000${boundary}`;
      const header = calls.find(c => c.color === color && c.y < 48);
      const body = calls.find(c => c.color === color && c.y === 48);
      expect(header).toMatchObject({ color, x: body?.x, w: body?.w, y: boundary === 2 || boundary === 3 ? 24 : 0 });
      expect(header!.x * dpr).toBeCloseTo(Math.round(header!.x * dpr));
      expect(header!.w * dpr).toBeCloseTo(Math.max(1, Math.round((boundary === 1 || boundary === 4 ? 2 : 1) * dpr)));
    }
  });

  it('破線の線種と位相を本文につなぐ', () => {
    const calls = render({ dashed: true }).filter(c => c.color === '#000002');
    expect(calls.filter(c => c.y < 48).map(c => [c.y, c.h])).toEqual([[24, 4], [30, 4], [36, 4], [42, 4]]);
    expect(calls.find(c => c.y === 48)?.h).toBe(4);
  });

  it('横スクロール中も固定境界を1回だけ描き、固定帯へスクロール列の線を重ねない', () => {
    const calls = render({ scroll: 93 });
    expect(calls.filter(c => c.color === '#000001' && c.y < 48)).toEqual([{ color: '#000001', x: 131, y: 0, w: 2, h: 48 }]);
    expect(calls.filter(c => c.y < 48 && c.color !== '#000000').every(c => c.x >= 131)).toBe(true);
  });

  it('列幅の変更後も見出しと本文が同じ境界に移る', () => {
    const calls = render({ columnWidth: 117 }).filter(c => c.color === '#000002');
    expect(calls.map(c => c.x)).toEqual([249, 249]);
  });

  it('0行でも見出しを描き、罫線未指定なら追加描画しない', () => {
    const calls = render({ rows: 0 });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.y < 48 && c.y + c.h <= 48)).toBe(true);
    expect(render({ borders: false })).toEqual([]);
  });
});
