// 🔬 DD-043 機械検証（複数文書 serve・N 枚固定・resolver 契約・ADR-0025）:
//   M1 2 文書を 1 プロセスで serve し独立に収束（操作・presence の漏れゼロ・AC1）／
//   M2 `/config?documentId=` が文書ごとの列順を返し、未知 ID は 404（AC4）／
//   M3 `/ws?documentId=` の未知 ID は upgrade を 404 で拒否（AC4）／
//   M4 起動時の検疫＝一方の復旧失敗が他方の起動を妨げない（AC3）／
//   M5 構成の fail-fast（documents×単一文書オプション併用・空/重複 documentIds・resolve が null）／
//   M6 サーバー起点 submit の宛先文書指定（未知 ID は reject）／
//   M7 join の申告 documentId 不一致は厳格接続で切断／M8 join 後の submitOperation で別文書を名乗っても切断／
//   M9 単一文書（従来）接続の申告不一致は受理しつつ oplog はサーバー値へ正規化される（oplog 汚染経路の封鎖・Codex P1）／
//   M10 1 文書の close 失敗でも残りの文書とサーバーの後始末を完遂する（Codex P1）。
// 単一文書構成の後方互換（AC2）は既存スイート全体（serve.stores / serve.auth / serve.submit / persistence / smoke）が担保する。
import { WebSocket } from 'ws';

import { afterEach, describe, expect, it } from 'vitest';

import { getCell } from '@nanairo-sheet/core';
import type { CellScalar } from '@nanairo-sheet/core';
import { col, row, setCells, str } from '@nanairo-sheet/collab/test-support';
import { createColumnId } from '@nanairo-sheet/types';

import { serve } from './index';
import type { ServeDiagnostic, ServeDocumentConfig, ServeOptions } from './index';
import { MemoryServeOpLog, MemoryServeSnapshots, createSessionClient, delay, waitFor } from './test-support';
import type { SessionClient } from './test-support';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const COLUMNS_A = ['col-a', 'col-b', 'col-c'];
const COLUMNS_B = ['2026-04-01', '2026-04-02']; // ③納入計画の年度別 board を模した別列構成

/** 2 文書（doc-a / doc-b）を固定リストで引く resolver 構成。 */
function twoDocuments(overrides: Record<string, ServeDocumentConfig> = {}): ServeOptions {
  const configs: Record<string, ServeDocumentConfig> = {
    'doc-a': { columnOrder: COLUMNS_A, seedRows: 2 },
    'doc-b': { columnOrder: COLUMNS_B, seedRows: 2 },
    ...overrides,
  };
  return {
    documents: {
      documentIds: Object.keys(configs),
      resolve: (documentId) => configs[documentId] ?? null,
    },
  };
}

async function startServer(options: ServeOptions): Promise<Awaited<ReturnType<typeof serve>>> {
  const server = await serve({ port: 0, ...options });
  cleanups.push(() => server.stop());
  return server;
}

function connect(port: number, documentId: string, clientId: string, columnOrder: string[]): SessionClient {
  const client = createSessionClient(`ws://127.0.0.1:${port}/ws?documentId=${encodeURIComponent(documentId)}`, {
    clientId,
    documentId,
    columnOrder: columnOrder.map((c) => createColumnId(c)),
  });
  cleanups.push(() => client.transport.close());
  return client;
}

function valueOf(client: SessionClient, rowId: string, columnId: string): CellScalar | undefined {
  return getCell(client.session.committedDocument, row(rowId), col(columnId))?.value;
}

/** 生 WS で接続し、送信フレームと close コードを観測する（プロトコル違反の検証用）。 */
async function rawClient(url: string): Promise<{
  send(message: unknown): void;
  closeCode(): Promise<number>;
  socket: WebSocket;
}> {
  const socket = new WebSocket(url);
  cleanups.push(() => {
    socket.terminate();
  });
  const closed = new Promise<number>((resolve) => {
    socket.on('close', (code: number) => resolve(code));
  });
  socket.on('error', () => {}); // terminate 後の error を uncaught 化させない
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('unexpected-response', (_req, res) => reject(new Error(`upgrade rejected: ${String(res.statusCode)}`)));
  });
  return {
    send: (message) => socket.send(JSON.stringify(message)),
    closeCode: () => closed,
    socket,
  };
}

