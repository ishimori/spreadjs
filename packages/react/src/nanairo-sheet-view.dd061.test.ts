// @vitest-environment jsdom
//
// React Facade（<NanairoSheetView>）の DD-061〜063 追加分 unit（jsdom・grid mount() をモック）:
//   - DD-061: cellStatusColors が GridMountOptions へそのまま渡り、識別系（値で直列化）として扱われる
//   - DD-062: ref handle の setCellStatus が grid の setCellStatus へそのまま渡る（mount 前は無視＋warn）
//   - DD-063: validateCell は開き直しの判定に入らず、最新の関数が呼ばれる

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, createRef } from 'react';
import { cleanup, render } from '@testing-library/react';

import { NanairoSheetView, type NanairoSheetViewHandle, type NanairoSheetViewProps } from './index';

interface FakeInstance {
  options: Record<string, unknown>;
  destroyed: boolean;
  cellStatusCalls: unknown[];
  setData(data: unknown): void;
  setCellStatus(rows: unknown): void;
  focus(): void;
  connectionState(): string;
  destroy(): void;
}

const h = vi.hoisted(() => ({ instances: [] as FakeInstance[] }));

vi.mock('@nanairo-sheet/grid', () => ({
  mount(_target: { container: HTMLElement }, options: Record<string, unknown>): FakeInstance {
    const inst: FakeInstance = {
      options,
      destroyed: false,
      cellStatusCalls: [],
      setData() {},
      setCellStatus(rows: unknown) {
        this.cellStatusCalls.push(rows);
      },
      focus() {},
      connectionState() {
        return 'standalone';
      },
      destroy() {
        this.destroyed = true;
      },
    };
    h.instances.push(inst);
    return inst;
  },
}));

function standaloneProps(over: Partial<NanairoSheetViewProps> = {}): NanairoSheetViewProps {
  return { mode: 'standalone', columnOrder: ['a', 'b'], ...over } as NanairoSheetViewProps;
}

beforeEach(() => {
  h.instances.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DD-061 cellStatusColors の写像', () => {
  it('grid へそのまま渡し、キー順だけ違う同値では開き直さず、色が変われば開き直す', () => {
    const { rerender } = render(
      createElement(NanairoSheetView, standaloneProps({ cellStatusColors: { error: { frame: '#00f', background: '#eef' } } })),
    );
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]!.options.cellStatusColors).toEqual({ error: { frame: '#00f', background: '#eef' } });

    rerender(createElement(NanairoSheetView, standaloneProps({ cellStatusColors: { error: { background: '#eef', frame: '#00f' } } })));
    expect(h.instances).toHaveLength(1);

    rerender(createElement(NanairoSheetView, standaloneProps({ cellStatusColors: { error: { frame: '#0a0' } } })));
    expect(h.instances).toHaveLength(2);
    expect(h.instances[0]!.destroyed).toBe(true);
    expect(h.instances[1]!.options.cellStatusColors).toEqual({ error: { frame: '#0a0' } });
  });

  it('未指定なら grid へ渡さない', () => {
    render(createElement(NanairoSheetView, standaloneProps()));
    expect(h.instances[0]!.options).not.toHaveProperty('cellStatusColors');
  });
});

describe('DD-062 ref handle の setCellStatus', () => {
  it('grid の setCellStatus へそのまま渡す', () => {
    const ref = createRef<NanairoSheetViewHandle>();
    render(createElement(NanairoSheetView, { ...standaloneProps(), ref }));
    const rows = [{ rowId: 'r1', cellStatus: { a: { level: 'error' as const, message: 'm' } } }];
    ref.current!.setCellStatus(rows);
    expect(h.instances[0]!.cellStatusCalls).toEqual([rows]);
  });
});

describe('consumer appearance の写像', () => {
  it('キー順に依存せず、fontを変えた場合だけ開き直す', () => {
    const { rerender } = render(createElement(NanairoSheetView, standaloneProps({ appearance: { cellFont: '14px sans-serif', headerFont: '600 14px sans-serif' } })));
    expect(h.instances[0]!.options.appearance).toEqual({ cellFont: '14px sans-serif', headerFont: '600 14px sans-serif' });
    rerender(createElement(NanairoSheetView, standaloneProps({ appearance: { headerFont: '600 14px sans-serif', cellFont: '14px sans-serif' } })));
    expect(h.instances).toHaveLength(1);
    rerender(createElement(NanairoSheetView, standaloneProps({ appearance: { cellFont: '15px sans-serif' } })));
    expect(h.instances).toHaveLength(2);
  });
});

describe('DD-063 validateCell の写像', () => {
  type Validate = (cell: { rowId: string; columnId: string; value: string }) => string | null;
  const passed = (inst: FakeInstance): Validate => inst.options.validateCell as Validate;

  it('関数を差し替えても開き直さず、最新の関数を呼ぶ。指定をやめると開き直して渡さない', () => {
    const first = vi.fn<Validate>(() => 'first');
    const second = vi.fn<Validate>(() => null);
    const { rerender } = render(createElement(NanairoSheetView, standaloneProps({ validateCell: first })));
    expect(h.instances).toHaveLength(1);
    const cell = { rowId: 'r1', columnId: 'a', value: '123' };
    expect(passed(h.instances[0]!)(cell)).toBe('first');

    rerender(createElement(NanairoSheetView, standaloneProps({ validateCell: second })));
    expect(h.instances).toHaveLength(1);
    expect(passed(h.instances[0]!)(cell)).toBeNull();
    expect(second).toHaveBeenCalledWith(cell);

    rerender(createElement(NanairoSheetView, standaloneProps()));
    expect(h.instances).toHaveLength(2);
    expect(h.instances[1]!.options).not.toHaveProperty('validateCell');
  });
});
