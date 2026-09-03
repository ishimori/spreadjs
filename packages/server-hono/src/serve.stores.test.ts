// 🔬 DD-026-1 機械検証（contract.md §5 S1〜S6）: 公開 API serve() に注入した oplog/snapshotStore（U1）と initialDocument の契約。
//   S1 append 解決＝durable の後に ACK（公開形 envelope が届く）／S2 stop→再 serve で継続／S3 キー順を保持しない snapshot 保存先
//   （jsonb 模倣）でも復旧／S4 initialDocument は復旧できる状態が無いときだけ 1 回・fresh join が document@0 を bootstrap で受ける／
//   S5 persistenceDir（ファイル）でも initialDocument が成立／S6 fail-fast。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getCell } from '@nanairo-sheet/core';
import type { CellScalar } from '@nanairo-sheet/core';
import { col, row, setCells, str } from '@nanairo-sheet/collab/test-support';

import { serve } from './index';
import type { ServeInitialDocument, ServeOptions } from './index';
import { MemoryServeOpLog, MemoryServeSnapshots, createSessionClient, delay, waitFor } from './test-support';
import type { SessionClient } from './test-support';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const INITIAL: ServeInitialDocument = {
  rows: [
    { rowId: 'r-1', cells: { 'col-a': { kind: 'string', value: '品番A' }, 'col-b': { kind: 'number', value: 12 } } },
    { rowId: 'r-2', cells: { 'col-c': { kind: 'date', value: '2026-09-03' } } },
  ],
};

function valueOf(client: SessionClient, rowId: string, columnId: string): CellScalar | undefined {
  return getCell(client.session.committedDocument, row(rowId), col(columnId))?.value;
}

async function startAndConnect(options: ServeOptions, clientId: string): Promise<{ server: Awaited<ReturnType<typeof serve>>; client: SessionClient }> {
  const server = await serve({ port: 0, ...options });
  cleanups.push(() => server.stop());
  const client = createSessionClient(`ws://127.0.0.1:${server.port}/ws`, { clientId });
  cleanups.push(() => client.transport.close());
  await waitFor(() => client.session.isOnline, `${clientId} online`);
  return { server, client };
}

