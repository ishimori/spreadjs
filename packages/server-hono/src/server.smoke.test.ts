// 🔬 Phase 4 機械検証（server.smoke.test）: 実 WS サーバー（ランダムポート）＋ ws-transport 経由の ClientSession 3 体で
// (1) SetCells 相互反映 → 全 committedHash がサーバー hash と一致・二重適用0、(2) presenceDelta が displayName/colorKey 付きで到達、
// (3) heartbeat 途絶接続が短縮 TTL sweep で presenceRemoved、を確認する。実クロックを注入し、TTL 検証は短縮値
// （ttl 200ms / sweep 50ms / heartbeat 40ms）で実時間待ちを 1 秒未満に抑える（指示 2）。後始末でリーク無し（プロセス自然終了）。

import { afterEach, describe, expect, it } from 'vitest';

import { createDocumentId } from '@nanairo-sheet/types';
import { ClientSession, createCounterIdGenerator } from '@nanairo-sheet/collab';
import { COLUMNS, col, row, setCells, str } from '@nanairo-sheet/collab/test-support';

import { WsClientTransport } from './test-support';
import { startServer } from './server';
import type { RunningServer } from './server';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout: ${label}`);
    }
    await delay(10);
  }
}

interface Client {
  session: ClientSession;
  transport: WsClientTransport;
}

const cleanups: Array<() => void | Promise<void>> = [];

function createClient(wsUrl: string, clientId: string, userId: string, displayName: string): Client {
  const transport = new WsClientTransport(wsUrl, { autoReconnect: false });
  const session = new ClientSession({
    clientId,
    userId,
    displayName,
    documentId: createDocumentId('demo-doc'),
    columnOrder: COLUMNS,
    transport,
    clock: { now: () => Date.now() }, // アダプター層＝実クロック
    idGenerator: createCounterIdGenerator(`${clientId}-op`),
  });
  session.start();
  cleanups.push(() => {
    transport.close();
  });
  return { session, transport };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe('server.smoke — 実 WS サーバー（ランダムポート）＋ ws-transport ＋ ClientSession 3 体', () => {
  it('SetCells 相互反映で全 hash 一致・presenceDelta 到達・heartbeat 途絶で TTL presenceRemoved', async () => {
    const server: RunningServer = await startServer({
      port: 0, // OS 任せのランダムポート（指示 3）
      ttlMillis: 200,
      sweepMillis: 50,
      heartbeatMillis: 40,
      seedRows: 3, // row-1..row-3
    });
    cleanups.push(() => server.close());
    const wsUrl = `ws://127.0.0.1:${server.port}/ws`;

    const a = createClient(wsUrl, 'client-a', 'user-a', 'Alice');
    const b = createClient(wsUrl, 'client-b', 'user-b', 'Bob');
    const c = createClient(wsUrl, 'client-c', 'user-c', 'Carol');
    const clients = [a, b, c];
    const sessions = clients.map((client) => client.session);

    // (0) 全員 online＋welcome（colorKey/connectionId）＋seed 行（revision>=1）到達。
    await waitFor(
      () => sessions.every((s) => s.isOnline && s.colorKey !== undefined && s.committedDocument.revision >= 1),
      'all clients online + seeded',
    );
    expect(server.connectionCount()).toBe(3);
    // colorKey は接続単位で相異（同色回避）。
    const colorKeys = sessions.map((s) => s.colorKey);
    expect(new Set(colorKeys).size).toBe(3);

    // heartbeat: A/B は継続、C は silent（TTL 失効させる）。
    const heartbeatTimers = [a, b].map((client) =>
      setInterval(() => {
        client.session.sendHeartbeat();
      }, 40),
    );
    cleanups.push(() => {
      for (const timer of heartbeatTimers) {
        clearInterval(timer);
      }
    });

    // (1) 各自が別セル（別行）へ SetCells → 全 committed hash がサーバー hash と一致・pending 0・二重適用0。
    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('A1') }]));
    b.session.submitLocalOperation(setCells([{ rowId: row('row-2'), columnId: col('col-a'), value: str('B2') }]));
    c.session.submitLocalOperation(setCells([{ rowId: row('row-3'), columnId: col('col-a'), value: str('C3') }]));

    await waitFor(
      () => sessions.every((s) => s.committedHash() === server.hash() && s.pendingCount === 0),
      'all committed hashes match server after SetCells',
    );
    // 非自明な収束（全 no-op で緑にならない）: seed(1) + 3 set = revision 4・3 セルが反映。
    expect(server.snapshot().currentRevision).toBe(4);
    for (const session of sessions) {
      expect(session.committedDocument.revision).toBe(4);
      expect(session.conflictQueue).toHaveLength(0);
    }

    // (2) Presence: 各自が activeCell を送る → 他接続の knownPresences に displayName/colorKey 付きで到達。
    a.session.sendPresence({ activeCell: { rowId: row('row-1'), columnId: col('col-a') }, selectionRanges: [] });
    b.session.sendPresence({ activeCell: { rowId: row('row-2'), columnId: col('col-a') }, selectionRanges: [] });
    c.session.sendPresence({ activeCell: { rowId: row('row-3'), columnId: col('col-a') }, selectionRanges: [] });

    // DD-053: welcome 直後にも activeCell なしの presence を送るため、knownPresences().length は接続確立時点で
    // 既に 2 になりうる。ここで待つべきは「明示 sendPresence（activeCell 付き）が他接続へ届いたか」。
    await waitFor(
      () => sessions.every((s) => s.knownPresences().every((p) => p.activeCell !== undefined)),
      'each client sees the other two presences with activeCell',
    );
    const seenByA = a.session.knownPresences().find((p) => p.userId === 'user-b');
    expect(seenByA).toBeDefined();
    expect(seenByA?.displayName).toBe('Bob');
    expect(typeof seenByA?.colorKey).toBe('string');
    expect(seenByA?.activeCell).toEqual({ rowId: row('row-2'), columnId: col('col-a') });

    // (3) heartbeat 途絶（C は silent）→ 短縮 TTL sweep で C が presenceRemoved（A/B の knownPresences から消える）。
    const carolConnId = c.session.connectionId;
    expect(carolConnId).toBeDefined();
    await waitFor(
      () =>
        a.session.knownPresences().every((p) => p.connectionId !== carolConnId) &&
        b.session.knownPresences().every((p) => p.connectionId !== carolConnId),
      'silent client swept via TTL presenceRemoved',
    );
    // A/B は heartbeat 継続ゆえ相互には見えたまま（sweep で巻き添えにならない）。
    expect(a.session.knownPresences().some((p) => p.connectionId === b.session.connectionId)).toBe(true);
    expect(b.session.knownPresences().some((p) => p.connectionId === a.session.connectionId)).toBe(true);
    expect(server.connectionCount()).toBe(2); // C の ws は sweep で server 側 close 済み

    // (4) 後始末: 全 transport close → 接続 0（切断イベントの取りこぼし無し・DA D28）。
    for (const timer of heartbeatTimers) {
      clearInterval(timer);
    }
    a.transport.close();
    b.transport.close();
    await waitFor(() => server.connectionCount() === 0, 'all connections cleaned up after close');
  });
});
