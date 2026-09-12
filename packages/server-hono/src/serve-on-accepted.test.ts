// 🔬 DD-049 H2 機械検証（contract.md §2・§7 S1〜S8）: serve({ onAccepted }) の受理通知。
//   S1 durable（append 解決）→ ACK/配信の後に 1 受理＝1 回・公開形（documentId/revision/actorId/origin/changes/envelope）。
//      authenticate 指定時の actorId はサーバー確定値。
//   S2 前値は op ごとの適用直前の値（append 保留中の連続 op・同一 op 内の同一セル複数書込は逐次・kind 保持）。
//   S3 submit 起点は origin=server・actorId=options.actorId。hook の後に submit の Promise が解決する（永続化あり/なし）。
//   S4 hook の同期 throw・async reject は診断 on-accepted-error（warn）に閉じ、受理・配信・後続の通知は継続する。
//      onDiagnostic 未指定でも console.error で黙らせない。
//   S5 複数文書 serve で文書ごとに正しい documentId。OCC reject（submit・クライアント op）は通知されない。
//   S6 insertRows/deleteRows は changes 空で通知。noop（削除済み行の再削除）と duplicate 再送は通知されない。
//   S7 hook 内の submit は別 revision で受理され origin=server で通知される（ループしない）。
//   S8 hook が envelope・changes を書き換えても、再接続の tail catch-up で受け取る値は元のまま（複製）。
// onAccepted 未指定の既存 serve の挙動不変（S9）は既存スイート（serve.* / server.* / convergence 等）が無修正で担保する。
import { Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';

import { getCell, isRecord } from '@nanairo-sheet/core';
import type { CellScalar } from '@nanairo-sheet/core';
import { col, deleteRows, insertRows, num, row, setCells, str } from '@nanairo-sheet/collab/test-support';
import { createColumnId } from '@nanairo-sheet/types';

import { serve } from './index';
import type { ServeAcceptedEvent, ServeDiagnostic, ServeOptions, ServeSetCellsInput, ServerInstance } from './index';
import { MemoryServeOpLog, MemoryServeSnapshots, createSessionClient, delay, waitFor } from './test-support';
import type { SessionClient, SessionClientOptions } from './test-support';
import { rawDataToString } from './ws-frame';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

const SYS: ServeSetCellsInput = {
  type: 'setCells',
  changes: [{ rowId: 'row-1', columnId: 'col-a', value: { kind: 'string', value: 'SYS' } }],
};

async function startServe(options: ServeOptions): Promise<ServerInstance> {
  const server = await serve({ port: 0, ...options });
  cleanups.push(() => server.stop());
  return server;
}

function connect(port: number, options: SessionClientOptions, query = ''): SessionClient {
  const client = createSessionClient(`ws://127.0.0.1:${port}/ws${query}`, options);
  cleanups.push(() => client.transport.close());
  return client;
}

function valueOf(client: SessionClient, rowId: string, columnId: string): CellScalar | undefined {
  return getCell(client.session.committedDocument, row(rowId), col(columnId))?.value;
}

/** 全クライアントが online・revision 到達・pending 0 になるまで待つ。 */
async function synced(clients: SessionClient[], revision: number, label: string): Promise<void> {
  await waitFor(
    () =>
      clients.every(
        (c) => c.session.isOnline && c.session.committedDocument.revision >= revision && c.session.pendingCount === 0,
      ),
    label,
  );
}

interface RawClient {
  send(message: unknown): void;
  /**
   * 複数フレームを下層 TCP socket の 1 回の write にまとめて送る（cork/uncork）。サーバーが同じ data チャンクで連続フレームを
   * 同期に処理する状況（再接続時の一括再送など）を作る。
   */
  sendBurst(messages: readonly unknown[]): void;
  /** 指定 operationId の operationAck を受け取った回数。 */
  acks(operationId: string): number;
  /** 受信した operations メッセージの revision を到着順に並べたもの。 */
  operationRevisions(): number[];
}

/** 生 WS クライアント（duplicate 再送・noop のように ClientSession では作れないフレームを送る）。 */
async function rawClient(port: number, clientId: string): Promise<RawClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: unknown[] = [];
  socket.on('message', (data: RawData) => {
    frames.push(JSON.parse(rawDataToString(data)));
  });
  socket.on('error', () => {}); // terminate 後の error を uncaught 化させない（後始末由来の意図的無視）
  cleanups.push(() => {
    socket.terminate();
  });
  await new Promise<void>((resolve) => {
    socket.on('open', () => resolve());
  });
  socket.send(JSON.stringify({ type: 'join', protocolVersion: 1, documentId: 'demo-doc', lastAppliedRevision: 0, clientId }));
  await waitFor(() => frames.some((frame) => isRecord(frame) && frame.type === 'welcome'), 'raw client welcome');
  return {
    send: (message) => {
      socket.send(JSON.stringify(message));
    },
    sendBurst: (messages) => {
      const underlying: unknown = Reflect.get(socket, '_socket');
      if (!(underlying instanceof Socket)) {
        throw new Error('ws の下層 TCP socket を取得できない');
      }
      underlying.cork();
      for (const message of messages) {
        socket.send(JSON.stringify(message));
      }
      underlying.uncork();
    },
    acks: (operationId) =>
      frames.filter((frame) => isRecord(frame) && frame.type === 'operationAck' && frame.operationId === operationId)
        .length,
    operationRevisions: () =>
      frames.flatMap((frame) =>
        isRecord(frame) && frame.type === 'operations' && Array.isArray(frame.operations)
          ? frame.operations.map((operation: unknown) =>
              isRecord(operation) && typeof operation.revision === 'number' ? operation.revision : -1,
            )
          : [],
      ),
  };
}

