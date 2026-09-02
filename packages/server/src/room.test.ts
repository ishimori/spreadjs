import { describe, expect, it } from 'vitest';

import type {
  JoinMessage,
  OperationsMessage,
  PresenceDeltaMessage,
  PresencePayload,
  PresenceRemovedMessage,
  PresenceSnapshotMessage,
  ServerMessage,
  WelcomeMessage,
} from '@nanairo-sheet/core';
import { applyOperation } from '@nanairo-sheet/core';
import { createDocumentId } from '@nanairo-sheet/types';

import { createCounterIdGenerator } from './deps';
import { Room } from './room';
import type { Outbound } from './room';
import { Sequencer, freshSequencerState } from './sequencer';
import { COLUMNS, col, createManualClock, envelope, insertRows, row } from './test-support';
import type { ManualClock } from './test-support';

function createTestRoom(ttlMillis = 15_000): { room: Room; clock: ManualClock; sequencer: Sequencer } {
  const clock = createManualClock();
  const sequencer = new Sequencer(freshSequencerState(COLUMNS), clock);
  const room = new Room(sequencer, { clock, idGenerator: createCounterIdGenerator(), ttlMillis });
  return { room, clock, sequencer };
}

const join = (clientId: string, lastAppliedRevision = 0): JoinMessage => ({
  type: 'join',
  protocolVersion: 1,
  documentId: createDocumentId('doc-1'),
  lastAppliedRevision,
  clientId,
});

const presencePayload = (overrides: Partial<PresencePayload> = {}): PresencePayload => ({
  userId: overrides.userId ?? 'user-1',
  displayName: overrides.displayName ?? 'Alice',
  activeCell: overrides.activeCell,
  selectionRanges: overrides.selectionRanges ?? [],
  editingCell: overrides.editingCell,
});

// ユーザー定義型ガード（P02 許容）: 総称 T の判別ユニオン絞り込みを表現する。
function isMessageOfType<T extends ServerMessage['type']>(
  item: Outbound,
  type: T,
): item is Outbound & { message: Extract<ServerMessage, { type: T }> } {
  return item.message.type === type;
}

function messagesOfType<T extends ServerMessage['type']>(
  outbound: Outbound[],
  type: T,
): Array<Extract<ServerMessage, { type: T }>> {
  const result: Array<Extract<ServerMessage, { type: T }>> = [];
  for (const item of outbound) {
    if (isMessageOfType(item, type)) {
      result.push(item.message);
    }
  }
  return result;
}

function firstOfType<T extends ServerMessage['type']>(
  outbound: Outbound[],
  type: T,
): Extract<ServerMessage, { type: T }> {
  const list = messagesOfType(outbound, type);
  if (list.length === 0) {
    throw new Error(`no ${type} message in outbound`);
  }
  return list[0];
}

