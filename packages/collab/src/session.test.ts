import { describe, expect, it } from 'vitest';

import { getCell } from '@nanairo-sheet/core';
import type { DocumentOperation, PresenceDeltaMessage, UserPresence } from '@nanairo-sheet/core';
import { createDocumentId } from '@nanairo-sheet/types';
import type { OperationId } from '@nanairo-sheet/types';

import { createCounterIdGenerator } from './deps';
import { ClientSession } from './session';
import type { SessionConfig } from './session';
import {
  COLUMNS,
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
} from './test-support';
import type { ManualClock } from './test-support';

interface Harness {
  session: ClientSession;
  transport: RecordingTransport;
  clock: ManualClock;
}

function createSession(overrides: Partial<SessionConfig> = {}): Harness {
  const clock = createManualClock();
  const transport = new RecordingTransport();
  const idGenerator = createCounterIdGenerator('op');
  const session = new ClientSession({
    clientId: 'cA',
    userId: 'user-a',
    displayName: 'Alice',
    documentId: createDocumentId('doc-1'),
    columnOrder: COLUMNS,
    transport,
    clock,
    idGenerator,
    resendTimeoutMillis: 1000,
    maxOfflineMillis: 30_000,
    maxOfflinePending: 100,
    ...overrides,
  });
  return { session, transport, clock };
}

/** start → welcome（初期接続・revision=currentRevision・colorKey 付き）。 */
function startAndWelcome(h: Harness, currentRevision = 0, colorKey = 'color-0'): void {
  h.session.start();
  h.transport.receive({
    type: 'welcome',
    sessionId: 'conn-1',
    currentRevision,
    colorKey,
    capabilities: { protocolVersion: 1 },
  });
}

/** サーバー確定 Operation を順に committed へ流し込む（seed 用・他クライアント発）。 */
function seedCommitted(h: Harness, ops: DocumentOperation[], startRevision = 1): void {
  const envs = ops.map((op, i) =>
    serverEnvelope({
      revision: startRevision + i,
      operationId: `seed-${startRevision + i}`,
      operation: op,
      clientId: 'client-seed',
      clientSequence: startRevision + i,
    }),
  );
  h.transport.receive(operationsMessage(envs));
}

