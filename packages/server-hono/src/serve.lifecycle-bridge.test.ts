// 🔬 DD-056-3 機械検証（contract.md §5.2・Codex 設計レビュー P2-1／P2-2）: 撤去の受信停止と、撤去・停止が snapshot 生成を待つこと。
//   ① RoomBridge を偽の WebSocket で直接駆動し、撤去（retire）の後・切断（closeSocket）の後に届いたフレーム（join・submitOperation）が
//      旧 Room に入らないこと、撤去後の新しい接続は 1001 で閉じること、whenDrained が永続化待ちの配信の完了まで待つことを確かめる
//      （実 WS では切断ハンドシェイク中のフレームのタイミングを決定的に作れないため）。
//   ② startServer（内部・snapshotIntervalOps を小さくできる）で、snapshot の保存を遅らせた状態の removeDocument が保存の終了を待ち、
//      解決の後にストアへ書き込まないこと、同じ ID・同じ保存先での足し直しが成功することを確かめる。
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { createDocumentId, createOperationId, createTransactionId } from '@nanairo-sheet/types';
import type { ClientMessage } from '@nanairo-sheet/core';
import {
  MemoryOpLogStore,
  MemorySnapshotStore,
  PersistentRoom,
  Room,
  Sequencer,
  createCounterIdGenerator,
  freshSequencerState,
} from '@nanairo-sheet/server';
import type { OpLogStore, OpLogReadResult, SnapshotStore } from '@nanairo-sheet/server';
import type { ServerOperationEnvelope } from '@nanairo-sheet/core';
import { createColumnId } from '@nanairo-sheet/types';
import type { WebSocket } from 'ws';

import { adaptOpLogStore } from './serve-adapters';
import type { ServeOpLogStore } from './serve-types';
import { RoomBridge, SubmitDeliveryLoop, startServer } from './server';
import { delay, waitFor } from './test-support';

const COLUMNS = ['col-a', 'col-b', 'col-c'].map((c) => createColumnId(c));

/** RoomBridge が使う範囲だけを持つ偽の WebSocket（on・close・send・readyState）。 */
class FakeSocket extends EventEmitter {
  readyState = 1; // OPEN
  readonly sent: unknown[] = [];
  closedWith: { code: number; reason: string } | undefined;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
    this.readyState = 2; // CLOSING（close イベントは相手の応答待ち＝届かない間にフレームが来る場面を作る）
  }
  frame(message: ClientMessage): void {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }
}

const join = (clientId: string): ClientMessage => ({
  type: 'join',
  protocolVersion: 1,
  documentId: createDocumentId('doc-1'),
  lastAppliedRevision: 0,
  clientId,
});

const submitInsert = (clientId: string, seq: number, rowId: string): ClientMessage => ({
  type: 'submitOperation',
  envelope: {
    protocolVersion: 1,
    documentId: createDocumentId('doc-1'),
    operationId: createOperationId(`${clientId}-${seq}`),
    transactionId: createTransactionId(`tx-${clientId}-${seq}`),
    actorId: clientId,
    clientId,
    clientSequence: seq,
    baseRevision: 0,
    operation: { type: 'insertRows', afterRowId: null, rows: [{ rowId: rowId as never }] },
  },
});

function asWebSocket(fake: FakeSocket): WebSocket {
  return fake as unknown as WebSocket; // テスト用の偽物（RoomBridge が触るメンバーだけを実装）
}

function buildBridge(): { bridge: RoomBridge; sequencer: Sequencer; room: Room } {
  const clock = { now: () => 0 };
  const sequencer = new Sequencer(freshSequencerState(COLUMNS), clock);
  const room = new Room(sequencer, { clock, idGenerator: createCounterIdGenerator() });
  const bridge = new RoomBridge(room, 'doc-1', new SubmitDeliveryLoop());
  return { bridge, sequencer, room };
}

