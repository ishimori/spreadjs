// 🔬 DD-026-3 機械検証（contract.md §5 B1/B2/B3/B5）: サーバー起点操作（U3）。通常受理経路（revision 付与・全接続へ配信・永続化）／
//   OCC reject は結果で返す／stop 後は reject・再起動をまたいで clientSequence が継続／durable 失敗後は write 停止（poisoning）。
//   B4（Undo 非対象）は grid の own-echo 判定 unit（packages/grid/src/session-sync.test.ts）で固定する。
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { getCell } from '@nanairo-sheet/core';
import { col, row } from '@nanairo-sheet/collab/test-support';

import { serve } from './index';
import type { ServeSetCellsInput } from './index';
import { MemoryServeOpLog, MemoryServeSnapshots, createSessionClient, delay, waitFor } from './test-support';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const SYS: ServeSetCellsInput = {
  type: 'setCells',
  changes: [{ rowId: 'row-1', columnId: 'col-a', value: { kind: 'string', value: 'SYS' } }],
};

describe('ServerInstance.submit（U3・DD-026-3）', () => {
  it('B1/B2: 受理→revision 付与・全接続へ配信・永続化（clientId=server）。古い beforeRevision は rejected で文書不変', async () => {
    const oplog = new MemoryServeOpLog();
    const server = await serve({ port: 0, seedRows: 2, oplog, snapshotStore: new MemoryServeSnapshots() });
    cleanups.push(() => server.stop());
    const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
    const a = createSessionClient(wsUrl, { clientId: 'client-a' });
    const b = createSessionClient(wsUrl, { clientId: 'client-b' });
    cleanups.push(() => a.transport.close(), () => b.transport.close());
    await waitFor(() => a.session.isOnline && b.session.isOnline && b.session.committedDocument.revision >= 1, 'both online');

    const result = await server.submit(SYS, { actorId: 'system' });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') {
      throw new Error('unreachable');
    }
    expect(result.revision).toBe(2); // seed=1 の次
    // 永続化（append 解決後に resolve）: oplog の envelope は clientId 'server'・actorId 'system'。
    const entry = oplog.entries[1];
    expect(entry.revision).toBe(2);
    expect(entry.operationId).toBe(result.operationId);
    expect(entry.clientId).toBe('server');
    expect(entry.actorId).toBe('system');
    expect(entry.operation).toEqual({ ...SYS, conflictPolicy: 'reject-overlap' });
    // 配信: 両クライアントが revision 2 に到達し、送信元クライアントは存在しない（pending 0）。
    await waitFor(() => [a, b].every((c) => c.session.committedDocument.revision === 2), 'broadcast to all');
    for (const c of [a, b]) {
      expect(c.session.pendingCount).toBe(0);
      expect(getCell(c.session.committedDocument, row('row-1'), col('col-a'))?.value).toEqual({ kind: 'string', value: 'SYS' });
    }
    expect(a.session.committedHash()).toBe(b.session.committedHash());

    // B2: セルの現在 revision は 2。beforeRevision 1 は stale → rejected（結果で返す・throw しない）。
    const stale = await server.submit(
      { type: 'setCells', changes: [{ rowId: 'row-1', columnId: 'col-a', beforeRevision: 1, value: { kind: 'string', value: 'LATE' } }] },
      { actorId: 'system' },
    );
    expect(stale).toEqual({ status: 'rejected', operationId: stale.operationId, code: 'stale-cell-revision' });
    await delay(60);
    expect(oplog.entries).toHaveLength(2); // 永続化されない
    for (const c of [a, b]) {
      expect(c.session.committedDocument.revision).toBe(2);
      expect(getCell(c.session.committedDocument, row('row-1'), col('col-a'))?.value).toEqual({ kind: 'string', value: 'SYS' });
    }
    // 現在 revision（2）を beforeRevision に指定した OCC 更新は受理される。
    const fresh = await server.submit(
      { type: 'setCells', changes: [{ rowId: 'row-1', columnId: 'col-a', beforeRevision: 2, value: { kind: 'number', value: 7 } }] },
      { actorId: 'system' },
    );
    expect(fresh.status).toBe('accepted');
    await waitFor(() => [a, b].every((c) => c.session.committedDocument.revision === 3), 'occ update broadcast');
  });

  it('B3: stop 後の submit は reject。同じストアで再 serve すると clientSequence が継続して受理される', async () => {
    const oplog = new MemoryServeOpLog();
    const snapshots = new MemoryServeSnapshots();
    const server1 = await serve({ port: 0, seedRows: 1, oplog, snapshotStore: snapshots });
    const first = await server1.submit(SYS, { actorId: 'system' });
    expect(first.status).toBe('accepted');
    expect(oplog.entries[1].clientSequence).toBe(1);
    await server1.stop();
    await expect(server1.submit(SYS, { actorId: 'system' })).rejects.toThrow(/stopped/);

    const server2 = await serve({ port: 0, seedRows: 1, oplog, snapshotStore: snapshots });
    cleanups.push(() => server2.stop());
    const second = await server2.submit(SYS, { actorId: 'system' });
    expect(second.status).toBe('accepted'); // clientSequence が 1 に戻ると client-sequence-violation で reject される
    expect(oplog.entries[2].clientSequence).toBe(2);
    expect(oplog.entries[2].revision).toBe(3);
  });

  it('B5: durable 失敗（append reject）で submit は reject し、以後の submit も拒否される（poisoning・既存契約）', async () => {
    const oplog = new MemoryServeOpLog();
    const server = await serve({ port: 0, seedRows: 1, oplog, snapshotStore: new MemoryServeSnapshots() });
    cleanups.push(() => server.stop());
    oplog.failNext = true;
    await expect(server.submit(SYS, { actorId: 'system' })).rejects.toThrow(/append failed/);
    await expect(server.submit(SYS, { actorId: 'system' })).rejects.toThrow(/poisoned/);
    expect(oplog.entries).toHaveLength(1); // seed のみ
  });

  it('引数エラー（changes 空・actorId 空）は reject、in-memory（永続化なし）でも通常経路で受理される', async () => {
    const server = await serve({ port: 0, seedRows: 1 });
    cleanups.push(() => server.stop());
    await expect(server.submit({ type: 'setCells', changes: [] }, { actorId: 'system' })).rejects.toThrow(/changes/);
    await expect(server.submit(SYS, { actorId: '' })).rejects.toThrow(/actorId/);
    const a = createSessionClient(`ws://127.0.0.1:${server.port}/ws`, { clientId: 'client-a' });
    cleanups.push(() => a.transport.close());
    await waitFor(() => a.session.isOnline && a.session.committedDocument.revision >= 1, 'online');
    const result = await server.submit(SYS, { actorId: 'system' });
    expect(result.status).toBe('accepted');
    await waitFor(() => a.session.committedDocument.revision === 2, 'delivered');
  });

  it("予約 clientId 'server' で join するクライアントは 1008 で拒否される（サーバー起点操作の clientSequence 表を共有させない）", async () => {
    const server = await serve({ port: 0, seedRows: 1 });
    cleanups.push(() => server.stop());
    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'join', protocolVersion: 1, documentId: 'demo-doc', lastAppliedRevision: 0, clientId: 'server' }));
      });
      ws.on('close', (code) => resolve(code));
      ws.on('error', reject);
    });
    expect(closeCode).toBe(1008);
    expect(server.connectionCount()).toBe(0);
    const ok = createSessionClient(`ws://127.0.0.1:${server.port}/ws`, { clientId: 'client-ok' });
    cleanups.push(() => ok.transport.close());
    await waitFor(() => ok.session.isOnline && ok.session.committedDocument.revision >= 1, 'normal client online');
  });
});
