// 🔬 DD-056-1 機械検証（contract.md §3.2・DD-056-1 AC1〜AC9）: 操作ごとの書込の認可（authorizeOperation・H11）。
//   実 WS サーバー（ランダムポート）＋ ClientSession 2 体で、拒否が送信元だけを巻き戻し・サーバーを止めず・操作ログを汚さないこと、
//   fail-closed（throw・非 boolean・Promise）と再入の禁止、authenticate の actorId・複数文書の documentId・判定材料の複製、
//   永続化あり（再起動をまたぐ clientSequence）を確かめる。処理順（冪等・clientSequence・baseRevision との前後）は sequencer.test.ts。
import { afterEach, describe, expect, it } from 'vitest';

import { getCell } from '@nanairo-sheet/core';
import type { DocumentOperation } from '@nanairo-sheet/core';
import { col, row } from '@nanairo-sheet/collab/test-support';

import { serve } from './index';
import type { ServeDiagnostic, ServerInstance } from './index';
import { MemoryServeOpLog, MemoryServeSnapshots, createSessionClient, delay, waitFor } from './test-support';
import type { SessionClient } from './test-support';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const setCellA = (value: string): DocumentOperation => ({
  type: 'setCells',
  conflictPolicy: 'reject-overlap',
  changes: [{ rowId: row('row-1'), columnId: col('col-a'), value: { kind: 'string', value } }],
});

const viewCellA = (client: SessionClient): unknown => getCell(client.session.viewDocument, row('row-1'), col('col-a'))?.value;
const committedCellA = (client: SessionClient): unknown =>
  getCell(client.session.committedDocument, row('row-1'), col('col-a'))?.value;

/** 2 クライアント（A・B）を繋いで seed（revision 1）まで待つ。 */
async function connectPair(server: ServerInstance, query = ''): Promise<{ a: SessionClient; b: SessionClient }> {
  const wsUrl = `ws://127.0.0.1:${server.port}/ws${query}`;
  const a = createSessionClient(wsUrl, { clientId: 'client-a' });
  const b = createSessionClient(wsUrl, { clientId: 'client-b' });
  cleanups.push(() => a.transport.close(), () => b.transport.close());
  await waitFor(
    () => [a, b].every((c) => c.session.isOnline && c.session.committedDocument.revision >= 1),
    'both online and seeded',
  );
  return { a, b };
}

