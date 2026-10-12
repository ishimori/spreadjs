// 🔬 DD-056-3 機械検証（contract.md §5・DD-056-3 AC1〜AC6）: 実行中の文書の追加と撤去（addDocument・removeDocument・H13）。
//   実 WS サーバー（ランダムポート）＋ ClientSession で、足した文書への参加と収束、外した文書の接続断・再接続の拒否（404）・submit の拒否、
//   撤去が受理済みの操作の永続化と onAccepted を待つこと、同じ保存先での足し直し（続きから復旧）、ID の重複・処理中・stop との競合、
//   検疫した ID の足し直しを確かめる。撤去の受信停止（切断中のフレーム）と snapshot 生成の待機は serve.lifecycle-bridge.test.ts。
import { WebSocket } from 'ws';

import { afterEach, describe, expect, it } from 'vitest';

import { getCell } from '@nanairo-sheet/core';
import type { CellScalar } from '@nanairo-sheet/core';
import { col, row, setCells, str } from '@nanairo-sheet/collab/test-support';
import { createColumnId } from '@nanairo-sheet/types';

import { serve } from './index';
import type { ServeAcceptedEvent, ServeDiagnostic, ServeDocumentConfig, ServeOptions, ServerInstance } from './index';
import { MemoryServeOpLog, MemoryServeSnapshots, createSessionClient, delay, waitFor } from './test-support';
import type { SessionClient } from './test-support';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const COLUMNS = ['col-a', 'col-b', 'col-c'];

async function start(options: ServeOptions): Promise<ServerInstance> {
  const server = await serve({ port: 0, ...options });
  cleanups.push(async () => {
    await server.stop().catch(() => undefined); // テスト内で stop 済みでもよい
  });
  return server;
}

/** 既定文書 'base' だけの複数文書構成（足す・外す文書は各テストが addDocument する）。 */
function baseOnly(extra: Partial<ServeOptions> = {}): ServeOptions {
  return {
    documents: { documentIds: ['base'], resolve: () => ({ columnOrder: COLUMNS, seedRows: 1 }) },
    ...extra,
  };
}

function connect(server: ServerInstance, documentId: string, clientId: string): SessionClient {
  const client = createSessionClient(`ws://127.0.0.1:${server.port}/ws?documentId=${encodeURIComponent(documentId)}`, {
    clientId,
    documentId,
    columnOrder: COLUMNS.map((c) => createColumnId(c)),
  });
  cleanups.push(() => client.transport.close());
  return client;
}

function valueOf(client: SessionClient, rowId: string, columnId: string): CellScalar | undefined {
  return getCell(client.session.committedDocument, row(rowId), col(columnId))?.value;
}

function upgradeStatus(url: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      ws.terminate();
      resolve(res.statusCode ?? 0);
    });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('error', (error: Error) => {
      reject(error);
    });
  });
}

const versionDoc = (overrides: Partial<ServeDocumentConfig> = {}): ServeDocumentConfig => ({
  columnOrder: COLUMNS,
  initialDocument: () => ({ rows: [{ rowId: 'r1', cells: { 'col-a': { kind: 'string', value: '初期' } } }, { rowId: 'r2' }] }),
  ...overrides,
});

