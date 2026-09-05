// @vitest-environment jsdom
//
// React Facade（<NanairoSheetView>）の DD-036 追加分 unit（jsdom・grid mount() をモック）:
//   - props（frozenRowCount / frozenColumnCount / columnBackgrounds / rowBackgrounds / readOnlyRows）の GridMountOptions への
//     1:1 写像と「識別系＝値変更で remount・同値リテラル（キー順違い・行順違いを含む）では remount しない」（契約 §5）
//   - ref handle の scrollToColumn が GridInstance へ直結し、未 mount 時は `handle-before-mount` warn で無視される
// 既存は nanairo-sheet-view.test.ts / .dd035.test.ts（無修正）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, createRef } from 'react';
import { cleanup, render } from '@testing-library/react';

import { NanairoSheetView, type NanairoSheetViewHandle, type NanairoSheetViewProps } from './index';

interface FakeInstance {
  options: Record<string, unknown>;
  destroyed: boolean;
  calls: Array<{ method: string; args: unknown[] }>;
  setData(data: unknown): void;
  focus(): void;
  connectionState(): string;
  insertRows(options: unknown): void;
  deleteRows(rowIds: unknown): void;
  scrollToRow(rowId: unknown): void;
  scrollToColumn(columnId: unknown): void;
  setActiveCell(rowId: unknown, columnId: unknown): void;
  destroy(): void;
}

const h = vi.hoisted(() => ({ instances: [] as FakeInstance[] }));