describe('serve({ authorizeOperation })（DD-056 H11）', () => {
  it('AC1/AC3: 拒否中の SetCells は送信元だけが巻き戻り、revision・oplog は進まず、B に届かない。許可に戻すと次の clientSequence で受理される', async () => {
    let locked = false;
    const oplog = new MemoryServeOpLog();
    const diags: ServeDiagnostic[] = [];
    const server = await serve({
      port: 0,
      seedRows: 2,
      oplog,
      snapshotStore: new MemoryServeSnapshots(),
      authorizeOperation: () => !locked,
      onDiagnostic: (entry) => diags.push(entry),
    });
    cleanups.push(() => server.stop());
    const { a, b } = await connectPair(server);
    expect(oplog.entries).toHaveLength(1); // seed

    locked = true;
    a.session.submitLocalOperation(setCellA('X'));
    expect(viewCellA(a)).toEqual({ kind: 'string', value: 'X' }); // 楽観適用
    await waitFor(() => a.session.conflictQueue.length === 1, 'A receives the rejection');
    const conflict = a.session.conflictQueue[0];
    expect(conflict?.reason).toBe('rejected');
    expect(conflict?.code).toBe('permission-denied');
    expect(viewCellA(a)).toBeUndefined(); // 巻き戻し（committed＋残りの pending から作り直す）
    expect(a.session.pendingCount).toBe(0);
    expect(a.session.committedDocument.revision).toBe(1);
    await delay(100); // 何も配信されないことを見るための待ち
    expect(b.session.committedDocument.revision).toBe(1);
    expect(committedCellA(b)).toBeUndefined();
    expect(oplog.entries).toHaveLength(1); // 拒否は永続化されない
    expect(server.connectionCount()).toBe(2); // 接続は切らない
    expect(diags.some((d) => d.code === 'operation-denied' && d.level === 'info')).toBe(true);

    // AC3: 許可に戻すと、A の次の操作（clientSequence 2）が通常どおり受理され、A・B が収束する。
    locked = false;
    a.session.submitLocalOperation(setCellA('Y'));
    await waitFor(() => [a, b].every((c) => c.session.committedDocument.revision === 2), 'both converge after unlock');
    for (const c of [a, b]) {
      expect(committedCellA(c)).toEqual({ kind: 'string', value: 'Y' });
    }
    expect(a.session.conflictQueue).toHaveLength(1); // 新しい拒否はない（sequence-violation のループもない）
    expect(oplog.entries.map((e) => e.revision)).toEqual([1, 2]);
  });

  it('AC2: 拒否中は行の挿入・削除も permission-denied（view の行構成は元に戻る）', async () => {
    let locked = false;
    const server = await serve({ port: 0, seedRows: 2, authorizeOperation: () => !locked });
    cleanups.push(() => server.stop());
    const { a, b } = await connectPair(server);
    locked = true;

    a.session.submitLocalOperation({ type: 'insertRows', afterRowId: row('row-2'), rows: [{ rowId: row('row-new') }] });
    a.session.submitLocalOperation({ type: 'deleteRows', rowIds: [row('row-1')] });
    expect(a.session.viewDocument.rowOrder.map(String)).toContain('row-new'); // 楽観適用
    await waitFor(() => a.session.conflictQueue.length === 2, 'both structural ops rejected');
    expect(a.session.conflictQueue.map((c) => c.code)).toEqual(['permission-denied', 'permission-denied']);
    expect(a.session.viewDocument.rowOrder.map(String)).toEqual(['row-1', 'row-2']);
    expect(a.session.viewDocument.rowMeta.get(row('row-1'))?.tombstone).toBe(false);
    expect(b.session.committedDocument.revision).toBe(1);
  });

  it('AC5: ServerInstance.submit は判定されない（拒否中でも受理され全接続へ配信される）', async () => {
    const seen: string[] = [];
    const server = await serve({
      port: 0,
      seedRows: 2,
      authorizeOperation: (request) => {
        seen.push(request.clientId);
        return false;
      },
    });
    cleanups.push(() => server.stop());
    const { a, b } = await connectPair(server);
    const result = await server.submit(
      { type: 'setCells', changes: [{ rowId: 'row-1', columnId: 'col-a', value: { kind: 'string', value: 'SYS' } }] },
      { actorId: 'system' },
    );
    expect(result.status).toBe('accepted');
    await waitFor(() => [a, b].every((c) => c.session.committedDocument.revision === 2), 'server op broadcast');
    expect(seen).toEqual([]); // フックは呼ばれていない
  });

  it('AC6: throw は authorize-error、非 boolean・Promise は authorize-invalid-result で拒否し、Promise の reject も捕捉する（接続は保たれる）', async () => {
    const diags: ServeDiagnostic[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    cleanups.push(() => {
      process.off('unhandledRejection', onUnhandled);
    });
    // フックが 1 回ごとに返すもの（Promise はフックの中で作る＝返す前に未捕捉 rejection として検出されないように）。
    const returns: Array<() => unknown> = [
      () => {
        throw new Error('hook bug');
      },
      () => undefined,
      () => Promise.resolve(true),
      () => Promise.reject(new Error('async hook failed')),
      () => true,
    ];
    let next = 0;
    const server = await serve({
      port: 0,
      seedRows: 2,
      authorizeOperation: (): boolean => {
        const produce = returns[next];
        next += 1;
        // @ts-expect-error JS consumer が型を無視して boolean 以外を返す誤りを模す（SDK の包みの fail-closed を確かめる）
        return produce?.();
      },
      onDiagnostic: (entry) => diags.push(entry),
    });
    cleanups.push(() => server.stop());
    const { a } = await connectPair(server);
    for (const value of ['t1', 't2', 't3', 't4']) {
      a.session.submitLocalOperation(setCellA(value));
    }
    await waitFor(() => a.session.conflictQueue.length === 4, 'four rejections');
    expect(a.session.conflictQueue.map((c) => c.code)).toEqual([
      'permission-denied',
      'permission-denied',
      'permission-denied',
      'permission-denied',
    ]);
    a.session.submitLocalOperation(setCellA('accepted'));
    await waitFor(() => a.session.committedDocument.revision === 2, 'true is accepted after the failures');
    expect(committedCellA(a)).toEqual({ kind: 'string', value: 'accepted' });
    await waitFor(
      () => diags.filter((d) => d.code === 'authorize-invalid-result').length >= 4,
      'invalid-result diagnostics incl. the rejected promise',
    );
    expect(diags.filter((d) => d.code === 'authorize-error')).toHaveLength(1);
    expect(diags.find((d) => d.code === 'authorize-error')?.message).toContain('hook bug');
    expect(diags.some((d) => d.code === 'authorize-invalid-result' && d.message.includes('async hook failed'))).toBe(true);
    expect(server.connectionCount()).toBe(2);
    await delay(50);
    expect(unhandled).toEqual([]); // Promise.reject を返したフックでも未捕捉 rejection は出ない
  });

  it('AC7: フックの中から呼んだ submit・stop は reject され（診断 authorize-reentry・未捕捉 rejection なし）、操作ログの revision は連番のまま', async () => {
    const oplog = new MemoryServeOpLog();
    const inner: Array<Promise<unknown>> = [];
    const diags: ServeDiagnostic[] = [];
    let serverRef: ServerInstance | undefined;
    const server = await serve({
      port: 0,
      seedRows: 2,
      oplog,
      snapshotStore: new MemoryServeSnapshots(),
      onDiagnostic: (entry) => diags.push(entry),
      authorizeOperation: () => {
        if (serverRef !== undefined) {
          inner.push(
            serverRef.submit(
              { type: 'setCells', changes: [{ rowId: 'row-2', columnId: 'col-b', value: { kind: 'string', value: 'INNER' } }] },
              { actorId: 'system' },
            ),
            serverRef.stop(),
          );
        }
        return true;
      },
    });
    serverRef = server;
    cleanups.push(() => server.stop());
    const { a, b } = await connectPair(server);
    a.session.submitLocalOperation(setCellA('outer'));
    await waitFor(() => [a, b].every((c) => c.session.committedDocument.revision === 2), 'outer op accepted');
    const settled = await Promise.allSettled(inner);
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
    for (const s of settled) {
      if (s.status === 'rejected') {
        expect(String(s.reason)).toContain('authorizeOperation の中からは呼べません');
      }
    }
    expect(oplog.entries.map((e) => e.revision)).toEqual([1, 2]); // 重複・欠番なし
    expect(getCell(b.session.committedDocument, row('row-2'), col('col-b'))).toBeUndefined(); // 内側の投入は入っていない
    expect(diags.filter((d) => d.code === 'authorize-reentry' && d.level === 'error')).toHaveLength(2);
    // サーバーは止まっていない（フックの外からの submit は受理される）。
    serverRef = undefined;
    const outside = await server.submit(
      { type: 'setCells', changes: [{ rowId: 'row-2', columnId: 'col-b', value: { kind: 'string', value: 'OUTSIDE' } }] },
      { actorId: 'system' },
    );
    expect(outside.status).toBe('accepted');
  });

  it('AC8: authenticate の actorId と接続先の documentId が渡り、判定材料の operation を書き換えても受理される操作は変わらない', async () => {
    const requests: Array<{ documentId: string; actorId: string; clientId: string; operationId: string }> = [];
    const server = await serve({
      port: 0,
      documents: {
        documentIds: ['doc-x', 'doc-y'],
        resolve: () => ({ columnOrder: ['col-a', 'col-b', 'col-c'], seedRows: 2 }),
      },
      authenticate: (request) => (request.headers.cookie === 'token=alice' ? { actorId: 'u-alice', displayName: 'Alice' } : null),
      authorizeOperation: (request) => {
        requests.push({
          documentId: request.documentId,
          actorId: request.actorId,
          clientId: request.clientId,
          operationId: request.operationId,
        });
        const operation = request.operation;
        if (operation.type === 'setCells') {
          const first = operation.changes[0];
          if (first !== undefined) {
            Reflect.set(first, 'value', { kind: 'string', value: 'HACKED' }); // consumer が判定材料を書き換えても
          }
        }
        return true;
      },
    });
    cleanups.push(() => server.stop());
    const client = createSessionClient(`ws://127.0.0.1:${server.port}/ws?documentId=doc-y`, {
      clientId: 'client-y',
      userId: 'spoofed-user', // 申告値（authenticate 指定時は使われない）
      documentId: 'doc-y',
      headers: { cookie: 'token=alice' },
    });
    cleanups.push(() => client.transport.close());
    await waitFor(() => client.session.isOnline && client.session.committedDocument.revision >= 1, 'doc-y online');
    const operationId = client.session.submitLocalOperation(setCellA('original'));
    await waitFor(() => client.session.committedDocument.revision === 2, 'accepted');
    expect(committedCellA(client)).toEqual({ kind: 'string', value: 'original' }); // 書き換えは受理に影響しない
    expect(requests).toEqual([{ documentId: 'doc-y', actorId: 'u-alice', clientId: 'client-y', operationId: String(operationId) }]);
  });

  it('AC9: 永続化ありでも拒否は oplog に入らず、再起動後（拒否の clientSequence 消費は永続化されない）も続けて受理される', async () => {
    let locked = true;
    const oplog = new MemoryServeOpLog();
    const snapshots = new MemoryServeSnapshots();
    const first = await serve({ port: 0, seedRows: 2, oplog, snapshotStore: snapshots, authorizeOperation: () => !locked });
    const port = first.port;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    const a = createSessionClient(wsUrl, { clientId: 'client-a', autoReconnect: true });
    cleanups.push(() => a.transport.close());
    await waitFor(() => a.session.isOnline && a.session.committedDocument.revision >= 1, 'online');
    a.session.submitLocalOperation(setCellA('denied'));
    await waitFor(() => a.session.conflictQueue.length === 1, 'rejected');
    expect(oplog.entries).toHaveLength(1);

    await first.stop();
    locked = false;
    const second = await serve({ port, seedRows: 2, oplog, snapshotStore: snapshots, authorizeOperation: () => !locked });
    cleanups.push(() => second.stop());
    await waitFor(() => a.session.isOnline, 'reconnected', 15_000);
    // 再起動で拒否の clientSequence 消費（seq 1）は失われている。A の次の操作（seq 2）は sequence-violation を経て
    // 再整列（DD-015 D27）され、受理される（黙った喪失・ループなし）。
    a.session.submitLocalOperation(setCellA('after-restart'));
    await waitFor(() => a.session.committedDocument.revision === 2, 'accepted after restart', 15_000);
    expect(committedCellA(a)).toEqual({ kind: 'string', value: 'after-restart' });
    expect(oplog.entries.map((e) => e.revision)).toEqual([1, 2]);
    expect(a.session.conflictQueue).toHaveLength(1); // 拒否は再起動前の 1 件だけ
  });
});