describe('RoomBridge の撤去の受信停止（DD-056 H13・Codex 設計レビュー P2-1）', () => {
  it('撤去の後に届いた join・submitOperation（未 join の接続を含む）は旧 Room に入らず、接続はすべて 1001 で切る', () => {
    const { bridge, sequencer, room } = buildBridge();
    const joined = new FakeSocket();
    const pendingJoin = new FakeSocket(); // 接続済み・未 join
    bridge.onConnect(asWebSocket(joined), undefined);
    bridge.onConnect(asWebSocket(pendingJoin), undefined);
    joined.frame(join('client-a'));
    expect(room.activeConnectionIds()).toHaveLength(1);

    bridge.retire(1001, 'document removed');
    expect(joined.closedWith).toEqual({ code: 1001, reason: 'document removed' });
    expect(pendingJoin.closedWith).toEqual({ code: 1001, reason: 'document removed' });
    expect(room.activeConnectionIds()).toHaveLength(0);

    // 切断ハンドシェイク中（CLOSING）に届いたフレーム。
    pendingJoin.frame(join('client-b'));
    joined.frame(join('client-a'));
    joined.frame(submitInsert('client-a', 1, 'row-x'));
    expect(room.activeConnectionIds()).toHaveLength(0); // 再参加していない
    expect(sequencer.currentRevision).toBe(0); // 投入されていない

    // 撤去の後の新しい接続（handshake の途中で撤去された接続）は受けずに 1001 で閉じる。
    const late = new FakeSocket();
    bridge.onConnect(asWebSocket(late), undefined);
    expect(late.closedWith).toEqual({ code: 1001, reason: 'document removed' });
    late.frame(join('client-c'));
    expect(room.activeConnectionIds()).toHaveLength(0);
  });

  it('不正なフレームで切った接続から後で届いた join も捨てる（既存の closeSocket の穴・同じ修正）', () => {
    const { bridge, room } = buildBridge();
    const ws = new FakeSocket();
    bridge.onConnect(asWebSocket(ws), undefined);
    ws.emit('message', Buffer.from('not json')); // 1008 で切断
    expect(ws.closedWith?.code).toBe(1008);
    ws.frame(join('client-a'));
    expect(room.activeConnectionIds()).toHaveLength(0);
  });

  it('whenDrained は永続化待ちの配信が終わってから解決する（撤去の手順 ④）', async () => {
    const gate = new GatedOpLog();
    const clock = { now: () => 0 };
    const sequencer = new Sequencer(freshSequencerState(COLUMNS), clock);
    const room = new Room(sequencer, { clock, idGenerator: createCounterIdGenerator() });
    const persistent = new PersistentRoom(room, sequencer, gate, new MemorySnapshotStore(), clock, { documentId: 'doc-1' });
    const bridge = new RoomBridge(persistent, 'doc-1', new SubmitDeliveryLoop());
    const ws = new FakeSocket();
    bridge.onConnect(asWebSocket(ws), undefined);
    ws.frame(join('client-a'));
    ws.frame(submitInsert('client-a', 1, 'row-1'));
    await waitFor(() => gate.pending, 'append in flight');

    let drained = false;
    const draining = bridge.whenDrained().then(() => {
      drained = true;
    });
    bridge.retire(1001, 'document removed');
    await delay(20);
    expect(drained).toBe(false);
    gate.release();
    await draining;
    expect(drained).toBe(true);
    expect(sequencer.currentRevision).toBe(1); // 撤去の前に受理した操作は有効（永続化された）
    expect(gate.entries).toHaveLength(1);
  });

  it('配信待ちが無ければ whenDrained はすぐ解決する', async () => {
    const { bridge } = buildBridge();
    await expect(bridge.whenDrained()).resolves.toBeUndefined();
  });
});

