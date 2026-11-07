// @vitest-environment jsdom
//
// React Facade（<NanairoSheetView>）の DD-064 追加分 unit（jsdom・grid mount() をモック）:
//   AC7 mergedCells は mount オプションの初期値として渡り、値（参照）が変わっても開き直さず同じ instance の setMergedCells を呼ぶ
//       （同じ参照なら呼ばない・未指定へ戻したら []）。columnGroups は mount 固定の識別系（値が変われば開き直す）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';

import { NanairoSheetView, type NanairoSheetViewProps } from './index';

interface FakeInstance {
  options: Record<string, unknown>;
  destroyed: boolean;
  calls: Array<{ method: string; args: unknown[] }>;
  setMergedCells(mergedCells: unknown): void;
  connectionState(): string;
  destroy(): void;
}

const h = vi.hoisted(() => ({ instances: [] as FakeInstance[] }));

vi.mock('@nanairo-sheet/grid', () => ({
  mount(_target: { container: HTMLElement }, options: Record<string, unknown>): FakeInstance {
    const inst: FakeInstance = {
      options,
      destroyed: false,
      calls: [],
      setMergedCells(mergedCells) {
        this.calls.push({ method: 'setMergedCells', args: [mergedCells] });
      },
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
  return { mode: 'standalone', columnOrder: ['no', 'item', 'm04', 'm05'], ...over } as NanairoSheetViewProps;
}

const mergeCalls = (inst: FakeInstance | undefined): unknown[] =>
  (inst?.calls ?? []).filter((c) => c.method === 'setMergedCells').map((c) => c.args[0]);

beforeEach(() => {
  h.instances.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DD-064 mergedCells は開き直さずに置き換える（AC7）', () => {
  it('mount 時の値は mount オプションへ、変化は同じ instance の setMergedCells へ（同じ参照なら呼ばない）', () => {
    const first = [{ rowId: 'd1:budget', columnId: 'no', rowSpan: 3 }];
    const { rerender } = render(createElement(NanairoSheetView, standaloneProps({ mergedCells: first })));
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]!.options.mergedCells).toBe(first);
    expect(mergeCalls(h.instances[0])).toEqual([]); // mount 自体が初期値で作られている

    rerender(createElement(NanairoSheetView, standaloneProps({ mergedCells: first })));
    expect(mergeCalls(h.instances[0])).toEqual([]);

    const second = [{ rowId: 'd2:budget', columnId: 'no', rowSpan: 3 }];
    rerender(createElement(NanairoSheetView, standaloneProps({ mergedCells: second })));
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]!.destroyed).toBe(false);
    expect(mergeCalls(h.instances[0])).toEqual([second]);

    rerender(createElement(NanairoSheetView, standaloneProps({})));
    expect(mergeCalls(h.instances[0])).toEqual([second, []]);
  });

  it('未指定なら mount オプションに mergedCells を渡さない', () => {
    render(createElement(NanairoSheetView, standaloneProps({})));
    expect('mergedCells' in h.instances[0]!.options).toBe(false);
  });
});

describe('DD-064 columnGroups は mount 固定（AC7）', () => {
  it('値が同じなら新しい配列でも開き直さず、値が変われば開き直す', () => {
    const groups = (caption: string) => [{ caption, columnIds: ['m04', 'm05'] }];
    const { rerender } = render(createElement(NanairoSheetView, standaloneProps({ columnGroups: groups('上期') })));
    expect(h.instances[0]!.options.columnGroups).toEqual(groups('上期'));

    rerender(createElement(NanairoSheetView, standaloneProps({ columnGroups: groups('上期') })));
    expect(h.instances).toHaveLength(1);

    rerender(createElement(NanairoSheetView, standaloneProps({ columnGroups: groups('前半') })));
    expect(h.instances).toHaveLength(2);
    expect(h.instances[0]!.destroyed).toBe(true);
    expect(h.instances[1]!.options.columnGroups).toEqual(groups('前半'));
  });
});
