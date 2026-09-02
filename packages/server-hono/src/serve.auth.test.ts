// 🔬 DD-026-2 機械検証（contract.md §5 A1〜A4）: 認証フック（U2）。null=401 拒否／identity で envelope actorId と presence を上書き／
//   throw=500 拒否（サーバー継続）／未指定は従来どおり申告値。
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { col, row, setCells, str } from '@nanairo-sheet/collab/test-support';

import { serve } from './index';
import type { ServeAuthenticate, ServeDiagnostic } from './index';
import { MemoryServeOpLog, MemoryServeSnapshots, createSessionClient, waitFor } from './test-support';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** Cookie で身元を決める認証フック（consumer の JWT Cookie 検証の代役）。 */
const authenticate: ServeAuthenticate = (request) => {
  const cookie = request.headers.cookie;
  if (cookie === 'token=alice') {
    return { actorId: 'u-alice', displayName: 'Alice' };
  }
  if (cookie === 'token=bob') {
    return Promise.resolve({ actorId: 'u-bob', displayName: 'Bob' });
  }
  if (cookie === 'token=boom') {
    throw new Error('boom');
  }
  return null;
};

/** 生の ws で upgrade だけ試み、受理（'open'）か拒否ステータスコードを返す。 */
function rawUpgrade(url: string, headers?: Record<string, string>): Promise<'open' | number> {
  return new Promise((resolve, reject) => {
    const ws = headers !== undefined ? new WebSocket(url, { headers }) : new WebSocket(url);
    ws.on('unexpected-response', (_req, res) => {
      const statusCode = res.statusCode ?? 0;
      res.resume();
      ws.on('error', () => {}); // terminate 由来の「closed before established」を吸収
      ws.terminate();
      resolve(statusCode);
    });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('error', reject);
  });
}

describe('serve() 認証フック（U2・DD-026-2）', () => {
  it('A1: authenticate が null → upgrade は 401 で拒否・接続数 0・診断 auth-rejected', async () => {
    const diagnostics: ServeDiagnostic[] = [];
    const server = await serve({ port: 0, seedRows: 1, authenticate, onDiagnostic: (e) => diagnostics.push(e) });
    cleanups.push(() => server.stop());
    expect(await rawUpgrade(`ws://127.0.0.1:${server.port}/ws`)).toBe(401);
    expect(await rawUpgrade(`ws://127.0.0.1:${server.port}/ws`, { cookie: 'token=unknown' })).toBe(401);
    expect(server.connectionCount()).toBe(0);
    expect(diagnostics.filter((d) => d.code === 'auth-rejected' && d.level === 'warn')).toHaveLength(2);
  });

  it('A2: 受理 identity で envelope の actorId・presence の userId/displayName を上書きし、申告値は無視される', async () => {
    const oplog = new MemoryServeOpLog();
    const server = await serve({ port: 0, seedRows: 2, authenticate, oplog, snapshotStore: new MemoryServeSnapshots() });
    cleanups.push(() => server.stop());
    const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
    // A は申告の userId/displayName を偽る（サーバーは Cookie の身元で上書きする）。
    const a = createSessionClient(wsUrl, { clientId: 'client-a', userId: 'spoof', displayName: 'Spoofy', headers: { cookie: 'token=alice' } });
    const b = createSessionClient(wsUrl, { clientId: 'client-b', headers: { cookie: 'token=bob' } });
    cleanups.push(() => a.transport.close(), () => b.transport.close());
    await waitFor(() => a.session.isOnline && b.session.isOnline && b.session.committedDocument.revision >= 1, 'both online');

    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('from-alice') }]));
    await waitFor(() => a.session.pendingCount === 0 && b.session.committedDocument.revision === 2, 'op accepted and broadcast');
    const accepted = oplog.entries[1];
    expect(accepted.actorId).toBe('u-alice'); // 申告 'spoof' ではなく認証結果
    expect(accepted.clientId).toBe('client-a'); // clientId は申告維持（再接続の同一性）
    expect(b.session.committedHash()).toBe(a.session.committedHash());

    a.session.sendPresence({ activeCell: { rowId: row('row-1'), columnId: col('col-a') }, selectionRanges: [] });
    await waitFor(() => b.session.knownPresences().length === 1, 'presence delivered');
    const seen = b.session.knownPresences()[0];
    expect(seen.displayName).toBe('Alice');
    expect(seen.userId).toBe('u-alice');
  });

  it('A3: authenticate が throw → 500 で拒否・診断 auth-error・他の接続は受理される（サーバー継続）', async () => {
    const diagnostics: ServeDiagnostic[] = [];
    const server = await serve({ port: 0, seedRows: 1, authenticate, onDiagnostic: (e) => diagnostics.push(e) });
    cleanups.push(() => server.stop());
    const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
    expect(await rawUpgrade(wsUrl, { cookie: 'token=boom' })).toBe(500);
    expect(diagnostics.filter((d) => d.code === 'auth-error' && d.level === 'error')).toHaveLength(1);
    expect(diagnostics.some((d) => d.message.includes('token='))).toBe(false); // 値は診断に載せない

    const ok = createSessionClient(wsUrl, { clientId: 'client-ok', headers: { cookie: 'token=bob' } });
    cleanups.push(() => ok.transport.close());
    await waitFor(() => ok.session.isOnline && ok.session.committedDocument.revision >= 1, 'valid client online after failure');
    expect(server.connectionCount()).toBe(1);
  });

  it('A4: authenticate 未指定なら従来どおり申告の actorId が使われる（回帰）', async () => {
    const oplog = new MemoryServeOpLog();
    const server = await serve({ port: 0, seedRows: 1, oplog, snapshotStore: new MemoryServeSnapshots() });
    cleanups.push(() => server.stop());
    const a = createSessionClient(`ws://127.0.0.1:${server.port}/ws`, { clientId: 'client-a', userId: 'declared-user' });
    cleanups.push(() => a.transport.close());
    await waitFor(() => a.session.isOnline && a.session.committedDocument.revision >= 1, 'online');
    a.session.submitLocalOperation(setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('v') }]));
    await waitFor(() => a.session.pendingCount === 0, 'acked');
    expect(oplog.entries[1].actorId).toBe('declared-user');
  });
});
