// snapshot-store の単体テスト（DD-014 Phase 2）: persisted format v1 往復一致・checksum/version fail-fast・世代保持・atomic save。
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Sequencer, freshSequencerState } from './sequencer';
import { serializeSnapshot } from './snapshot';
import {
  FileSnapshotStore,
  SNAPSHOT_FORMAT_VERSION,
  createPersistedSnapshot,
  parsePersistedSnapshot,
} from './snapshot-store';
import { COLUMNS, createManualClock, envelope, insertRows, setCells, row, col, str } from './test-support';

function buildSequencerWithData(): Sequencer {
  const clock = createManualClock();
  const seq = new Sequencer(freshSequencerState(COLUMNS), clock);
  seq.submit(envelope({ operationId: 'op-1', clientSequence: 1, operation: insertRows(null, ['r1', 'r2']) }));
  seq.submit(
    envelope({
      operationId: 'op-2',
      clientSequence: 2,
      baseRevision: 1,
      operation: setCells([{ rowId: row('r1'), columnId: col('col-a'), value: str('hello') }]),
    }),
  );
  return seq;
}

function persistedFrom(seq: Sequencer): ReturnType<typeof createPersistedSnapshot> {
  const data = serializeSnapshot(seq.exportState());
  return createPersistedSnapshot({
    documentId: 'doc-1',
    revision: seq.currentRevision,
    createdAt: new Date(0).toISOString(),
    snapshot: { ...data, operationLog: [] },
  });
}

describe('persisted snapshot format v1', () => {
  it('createPersistedSnapshot→parsePersistedSnapshot が往復一致する（AC2）', () => {
    const persisted = persistedFrom(buildSequencerWithData());
    const roundTrip = parsePersistedSnapshot(JSON.stringify(persisted));
    expect(roundTrip).toEqual(persisted);
    expect(roundTrip.formatVersion).toBe(SNAPSHOT_FORMAT_VERSION);
    expect(roundTrip.snapshot.operationLog).toEqual([]); // log は埋め込まない（正本は oplog）
  });

  it('checksum 不一致は fail-fast で throw する（改竄/bit-rot 検知・AC6）', () => {
    const persisted = persistedFrom(buildSequencerWithData());
    const tampered = { ...persisted, revision: persisted.revision + 999 }; // checksum を再計算せず改竄
    expect(() => parsePersistedSnapshot(JSON.stringify(tampered))).toThrow(/checksum/);
  });

  it('非対応 format version は fail-fast で throw する（AC6）', () => {
    const persisted = persistedFrom(buildSequencerWithData());
    const bad = JSON.stringify({ ...persisted, formatVersion: 99 });
    expect(() => parsePersistedSnapshot(bad)).toThrow(/format version/);
  });

  it('JSON 破損は fail-fast で throw する（AC6）', () => {
    expect(() => parsePersistedSnapshot('{ broken')).toThrow();
  });
});

describe('FileSnapshotStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'snap-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('save→loadLatest が最新 revision を返す', async () => {
    const store = new FileSnapshotStore(dir);
    const seq = buildSequencerWithData();
    await store.save(persistedFrom(seq));
    const loaded = await store.loadLatest();
    expect(loaded?.revision).toBe(2);
  });

  it('直近 K=2 世代のみ保持し古い世代を削除する（要確認③）', async () => {
    const store = new FileSnapshotStore(dir, 2);
    const seq = buildSequencerWithData();
    // 明示的に 3 世代を revision 3/4/5 で作る（同一 document で revision だけ差し替え・checksum 再計算）。
    for (const rev of [3, 4, 5]) {
      const data = serializeSnapshot(seq.exportState());
      await store.save(
        createPersistedSnapshot({ documentId: 'doc-1', revision: rev, createdAt: new Date(0).toISOString(), snapshot: { ...data, operationLog: [] } }),
      );
    }
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(2);
    const loaded = await store.loadLatest();
    expect(loaded?.revision).toBe(5);
  });

  it('最新世代が破損していれば loadLatest は fail-fast で throw する（AC6）', async () => {
    const store = new FileSnapshotStore(dir);
    await writeFile(join(dir, 'snapshot-7.json'), '{ corrupt json');
    await expect(store.loadLatest()).rejects.toThrow();
  });

  it('snapshot 不在時は loadLatest が undefined を返す（初回起動）', async () => {
    const store = new FileSnapshotStore(dir);
    expect(await store.loadLatest()).toBeUndefined();
  });

  it('save は temp→rename の atomic 書込で .tmp を残さない', async () => {
    const store = new FileSnapshotStore(dir);
    await store.save(persistedFrom(buildSequencerWithData()));
    const files = await readdir(dir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});

/** 全階層のオブジェクトキーを逆順に並べ替える（Postgres jsonb 等、キー順を保持しない保存先の模倣）。 */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => reverseKeys(item));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort().reverse()) {
      out[key] = reverseKeys(record[key]);
    }
    return out;
  }
  return value;
}

describe('persisted snapshot format v2（DD-026-1・キー順非依存 checksum）', () => {
  it('キー順を入れ替えた JSON（jsonb 模倣）でも checksum が一致して読める', () => {
    const persisted = persistedFrom(buildSequencerWithData());
    expect(persisted.formatVersion).toBe(2);
    const reordered = JSON.stringify(reverseKeys(JSON.parse(JSON.stringify(persisted))));
    expect(reordered).not.toBe(JSON.stringify(persisted));
    expect(parsePersistedSnapshot(reordered)).toEqual(persisted);
  });

  it('v1（挿入順 checksum）の既存ファイルは旧算法で検証して読める（読込互換・キー順が崩れた v1 は不一致）', () => {
    const data = serializeSnapshot(buildSequencerWithData().exportState());
    const payload = {
      formatVersion: 1,
      documentId: 'doc-1',
      revision: 2,
      createdAt: new Date(0).toISOString(),
      snapshot: { ...data, operationLog: [] },
    };
    const checksum = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
    const legacy = parsePersistedSnapshot(JSON.stringify({ ...payload, checksum }));
    expect(legacy.formatVersion).toBe(1);
    expect(legacy.revision).toBe(2);
    expect(() => parsePersistedSnapshot(JSON.stringify(reverseKeys({ ...payload, checksum })))).toThrow(/checksum/);
  });

  it('FileSnapshotStore は v2 で保存し、v1 ファイルが残っていても loadLatest できる', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snap-v2-'));
    try {
      const store = new FileSnapshotStore(dir);
      const data = serializeSnapshot(buildSequencerWithData().exportState());
      const v1 = { formatVersion: 1, documentId: 'doc-1', revision: 1, createdAt: new Date(0).toISOString(), snapshot: { ...data, operationLog: [] } };
      const v1Checksum = createHash('sha256').update(JSON.stringify(v1), 'utf8').digest('hex');
      await writeFile(join(dir, 'snapshot-1.json'), JSON.stringify({ ...v1, checksum: v1Checksum }));
      expect((await store.loadLatest())?.formatVersion).toBe(1);
      await store.save(persistedFrom(buildSequencerWithData())); // revision 2・v2
      const latest = await store.loadLatest();
      expect(latest?.formatVersion).toBe(2);
      expect(latest?.revision).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