/** 生 WS 用の join フレーム。 */
function joinFrame(documentId: string, clientId: string): unknown {
  return { type: 'join', protocolVersion: 1, documentId, lastAppliedRevision: 0, clientId };
}

/** 生 WS 用の submitOperation フレーム（SetCells 1 件）。 */
function submitFrame(options: {
  documentId: string;
  clientId: string;
  columnId: string;
  baseRevision: number;
  value: string;
}): unknown {
  return {
    type: 'submitOperation',
    envelope: {
      protocolVersion: 1,
      documentId: options.documentId,
      operationId: `${options.clientId}-op-1`,
      transactionId: `tx-${options.clientId}-1`,
      actorId: options.clientId,
      clientId: options.clientId,
      clientSequence: 1,
      baseRevision: options.baseRevision,
      operation: {
        type: 'setCells',
        changes: [{ rowId: 'row-1', columnId: options.columnId, value: { kind: 'string', value: options.value } }],
        conflictPolicy: 'reject-overlap',
      },
    },
  };
}

/** WS upgrade の HTTP 応答ステータスを観測する（受理された場合は 101 を返して閉じる）。 */
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
      // unexpected-response を購読しているため、ここへ来るのは接続自体の失敗。
      reject(error);
    });
  });
}

describe('serve() 複数文書（DD-043・ADR-0025）', () => {
  it('M1: 2 文書を 1 プロセスで serve し、操作も presence も文書をまたがない（AC1）', async () => {
    const server = await startServer(twoDocuments());
    expect(server.documentIds).toEqual(['doc-a', 'doc-b']);
    expect(server.documentId).toBe('doc-a'); // defaultDocumentId 未指定 → documentIds[0]
    expect(server.quarantined).toEqual([]);

    const a = connect(server.port, 'doc-a', 'client-a', COLUMNS_A);
    const b = connect(server.port, 'doc-b', 'client-b', COLUMNS_B);
    // join → welcome → bootstrap（seed の revision 1）まで待ってから編集する（online は transport 確立のみを表す）。
    await waitFor(
      () => a.session.committedDocument.revision >= 1 && b.session.committedDocument.revision >= 1,
      'both seeded',
    );

    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('A面') }]));
    b.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('2026-04-01'), value: str('B面') }]));
    await waitFor(
      () => a.session.committedDocument.revision >= 2 && b.session.committedDocument.revision >= 2,
      'both acked',
    );

    // それぞれの文書だけが自分の編集を持つ（漏れゼロ）。
    expect(valueOf(a, 'row-1', 'col-a')).toEqual({ kind: 'string', value: 'A面' });
    expect(valueOf(b, 'row-1', '2026-04-01')).toEqual({ kind: 'string', value: 'B面' });
    expect(valueOf(a, 'row-1', '2026-04-01')).toBeUndefined();
    expect(valueOf(b, 'row-1', 'col-a')).toBeUndefined();
    // revision も文書ごとに独立（seed 1 + 自分の 1 件）。
    expect(a.session.committedDocument.revision).toBe(2);
    expect(b.session.committedDocument.revision).toBe(2);

    // presence も混ざらない（相手の文書の在席者を見ない）。
    a.session.sendPresence({ activeCell: { rowId: row('row-1'), columnId: col('col-a') }, selectionRanges: [] });
    b.session.sendPresence({ activeCell: { rowId: row('row-1'), columnId: col('2026-04-01') }, selectionRanges: [] });
    await delay(60);
    expect(a.session.knownPresences()).toEqual([]);
    expect(b.session.knownPresences()).toEqual([]);

    expect(server.connectionCount()).toBe(2); // 全文書合計
    expect(server.connectionCount('doc-a')).toBe(1);
    expect(server.connectionCount('doc-b')).toBe(1);
  });

  it('M2: /config が documentId ごとの列順を返し、未知 ID は 404（AC4）', async () => {
    const server = await startServer(twoDocuments());

    const defaulted = await (await fetch(`${server.url}/config`)).json();
    expect(defaulted).toMatchObject({ documentId: 'doc-a', columnOrder: COLUMNS_A });

    const b = await (await fetch(`${server.url}/config?documentId=doc-b`)).json();
    expect(b).toMatchObject({ documentId: 'doc-b', columnOrder: COLUMNS_B });

    const unknown = await fetch(`${server.url}/config?documentId=doc-zzz`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: 'unknown-document', documentId: 'doc-zzz' });

    // /snapshot（検査用）も同じ規則に従う。
    expect((await fetch(`${server.url}/snapshot?documentId=doc-zzz`)).status).toBe(404);
    expect((await fetch(`${server.url}/snapshot?documentId=doc-b`)).status).toBe(200);
  });

  it('M3: /ws は未知 documentId の upgrade を 404 で拒否する（AC4）', async () => {
    const server = await startServer(twoDocuments());
    expect(await upgradeStatus(`ws://127.0.0.1:${server.port}/ws?documentId=doc-b`)).toBe(101);
    expect(await upgradeStatus(`ws://127.0.0.1:${server.port}/ws?documentId=doc-zzz`)).toBe(404);
    expect(await upgradeStatus(`ws://127.0.0.1:${server.port}/ws`)).toBe(101); // 無指定＝既定文書
  });

  it('M4: 一方の文書の復旧失敗は他方の起動を妨げない（起動時の検疫・AC3）', async () => {
    const diagnostics: ServeDiagnostic[] = [];
    // doc-b の oplog だけが readAll で恒久的に失敗する（deterministic poison の模擬）。
    const poisoned = new MemoryServeOpLog();
    poisoned.readAll = () => Promise.reject(new Error('oplog 破損（テスト注入）'));
    const server = await startServer({
      onDiagnostic: (entry) => diagnostics.push(entry),
      ...twoDocuments({
        'doc-b': { columnOrder: COLUMNS_B, seedRows: 2, oplog: poisoned, snapshotStore: new MemoryServeSnapshots() },
      }),
    });

    expect(server.documentIds).toEqual(['doc-a']); // 健全な文書だけで立ち上がる
    expect(server.quarantined).toHaveLength(1);
    expect(server.quarantined[0]?.documentId).toBe('doc-b');
    expect(server.quarantined[0]?.reason).toContain('oplog 破損');
    expect(diagnostics.filter((d) => d.code === 'document-quarantined' && d.level === 'error')).not.toHaveLength(0);

    // 検疫された文書は外形上も serve されていない（接続・設定取得とも 404）。
    expect((await fetch(`${server.url}/config?documentId=doc-b`)).status).toBe(404);
    expect(await upgradeStatus(`ws://127.0.0.1:${server.port}/ws?documentId=doc-b`)).toBe(404);

    // 残った文書は通常どおり編集できる。
    const a = connect(server.port, 'doc-a', 'client-a', COLUMNS_A);
    await waitFor(() => a.session.committedDocument.revision >= 1, 'a seeded');
    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('生存') }]));
    await waitFor(() => a.session.committedDocument.revision >= 2, 'a acked');
    expect(valueOf(a, 'row-1', 'col-a')).toEqual({ kind: 'string', value: '生存' });
  });

  it('M4b: 全文書が検疫されても listen は続き、全接続が 404 になる（再起動ループを作らない）', async () => {
    const brokenOplog = (): MemoryServeOpLog => {
      const oplog = new MemoryServeOpLog();
      oplog.readAll = () => Promise.reject(new Error('oplog 破損（テスト注入）'));
      return oplog;
    };
    const server = await startServer(
      twoDocuments({
        'doc-a': { columnOrder: COLUMNS_A, seedRows: 2, oplog: brokenOplog(), snapshotStore: new MemoryServeSnapshots() },
        'doc-b': { columnOrder: COLUMNS_B, seedRows: 2, oplog: brokenOplog(), snapshotStore: new MemoryServeSnapshots() },
      }),
    );
    expect(server.documentIds).toEqual([]);
    expect(server.quarantined.map((q) => q.documentId)).toEqual(['doc-a', 'doc-b']);
    expect((await fetch(`${server.url}/health`)).status).toBe(200); // 死活監視の口は変えない
    expect((await fetch(`${server.url}/config`)).status).toBe(404);
    expect(await upgradeStatus(`ws://127.0.0.1:${server.port}/ws`)).toBe(404);
  });

  it('M5: 構成の fail-fast（単一文書オプション併用・空/重複 documentIds・未知の default・resolve が null）', async () => {
    await expect(
      serve({ port: 0, documentId: 'doc-a', ...twoDocuments() }),
    ).rejects.toThrow(/documents と単一文書オプション/);
    await expect(
      serve({ port: 0, seedRows: 3, ...twoDocuments() }),
    ).rejects.toThrow(/documents と単一文書オプション/);
    await expect(
      serve({ port: 0, documents: { documentIds: [], resolve: () => null } }),
    ).rejects.toThrow(/documentIds が空/);
    await expect(
      serve({ port: 0, documents: { documentIds: ['x', 'x'], resolve: () => ({ columnOrder: COLUMNS_A }) } }),
    ).rejects.toThrow(/重複/);
    await expect(
      serve({
        port: 0,
        documents: { documentIds: ['x'], resolve: () => ({ columnOrder: COLUMNS_A }), defaultDocumentId: 'y' },
      }),
    ).rejects.toThrow(/defaultDocumentId/);
    await expect(
      serve({ port: 0, documents: { documentIds: ['x'], resolve: () => null } }),
    ).rejects.toThrow(/null を返しました/);
    // 文書ごとの排他規則も同じ検証を通る（どの文書の構成が矛盾しているかを示す）。
    await expect(
      serve({
        port: 0,
        documents: {
          documentIds: ['x'],
          resolve: () => ({ columnOrder: COLUMNS_A, oplog: new MemoryServeOpLog() }),
        },
      }),
    ).rejects.toThrow(/\[documentId=x\].*両方指定/);
  });

  it('M6: サーバー起点 submit は宛先文書へ入り、serve していない ID は reject（U3×複数文書）', async () => {
    const server = await startServer(twoDocuments());
    const a = connect(server.port, 'doc-a', 'client-a', COLUMNS_A);
    const b = connect(server.port, 'doc-b', 'client-b', COLUMNS_B);
    await waitFor(
      () => a.session.committedDocument.revision >= 1 && b.session.committedDocument.revision >= 1,
      'both seeded',
    );

    const result = await server.submit(
      { type: 'setCells', changes: [{ rowId: 'row-2', columnId: '2026-04-02', value: { kind: 'number', value: 7 } }] },
      { actorId: 'system', documentId: 'doc-b' },
    );
    expect(result.status).toBe('accepted');
    await waitFor(() => b.session.committedDocument.revision >= 2, 'b applied');
    await delay(60);
    expect(valueOf(b, 'row-2', '2026-04-02')).toEqual({ kind: 'number', value: 7 });
    expect(a.session.committedDocument.revision).toBe(1); // doc-a は seed のみ（漏れゼロ）

    await expect(
      server.submit(
        { type: 'setCells', changes: [{ rowId: 'row-1', columnId: 'col-a', value: { kind: 'string', value: 'x' } }] },
        { actorId: 'system', documentId: 'doc-zzz' },
      ),
    ).rejects.toThrow(/serve していません/);
  });

  it('M7: 文書を明示した接続は join の申告 documentId 不一致で 1008 切断される', async () => {
    const server = await startServer(twoDocuments());
    // `?documentId=doc-a` で繋ぎながら join では doc-b を名乗る（誤配線・改竄の模擬）。
    const rogue = await rawClient(`ws://127.0.0.1:${server.port}/ws?documentId=doc-a`);
    rogue.send(joinFrame('doc-b', 'client-rogue'));
    expect(await rogue.closeCode()).toBe(1008); // 実際に upgrade→join を通した上で拒否されている
    expect(server.connectionCount('doc-a')).toBe(0);

    // 対照: 正しく名乗った接続は切断されない（拒否側だけが通る偽陽性を排除する）。
    const honest = await rawClient(`ws://127.0.0.1:${server.port}/ws?documentId=doc-a`);
    honest.send(joinFrame('doc-a', 'client-honest'));
    await waitFor(() => server.connectionCount('doc-a') === 1, 'honest joined');
    expect(honest.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('M8: join 後に別文書を名乗る submitOperation も厳格接続では 1008 切断される（oplog 汚染の封鎖・Codex P1）', async () => {
    const server = await startServer(twoDocuments());
    const rogue = await rawClient(`ws://127.0.0.1:${server.port}/ws?documentId=doc-a`);
    rogue.send(joinFrame('doc-a', 'client-rogue')); // join は正しく名乗る
    await waitFor(() => server.connectionCount('doc-a') === 1, 'joined');
    // 受理後に別文書 ID の envelope を送る（Room は documentId を見ないため、素通しすると doc-a の oplog へ
    // doc-b の entry が入り、次回起動の復旧が entry 照合で失敗して doc-a が丸ごと検疫される）。
    rogue.send(
      submitFrame({ documentId: 'doc-b', clientId: 'client-rogue', columnId: 'col-a', baseRevision: 1, value: 'X' }),
    );
    expect(await rogue.closeCode()).toBe(1008);
    // doc-a の文書は動いていない（拒否は適用前）。
    const snapshot = (await (await fetch(`${server.url}/snapshot?documentId=doc-a`)).json()) as {
      document: { revision: number };
    };
    expect(snapshot.document.revision).toBe(1); // seed のみ
  });

  it('M9: 単一文書（従来）接続の申告不一致は受理しつつ、oplog はサーバー値へ正規化される（後方互換×汚染封鎖）', async () => {
    const oplog = new MemoryServeOpLog();
    const diagnostics: ServeDiagnostic[] = [];
    const server = await startServer({
      documentId: 'demo-doc',
      seedRows: 2,
      oplog,
      snapshotStore: new MemoryServeSnapshots(),
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    // 従来経路（`?documentId=` 無し・単一文書構成）。別文書を名乗っても切断しない（後方互換）。
    const legacy = await rawClient(`ws://127.0.0.1:${server.port}/ws`);
    legacy.send(joinFrame('other-doc', 'client-legacy'));
    await waitFor(() => server.connectionCount() === 1, 'legacy joined');
    legacy.send(
      submitFrame({ documentId: 'other-doc', clientId: 'client-legacy', columnId: 'col-a', baseRevision: 1, value: 'Y' }),
    );
    await waitFor(() => oplog.entries.length >= 2, 'op appended');
    expect(legacy.socket.readyState).toBe(WebSocket.OPEN); // 切断していない
    // oplog に入った envelope の documentId は serve 中の文書へ正規化されている（別 ID のまま記録すると
    // 次回起動の復旧が entry 照合で失敗する）。
    expect(oplog.entries.every((e) => e.documentId === 'demo-doc')).toBe(true);
    expect(diagnostics.filter((d) => d.code === 'document-mismatch')).toHaveLength(1); // 警告は接続あたり 1 回
  });

  it('M10: 1 文書の close 失敗でも残りの文書とサーバーの後始末を完遂する（Codex P1）', async () => {
    const failing = new MemoryServeOpLog();
    failing.close = () => Promise.reject(new Error('close 失敗（テスト注入）'));
    const healthySnapshots = new MemoryServeSnapshots();
    const server = await serve({
      port: 0,
      documents: {
        documentIds: ['doc-a', 'doc-b'],
        resolve: (documentId) =>
          documentId === 'doc-a'
            ? { columnOrder: COLUMNS_A, seedRows: 1, oplog: failing, snapshotStore: new MemoryServeSnapshots() }
            : { columnOrder: COLUMNS_B, seedRows: 1, oplog: new MemoryServeOpLog(), snapshotStore: healthySnapshots },
      },
    });
    const port = server.port;
    // stop() は失敗を伝えるが、後続文書・HTTP/WS の後始末は完了している。
    await expect(server.stop()).rejects.toThrow(/後始末に失敗/);
    // http server が閉じている＝同じポートへ接続できない（閉じ残していないことの外形確認）。
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
