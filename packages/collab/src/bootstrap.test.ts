// クライアント snapshot bootstrap（DD-014-1・P1-6/P1-7・AC1/AC8）。
// fresh join は welcome＋bootstrap（document@R）で committed を確立し、全 operationLog を replay しない
// （appliedServerOpCount が 0 のまま committed が R に到達＝全 replay 非依存）。tail は bootstrap 後に適用する。

import { applyOperation, createDocument, documentHash, serializeDocument } from '@nanairo-sheet/core';
import type { BootstrapMessage, DocumentSnapshot, SheetDocument } from '@nanairo-sheet/core';
import { createDocumentId } from '@nanairo-sheet/types';
import { describe, expect, it } from 'vitest';

import { createCounterIdGenerator } from './deps';
import { ClientSession } from './session';
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
}

function createSession(): Harness {
  const clock = createManualClock();
  const transport = new RecordingTransport();
  const session = new ClientSession({
    clientId: 'cA',
    userId: 'user-a',
    displayName: 'Alice',
    documentId: createDocumentId('doc-1'),
    columnOrder: COLUMNS,
    transport,
    clock,
    idGenerator: createCounterIdGenerator('op'),
  });
  return { session, transport, clock };
}

/** N 行 × 各行 1 セルの権威文書を組み、bootstrap 用 snapshot を作る（サーバーの document@R 相当）。 */
function buildAuthoritativeDocument(rowCount: number): { doc: SheetDocument; snapshot: DocumentSnapshot; revision: number } {
  let doc = createDocument([...COLUMNS]);
  let revision = 0;
  // 1 op で全行挿入（bulk・大規模構築でも Θ(N²) を避ける）。
  revision += 1;
  doc = applyOperation(
    doc,
    insertRows(
      null,
      Array.from({ length: rowCount }, (_, i) => `row-${i + 1}`),
    ),
    { revision },
  ).document;
  // 1 op で全セルを set（bulk）。
  revision += 1;
  doc = applyOperation(
    doc,
    setCells(
      Array.from({ length: rowCount }, (_, i) => ({
        rowId: row(`row-${i + 1}`),
        columnId: col('col-a'),
        value: str(`v${i + 1}`),
      })),
    ),
    { revision },
  ).document;
  return { doc, snapshot: serializeDocument(doc), revision };
}

function welcome(revision: number) {
  return { type: 'welcome' as const, sessionId: 'conn-1', currentRevision: revision, colorKey: 'color-0', capabilities: { protocolVersion: 1 } };
}
function bootstrap(snapshot: DocumentSnapshot, revision: number): BootstrapMessage {
  return { type: 'bootstrap', document: snapshot, revision };
}