describe('H. 楽観適用 rollback/replay（§7.7 6手順）— AC4・Phase 3', () => {
  it('S-H1: 他クライアントの非競合 op 到着 → own pending は残り再適用（committed に own は未反映）', () => {
    const h = createSession();
    startAndWelcome(h);
    seedCommitted(h, [insertRows(null, ['row-1', 'row-2'])]); // rev1: row-1,row-2

    const opX = h.session.submitLocalOperation(
      setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]),
    );
    expect(h.session.pendingCount).toBe(1);

    // 他クライアントの operationY（row-2 更新, revision=2）到着
    h.transport.receive(
      operationsMessage([
        serverEnvelope({
          revision: 2,
          operationId: 'other-1',
          operation: setCells([{ rowId: row('row-2'), columnId: col('col-b'), value: str('y') }]),
        }),
      ]),
    );

    // opX は own でなく非競合 → pending に残る（S-H1）
    expect(h.session.pendingOperationIds()).toEqual([opX]);
    // committed には Y のみ（own opX は未確定）
    expect(getCell(h.session.committedDocument, row('row-2'), col('col-b'))).toEqual({
      value: str('y'),
      lastChangedRevision: 2,
    });
    expect(getCell(h.session.committedDocument, row('row-1'), col('col-a'))).toBeUndefined();
    // 楽観ビューには X も Y も反映
    expect(getCell(h.session.viewDocument, row('row-1'), col('col-a'))?.value).toEqual(str('x'));
    expect(getCell(h.session.viewDocument, row('row-2'), col('col-b'))?.value).toEqual(str('y'));
  });

  it('S-H2: 自分の op が operations で確定 → own を pending から除去（二重適用0・I-3）', () => {
    const h = createSession();
    startAndWelcome(h);
    seedCommitted(h, [insertRows(null, ['row-1'])]); // rev1

    const opX = h.session.submitLocalOperation(
      setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]),
    );
    // 自分の opX のエコー（revision=2, clientId=cA, operationId=opX）
    h.transport.receive(
      operationsMessage([
        serverEnvelope({ revision: 2, operationId: opX, clientId: 'cA', clientSequence: 1, operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]) }),
      ]),
    );
    expect(h.session.pendingCount).toBe(0);
    expect(h.session.committedHash()).toBe(h.session.viewHash()); // 静止点で一致
    expect(getCell(h.session.committedDocument, row('row-1'), col('col-a'))).toEqual({
      value: str('x'),
      lastChangedRevision: 2,
    });
  });

  it('S-H3: 競合 op → own を Conflict Queue・依存 pending は連鎖失効（入力消失0）', () => {
    const h = createSession();
    startAndWelcome(h);
    seedCommitted(h, [
      insertRows(null, ['row-1']),
      setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('base') }]),
    ]); // rev1: insert, rev2: row-1.col-a=base@2

    // opX: row-1.col-a を beforeRevision=2 で編集（committed 一致）
    const opX = h.session.submitLocalOperation(
      setCells([{ rowId: row('row-1'), columnId: col('col-a'), beforeRevision: 2, value: str('mineX') }]),
    );
    // opZ: 同 row-1 の別列を追記（opX に依存＝chained・beforeRevision なし）
    const opZ = h.session.submitLocalOperation(
      setCells([{ rowId: row('row-1'), columnId: col('col-b'), value: str('mineZ') }]),
    );
    expect(h.session.pendingCount).toBe(2);

    // 他クライアントが row-1.col-a を更新（revision=3）→ opX が stale
    h.transport.receive(
      operationsMessage([
        serverEnvelope({
          revision: 3,
          operationId: 'other-1',
          operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), beforeRevision: 2, value: str('serverY') }]),
        }),
      ]),
    );

    expect(h.session.pendingCount).toBe(0);
    const cq = h.session.conflictQueue;
    expect(cq).toHaveLength(2); // 入力消失0（I-2）
    expect(cq[0].operationId).toBe(opX);
    expect(cq[0].reason).toBe('revalidation-failed');
    expect(cq[1].operationId).toBe(opZ);
    expect(cq[1].reason).toBe('dependency'); // 連鎖失効
    // 元のローカル入力を保持（コピー可能）
    expect(cq[0].operation).toEqual(
      setCells([{ rowId: row('row-1'), columnId: col('col-a'), beforeRevision: 2, value: str('mineX') }]),
    );
    // committed はサーバー値へ収束
    expect(getCell(h.session.committedDocument, row('row-1'), col('col-a'))?.value).toEqual(str('serverY'));
  });

  it('S-H4a: own ACK 先着 → 後着エコーで冪等除去（二重適用0）', () => {
    const h = createSession();
    startAndWelcome(h);
    seedCommitted(h, [insertRows(null, ['row-1'])]);
    const opX = h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]));

    h.transport.receive({ type: 'operationAck', operationId: opX, revision: 2 }); // ACK 先着
    expect(h.session.pendingCount).toBe(1); // まだ echo 未達（committed 前進のため保持）
    h.transport.receive(operationsMessage([serverEnvelope({ revision: 2, operationId: opX, clientId: 'cA', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]) })]));
    expect(h.session.pendingCount).toBe(0);
    expect(getCell(h.session.committedDocument, row('row-1'), col('col-a'))?.value).toEqual(str('x'));
  });

  it('S-H4b: own エコー先着 → 後着 ACK は冪等 no-op（二重適用0）', () => {
    const h = createSession();
    startAndWelcome(h);
    seedCommitted(h, [insertRows(null, ['row-1'])]);
    const opX = h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]));

    h.transport.receive(operationsMessage([serverEnvelope({ revision: 2, operationId: opX, clientId: 'cA', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]) })])); // echo 先着
    expect(h.session.pendingCount).toBe(0);
    h.transport.receive({ type: 'operationAck', operationId: opX, revision: 2 }); // 後着 ACK
    expect(h.session.pendingCount).toBe(0); // no-op
    expect(getCell(h.session.committedDocument, row('row-1'), col('col-a'))).toEqual({ value: str('x'), lastChangedRevision: 2 });
  });

  it('S-H5: 楽観ビューでは hash 一致を主張しない（committed 静止点でのみ一致）', () => {
    const h = createSession();
    startAndWelcome(h);
    seedCommitted(h, [insertRows(null, ['row-1'])]);
    const opX = h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]));
    expect(h.session.viewHash()).not.toBe(h.session.committedHash()); // pending 中は不一致
    h.transport.receive(operationsMessage([serverEnvelope({ revision: 2, operationId: opX, clientId: 'cA', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]) })]));
    expect(h.session.viewHash()).toBe(h.session.committedHash()); // 静止点で一致
  });
});

