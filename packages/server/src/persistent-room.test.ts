// PersistentRoom の単体テスト（DD-014 Phase 1/2）:
//   - durable ACK 順序: ACK/broadcast は oplog append（fsync）解決後にのみ返る（log 書込前に ACK が出ない）。
//   - 再起動復旧: snapshot＋tail replay の hash == oplog 全 replay の hash（AC3）。snapshot 無しの全 replay も一致。
//   - snapshot 生成トリガー（N op ごと）と取り漏らしなし。
import { documentHash } from '@nanairo-sheet/core';
import type { ServerOperationEnvelope } from '@nanairo-sheet/core';
import { describe, expect, it } from 'vitest';

import { createCounterIdGenerator } from './deps';
import { MemoryOpLogStore } from './oplog-store';
import type { OpLogStore, OpLogReadResult } from './oplog-store';
import { PersistentRoom, recoverSequencerState } from './persistent-room';
import { Room } from './room';
import { Sequencer, freshSequencerState } from './sequencer';
import { serializeSnapshot } from './snapshot';
import { MemorySnapshotStore, createPersistedSnapshot } from './snapshot-store';
import type { SnapshotStore } from './snapshot-store';
import { COLUMNS, col, createManualClock, envelope, insertRows, row, setCells, str } from './test-support';

function buildPersistentRoom(oplog: OpLogStore, snapshotStore: SnapshotStore, snapshotIntervalOps = 1_000) {
  const clock = createManualClock();
  const sequencer = new Sequencer(freshSequencerState(COLUMNS), clock);
  const room = new Room(sequencer, { clock, idGenerator: createCounterIdGenerator() });
  const persistent = new PersistentRoom(room, sequencer, oplog, snapshotStore, clock, {
    documentId: 'doc-1',
    snapshotIntervalOps,
  });
  return { persistent, sequencer, room, clock };
}

/** append の解決を手動で制御できる oplog（durable 順序検証用）。 */
class GatedOpLogStore implements OpLogStore {
  private readonly entries: ServerOperationEnvelope[] = [];
  private release: (() => void) | undefined;

