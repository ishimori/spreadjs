import { describe, expect, it } from 'vitest';

import { createCounterIdGenerator } from '@nanairo-sheet/collab';
import type { SessionConfig, TransportListener } from '@nanairo-sheet/collab';
import {
  RecordingTransport,
  col,
  createManualClock,
  insertRows,
  operationsMessage,
  row,
  serverEnvelope,
  setCells,
  str,
} from '@nanairo-sheet/collab/test-support';
import type { ServerMessage } from '@nanairo-sheet/core';
import { createColumnId, createDocumentId } from '@nanairo-sheet/types';

import { createObservingTransport, createSessionSync } from './session-sync';

const COLUMN_ORDER = [createColumnId('col-0'), createColumnId('col-1'), createColumnId('col-2')];

function baseSessionConfig(): Omit<SessionConfig, 'transport'> {
  return {
    clientId: 'client-a',
    userId: 'user-a',
    displayName: 'A',
    documentId: createDocumentId('demo-doc'),
    columnOrder: COLUMN_ORDER,
    clock: createManualClock(),
    idGenerator: createCounterIdGenerator('a'),
  };
}

const welcome = (currentRevision: number): ServerMessage => ({
  type: 'welcome',
  sessionId: 'conn-1',
  colorKey: '0',
  currentRevision,
  capabilities: { protocolVersion: 1 },
});

describe('createObservingTransport（唯一の正本を先に更新する順序保証）', () => {
  it('handleServerMessage/Connected/Disconnected は session → observer の順', () => {
    const calls: string[] = [];
    const fakeSession: TransportListener = {
      handleServerMessage: () => calls.push('session-msg'),
      handleConnected: () => calls.push('session-conn'),
      handleDisconnected: () => calls.push('session-disc'),
    };
    const inner = new RecordingTransport();
    const observing = createObservingTransport(inner);
    observing.setListener(fakeSession);
    observing.setObserver({
      onServerMessage: () => calls.push('observer-msg'),
      onConnected: () => calls.push('observer-conn'),
      onDisconnected: () => calls.push('observer-disc'),
    });

    inner.connect();
    inner.receive({ type: 'heartbeatAck', serverTime: 0 });
    inner.drop();

    expect(calls).toEqual([
      'session-conn',
      'observer-conn',
      'session-msg',
      'observer-msg',
      'session-disc',
      'observer-disc',
    ]);
  });

  it('send は inner へ委譲する', () => {
    const inner = new RecordingTransport();
    const observing = createObservingTransport(inner);
    observing.setListener({
      handleServerMessage: () => {},
      handleConnected: () => {},
      handleDisconnected: () => {},
    });
    observing.send({ type: 'heartbeat', sentAt: 1 });
    expect(inner.sentOfType('heartbeat')).toHaveLength(1);
  });
});