describe('serve() ストア注入（U1・DD-026-1）', () => {
  it('S1: append に公開形 envelope が届き、append 解決まで ACK が出ない（durable ACK 契約）', async () => {
    const oplog = new MemoryServeOpLog();
    const snapshots = new MemoryServeSnapshots();
    const { client: a } = await startAndConnect({ seedRows: 2, oplog, snapshotStore: snapshots }, 'client-a');
    await waitFor(() => a.session.committedDocument.revision >= 1, 'seeded');
    expect(oplog.entries).toHaveLength(1); // seed（revision 1）は起動時に durable 化される

    oplog.gate = true; // 以降の append を保留
    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('X') }]));
    await waitFor(() => oplog.appendCalls === 2, 'append called');
    await delay(60);
    expect(a.session.pendingCount).toBe(1); // append 未解決の間は ACK が出ない
    oplog.release();
    await waitFor(() => a.session.pendingCount === 0, 'acked after append resolved');

    const entry = oplog.entries[1];
    expect(entry.revision).toBe(2);
    expect(entry.actorId).toBe('user-client-a');
    expect(entry.clientId).toBe('client-a');
    expect(entry.documentId).toBe('demo-doc');
    expect(entry.operation).toEqual({
      type: 'setCells',
      conflictPolicy: 'reject-overlap',
      changes: [{ rowId: 'row-1', columnId: 'col-a', value: { kind: 'string', value: 'X' } }],
    });
  });

  it('S2: stop → 同じストアで再 serve → revision・値が継続し、新規クライアントが復元文書を受け取る（再 seed しない）', async () => {
    const oplog = new MemoryServeOpLog();
    const snapshots = new MemoryServeSnapshots();
    const server1 = await serve({ port: 0, seedRows: 2, oplog, snapshotStore: snapshots });
    const a = createSessionClient(`ws://127.0.0.1:${server1.port}/ws`, { clientId: 'client-a' });
    await waitFor(() => a.session.isOnline && a.session.committedDocument.revision >= 1, 'a online');
    a.session.submitLocalOperation(setCells([{ rowId: row('row-2'), columnId: col('col-b'), value: str('DURABLE') }]));
    await waitFor(() => a.session.pendingCount === 0, 'a acked');
    const hash = a.session.committedHash();
    const revision = a.session.committedDocument.revision;
    a.transport.close();
    await waitFor(() => server1.connectionCount() === 0, 'a disconnected');
    await server1.stop();

    const server2 = await serve({ port: 0, seedRows: 2, oplog, snapshotStore: snapshots });
    cleanups.push(() => server2.stop());
    expect(oplog.entries).toHaveLength(2); // seed + edit（復旧起動で seed を書き足さない）
    const b = createSessionClient(`ws://127.0.0.1:${server2.port}/ws`, { clientId: 'client-b' });
    cleanups.push(() => b.transport.close());
    await waitFor(
      () => b.session.isOnline && b.session.committedHash() === hash && b.session.committedDocument.revision === revision,
      'b restored',
    );
    expect(valueOf(b, 'row-2', 'col-b')).toEqual({ kind: 'string', value: 'DURABLE' });
  });

  it('S3: キー順を保持しない snapshot 保存先（jsonb 模倣）でも snapshot@0＋tail から復旧する', async () => {
    const oplog = new MemoryServeOpLog();
    const snapshots = new MemoryServeSnapshots(true); // loadLatest が全階層のキー順を崩して返す
    let calls = 0;
    const options: ServeOptions = {
      oplog,
      snapshotStore: snapshots,
      initialDocument: () => {
        calls += 1;
        return INITIAL;
      },
    };
    const server1 = await serve({ port: 0, ...options });
    expect(snapshots.saveCount).toBe(1); // snapshot@0 を listen 前に保存
    const a = createSessionClient(`ws://127.0.0.1:${server1.port}/ws`, { clientId: 'client-a' });
    await waitFor(() => a.session.isOnline && a.session.committedDocument.rowOrder.length === 2, 'a bootstrapped');
    a.session.submitLocalOperation(setCells([{ rowId: row('r-2'), columnId: col('col-a'), value: str('edit') }]));
    await waitFor(() => a.session.pendingCount === 0, 'a acked');
    a.transport.close();
    await waitFor(() => server1.connectionCount() === 0, 'a disconnected');
    await server1.stop();

    const server2 = await serve({ port: 0, ...options }); // キー順が崩れた snapshot@0 を読み、checksum 検証を通す
    cleanups.push(() => server2.stop());
    expect(calls).toBe(1); // 復旧できる状態があるので initialDocument は呼ばれない
    const b = createSessionClient(`ws://127.0.0.1:${server2.port}/ws`, { clientId: 'client-b' });
    cleanups.push(() => b.transport.close());
    await waitFor(() => b.session.isOnline && b.session.committedDocument.revision === 1, 'b restored');
    expect(valueOf(b, 'r-1', 'col-a')).toEqual({ kind: 'string', value: '品番A' });
    expect(valueOf(b, 'r-2', 'col-a')).toEqual({ kind: 'string', value: 'edit' });
  });

  it('S4: initialDocument は snapshot も oplog も無いときだけ 1 回呼ばれ、fresh join が document@0 を受け取る（oplog は消費者の操作のみ）', async () => {
    const oplog = new MemoryServeOpLog();
    const snapshots = new MemoryServeSnapshots();
    let calls = 0;
    const options: ServeOptions = {
      oplog,
      snapshotStore: snapshots,
      initialDocument: () => {
        calls += 1;
        return Promise.resolve(INITIAL);
      },
    };
    const server1 = await serve({ port: 0, ...options });
    expect(calls).toBe(1);
    expect(oplog.entries).toHaveLength(0); // 初期文書は oplog に載せない
    const a = createSessionClient(`ws://127.0.0.1:${server1.port}/ws`, { clientId: 'client-a' });
    await waitFor(() => a.session.isOnline && a.session.committedDocument.rowOrder.length === 2, 'a bootstrapped at revision 0');
    expect(a.session.committedDocument.revision).toBe(0);
    expect(a.session.committedDocument.rowOrder.map(String)).toEqual(['r-1', 'r-2']);
    expect(valueOf(a, 'r-1', 'col-a')).toEqual({ kind: 'string', value: '品番A' });
    expect(valueOf(a, 'r-1', 'col-b')).toEqual({ kind: 'number', value: 12 });
    expect(valueOf(a, 'r-2', 'col-c')).toEqual({ kind: 'date', value: '2026-09-03' });

    a.session.submitLocalOperation(setCells([{ rowId: row('r-2'), columnId: col('col-a'), value: str('edit') }]));
    await waitFor(() => a.session.pendingCount === 0 && a.session.committedDocument.revision === 1, 'a edit acked as revision 1');
    expect(oplog.entries.map((e) => e.revision)).toEqual([1]);
    a.transport.close();
    await waitFor(() => server1.connectionCount() === 0, 'a disconnected');
    await server1.stop();

    const server2 = await serve({ port: 0, ...options });
    cleanups.push(() => server2.stop());
    expect(calls).toBe(1); // 再起動では呼ばれない（snapshot@0＋tail で復旧）
    const b = createSessionClient(`ws://127.0.0.1:${server2.port}/ws`, { clientId: 'client-b' });
    cleanups.push(() => b.transport.close());
    await waitFor(() => b.session.isOnline && b.session.committedDocument.revision === 1, 'b restored');
    expect(valueOf(b, 'r-1', 'col-b')).toEqual({ kind: 'number', value: 12 });
    expect(valueOf(b, 'r-2', 'col-a')).toEqual({ kind: 'string', value: 'edit' });
  });

  it('S4b: ストア無し（in-memory）でも initialDocument から document@0 で開始できる', async () => {
    const { client: a } = await startAndConnect({ initialDocument: () => INITIAL }, 'client-a');
    await waitFor(() => a.session.committedDocument.rowOrder.length === 2, 'bootstrapped');
    expect(a.session.committedDocument.revision).toBe(0);
    a.session.submitLocalOperation(setCells([{ rowId: row('r-1'), columnId: col('col-c'), value: str('v') }]));
    await waitFor(() => a.session.pendingCount === 0 && a.session.committedDocument.revision === 1, 'edit acked');
  });

  it('S5: persistenceDir（ファイル永続化）でも initialDocument が成立し、再起動で復旧する', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dd026-initial-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    let calls = 0;
    const options: ServeOptions = {
      persistenceDir: dir,
      initialDocument: () => {
        calls += 1;
        return INITIAL;
      },
    };
    const server1 = await serve({ port: 0, ...options });
    const a = createSessionClient(`ws://127.0.0.1:${server1.port}/ws`, { clientId: 'client-a' });
    await waitFor(() => a.session.isOnline && a.session.committedDocument.rowOrder.length === 2, 'a bootstrapped');
    a.session.submitLocalOperation(setCells([{ rowId: row('r-1'), columnId: col('col-c'), value: str('file') }]));
    await waitFor(() => a.session.pendingCount === 0, 'a acked');
    a.transport.close();
    await waitFor(() => server1.connectionCount() === 0, 'a disconnected');
    await server1.stop();

    const server2 = await serve({ port: 0, ...options });
    cleanups.push(() => server2.stop());
    expect(calls).toBe(1);
    const b = createSessionClient(`ws://127.0.0.1:${server2.port}/ws`, { clientId: 'client-b' });
    cleanups.push(() => b.transport.close());
    await waitFor(() => b.session.isOnline && b.session.committedDocument.revision === 1, 'b restored');
    expect(valueOf(b, 'r-1', 'col-c')).toEqual({ kind: 'string', value: 'file' });
    expect(valueOf(b, 'r-2', 'col-c')).toEqual({ kind: 'date', value: '2026-09-03' });
  });

  it('S6: fail-fast（片方だけのストア／persistenceDir 併用／seedRows 併用／行 ID 重複／未知列）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dd026-ff-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await expect(serve({ port: 0, oplog: new MemoryServeOpLog() })).rejects.toThrow(/両方指定/);
    await expect(
      serve({ port: 0, persistenceDir: dir, oplog: new MemoryServeOpLog(), snapshotStore: new MemoryServeSnapshots() }),
    ).rejects.toThrow(/併用できません/);
    await expect(serve({ port: 0, seedRows: 3, initialDocument: () => INITIAL })).rejects.toThrow(/seedRows/);
    await expect(
      serve({ port: 0, initialDocument: () => ({ rows: [{ rowId: 'x' }, { rowId: 'x' }] }) }),
    ).rejects.toThrow(/重複/);
    await expect(
      serve({ port: 0, initialDocument: () => ({ rows: [{ rowId: 'x', cells: { nope: { kind: 'blank' } } }] }) }),
    ).rejects.toThrow(/columnOrder/);
  });
});