/** append を手動で解決できる oplog。 */
class GatedOpLog implements OpLogStore {
  readonly entries: ServerOperationEnvelope[] = [];
  pending = false;
  private resolveAppend: (() => void) | undefined;
  append(entries: readonly ServerOperationEnvelope[]): Promise<void> {
    this.entries.push(...entries);
    this.pending = true;
    return new Promise<void>((resolve) => {
      this.resolveAppend = resolve;
    });
  }
  release(): void {
    this.pending = false;
    this.resolveAppend?.();
  }
  readAll(): Promise<OpLogReadResult> {
    return Promise.resolve({ entries: [...this.entries], discardedTornRecords: 0 });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** save を手動で解決でき、close の後の save を数える snapshot ストア。 */
class GatedSnapshots implements SnapshotStore {
  private readonly inner = new MemorySnapshotStore();
  private resolveSave: (() => void) | undefined;
  saving = false;
  closed = false;
  savesAfterClose = 0;
  async save(persisted: Parameters<SnapshotStore['save']>[0]): Promise<void> {
    if (this.closed) {
      this.savesAfterClose += 1;
    }
    if (persisted.revision > 0) {
      this.saving = true;
      await new Promise<void>((resolve) => {
        this.resolveSave = resolve;
      });
      this.saving = false;
    }
    await this.inner.save(persisted);
  }
  release(): void {
    this.resolveSave?.();
  }
  loadLatest(): ReturnType<SnapshotStore['loadLatest']> {
    return this.inner.loadLatest();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

describe('removeDocument と snapshot 生成（DD-056 H13・Codex 設計レビュー P2-2）', () => {
  it('snapshot の保存を遅らせた状態の撤去は保存の終了を待ち、解決の後にストアへ書かない。同じ ID・同じ保存先で足し直せる', async () => {
    const oplog = new MemoryOpLogStore();
    const snapshots = new GatedSnapshots();
    const running = await startServer({ port: 0, seedRows: 1, snapshotIntervalOps: 1 });
    try {
      await running.addDocument('v1', { columnOrder: ['col-a', 'col-b', 'col-c'], seedRows: 1, oplog, snapshotStore: snapshots });
      const result = await running.submit(
        { type: 'setCells', changes: [{ rowId: 'row-1', columnId: 'col-a', value: { kind: 'string', value: 'S' } }] },
        'system',
        'v1',
      );
      expect(result.status).toBe('accepted');
      await waitFor(() => snapshots.saving, 'snapshot save in flight');

      let removed = false;
      const removing = running.removeDocument('v1').then(() => {
        removed = true;
      });
      await delay(30);
      expect(removed).toBe(false); // 保存の終了を待っている
      expect(snapshots.closed).toBe(false);
      snapshots.release();
      await removing;
      expect(snapshots.closed).toBe(true);
      await delay(30);
      expect(snapshots.savesAfterClose).toBe(0);

      await running.addDocument('v1', { columnOrder: ['col-a', 'col-b', 'col-c'], seedRows: 1, oplog, snapshotStore: snapshots });
      expect(running.documentIds).toContain('v1');
      expect(running.hash('v1')).toBeTypeOf('string');
    } finally {
      await running.close();
    }
  });
});

describe('consumer ストアの adapter の close（DD-056 H13）', () => {
  it('直列化キューに残っている append を待ってから consumer の close を呼ぶ（撤去・停止でトランザクションの途中に閉じない）', async () => {
    const events: string[] = [];
    let releaseAppend: (() => void) | undefined;
    const store: ServeOpLogStore = {
      append: async () => {
        events.push('append-start');
        await new Promise<void>((resolve) => {
          releaseAppend = resolve;
        });
        events.push('append-end');
      },
      readAll: () => Promise.resolve({ entries: [] }),
      close: () => {
        events.push('close');
        return Promise.resolve();
      },
    };
    const adapted = adaptOpLogStore(store);
    const appending = adapted.append([]);
    await waitFor(() => releaseAppend !== undefined, 'append started');
    const closing = adapted.close();
    await delay(20);
    expect(events).toEqual(['append-start']); // close はまだ呼ばれていない
    releaseAppend?.();
    await Promise.all([appending, closing]);
    expect(events).toEqual(['append-start', 'append-end', 'close']);
  });
});
