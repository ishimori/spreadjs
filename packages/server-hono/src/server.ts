// 開発用WSサーバーアダプター（Hono + @hono/node-server + ws）。phase4-design.md の HTTP/WS 配線・接続ライフサイクル・
// heartbeat/TTL sweep 駆動・起動/停止 API・後始末を実装する。**実クロック・実タイマー・Node API・ws/hono を使う唯一の層**
// （Room/Sequencer/Presence の注入クロック設計は不変＝server.ts が {now: Date.now} と setInterval を注入・駆動する）。
//
// server-core（Room）はトランスポート非依存で Outbound[] を返す。本アダプターは connectionId↔WebSocket を対応づけ、
// Outbound を fan-out し、close/error/TTL sweep で presenceRemoved を配信する。protocol-subset §1/§5/§6/§7 準拠。
//
// DD-026（consumer 統合①）: U1 注入ストア（oplog/snapshotStore）と初期文書（initialDocument＝document@0・snapshot@0 を
// durable 化してから listen）／U2 認証フック（upgrade 時 authenticate・identity で envelope actorId と presence を上書き）／
// U3 サーバー起点操作（submit＝擬似接続 'server' として通常受理経路を通す）を本層に追加した。

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Server as HttpServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { dirname, join } from 'node:path';
import process from 'node:process';
import type { Duplex } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';

import { documentHash } from '@nanairo-sheet/core';
import type {
  ClientMessage,
  ClientMessageExceptJoin,
  ClientOperationEnvelope,
  JoinMessage,
  SetCellsOperation,
} from '@nanairo-sheet/core';
import {
  FileOpLogStore,
  FileSnapshotStore,
  PersistentRoom,
  Room,
  Sequencer,
  createPersistedSnapshot,
  deserializeSnapshot,
  freshSequencerState,
  recoverSequencerState,
  serializeSnapshot,
} from '@nanairo-sheet/server';
import type {
  Clock,
  OpLogStore,
  Outbound,
  OutboundTarget,
  RecoveryReport,
  SequencerState,
  SnapshotData,
  SnapshotStore,
} from '@nanairo-sheet/server';
import {
  createColumnId,
  createDocumentId,
  createOperationId,
  createRowId,
  createTransactionId,
} from '@nanairo-sheet/types';
import type { OperationId, RowId } from '@nanairo-sheet/types';
import { decodeClientMessage } from '@nanairo-sheet/core';

import {
  DEFAULT_INTEGRATION_DATASET,
  integrationColumnOrder,
  seedIntegrationDataset,
} from './seed-dataset';
import type { IntegrationDatasetConfig } from './seed-dataset';
import { buildInitialDocument, liftSetCellsInput } from './serve-adapters';
import type {
  ServeAuthenticate,
  ServeIdentity,
  ServeInitialDocument,
  ServeSetCellsInput,
  ServeSubmitResult,
} from './serve-types';
import { rawDataToString } from './ws-frame';

const DEFAULT_PORT = 8787; // playground(5173) と非衝突（指示 3）
const DEFAULT_SEED_ROWS = 5;
const DEFAULT_HEARTBEAT_MILLIS = 5_000; // §9.3
const DEFAULT_TTL_MILLIS = 15_000; // §9.3
const DEFAULT_SWEEP_MILLIS = 5_000;
const PROTOCOL_VERSION = 1;
/** サーバー起点操作（DD-026-3）の予約 clientId。clientSequence は Sequencer の表から継続する（再起動をまたぐ）。 */
export const SERVER_CLIENT_ID = 'server';
/** サーバー起点操作を Room へ投入するときの擬似 connectionId（ws を持たない＝ACK は dispatch で捨てられる）。 */
const SERVER_CONNECTION_ID = 'server';

type NodeServer = ReturnType<typeof serve>;

/** 診断の受け口（serve() の onDiagnostic へ橋渡し・未指定なら無出力）。 */
export type DiagnosticSink = (level: 'debug' | 'info' | 'warn' | 'error', code: string, message: string) => void;

export interface StartServerOptions {
  port?: number; // 既定 8787。0 = OS 任せのランダムポート（テスト・指示 3）
  host?: string; // 既定 '127.0.0.1'
  documentId?: string; // 既定 'demo-doc'
  columnOrder?: string[]; // 既定 ['col-a','col-b','col-c']
  seedRows?: number; // 既定 5（初期グリッド row-1..row-N）。initialDocument とは排他
  heartbeatMillis?: number; // 既定 5000（/config でデモへ伝える）
  ttlMillis?: number; // 既定 15000（Room presence TTL）
  sweepMillis?: number; // 既定 5000（sweep 実タイマー間隔）
  restoreFrom?: SnapshotData; // 指定時: snapshot＋log から復元起動（seed をスキップ・revision 継続・S-K2/K4）
  integrationDataset?: IntegrationDatasetConfig | boolean; // DD-005 Phase 2: 50,000行×200列・非空約10万を投入（true=既定規模）
  persistenceDir?: string; // DD-014: 指定時にファイル永続化（oplog＋snapshot）を有効化。再起動で snapshot＋tail から復旧する
  snapshotIntervalOps?: number; // DD-014: N op ごとに非同期 snapshot 生成（既定 1,000）
  oplog?: OpLogStore; // DD-026-1: 注入 oplog（snapshotStore と同時指定・persistenceDir と排他）
  snapshotStore?: SnapshotStore; // DD-026-1: 注入 snapshot ストア（oplog と同時指定・persistenceDir と排他）
  initialDocument?: () => Promise<ServeInitialDocument> | ServeInitialDocument; // DD-026-1: 復旧できる状態が無いときの初期文書（document@0）
  authenticate?: ServeAuthenticate; // DD-026-2: upgrade 時の認証フック（null=401・throw=500）
  diagnostics?: DiagnosticSink; // serve() の onDiagnostic への橋渡し
  documents?: StartDocumentsOptions; // DD-043: 複数文書 serve（単一文書オプション群とは排他）
}

/**
 * 内部の文書構成（DD-043）。公開 `ServeDocumentConfig` の内部ストア版で、index.ts が adapter を掛けて渡す。
 * 単一文書オプション（documentId/columnOrder/...）と同じ意味を文書単位で持つ。
 */
export interface StartDocumentConfig {
  columnOrder: readonly string[];
  seedRows?: number;
  persistenceDir?: string;
  oplog?: OpLogStore;
  snapshotStore?: SnapshotStore;
  initialDocument?: () => Promise<ServeInitialDocument> | ServeInitialDocument;
}

