// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasLayout } from './canvas-layout';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const stage = document.createElement('div');
  const canvases = [document.createElement('canvas'), document.createElement('canvas')] as const;
  let left = 17, top = 197.765625;
  const read = vi.spyOn(stage, 'getBoundingClientRect').mockImplementation(() => new DOMRect(left, top, 1000, 500));
  const dpr = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1.25);
  const changed = vi.fn();
  const layout = createCanvasLayout(stage, canvases, changed);
  return { layout, read, dpr, changed, canvases, move: () => { left += 0.125; top += 31.375; } };
}

describe('DD-058 canvas layout', () => {
  it('同サイズの位置移動を拾い、両 canvas を同じ offset にそろえる', () => {
    const f = fixture();
    f.layout.sync();
    const before = f.canvases[0].style.transform;
    expect(f.canvases[0].style.left).toBe('-17px');
    expect(before).toBe('translate(16.8px, 197.6px)');
    f.move();
    f.layout.sync();
    expect(f.canvases[0].style.transform).not.toBe(before);
    expect(f.canvases[0].style.transform).toBe(f.canvases[1].style.transform);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('CSS サイズを変えず DPR だけ変えると layout 更新を1回通知する', () => {
    const f = fixture();
    f.layout.sync();
    f.dpr.mockReturnValue(1.5);
    f.layout.sync();
    f.layout.sync();
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.canvases[0].style.transform).toBe(f.canvases[1].style.transform);
    f.dpr.mockReturnValue(2);
    f.layout.sync();
    expect(f.changed).toHaveBeenCalledTimes(2);
  });

  it('位置が変わらないフレームでは DOM への書き込みをしない', () => {
    const f = fixture();
    const set = vi.spyOn(f.canvases[0].style, 'transform', 'set');
    f.layout.sync();
    f.layout.sync();
    expect(set).toHaveBeenCalledTimes(1);
  });
});
