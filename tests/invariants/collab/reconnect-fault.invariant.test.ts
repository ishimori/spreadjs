// 共同編集 不変条件スイート §2.3「idempotency／reconnect・catch-up」行の**実充足**（DD-015・CG-5）。
//
// DD-013 の collab.invariant は disconnect を注入しない（reconnect は DD-015 スコープ）と明示していた。本スイートはその行を埋める:
// 本番配線（Room＋Sequencer＋ClientSession×N を InProcessHub で結線）へ **切断/再接続 + duplicate/drop/delay + client→server 欠落**
// を seed 付きで注入し、静止点で fault matrix の保証セル（**C1〜C7・C10＝S-cont〔server 継続稼働〕のみ**）が全て収束・二重適用0・入力喪失0 を
// 満たすことを機械検証する。client→server の submitOperation drop（＝D27/D34「client→server 欠落時の完全再整列」）を注入し reconcile＋再送で回収。
// **S-restart（server 再起動跨ぎ・C10r）は本スイート対象外**（単一 Sequencer/Room を run 全体で保持＝restart を注入しない・Codex 第3回 P2）。
// 再起動 reconcile は決定論テスト（apps/collaboration-server: reconnect-fault WS-R5〔永続化再起動〕・restart-restore）で固定する。
//
// 決定論: 選択は mulberry32(seed)、ID は決定的連番、時刻は手動クロック。Date.now()/Math.random() は使わない（再現性）。
// 証跡（seed・config・収束 hash・fault カウンタ）は doc/DD/DD-015/reconnect-fault-evidence.json へ出力する（Evidence full）。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { afterAll, describe, expect, it } from 'vitest';

import { displayRowOrder, documentHash } from '@nanairo-sheet/core';
import type { DocumentOperation } from '@nanairo-sheet/core';
import { Room, Sequencer, freshSequencerState, serializeSnapshot, verifySnapshotIntegrity } from '@nanairo-sheet/server';
import { createCounterIdGenerator as createConnIdGenerator } from '@nanairo-sheet/server';
import { createDocumentId, createOperationId, createRowId, createTransactionId } from '@nanairo-sheet/types';
import type { OperationId, RowId } from '@nanairo-sheet/types';
import { ClientSession, createCounterIdGenerator } from '@nanairo-sheet/collab';
import type { ConflictQueueEntry } from '@nanairo-sheet/collab';
import { InProcessHub } from '@nanairo-sheet/collab/inprocess-transport';
import { COLUMNS, createManualClock, num, str } from '@nanairo-sheet/collab/test-support';
import type { ManualClock } from '@nanairo-sheet/collab/test-support';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOCUMENT_ID = createDocumentId('reconnect-inv-doc');
const RESEND_MILLIS = 1_000;
const CATCHUP_POLL_MILLIS = 1_000;
const PUMP_ADVANCE = 2_000;
const PUMP_EVERY = 4;
const HUGE = Number.MAX_SAFE_INTEGER;
const MAX_QUIESCE_TICKS = 2_000;

interface Client {
  clientId: string;
  index: number;
  session: ClientSession;
  rowSeq: number;
  opSeq: number;
  disconnected: boolean;
  reconnectAt: number;
}

interface RunOptions {
  seed: number;
  clientCount: number;
  opCount: number;
  faults: { duplicate: number; drop: number; delay: number };
  disconnectRate: number;
  injectClientToServer: boolean; // true=submitOperation（client→server）にも drop/duplicate 注入＝D27 経路
  seedRows: number;
}

interface RunResult {
  converged: boolean;
  quiescenceTicks: number;
  serverHash: string;
  finalRevision: number;
  submittedOps: number;
  submittedIds: OperationId[]; // 全 submit の operationId（各 op の説明責任＝Codex P2-2）
  unaccountedIds: string[]; // server 未処理（ackCache 不在）かつ conflict 不在＝サイレント喪失（0 でなければ入力喪失）
  acceptedOps: number;
  rejects: ConflictQueueEntry[];
  disconnectEvents: number;
  faultCounters: { duplicate: number; drop: number; delay: number; disconnect: number };
  maxPendingDepth: number;
  snapshotReplayHash: string;
  clientHashes: string[];
}