/** 複数文書 serve の内部オプション（DD-043・v1 は起動時に決めた N 枚固定）。 */
export interface StartDocumentsOptions {
  documentIds: readonly string[];
  resolve: (documentId: string) => Promise<StartDocumentConfig | null> | StartDocumentConfig | null;
  defaultDocumentId?: string;
}

/** 起動時の検疫で serve から外された文書（DD-043 D3）。 */
export interface QuarantinedDocument {
  documentId: string;
  reason: string;
}

export interface RunningServer {
  port: number;
  url: string;
  documentId: string; // 既定文書（documentId 無指定の接続の宛先）。DD-043 でも意味は不変
  documentIds: string[]; // DD-043: 実際に serve 中の文書（起動時の検疫で外れた分は含まない）
  quarantined: QuarantinedDocument[]; // DD-043: 起動時の復旧失敗で外した文書（多文書構成のみ・単一文書は起動失敗）
  hash(documentId?: string): string; // 現在の権威文書 hash（smoke の収束 assert 用）。未指定=既定文書
  snapshot(documentId?: string): SnapshotData; // 検査用。未指定=既定文書
  connectionCount(documentId?: string): number; // リーク検査用（後始末後 0）。未指定=全文書合計
  recovery?: RecoveryReport; // DD-014: 永続化有効時の再起動復旧内訳（snapshot revision・tail replay 数。既定文書のもの）
  submit(operation: ServeSetCellsInput, actorId: string, documentId?: string): Promise<ServeSubmitResult>; // DD-026-3
  close(): Promise<void>; // 全 ws terminate → wss.close → http server.close → clearInterval → oplog/snapshot close
}

/**
 * RoomBridge が駆動する Room 相当（Room＝同期／PersistentRoom＝submit のみ durable のため Promise を返す）。
 * handleMessage が Promise を返す場合、dispatch は durable 化（fsync）後に行われる（DD-014 durable ACK 契約）。
 */
interface RoomController {
  handleJoin(join: JoinMessage): { connectionId: string; outbound: Outbound[] };
  handleMessage(connectionId: string, message: ClientMessageExceptJoin): Outbound[] | Promise<Outbound[]>;
  handleDisconnect(connectionId: string): Outbound[];
  sweep(): Outbound[];
  activeConnectionIds(): readonly string[];
}

/** 接続ごとのメタ（認証済み identity・文書 ID 厳格判定）。ws をキーに保持し、close/sweep で解放する。 */
interface ConnectionMeta {
  readonly identity: ServeIdentity | undefined;
  readonly strictDocument: boolean;
}

/**
 * connectionId ↔ WebSocket を対応づけ、Room の Outbound[] を fan-out するブリッジ。
 * 接続ライフサイクル（accept → join → 確立 → close/error）と TTL sweep を実装する（phase4-design §2/§3）。
 * DD-026-2: 認証済み identity を接続ごとに保持し、Room へ渡す前に submitOperation/presence の身元を上書きする。
 */
class RoomBridge {
  private readonly wsByConnection = new Map<string, WebSocket>();
  private readonly connectionByWs = new Map<WebSocket, string>();
  private readonly metaByWs = new Map<WebSocket, ConnectionMeta>();

  constructor(
    private readonly room: RoomController,
    /** この bridge が担当する文書 ID（join の申告 documentId と突き合わせる・DD-043）。 */
    private readonly documentId: string,
    private readonly diagnostics?: DiagnosticSink,
  ) {}

  /**
   * 新規 WS を受理し、メッセージ・切断を購読する（connectionId は最初の join で確定）。identity は authenticate の結果。
   * `strictDocument`（DD-043）= true の接続は、join の申告 documentId が本 bridge の文書と違えば切断する
   * （複数文書 serve・`?documentId=` 明示時。他文書の envelope を oplog へ混ぜない）。
   */
  onConnect(ws: WebSocket, identity: ServeIdentity | undefined, strictDocument = false): void {
    this.metaByWs.set(ws, { identity, strictDocument });
    ws.on('message', (data: RawData) => {
      this.onMessage(ws, data);
    });
    ws.on('close', () => {
      this.onClose(ws);
    });
    ws.on('error', () => {
      this.onClose(ws); // error は close を誘発するが、両発火でも onClose は冪等（DA D28）
    });
  }

  connectionCount(): number {
    return this.connectionByWs.size;
  }

  /** TTL sweep を発火し presenceRemoved を配信、失効接続の ws を close する（実タイマーから呼ぶ）。 */
  sweep(): void {
    this.dispatch(this.room.sweep());
    const active = new Set(this.room.activeConnectionIds());
    for (const [connectionId, ws] of [...this.wsByConnection]) {
      if (!active.has(connectionId)) {
        this.wsByConnection.delete(connectionId);
        this.connectionByWs.delete(ws);
        this.metaByWs.delete(ws);
        ws.close(1000, 'presence ttl expired'); // 続く close イベントは connectionByWs 削除済みゆえ no-op（冪等）
      }
    }
  }

  /**
   * サーバー起点の操作（DD-026-3）を擬似接続 SERVER_CONNECTION_ID として通常経路（Room/PersistentRoom.handleMessage）へ
   * 投入する。永続化有効時は durable 化後に解決する。ACK（宛先＝擬似接続）は ws が無いため dispatch が捨て、operations は
   * 全接続へ配信される。Room の ACK/reject から結果を組む。
   */
  async submitFromServer(envelope: ClientOperationEnvelope): Promise<ServeSubmitResult> {
    const outbound = await this.room.handleMessage(SERVER_CONNECTION_ID, { type: 'submitOperation', envelope });
    this.dispatch(outbound);
    return submitResultOf(envelope.operationId, outbound);
  }