describe('serve() ストア注入 — Codex xhigh 指摘の回帰固定（DD-026-1）', () => {
  it('S9: 並行 append でも consumer ストアは呼び出し順に 1 件ずつ呼ばれ、失敗後は以降が reject される（fail-stop・Codex P1）', async () => {
    const calls: number[][] = [];
    let active = 0;
    let maxActive = 0;
    class RecordingOpLog extends MemoryServeOpLog {
      override async append(entries: readonly import('./index').ServeOperationEnvelope[]): Promise<void> {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push(entries.map((e) => e.revision));
        try {
          if (calls.length === 2) {
            await delay(80); // 2 件目（最初の submit）だけ遅い＝直列化が無ければ 3 件目が先に完了する
          }
          await super.append(entries);
        } finally {
          active -= 1;
        }
      }
    }
    const oplog = new RecordingOpLog();
    const server = await serve({ port: 0, seedRows: 1, oplog, snapshotStore: new MemoryServeSnapshots() });
    cleanups.push(() => server.stop());
    const change = (value: string) => ({ type: 'setCells' as const, changes: [{ rowId: 'row-1', columnId: 'col-a', value: { kind: 'string' as const, value } }] });
    const [r2, r3] = await Promise.all([server.submit(change('a'), { actorId: 'system' }), server.submit(change('b'), { actorId: 'system' })]);
    expect(r2.status).toBe('accepted');
    expect(r3.status).toBe('accepted');
    expect(maxActive).toBe(1); // 並行に呼ばれない
    expect(calls).toEqual([[1], [2], [3]]); // 呼び出し順＝revision 順
    expect(oplog.entries.map((e) => e.revision)).toEqual([1, 2, 3]);

    // fail-stop: 4 件目が失敗 → 同時に投入した 5 件目はストアを呼ばずに reject。以後は PersistentRoom も poisoned。
    oplog.failNext = true;
    const [p4, p5] = await Promise.allSettled([server.submit(change('c'), { actorId: 'system' }), server.submit(change('d'), { actorId: 'system' })]);
    expect(p4.status).toBe('rejected');
    expect(p5.status).toBe('rejected');
    if (p4.status === 'rejected' && p5.status === 'rejected') {
      expect(String(p4.reason)).toMatch(/append failed/);
      expect(String(p5.reason)).toMatch(/fail-stop/);
    }
    expect(calls).toHaveLength(4); // 5 件目はストアに届かない
    expect(oplog.entries.map((e) => e.revision)).toEqual([1, 2, 3]); // 欠番の revision がストアへ書かれない
    await expect(server.submit(change('e'), { actorId: 'system' })).rejects.toThrow(/poisoned/);
  });

  it('S10: 非有限 number・非正準 date は initialDocument の起動エラー／submit の reject（Codex P1・収束を壊す値を入れない）', async () => {
    await expect(
      serve({ port: 0, initialDocument: () => ({ rows: [{ rowId: 'x', cells: { 'col-a': { kind: 'number', value: Number.NaN } } }] }) }),
    ).rejects.toThrow(/有限数/);
    await expect(
      serve({ port: 0, initialDocument: () => ({ rows: [{ rowId: 'x', cells: { 'col-a': { kind: 'date', value: '2026/09/03' } } }] }) }),
    ).rejects.toThrow(/LocalDate/);
    const server = await serve({ port: 0, seedRows: 1 });
    cleanups.push(() => server.stop());
    const cell = (value: import('./index').ServeCellScalar) => ({ type: 'setCells' as const, changes: [{ rowId: 'row-1', columnId: 'col-a', value }] });
    await expect(server.submit(cell({ kind: 'number', value: Number.POSITIVE_INFINITY }), { actorId: 'system' })).rejects.toThrow(/有限数/);
    await expect(server.submit(cell({ kind: 'date', value: '2026-02-30' }), { actorId: 'system' })).rejects.toThrow(/LocalDate/);
    await expect(server.submit(cell({ kind: 'date', value: '2026-9-3' }), { actorId: 'system' })).rejects.toThrow(/LocalDate/);
    const ok = await server.submit(cell({ kind: 'date', value: '2026-09-03' }), { actorId: 'system' });
    expect(ok.status).toBe('accepted');
  });
});