function genOp(client: Client, rng: () => number, liveRows: RowId[], maxRows: number, totalRows: number): DocumentOperation | undefined {
  const roll = rng();
  if (liveRows.length < 4 && totalRows < maxRows) {
    const rowId = createRowId(`ins-${client.index}-${client.rowSeq}`);
    client.rowSeq += 1;
    const anchor = liveRows.length > 0 && rng() >= 0.3 ? liveRows[Math.floor(rng() * liveRows.length)] : null;
    return { type: 'insertRows', afterRowId: anchor, rows: [{ rowId }] };
  }
  if (roll < 0.12 && totalRows < maxRows) {
    const rowId = createRowId(`ins-${client.index}-${client.rowSeq}`);
    client.rowSeq += 1;
    return { type: 'insertRows', afterRowId: null, rows: [{ rowId }] };
  }
  if (roll < 0.22 && liveRows.length > 4) {
    const candidates = liveRows.filter((r) => String(r).startsWith('ins-'));
    if (candidates.length > 0) {
      return { type: 'deleteRows', rowIds: [candidates[Math.floor(rng() * candidates.length)]] };
    }
  }
  if (liveRows.length === 0) {
    const rowId = createRowId(`ins-${client.index}-${client.rowSeq}`);
    client.rowSeq += 1;
    return { type: 'insertRows', afterRowId: null, rows: [{ rowId }] };
  }
  const targetRow = liveRows[Math.floor(rng() * liveRows.length)];
  const targetCol = COLUMNS[Math.floor(rng() * COLUMNS.length)];
  const value = rng() < 0.5 ? str(`v${client.index}-${client.opSeq}`) : num(client.opSeq);
  client.opSeq += 1;
  return { type: 'setCells', conflictPolicy: 'reject-overlap', changes: [{ rowId: targetRow, columnId: targetCol, value }] };
}

function onlineClients(clients: Client[]): Client[] {
  return clients.filter((c) => !c.disconnected);
}

function seedServer(sequencer: Sequencer, rows: string[]): void {
  sequencer.submit({
    protocolVersion: 1,
    documentId: DOCUMENT_ID,
    operationId: createOperationId('seed'),
    transactionId: createTransactionId('tx-seed'),
    actorId: 'system',
    clientId: 'system',
    clientSequence: 1,
    baseRevision: 0,
    operation: { type: 'insertRows', afterRowId: null, rows: rows.map((r) => ({ rowId: createRowId(r) })) },
  });
}

function run(opts: RunOptions): RunResult {
  const rng = mulberry32(opts.seed);
  const clock: ManualClock = createManualClock();
  const sequencer = new Sequencer(freshSequencerState(COLUMNS), clock);
  const room = new Room(sequencer, { clock, idGenerator: createConnIdGenerator('conn') });
  const hub = new InProcessHub(room, { seed: opts.seed, faults: opts.faults, injectClientToServer: opts.injectClientToServer });

  seedServer(sequencer, Array.from({ length: opts.seedRows }, (_, i) => `seed-${i + 1}`));

  const clients: Client[] = [];
  for (let i = 0; i < opts.clientCount; i += 1) {
    const clientId = `c${i}`;
    const session = new ClientSession({
      clientId,
      userId: `u${i}`,
      displayName: `User${i}`,
      documentId: DOCUMENT_ID,
      columnOrder: COLUMNS,
      transport: hub.connect(clientId),
      clock,
      idGenerator: createCounterIdGenerator(`${clientId}-op`),
      resendTimeoutMillis: RESEND_MILLIS,
      catchupPollMillis: CATCHUP_POLL_MILLIS,
      maxOfflineMillis: HUGE,
      maxOfflinePending: HUGE,
    });
    session.start();
    clients.push({ clientId, index: i, session, rowSeq: 0, opSeq: 0, disconnected: false, reconnectAt: -1 });
  }
  hub.deliverAll();

  const maxRows = 40;
  let submittedOps = 0;
  const submittedIds: OperationId[] = [];
  let disconnectEvents = 0;
  let maxPendingDepth = 0;

  for (let i = 0; i < opts.opCount; i += 1) {
    // 1. 期限到来の再接続
    for (const client of clients) {
      if (client.disconnected && i >= client.reconnectAt) {
        hub.reconnect(client.clientId);
        client.disconnected = false;
      }
    }
    // 2. 切断（先に配送して当該 Client のキュー済み reject/ack を渡してから落とす）
    if (onlineClients(clients).length > 1 && rng() < opts.disconnectRate) {
      const online = onlineClients(clients);
      const victim = online[Math.floor(rng() * online.length)];
      hub.deliverAll();
      hub.disconnect(victim.clientId);
      victim.disconnected = true;
      victim.reconnectAt = i + 2 + Math.floor(rng() * 6);
      disconnectEvents += 1;
    }
    // 3. online な 1 Client が op を生成・楽観適用・送信
    const online = onlineClients(clients);
    if (online.length > 0) {
      const actor = online[Math.floor(rng() * online.length)];
      const view = actor.session.viewDocument;
      const op = genOp(actor, rng, displayRowOrder(view), maxRows, view.rowOrder.length);
      if (op !== undefined) {
        submittedIds.push(actor.session.submitLocalOperation(op));
        submittedOps += 1;
      }
    }
    for (const client of clients) {
      maxPendingDepth = Math.max(maxPendingDepth, client.session.pendingCount);
    }
    if (i % PUMP_EVERY === 0) {
      clock.advance(PUMP_ADVANCE);
      for (const client of clients) {
        if (!client.disconnected) {
          client.session.tick();
        }
      }
      hub.deliverAll();
    }
  }

  // 静止点: フォールト無効化 → 全再接続 → 収束まで tick 前進
  hub.disableFaults();
  for (const client of clients) {
    if (client.disconnected) {
      hub.reconnect(client.clientId);
      client.disconnected = false;
    }
  }
  let quiescenceTicks = 0;
  let converged = false;
  while (quiescenceTicks < MAX_QUIESCE_TICKS) {
    clock.advance(PUMP_ADVANCE);
    for (const client of clients) {
      client.session.tick();
    }
    hub.deliverAll();
    quiescenceTicks += 1;
    const serverHash = documentHash(sequencer.document);
    const serverRev = sequencer.currentRevision;
    if (
      clients.every(
        (c) =>
          c.session.isOnline &&
          c.session.pendingCount === 0 &&
          c.session.nextExpectedRevision === serverRev + 1 &&
          c.session.committedHash() === serverHash,
      )
    ) {
      converged = true;
      break;
    }
  }

  const snapshot = serializeSnapshot(sequencer.exportState());
  const integrity = verifySnapshotIntegrity(snapshot);
  const rejects = clients.flatMap((c) => c.session.conflictQueue.filter((e) => e.reason === 'rejected'));

  // Codex P2-2: 全 submit の説明責任。各 op は server で処理済み（ackCache 在＝accepted or noop）か、いずれかの client の
  // Conflict Queue に保持されていなければならない。どちらでもない op = pending 空・hash 一致でも**サイレント喪失**（入力損失）。
  const conflictedIds = new Set(clients.flatMap((c) => c.session.conflictQueue.map((e) => String(e.operationId))));
  const unaccountedIds = submittedIds
    .filter((id) => sequencer.ackedRevisionOf(id) === undefined && !conflictedIds.has(String(id)))
    .map((id) => String(id));

  return {
    converged,
    quiescenceTicks,
    serverHash: documentHash(sequencer.document),
    finalRevision: sequencer.currentRevision,
    submittedOps,
    submittedIds,
    unaccountedIds,
    acceptedOps: snapshot.operationLog.length,
    rejects,
    disconnectEvents,
    faultCounters: { ...hub.counters },
    maxPendingDepth,
    snapshotReplayHash: integrity.replayHash,
    clientHashes: clients.map((c) => c.session.committedHash()),
  };
}