  private onMessage(ws: WebSocket, data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data));
    } catch {
      this.closeSocket(ws, 1008, 'invalid json'); // 不正 JSON は切断（§エラーハンドリング）
      return;
    }
    const message = decodeClientMessage(parsed);
    if (message === undefined) {
      this.closeSocket(ws, 1008, 'unrecognized message');
      return;
    }
    try {
      this.route(ws, message);
    } catch (error) {
      // 1 接続のメッセージ処理失敗を他接続へ波及させない（当該接続のみ切断・P08: 握りつぶさない）。
      console.error(`RoomBridge: message handling failed: ${errorMessage(error)}`);
      this.closeSocket(ws, 1011, 'internal error');
    }
  }

  private route(ws: WebSocket, message: ClientMessage): void {
    const existing = this.connectionByWs.get(ws);
    if (message.type === 'join') {
      if (existing !== undefined) {
        return; // 二重 join は無視
      }
      if (message.clientId === SERVER_CLIENT_ID) {
        // 予約 clientId（DD-026-3）: サーバー起点操作の clientSequence 表を共有してしまい両者が violation になるため拒否する。
        this.closeSocket(ws, 1008, 'reserved clientId');
        return;
      }
      if (!this.acceptDocument(ws, message)) {
        return;
      }
      const { connectionId, outbound } = this.room.handleJoin(message);
      this.wsByConnection.set(connectionId, ws);
      this.connectionByWs.set(ws, connectionId);
      this.dispatch(outbound); // welcome → operations → presenceSnapshot をこの順で（§8.2）
      return;
    }
    if (existing === undefined) {
      return; // join 前の非 join メッセージは無視（接続は維持）
    }
    // DD-026-2: 認証済み接続は申告の actorId/userId/displayName を信用せず、identity で上書きしてから Room へ渡す。
    const identity = this.metaByWs.get(ws)?.identity;
    const result = this.room.handleMessage(existing, identity !== undefined ? withIdentity(message, identity) : message);
    if (result instanceof Promise) {
      // durable 境界（oplog fsync）解決後に ACK/broadcast を dispatch する（DD-014 durable ACK 契約）。
      // 書込失敗時は当該接続のみ切断（他接続へ波及させない・P08）。
      result.then((outbound) => this.dispatch(outbound)).catch((error: unknown) => {
        console.error(`RoomBridge: durable submit failed: ${errorMessage(error)}`);
        this.closeSocket(ws, 1011, 'internal error');
      });
      return;
    }
    this.dispatch(result);
  }

  /**
   * join の申告 documentId を検証する（DD-043）。厳格接続（複数文書 serve・`?documentId=` 明示）で不一致なら切断して false。
   * 従来の単一文書・無指定接続は後方互換のため受理し、警告診断だけ出す（申告の不一致は envelope の documentId 汚染源）。
   */
  private acceptDocument(ws: WebSocket, join: JoinMessage): boolean {
    if (String(join.documentId) === this.documentId) {
      return true;
    }
    if (this.metaByWs.get(ws)?.strictDocument === true) {
      this.closeSocket(ws, 1008, 'document mismatch');
      return false;
    }
    this.diagnostics?.(
      'warn',
      'document-mismatch',
      `join の documentId '${String(join.documentId)}' が serve 中の '${this.documentId}' と一致しません（単一文書構成のため従来どおり受理）`,
    );
    return true;
  }

  private onClose(ws: WebSocket): void {
    const connectionId = this.connectionByWs.get(ws);
    if (connectionId === undefined) {
      this.metaByWs.delete(ws); // 未 join のまま閉じた接続のメタ（identity 等）を解放
      return; // 未 join or 既に削除済み（close/error 両発火・sweep close の冪等・DA D28）
    }
    this.connectionByWs.delete(ws);
    this.wsByConnection.delete(connectionId);
    this.metaByWs.delete(ws);
    this.dispatch(this.room.handleDisconnect(connectionId)); // presenceRemoved（others）即時・§9.3
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    this.onClose(ws); // 先に room/マップから外し presenceRemoved を配信してから close
    ws.close(code, reason);
  }

  private dispatch(outbound: Outbound[]): void {
    for (const item of outbound) {
      for (const connectionId of this.resolveTargets(item.target)) {
        const ws = this.wsByConnection.get(connectionId);
        if (ws !== undefined && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(item.message));
        }
      }
    }
  }

  private resolveTargets(target: OutboundTarget): string[] {
    switch (target.kind) {
      case 'connection':
        return [target.connectionId];
      case 'others':
        return this.room.activeConnectionIds().filter((id) => id !== target.exceptConnectionId);
      case 'all':
        return [...this.room.activeConnectionIds()];
    }
  }
}

/** 認証済み identity で申告値を上書きする（submitOperation の actorId・presence の userId/displayName。DD-026-2）。 */
function withIdentity(message: ClientMessageExceptJoin, identity: ServeIdentity): ClientMessageExceptJoin {
  switch (message.type) {
    case 'submitOperation':
      return { type: 'submitOperation', envelope: { ...message.envelope, actorId: identity.actorId } };
    case 'presence':
      return {
        type: 'presence',
        sequence: message.sequence,
        payload: { ...message.payload, userId: identity.actorId, displayName: identity.displayName },
      };
    case 'heartbeat':
    case 'requestCatchup':
      return message;
  }
}

/** Room の Outbound（擬似接続宛て ACK/reject）から submit 結果を組む（DD-026-3）。 */
function submitResultOf(operationId: OperationId, outbound: Outbound[]): ServeSubmitResult {
  for (const item of outbound) {
    const message = item.message;
    if (message.type === 'operationAck' && message.operationId === operationId) {
      return { status: 'accepted', operationId: String(operationId), revision: message.revision };
    }
    if (message.type === 'operationRejected' && message.operationId === operationId) {
      return { status: 'rejected', operationId: String(operationId), code: message.code };
    }
  }
  throw new Error('submit: Room が ACK/reject を返しませんでした（内部不整合）');
}

/** 1 文書分の起動仕様（内部・DD-043）。単一文書構成は N=1 のこの仕様へ写像する。 */
interface DocumentSpec {
  documentId: string;
  columnOrder: string[];
  /** **明示指定された** 初期グリッド行数（未指定=undefined。既定 DEFAULT_SEED_ROWS の適用は seed 時）。 */
  seedRows?: number;
  persistenceDir?: string;
  oplog?: OpLogStore;
  snapshotStore?: SnapshotStore;
  initialDocument?: () => Promise<ServeInitialDocument> | ServeInitialDocument;
  /** デモ・検査専用（単一文書構成のみ）。 */
  restoreFrom?: SnapshotData;
  /** デモ専用（単一文書構成のみ）。 */
  dataset?: IntegrationDatasetConfig;
}

/**
 * 1 文書分のランタイム（Sequencer / Room / PersistentRoom / RoomBridge の組・DD-043）。
 * 文書間で状態を共有しない＝操作・presence・oplog・snapshot はすべて文書ごとに閉じる。
 */
interface DocumentRuntime {
  readonly documentId: string;
  readonly columnOrder: string[];
  readonly bridge: RoomBridge;
  readonly recovery: RecoveryReport | undefined;
  hash(): string;
  snapshot(): SnapshotData;
  submit(operation: ServeSetCellsInput, actorId: string): Promise<ServeSubmitResult>;
  close(): Promise<void>;
}

/**
 * 1 文書分の構成の排他規則を検証する（保存先は 1 つ・初期内容の供給元は 1 つ・ストアは両方指定）。
 * `at` は多文書構成で「どの文書の構成が矛盾しているか」を示す挿入句（単一文書構成では空文字）。
 */
