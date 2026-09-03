// @vitest-environment jsdom
//
// React Facade（<NanairoSheetView>）の DD-035 追加分 unit（jsdom・grid mount() をモック）:
//   - 列スキーマ props 6 点（columnTypes/columnFormats/columnCaptions/columnDisplayFormats/readOnly/readOnlyColumns）の
//     GridMountOptions への 1:1 写像と「識別系＝値変更で remount・同値リテラルでは remount しない」（契約 §4）
//   - ref handle の insertRows/deleteRows/scrollToRow/setActiveCell が GridInstance へ直結し、未 mount 時は
//     `handle-before-mount` warn で無視される（契約 §3）
// 既存の AC1〜AC6 は nanairo-sheet-view.test.ts（無修正）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, createRef } from 'react';
import { cleanup, render } from '@testing-library/react';

import {
  NanairoSheetView,
  type NanairoSheetViewHandle,
  type NanairoSheetViewProps,
} from './index';

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

describe('DD-035 列スキーマ props の写像（AC7）', () => {
  it('6 props を grid の同名 mount オプションへ 1:1 写像する', () => {
    render(
      createElement(
        NanairoSheetView,
        standaloneProps({
          columnTypes: { a: { type: 'select', options: ['x', 'y'] }, b: { type: 'date' } },
          columnFormats: { a: [{ match: 'x', style: { badge: true } }] },
          columnCaptions: { a: '取引先' },
          columnDisplayFormats: { c: { type: 'number', grouping: true } },
          readOnly: false,
          readOnlyColumns: ['c'],
        }),
      ),
    );
    expect(h.instances).toHaveLength(1);
    const opt = h.instances[0]!.options;
    expect(opt.columnTypes).toEqual({ a: { type: 'select', options: ['x', 'y'] }, b: { type: 'date' } });
    expect(opt.columnFormats).toEqual({ a: [{ match: 'x', style: { badge: true } }] });
    expect(opt.columnCaptions).toEqual({ a: '取引先' });
    expect(opt.columnDisplayFormats).toEqual({ c: { type: 'number', grouping: true } });
    expect(opt.readOnly).toBe(false);
    expect(opt.readOnlyColumns).toEqual(['c']);
  });

  it('未指定なら undefined のまま渡す（grid 側で現行挙動＝既存 consumer 無影響）', () => {
    render(createElement(NanairoSheetView, standaloneProps()));
    const opt = h.instances[0]!.options;
    for (const key of ['columnTypes', 'columnFormats', 'columnCaptions', 'columnDisplayFormats', 'readOnly', 'readOnlyColumns']) {
      expect(opt[key], key).toBeUndefined();
    }
  });

  it('同値の新規リテラルでは remount せず、値が変われば remount する（識別系・値で直列化）', () => {
    const { rerender } = render(
      createElement(NanairoSheetView, standaloneProps({ readOnlyColumns: ['c'], columnTypes: { b: { type: 'date' } } })),
    );
    expect(h.instances).toHaveLength(1);

    // 同値の新規オブジェクト → remount しない。
    rerender(
      createElement(NanairoSheetView, standaloneProps({ readOnlyColumns: ['c'], columnTypes: { b: { type: 'date' } } })),
    );
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]!.destroyed).toBe(false);

    // 値が変わる → destroy → 新 instance。
    rerender(
      createElement(
        NanairoSheetView,
        standaloneProps({ readOnlyColumns: ['b', 'c'], columnTypes: { b: { type: 'date' } } }),
      ),
    );
    expect(h.instances).toHaveLength(2);
    expect(h.instances[0]!.destroyed).toBe(true);
    expect(h.instances[1]!.options.readOnlyColumns).toEqual(['b', 'c']);
  });

  it('Record のキー順・readOnlyColumns の並び順が違うだけでは remount しない（Codex P2・正準化）', () => {
    const { rerender } = render(
      createElement(
        NanairoSheetView,
        standaloneProps({
          columnTypes: { a: { type: 'select', options: ['x', 'y'] }, b: { type: 'date' } },
          columnCaptions: { a: 'A', b: 'B' },
          readOnlyColumns: ['c', 'b'],
        }),
      ),
    );
    rerender(
      createElement(
        NanairoSheetView,
        standaloneProps({
          columnTypes: { b: { type: 'date' }, a: { options: ['x', 'y'], type: 'select' } },
          columnCaptions: { b: 'B', a: 'A' },
          readOnlyColumns: ['b', 'c'],
        }),
      ),
    );
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]!.destroyed).toBe(false);
    // 候補の順序は意味を持つ＝入れ替えれば remount する。
    rerender(
      createElement(
        NanairoSheetView,
        standaloneProps({
          columnTypes: { a: { type: 'select', options: ['y', 'x'] }, b: { type: 'date' } },
          columnCaptions: { a: 'A', b: 'B' },
          readOnlyColumns: ['b', 'c'],
        }),
      ),
    );
    expect(h.instances).toHaveLength(2);
  });
});

describe('DD-035 ref handle の命令 API（AC7）', () => {
  it('insertRows/deleteRows/scrollToRow/setActiveCell が GridInstance へ引数そのままで直結する', () => {
    const ref = createRef<NanairoSheetViewHandle>();
    render(createElement(NanairoSheetView, { ref, ...standaloneProps() } as NanairoSheetViewProps & { ref: typeof ref }));
    const handle = ref.current!;
    expect(handle).toBeTruthy();

    handle.insertRows({ afterRowId: null, count: 2 });
    handle.deleteRows(['r1', 'r2']);
    handle.scrollToRow('r9');
    handle.setActiveCell('r9', 'b');

    expect(h.instances[0]!.calls).toEqual([
      { method: 'insertRows', args: [{ afterRowId: null, count: 2 }] },
      { method: 'deleteRows', args: [['r1', 'r2']] },
      { method: 'scrollToRow', args: ['r9'] },
      { method: 'setActiveCell', args: ['r9', 'b'] },
    ]);
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

    handle.insertRows({ afterRowId: null });
    handle.deleteRows(['r1']);
    handle.scrollToRow('r1');
    handle.setActiveCell('r1', 'a');

    expect(h.instances[0]!.calls).toEqual([]);
    expect(onDiagnostic).toHaveBeenCalledTimes(4);
    for (const call of onDiagnostic.mock.calls) {
      expect(call[0]).toMatchObject({ level: 'warn', code: 'handle-before-mount' });
    }
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