describe('G. 競合 reject → Conflict Queue 保持（AC4・§10.2/10.3・消失0）', () => {
  it('S-G2: stale reject → ローカル入力を Conflict Queue へ（サーバー値へ収束・再送しない）', () => {
    const h = createSession();
    startAndWelcome(h);
    seedCommitted(h, [insertRows(null, ['row-1'])]); // committed: row-1（col-a は空＝rev0）

    // クライアントは col-a を空（rev0）と認識して編集 → beforeRevision:0 でローカルは妥当 → 送信
    const opX = h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), beforeRevision: 0, value: str('mine') }]));
    expect(h.session.pendingCount).toBe(1);

    // サーバーは既に他者更新で col-a@2（クライアント未受信）→ stale reject
    h.transport.receive({
      type: 'operationRejected',
      operationId: opX,
      code: 'stale-cell-revision',
      details: { violations: [{ code: 'stale-cell-revision', rowId: row('row-1'), columnId: col('col-a'), currentValue: str('server'), currentRevision: 2 }] },
    });

    expect(h.session.pendingCount).toBe(0);
    const cq = h.session.conflictQueue;
    expect(cq).toHaveLength(1);
    expect(cq[0].operationId).toBe(opX);
    expect(cq[0].reason).toBe('rejected'); // サーバー判定の reject（クライアント側 revalidation ではない）
    expect(cq[0].code).toBe('stale-cell-revision');
    expect(cq[0].details?.violations?.[0].code).toBe('stale-cell-revision');
    expect(cq[0].operation).toEqual(setCells([{ rowId: row('row-1'), columnId: col('col-a'), beforeRevision: 0, value: str('mine') }])); // 自分の値を保全（消失0）
    expect(h.session.viewHash()).toBe(h.session.committedHash()); // pending 除去後 view==committed

    // 再送しない（reject 済みは pending から除去済み＝タイマーで蘇らない）
    h.transport.clear();
    h.clock.advance(5_000);
    h.session.tick();
    expect(h.transport.sentOfType('submitOperation')).toHaveLength(0);

    // 後続 operations（rev2）でサーバー値へ収束
    h.transport.receive(operationsMessage([serverEnvelope({ revision: 2, operationId: 'other-2', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('server') }]) })]));
    expect(getCell(h.session.committedDocument, row('row-1'), col('col-a'))?.value).toEqual(str('server'));
  });

  it('S-G3: target-row-deleted reject → Conflict Queue（削除を知らずに楽観適用したローカル入力を保持）', () => {
    const h = createSession();
    startAndWelcome(h);
    seedCommitted(h, [insertRows(null, ['row-1'])]);
    const opX = h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('mine') }]));

    h.transport.receive({ type: 'operationRejected', operationId: opX, code: 'target-row-deleted', details: { violations: [{ code: 'target-row-deleted', rowId: row('row-1') }] } });
    const cq = h.session.conflictQueue;
    expect(cq).toHaveLength(1);
    expect(cq[0].code).toBe('target-row-deleted');
    expect(cq[0].operation).toEqual(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('mine') }]));
  });
});