function validateDocumentSpec(spec: DocumentSpec, at: string): void {
  // restoreFrom×persistenceDir 排他（DD-018-1 AC3・P2-4）: restoreFrom は in-memory 専用 bootstrap（検査/テスト）、
  // persistenceDir は durable file 復旧。併用は revision 不連続（空 dir＋revision R の restoreFrom→次 accepted op が R+1 を
  // 空 oplog 先頭へ書込→次回起動が連番違反で失敗）を生むため、起動時に明示拒否する（黙って壊さない・fail-fast）。
  if (spec.persistenceDir !== undefined && spec.restoreFrom !== undefined) {
    throw new Error(
      `startServer:${at} restoreFrom と persistenceDir は併用できません（restoreFrom=in-memory 専用復元・` +
        'persistenceDir=durable 復旧。併用は revision 不連続を招くため明示拒否・DD-018-1 P2-4）',
    );
  }
  // DD-026-1 排他: 保存先は 1 つ（persistenceDir=ファイル or 注入ストア）。初期内容の供給元も 1 つ（seed 系 or initialDocument）。
  if (spec.persistenceDir !== undefined && (spec.oplog !== undefined || spec.snapshotStore !== undefined)) {
    throw new Error(`serve:${at} persistenceDir と oplog/snapshotStore は併用できません（保存先は 1 つ・DD-026-1）`);
  }
  if ((spec.oplog === undefined) !== (spec.snapshotStore === undefined)) {
    throw new Error(
      `serve:${at} oplog と snapshotStore は両方指定してください（片方だけでは再起動復旧が成立しません・DD-026-1）`,
    );
  }
  if (spec.initialDocument !== undefined) {
    if (spec.seedRows !== undefined) {
      throw new Error(`serve:${at} initialDocument と seedRows は併用できません（初期内容の供給元は 1 つ・DD-026-1）`);
    }
    if (spec.restoreFrom !== undefined || spec.dataset !== undefined) {
      throw new Error(`startServer:${at} initialDocument は restoreFrom / integrationDataset と併用できません（DD-026-1）`);
    }
  }
}

/**
 * 1 文書分のランタイムを構築する（復旧 → 初期文書 → seed → Room/PersistentRoom/RoomBridge）。
 * 途中で失敗した場合は開いたストアを閉じてから throw する（起動時の検疫でハンドルを残さない・DD-043 D3）。
 */
async function createDocumentRuntime(
  spec: DocumentSpec,
  deps: { clock: Clock; ttlMillis: number; snapshotIntervalOps?: number; diagnostics?: DiagnosticSink },
): Promise<DocumentRuntime> {
  const { clock, ttlMillis, diagnostics } = deps;
  const documentId = spec.documentId;
  const columnOrderStrings = spec.columnOrder;
  const columnOrder = columnOrderStrings.map((c) => createColumnId(c));

  // 永続化（DD-014 ファイル or DD-026-1 注入ストア）: 再起動復旧＝最新 snapshot（document@R）＋oplog tail（revision>R）で復元。
  let oplog: OpLogStore | undefined;
  let snapshotStore: SnapshotStore | undefined;
  if (spec.persistenceDir !== undefined) {
    oplog = new FileOpLogStore(join(spec.persistenceDir, 'oplog.jsonl'));
    snapshotStore = new FileSnapshotStore(join(spec.persistenceDir, 'snapshots'));
  } else if (spec.oplog !== undefined && spec.snapshotStore !== undefined) {
    oplog = spec.oplog;
    snapshotStore = spec.snapshotStore;
  }

  try {
    let recovery: RecoveryReport | undefined;
    let recoveredState: SequencerState | undefined;
    if (oplog !== undefined && snapshotStore !== undefined) {
      // documentId 相互検証（DD-018-1 AC1）: 使用済み persistenceDir を別 documentId で起動＝誤公開を fail-fast。
      const recovered = await recoverSequencerState({ oplog, snapshotStore, columnOrder, documentId });
      recovery = recovered.report;
      // snapshot があれば op が 0 件でも復旧扱い（初期文書 snapshot@0 直後の再起動を fresh と誤判定して seed/initialDocument
      // で上書きしない・DD-026-1）。
      if (recovered.report.totalOps > 0 || recovered.report.fromSnapshotRevision !== undefined) {
        recoveredState = recovered.state; // 既存文書を復元（seed しない）
      }
    }

    // 初期文書（DD-026-1）: 復旧も restoreFrom も無いときだけ consumer の initialDocument から document@0 を組む。
    // oplog だけでは初期内容を再構築できないため、ストアがあれば snapshot@0 を durable 化してから listen する（保存失敗は起動失敗）。
    let initialDocumentState: SequencerState | undefined;
    if (recoveredState === undefined && spec.restoreFrom === undefined && spec.initialDocument !== undefined) {
      const input = await spec.initialDocument();
      const state = freshSequencerState(columnOrder);
      state.document = buildInitialDocument(columnOrder, input);
      if (snapshotStore !== undefined) {
        await snapshotStore.save(
          createPersistedSnapshot({
            documentId,
            revision: 0,
            createdAt: new Date(clock.now()).toISOString(),
            snapshot: { ...serializeSnapshot(state), operationLog: [] },
          }),
        );
      }
      initialDocumentState = state;
    }

    // 復元起動: restoreFrom（in-memory 検査用）指定時は snapshot＋log から Sequencer 状態を再構築する。
    // 永続化復元が優先（recoveredState）→初期文書→restoreFrom。いずれも無ければ空＋seed。
    const initialState =
      recoveredState ??
      initialDocumentState ??
      (spec.restoreFrom !== undefined ? deserializeSnapshot(spec.restoreFrom) : freshSequencerState(columnOrder));
    const sequencer = new Sequencer(initialState, clock);
    const room = new Room(sequencer, {
      clock,
      idGenerator: { next: () => randomUUID() }, // connectionId は実 UUID
      ttlMillis,
    });
    // fresh（復元でも初期文書でも restoreFrom でもない）ときだけ seed する。永続化有効時は seed op を durable に oplog へ追記し、
    // 次回再起動の復旧で seed 済み文書を再現できるようにする（seed が oplog に無いと edit の baseRevision が破綻する）。
    const isFresh = recoveredState === undefined && initialDocumentState === undefined && spec.restoreFrom === undefined;
    if (isFresh) {
      if (spec.dataset !== undefined) {
        seedIntegrationDataset(sequencer, documentId, spec.dataset);
      } else {
        seedInitialRows(sequencer, documentId, spec.seedRows ?? DEFAULT_SEED_ROWS);
      }
      if (oplog !== undefined) {
        await oplog.append(sequencer.exportState().operationLog); // seed を durable 化（revision 1..k）
      }
    }

    // 永続化有効時は PersistentRoom（durable ACK 境界＋snapshot 生成）で Room を包む。
    const persistentRoom =
      oplog !== undefined && snapshotStore !== undefined
        ? new PersistentRoom(room, sequencer, oplog, snapshotStore, clock, {
            documentId,
            snapshotIntervalOps: deps.snapshotIntervalOps,
          })
        : undefined;
    const bridge = new RoomBridge(persistentRoom ?? room, documentId, diagnostics);
    // 検査/復元用 snapshot: 永続化有効時は durable frontier 以下に制限する（未 fsync revision を `/snapshot`・
    // RunningServer.snapshot() から観測させない・DD-014-1 P1-3）。無効時は現在状態（全 in-memory が読取可能）。
    const readSnapshot = (): SnapshotData =>
      persistentRoom !== undefined ? persistentRoom.durableSnapshot() : serializeSnapshot(room.exportState());

    /**
     * サーバー起点 SetCells（DD-026-3）。clientSequence の採番と Room 投入の間に await を挟まない（同一 tick の並行 submit でも単調）。
     * 引数エラーも同期 throw せず reject で返す（`.catch` だけの呼び出しでも取りこぼさない＝常に Promise 契約）。
     */
    const submit = (operation: ServeSetCellsInput, actorId: string): Promise<ServeSubmitResult> => {
      if (actorId.length === 0) {
        return Promise.reject(new Error('submit: actorId が空です'));
      }
      if (operation.changes.length === 0) {
        return Promise.reject(new Error('submit: changes が空です（SetCells は 1 件以上）'));
      }
      let lifted: SetCellsOperation;
      try {
        lifted = liftSetCellsInput(operation); // 値検証（有限数・正準 LocalDate）は同期 throw → reject へ写す
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      const operationId = createOperationId(randomUUID());
      const envelope: ClientOperationEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        documentId: createDocumentId(documentId),
        operationId,
        transactionId: createTransactionId(`tx-${operationId}`),
        actorId,
        clientId: SERVER_CLIENT_ID,
        clientSequence: (sequencer.clientSequenceTable.get(SERVER_CLIENT_ID) ?? 0) + 1,
        baseRevision: sequencer.currentRevision,
        operation: lifted,
      };
      return bridge.submitFromServer(envelope);
    };

    return {
      documentId,
      columnOrder: columnOrderStrings,
      bridge,
      recovery,
      hash: () => documentHash(sequencer.document),
      snapshot: readSnapshot,
      submit,
      close: async () => {
        if (persistentRoom !== undefined) {
          await persistentRoom.close(); // 保留中の durable 書込を確定して oplog/snapshot ハンドルを閉じる
        }
      },
    };
  } catch (error) {
    // 起動途中の失敗（復旧失敗・snapshot@0 保存失敗・seed 追記失敗）でストアのハンドルを開いたまま残さない。
    // 多文書構成では当該文書だけ検疫して残りで立ち上がるため、ここで閉じないとハンドルが漏れる（DD-043 D3）。
    await closeStoreQuietly(oplog);
    await closeStoreQuietly(snapshotStore);
    throw error;
  }
}

