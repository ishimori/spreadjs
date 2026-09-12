// @vitest-environment jsdom
//
// React Facade（<NanairoSheetView>）の DD-054 追加分 unit（jsdom・grid mount() をモック）:
//   AC1/AC2 stringColumns・rowOperations の GridMountOptions への 1:1 写像
//   AC3 stringColumns・rowOperations は識別系（値変更で remount・同値リテラルでは remount しない）
//   AC4 ref handle の setRows が GridInstance.setRows へ直結し、未 mount 時は handle-before-mount warn で無視される
// 既存の AC1〜AC7（旧DD）は nanairo-sheet-view.test.ts / .dd035.test.ts / .dd036.test.ts / .dd049.test.ts（無修正）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, createRef } from 'react';
import { cleanup, render } from '@testing-library/react';

import { NanairoSheetView, type NanairoSheetViewHandle, type NanairoSheetViewProps } from './index';

interface FakeInstance {
  options: Record<string, unknown>;
  destroyed: boolean;
  calls: Array<{ method: string; args: unknown[] }>;
  setRows(rows: unknown): void;
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
      setRows(rows) {
        this.calls.push({ method: 'setRows', args: [rows] });
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
  return { mode: 'standalone', columnOrder: ['a', 'b', 'c'], ...over } as NanairoSheetViewProps;
}

beforeEach(() => {
  h.instances.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DD-054 stringColumns・rowOperations の写像（AC1/AC2）', () => {
  it('grid の同名 mount オプションへ 1:1 写像する', () => {
    render(
      createElement(NanairoSheetView, standaloneProps({ stringColumns: ['phone'], rowOperations: false })),
    );
    expect(h.instances).toHaveLength(1);
    const opt = h.instances[0]!.options;
    expect(opt.stringColumns).toEqual(['phone']);
    expect(opt.rowOperations).toBe(false);
  });

  it('未指定なら undefined のまま渡す（grid 側で現行挙動＝既存 consumer 無影響）', () => {
    render(createElement(NanairoSheetView, standaloneProps()));
    const opt = h.instances[0]!.options;
    expect(opt.stringColumns).toBeUndefined();
    expect(opt.rowOperations).toBeUndefined();
  });
});

describe('DD-054 stringColumns・rowOperations は識別系（AC3）', () => {
  it('同値の新規リテラルでは remount せず、値が変われば remount する（stringColumns は値で直列化）', () => {
    const { rerender } = render(
      createElement(NanairoSheetView, standaloneProps({ stringColumns: ['a', 'b'] })),
    );
    expect(h.instances).toHaveLength(1);

    // 同値の新規配列 → remount しない。
    rerender(createElement(NanairoSheetView, standaloneProps({ stringColumns: ['a', 'b'] })));
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]!.destroyed).toBe(false);

    // 値が変わる → destroy → 新 instance。
    rerender(createElement(NanairoSheetView, standaloneProps({ stringColumns: ['a', 'b', 'c'] })));
    expect(h.instances).toHaveLength(2);
    expect(h.instances[0]!.destroyed).toBe(true);
  });

  it('stringColumns は集合として順序非依存で正準化する（readOnlyColumns と同じ扱い）', () => {
    const { rerender } = render(
      createElement(NanairoSheetView, standaloneProps({ stringColumns: ['b', 'a'] })),
    );
    expect(h.instances).toHaveLength(1);

    // 並び順だけが違う → remount しない。
    rerender(createElement(NanairoSheetView, standaloneProps({ stringColumns: ['a', 'b'] })));
    expect(h.instances).toHaveLength(1);
  });

  it('rowOperations の値が変われば remount する', () => {
    const { rerender } = render(createElement(NanairoSheetView, standaloneProps({ rowOperations: true })));
    expect(h.instances).toHaveLength(1);

    rerender(createElement(NanairoSheetView, standaloneProps({ rowOperations: true })));
    expect(h.instances).toHaveLength(1); // 同値では remount しない

    rerender(createElement(NanairoSheetView, standaloneProps({ rowOperations: false })));
    expect(h.instances).toHaveLength(2);
  });
});

describe('DD-054 ref handle の setRows（AC4）', () => {
  it('setRows が GridInstance.setRows へ引数そのままで直結する', () => {
    const ref = createRef<NanairoSheetViewHandle>();
    render(createElement(NanairoSheetView, { ref, ...standaloneProps() } as NanairoSheetViewProps & { ref: typeof ref }));
    const handle = ref.current!;
    expect(handle).toBeTruthy();

    const rows = [{ rowId: 'r1', cells: { a: 'x' } }];
    handle.setRows(rows);

    expect(h.instances[0]!.calls).toEqual([{ method: 'setRows', args: [rows] }]);
  });

  it('unmount 後（instance なし）の呼び出しは handle-before-mount warn で無視する', () => {
    const ref = createRef<NanairoSheetViewHandle>();
    const onDiagnostic = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { unmount } = render(
      createElement(NanairoSheetView, { ref, ...standaloneProps({ onDiagnostic }) } as NanairoSheetViewProps & {
        ref: typeof ref;
      }),
    );
    const handle = ref.current!;
    unmount();

    handle.setRows([{ rowId: 'r1' }]);

    expect(h.instances[0]!.calls).toEqual([]);
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({ level: 'warn', code: 'handle-before-mount' });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