describe('ServerInstance.addDocument / removeDocument（DD-056 H13）', () => {
  it('AC1: 実行中に足した文書へ 2 クライアントが参加して編集・収束し、documentIds と /config に載る', async () => {
    const diags: ServeDiagnostic[] = [];
    const server = await start(baseOnly({ onDiagnostic: (entry) => diags.push(entry) }));
    expect(await upgradeStatus(`ws://127.0.0.1:${server.port}/ws?documentId=v2`)).toBe(404);
    await server.addDocument('v2', versionDoc());
    expect(server.documentIds).toEqual(['base', 'v2']);
    expect((await fetch(`${server.url}/config?documentId=v2`)).status).toBe(200);
    expect(diags.some((d) => d.code === 'document-added' && d.level === 'info')).toBe(true);

    const a = connect(server, 'v2', 'client-a');
    const b = connect(server, 'v2', 'client-b');
    await waitFor(() => [a, b].every((c) => c.session.isOnline && valueOf(c, 'r1', 'col-a') !== undefined), 'joined v2');
    expect(valueOf(a, 'r1', 'col-a')).toEqual(str('初期'));
    a.session.submitLocalOperation(setCells([{ rowId: row('r2'), columnId: col('col-b'), value: str('A の入力') }]));
    await waitFor(() => valueOf(b, 'r2', 'col-b')?.kind === 'string', 'converged');
    expect(a.session.committedHash()).toBe(b.session.committedHash());
    // サーバー起点の投入も宛先を指定できる。
    const result = await server.submit(
      { type: 'setCells', changes: [{ rowId: 'r2', columnId: 'col-c', value: { kind: 'number', value: 7 } }] },
      { actorId: 'system', documentId: 'v2' },
    );
    expect(result.status).toBe('accepted');
  });

  it('AC2: 外すと接続が切れ、再接続は 404・/config は 404・submit は reject、documentIds から外れる（外した文書への再送は受け付けない）', async () => {
    const diags: ServeDiagnostic[] = [];
    const server = await start(baseOnly({ onDiagnostic: (entry) => diags.push(entry) }));
    await server.addDocument('v1', versionDoc());
    const a = connect(server, 'v1', 'client-a');
    await waitFor(() => a.session.isOnline && valueOf(a, 'r1', 'col-a') !== undefined, 'joined v1');

    await server.removeDocument('v1');
    await waitFor(() => !a.session.isOnline, 'client disconnected');
    expect(server.documentIds).toEqual(['base']);
    expect(await upgradeStatus(`ws://127.0.0.1:${server.port}/ws?documentId=v1`)).toBe(404);
    expect((await fetch(`${server.url}/config?documentId=v1`)).status).toBe(404);
    await expect(
      server.submit(
        { type: 'setCells', changes: [{ rowId: 'r1', columnId: 'col-a', value: { kind: 'string', value: 'X' } }] },
        { actorId: 'system', documentId: 'v1' },
      ),
    ).rejects.toThrow(/serve していません/);
    expect(diags.some((d) => d.code === 'document-removed')).toBe(true);
    expect(server.connectionCount()).toBe(0);
    // 既定文書は引き続き使える。
    expect(await upgradeStatus(`ws://127.0.0.1:${server.port}/ws`)).toBe(101);
  });

  it('AC3: 撤去は、撤去の前に受理した操作の永続化と onAccepted が済んでから解決する', async () => {
    const accepted: ServeAcceptedEvent[] = [];
    const oplog = new MemoryServeOpLog();
    const server = await start(baseOnly({ onAccepted: (event) => void accepted.push(event) }));
    await server.addDocument('v1', versionDoc({ oplog, snapshotStore: new MemoryServeSnapshots() }));
    const a = connect(server, 'v1', 'client-a');
    await waitFor(() => a.session.isOnline && valueOf(a, 'r1', 'col-a') !== undefined, 'joined v1');

    oplog.gate = true; // append を保留する（受理は済んだが永続化待ち）
    a.session.submitLocalOperation(setCells([{ rowId: row('r1'), columnId: col('col-b'), value: str('最後の入力') }]));
    await waitFor(() => oplog.appendCalls === 1, 'append in flight');

    let removed = false;
    const removing = server.removeDocument('v1').then(() => {
      removed = true;
    });
    await delay(50);
    expect(removed).toBe(false); // 永続化待ちの受理を待っている
    expect(accepted).toHaveLength(0);
    expect(server.documentIds).toEqual(['base']); // 登録からは先に外れている

    oplog.release();
    await removing;
    expect(oplog.entries.map((e) => e.revision)).toEqual([1]);
    expect(accepted.map((e) => [e.documentId, e.revision])).toEqual([['v1', 1]]); // onAccepted は解決の前に届いている
  });

  it('AC5: 同じ ID・同じ保存先で足し直すと続きの revision から復旧する（初期文書は作り直さない）', async () => {
    const oplog = new MemoryServeOpLog();
    const snapshots = new MemoryServeSnapshots();
    let initialCalls = 0;
    const config = versionDoc({
      oplog,
      snapshotStore: snapshots,
      initialDocument: () => {
        initialCalls += 1;
        return { rows: [{ rowId: 'r1' }] };
      },
    });
    const server = await start(baseOnly());
    await server.addDocument('v1', config);
    const a = connect(server, 'v1', 'client-a');
    await waitFor(() => a.session.isOnline && a.session.committedDocument.rowOrder.length === 1, 'joined');
    a.session.submitLocalOperation(setCells([{ rowId: row('r1'), columnId: col('col-a'), value: str('残る値') }]));
    await waitFor(() => a.session.committedDocument.revision === 1, 'accepted');
    await server.removeDocument('v1');

    await server.addDocument('v1', config);
    expect(initialCalls).toBe(1); // 2 回目は保存先から復旧（初期文書を作らない）
    const b = connect(server, 'v1', 'client-b');
    await waitFor(() => b.session.isOnline && valueOf(b, 'r1', 'col-a') !== undefined, 'rejoined');
    expect(valueOf(b, 'r1', 'col-a')).toEqual(str('残る値'));
    expect(b.session.committedDocument.revision).toBe(1);
    b.session.submitLocalOperation(setCells([{ rowId: row('r1'), columnId: col('col-b'), value: str('続き') }]));
    await waitFor(() => b.session.committedDocument.revision === 2, 'continues from revision 1');
    expect(oplog.entries.map((e) => e.revision)).toEqual([1, 2]);
  });

  it('AC6: 重複・空・処理中・serve していない ID・stop 後の追加と撤去は reject する', async () => {
    const server = await start(baseOnly());
    await expect(server.addDocument('base', versionDoc())).rejects.toThrow(/serve 中/);
    await expect(server.addDocument('', versionDoc())).rejects.toThrow(/空/);
    await expect(server.removeDocument('nope')).rejects.toThrow(/serve していません/);

    let release: (() => void) | undefined;
    const slow = versionDoc({
      initialDocument: () =>
        new Promise((resolve) => {
          release = () => resolve({ rows: [] });
        }),
    });
    const adding = server.addDocument('slow', slow);
    await expect(server.addDocument('slow', versionDoc())).rejects.toThrow(/処理中/);
    await expect(server.removeDocument('slow')).rejects.toThrow(/処理中/); // 追加の途中はまだ登録されていない＝処理中で拒否
    await waitFor(() => release !== undefined, 'initialDocument called');
    release?.();
    await adding;
    expect(server.documentIds).toEqual(['base', 'slow']);
    await expect(server.addDocument('bad', { columnOrder: COLUMNS, seedRows: 1, initialDocument: () => ({ rows: [] }) })).rejects.toThrow(
      /併用できません/,
    );

    await server.stop();
    await expect(server.addDocument('late', versionDoc())).rejects.toThrow(/stopped/);
    await expect(server.removeDocument('slow')).rejects.toThrow(/stopped/);
  });

  it('AC6: 追加の途中で stop すると、stop は追加の終わりを待ち、作った文書を閉じて追加は reject する（保存先のハンドルを残さない）', async () => {
    let closes = 0;
    const oplog = new MemoryServeOpLog();
    const snapshots = new MemoryServeSnapshots();
    const originalOplogClose = oplog.close.bind(oplog);
    oplog.close = () => {
      closes += 1;
      return originalOplogClose();
    };
    let release: (() => void) | undefined;
    const server = await start(baseOnly());
    const adding = server.addDocument(
      'v9',
      versionDoc({
        oplog,
        snapshotStore: snapshots,
        initialDocument: () =>
          new Promise((resolve) => {
            release = () => resolve({ rows: [{ rowId: 'r1' }] });
          }),
      }),
    );
    const addOutcome = adding.then(
      () => 'resolved',
      (error: unknown) => String(error),
    );
    await waitFor(() => release !== undefined, 'initialDocument called');
    let stopped = false;
    const stopping = server.stop().then(() => {
      stopped = true;
    });
    await delay(30);
    expect(stopped).toBe(false); // 追加の終わりを待っている
    release?.();
    await stopping;
    expect(await addOutcome).toMatch(/停止しました/);
    expect(closes).toBe(1); // 作った文書の保存先を閉じた
  });

  it('起動時に検疫した ID を健全な保存先で足し直すと serve され、quarantined から外れる', async () => {
    const poisoned = new MemoryServeOpLog();
    poisoned.readAll = () => Promise.reject(new Error('oplog 破損（テスト注入）'));
    const server = await start({
      documents: {
        documentIds: ['base', 'broken'],
        resolve: (documentId) =>
          documentId === 'broken'
            ? { columnOrder: COLUMNS, oplog: poisoned, snapshotStore: new MemoryServeSnapshots() }
            : { columnOrder: COLUMNS, seedRows: 1 },
      },
      onDiagnostic: () => undefined,
    });
    expect(server.quarantined.map((q) => q.documentId)).toEqual(['broken']);
    await server.addDocument('broken', versionDoc());
    expect(server.quarantined).toEqual([]);
    expect(server.documentIds).toEqual(['base', 'broken']);
  });

  it('既定文書も外せる（以後の documentId なしの接続は 404）。単一文書構成でも addDocument できる', async () => {
    const server = await start({ seedRows: 1 }); // 単一文書構成（既定 'demo-doc'）
    await server.addDocument('extra', versionDoc());
    expect(server.documentIds).toEqual(['demo-doc', 'extra']);
    const extra = connect(server, 'extra', 'client-x');
    await waitFor(() => extra.session.isOnline && valueOf(extra, 'r1', 'col-a') !== undefined, 'joined extra');
    await server.removeDocument('demo-doc');
    expect(await upgradeStatus(`ws://127.0.0.1:${server.port}/ws`)).toBe(404);
    expect(await upgradeStatus(`ws://127.0.0.1:${server.port}/ws?documentId=extra`)).toBe(101);
  });
});
