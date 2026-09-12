// DD-049 H4（contract.md §3・§7 C1〜C3）: ClientSession.onCommittedOperation の単体検証。
//   C1 他クライアントの op（SetCells・InsertRows）が committed に入るたび 1 回。callback 時点で committed は当該 revision、
//      ChangeSet は before/after を持つ。
//   C2 自分の op は楽観適用中・ACK 時点では届かず、echo で committed に入った時点で届く。reject・revalidation-failed で
//      消えた楽観適用は届かない。
//   C3 snapshot bootstrap（fresh join）では届かず、その後の tail は届く。重複配信は 1 回・順不同到着は revision 昇順・
//      再接続の tail catch-up は届く。
// callback 未指定の既存挙動（observer のイベント列）は既存スイート（session-events.test.ts 等）が無修正で担保する。

import { describe, expect, it } from 'vitest';

import { applyOperation, createDocument, serializeDocument } from '@nanairo-sheet/core';
import type { ServerMessage } from '@nanairo-sheet/core';
import { createDocumentId } from '@nanairo-sheet/types';

import { createCounterIdGenerator } from './deps';
import { ClientSession } from './session';
import type { CommittedOperationEvent } from './session';
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

interface Harness {
  session: ClientSession;
  transport: RecordingTransport;
  events: CommittedOperationEvent[];
  /** callback 時点の committed revision・pending 件数（rebuild 後に呼ばれていることの確認）。 */
  observed: Array<{ committedRevision: number; pendingCount: number }>;
}

function createHarness(): Harness {
  const transport = new RecordingTransport();
  const events: CommittedOperationEvent[] = [];
  const observed: Harness['observed'] = [];
  const session: ClientSession = new ClientSession({
    clientId: 'cA',
    userId: 'user-a',
    displayName: 'Alice',
    documentId: createDocumentId('doc-1'),
    columnOrder: COLUMNS,
    transport,
    clock: createManualClock(),
    idGenerator: createCounterIdGenerator('op'),
    onCommittedOperation: (event) => {
      events.push(event);
      observed.push({ committedRevision: session.committedDocument.revision, pendingCount: session.pendingCount });
    },
  });
  return { session, transport, events, observed };
}

function welcome(currentRevision: number, sessionId = 'conn-a'): ServerMessage {
  return { type: 'welcome', sessionId, colorKey: 'k', currentRevision, capabilities: { protocolVersion: 1 } };
}

function revisions(h: Harness): number[] {
  return h.events.map((e) => e.envelope.revision);
}

/** fresh join（welcome 0）＋ seed 行（revision 1）まで進めた harness。 */
function joinedHarness(): Harness {
  const h = createHarness();
  h.session.start();
  h.transport.receive(welcome(0));
  h.transport.receive(
    operationsMessage([serverEnvelope({ revision: 1, operationId: 'seed', operation: insertRows(null, ['row-1']) })]),
  );
  return h;
}