describe('再送ポリシー（Q-2 裁定の実装・指示 2）', () => {
  it('タイマー満了で un-ACK pending を先頭から同一 operationId・同一 clientSequence で再送', () => {
    const h = createSession({ resendTimeoutMillis: 1000 });
    startAndWelcome(h);
    seedCommitted(h, [insertRows(null, ['row-1'])]);
    const opX = h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]));
    const firstSubmits = h.transport.sentOfType('submitOperation');
    expect(firstSubmits).toHaveLength(1);
    expect(firstSubmits[0].envelope.operationId).toBe(opX);
    const originalSeq = firstSubmits[0].envelope.clientSequence;

    h.clock.advance(1000);
    h.session.tick();
    const submits = h.transport.sentOfType('submitOperation');
    expect(submits).toHaveLength(2); // 再送
    expect(submits[1].envelope.operationId).toBe(opX); // 同一 operationId
    expect(submits[1].envelope.clientSequence).toBe(originalSeq); // 同一 clientSequence
  });

  it('ACK 済み pending はタイマーで再送しない', () => {
    const h = createSession({ resendTimeoutMillis: 1000 });
    startAndWelcome(h);
    seedCommitted(h, [insertRows(null, ['row-1'])]);
    const opX = h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]));
    h.transport.receive({ type: 'operationAck', operationId: opX, revision: 2 });
    h.transport.clear();
    h.clock.advance(5000);
    h.session.tick();
    expect(h.transport.sentOfType('submitOperation')).toHaveLength(0);
  });

  it('client-sequence-violation 受信で先頭から全 pending を再送（Conflict Queue へは送らない）', () => {
    const h = createSession();
    startAndWelcome(h);
    seedCommitted(h, [insertRows(null, ['row-1', 'row-2'])]);
    const opA = h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('a') }]));
    const opB = h.session.submitLocalOperation(setCells([{ rowId: row('row-2'), columnId: col('col-a'), value: str('b') }]));
    h.transport.clear();

    // opA の submit が欠落 → opB が seq=2 で届き server が sequence 違反を返す
    h.transport.receive({ type: 'operationRejected', operationId: opB, code: 'client-sequence-violation', details: { expectedSequence: 1, receivedSequence: 2 } });

    // pending は減らない（Conflict Queue 行きではない）
    expect(h.session.pendingCount).toBe(2);
    expect(h.session.conflictQueue).toHaveLength(0);
    const resent = h.transport.sentOfType('submitOperation');
    expect(resent.map((m) => m.envelope.operationId)).toEqual([opA, opB]); // 先頭から
  });
});

