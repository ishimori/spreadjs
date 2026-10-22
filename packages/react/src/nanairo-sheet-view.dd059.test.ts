// @vitest-environment jsdom
//
// React Facade（<NanairoSheetView>）の DD-059 追加分 unit（jsdom・grid mount() をモック）:
//   - columnDisplayFormats の負の数の書式（number の `negative`）が GridMountOptions へそのまま渡る（AC5）
//   - `negative` も識別系（値で直列化）: キー順だけ違う同値は remount せず、表記が変われば remount する

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';

import { NanairoSheetView, type NanairoSheetViewProps } from './index';

interface FakeInstance {
  options: Record<string, unknown>;
  destroyed: boolean;
  setData(data: unknown): void;
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
      setData() {},
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

describe('DD-059 負の数の書式の写像（AC5）', () => {
  it('number の negative を columnDisplayFormats のまま grid へ渡す', () => {
    render(
      createElement(
        NanairoSheetView,
        standaloneProps({
          columnDisplayFormats: {
            a: { type: 'number', grouping: true, negative: { style: 'parentheses', color: '#c00' } },
            b: { type: 'number', negative: { style: 'triangle' } },
          },
        }),
      ),
    );
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]!.options.columnDisplayFormats).toEqual({
      a: { type: 'number', grouping: true, negative: { style: 'parentheses', color: '#c00' } },
      b: { type: 'number', negative: { style: 'triangle' } },
    });
  });

  it('キー順だけ違う同値では remount せず、表記が変われば remount する', () => {
    const { rerender } = render(
      createElement(
        NanairoSheetView,
        standaloneProps({ columnDisplayFormats: { a: { type: 'number', negative: { style: 'parentheses', color: 'red' } } } }),
      ),
    );
    expect(h.instances).toHaveLength(1);

    rerender(
      createElement(
        NanairoSheetView,
        standaloneProps({ columnDisplayFormats: { a: { negative: { color: 'red', style: 'parentheses' }, type: 'number' } } }),
      ),
    );
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]!.destroyed).toBe(false);

    rerender(
      createElement(
        NanairoSheetView,
        standaloneProps({ columnDisplayFormats: { a: { type: 'number', negative: { style: 'triangle', color: 'red' } } } }),
      ),
    );
    expect(h.instances).toHaveLength(2);
    expect(h.instances[0]!.destroyed).toBe(true);
    expect(h.instances[1]!.options.columnDisplayFormats).toEqual({
      a: { type: 'number', negative: { style: 'triangle', color: 'red' } },
    });
  });
});