/** ストアを閉じる（後始末専用。close の失敗は元の失敗を隠さないよう記録だけして飲み込む・P08）。 */
async function closeStoreQuietly(store: { close(): Promise<void> } | undefined): Promise<void> {
  if (store === undefined) {
    return;
  }
  try {
    await store.close();
  } catch (error) {
    console.error(`collaboration-server: store close failed during startup cleanup: ${errorMessage(error)}`);
  }
}

/** 構築済みランタイムを全て閉じる（起動途中の失敗・stop の後始末）。 */
async function closeRuntimes(runtimes: Map<string, DocumentRuntime>): Promise<void> {
  for (const runtime of runtimes.values()) {
    await runtime.close();
  }
}

/** 複数文書オプションを検証し、既定文書 ID を返す（DD-043）。 */
function validateDocumentsOptions(documents: StartDocumentsOptions): string {
  const ids = documents.documentIds;
  if (ids.length === 0) {
    throw new Error('serve: documents.documentIds が空です（v1 は起動時に serve する文書を 1 つ以上指定する・DD-043）');
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (id.length === 0) {
      throw new Error('serve: documents.documentIds に空の documentId が含まれています（DD-043）');
    }
    if (seen.has(id)) {
      throw new Error(`serve: documents.documentIds に重複した documentId '${id}' が含まれています（DD-043）`);
    }
    seen.add(id);
  }
  const defaultDocumentId = documents.defaultDocumentId ?? ids[0];
  if (!seen.has(defaultDocumentId)) {
    throw new Error(
      `serve: documents.defaultDocumentId '${defaultDocumentId}' が documentIds に含まれていません（DD-043）`,
    );
  }
  return defaultDocumentId;
}

/** 複数文書構成では単一文書オプションを受け付けない（どちらが効いているのか曖昧な起動を作らない・DD-043）。 */
function assertNoSingleDocumentOptions(options: StartServerOptions, dataset: IntegrationDatasetConfig | undefined): void {
  const conflicting: string[] = [];
  if (options.documentId !== undefined) conflicting.push('documentId');
  if (options.columnOrder !== undefined) conflicting.push('columnOrder');
  if (options.seedRows !== undefined) conflicting.push('seedRows');
  if (options.persistenceDir !== undefined) conflicting.push('persistenceDir');
  if (options.oplog !== undefined) conflicting.push('oplog');
  if (options.snapshotStore !== undefined) conflicting.push('snapshotStore');
  if (options.initialDocument !== undefined) conflicting.push('initialDocument');
  if (options.restoreFrom !== undefined) conflicting.push('restoreFrom');
  if (dataset !== undefined) conflicting.push('integrationDataset');
  if (conflicting.length > 0) {
    throw new Error(
      `serve: documents と単一文書オプション（${conflicting.join(' / ')}）は併用できません` +
        '（文書構成の供給元は 1 つ。単一文書は documents なしの従来指定、複数文書は documents.resolve・DD-043）',
    );
  }
}

/** upgrade / HTTP 要求の `?documentId=` を取り出す（未指定・空は undefined＝既定文書）。 */
function requestedDocumentId(url: string | undefined): string | undefined {
  const value = new URL(url ?? '/', 'http://localhost').searchParams.get('documentId');
  return value === null || value === '' ? undefined : value;
}