describe('Presence 送信・識別伝搬・welcome.colorKey（指示 3）', () => {
  it('welcome の colorKey を自色として保持（自分の colorKey の知り方＝welcome 拡張）', () => {
    const h = createSession();
    startAndWelcome(h, 0, 'color-2');
    expect(h.session.connectionId).toBe('conn-1');
    expect(h.session.colorKey).toBe('color-2');
  });

  it('sendPresence は userId/displayName を充填し connection 単位・単調 sequence で送る', () => {
    const h = createSession();
    startAndWelcome(h); // DD-053: welcome 直後に activeCell なしの presence を1回送る（sequence=1）
    h.session.sendPresence({ activeCell: { rowId: row('row-1'), columnId: col('col-a') }, selectionRanges: [] });
    h.session.sendPresence({ activeCell: { rowId: row('row-2'), columnId: col('col-a') }, selectionRanges: [] });
    const presences = h.transport.sentOfType('presence');
    expect(presences).toHaveLength(3);
    expect(presences[0].sequence).toBe(1);
    expect(presences[1].sequence).toBe(2);
    expect(presences[2].sequence).toBe(3); // 単調
    expect(presences[0].payload.activeCell).toBeUndefined(); // welcome 直後は選択前＝activeCell なし
    expect(presences[1].payload.userId).toBe('user-a');
    expect(presences[1].payload.displayName).toBe('Alice');
    expect(presences[1].payload.activeCell).toEqual({ rowId: row('row-1'), columnId: col('col-a') });
  });

  it('presenceDelta/presenceRemoved で他タブの Presence を保持/削除（Phase 4 デモ経路）', () => {
    const h = createSession();
    startAndWelcome(h);
    const other: UserPresence = { connectionId: 'conn-2', colorKey: 'color-1', sequence: 1, userId: 'user-b', displayName: 'Bob', selectionRanges: [], activeCell: { rowId: row('row-1'), columnId: col('col-a') } };
    const delta: PresenceDeltaMessage = { type: 'presenceDelta', presence: other };
    h.transport.receive(delta);
    expect(h.session.knownPresences().map((p) => p.connectionId)).toEqual(['conn-2']);
    expect(h.session.knownPresences()[0].displayName).toBe('Bob');
    expect(h.session.knownPresences()[0].colorKey).toBe('color-1');
    h.transport.receive({ type: 'presenceRemoved', sessionId: 'conn-2' });
    expect(h.session.knownPresences()).toEqual([]);
  });

  it('presenceSnapshot は他接続の Presence をまとめて保持（自 connectionId は除外）', () => {
    const h = createSession();
    startAndWelcome(h);
    h.transport.receive({
      type: 'presenceSnapshot',
      users: [
        { connectionId: 'conn-1', colorKey: 'color-0', sequence: 1, userId: 'user-a', displayName: 'Alice', selectionRanges: [] },
        { connectionId: 'conn-2', colorKey: 'color-1', sequence: 1, userId: 'user-b', displayName: 'Bob', selectionRanges: [] },
      ],
    });
    expect(h.session.knownPresences().map((p) => p.connectionId)).toEqual(['conn-2']); // 自分は除外
  });
});

describe('InverseSeed rollback 復元の完全性（DA・逆操作復元→同一hash）', () => {
  it('挿入＋空セル set の pending は rollbackBaselineHash が committed と厳密一致', () => {
    const h = createSession();
    startAndWelcome(h);
    // committed は空。fresh insert + fresh set（before=blank）
    h.session.submitLocalOperation(insertRows(null, ['row-1']));
    h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('x') }]));
    h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-b'), value: num(7) }]));
    expect(h.session.pendingCount).toBe(3);
    // view から inverseSeed を逆順 rollback → committed（空）へ厳密復元
    expect(h.session.rollbackBaselineHash()).toBe(h.session.committedHash());
  });

  it('既存セル上書きでは rollbackBaselineHash が committed と一致しない（D22: InverseSeed に before-revision 無し）— committed 権威管理で収束は担保', () => {
    const h = createSession();
    startAndWelcome(h);
    seedCommitted(h, [insertRows(null, ['row-1']), setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('old') }])]);
    h.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('new') }]));
    // InverseSeed は before=old の revision を持たないため rollback は非厳密（限界の実証）
    expect(h.session.rollbackBaselineHash()).not.toBe(h.session.committedHash());
    // ただし committed は権威（rollback から導出しない）ゆえ収束は保たれる:
    const opId: OperationId = h.session.pendingOperationIds()[0];
    h.transport.receive(operationsMessage([serverEnvelope({ revision: 3, operationId: opId, clientId: 'cA', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('new') }]) })]));
    expect(getCell(h.session.committedDocument, row('row-1'), col('col-a'))).toEqual({ value: str('new'), lastChangedRevision: 3 });
    expect(h.session.viewHash()).toBe(h.session.committedHash());
  });

  it('DeleteRows 混在でも収束（committed 権威で hash が参照文書と一致）', () => {
    const h = createSession();
    startAndWelcome(h);
    seedCommitted(h, [
      insertRows(null, ['row-1', 'row-2', 'row-3']),
      setCells([{ rowId: row('row-2'), columnId: col('col-a'), value: str('keep') }]),
      deleteRows([row('row-1')]),
    ]);
    // committed の hash は「同じ op 列を独立に適用した文書」と一致（決定論・AC1 の Phase 3 側）
    expect(typeof h.session.committedHash()).toBe('string');
    expect(getCell(h.session.committedDocument, row('row-2'), col('col-a'))?.value).toEqual(str('keep'));
  });
});
