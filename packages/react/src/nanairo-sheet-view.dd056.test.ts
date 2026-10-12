// @vitest-environment jsdom
//
// React Facade（<NanairoSheetView>）の DD-056-2 追加分 unit（jsdom・grid mount() をモック）:
//   AC7 readOnly は識別系から外れ、値が変わっても開き直さず同じ instance の setReadOnly を呼ぶ／初回 mount と、他の識別系の変化で
//       開き直した直後は呼ばない（mount 自体が現在の値で作られる）
//   AC7 ref handle の pendingCount・flush が GridInstance へ直結し、未 mount は 0／{ status: 'flushed' }（warn しない）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, createRef } from 'react';
import { cleanup, render } from '@testing-library/react';

import { NanairoSheetView, type NanairoSheetViewHandle, type NanairoSheetViewProps } from './index';

interface FakeInstance {
  options: Record<string, unknown>;
  destroyed: boolean;
  calls: Array<{ method: string; args: unknown[] }>;
  setReadOnly(readOnly: boolean): void;
  pendingCount(): number;
  flush(options?: unknown): Promise<unknown>;
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
      setReadOnly(readOnly) {
        this.calls.push({ method: 'setReadOnly', args: [readOnly] });
      },
      pendingCount() {
        this.calls.push({ method: 'pendingCount', args: [] });
        return 3;
      },
      flush(flushOptions) {
        this.calls.push({ method: 'flush', args: [flushOptions] });
        return Promise.resolve({ status: 'timeout', pendingCount: 3, editing: false });
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

const setReadOnlyCalls = (inst: FakeInstance | undefined): unknown[] =>
  (inst?.calls ?? []).filter((c) => c.method === 'setReadOnly').map((c) => c.args[0]);

beforeEach(() => {
  h.instances.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DD-056 readOnly は開き直さずに切り替える（AC7）', () => {
  it('readOnly が変わっても remount せず、同じ instance の setReadOnly を呼ぶ（初回 mount では呼ばない）', () => {
    const { rerender } = render(createElement(NanairoSheetView, standaloneProps({ readOnly: false })));
    expect(h.instances).toHaveLength(1);
    expect(setReadOnlyCalls(h.instances[0])).toEqual([]); // mount 自体が readOnly=false で作られている

    rerender(createElement(NanairoSheetView, standaloneProps({ readOnly: true })));
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]!.destroyed).toBe(false);
    expect(setReadOnlyCalls(h.instances[0])).toEqual([true]);

    rerender(createElement(NanairoSheetView, standaloneProps({ readOnly: true }))); // 同値 → 呼ばない
    rerender(createElement(NanairoSheetView, standaloneProps({}))); // 未指定 = false
    expect(h.instances).toHaveLength(1);
    expect(setReadOnlyCalls(h.instances[0])).toEqual([true, false]);
  });

  it('readOnly=true で mount した場合も初回は呼ばず、mount オプションへ写す', () => {
    render(createElement(NanairoSheetView, standaloneProps({ readOnly: true })));
    expect(h.instances[0]!.options.readOnly).toBe(true);
    expect(setReadOnlyCalls(h.instances[0])).toEqual([]);
  });

  it('他の識別系 props と同時に変わって開き直すときは、新しい mount が現在の readOnly で作られ setReadOnly は呼ばれない', () => {
    const { rerender } = render(createElement(NanairoSheetView, standaloneProps({ readOnly: false, wrapColumns: ['a'] })));
    rerender(createElement(NanairoSheetView, standaloneProps({ readOnly: true, wrapColumns: ['b'] })));
    expect(h.instances).toHaveLength(2);
    expect(h.instances[0]!.destroyed).toBe(true);
    expect(h.instances[1]!.options.readOnly).toBe(true);
    expect(setReadOnlyCalls(h.instances[1])).toEqual([]);
    expect(setReadOnlyCalls(h.instances[0])).toEqual([]);

    // その後の readOnly だけの変化は、新しい instance の setReadOnly で写す。
    rerender(createElement(NanairoSheetView, standaloneProps({ readOnly: false, wrapColumns: ['b'] })));
    expect(h.instances).toHaveLength(2);
    expect(setReadOnlyCalls(h.instances[1])).toEqual([false]);
  });
});

describe('DD-056 ref handle の pendingCount・flush（AC7）', () => {
  it('GridInstance へ直結する', async () => {
    const ref = createRef<NanairoSheetViewHandle>();
    render(createElement(NanairoSheetView, { ...standaloneProps(), ref }));
    expect(ref.current?.pendingCount()).toBe(3);
    await expect(ref.current?.flush({ timeoutMs: 500 })).resolves.toEqual({ status: 'timeout', pendingCount: 3, editing: false });
    expect(h.instances[0]!.calls.find((c) => c.method === 'flush')?.args).toEqual([{ timeoutMs: 500 }]);
  });

  it('未 mount（unmount 後）は 0／flushed を返し、warn しない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ref = createRef<NanairoSheetViewHandle>();
    const { unmount } = render(createElement(NanairoSheetView, { ...standaloneProps(), ref }));
    const handle = ref.current;
    unmount();
    expect(handle?.pendingCount()).toBe(0);
    await expect(handle?.flush()).resolves.toEqual({ status: 'flushed' });
    expect(warn).not.toHaveBeenCalled();
  });
});
