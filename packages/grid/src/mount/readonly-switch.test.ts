// DD-065: 読み取り専用の切り替え（mount/readonly-switch.ts）を、grid を mount せずに確かめる。
// 変換の終わり待ち・編集の確定の許可・flush・destroy の後始末（DD-056 H12・contract.md §4）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDiagnosticSink } from '../diagnostics';
import type { GridDiagnostic } from '../diagnostics';
import type { GridBackend } from '../grid-backend';
import type { IntegrationEditor } from '../integration-editor';
import { createReadOnlySwitch } from './readonly-switch';

interface FakeState {
  composing: boolean;
  phase: string;
  editingTarget: object | null;
  pendingCount: number;
  stopped: boolean;
  destroyed: boolean;
}

function setup(initialReadOnly: unknown = false) {
  const state: FakeState = { composing: false, phase: 'Navigation', editingTarget: null, pendingCount: 0, stopped: false, destroyed: false };
  const calls: string[] = [];
  const diagnostics: GridDiagnostic[] = [];
  const editor = {
    session: {
      isComposing: () => state.composing,
      getPhase: () => state.phase,
      getEditingTarget: () => state.editingTarget,
    },
    commitEdit: () => {
      calls.push('commitEdit');
      if (state.composing) {
        return 'composing';
      }
      state.editingTarget = null;
      return 'committed';
    },
    setReadOnly: (value: boolean) => calls.push(`editor.setReadOnly(${value})`),
  } as unknown as IntegrationEditor;
  const backend = {
    session: {
      get isStopped() {
        return state.stopped;
      },
      get pendingCount() {
        return state.pendingCount;
      },
    },
    view: { markViewportDirty: () => calls.push('markViewportDirty') },
  } as unknown as GridBackend;
  const sw = createReadOnlySwitch({
    diag: createDiagnosticSink((entry) => diagnostics.push(entry)),
    initialReadOnly,
    isDestroyed: () => state.destroyed,
    backend: () => backend,
    editor: () => editor,
    closePopups: () => calls.push('closePopups'),
    syncCellLock: () => calls.push('syncCellLock'),
  });
  return { sw, state, calls, codes: () => diagnostics.map((d) => d.code) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('mount/readonly-switch: mount 時の値', () => {
  it('true なら読み取り専用で始め readonly-mode を出す。boolean でない値は編集可能側へ倒し readonly-invalid を出す', () => {
    expect(setup(true).sw.isReadOnly()).toBe(true);
    expect(setup(true).codes()).toEqual(['readonly-mode']);
    const invalid = setup('yes');
    expect(invalid.sw.isReadOnly()).toBe(false);
    expect(invalid.codes()).toEqual(['readonly-invalid']);
  });
});

describe('mount/readonly-switch: setReadOnly', () => {
  it('変換していなければ、編集中のセルを確定してから候補欄を閉じ、textarea まで読み取り専用にする', () => {
    const { sw, calls } = setup();
    sw.setReadOnly(true);
    expect(sw.isReadOnly()).toBe(true);
    expect(sw.isDeferred()).toBe(false);
    expect(calls.slice(0, 4)).toEqual(['commitEdit', 'closePopups', 'closePopups', 'editor.setReadOnly(true)']);
    expect(calls).toContain('syncCellLock');
  });

  it('変換中なら textarea に触れずに入口だけ止め、変換が終わった後の判定で確定して読み取り専用にする', () => {
    const { sw, state, calls } = setup();
    state.composing = true;
    state.phase = 'Composing';
    state.editingTarget = { cell: 'A1' };
    sw.setReadOnly(true);
    expect(sw.isReadOnly()).toBe(true);
    expect(sw.isDeferred()).toBe(true);
    expect(calls).toEqual(['closePopups', 'markViewportDirty']); // textarea（editor）には触れない
    // 変換が終わって状態の変化を受けた判定（macrotask）で、確定して読み取り専用にする。
    state.composing = false;
    state.phase = 'Editing';
    sw.scheduleEditStateCheck();
    vi.runOnlyPendingTimers();
    expect(sw.isDeferred()).toBe(false);
    expect(calls).toContain('editor.setReadOnly(true)');
  });

  it('変換の終わり待ちの間、送信の関所で通すのは切り替えを頼まれた時点の編集の確定 1 回だけ', () => {
    const { sw, state } = setup();
    const target = { cell: 'A1' };
    state.composing = true;
    state.phase = 'Composing';
    state.editingTarget = target;
    sw.setReadOnly(true);
    const seen: boolean[] = [];
    sw.runEditorCommit(() => seen.push(sw.isDeferredEditorCommit()));
    sw.runEditorCommit(() => seen.push(sw.isDeferredEditorCommit())); // 許可は 1 回で消費済み
    expect(seen).toEqual([true, false]);
    expect(sw.isDeferredEditorCommit()).toBe(false); // 送った後は関所を閉じる
  });

  it('false に戻すと変換の終わり待ちを取り消し、textarea の読み取り専用を外す', () => {
    const { sw, state, calls } = setup();
    state.composing = true;
    state.phase = 'Composing';
    sw.setReadOnly(true);
    sw.setReadOnly(false);
    expect(sw.isReadOnly()).toBe(false);
    expect(sw.isDeferred()).toBe(false);
    expect(calls).toContain('editor.setReadOnly(false)');
  });
});

describe('mount/readonly-switch: flush と destroy', () => {
  it('送るものが無ければすぐに flushed を返す', async () => {
    const { sw } = setup();
    await expect(sw.flush(undefined)).resolves.toEqual({ status: 'flushed' });
  });

  it('未送信が残っていれば待ち、上限を過ぎると timeout を返す', async () => {
    const { sw, state } = setup();
    state.pendingCount = 2;
    const result = sw.flush({ timeoutMs: 500 });
    vi.advanceTimersByTime(500);
    await expect(result).resolves.toEqual({ status: 'timeout', pendingCount: 2, editing: false });
  });

  it('destroy（dispose）は待っている flush を stopped ですぐに 1 回だけ解決し、タイマーを残さない', async () => {
    const { sw, state } = setup();
    state.pendingCount = 1;
    let settled = 0;
    const result = sw.flush({ timeoutMs: 60_000 }).then((r) => {
      settled += 1;
      return r;
    });
    sw.scheduleEditStateCheck(); // 判定の予約も残っている状態にする
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    state.destroyed = true;
    sw.dispose();
    await expect(result).resolves.toEqual({ status: 'stopped', pendingCount: 1 });
    expect(settled).toBe(1);
    expect(vi.getTimerCount()).toBe(0); // flush の待ちと判定の予約の両方が取り消されている
  });

  it('destroy の後の flush はすぐに stopped を返し、setReadOnly は何もしない', async () => {
    const { sw, state, calls } = setup();
    state.destroyed = true;
    await expect(sw.flush(undefined)).resolves.toEqual({ status: 'stopped', pendingCount: 0 });
    sw.setReadOnly(true);
    expect(sw.isReadOnly()).toBe(false);
    expect(calls).toEqual([]);
  });
});