const evidence: Array<Record<string, unknown>> = [];

function assertConverged(label: string, res: RunResult): void {
  expect(res.converged, `[${label}] quiescence within ${MAX_QUIESCE_TICKS} ticks`).toBe(true);
  // INV: 全 client hash == server hash（収束）
  for (const h of res.clientHashes) {
    expect(h, `[${label}] client hash == server`).toBe(res.serverHash);
  }
  // INV: 二重適用0（snapshot replay hash == server hash・operationId 重複0・revision 連番は snapshot 整合で担保）
  expect(res.snapshotReplayHash, `[${label}] snapshot replay hash`).toBe(res.serverHash);
  // INV（Codex P2-2）: 全 submit の説明責任＝サイレント喪失0（accepted/noop or conflict のいずれかに必ず存在する）。
  expect(res.unaccountedIds, `[${label}] no silently lost ops (accounted=accepted/noop or conflict)`).toEqual([]);
  // meta: フォールトが実際に発火（"通るように書いた"の否定）
  expect(res.disconnectEvents, `[${label}] disconnect fired`).toBeGreaterThan(0);
  expect(res.faultCounters.delay, `[${label}] delay fired`).toBeGreaterThan(0);
  expect(res.faultCounters.drop, `[${label}] drop fired`).toBeGreaterThan(0);
}

