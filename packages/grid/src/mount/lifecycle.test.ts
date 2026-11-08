// @vitest-environment jsdom
// DD-065: 起動と再注入の配線を、Canvas・React・WebSocket サーバーなしで確かめる。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTextMetricsCache } from '@nanairo-sheet/render';
import { createColumnId, createRowId } from '@nanairo-sheet/types';

import { compileAppearance } from '../appearance';
import { createCellStatusStore } from '../cell-status';
import { createDiagnosticSink } from '../diagnostics';
import type { GridDiagnostic } from '../diagnostics';
import type { GridEvent, GridMountOptions } from '../index';
import { createLoadMetrics } from '../initial-load-metrics';
import { createUndoController } from '../undo-stack';
import { createLifecycle } from './lifecycle';

const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(options: GridMountOptions = { mode: 'standalone', columnOrder: ['a', 'b'] }) {
  const state = { destroyed: false };
  const abort = new AbortController();
  const events: GridEvent[] = [];
  const diagnostics: GridDiagnostic[] = [];
  const cellStatusStore = createCellStatusStore(undefined);
  const undoCtrl = createUndoController();
  const clearUndo = vi.spyOn(undoCtrl, 'clear');
  const build = vi.fn(() => true);
  const recordProgrammaticUndo = vi.fn();
  const refreshHoverStatus = vi.fn();
  const attachBackend = vi.fn(() => lifecycle.backend()?.start());
  const lifecycle = createLifecycle({
    options,
    isStandalone: options.mode === 'standalone',
    serverOrigin: 'http://localhost:9499',
    documentQuery: options.documentId === undefined ? '' : `?documentId=${encodeURIComponent(options.documentId)}`,
    wsUrl: 'ws://localhost:9499/ws',
    clientId: 'test-client',
    displayName: 'test-user',
    wrapEnabled: false,
    wrapColumns: [],
    stringColumns: [],
    stringColumnStrings: new Set(),
    cellTextCache: createTextMetricsCache((text) => text.length),
    signal: abort.signal,
    diag: createDiagnosticSink((entry) => diagnostics.push(entry)),
    metrics: createLoadMetrics(),
    undoCtrl,
    cellStatusStore,
    events: {
      emit: (event) => events.push(event),
      hasListeners: () => true,
      queueRemoteChange: () => {},
      flushRemoteChanges: () => {},
      refreshPresence: () => {},
    },
    config: { build, appearance: () => compileAppearance(undefined, [], () => true, () => undefined) },
    editSubmit: { recordPendingStandaloneUndo: () => {}, recordProgrammaticUndo },
    isDestroyed: () => state.destroyed,
    editor: () => undefined,
    scheduleEditStateCheck: () => {},
    refreshHoverStatus,
    attachBackend,
  });
  cleanups.push(() => {
    state.destroyed = true;
    lifecycle.stopTimers();
    abort.abort();
    lifecycle.closeTransport();
  });
  const value = (rowId: string, columnId = 'a') => lifecycle.backend()?.view.cellDisplay(createRowId(rowId), createColumnId(columnId));
  return { lifecycle, state, abort, events, diagnostics, cellStatusStore, clearUndo, build, recordProgrammaticUndo, refreshHoverStatus, attachBackend, value };
}