/** 開発用WSサーバーを起動する。listening 後に実ポートを含む RunningServer で resolve する（port 0 対応）。 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const heartbeatMillis = options.heartbeatMillis ?? DEFAULT_HEARTBEAT_MILLIS;
  const ttlMillis = options.ttlMillis ?? DEFAULT_TTL_MILLIS;
  const sweepMillis = options.sweepMillis ?? DEFAULT_SWEEP_MILLIS;
  const port = options.port ?? DEFAULT_PORT;
  const diagnostics = options.diagnostics;
  const clock: Clock = { now: () => Date.now() }; // アダプター層のみ実クロック（指示 1）
  // DD-005 統合データセット指定時は列順・シードを 50,000行×200列へ切り替える（既存の小規模デモとは排他）。
  const datasetConfig = resolveDataset(options.integrationDataset);
  const runtimeDeps = { clock, ttlMillis, snapshotIntervalOps: options.snapshotIntervalOps, diagnostics };

  // 文書レジストリ（DD-043）。単一文書構成は N=1 の同じ経路を通る（分岐は「仕様の作り方」だけ）。
  const runtimes = new Map<string, DocumentRuntime>();
  const quarantined: QuarantinedDocument[] = [];
  const multiDocument = options.documents !== undefined;
  let defaultDocumentId: string;

  if (options.documents !== undefined) {
    assertNoSingleDocumentOptions(options, datasetConfig);
    defaultDocumentId = validateDocumentsOptions(options.documents);
    for (const documentId of options.documents.documentIds) {
      let spec: DocumentSpec;
      try {
        // resolve の失敗・null は構成矛盾＝起動失敗（データ由来の復旧失敗と違い、再起動でも直らない）。
        const config = await options.documents.resolve(documentId);
        if (config === null) {
          throw new Error(
            `serve: documents.resolve('${documentId}') が null を返しました（documentIds に載せた文書は必ず引けること・DD-043）`,
          );
        }
        spec = { documentId, columnOrder: [...config.columnOrder], ...omitUndefined(config) };
        validateDocumentSpec(spec, ` [documentId=${documentId}]`);
      } catch (error) {
        await closeRuntimes(runtimes);
        throw error;
      }
      try {
        runtimes.set(documentId, await createDocumentRuntime(spec, runtimeDeps));
      } catch (error) {
        // D3 起動時の検疫: 復旧に失敗した文書だけ外し、残りの文書で立ち上がる（deterministic poison による
        // 全文書道連れの再起動ループを防ぐ）。診断で大きく警告し、外形上は当該文書への接続が 404 になる。
        const reason = errorMessage(error);
        quarantined.push({ documentId, reason });
        const summary = `document '${documentId}' を起動時の復旧失敗により serve から外しました（検疫・DD-043 D3）: ${reason}`;
        if (diagnostics !== undefined) {
          diagnostics('error', 'document-quarantined', summary);
        }
        console.error(`collaboration-server: ${summary}`); // 診断 hook 未指定でも黙らせない（P08）
      }
    }
  } else {
    const documentId = options.documentId ?? 'demo-doc';
    const spec: DocumentSpec = {
      documentId,
      columnOrder:
        datasetConfig !== undefined
          ? integrationColumnOrder(datasetConfig.cols).map((c) => String(c))
          : options.columnOrder ?? ['col-a', 'col-b', 'col-c'],
      ...(options.seedRows !== undefined ? { seedRows: options.seedRows } : {}),
      ...(options.persistenceDir !== undefined ? { persistenceDir: options.persistenceDir } : {}),
      ...(options.oplog !== undefined ? { oplog: options.oplog } : {}),
      ...(options.snapshotStore !== undefined ? { snapshotStore: options.snapshotStore } : {}),
      ...(options.initialDocument !== undefined ? { initialDocument: options.initialDocument } : {}),
      ...(options.restoreFrom !== undefined ? { restoreFrom: options.restoreFrom } : {}),
      ...(datasetConfig !== undefined ? { dataset: datasetConfig } : {}),
    };
    validateDocumentSpec(spec, '');
    // 単一文書構成の復旧失敗は**従来どおり起動失敗**（検疫しない）。1 枚しか無い構成で 0 文書 listen を始めると
    // consumer は起動成功と誤認して全接続が 404 になる。後方互換（DD-043 AC2）も兼ねる。
    runtimes.set(documentId, await createDocumentRuntime(spec, runtimeDeps));
    defaultDocumentId = documentId;
  }

  /** `?documentId=` から文書を引く（未指定=既定文書）。未知・検疫済みは undefined＝拒否。 */
  const lookupRuntime = (documentId: string | undefined): DocumentRuntime | undefined =>
    runtimes.get(documentId ?? defaultDocumentId);
  /** in-process API 用（未知は throw）。 */
  const requireRuntime = (documentId?: string): DocumentRuntime => {
    const runtime = lookupRuntime(documentId);
    if (runtime === undefined) {
      throw new Error(
        `serve: documentId '${documentId ?? defaultDocumentId}' は serve していません（未知 ID・または起動時の検疫で除外・DD-043）`,
      );
    }
    return runtime;
  };

  const demoHtml = loadDemoHtml();
  const app = new Hono();
  // dev サーバー: playground 統合ページは別オリジン（Vite dev の別ポート）から /config・/snapshot を fetch するため
  // CORS を許可する（開発用途のみ。DD-005 Phase 2 headed smoke でクロスオリジン fetch のブロックが判明し追加）。
  app.use('*', cors());
  app.get('/', (c) => c.html(demoHtml));
  // 死活監視の口。複数文書でも本文は 'ok' 固定（プローブ側の破壊的変更を作らない）。検疫の可視化は診断 hook と
  // 当該文書への /config・/ws が 404 になることで行う（DD-043 論点③）。
  app.get('/health', (c) => c.text('ok'));
  // columnOrder はブラウザークライアント（playground 統合ページ）が ClientSession を同一列順で構築するために配る。
  // DD-043 D2: `?documentId=` で文書を指定できる（無指定は既定文書）。未知 ID は 404。
  app.get('/config', (c) => {
    const requested = requestedDocumentId(c.req.url);
    const runtime = lookupRuntime(requested);
    if (runtime === undefined) {
      const missing = requested ?? defaultDocumentId;
      diagnostics?.('warn', 'document-unknown', `/config: serve していない documentId '${missing}'（404）`);
      return c.json({ error: 'unknown-document', documentId: missing }, 404);
    }
    return c.json({ documentId: runtime.documentId, heartbeatMillis, columnOrder: runtime.columnOrder });
  });
  app.get('/snapshot', (c) => {
    const requested = requestedDocumentId(c.req.url);
    const runtime = lookupRuntime(requested);
    if (runtime === undefined) {
      const missing = requested ?? defaultDocumentId;
      return c.json({ error: 'unknown-document', documentId: missing }, 404);
    }
    return c.json(runtime.snapshot());
  });

  let listening: { server: NodeServer; boundPort: number };
  try {
    listening = await new Promise<{ server: NodeServer; boundPort: number }>((resolve, reject) => {
      const created = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
        resolve({ server: created, boundPort: info.port });
      });
      created.once('error', reject); // listen 失敗（ポート使用中等）は reject
    });
  } catch (error) {
    await closeRuntimes(runtimes); // listen 前に構築済みの文書ハンドルを残さない
    throw error;
  }
  const { server, boundPort } = listening;
  server.on('error', (error: Error) => {
    console.error(`collaboration-server: runtime error: ${error.message}`);
  });

  if (!(server instanceof HttpServer)) {
    await closeServer(server, undefined, undefined, runtimes);
    throw new Error('collaboration-server: expected a Node http.Server for WebSocket upgrade');
  }

  const wss = new WebSocketServer({ noServer: true });
  const authenticate = options.authenticate;
  // 認証待ち（await 中）の raw socket。wss にも RoomBridge にも未登録のため、stop() で明示 destroy しないと server.close が
  // 待ち続ける（hook が settle しない＋peer が接続を保つ場合・Codex P2）。
  const pendingAuthSockets = new Set<Duplex>();
  /**
   * upgrade を受理する。DD-043 D2: `?documentId=` で宛先文書を決め（無指定は既定文書）、serve していない ID は 404 で拒否する。
   * 評価順序は authenticate →文書解決（未認証の相手へ文書集合の存在を漏らさない。文書単位の認可は hook が url から行える）。
   */
  const acceptUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, identity: ServeIdentity | undefined): void => {
    const requested = requestedDocumentId(req.url);
    const runtime = lookupRuntime(requested);
    if (runtime === undefined) {
      const missing = requested ?? defaultDocumentId;
      diagnostics?.('warn', 'document-unknown', `websocket upgrade rejected (404): serve していない documentId '${missing}'`);
      socket.on('error', () => {}); // 応答書き込み中の error を listener 無しで放置しない（uncaught 化を防ぐ）
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    // 文書を明示した接続・複数文書構成の接続は、join の申告 documentId 不一致を切断する（他文書の envelope を混ぜない）。
    // 判定に runtimes.size を使わないのは、検疫で 1 文書に減った複数文書構成が緩くなるのを避けるため。
    const strictDocument = requested !== undefined || multiDocument;
    wss.handleUpgrade(req, socket, head, (ws) => {
      runtime.bridge.onConnect(ws, identity, strictDocument);
    });
  };
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (authenticate === undefined) {
      acceptUpgrade(req, socket, head, undefined);
      return;
    }
    // DD-026-2: 認証（非同期）を待つ間、raw socket の error を listener 無しで放置しない（uncaught 化でプロセスを落とさない）。
    // ws は handleUpgrade 以降しか listener を持たないため、この層で受ける。受理時は ws の listener に引き継ぐ（拒否時は
    // 応答を書いて destroy するまで本 listener を残す）。
    const onSocketError = (): void => {};
    socket.on('error', onSocketError);
    pendingAuthSockets.add(socket);
    void runAuthenticate(authenticate, req)
      .then((identity) => {
        pendingAuthSockets.delete(socket);
        if (socket.destroyed) {
          return; // await 中に peer が切断 or stop() が破棄済み
        }
        if (identity === null) {
          diagnostics?.('warn', 'auth-rejected', 'websocket upgrade rejected (401): authenticate returned null');
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        socket.off('error', onSocketError);
        acceptUpgrade(req, socket, head, identity);
      })
      .catch((error: unknown) => {
        pendingAuthSockets.delete(socket);
        // hook の失敗は通さない（500 で拒否）。hook の error message は Cookie/トークン/DB 資格情報を含み得るため診断へ載せず、
        // 種別（Error.name）だけを出す（Codex P2）。詳細は hook 側で記録する。onDiagnostic 未指定時も黙らせない（P08）。
        const kind = error instanceof Error ? error.name : typeof error;
        const summary = `websocket upgrade rejected (500): authenticate threw ${kind}（詳細は hook 側で記録すること）`;
        if (diagnostics !== undefined) {
          diagnostics('error', 'auth-error', summary);
        } else {
          console.error(`collaboration-server: ${summary}`);
        }
        if (!socket.destroyed) {
          rejectUpgrade(socket, 500, 'Internal Server Error');
        }
      });
  });

  const sweepTimer = setInterval(() => {
    for (const runtime of runtimes.values()) {
      runtime.bridge.sweep();
    }
  }, sweepMillis);

  let closed = false;
  /** サーバー起点 SetCells（DD-026-3）。DD-043: `documentId` 未指定は既定文書、serve していない ID は reject。 */
  const submit = (operation: ServeSetCellsInput, actorId: string, documentId?: string): Promise<ServeSubmitResult> => {
    if (closed) {
      return Promise.reject(new Error('submit: server stopped'));
    }
    let runtime: DocumentRuntime;
    try {
      runtime = requireRuntime(documentId);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return runtime.submit(operation, actorId);
  };

  const url = `http://${host}:${boundPort}`;
  return {
    port: boundPort,
    url,
    documentId: defaultDocumentId,
    documentIds: [...runtimes.keys()],
    quarantined,
    hash: (documentId) => requireRuntime(documentId).hash(),
    snapshot: (documentId) => requireRuntime(documentId).snapshot(),
    connectionCount: (documentId) =>
      documentId === undefined
        ? [...runtimes.values()].reduce((sum, runtime) => sum + runtime.bridge.connectionCount(), 0)
        : requireRuntime(documentId).bridge.connectionCount(),
    recovery: runtimes.get(defaultDocumentId)?.recovery,
    submit,
    close: () => {
      closed = true;
      return closeServer(server, wss, sweepTimer, runtimes, pendingAuthSockets);
    },
  };
}

