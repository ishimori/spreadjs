// DD-015 Phase 1（要確認③）: イベント通知契約の単体検証。接続状態（online/offline/stopped）・pending 件数・
// reject 発生が observer へ通知され、冗長発火しないこと、offline 上限超過で stopped 通知＋編集停止することを固定する。

import { describe, expect, it } from 'vitest';

import { getCell } from '@nanairo-sheet/core';
import { createDocumentId } from '@nanairo-sheet/types';

import { createCounterIdGenerator } from './deps';
import { ClientSession } from './session';
import type { SessionConfig, SessionEvent } from './session';
import {
  COLUMNS,
  RecordingTransport,
  col,
  createManualClock,
  insertRows,
  operationsMessage,
  row,
  serverEnvelope,
  setCells,
  str,
} from './test-support';
import type { ManualClock } from './test-support';

interface Harness {
  session: ClientSession;
  transport: RecordingTransport;
  clock: ManualClock;
  events: SessionEvent[];
}

function createSession(overrides: Partial<SessionConfig> = {}): Harness {
  const clock = createManualClock();
  const transport = new RecordingTransport();
  const events: SessionEvent[] = [];
  const session = new ClientSession({
    clientId: 'cA',
    userId: 'user-a',
    displayName: 'Alice',
    documentId: createDocumentId('doc-1'),
    columnOrder: COLUMNS,
    transport,
    clock,
    idGenerator: createCounterIdGenerator('op'),
    resendTimeoutMillis: 1000,
    maxOfflineMillis: 30_000,
    maxOfflinePending: 100,
    observer: (event) => events.push(event),
    ...overrides,
  });
  return { session, transport, clock, events };
}

function connectionStates(events: SessionEvent[]): string[] {
  return events.filter((e) => e.type === 'connection').map((e) => (e as { state: string }).state);
}

describe('DD-015 イベント通知契約 — connection / pending / rejected', () => {
  it('connect で online・drop で offline・再接続で online（冗長発火なし）', () => {
    const h = createSession();
    h.session.start(); // connect → handleConnected
    h.transport.receive({ type: 'welcome', sessionId: 'c1', currentRevision: 0, colorKey: 'k', capabilities: { protocolVersion: 1 } });
    h.transport.drop();
    h.transport.reconnect();

    expect(connectionStates(h.events)).toEqual(['online', 'offline', 'online']);
  });

  it('submit で pending 増、ACK 済み echo で pending 減が通知される', () => {
    const h = createSession();
    h.session.start();
    h.transport.receive({ type: 'welcome', sessionId: 'c1', currentRevision: 0, colorKey: 'k', capabilities: { protocolVersion: 1 } });
    h.transport.receive(operationsMessage([serverEnvelope({ revision: 1, operationId: 'seed-1', operation: insertRows(null, ['row-1']) })]));

    const opId = h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]));
    const pendingUp = h.events.filter((e) => e.type === 'pending').map((e) => (e as { pendingCount: number }).pendingCount);
    expect(pendingUp).toContain(1); // 1 件へ増加

    // server が echo（own op を revision 2 で確定）→ pending 0 へ
    h.transport.receive(operationsMessage([serverEnvelope({ revision: 2, operationId: String(opId), operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]), clientId: 'cA', clientSequence: 1 })]));
    const pendingCounts = h.events.filter((e) => e.type === 'pending').map((e) => (e as { pendingCount: number }).pendingCount);
    expect(pendingCounts[pendingCounts.length - 1]).toBe(0); // 最終的に 0
    expect(h.session.pendingCount).toBe(0);
  });

  it('server reject で rejected イベントが発火し元 operation を保持する', () => {
    const h = createSession();
    h.session.start();
    h.transport.receive({ type: 'welcome', sessionId: 'c1', currentRevision: 0, colorKey: 'k', capabilities: { protocolVersion: 1 } });
    h.transport.receive(operationsMessage([
      serverEnvelope({ revision: 1, operationId: 'seed-1', operation: insertRows(null, ['row-1']) }),
      serverEnvelope({ revision: 2, operationId: 'seed-2', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('base') }]) }),
    ]));
    const opId = h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), beforeRevision: 2, value: str('mine') }]));
    h.transport.receive({ type: 'operationRejected', operationId: opId, code: 'stale-cell-revision', details: {} });

    const rejected = h.events.filter((e) => e.type === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as { entry: { operationId: string } }).entry.operationId).toBe(String(opId));
  });

  it('offline 上限（時間）超過で stopped 通知＋編集停止（submit throw・リトライは継続＝接続イベントは stopped）', () => {
    const h = createSession({ maxOfflineMillis: 30_000 });
    h.session.start();
    h.transport.receive({ type: 'welcome', sessionId: 'c1', currentRevision: 0, colorKey: 'k', capabilities: { protocolVersion: 1 } });
    h.transport.receive(operationsMessage([serverEnvelope({ revision: 1, operationId: 'seed-1', operation: insertRows(null, ['row-1']) })]));
    h.transport.drop();
    h.clock.advance(30_001);
    h.session.tick();

    expect(connectionStates(h.events)).toEqual(['online', 'offline', 'stopped']);
    expect(h.session.isStopped).toBe(true);
    expect(() => h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]))).toThrow();
  });

  it('observer 未指定でも動作する（通知なし・回帰）', () => {
    const clock = createManualClock();
    const transport = new RecordingTransport();
    const session = new ClientSession({
      clientId: 'cA', userId: 'u', displayName: 'A', documentId: createDocumentId('doc-1'),
      columnOrder: COLUMNS, transport, clock, idGenerator: createCounterIdGenerator('op'),
    });
    session.start();
    transport.receive({ type: 'welcome', sessionId: 'c1', currentRevision: 0, colorKey: 'k', capabilities: { protocolVersion: 1 } });
    expect(session.isOnline).toBe(true); // throw しない
  });
});