vi.mock('@nanairo-sheet/grid', () => ({
  mount(_target: { container: HTMLElement }, options: Record<string, unknown>): FakeInstance {
    const inst: FakeInstance = {
      options,
      destroyed: false,
      calls: [],
      setData(data) {
        this.calls.push({ method: 'setData', args: [data] });
      },
      focus() {
        this.calls.push({ method: 'focus', args: [] });
      },
      connectionState() {
        return 'standalone';
      },
      insertRows(options) {
        this.calls.push({ method: 'insertRows', args: [options] });
      },
      deleteRows(rowIds) {
        this.calls.push({ method: 'deleteRows', args: [rowIds] });
      },
      scrollToRow(rowId) {
        this.calls.push({ method: 'scrollToRow', args: [rowId] });
      },
      scrollToColumn(columnId) {
        this.calls.push({ method: 'scrollToColumn', args: [columnId] });
      },
      setActiveCell(rowId, columnId) {
        this.calls.push({ method: 'setActiveCell', args: [rowId, columnId] });
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

describe('DD-036/DD-045 props の写像（AC8/AC10）', () => {
  it('固定 pane・静的背景・readOnly props を grid の同名 mount オプションへ 1:1 写像する', () => {
    render(
      createElement(
        NanairoSheetView,
        standaloneProps({
          frozenRowCount: 2,
          frozenColumnCount: 5,
          columnBackgrounds: { b: '#eef3ff' },
          rowBackgrounds: { r2: '#e5e7eb' },
          readOnlyRows: ['r1', 'r2'],
        }),
      ),
    );
    const opt = h.instances[0]!.options;
    expect(opt.frozenRowCount).toBe(2);
    expect(opt.frozenColumnCount).toBe(5);
    expect(opt.columnBackgrounds).toEqual({ b: '#eef3ff' });
    expect(opt.rowBackgrounds).toEqual({ r2: '#e5e7eb' });
    expect(opt.readOnlyRows).toEqual(['r1', 'r2']);
  });

  it('未指定なら undefined のまま渡す（grid 側で既定＝既存 consumer 無影響）', () => {
    render(createElement(NanairoSheetView, standaloneProps()));
    const opt = h.instances[0]!.options;
    for (const key of ['frozenRowCount', 'frozenColumnCount', 'columnBackgrounds', 'rowBackgrounds', 'readOnlyRows']) {
      expect(opt[key], key).toBeUndefined();
    }
  });

  it('同値（キー順違い・行順違い）では remount せず、値が変われば remount する', () => {
    const { rerender } = render(
      createElement(
        NanairoSheetView,
        standaloneProps({
          frozenColumnCount: 5,
          columnBackgrounds: { a: '#fff', b: '#000' },
          rowBackgrounds: { r1: '#eee', r2: '#ddd' },
          readOnlyRows: ['r2', 'r1'],
        }),
      ),
    );
    expect(h.instances).toHaveLength(1);

    // Record のキー順・行 ID の並び順が違うだけ → 正準化されて同値＝remount しない。
    rerender(
      createElement(
        NanairoSheetView,
        standaloneProps({
          frozenColumnCount: 5,
          columnBackgrounds: { b: '#000', a: '#fff' },
          rowBackgrounds: { r2: '#ddd', r1: '#eee' },
          readOnlyRows: ['r1', 'r2'],
        }),
      ),
    );
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]!.destroyed).toBe(false);

    // 行背景の値が変われば remount（mount 時固定のオプションゆえ）。
    rerender(
      createElement(
        NanairoSheetView,
        standaloneProps({
          frozenColumnCount: 5,
          columnBackgrounds: { a: '#fff', b: '#000' },
          rowBackgrounds: { r1: '#fff', r2: '#ddd' },
          readOnlyRows: ['r1', 'r2'],
        }),
      ),
    );
    expect(h.instances).toHaveLength(2);
    expect(h.instances[0]!.destroyed).toBe(true);
    expect(h.instances[1]!.options.rowBackgrounds).toEqual({ r1: '#fff', r2: '#ddd' });

    // 固定列数が変わっても従来どおり remount。
    rerender(
      createElement(
        NanairoSheetView,
        standaloneProps({
          frozenColumnCount: 3,
          columnBackgrounds: { a: '#fff', b: '#000' },
          rowBackgrounds: { r1: '#fff', r2: '#ddd' },
          readOnlyRows: ['r1', 'r2'],
        }),
      ),
    );
    expect(h.instances).toHaveLength(3);
    expect(h.instances[2]!.options.frozenColumnCount).toBe(3);
  });
});

describe('DD-047 罫線prop', () => {
  it('両モードへ写像し、ネストしたキー順だけの変更ではremountせず、幅変更時だけ再作成', () => {
    const border = { color: '#123456', width: 2 };
    const { rerender } = render(createElement(NanairoSheetView, standaloneProps({ rowBorders: { r0: { top: border, bottom: border } }, columnBorders: { a: { right: border } } })));
    expect(h.instances[0]!.options.columnBorders).toEqual({ a: { right: border } });
    rerender(createElement(NanairoSheetView, standaloneProps({ columnBorders: { a: { right: { width: 2, color: '#123456' } } }, rowBorders: { r0: { bottom: border, top: border } } })));
    expect(h.instances).toHaveLength(1);
    rerender(createElement(NanairoSheetView, standaloneProps({ rowBorders: { r0: { top: { ...border, width: 3 } } } })));
    expect(h.instances).toHaveLength(2);
    expect(h.instances[0]!.destroyed).toBe(true);
    rerender(createElement(NanairoSheetView, { serverUrl: 'http://localhost:8799', rowBorders: { r0: { top: border } }, columnBorders: { a: { left: border } } }));
    expect(h.instances[2]!.options.rowBorders).toEqual({ r0: { top: border } });
    expect(h.instances[2]!.options.columnBorders).toEqual({ a: { left: border } });
  });
});

describe('DD-036 handle.scrollToColumn（契約 §4/§5）', () => {
  it('GridInstance.scrollToColumn へ直結する', () => {
    const ref = createRef<NanairoSheetViewHandle>();
    render(createElement(NanairoSheetView, { ...standaloneProps(), ref } as never));
    ref.current!.scrollToColumn('col-x120');
    expect(h.instances[0]!.calls).toContainEqual({ method: 'scrollToColumn', args: ['col-x120'] });
  });

  it('未 mount 時は handle-before-mount の warn を出して無視する', () => {
    const ref = createRef<NanairoSheetViewHandle>();
    const diagnostics: Array<{ code: string }> = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { unmount } = render(
      createElement(NanairoSheetView, {
        ...standaloneProps({ onDiagnostic: (entry) => diagnostics.push(entry) }),
        ref,
      } as never),
    );
    const handle = ref.current!;
    unmount(); // unmount 後は React が ref を null にするため、handle は先に取り出しておく
    handle.scrollToColumn('col-b');
    expect(diagnostics.some((d) => d.code === 'handle-before-mount')).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