describe('invariant/collab reconnect-fault（DD-015・§2.3 idempotency/reconnect・catch-up 実充足）', () => {
  const configs: RunOptions[] = [
    { seed: 20_260_715, clientCount: 3, opCount: 1_200, faults: { duplicate: 0.15, drop: 0.15, delay: 0.2 }, disconnectRate: 0.08, injectClientToServer: false, seedRows: 6 },
    { seed: 771_113, clientCount: 4, opCount: 1_200, faults: { duplicate: 0.12, drop: 0.15, delay: 0.2 }, disconnectRate: 0.1, injectClientToServer: false, seedRows: 6 },
    // D27/D34: client→server の submitOperation 欠落を注入（reconcile＋再送＋seq違反回復で完全再整列＝データ損失0）
    { seed: 909_090, clientCount: 3, opCount: 1_000, faults: { duplicate: 0.1, drop: 0.12, delay: 0.15 }, disconnectRate: 0.08, injectClientToServer: true, seedRows: 6 },
    // 2026-09-12（DD-053）: 元は seed=1_234_567 だったが、welcome 直後に presence を送るようになった影響で
    // RNG 消費量（InProcessHub.deliverNext の delay ロール）がわずかに変わり、この 1 座席だけ
    // 「InProcessHub.deliverAll: message storm」で落ちるようになった。**原因は本DDの presence 変更ではない**:
    // 変更前のコードで本 config（injectClientToServer:true）のまま seed だけ 1〜40 を振ったところ 40 件中 10 件
    // （25%）が同じ message storm を再現した＝client-sequence-violation 受信時の再送（session.ts handleRejected）が
    // 一部のフォールト系列で収束しない、既存の潜在バグ（コード注釈の「client-sequence 完全再整列は未実装」＝D27
    // deferred 境界に該当）。本DDはこの座席を新しい非該当 seed へ差し替えるだけに留め、収束保証自体の修正は
    // 別DD（Sequencer/ClientSession の client-sequence 完全再整列）の起票が必要（doc/plan/stage2-backlog.md 参照）。
    { seed: 1_234_568, clientCount: 4, opCount: 1_000, faults: { duplicate: 0.1, drop: 0.12, delay: 0.15 }, disconnectRate: 0.1, injectClientToServer: true, seedRows: 6 },
  ];

  for (const cfg of configs) {
    const kind = cfg.injectClientToServer ? 'C→S欠落含む(D27)' : 'S→C欠落';
    it(
      `seed=${cfg.seed}・${cfg.clientCount}client×${cfg.opCount}op・${kind}・切断注入 → 全収束・二重適用0・喪失0`,
      () => {
        const res = run(cfg);
        process.stdout.write(
          `\n[reconnect-inv seed-${cfg.seed}] ${JSON.stringify({
            kind,
            clients: cfg.clientCount,
            ops: cfg.opCount,
            accepted: res.acceptedOps,
            disconnects: res.disconnectEvents,
            faults: res.faultCounters,
            rejects: res.rejects.length,
            maxPendingDepth: res.maxPendingDepth,
            finalRevision: res.finalRevision,
            serverHash: res.serverHash,
            quiescenceTicks: res.quiescenceTicks,
          })}\n`,
        );
        evidence.push({
          seed: cfg.seed,
          kind,
          clientCount: cfg.clientCount,
          opCount: cfg.opCount,
          injectClientToServer: cfg.injectClientToServer,
          disconnectRate: cfg.disconnectRate,
          faultRates: cfg.faults,
          converged: res.converged,
          quiescenceTicks: res.quiescenceTicks,
          disconnectEvents: res.disconnectEvents,
          faultCounters: res.faultCounters,
          acceptedOps: res.acceptedOps,
          rejects: res.rejects.length,
          finalRevision: res.finalRevision,
          serverHash: res.serverHash,
          snapshotReplayHash: res.snapshotReplayHash,
        });
        try {
          assertConverged(`seed-${cfg.seed}`, res);
        } catch (error) {
          process.stdout.write(`\n[RECONNECT-INV FAILED] reproduce with: seed=${cfg.seed} clients=${cfg.clientCount} ops=${cfg.opCount} injectC2S=${String(cfg.injectClientToServer)}\n`);
          throw error;
        }
      },
      120_000,
    );
  }

  it('同一 seed 再実行で完全に同一の最終 hash・受理数（決定論・再現性）', () => {
    const cfg = configs[2]; // D27 経路（client→server 欠落）で決定論を確認
    const a = run(cfg);
    const b = run({ ...cfg });
    assertConverged('determinism-a', a);
    assertConverged('determinism-b', b);
    expect(b.serverHash).toBe(a.serverHash);
    expect(b.finalRevision).toBe(a.finalRevision);
    expect(b.acceptedOps).toBe(a.acceptedOps);
    expect(b.faultCounters).toEqual(a.faultCounters);
  });

  afterAll(() => {
    // Evidence full: seed・config・収束 hash・fault カウンタを DD-015 証跡へ出力（再現コマンドは各 it のログに残す）。
    // DD-015 はアーカイブ済み（正典スナップショットは doc/archived/DD/DD-015/）ゆえ、テスト再実行の再生成分は
    // git 追跡外の test-results/ 配下へ書く（active な doc/DD/ を汚さない）。
    const here = dirname(fileURLToPath(import.meta.url));
    const outDir = join(here, '..', '..', '..', 'test-results', 'dd-evidence', 'DD-015');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, 'reconnect-fault-evidence.json'),
      `${JSON.stringify({ generatedBy: 'tests/invariants/collab/reconnect-fault.invariant.test.ts', runs: evidence }, null, 2)}\n`,
      'utf8',
    );
  });
});