describe('createSessionSync（ClientSession=正本・DocumentView=派生）', () => {
  it('start で join を送る', () => {
    const inner = new RecordingTransport();
    const sync = createSessionSync({ innerTransport: inner, sessionConfig: baseSessionConfig(), rowHeight: 20, colWidth: 60 });
    sync.start();
    expect(inner.sentOfType('join')).toHaveLength(1);
  });

  it('operations 受信 → view が構造＋セルを追従（適用後の文書を読む）', () => {
    const inner = new RecordingTransport();
    const sync = createSessionSync({ innerTransport: inner, sessionConfig: baseSessionConfig(), rowHeight: 20, colWidth: 60 });
    sync.start();
    inner.receive(welcome(2));
    inner.receive(
      operationsMessage([
        serverEnvelope({ revision: 1, operationId: 'op-ins', operation: insertRows(null, ['r0', 'r1', 'r2']) }),
        serverEnvelope({
          revision: 2,
          operationId: 'op-set',
          operation: setCells([{ rowId: row('r1'), columnId: col('col-0'), value: str('hi') }]),
        }),
      ]),
    );

    // 適用は session が完了済み。dirty を flush して Render State を整合させる。
    const result = sync.view.flush();
    expect(result.structuralRebuilt).toBe(true);
    expect(sync.view.rowAxis.count()).toBe(3);
    expect(sync.view.rowIndexOf(row('r1'))).toBe(1);
    const cells: Array<[number, number, string]> = [];
    sync.view.store.queryRange(0, 3, 0, 3, (r, c, v) => {
      cells.push([r, c, v]);
    });
    expect(cells).toEqual([[1, 0, 'hi']]);
    // committed（唯一の正本）と一致する view であること。
    expect(sync.session.committedDocument.revision).toBe(2);
  });

  it('SetCells だけの受信では rowAxis を再構築しない（#5）', () => {
    const inner = new RecordingTransport();
    const sync = createSessionSync({ innerTransport: inner, sessionConfig: baseSessionConfig(), rowHeight: 20, colWidth: 60 });
    sync.start();
    inner.receive(welcome(1));
    inner.receive(operationsMessage([serverEnvelope({ revision: 1, operationId: 'op-ins', operation: insertRows(null, ['r0', 'r1']) })]));
    sync.view.flush();
    const rebuilds = sync.view.structuralRebuildCount;
    const axis = sync.view.rowAxis;

    inner.receive(
      operationsMessage([
        serverEnvelope({
          revision: 2,
          operationId: 'op-set',
          operation: setCells([{ rowId: row('r0'), columnId: col('col-1'), value: str('v') }]),
        }),
      ]),
    );
    const result = sync.view.flush();
    expect(result.dirty.cell).toBe(true);
    expect(result.dirty['row-structure']).toBe(false);
    expect(sync.view.structuralRebuildCount).toBe(rebuilds); // 全再構築していない
    expect(sync.view.rowAxis).toBe(axis);
  });

  it('operationRejected 受信で cell dirty を立てる（rejected draft を Canvas に残さない・Codex P1）', () => {
    const inner = new RecordingTransport();
    const sync = createSessionSync({ innerTransport: inner, sessionConfig: baseSessionConfig(), rowHeight: 20, colWidth: 60 });
    sync.start();
    inner.receive(welcome(1));
    inner.receive(operationsMessage([serverEnvelope({ revision: 1, operationId: 'op-ins', operation: insertRows(null, ['r0', 'r1']) })]));
    sync.view.flush(); // 初期構造の dirty を消費
    expect(sync.view.isDirty()).toBe(false);

    // ローカル SetCells を楽観 submit（pending）→ サーバーが stale で reject。
    const opId = sync.session.submitLocalOperation(
      setCells([{ rowId: row('r0'), columnId: col('col-0'), beforeRevision: 0, value: str('A') }]),
    );
    sync.view.flush(); // submit 自体は session-sync 経由の dirty を立てない（main の onChange 側）
    inner.receive({ type: 'operationRejected', operationId: opId, code: 'stale-cell-revision' });

    const result = sync.view.flush();
    expect(result.dirty.cell).toBe(true); // reject で viewDocument が committed へ戻る → 可視範囲を描き直す
  });

  it('presenceDelta 受信で viewport dirty を立てる（overlay 再描画契機・シナリオ10/Codex P1）', () => {
    const inner = new RecordingTransport();
    const sync = createSessionSync({ innerTransport: inner, sessionConfig: baseSessionConfig(), rowHeight: 20, colWidth: 60 });
    sync.start();
    inner.receive(welcome(1));
    sync.view.flush();
    expect(sync.view.isDirty()).toBe(false);

    inner.receive({
      type: 'presenceDelta',
      presence: { connectionId: 'conn-b', colorKey: '1', sequence: 1, userId: 'user-b', displayName: 'B', selectionRanges: [] },
    });
    const result = sync.view.flush();
    expect(result.dirty.viewport).toBe(true); // 他者カーソル/名前タグの出現で overlay を描き直す
  });

  it('再接続で Render State を全再構築する（#10 再接続経路）', () => {
    const inner = new RecordingTransport();
    const sync = createSessionSync({ innerTransport: inner, sessionConfig: baseSessionConfig(), rowHeight: 20, colWidth: 60 });
    sync.start();
    inner.receive(welcome(1));
    inner.receive(operationsMessage([serverEnvelope({ revision: 1, operationId: 'op-ins', operation: insertRows(null, ['r0', 'r1']) })]));
    sync.view.flush();
    const rebuildsBefore = sync.view.structuralRebuildCount;

    // 切断 → 再接続。
    inner.drop();
    expect(sync.session.isOnline).toBe(false);
    inner.reconnect();
    expect(sync.session.isOnline).toBe(true);

    // 再接続直後の flush は構造再構築（Render State を Document State から作り直す）。
    const result = sync.view.flush();
    expect(result.structuralRebuilt).toBe(true);
    expect(sync.view.structuralRebuildCount).toBe(rebuildsBefore + 1);
    expect(sync.view.rowAxis.count()).toBe(2); // 現在の displayRowOrder から再構築
  });

  it('切断中の再接続で join を再送する（同一 clientId）', () => {
    const inner = new RecordingTransport();
    const sync = createSessionSync({ innerTransport: inner, sessionConfig: baseSessionConfig(), rowHeight: 20, colWidth: 60 });
    sync.start();
    inner.clear();
    inner.drop();
    inner.reconnect();
    const joins = inner.sentOfType('join');
    expect(joins).toHaveLength(1);
    expect(joins[0].clientId).toBe('client-a');
  });
});

describe('own-echo 判定（DD-020-3 Undo の記録源・DD-026-3 サーバー起点 op の非対象）', () => {
  it('onOwnSetCellsCommitted は自 clientId の SetCells echo だけで発火し、clientId "server"（サーバー起点）の op では発火しない', () => {
    const inner = new RecordingTransport();
    const committed: string[] = [];
    const sync = createSessionSync({
      innerTransport: inner,
      sessionConfig: baseSessionConfig(),
      rowHeight: 20,
      colWidth: 60,
      onOwnSetCellsCommitted: (operationId) => {
        committed.push(String(operationId));
      },
    });
    sync.start();
    inner.receive(welcome(3));
    inner.receive(
      operationsMessage([
        serverEnvelope({ revision: 1, operationId: 'op-ins', operation: insertRows(null, ['r0']) }),
        // サーバー起点操作（DD-026-3）: clientId='server'・actorId='system' の SetCells。
        serverEnvelope({
          revision: 2,
          operationId: 'op-server',
          clientId: 'server',
          actorId: 'system',
          operation: setCells([{ rowId: row('r0'), columnId: col('col-0'), value: str('SYS') }]),
        }),
        // 自分の SetCells の echo（Undo の ownedRevision 更新対象）。
        serverEnvelope({
          revision: 3,
          operationId: 'op-own',
          clientId: 'client-a',
          actorId: 'user-a',
          operation: setCells([{ rowId: row('r0'), columnId: col('col-1'), value: str('mine') }]),
        }),
      ]),
    );
    expect(sync.session.committedDocument.revision).toBe(3);
    expect(committed).toEqual(['op-own']); // 'op-server' は含まれない＝Undo 記録の対象外
  });
});
