// DD-049 H4（contract.md §3・§7 G1/G2）:
//   G1 受理済み op → 公開 GridRemoteChange の写像（SetCells のみ・cell-commit と同じ表示文字列・origin local/remote/server）。
//   G2 SessionSync.onServerMessageSettled は session の適用と Render State の dirty 立ての後に呼ばれ、その時点で
//      メッセージ内の受理済み op は onCommittedOperation へ全件通知済み（committed は最終 revision）。
// 共同編集モードの配線（キュー → settle で remote-change として配る）は playground E2E（remote-change.spec.ts）で検証する。

import { describe, expect, it } from 'vitest';

import { applyOperation, createDocument } from '@nanairo-sheet/core';
import type { DocumentOperation, ServerMessage, SheetDocument } from '@nanairo-sheet/core';
import { createCounterIdGenerator } from '@nanairo-sheet/collab';
import type { CommittedOperationEvent } from '@nanairo-sheet/collab';
import {
  RecordingTransport,
  col,
  createManualClock,
  deleteRows,
  insertRows,
  num,
  operationsMessage,
  row,
  serverEnvelope,
  setCells,
  str,
} from '@nanairo-sheet/collab/test-support';
import { createColumnId, createDocumentId } from '@nanairo-sheet/types';

import { SERVER_ORIGIN_CLIENT_ID, remoteChangeOrigin, toGridRemoteChange } from './remote-change';
import { createSessionSync } from './session-sync';

const COLUMN_ORDER = [createColumnId('col-0'), createColumnId('col-1')];

/** r0 行があり col-1 に 1200 が入っている文書（revision 2）。 */
function seededDocument(): SheetDocument {
  const inserted = applyOperation(createDocument(COLUMN_ORDER), insertRows(null, ['r0']), { revision: 1 }).document;
  return applyOperation(inserted, setCells([{ rowId: row('r0'), columnId: col('col-1'), value: num(1200) }]), { revision: 2 })
    .document;
}

function changeSetOf(operation: DocumentOperation): ReturnType<typeof applyOperation>['changeSet'] {
  return applyOperation(seededDocument(), operation, { revision: 3 }).changeSet;
}

describe('toGridRemoteChange（DD-049 H4・純関数）', () => {
  it('SetCells を cell-commit と同じ表示文字列の前後値へ写す（数値・日付・空・同一セルの逐次・changes 順）', () => {
    const operation = setCells([
      { rowId: row('r0'), columnId: col('col-0'), value: str('あ') },
      { rowId: row('r0'), columnId: col('col-1'), value: { kind: 'date', value: '2026-09-12' } },
      { rowId: row('r0'), columnId: col('col-0'), value: { kind: 'blank' } },
    ]);
    const envelope = serverEnvelope({ revision: 3, operationId: 'op-3', clientId: 'client-b', actorId: 'user-b', operation });
    expect(toGridRemoteChange(envelope, changeSetOf(operation), 'client-a')).toEqual({
      origin: 'remote',
      revision: 3,
      actorId: 'user-b',
      changes: [
        { rowId: 'r0', columnId: 'col-0', value: 'あ', previousValue: '' },
        { rowId: 'r0', columnId: 'col-1', value: '2026-09-12', previousValue: '1200' },
        { rowId: 'r0', columnId: 'col-0', value: '', previousValue: 'あ' },
      ],
    });
  });

  it('origin は自分の clientId＝local・予約 clientId "server"＝server・それ以外＝remote', () => {
    expect(SERVER_ORIGIN_CLIENT_ID).toBe('server'); // server-hono SERVER_CLIENT_ID（DD-026-3）と同値
    expect(remoteChangeOrigin('client-a', 'client-a')).toBe('local');
    expect(remoteChangeOrigin('server', 'client-a')).toBe('server');
    expect(remoteChangeOrigin('client-b', 'client-a')).toBe('remote');
    const operation = setCells([{ rowId: row('r0'), columnId: col('col-0'), value: str('SYS') }]);
    const change = toGridRemoteChange(
      serverEnvelope({ revision: 3, operationId: 'op-s', clientId: 'server', actorId: 'system', operation }),
      changeSetOf(operation),
      'client-a',
    );
    expect(change?.origin).toBe('server');
    expect(change?.actorId).toBe('system');
  });

  it('InsertRows / DeleteRows は対象外（undefined）', () => {
    const insert = insertRows(row('r0'), ['r1']);
    expect(
      toGridRemoteChange(serverEnvelope({ revision: 3, operationId: 'i', operation: insert }), changeSetOf(insert), 'client-a'),
    ).toBeUndefined();
    const remove = deleteRows([row('r0')]);
    expect(
      toGridRemoteChange(serverEnvelope({ revision: 3, operationId: 'd', operation: remove }), changeSetOf(remove), 'client-a'),
    ).toBeUndefined();
  });
});

describe('SessionSync.onServerMessageSettled（DD-049）', () => {
  it('session の適用と Render State の dirty 立ての後に呼ばれ、メッセージ内の受理済み op は全件通知済み', () => {
    const inner = new RecordingTransport();
    const committed: CommittedOperationEvent[] = [];
    const settled: Array<{ type: string; committedCount: number; revision: number; dirty: boolean }> = [];
    const sync = createSessionSync({
      innerTransport: inner,
      sessionConfig: {
        clientId: 'client-a',
        userId: 'user-a',
        displayName: 'A',
        documentId: createDocumentId('demo-doc'),
        columnOrder: COLUMN_ORDER,
        clock: createManualClock(),
        idGenerator: createCounterIdGenerator('a'),
        onCommittedOperation: (event) => {
          committed.push(event);
        },
      },
      rowHeight: 20,
      colWidth: 60,
      onServerMessageSettled: (message: ServerMessage) => {
        settled.push({
          type: message.type,
          committedCount: committed.length,
          revision: sync.session.committedDocument.revision,
          dirty: sync.view.isDirty(),
        });
      },
    });
    sync.start();
    inner.receive({ type: 'welcome', sessionId: 'conn-1', colorKey: '0', currentRevision: 0, capabilities: { protocolVersion: 1 } });
    sync.view.flush(); // 初期構造の dirty を消費（以降の dirty は operations 由来）
    expect(sync.view.isDirty()).toBe(false);

    inner.receive(
      operationsMessage([
        serverEnvelope({ revision: 1, operationId: 'op-ins', operation: insertRows(null, ['r0']) }),
        serverEnvelope({
          revision: 2,
          operationId: 'op-set',
          clientId: 'client-b',
          operation: setCells([{ rowId: row('r0'), columnId: col('col-0'), value: str('hi') }]),
        }),
      ]),
    );
    expect(settled.map((s) => s.type)).toEqual(['welcome', 'operations']);
    expect(settled[1]).toEqual({ type: 'operations', committedCount: 2, revision: 2, dirty: true });
  });
});