/** SetCells 1 件の wire 形式（生 WS フレーム用）。 */
function setCellsWire(columnId: string, text: string): unknown {
  return {
    type: 'setCells',
    conflictPolicy: 'reject-overlap',
    changes: [{ rowId: 'row-1', columnId, value: { kind: 'string', value: text } }],
  };
}

function submitFrame(
  clientId: string,
  clientSequence: number,
  operationId: string,
  baseRevision: number,
  operation: unknown,
): unknown {
  return {
    type: 'submitOperation',
    envelope: {
      protocolVersion: 1,
      documentId: 'demo-doc',
      operationId,
      transactionId: `tx-${operationId}`,
      actorId: clientId,
      clientId,
      clientSequence,
      baseRevision,
      operation,
    },
  };
}

describe('serve({ onAccepted })（DD-049 H2）', () => {
  it('S1: 永続化ありでは append 解決と ACK の後に 1 受理＝1 回、公開形（前後値・oplog と同形の envelope）で届く', async () => {
    const oplog = new MemoryServeOpLog();
    const events: ServeAcceptedEvent[] = [];
    const server = await startServe({
      seedRows: 2,
      oplog,
      snapshotStore: new MemoryServeSnapshots(),
      onAccepted: (event) => {
        events.push(event);
      },
    });
    const a = connect(server.port, { clientId: 'client-a' });
    await synced([a], 1, 'a online');
    expect(events).toHaveLength(0); // seed（listen 前）は通知しない

    oplog.gate = true; // 以降の append を保留＝durable 未完了
    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('A1') }]));
    await waitFor(() => oplog.appendCalls === 2, 'op の append が呼ばれる'); // seed 1 回＋op 1 回
    await delay(60);
    expect(events).toHaveLength(0); // durable 前は通知しない
    expect(a.session.pendingCount).toBe(1); // ACK も出ていない

    oplog.gate = false;
    oplog.release();
    await waitFor(() => a.session.pendingCount === 0 && events.length === 1, 'ACK と通知');
    const event = events[0];
    expect(event).toMatchObject({ documentId: 'demo-doc', revision: 2, actorId: 'user-client-a', origin: 'client' });
    expect(event.changes).toEqual([
      { rowId: 'row-1', columnId: 'col-a', value: { kind: 'string', value: 'A1' }, previousValue: { kind: 'blank' } },
    ]);
    expect(event.envelope).toEqual(oplog.entries[1]); // oplog に追記された受理 envelope と同形
    expect(event.envelope.clientId).toBe('client-a');
  });

  it('S1: authenticate 指定時の actorId はサーバーが確定した利用者 ID（申告値ではない）', async () => {
    const events: ServeAcceptedEvent[] = [];
    const server = await startServe({
      seedRows: 1,
      authenticate: () => ({ actorId: 'u-42', displayName: 'Bob' }),
      onAccepted: (event) => {
        events.push(event);
      },
    });
    const a = connect(server.port, { clientId: 'client-a', userId: 'spoofed' });
    await synced([a], 1, 'a online');
    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-b'), value: num(42) }]));
    await waitFor(() => events.length === 1, '通知');
    expect(events[0].actorId).toBe('u-42');
    expect(events[0].envelope.actorId).toBe('u-42');
    expect(events[0].changes[0].value).toEqual({ kind: 'number', value: 42 });
  });

  it('S2: 前値は op ごとの適用直前の値（append 保留中の連続 op・同一 op 内の同一セル複数書込は逐次）', async () => {
    const oplog = new MemoryServeOpLog();
    const events: ServeAcceptedEvent[] = [];
    const server = await startServe({
      seedRows: 1,
      oplog,
      snapshotStore: new MemoryServeSnapshots(),
      onAccepted: (event) => {
        events.push(event);
      },
    });
    const a = connect(server.port, { clientId: 'client-a' });
    await synced([a], 1, 'a online');

    oplog.gate = true;
    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('1') }]));
    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: num(2) }]));
    await waitFor(() => oplog.appendCalls === 2, '1 件目の append が保留される');
    await delay(100); // 2 件目も Room で受理（revision 付与）されて append 待ちに入る
    oplog.gate = false;
    oplog.release();
    await waitFor(() => a.session.pendingCount === 0 && events.length === 2, '2 件の通知');
    expect(events.map((e) => [e.revision, e.changes])).toEqual([
      [2, [{ rowId: 'row-1', columnId: 'col-a', value: { kind: 'string', value: '1' }, previousValue: { kind: 'blank' } }]],
      [
        3,
        [{ rowId: 'row-1', columnId: 'col-a', value: { kind: 'number', value: 2 }, previousValue: { kind: 'string', value: '1' } }],
      ],
    ]);

    const result = await server.submit(
      {
        type: 'setCells',
        changes: [
          { rowId: 'row-1', columnId: 'col-b', value: { kind: 'string', value: 'x' } },
          { rowId: 'row-1', columnId: 'col-b', value: { kind: 'date', value: '2026-09-12' } },
          { rowId: 'row-1', columnId: 'col-a', value: { kind: 'blank' } },
        ],
      },
      { actorId: 'system' },
    );
    expect(result.status).toBe('accepted');
    expect(events[2].changes).toEqual([
      { rowId: 'row-1', columnId: 'col-b', value: { kind: 'string', value: 'x' }, previousValue: { kind: 'blank' } },
      {
        rowId: 'row-1',
        columnId: 'col-b',
        value: { kind: 'date', value: '2026-09-12' },
        previousValue: { kind: 'string', value: 'x' },
      },
      { rowId: 'row-1', columnId: 'col-a', value: { kind: 'blank' }, previousValue: { kind: 'number', value: 2 } },
    ]);
  });

  it('S3: submit 起点は origin=server・actorId=options.actorId で、hook の後に submit の Promise が解決する', async () => {
    const order: string[] = [];
    const events: ServeAcceptedEvent[] = [];
    const server = await startServe({
      seedRows: 1,
      onAccepted: (event) => {
        order.push(`hook@${event.revision}`);
        events.push(event);
      },
    });
    const result = await server.submit(SYS, { actorId: 'system' });
    order.push(`resolved@${result.status === 'accepted' ? result.revision : result.status}`);
    expect(order).toEqual(['hook@2', 'resolved@2']);
    expect(events[0]).toMatchObject({ origin: 'server', actorId: 'system', documentId: 'demo-doc', revision: 2 });
    expect(events[0].envelope.clientId).toBe('server');
    expect(events[0].changes).toEqual([
      { rowId: 'row-1', columnId: 'col-a', value: { kind: 'string', value: 'SYS' }, previousValue: { kind: 'blank' } },
    ]);
  });

  it('S3: 永続化ありの submit は append 解決まで通知も解決もしない', async () => {
    const oplog = new MemoryServeOpLog();
    const order: string[] = [];
    const server = await startServe({
      seedRows: 1,
      oplog,
      snapshotStore: new MemoryServeSnapshots(),
      onAccepted: (event) => {
        order.push(`hook@${event.revision}`);
      },
    });
    oplog.gate = true;
    const settled = server.submit(SYS, { actorId: 'system' }).then((result) => {
      order.push(`resolved@${result.status}`);
    });
    await waitFor(() => oplog.appendCalls === 2, 'append 保留');
    await delay(30);
    expect(order).toEqual([]);
    oplog.gate = false;
    oplog.release();
    await settled;
    expect(order).toEqual(['hook@2', 'resolved@accepted']);
  });

  it('S4: hook の同期 throw・async reject は診断 on-accepted-error に閉じ、受理・配信・後続の通知は継続する', async () => {
    const diagnostics: ServeDiagnostic[] = [];
    const seen: number[] = [];
    const server = await startServe({
      seedRows: 1,
      onDiagnostic: (entry) => {
        diagnostics.push(entry);
      },
      onAccepted: (event) => {
        seen.push(event.revision);
        if (event.revision === 2) {
          throw new Error('sync boom');
        }
        if (event.revision === 3) {
          return Promise.reject(new TypeError('async boom'));
        }
        return undefined;
      },
    });
    const a = connect(server.port, { clientId: 'client-a' });
    const b = connect(server.port, { clientId: 'client-b' });
    await synced([a, b], 1, 'online');
    const steps: Array<[number, string]> = [
      [2, 'v2'],
      [3, 'v3'],
      [4, 'v4'],
    ];
    for (const [revision, text] of steps) {
      a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str(text) }]));
      await synced([a, b], revision, `revision ${revision} が両クライアントへ配信`);
    }
    await waitFor(() => diagnostics.filter((d) => d.code === 'on-accepted-error').length === 2, '診断 2 件');
    expect(seen).toEqual([2, 3, 4]);
    const failures = diagnostics.filter((d) => d.code === 'on-accepted-error');
    expect(failures.map((d) => d.level)).toEqual(['warn', 'warn']);
    expect(failures[0].message).toContain('revision=2');
    expect(failures[0].message).toContain('Error: sync boom');
    expect(failures[1].message).toContain('revision=3');
    expect(failures[1].message).toContain('TypeError: async boom');
    expect(valueOf(b, 'row-1', 'col-a')).toEqual({ kind: 'string', value: 'v4' });
    expect(a.session.committedHash()).toBe(b.session.committedHash());
  });

  it('S4: onDiagnostic 未指定でも hook の失敗を console.error へ出して黙らせない（受理は成立する）', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = await startServe({
      seedRows: 1,
      onAccepted: () => {
        throw new Error('boom');
      },
    });
    const result = await server.submit(SYS, { actorId: 'system' });
    expect(result.status).toBe('accepted');
    expect(
      errors.mock.calls.some((call) => String(call[0]).includes('onAccepted が失敗しました') && String(call[0]).includes('boom')),
    ).toBe(true);
  });

  it('S5: 複数文書 serve では文書ごとに正しい documentId で届き、OCC reject は通知されない', async () => {
    const events: ServeAcceptedEvent[] = [];
    const columnsA = ['col-a', 'col-b', 'col-c'];
    const columnsB = ['2026-04-01', '2026-04-02'];
    const server = await startServe({
      documents: {
        documentIds: ['doc-a', 'doc-b'],
        resolve: (documentId) =>
          documentId === 'doc-a' ? { columnOrder: columnsA, seedRows: 1 } : { columnOrder: columnsB, seedRows: 1 },
      },
      onAccepted: (event) => {
        events.push(event);
      },
    });
    const a = connect(
      server.port,
      { clientId: 'client-a', documentId: 'doc-a', columnOrder: columnsA.map((c) => createColumnId(c)) },
      '?documentId=doc-a',
    );
    const b = connect(
      server.port,
      { clientId: 'client-b', documentId: 'doc-b', columnOrder: columnsB.map((c) => createColumnId(c)) },
      '?documentId=doc-b',
    );
    await synced([a, b], 1, 'online');
    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('A') }]));
    await synced([a], 2, 'doc-a の受理');
    b.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('2026-04-01'), value: str('B') }]));
    await synced([b], 2, 'doc-b の受理');
    await waitFor(() => events.length === 2, '2 文書の通知');
    expect(events.map((e) => [e.documentId, e.revision, e.envelope.documentId])).toEqual([
      ['doc-a', 2, 'doc-a'],
      ['doc-b', 2, 'doc-b'],
    ]);

    // OCC reject: サーバー起点（結果で返る）とクライアント op（Conflict Queue）のどちらも通知しない。
    const stale = await server.submit(
      {
        type: 'setCells',
        changes: [{ rowId: 'row-1', columnId: 'col-a', beforeRevision: 1, value: { kind: 'string', value: 'late' } }],
      },
      { actorId: 'system', documentId: 'doc-a' },
    );
    expect(stale.status).toBe('rejected');
    a.session.submitLocalOperation(
      setCells([{ rowId: row('row-1'), columnId: col('col-a'), beforeRevision: 1, value: str('late') }]),
    );
    await waitFor(() => a.session.conflictQueue.length === 1, 'クライアント op の競合');
    await delay(80);
    expect(events).toHaveLength(2);
  });

  it('S6: insertRows/deleteRows は changes 空で通知し、noop（削除済み行の再削除）と duplicate 再送は通知しない', async () => {
    const events: ServeAcceptedEvent[] = [];
    const server = await startServe({
      seedRows: 2,
      onAccepted: (event) => {
        events.push(event);
      },
    });
    const a = connect(server.port, { clientId: 'client-a' });
    await synced([a], 1, 'online');
    a.session.submitLocalOperation(insertRows(row('row-2'), ['row-new']));
    await synced([a], 2, 'insert の受理');
    a.session.submitLocalOperation(deleteRows([row('row-new')]));
    await synced([a], 3, 'delete の受理');
    await waitFor(() => events.length === 2, '行操作の通知');
    expect(events.map((e) => [e.revision, e.envelope.operation.type, e.changes])).toEqual([
      [2, 'insertRows', []],
      [3, 'deleteRows', []],
    ]);

    // 生 WS クライアントで duplicate 再送と noop を送る（どちらも revision を消費しない）。
    const raw = await rawClient(server.port, 'raw-client');
    const setFrame = submitFrame('raw-client', 1, 'raw-op-1', 3, {
      type: 'setCells',
      conflictPolicy: 'reject-overlap',
      changes: [{ rowId: 'row-1', columnId: 'col-a', value: { kind: 'string', value: 'R' } }],
    });
    raw.send(setFrame);
    await waitFor(() => raw.acks('raw-op-1') === 1, '受理 ACK');
    raw.send(setFrame); // 同一 operationId の再送＝duplicate ACK
    await waitFor(() => raw.acks('raw-op-1') === 2, 'duplicate ACK');
    raw.send(submitFrame('raw-client', 2, 'raw-op-2', 4, { type: 'deleteRows', rowIds: ['row-new'] })); // 削除済み行＝noop
    await waitFor(() => raw.acks('raw-op-2') === 1, 'noop ACK');
    await delay(50);
    expect(events.map((e) => e.revision)).toEqual([2, 3, 4]); // raw-op-1 の受理 1 回だけ
  });

  it('S7: hook 内の submit は別 revision で受理され origin=server で通知される（ループしない）', async () => {
    const events: ServeAcceptedEvent[] = [];
    const failures: unknown[] = [];
    const holder: { server?: ServerInstance } = {};
    const server = await startServe({
      seedRows: 1,
      onAccepted: (event) => {
        events.push(event);
        if (event.origin !== 'client') {
          return; // サーバー起点は再評価しない（consumer 側のループ防止）
        }
        holder.server
          ?.submit(
            {
              type: 'setCells',
              changes: [{ rowId: 'row-1', columnId: 'col-c', value: { kind: 'string', value: `total@${event.revision}` } }],
            },
            { actorId: 'system' },
          )
          .catch((error: unknown) => {
            failures.push(error);
          });
      },
    });
    holder.server = server;
    const a = connect(server.port, { clientId: 'client-a' });
    await synced([a], 1, 'online');
    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: num(10) }]));
    await waitFor(() => events.length === 2 && a.session.committedDocument.revision === 3, '再計算 op の受理と配信');
    expect(events.map((e) => [e.revision, e.origin, e.actorId])).toEqual([
      [2, 'client', 'user-client-a'],
      [3, 'server', 'system'],
    ]);
    expect(valueOf(a, 'row-1', 'col-c')).toEqual({ kind: 'string', value: 'total@2' });
    await delay(80);
    expect(events).toHaveLength(2);
    expect(failures).toEqual([]);
  });

  it('S8: hook が envelope・changes を書き換えても、再接続の tail catch-up で受け取る値は元のまま（複製）', async () => {
    const server = await startServe({
      seedRows: 1,
      onAccepted: (event) => {
        // readonly 型を無視して破壊する consumer を模す（Object.assign は readonly を検査しない）。
        Object.assign(event.envelope, { revision: 999, actorId: 'hacked' });
        const operation = event.envelope.operation;
        if (operation.type === 'setCells') {
          for (const change of operation.changes) {
            Object.assign(change, { value: { kind: 'string', value: 'HACKED' } });
          }
        }
        for (const change of event.changes) {
          Object.assign(change, { value: { kind: 'string', value: 'HACKED' } });
        }
      },
    });
    const a = connect(server.port, { clientId: 'client-a' });
    const b = connect(server.port, { clientId: 'client-b' });
    await synced([a, b], 1, 'online');
    b.transport.dropForTest(); // b は切断したまま（op を後から tail catch-up で受け取る）
    const appliedBefore = b.session.appliedServerOpCount;

    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('ORIGINAL') }]));
    await synced([a], 2, 'a の受理');
    b.transport.resumeAfterDrop();
    await synced([b], 2, 'b の再接続 catch-up');
    expect(b.session.appliedServerOpCount).toBe(appliedBefore + 1); // bootstrap ではなく operationLog の tail で受け取った
    expect(valueOf(b, 'row-1', 'col-a')).toEqual({ kind: 'string', value: 'ORIGINAL' });
    expect(b.session.committedHash()).toBe(a.session.committedHash());
  });

  it('S9: 同じ data チャンクで届いた連続フレームの受理 hook から submit しても、配信と通知は revision 順（Codex P1）', async () => {
    // 前提は「2 フレームがサーバーの同じ同期区間で処理される」こと（ws サーバーは 1 チャンク内の複数メッセージを同期に emit する）。
    // TCP の受信側でまとまらなかった試行は修正前でも順序が崩れず検査にならないため、1 件目の hook で積んだマイクロタスクが 2 件目の
    // hook の時点で未実行かどうかで前提の成立を確かめ、成立するまでやり直す（偽 green を防ぐ・Codex 第 2 回 P3）。
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const events: ServeAcceptedEvent[] = [];
      const failures: unknown[] = [];
      const holder: { server?: ServerInstance } = {};
      const probe: { checkpointReached: boolean; sameSyncRun: boolean | undefined } = {
        checkpointReached: false,
        sameSyncRun: undefined,
      };
      const server = await startServe({
        seedRows: 1,
        onAccepted: (event) => {
          events.push(event);
          if (event.origin !== 'client') {
            return;
          }
          if (event.revision !== 2) {
            probe.sameSyncRun = !probe.checkpointReached; // 2 件目の hook 時点で 1 件目のマイクロタスクが未実行＝同じ同期区間
            return;
          }
          queueMicrotask(() => {
            probe.checkpointReached = true;
          });
          holder.server
            ?.submit(
              { type: 'setCells', changes: [{ rowId: 'row-1', columnId: 'col-c', value: { kind: 'string', value: 'recalc' } }] },
              { actorId: 'system' },
            )
            .catch((error: unknown) => {
              failures.push(error);
            });
        },
      });
      holder.server = server;
      const clientId = `raw-burst-${attempt}`;
      const raw = await rawClient(server.port, clientId);
      // A（revision 2）の hook がサーバー起点 op（revision 3）を投入した直後に、同じチャンクの B（revision 4）が同期で処理される。
      raw.sendBurst([
        submitFrame(clientId, 1, `${clientId}-op-1`, 1, setCellsWire('col-a', 'A')),
        submitFrame(clientId, 2, `${clientId}-op-2`, 1, setCellsWire('col-b', 'B')),
      ]);
      await waitFor(() => events.length === 3 && raw.operationRevisions().length === 3, '3 件の受理・通知・配信');
      if (probe.sameSyncRun !== true && attempt < MAX_ATTEMPTS) {
        continue; // 前提不成立（別々の data チャンクで届いた）→ やり直す
      }
      expect(probe.sameSyncRun, '2 フレームが同じ同期区間で処理された（S9 の前提）').toBe(true);
      expect(events.map((e) => [e.revision, e.origin])).toEqual([
        [2, 'client'],
        [3, 'server'],
        [4, 'client'],
      ]);
      expect(raw.operationRevisions()).toEqual([2, 3, 4]); // 配信（operations）も revision 順
      expect(failures).toEqual([]);
      return;
    }
  });

  it('S10: hook が文字列化できない値（null prototype）を throw／reject しても診断に閉じ、submit は受理で解決する（Codex P2）', async () => {
    const diagnostics: ServeDiagnostic[] = [];
    const server = await startServe({
      seedRows: 1,
      onDiagnostic: (entry) => {
        diagnostics.push(entry);
      },
      onAccepted: (event) => {
        if (event.revision === 2) {
          throw Object.create(null);
        }
        return Promise.reject(Object.create(null));
      },
    });
    const first = await server.submit(SYS, { actorId: 'system' });
    const second = await server.submit(
      { type: 'setCells', changes: [{ rowId: 'row-1', columnId: 'col-b', value: { kind: 'string', value: 'S2' } }] },
      { actorId: 'system' },
    );
    expect(first.status).toBe('accepted');
    expect(second.status).toBe('accepted');
    await waitFor(() => diagnostics.filter((d) => d.code === 'on-accepted-error').length === 2, '診断 2 件');
    const messages = diagnostics.filter((d) => d.code === 'on-accepted-error').map((d) => d.message);
    expect(messages[0]).toContain('revision=2');
    expect(messages[1]).toContain('revision=3');
  });

  it('S11: 永続化ありで先行 op の append 保留中でも、revision を消費しない応答（OCC reject）は待たずに返る（Codex 第 2 回 P1）', async () => {
    const oplog = new MemoryServeOpLog();
    const server = await startServe({ seedRows: 1, oplog, snapshotStore: new MemoryServeSnapshots() }); // onAccepted 未指定でも成立すること
    const a = connect(server.port, { clientId: 'client-a' });
    const b = connect(server.port, { clientId: 'client-b' });
    await synced([a, b], 1, 'online');
    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('saved') }]));
    await synced([a, b], 2, '保存済みの値（col-a の cell revision 2）');

    oplog.gate = true; // 以降の append を保留＝先行 op（revision 3）の配信は durable 待ち
    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-b'), value: str('pending') }]));
    await waitFor(() => oplog.appendCalls === 3, '先行 op の append が保留される');

    // (1) サーバー起点の確実な競合（col-a の beforeRevision 1 は古い）は、append 解放前に rejected で解決する。
    const stale = await Promise.race([
      server.submit(
        {
          type: 'setCells',
          changes: [{ rowId: 'row-1', columnId: 'col-a', beforeRevision: 1, value: { kind: 'string', value: 'late' } }],
        },
        { actorId: 'system' },
      ),
      delay(1_000).then(() => 'timeout' as const),
    ]);
    expect(stale).toMatchObject({ status: 'rejected', code: 'stale-cell-revision' });

    // (2) クライアント op の競合も append 解放前に operationRejected が届く。b は保留中の revision 3 をまだ受け取っていないため、
    //     col-b の beforeRevision 0 はローカルでは有効（送信される）・サーバーでは古い（reject される）。
    b.session.submitLocalOperation(
      setCells([{ rowId: row('row-1'), columnId: col('col-b'), beforeRevision: 0, value: str('late-b') }]),
    );
    await waitFor(() => b.session.conflictQueue.length === 1, 'append 解放前に reject が届く', 1_000);
    expect(b.session.conflictQueue[0]?.reason).toBe('rejected');
    expect(oplog.appendCalls).toBe(3); // まだ解放していない

    oplog.gate = false;
    oplog.release();
    await synced([a, b], 3, '保留していた op の配信');
  });

  it('S12: 複数文書 serve で hook から別文書へ submit しても hook は入れ子にならず、別文書の通知・解決は hook が戻った後（Codex 第 2 回 P2）', async () => {
    const order: string[] = [];
    const failures: unknown[] = [];
    const holder: { server?: ServerInstance } = {};
    const server = await startServe({
      documents: {
        documentIds: ['doc-a', 'doc-b'],
        resolve: () => ({ columnOrder: ['col-a', 'col-b'], seedRows: 1 }),
      },
      onAccepted: (event) => {
        order.push(`start:${event.documentId}@${event.revision}`);
        if (event.documentId === 'doc-a') {
          holder.server
            ?.submit(
              { type: 'setCells', changes: [{ rowId: 'row-1', columnId: 'col-b', value: { kind: 'string', value: 'summary' } }] },
              { actorId: 'system', documentId: 'doc-b' },
            )
            .then((result) => {
              order.push(`resolved:doc-b:${result.status}`);
            })
            .catch((error: unknown) => {
              failures.push(error);
            });
        }
        order.push(`end:${event.documentId}@${event.revision}`);
      },
    });
    holder.server = server;
    const result = await server.submit(
      { type: 'setCells', changes: [{ rowId: 'row-1', columnId: 'col-a', value: { kind: 'string', value: 'A' } }] },
      { actorId: 'system', documentId: 'doc-a' },
    );
    expect(result.status).toBe('accepted');
    await waitFor(() => order.length === 5, '別文書の通知と解決');
    expect(order).toEqual(['start:doc-a@2', 'end:doc-a@2', 'start:doc-b@2', 'end:doc-b@2', 'resolved:doc-b:accepted']);
    expect(failures).toEqual([]);
  });
});