describe('ClientSession.onCommittedOperation（DD-049 H4）', () => {
  it('C1: 他クライアントの op が committed に入るたび 1 回・rebuild 後に呼ばれ、ChangeSet は before/after を持つ', () => {
    const h = createHarness();
    h.session.start();
    h.transport.receive(welcome(0));
    h.transport.receive(
      operationsMessage([
        serverEnvelope({ revision: 1, operationId: 'seed', operation: insertRows(null, ['row-1']) }),
        serverEnvelope({
          revision: 2,
          operationId: 'other-1',
          operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]),
        }),
        serverEnvelope({
          revision: 3,
          operationId: 'other-2',
          operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('y') }]),
        }),
      ]),
    );
    expect(revisions(h)).toEqual([1, 2, 3]);
    expect(h.observed.map((o) => o.committedRevision)).toEqual([1, 2, 3]);
    expect(h.events[0]?.changeSet.rowsInserted).toEqual(['row-1']);
    expect(h.events[1]?.changeSet.cells).toEqual([
      { rowId: 'row-1', columnId: 'col-a', before: { kind: 'blank' }, after: { kind: 'string', value: 'x' } },
    ]);
    expect(h.events[2]?.changeSet.cells).toEqual([
      { rowId: 'row-1', columnId: 'col-a', before: { kind: 'string', value: 'x' }, after: { kind: 'string', value: 'y' } },
    ]);
  });

  it('C2: 自分の op は楽観適用中・ACK 時点では届かず、echo で committed に入った時点で届く（pending は除去済み）', () => {
    const h = joinedHarness();
    const operation = setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('mine') }]);
    const operationId = h.session.submitLocalOperation(operation);
    expect(revisions(h)).toEqual([1]); // 楽観適用だけでは届かない
    h.transport.receive({ type: 'operationAck', operationId, revision: 2 });
    expect(revisions(h)).toEqual([1]); // ACK だけでも届かない（committed 未反映）
    h.transport.receive(
      operationsMessage([
        serverEnvelope({
          revision: 2,
          operationId: String(operationId),
          clientId: 'cA',
          actorId: 'user-a',
          clientSequence: 1,
          operation,
        }),
      ]),
    );
    expect(revisions(h)).toEqual([1, 2]);
    expect(h.events[1]?.envelope.clientId).toBe('cA');
    expect(h.observed[1]?.pendingCount).toBe(0);
  });

  it('C2: reject・revalidation-failed で消えた楽観適用は届かない（他者の op だけが届く）', () => {
    const h = joinedHarness();
    h.transport.receive(
      operationsMessage([
        serverEnvelope({
          revision: 2,
          operationId: 'base',
          operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('base') }]),
        }),
      ]),
    );
    // (a) サーバー reject
    const rejectedId = h.session.submitLocalOperation(
      setCells([{ rowId: row('row-1'), columnId: col('col-b'), value: str('rejected') }]),
    );
    h.transport.receive({ type: 'operationRejected', operationId: rejectedId, code: 'stale-cell-revision' });
    // (b) 他者の後続変更で再検証失敗（beforeRevision=2 のまま、他者が同じセルを revision 3 で更新）
    h.session.submitLocalOperation(
      setCells([{ rowId: row('row-1'), columnId: col('col-a'), beforeRevision: 2, value: str('stale') }]),
    );
    h.transport.receive(
      operationsMessage([
        serverEnvelope({
          revision: 3,
          operationId: 'other',
          operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('theirs') }]),
        }),
      ]),
    );
    expect(h.session.conflictQueue.map((c) => c.reason)).toEqual(['rejected', 'revalidation-failed']);
    expect(revisions(h)).toEqual([1, 2, 3]);
    expect(h.events.every((e) => e.envelope.clientId !== 'cA')).toBe(true);
  });

  it('C3: snapshot bootstrap（fresh join）で確立した状態は届かず、その後の tail は届く', () => {
    const h = createHarness();
    h.session.start();
    let document = createDocument(COLUMNS);
    document = applyOperation(document, insertRows(null, ['row-1']), { revision: 4 }).document;
    document = applyOperation(
      document,
      setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('snap') }]),
      { revision: 5 },
    ).document;
    h.transport.receive(welcome(5));
    h.transport.receive({ type: 'bootstrap', document: serializeDocument(document), revision: 5 });
    expect(h.session.committedDocument.revision).toBe(5);
    expect(revisions(h)).toEqual([]);
    h.transport.receive(
      operationsMessage([
        serverEnvelope({
          revision: 6,
          operationId: 'tail',
          operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('after') }]),
        }),
      ]),
    );
    expect(revisions(h)).toEqual([6]);
    expect(h.events[0]?.changeSet.cells[0]?.before).toEqual({ kind: 'string', value: 'snap' });
  });

  it('C3: 重複配信は 1 回・順不同到着は revision 昇順で届く', () => {
    const h = joinedHarness();
    const second = serverEnvelope({
      revision: 2,
      operationId: 'op-2',
      operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('2') }]),
    });
    const third = serverEnvelope({
      revision: 3,
      operationId: 'op-3',
      operation: setCells([{ rowId: row('row-1'), columnId: col('col-b'), value: str('3') }]),
    });
    h.transport.receive(operationsMessage([third])); // 欠番（2 が未着）→ buffer に留まり届かない
    expect(revisions(h)).toEqual([1]);
    h.transport.receive(operationsMessage([second]));
    expect(revisions(h)).toEqual([1, 2, 3]);
    h.transport.receive(operationsMessage([second, third])); // 重複配信は無視
    expect(revisions(h)).toEqual([1, 2, 3]);
  });

  it('C3: 再接続の tail catch-up で受け取った op は届く', () => {
    const h = joinedHarness();
    h.transport.drop();
    h.transport.reconnect();
    h.transport.receive(welcome(3, 'conn-a2'));
    expect(h.transport.sentOfType('requestCatchup').length).toBeGreaterThan(0);
    h.transport.receive(
      operationsMessage([
        serverEnvelope({
          revision: 2,
          operationId: 'missed-2',
          operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('m2') }]),
        }),
        serverEnvelope({
          revision: 3,
          operationId: 'missed-3',
          operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('m3') }]),
        }),
      ]),
    );
    expect(revisions(h)).toEqual([1, 2, 3]);
  });
});
