// @vitest-environment jsdom
//
// React Facade（<NanairoSheetView>）の DD-049 追加分 unit（jsdom・grid mount() をモック）:
//   R1 GridEvent 'remote-change' → onRemoteChange(change)・'presence' → onPresenceChange(users)・onEvent には全種別
//   R2 callback を差し替えても remount しない（契約 §4 分類3）
//   R3 handle.presences は GridInstance.presences へ直結し、未 mount 時は [] で warn しない
// 既存の AC1〜AC7 は nanairo-sheet-view.test.ts / .dd035.test.ts / .dd036.test.ts（無修正）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, createRef } from 'react';
import { cleanup, render } from '@testing-library/react';

import type { GridEvent, GridPresenceUser, GridRemoteChange } from '@nanairo-sheet/grid';
import { NanairoSheetView, type NanairoSheetViewHandle, type NanairoSheetViewProps } from './index';

interface FakeInstance {
  options: { onEvent?: (event: GridEvent) => void };
  destroyed: boolean;
  users: readonly GridPresenceUser[];
  presences(): readonly GridPresenceUser[];
  connectionState(): string;
  destroy(): void;
  fire(event: GridEvent): void;
}

const h = vi.hoisted(() => ({ instances: [] as FakeInstance[] }));

vi.mock('@nanairo-sheet/grid', () => ({
  mount(_target: { container: HTMLElement }, options: FakeInstance['options']): FakeInstance {
    const inst: FakeInstance = {
      options,
      destroyed: false,
      users: [],
      presences() {
        return this.users;
      },
      connectionState() {
        return 'online';
      },
      destroy() {
        this.destroyed = true;
      },
      fire(event) {
        this.options.onEvent?.(event);
      },
    };
    h.instances.push(inst);
    return inst;
  },
}));

function collabProps(over: Partial<NanairoSheetViewProps> = {}): NanairoSheetViewProps {
  return { serverUrl: 'http://127.0.0.1:8787', displayName: 'Alice', ...over } as NanairoSheetViewProps;
}

const ALICE: GridPresenceUser = { userId: 'client-a', displayName: 'Alice', activeCell: { rowId: 'r1', columnId: 'c1' }, self: true };
const BOB: GridPresenceUser = { userId: 'user-b', displayName: 'Bob', activeCell: null, self: false };
const REMOTE: GridRemoteChange = {
  origin: 'remote',
  revision: 12,
  actorId: 'user-b',
  changes: [{ rowId: 'r1', columnId: 'c1', value: '100', previousValue: '' }],
};

beforeEach(() => {
  h.instances.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DD-049 remote-change / presence の callback 写像（AC6）', () => {
  it('remote-change → onRemoteChange(change)、presence → onPresenceChange(users)、onEvent には全種別が届く', () => {
    const onRemoteChange = vi.fn();
    const onPresenceChange = vi.fn();
    const onConnectionChange = vi.fn();
    const onCellCommit = vi.fn();
    const onEvent = vi.fn();
    render(
      createElement(NanairoSheetView, collabProps({ onRemoteChange, onPresenceChange, onConnectionChange, onCellCommit, onEvent })),
    );
    const inst = h.instances[0]!;

    inst.fire({ type: 'remote-change', change: REMOTE });
    inst.fire({ type: 'presence', users: [ALICE, BOB] });

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(onRemoteChange).toHaveBeenCalledWith(REMOTE);
    expect(onPresenceChange).toHaveBeenCalledTimes(1);
    expect(onPresenceChange).toHaveBeenCalledWith([ALICE, BOB]);
    expect(onEvent).toHaveBeenCalledTimes(2);
    // 別種別の callback へ漏れない（remote-change は cell-commit ではない）。
    expect(onConnectionChange).not.toHaveBeenCalled();
    expect(onCellCommit).not.toHaveBeenCalled();
  });

  it('callback を差し替えても remount せず、次のイベントで新しい callback を呼ぶ', () => {
    const remoteA = vi.fn();
    const remoteB = vi.fn();
    const presenceA = vi.fn();
    const presenceB = vi.fn();
    const { rerender } = render(
      createElement(NanairoSheetView, collabProps({ onRemoteChange: remoteA, onPresenceChange: presenceA })),
    );
    rerender(createElement(NanairoSheetView, collabProps({ onRemoteChange: remoteB, onPresenceChange: presenceB })));
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]!.destroyed).toBe(false);

    h.instances[0]!.fire({ type: 'remote-change', change: { ...REMOTE, origin: 'local', actorId: 'client-a' } });
    h.instances[0]!.fire({ type: 'presence', users: [ALICE] });
    expect(remoteA).not.toHaveBeenCalled();
    expect(presenceA).not.toHaveBeenCalled();
    expect(remoteB).toHaveBeenCalledTimes(1);
    expect(presenceB).toHaveBeenCalledWith([ALICE]);
  });

  it('callback 未指定でも onEvent の素通しは届く（例外にならない）', () => {
    const onEvent = vi.fn();
    render(createElement(NanairoSheetView, collabProps({ onEvent })));
    expect(() => {
      h.instances[0]!.fire({ type: 'remote-change', change: REMOTE });
      h.instances[0]!.fire({ type: 'presence', users: [] });
    }).not.toThrow();
    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});

describe('DD-049 ref handle presences（AC6）', () => {
  it('GridInstance.presences へ直結し、未 mount（unmount 後）は [] を返して warn しない', () => {
    const ref = createRef<NanairoSheetViewHandle>();
    const onDiagnostic = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { unmount } = render(
      createElement(NanairoSheetView, { ref, ...collabProps({ onDiagnostic }) } as NanairoSheetViewProps & {
        ref: typeof ref;
      }),
    );
    const handle = ref.current!;
    h.instances[0]!.users = [ALICE, BOB];
    expect(handle.presences()).toEqual([ALICE, BOB]);

    unmount();
    expect(handle.presences()).toEqual([]);
    expect(onDiagnostic).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