/**
 * 文書構成から `columnOrder` 以外を取り出し、`undefined` の値を持つキーを落とす（DD-043）。
 * spread で `{ seedRows: undefined }` を作ると「明示指定あり」と誤判定され、initialDocument との排他検証が誤爆する。
 */
function omitUndefined(config: StartDocumentConfig): Omit<StartDocumentConfig, 'columnOrder'> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key !== 'columnOrder' && value !== undefined) {
      out[key] = value;
    }
  }
  return out as Omit<StartDocumentConfig, 'columnOrder'>;
}

/** 認証フックを実行し結果を検証する（DD-026-2）。不正な戻り値（actorId 空など）は throw＝500 で拒否（通さない）。 */
async function runAuthenticate(authenticate: ServeAuthenticate, req: IncomingMessage): Promise<ServeIdentity | null> {
  const identity = await authenticate({ url: req.url ?? '/', headers: req.headers });
  if (identity === null) {
    return null;
  }
  if (typeof identity.actorId !== 'string' || identity.actorId.length === 0 || typeof identity.displayName !== 'string') {
    throw new Error('authenticate は { actorId: 非空 string, displayName: string } か null を返す必要があります');
  }
  return { actorId: identity.actorId, displayName: identity.displayName };
}

/**
 * upgrade を HTTP ステータスで拒否して socket を閉じる（ws の abortHandshake 相当・DD-026-2）。
 * 応答を flush してから destroy する（write 直後の destroy はユーザー空間バッファを捨て、client が 401 を読めないことがある）。
 */