  append(entries: readonly ServerOperationEnvelope[]): Promise<void> {
    this.entries.push(...entries);
    return new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  flushGate(): void {
    this.release?.();
    this.release = undefined;
  }
  readAll(): Promise<OpLogReadResult> {
    return Promise.resolve({ entries: [...this.entries], discardedTornRecords: 0 });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const submitInsert = (id: string, seq: number) =>
  ({ type: 'submitOperation', envelope: envelope({ operationId: id, clientSequence: seq, operation: insertRows(null, [id]) }) }) as const;

describe('PersistentRoom durable ACK 順序（Phase 1）', () => {
  it('ACK/broadcast は oplog append（fsync）解決後にのみ dispatch される（log 書込前に ACK を出さない）', async () => {
    const gate = new GatedOpLogStore();
    const { persistent } = buildPersistentRoom(gate, new MemorySnapshotStore());
    persistent.handleJoin({ type: 'join', protocolVersion: 1, documentId: 'doc-1' as never, lastAppliedRevision: 0, clientId: 'client-A' });

    let resolved = false;
    const pending = persistent.handleMessage('conn-1', submitInsert('op-1', 1)).then((outbound) => {
      resolved = true;
      return outbound;
    });
    // まだ gate 未開放＝append 未解決ゆえ ACK は返らない。
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    gate.flushGate(); // fsync 完了相当
    const outbound = await pending;
    expect(resolved).toBe(true);
    // durable 化後に ACK と operations（broadcast）が返る。
    const types = outbound.map((o) => o.message.type);
    expect(types).toContain('operationAck');
    expect(types).toContain('operations');
  });

  it('reject/duplicate は oplog へ書かず即応する（accepted のみ durable 境界）', async () => {
    const oplog = new MemoryOpLogStore();
    const { persistent } = buildPersistentRoom(oplog, new MemorySnapshotStore());
    persistent.handleJoin({ type: 'join', protocolVersion: 1, documentId: 'doc-1' as never, lastAppliedRevision: 0, clientId: 'client-A' });
    // clientSequence 違反 → reject。oplog は空のまま。
    const outbound = await persistent.handleMessage('conn-1', submitInsert('op-x', 5));
    expect(outbound.map((o) => o.message.type)).toContain('operationRejected');
    const { entries } = await oplog.readAll();
    expect(entries.length).toBe(0);
  });
});

describe('PersistentRoom 再起動復旧（Phase 2）', () => {
  async function applyOps(persistent: PersistentRoom): Promise<void> {
    persistent.handleJoin({ type: 'join', protocolVersion: 1, documentId: 'doc-1' as never, lastAppliedRevision: 0, clientId: 'client-A' });
    await persistent.handleMessage('conn-1', submitInsert('op-1', 1));
    await persistent.handleMessage('conn-1', {
      type: 'submitOperation',
      envelope: envelope({ operationId: 'op-2', clientSequence: 2, baseRevision: 1, operation: setCells([{ rowId: row('op-1'), columnId: col('col-a'), value: str('X') }]) }),
    });
    await persistent.handleMessage('conn-1', submitInsert('op-3', 3));
  }

  it('snapshot＋tail replay の hash == oplog 全 replay の hash（AC3）', async () => {
    const oplog = new MemoryOpLogStore();
    const snapshotStore = new MemorySnapshotStore();
    const { persistent, sequencer } = buildPersistentRoom(oplog, snapshotStore);
    await applyOps(persistent); // 3 op 適用
    const liveHash = documentHash(sequencer.document);
    await persistent.forceSnapshot(); // revision 3 の snapshot（tail 0）

    // 復旧（snapshot revision 3 + tail 0）。
    const recovered = await recoverSequencerState({ oplog, snapshotStore, columnOrder: [...COLUMNS], documentId: 'doc-1' });
    expect(documentHash(recovered.state.document)).toBe(liveHash);
    expect(recovered.report.fromSnapshotRevision).toBe(3);
    expect(recovered.report.tailReplayed).toBe(0);
    expect(recovered.state.currentRevision).toBe(3);
    expect(recovered.state.operationLog.length).toBe(3); // catch-up 供給のため全 log を in-memory へ復元
  });

  it('snapshot が古い revision の場合、tail replay で最新 hash に一致する（O(tail)・AC3/AC5）', async () => {
    const oplog = new MemoryOpLogStore();
    const snapshotStore = new MemorySnapshotStore();
    const { persistent, sequencer } = buildPersistentRoom(oplog, snapshotStore);
    persistent.handleJoin({ type: 'join', protocolVersion: 1, documentId: 'doc-1' as never, lastAppliedRevision: 0, clientId: 'client-A' });
    await persistent.handleMessage('conn-1', submitInsert('op-1', 1));
    await persistent.handleMessage('conn-1', submitInsert('op-2', 2));
    await persistent.forceSnapshot(); // snapshot@revision 2
    // snapshot 後にさらに op（tail）を追加。
    await persistent.handleMessage('conn-1', submitInsert('op-3', 3));
    await persistent.handleMessage('conn-1', submitInsert('op-4', 4));
    const liveHash = documentHash(sequencer.document);

    const recovered = await recoverSequencerState({ oplog, snapshotStore, columnOrder: [...COLUMNS], documentId: 'doc-1' });
    expect(documentHash(recovered.state.document)).toBe(liveHash);
    expect(recovered.report.fromSnapshotRevision).toBe(2);
    expect(recovered.report.tailReplayed).toBe(2); // op-3, op-4 のみ replay（O(tail)）
    expect(recovered.state.currentRevision).toBe(4);
  });

  it('snapshot 無し時は oplog 全 replay で復旧し hash 一致（縮退経路）', async () => {
    const oplog = new MemoryOpLogStore();
    const snapshotStore = new MemorySnapshotStore();
    const { persistent, sequencer } = buildPersistentRoom(oplog, snapshotStore);
    await applyOps(persistent); // snapshot は生成しない（interval 未達）
    const liveHash = documentHash(sequencer.document);

    const recovered = await recoverSequencerState({ oplog, snapshotStore, columnOrder: [...COLUMNS], documentId: 'doc-1' });
    expect(documentHash(recovered.state.document)).toBe(liveHash);
    expect(recovered.report.fromSnapshotRevision).toBeUndefined();
    expect(recovered.report.tailReplayed).toBe(3);
  });

  it('N op ごとに snapshot が非同期生成される（snapshotIntervalOps）', async () => {
    const oplog = new MemoryOpLogStore();
    const snapshotStore = new MemorySnapshotStore();
    const { persistent } = buildPersistentRoom(oplog, snapshotStore, 3);
    persistent.handleJoin({ type: 'join', protocolVersion: 1, documentId: 'doc-1' as never, lastAppliedRevision: 0, clientId: 'client-A' });
    for (let i = 1; i <= 3; i += 1) {
      await persistent.handleMessage('conn-1', submitInsert(`op-${i}`, i));
    }
    // 非同期 snapshot 生成の完了を待つ。
    await new Promise((r) => setTimeout(r, 10));
    expect(snapshotStore.saveCount).toBeGreaterThanOrEqual(1);
    const loaded = await snapshotStore.loadLatest();
    expect(loaded?.revision).toBe(3);
  });
});

describe('recoverSequencerState documentId × persistenceDir 相互検証 fail-fast（DD-018-1）', () => {
  /** documentId 'doc-1' で 3 op 適用した oplog（＋任意で snapshot）を作る。 */
  async function seedPersistence(withSnapshot: boolean): Promise<{ oplog: MemoryOpLogStore; snapshotStore: MemorySnapshotStore }> {
    const oplog = new MemoryOpLogStore();
    const snapshotStore = new MemorySnapshotStore();
    const { persistent } = buildPersistentRoom(oplog, snapshotStore);
    persistent.handleJoin({ type: 'join', protocolVersion: 1, documentId: 'doc-1' as never, lastAppliedRevision: 0, clientId: 'client-A' });
    for (let i = 1; i <= 3; i += 1) {
      await persistent.handleMessage('conn-1', submitInsert(`op-${i}`, i));
    }
    if (withSnapshot) {
      await persistent.forceSnapshot(); // documentId 'doc-1' の snapshot@revision 3
    }
    return { oplog, snapshotStore };
  }

  it('AC1: snapshot 経路で persisted documentId≠要求 documentId は fail-fast（別 ID で誤公開させない）', async () => {
    const { oplog, snapshotStore } = await seedPersistence(true);
    await expect(
      recoverSequencerState({ oplog, snapshotStore, columnOrder: [...COLUMNS], documentId: 'other-doc' }),
    ).rejects.toThrow(/documentId 不一致/);
  });

  it('AC1: snapshot 無し（oplog のみ）経路でも persisted documentId≠要求で fail-fast', async () => {
    const { oplog, snapshotStore } = await seedPersistence(false); // snapshot 未生成＝oplog 先頭 entry の documentId で照合
    await expect(
      recoverSequencerState({ oplog, snapshotStore, columnOrder: [...COLUMNS], documentId: 'other-doc' }),
    ).rejects.toThrow(/documentId 不一致/);
  });

  it('AC1: oplog に別 documentId の entry が混在したら fail-fast（Codex P1・全 entry 照合）', async () => {
    const { oplog, snapshotStore } = await seedPersistence(false); // doc-1 の 3 op
    // 旧版で別 ID 起動→tail 追記した残骸を模擬: revision 4 に documentId 'doc-2' の entry を混入。
    const { entries } = await oplog.readAll();
    const foreign = { ...entries[2], documentId: 'doc-2' as never, revision: 4, operationId: 'op-foreign' as never };
    await oplog.append([foreign]);
    // 要求 'doc-1' は snapshot（無し）・先頭 entry（doc-1）は通るが、4 件目の doc-2 で throw する。
    await expect(
      recoverSequencerState({ oplog, snapshotStore, columnOrder: [...COLUMNS], documentId: 'doc-1' }),
    ).rejects.toThrow(/oplog entry documentId 不一致/);
  });

  it('AC2: 同一 documentId での再開は throw せず復元する（正常系 positive）', async () => {
    const { oplog, snapshotStore } = await seedPersistence(true);
    const recovered = await recoverSequencerState({ oplog, snapshotStore, columnOrder: [...COLUMNS], documentId: 'doc-1' });
    expect(recovered.state.currentRevision).toBe(3);
  });

  it('AC1: 空 persistenceDir（persisted 無し・oplog 空）は照合対象なしで throw しない（過剰拒否しない）', async () => {
    const oplog = new MemoryOpLogStore();
    const snapshotStore = new MemorySnapshotStore();
    const recovered = await recoverSequencerState({ oplog, snapshotStore, columnOrder: [...COLUMNS], documentId: 'any-doc' });
    expect(recovered.report.totalOps).toBe(0);
  });

  it('AC3: 封筒 revision と内側 snapshot.currentRevision の不一致で fail-fast（改竄/論理不整合）', async () => {
    const oplog = new MemoryOpLogStore();
    const snapshotStore = new MemorySnapshotStore();
    const { persistent, sequencer } = buildPersistentRoom(oplog, snapshotStore);
    persistent.handleJoin({ type: 'join', protocolVersion: 1, documentId: 'doc-1' as never, lastAppliedRevision: 0, clientId: 'client-A' });
    for (let i = 1; i <= 3; i += 1) {
      await persistent.handleMessage('conn-1', submitInsert(`op-${i}`, i));
    }
    // 内側 snapshot は revision 3 だが封筒 revision を 99 に改竄（checksum は自己整合ゆえ parse は通過する）。
    const data = serializeSnapshot(sequencer.exportState());
    const tampered = createPersistedSnapshot({
      documentId: 'doc-1',
      revision: 99,
      createdAt: new Date(0).toISOString(),
      snapshot: { ...data, operationLog: [] },
    });
    await snapshotStore.save(tampered);
    await expect(
      recoverSequencerState({ oplog, snapshotStore, columnOrder: [...COLUMNS], documentId: 'doc-1' }),
    ).rejects.toThrow(/封筒 revision/);
  });
});

// ---- DD-056 H13（Codex 設計レビュー P2-2）: close は実行中の snapshot 生成を待ち、新しい生成を始めない ----

/** save を手動で解決できる snapshot ストア（生成中に close が呼ばれる場面の検証用）。close の後の save を記録する。 */
class GatedSnapshotStore implements SnapshotStore {
  private readonly inner = new MemorySnapshotStore();
  private release: (() => void) | undefined;
  closed = false;
  savesAfterClose = 0;
  saveStarted = 0;

  async save(persisted: Parameters<SnapshotStore['save']>[0]): Promise<void> {
    this.saveStarted += 1;
    if (this.closed) {
      this.savesAfterClose += 1;
    }
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    await this.inner.save(persisted);
  }
  flushGate(): void {
    this.release?.();
    this.release = undefined;
  }
  loadLatest(): ReturnType<SnapshotStore['loadLatest']> {
    return this.inner.loadLatest();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

describe('PersistentRoom.close と snapshot 生成（DD-056 H13）', () => {
  it('実行中の snapshot 生成の終了を待ってからストアを閉じ、close の後は新しい生成を始めない', async () => {
    const snapshots = new GatedSnapshotStore();
    const { persistent } = buildPersistentRoom(new MemoryOpLogStore(), snapshots, 1);
    persistent.handleJoin({ type: 'join', protocolVersion: 1, documentId: 'doc-1' as never, lastAppliedRevision: 0, clientId: 'client-A' });
    await persistent.handleMessage('conn-1', submitInsert('op-1', 1)); // snapshotIntervalOps=1 → 生成が始まる（save は保留）
    await persistent.handleMessage('conn-1', submitInsert('op-2', 2)); // 生成中に蓄積（終わった後に再判定される分）
    expect(snapshots.saveStarted).toBe(1);

    let closed = false;
    const closing = persistent.close().then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(false); // 保存の終了を待っている
    expect(snapshots.closed).toBe(false);

    snapshots.flushGate();
    await closing;
    expect(closed).toBe(true);
    expect(snapshots.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(snapshots.saveStarted).toBe(1); // 蓄積分の再判定は close 開始後なので新しい生成を始めない
    expect(snapshots.savesAfterClose).toBe(0);
  });
});