describe('DD-070-5: 拒否の通知の時点と初回の状態', () => {
  it('rejected を受けた購読者がその場で読む view には、拒否した値が残らない（view を作り直してから知らせる）', () => {
    const seen: string[] = [];
    const ref: { session?: ClientSession } = {};
    const h = createSession({
      observer: (event) => {
        if (event.type === 'rejected' && ref.session !== undefined) {
          const record = getCell(ref.session.viewDocument, row('row-1'), col('col-a'));
          seen.push(record === undefined ? '' : String((record.value as { value?: unknown }).value ?? ''));
        }
      },
    });
    ref.session = h.session;
    h.session.start();
    h.transport.receive({ type: 'welcome', sessionId: 'c1', currentRevision: 0, colorKey: 'k', capabilities: { protocolVersion: 1 } });
    h.transport.receive(operationsMessage([
      serverEnvelope({ revision: 1, operationId: 'seed-1', operation: insertRows(null, ['row-1']) }),
      serverEnvelope({ revision: 2, operationId: 'seed-2', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('base') }]) }),
    ]));
    const opId = h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), beforeRevision: 2, value: str('mine') }]));
    h.transport.receive({ type: 'operationRejected', operationId: opId, code: 'stale-cell-revision', details: {} });
    expect(seen).toEqual(['base']);
  });

  it('hasInitialState: welcome の前は false。空の文書（bootstrap 不要）なら welcome で true、一度立ったら再接続中も true', () => {
    const h = createSession();
    expect(h.session.hasInitialState).toBe(false);
    h.session.start();
    expect(h.session.hasInitialState).toBe(false);
    h.transport.receive({ type: 'welcome', sessionId: 'c1', currentRevision: 0, colorKey: 'k', capabilities: { protocolVersion: 1 } });
    expect(h.session.hasInitialState).toBe(true);
    h.transport.drop();
    expect(h.session.hasInitialState).toBe(true);
  });

  it('hasInitialState: 既存の文書へ初めて入るときは bootstrap を受け取るまで false', () => {
    const h = createSession();
    h.session.start();
    h.transport.receive({ type: 'welcome', sessionId: 'c1', currentRevision: 3, colorKey: 'k', capabilities: { protocolVersion: 1 } });
    expect(h.session.hasInitialState).toBe(false);
  });
});