describe('Room join（§8.2・S-L1）', () => {
  it('connectionId を払い出し welcome＋presenceSnapshot を送信元へ返す', () => {
    const { room } = createTestRoom();
    const { connectionId, outbound } = room.handleJoin(join('cA'));
    expect(connectionId).toBe('conn-1'); // 決定的 idGenerator
    const welcome: WelcomeMessage = firstOfType(outbound, 'welcome');
    expect(welcome.sessionId).toBe('conn-1');
    expect(welcome.currentRevision).toBe(0);
    const snapshot: PresenceSnapshotMessage = firstOfType(outbound, 'presenceSnapshot');
    expect(snapshot.users).toEqual([]); // まだ誰も presence を送っていない
    // 宛先はすべて自分（connection）
    for (const item of outbound) {
      expect(item.target).toEqual({ kind: 'connection', connectionId: 'conn-1' });
    }
  });

  it('lastAppliedRevision 以降の operations だけを返す（R+1..current）', () => {
    const { room, sequencer } = createTestRoom();
    sequencer.submit(envelope({ clientId: 'setup', clientSequence: 1, operationId: 's1', operation: insertRows(null, ['row-1']) })); // rev=1
    sequencer.submit(envelope({ clientId: 'setup', clientSequence: 2, operationId: 's2', operation: insertRows(row('row-1'), ['row-2']) })); // rev=2
    const { outbound } = room.handleJoin(join('cA', 1)); // lastApplied=1 → rev>1 のみ
    const ops: OperationsMessage = firstOfType(outbound, 'operations');
    expect(ops.operations.map((e) => e.revision)).toEqual([2]);
    expect(ops.fromRevision).toBe(2);
    expect(ops.toRevision).toBe(2);
  });

  it('DD-014-1 AC1: 非空文書への fresh join（lastApplied=0）は bootstrap（document@R）を返し全 operationLog を送らない', () => {
    const { room, sequencer } = createTestRoom();
    for (let i = 1; i <= 4; i += 1) {
      sequencer.submit(envelope({ clientId: 'setup', clientSequence: i, operationId: `s${i}`, operation: insertRows(null, [`row-${i}`]) }));
    }
    const { outbound } = room.handleJoin(join('cA', 0));
    const boot = messagesOfType(outbound, 'bootstrap');
    expect(boot).toHaveLength(1);
    expect(boot[0].revision).toBe(4); // = currentRevision（frontier）
    expect(messagesOfType(outbound, 'operations')).toHaveLength(0); // ★ 全 replay 経路（operationLog 全送出）が残っていない
  });
});

describe('Room submitOperation ルーティング（S-H4 エコー）', () => {
  it('accepted は ACK を送信元へ・operations を全接続へエコー', () => {
    const { room } = createTestRoom();
    room.handleJoin(join('cA')); // conn-1
    room.handleJoin(join('cB')); // conn-2
    const outbound = room.handleMessage('conn-1', {
      type: 'submitOperation',
      envelope: envelope({ clientId: 'cA', clientSequence: 1, operationId: 'x', operation: insertRows(null, ['row-1']) }),
    });
    const ackItems = outbound.filter((o) => o.message.type === 'operationAck');
    expect(ackItems).toHaveLength(1);
    expect(ackItems[0].target).toEqual({ kind: 'connection', connectionId: 'conn-1' });
    const opsItems = outbound.filter((o) => o.message.type === 'operations');
    expect(opsItems).toHaveLength(1);
    expect(opsItems[0].target).toEqual({ kind: 'all' }); // 送信元含む全接続へエコー
  });

  it('rejected は reject を送信元のみへ（broadcast しない）', () => {
    const { room } = createTestRoom();
    room.handleJoin(join('cA'));
    const outbound = room.handleMessage('conn-1', {
      type: 'submitOperation',
      envelope: envelope({ clientId: 'cA', clientSequence: 1, operationId: 'x', baseRevision: 99, operation: insertRows(null, ['row-1']) }),
    });
    expect(outbound).toHaveLength(1);
    expect(outbound[0].message.type).toBe('operationRejected');
    expect(outbound[0].target).toEqual({ kind: 'connection', connectionId: 'conn-1' });
  });
});

describe('Room requestCatchup（off-by-one・S-I5）', () => {
  it('afterRevision=N → operations{fromRevision:N+1}（N 自身は再送しない）', () => {
    const { room, sequencer } = createTestRoom();
    for (let i = 1; i <= 5; i += 1) {
      sequencer.submit(envelope({ clientId: 'setup', clientSequence: i, operationId: `s${i}`, operation: insertRows(null, [`row-${i}`]) }));
    } // revisions 1..5
    const { connectionId } = room.handleJoin(join('cA', 5));
    const outbound = room.handleMessage(connectionId, { type: 'requestCatchup', afterRevision: 2 });
    const ops: OperationsMessage = firstOfType(outbound, 'operations');
    expect(ops.fromRevision).toBe(3); // N+1
    expect(ops.operations.map((e) => e.revision)).toEqual([3, 4, 5]); // 2 は含まれない
    expect(ops.toRevision).toBe(5);
  });

  it('追いつき済み（afterRevision>=current）は空 operations を確定応答', () => {
    const { room, sequencer } = createTestRoom();
    sequencer.submit(envelope({ clientId: 'setup', clientSequence: 1, operationId: 's1', operation: insertRows(null, ['row-1']) }));
    const { connectionId } = room.handleJoin(join('cA', 1));
    const outbound = room.handleMessage(connectionId, { type: 'requestCatchup', afterRevision: 1 });
    const ops: OperationsMessage = firstOfType(outbound, 'operations');
    expect(ops.operations).toEqual([]);
    expect(ops.fromRevision).toBe(2);
    expect(ops.toRevision).toBe(1);
  });
});

