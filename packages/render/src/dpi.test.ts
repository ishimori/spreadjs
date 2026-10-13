import { describe, expect, it } from 'vitest';

import { backingSize, deviceLineWidth, devicePixelOffset, normalizeDpr, snapToDevice } from './dpi';

describe('dpi: devicePixelOffset', () => {
  it.each([1, 1.25, 1.5, 1.75, 2])('DPR %s: 最寄りの実画素へ半画素以内で合わせる', (dpr) => {
    for (const css of [0, 17, 197.765625, -17, -197.765625, 0.25, 10000.125]) {
      const offset = devicePixelOffset(css, dpr);
      expect((css + offset) * dpr).toBeCloseTo(Math.round(css * dpr), 10);
      expect(Math.abs(offset * dpr)).toBeLessThanOrEqual(0.5 + 1e-10);
    }
  });

  it('整数位置は動かさず、無効 DPR は 1 として扱う', () => {
    expect(devicePixelOffset(16, 1.25)).toBe(0);
    expect(devicePixelOffset(0.2, Number.NaN)).toBeCloseTo(-0.2);
    expect(devicePixelOffset(0.2, 0)).toBeCloseTo(-0.2);
  });
});

describe('dpi: backingSize', () => {
  it('CSS サイズ × DPR でバッキングストアを算出する', () => {
    expect(backingSize({ width: 100, height: 50 }, 2)).toEqual({ width: 200, height: 100 });
  });

  it('非整数 DPR は round で整数化する', () => {
    expect(backingSize({ width: 100, height: 50 }, 1.25)).toEqual({ width: 125, height: 63 });
  });
});

describe('dpi: normalizeDpr', () => {
  it('0・負値・NaN は 1 に丸める', () => {
    expect(normalizeDpr(0)).toBe(1);
    expect(normalizeDpr(-2)).toBe(1);
    expect(normalizeDpr(Number.NaN)).toBe(1);
    expect(normalizeDpr(2)).toBe(2);
  });
});

describe('dpi: snapToDevice / deviceLineWidth', () => {
  it('DPR=1 では 0.5 オフセット（DD-002 と同じ）', () => {
    expect(snapToDevice(10, 1)).toBe(10.5);
    expect(deviceLineWidth(1)).toBe(1);
  });

  it('DPR=2 では device 上で round(css*dpr)+0.5 になる CSS 座標を返す', () => {
    const css = snapToDevice(10, 2);
    // device 座標へ戻すと X.5 になっていること（くっきり 1px の条件）。
    expect(css * 2).toBe(Math.round(10 * 2) + 0.5);
    expect(deviceLineWidth(2)).toBe(0.5);
  });

  it('非整数 DPR=1.5 でも device 上で X.5 になる', () => {
    const css = snapToDevice(7, 1.5);
    expect(css * 1.5).toBeCloseTo(Math.round(7 * 1.5) + 0.5, 10);
  });
});