describe('mount/lifecycle: 起動と保留した再注入', () => {
  it('単独モードは同期 return の後の microtask で結線し、WS と tick を使わない', async () => {
    const setInterval = vi.spyOn(window, 'setInterval');
    const env = setup({ mode: 'standalone', documentId: 'local-book', columnOrder: ['a'] });
    env.lifecycle.start();
    expect(env.lifecycle.backend()).toBeUndefined();
    expect(env.attachBackend).not.toHaveBeenCalled();
    expect(env.lifecycle.connectionState()).toBe('standalone');
    await Promise.resolve();
    expect(env.attachBackend).toHaveBeenCalledOnce();
    expect(env.build).toHaveBeenCalledWith(['a']);
    expect(env.lifecycle.documentId()).toBe('local-book');
    expect(env.lifecycle.standalone()).toBe(env.lifecycle.backend());
    expect(env.lifecycle.transport()).toBeUndefined();
    expect(setInterval).not.toHaveBeenCalled();
  });

  it('boot 前の setRows → setData → setCellStatus → setRows を呼び出し順に再生する', async () => {
    const env = setup();
    env.lifecycle.setRows([{ rowId: 'old', cells: { a: 'discard' } }]);
    env.lifecycle.setData({ rows: [{ rowId: 'new', cells: { a: 'base' } }] });
    env.lifecycle.setCellStatus([{ rowId: 'new', cellStatus: { a: { level: 'warning' } } }]);
    env.lifecycle.setRows([{ rowId: 'new', cells: { a: 'last' } }]);
    expect(env.cellStatusStore.hasAny()).toBe(false);
    env.lifecycle.start();
    await Promise.resolve();
    expect(env.lifecycle.backend()?.session.committedDocument.rowOrder).toEqual([createRowId('new')]);
    expect(env.value('new')).toBe('last');
    expect(env.cellStatusStore.statusOf('new', 'a')).toEqual({ level: 'warning' });
    expect(env.clearUndo).toHaveBeenCalledOnce();
    expect(env.recordProgrammaticUndo).toHaveBeenCalledTimes(2);
    expect(env.events).toEqual([]); // プログラム的な再注入は cell-commit を発火しない
  });

  it('boot 前の setCellStatus の後に setData を呼ぶと、状態も新しい文書へ作り直す', async () => {
    const env = setup();
    env.lifecycle.setCellStatus([{ rowId: 'r1', cellStatus: { a: { level: 'error' } } }]);
    env.lifecycle.setData({ rows: [{ rowId: 'r1', cells: { a: 'new' } }] });
    env.lifecycle.start();
    await Promise.resolve();
    expect(env.value('r1')).toBe('new');
    expect(env.cellStatusStore.hasAny()).toBe(false);
  });

  it('JS 経路の不正な状態表示があっても、保留した後続の setData と setRows を失わない', async () => {
    const env = setup();
    Reflect.apply(env.lifecycle.setCellStatus, env.lifecycle, [null]);
    Reflect.apply(env.lifecycle.setCellStatus, env.lifecycle, [[null, { rowId: 42 }]]);
    env.lifecycle.setData({ rows: [{ rowId: 'r1', cells: { a: 'first' } }] });
    env.lifecycle.setRows([{ rowId: 'r1', cells: { a: 'last' } }]);
    env.lifecycle.start();
    await Promise.resolve();
    expect(env.value('r1')).toBe('last');
    expect(env.diagnostics.filter((entry) => entry.code === 'cell-status-invalid')).toHaveLength(2);
    expect(env.events).toEqual([]);
  });

  it('boot の microtask 前に destroy されたら、backend を作らず保留分も適用しない', async () => {
    const env = setup();
    env.lifecycle.setData({ rows: [{ rowId: 'r1' }] });
    env.lifecycle.start();
    env.state.destroyed = true;
    await Promise.resolve();
    expect(env.build).not.toHaveBeenCalled();
    expect(env.attachBackend).not.toHaveBeenCalled();
    expect(env.lifecycle.backend()).toBeUndefined();
    expect(env.events).toEqual([]);
  });

  it('設定の検証が失敗したら結線しない。結線の例外は runtime error として通知する', async () => {
    const invalid = setup();
    invalid.build.mockReturnValue(false);
    invalid.lifecycle.start();
    await Promise.resolve();
    expect(invalid.attachBackend).not.toHaveBeenCalled();
    expect(invalid.lifecycle.backend()).toBeUndefined();

    const fault = setup();
    fault.attachBackend.mockImplementation(() => { throw new Error('attach failed'); });
    fault.lifecycle.start();
    await Promise.resolve();
    expect(fault.events).toEqual([{ type: 'error', phase: 'runtime', code: 'runtime-fault', message: 'attach failed' }]);
  });
});

describe('mount/lifecycle: 共同編集の起動途中', () => {
  it('setData/setRows は診断だけにし、setCellStatus は boot を待たず view-local に保持する', () => {
    const env = setup({ serverUrl: 'http://localhost:9499' });
    env.lifecycle.setData({ rows: [{ rowId: 'r1' }] });
    env.lifecycle.setRows([{ rowId: 'r1' }]);
    env.lifecycle.setCellStatus([{ rowId: 'r1', cellStatus: { a: { level: 'error' } } }]);
    expect(env.lifecycle.connectionState()).toBe('offline');
    expect(env.diagnostics.map((entry) => entry.code)).toEqual(['setData', 'setRows']);
    expect(env.cellStatusStore.statusOf('r1', 'a')).toEqual({ level: 'error' });
    expect(env.refreshHoverStatus).toHaveBeenCalledOnce();
    env.state.destroyed = true;
    env.lifecycle.setCellStatus([{ rowId: 'r1', cellStatus: {} }]);
    expect(env.cellStatusStore.hasAny()).toBe(true);
  });

  it('config の HTTP エラーを公開 error に写し、tick interval を破棄時に解放する', async () => {
    const fetchConfig = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchConfig);
    const setInterval = vi.spyOn(window, 'setInterval');
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const env = setup({ serverUrl: 'http://localhost:9499', documentId: 'book/a' });
    env.lifecycle.start();
    await vi.waitFor(() => expect(env.events).toHaveLength(1));
    expect(fetchConfig).toHaveBeenCalledWith('http://localhost:9499/config?documentId=book%2Fa', { signal: env.abort.signal });
    expect(env.events[0]).toMatchObject({ type: 'error', phase: 'config', code: 'config-unavailable' });
    expect(env.attachBackend).not.toHaveBeenCalled();
    env.lifecycle.stopTimers();
    expect(clearInterval).toHaveBeenCalledWith(setInterval.mock.results[0]?.value);
  });

  it('config 取得中の destroy/abort をエラー通知せず、後から結線しない', async () => {
    const env = setup({ serverUrl: 'http://localhost:9499' });
    let rejectFetch: (reason: unknown) => void = () => {};
    const pending = new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
    vi.stubGlobal('fetch', vi.fn(() => pending));
    env.abort.signal.addEventListener('abort', () => rejectFetch(new DOMException('aborted', 'AbortError')));
    env.lifecycle.start();
    env.state.destroyed = true;
    env.abort.abort();
    await pending.catch(() => {});
    await Promise.resolve();
    expect(env.events).toEqual([]);
    expect(env.attachBackend).not.toHaveBeenCalled();
    expect(env.lifecycle.transport()).toBeUndefined();
  });
});