function rejectUpgrade(socket: Duplex, statusCode: number, reason: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.once('finish', () => {
    socket.destroy();
  });
  socket.end(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** integrationDataset オプションを具体設定へ正規化する（undefined/false=無効・true=既定規模・object=既定へマージ）。 */
function resolveDataset(
  option: IntegrationDatasetConfig | boolean | undefined,
): IntegrationDatasetConfig | undefined {
  if (option === undefined || option === false) {
    return undefined;
  }
  if (option === true) {
    return DEFAULT_INTEGRATION_DATASET;
  }
  return { ...DEFAULT_INTEGRATION_DATASET, ...option };
}

/** 初期グリッド（row-1..row-N）を単一 InsertRows で投入する（デモの見える行）。 */
function seedInitialRows(sequencer: Sequencer, documentId: string, count: number): void {
  if (count <= 0) {
    return;
  }
  const rows: Array<{ rowId: RowId }> = [];
  for (let i = 1; i <= count; i += 1) {
    rows.push({ rowId: createRowId(`row-${i}`) });
  }
  const envelope: ClientOperationEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    documentId: createDocumentId(documentId),
    operationId: createOperationId('seed-rows'),
    transactionId: createTransactionId('tx-seed-rows'),
    actorId: 'system',
    clientId: 'system',
    clientSequence: 1,
    baseRevision: 0,
    operation: { type: 'insertRows', afterRowId: null, rows },
  };
  sequencer.submit(envelope);
}

function loadDemoHtml(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // .../src
  return readFileSync(join(here, '..', 'public', 'demo.html'), 'utf8');
}

async function closeServer(
  server: NodeServer,
  wss: WebSocketServer | undefined,
  sweepTimer: ReturnType<typeof setInterval> | undefined,
  runtimes?: Map<string, DocumentRuntime>,
  pendingAuthSockets?: Set<Duplex>,
): Promise<void> {
  if (sweepTimer !== undefined) {
    clearInterval(sweepTimer);
  }
  if (runtimes !== undefined) {
    await closeRuntimes(runtimes); // 各文書の保留中 durable 書込を確定して oplog/snapshot ハンドルを閉じる
  }
  if (pendingAuthSockets !== undefined) {
    for (const socket of pendingAuthSockets) {
      socket.destroy(); // 認証待ちの raw socket は wss 管理外＝明示破棄しないと server.close が待ち続ける（Codex P2）
    }
    pendingAuthSockets.clear();
  }
  if (wss !== undefined) {
    for (const client of wss.clients) {
      client.terminate(); // ソケットを強制解放しリーク無しでプロセスが自然終了できるように
    }
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined && error !== null) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `tsx src/server.ts`（dev script）で直接起動されたときだけ待受を開始する（import 時は起動しない＝smoke が import 可能）。 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

/** env の数値（未指定・不正は undefined）。E2E 起動用のシード規模調整に使う（DD-005 Phase 4）。 */
function numEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * `--integration` 起動時のシード規模を決める（DD-005 Phase 4・E2E 起動用の最小追加）。
 * env（SEED_ROWS / SEED_COLS / SEED_NONEMPTY）が無ければ既定規模（true＝50,000行×200列×非空100,000）。
 * E2E は行数（50,000）を保ったまま非空セル数だけ絞って初期 replay を軽くする（挙動・公開API は不変）。
 */
function integrationDatasetFromEnv(): IntegrationDatasetConfig | boolean {
  const rows = numEnv('SEED_ROWS');
  const cols = numEnv('SEED_COLS');
  const nonEmpty = numEnv('SEED_NONEMPTY');
  if (rows === undefined && cols === undefined && nonEmpty === undefined) {
    return true; // 既定規模（dev:integration の通常起動）
  }
  return {
    ...DEFAULT_INTEGRATION_DATASET,
    ...(rows !== undefined ? { rows } : {}),
    ...(cols !== undefined ? { cols } : {}),
    ...(nonEmpty !== undefined ? { nonEmpty } : {}),
  };
}

if (isMainModule()) {
  const envPort = process.env.PORT;
  const port = envPort === undefined ? DEFAULT_PORT : Number(envPort);
  // DD-005 統合PoC のシード投入は `--integration` フラグ or `SEED_DATASET=integration` で有効化する。
  const integrationEnabled =
    process.argv.includes('--integration') || process.env.SEED_DATASET === 'integration';
  const integrationDataset = integrationEnabled ? integrationDatasetFromEnv() : false;
  // DD-014: PERSISTENCE_DIR 指定でファイル永続化（oplog＋snapshot）を有効化する（再起動で復旧）。
  const persistenceDir = process.env.PERSISTENCE_DIR;
  const snapshotIntervalOps = numEnv('SNAPSHOT_INTERVAL_OPS');
  startServer({ port, integrationDataset, persistenceDir, snapshotIntervalOps })
    .then((running) => {
      process.stdout.write(
        `collaboration-server listening on ${running.url} (documentId=${running.documentId})\n`,
      );
      if (running.recovery !== undefined) {
        process.stdout.write(
          `DD-014 persistence: recovered from ${persistenceDir ?? ''} (snapshot=${String(running.recovery.fromSnapshotRevision)} totalOps=${running.recovery.totalOps} tailReplayed=${running.recovery.tailReplayed} tornDiscarded=${running.recovery.discardedTornRecords})\n`,
        );
      }
      if (integrationEnabled) {
        process.stdout.write(
          `DD-005 integration dataset seeded (rows/cols/nonEmpty overridable via SEED_ROWS/SEED_COLS/SEED_NONEMPTY). WS: ws://${running.url.replace(/^https?:\/\//, '')}/ws\n`,
        );
      } else {
        process.stdout.write(
          `open two tabs with different names, e.g. ${running.url}/?name=Alice and ${running.url}/?name=Bob\n`,
        );
      }
      const shutdown = (): void => {
        void running.close().then(() => {
          process.exit(0);
        });
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((error: unknown) => {
      process.stderr.write(`collaboration-server failed to start: ${errorMessage(error)}\n`);
      process.exit(1);
    });
}