describe('Room Presence 中継（§9・connection 単位）', () => {
  it('S-L1/L2: 最初の presence → colorKey 付き presenceDelta を他接続へ配信', () => {
    const { room } = createTestRoom();
    room.handleJoin(join('cA')); // conn-1 → color-0
    room.handleJoin(join('cB')); // conn-2 → color-1
    const outbound = room.handleMessage('conn-1', { type: 'presence', sequence: 1, payload: presencePayload({ activeCell: { rowId: row('row-1'), columnId: col('col-a') } }) });
    const delta: PresenceDeltaMessage = firstOfType(outbound, 'presenceDelta');
    expect(delta.presence.connectionId).toBe('conn-1');
    expect(delta.presence.colorKey).toBe('color-0'); // 決定的割当
    expect(delta.presence.activeCell).toEqual({ rowId: row('row-1'), columnId: col('col-a') });
    expect(outbound[0].target).toEqual({ kind: 'others', exceptConnectionId: 'conn-1' });
  });

  it('S-L1: 後から join した接続の presenceSnapshot に既存 presence が含まれる', () => {
    const { room } = createTestRoom();
    room.handleJoin(join('cA'));
    room.handleMessage('conn-1', { type: 'presence', sequence: 1, payload: presencePayload({ displayName: 'Alice' }) });
    const { outbound } = room.handleJoin(join('cB'));
    const snapshot: PresenceSnapshotMessage = firstOfType(outbound, 'presenceSnapshot');
    expect(snapshot.users.map((u) => u.connectionId)).toEqual(['conn-1']);
    expect(snapshot.users[0].colorKey).toBe('color-0');
  });

  it('S-L3: 古い sequence の presence は破棄（配信なし）', () => {
    const { room } = createTestRoom();
    room.handleJoin(join('cA'));
    room.handleMessage('conn-1', { type: 'presence', sequence: 5, payload: presencePayload({ displayName: 'v5' }) });
    const outbound = room.handleMessage('conn-1', { type: 'presence', sequence: 3, payload: presencePayload({ displayName: 'v3' }) });
    expect(outbound).toEqual([]); // 破棄
    expect(room.exportState()); // no throw（状態健全）
  });

  it('S-L4: heartbeat は heartbeatAck を返し TTL を更新（失効しない）', () => {
    const { room, clock } = createTestRoom(15_000);
    room.handleJoin(join('cA'));
    room.handleMessage('conn-1', { type: 'presence', sequence: 1, payload: presencePayload() });
    clock.set(10_000);
    const hb = room.handleMessage('conn-1', { type: 'heartbeat', sentAt: 10_000 });
    expect(hb[0].message.type).toBe('heartbeatAck');
    // heartbeat で lastSeen=10000 更新。20000 で sweep しても 20000-10000=10000<=15000 で維持
    clock.set(20_000);
    expect(room.sweep()).toEqual([]);
  });

  it('S-L5: heartbeat 途絶で TTL 超過 → sweep が presenceRemoved を配信（注入クロック）', () => {
    const { room, clock } = createTestRoom(15_000);
    room.handleJoin(join('cA'));
    room.handleMessage('conn-1', { type: 'presence', sequence: 1, payload: presencePayload() });
    clock.set(20_000); // 20000-0=20000 > 15000
    const outbound = room.sweep();
    const removed: PresenceRemovedMessage = firstOfType(outbound, 'presenceRemoved');
    expect(removed.sessionId).toBe('conn-1');
    expect(room.activeConnectionIds()).toEqual([]); // 接続も除去
  });

  it('S-L6: 正常 close は即時 presenceRemoved（TTL を待たない）', () => {
    const { room } = createTestRoom();
    room.handleJoin(join('cA'));
    room.handleMessage('conn-1', { type: 'presence', sequence: 1, payload: presencePayload() });
    const outbound = room.handleDisconnect('conn-1');
    const removed: PresenceRemovedMessage = firstOfType(outbound, 'presenceRemoved');
    expect(removed.sessionId).toBe('conn-1');
    expect(removed).toBeDefined();
    expect(outbound[0].target).toEqual({ kind: 'others', exceptConnectionId: 'conn-1' });
  });

  it('S-L7: 同一 userId の2接続は別 Presence・colorKey も別・片方 close で片方のみ削除', () => {
    const { room } = createTestRoom();
    room.handleJoin(join('cA')); // conn-1 → color-0
    room.handleJoin(join('cB')); // conn-2 → color-1
    const d1 = room.handleMessage('conn-1', { type: 'presence', sequence: 1, payload: presencePayload({ userId: 'user-1' }) });
    const d2 = room.handleMessage('conn-2', { type: 'presence', sequence: 1, payload: presencePayload({ userId: 'user-1' }) });
    expect(firstOfType(d1, 'presenceDelta').presence.colorKey).toBe('color-0');
    expect(firstOfType(d2, 'presenceDelta').presence.colorKey).toBe('color-1'); // 同 userId でも別 colorKey
    room.handleDisconnect('conn-1');
    // conn-2 は残る
    const { outbound } = room.handleJoin(join('cC'));
    const snapshot: PresenceSnapshotMessage = firstOfType(outbound, 'presenceSnapshot');
    expect(snapshot.users.map((u) => u.connectionId)).toEqual(['conn-2']);
  });

  it('colorKey は close で解放され再利用される（決定的・指示 6）', () => {
    const { room } = createTestRoom();
    room.handleJoin(join('cA')); // conn-1 → color-0
    room.handleMessage('conn-1', { type: 'presence', sequence: 1, payload: presencePayload() });
    room.handleDisconnect('conn-1'); // color-0 解放
    room.handleJoin(join('cB')); // conn-2 → color-0 再利用（最小未使用 index）
    const outbound = room.handleMessage('conn-2', { type: 'presence', sequence: 1, payload: presencePayload() });
    expect(firstOfType(outbound, 'presenceDelta').presence.colorKey).toBe('color-0');
  });
});

describe('初期文書 document@0 の fresh join bootstrap（DD-026-1）', () => {
  it('非空 document@0 への fresh join は bootstrap@0 を返し、空文書@0 は従来どおり返さない', () => {
    const clock = createManualClock();
    const state = freshSequencerState(COLUMNS);
    state.document = applyOperation(state.document, insertRows(null, ['row-1']), { revision: 0 }).document;
    const room = new Room(new Sequencer(state, clock), { clock, idGenerator: createCounterIdGenerator() });
    const { outbound } = room.handleJoin(join('cA', 0));
    const boot = messagesOfType(outbound, 'bootstrap');
    expect(boot).toHaveLength(1);
    expect(boot[0].revision).toBe(0);
    expect(boot[0].document.rowOrder).toEqual(['row-1']);
    expect(messagesOfType(outbound, 'operations')).toHaveLength(0);
    expect(firstOfType(outbound, 'welcome').currentRevision).toBe(0);

    const empty = createTestRoom();
    expect(messagesOfType(empty.room.handleJoin(join('cB', 0)).outbound, 'bootstrap')).toHaveLength(0);
  });
});