describe('クライアント snapshot bootstrap（DD-014-1・P1-6/P1-7）', () => {
  it('AC1: fresh join は bootstrap で committed を確立し全 operationLog を replay しない（appliedServerOpCount=0）', () => {
    const h = createSession();
    const { doc, snapshot, revision } = buildAuthoritativeDocument(5_000); // 大規模文書（bulk 構築でハングしない）
    h.session.start();
    h.transport.receive(welcome(revision)); // awaitingBootstrap ゆえ catch-up を発行しない
    expect(h.transport.sentOfType('requestCatchup')).toHaveLength(0); // ★ 全 replay 経路（catch-up→全 log）を発行しない
    h.transport.receive(bootstrap(snapshot, revision));

    // committed は snapshot@R へ一致（hash 一致）。適用したサーバー op は 0 件＝全 replay 非依存。
    expect(h.session.committedDocument.revision).toBe(revision);
    expect(h.session.committedHash()).toBe(documentHash(doc));
    expect(h.session.appliedServerOpCount).toBe(0); // ★ AC1: 全 operationLog（2 bulk op でも）を 1 件も replay していない
    expect(h.session.bootstrapRevision).toBe(revision);
    expect(h.session.nextExpectedRevision).toBe(revision + 1);
  });

  it('bootstrap 後に到着する tail（R+1..）だけを適用する（committed が前進）', () => {
    const h = createSession();
    const { doc, snapshot, revision } = buildAuthoritativeDocument(3);
    h.session.start();
    h.transport.receive(welcome(revision));
    h.transport.receive(bootstrap(snapshot, revision));
    expect(h.session.appliedServerOpCount).toBe(0);

    // tail: 他クライアントが row-1.col-b を更新（revision R+1）。
    h.transport.receive(
      operationsMessage([
        serverEnvelope({ revision: revision + 1, operationId: 'tail-1', operation: setCells([{ rowId: row('row-1'), columnId: col('col-b'), value: str('tail') }]) }),
      ]),
    );
    expect(h.session.committedDocument.revision).toBe(revision + 1);
    expect(h.session.appliedServerOpCount).toBe(1); // tail の 1 件のみ
    // bootstrap の doc に tail を素直に適用した参照と hash 一致。
    const ref = applyOperation(doc, setCells([{ rowId: row('row-1'), columnId: col('col-b'), value: str('tail') }]), { revision: revision + 1 }).document;
    expect(h.session.committedHash()).toBe(documentHash(ref));
  });

  it('welcome より先に bootstrap 到達順が入れ替わっても committed を確立する（buffer 破棄で二重適用0）', () => {
    const h = createSession();
    const { snapshot, revision } = buildAuthoritativeDocument(3);
    h.session.start();
    // tail が bootstrap より先着（buffer へ）。
    h.transport.receive(welcome(revision));
    h.transport.receive(
      operationsMessage([
        serverEnvelope({ revision: revision + 1, operationId: 'tail-1', operation: setCells([{ rowId: row('row-1'), columnId: col('col-b'), value: str('t') }]) }),
      ]),
    );
    expect(h.session.committedDocument.revision).toBe(0); // まだ bootstrap 未達＝buffer 保留
    h.transport.receive(bootstrap(snapshot, revision));
    // bootstrap で R 確立 → buffer の R+1 が drain される。
    expect(h.session.committedDocument.revision).toBe(revision + 1);
    expect(h.session.appliedServerOpCount).toBe(1);
  });

  it('P1-B: bootstrap は ACK 済み pending を除去する（成功済み op を誤って Conflict Queue に送らない・Codex）', () => {
    const h = createSession();
    h.session.start();
    h.transport.receive(welcome(0)); // 空文書で接続開始（awaitingBootstrap は 0>0=false で解除）
    // online で op を submit → ACK 受領（サーバー accepted）だが operations エコー未達（committed 未前進）。
    const opId = h.session.submitLocalOperation(insertRows(null, ['row-1']));
    h.transport.receive({ type: 'operationAck', operationId: opId, revision: 1 });
    expect(h.session.pendingCount).toBe(1); // acknowledged だが echo 未達ゆえ committed 未前進で保持

    // 切断 → 再接続（committed.revision=0・pending 1 のまま fresh join）。
    h.transport.drop();
    h.transport.reconnect(); // sendJoin: committed.revision===0 → awaitingBootstrap=true

    // サーバーは accepted 済みの op を含む document@1 を bootstrap（op envelope は運ばない）。
    let doc = createDocument([...COLUMNS]);
    doc = applyOperation(doc, insertRows(null, ['row-1']), { revision: 1 }).document;
    h.transport.receive(welcome(1));
    h.transport.receive(bootstrap(serializeDocument(doc), 1));

    // ACK 済み pending が除去され committed@1 が確立（duplicate-row で Conflict Queue へ誤送しない）。
    expect(h.session.pendingCount).toBe(0);
    expect(h.session.conflictQueue).toHaveLength(0);
    expect(h.session.committedDocument.revision).toBe(1);
    expect(h.session.committedHash()).toBe(documentHash(doc));
  });

  it('空文書（R=0）の fresh join は bootstrap 無しで通常同期する（後方互換）', () => {
    const h = createSession();
    h.session.start();
    h.transport.receive(welcome(0)); // R=0 → server は bootstrap を送らない
    // 通常の operations 経路で committed が前進する。
    h.transport.receive(operationsMessage([serverEnvelope({ revision: 1, operationId: 's1', operation: insertRows(null, ['row-1']) })]));
    expect(h.session.committedDocument.revision).toBe(1);
    expect(h.session.bootstrapRevision).toBeUndefined();
    expect(h.session.appliedServerOpCount).toBe(1);
  });
});

describe('初期文書 document@0 の bootstrap@0（DD-026-1）', () => {
  it('committed 0 かつ未 bootstrap のとき bootstrap@0 を受理し、以後の重複 bootstrap@0 は無視、op は revision 1 から連続適用', () => {
    const h = createSession();
    h.session.start();
    h.transport.receive(welcome(0)); // frontier 0 だが文書は非空（server が bootstrap@0 を送る）
    const initial = applyOperation(createDocument([...COLUMNS]), insertRows(null, ['row-1']), { revision: 0 }).document;
    h.transport.receive(bootstrap(serializeDocument(initial), 0));
    expect(h.session.committedDocument.rowOrder.map(String)).toEqual(['row-1']);
    expect(h.session.committedDocument.revision).toBe(0);
    expect(h.session.bootstrapRevision).toBe(0);
    expect(h.session.isOnline).toBe(true);

    // 再接続などで届く重複 bootstrap@0 は無視する（committed は不変）。
    const other = applyOperation(createDocument([...COLUMNS]), insertRows(null, ['row-X']), { revision: 0 }).document;
    h.transport.receive(bootstrap(serializeDocument(other), 0));
    expect(h.session.committedDocument.rowOrder.map(String)).toEqual(['row-1']);

    h.transport.receive(
      operationsMessage([
        serverEnvelope({ revision: 1, operationId: 's1', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('v') }]) }),
      ]),
    );
    expect(h.session.committedDocument.revision).toBe(1);
    expect(h.session.nextExpectedRevision).toBe(2);
  });
});
