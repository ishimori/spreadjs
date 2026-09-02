// ヘッドレスクライアントセッション（楽観適用＋§7.7 rollback/replay）。committed（サーバー確定・権威）と
// pending（未 ACK のローカル楽観 Operation）の二層を持ち、server op 到着で rollback/replay により収束させる。
//
// 依存ゼロ・トランスポート注入: 非相対 import は @nanairo-sheet/core / @nanairo-sheet/types のみ
// （Phase 1 で collab へ昇格しやすく）。時刻・ID・トランスポートは全注入（Date.now/Math.random/
// crypto/DOM/Node 非参照）。判定は core の validateOperation を共有（サーバーとの乖離を構造的に防ぐ・指示 1）。

import {
  CATCHUP_SNAPSHOT_THRESHOLD,
  applyOperation,
  cloneCellScalar,
  cloneDocument,
  createDocument,
  deleteCell,
  deleteRowCells,
  deserializeDocument,
  documentHash,
  setCell,
  validateOperation,
} from '@nanairo-sheet/core';
import type {
  BootstrapMessage,
  CellAddressById,
  ChangeSet,
  ClientMessage,
  ClientOperationEnvelope,
  DocumentOperation,
  InverseSeed,
  OperationAckMessage,
  OperationRejectedMessage,
  OperationViolation,
  OperationsMessage,
  PresenceDeltaMessage,
  PresencePayload,
  PresenceRemovedMessage,
  PresenceSnapshotMessage,
  ReconcileInfo,
  RejectCode,
  RejectDetails,
  SelectionById,
  ServerMessage,
  ServerOperationEnvelope,
  SetCellsOperation,
  SheetDocument,
  UserPresence,
  WelcomeMessage,
} from '@nanairo-sheet/core';
import { createOperationId, createTransactionId } from '@nanairo-sheet/types';
import type { ColumnId, DocumentId, OperationId, RowId } from '@nanairo-sheet/types';

import type { Clock, IdGenerator } from './deps';

// ---- トランスポート IF（送受信・接続イベント）----

/** ClientSession が実装するトランスポートリスナー。トランスポートがサーバーメッセージ・接続イベントを push する。 */
export interface TransportListener {
  handleServerMessage(message: ServerMessage): void;
  handleConnected(): void; // 初回接続・再接続で発火 → join 送信
  handleDisconnected(): void; // 切断 → offline へ
}

/** クライアントトランスポート（in-process / 実 WS が実装）。session が注入で受け取る。 */
export interface ClientTransport {
  setListener(listener: TransportListener): void;
  connect(): void; // 接続確立 → listener.handleConnected()
  send(message: ClientMessage): void; // 送信（フォールトで drop/duplicate/delay され得る）
}

// ---- イベント通知契約（DD-015 要確認③・§6「pending・rejected 状態のイベント通知」）----

/**
 * 接続状態（consumer 表示用・DD-015）。
 * - `online`: トランスポート接続確立中（同期中を含む）。
 * - `offline`: 切断中（トランスポートは指数バックオフで再接続を試行中＝リトライ継続）。
 * - `stopped`: offline 上限（maxOfflineMillis/maxOfflinePending）超過で **編集停止**（接続リトライは継続するが submit は不可）。
 */
export type ConnectionState = 'online' | 'offline' | 'stopped';

/**
 * ClientSession が発火するイベント（接続状態・pending 件数・reject 発生）。consumer（playground/DD-016 Facade）が購読し
 * 接続状態・未送信件数・競合を可視化する（§6 保証項目「可視化またはイベント通知」の"イベント通知"側を正とする）。
 * pending/connection は値が変化したときのみ発火（冗長発火なし）。rejected は Conflict Queue 追加ごとに発火。
 */
export type SessionEvent =
  | { type: 'connection'; state: ConnectionState; pendingCount: number }
  | { type: 'pending'; pendingCount: number }
  | { type: 'rejected'; entry: ConflictQueueEntry; pendingCount: number }
  // revision 連続性 fail-fast（DD-015・fault matrix C11）: server frontier が client committed 未満＝分岐した歴史。
  // 黙って merge せず通知＋編集停止する（データ整合の破壊を防ぐ）。
  | { type: 'divergence'; serverRevision: number; committedRevision: number };

export type SessionObserver = (event: SessionEvent) => void;

// ---- Conflict Queue（コピー可能・§10.1・I-2）----

export type ConflictReason = 'rejected' | 'revalidation-failed' | 'dependency';

export interface ConflictQueueEntry {
  operationId: OperationId;
  operation: DocumentOperation; // 元のローカル Operation（深いコピー＝「自分の値」を保全）
  clientSequence: number;
  baseRevision: number;
  reason: ConflictReason;
  code?: RejectCode; // reason==='rejected'（server 判定）
  violations?: OperationViolation[]; // reason==='revalidation-failed' or server details.violations
  details?: RejectDetails; // server reject の現在値/現在revision（解決 UI 材料・PoC-A/Phase 4）
}

// ---- pending エントリー ----

interface PendingEntry {
  envelope: ClientOperationEnvelope; // operationId/clientSequence/baseRevision 不変（再送キー）
  inverseSeed: InverseSeed; // 楽観適用時の逆操作データ（rebuildView で毎回再計算）
  acknowledged: boolean; // operationAck 受信済み（再送対象から外す）
  ackRevision: number | undefined; // ACK が示す確定 revision（bootstrap filter が「効果が committed@R に入ったか」を判定・Codex P1-d）
  localNoop: boolean; // 楽観適用が空 changeSet（operations エコー無し → ACK で除去）
}

/** sendPresence が受け取る 3 種フィールド（userId/displayName は session が充填）。 */
export interface PresenceUpdate {
  activeCell?: CellAddressById;
  selectionRanges: SelectionById[];
  editingCell?: CellAddressById;
}

export interface SessionConfig {
  clientId: string;
  userId: string;
  displayName: string;
  documentId: DocumentId;
  columnOrder: ColumnId[];
  transport: ClientTransport;
  clock: Clock;
  idGenerator: IdGenerator;
  protocolVersion?: number; // 既定 1
  resendTimeoutMillis?: number; // 既定 5000（再送タイマー）
  catchupPollMillis?: number; // 既定 resendTimeoutMillis（周期 catch-up ポーリング間隔・tail 欠落回復）
  maxOfflineMillis?: number; // 既定 30000（§8.5・Q-4）
  maxOfflinePending?: number; // 既定 100（§8.5・Q-4）
  observer?: SessionObserver; // DD-015: 接続状態・pending 件数・reject 発生の通知（未指定なら通知しない）
}

const DEFAULT_PROTOCOL_VERSION = 1;
const DEFAULT_RESEND_TIMEOUT = 5_000;
const DEFAULT_MAX_OFFLINE_MILLIS = 30_000; // §8.5 暫定
const DEFAULT_MAX_OFFLINE_PENDING = 100; // §8.5 暫定

export class ClientSession implements TransportListener {
  private readonly clientId: string;
  private readonly userId: string;
  private readonly displayName: string;
  private readonly documentId: DocumentId;
  private readonly protocolVersion: number;
  private readonly resendTimeoutMillis: number;
  private readonly catchupPollMillis: number;
  private readonly maxOfflineMillis: number;
  private readonly maxOfflinePending: number;
  private readonly transport: ClientTransport;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly observer: SessionObserver | undefined;

  private committed: SheetDocument;
  private view: SheetDocument;
  private pending: PendingEntry[] = [];
  private readonly conflicts: ConflictQueueEntry[] = [];
  private expectedRevision: number; // = committed.revision + 1
  private readonly revisionBuffer = new Map<number, ServerOperationEnvelope>();
  private lastCatchupRequestedRevision: number | undefined = undefined;
  private readonly knownPresence = new Map<string, UserPresence>();

  private _connectionId: string | undefined = undefined;
  private _colorKey: string | undefined = undefined;
  private online = false;
  private hasConnected = false; // 一度でも接続確立したか（初回接続前は offline 時間上限を適用しない・offlineSince 未確定）
  private offlineSince = 0;
  private stopped = false;
  private lastClientSequence = 0;
  private presenceSequence = 0;
  private lastPresence: PresenceUpdate | undefined = undefined;
  private lastSendAt = 0;
  private lastPollAt = 0;
  private awaitingSync = false;
  private awaitingBootstrap = false; // fresh join（committed.revision=0）で snapshot bootstrap を待つ（P1-6/P1-7）
  private reconcileInfo: ReconcileInfo | undefined = undefined; // 再接続 reconcile（committed が権威化してから適用＝Codex P1-2）
  private welcomeSeen = false; // この接続で welcome を受信済み（reorder で bootstrap 先着時に buffer するか判定・Codex P1-c）
  private bufferedBootstrap: BootstrapMessage | undefined = undefined; // welcome より先着した bootstrap（reconcile 情報を待って処理・P1-c）
  private knownServerRevision: number | undefined = undefined;
  private _appliedServerOpCount = 0; // committed へ適用したサーバー op 総数（AC1/AC8 の「全 replay 非依存」計測用）
  private _bootstrapRevision: number | undefined = undefined; // snapshot bootstrap で確立した committed revision
  private lastConnectionState: ConnectionState | undefined = undefined; // 直近発火した接続状態（冗長発火抑止）
  private lastEmittedPendingCount = 0; // 直近発火した pending 件数（冗長発火抑止）

  constructor(config: SessionConfig) {
    this.clientId = config.clientId;
    this.userId = config.userId;
    this.displayName = config.displayName;
    this.documentId = config.documentId;
    this.protocolVersion = config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.resendTimeoutMillis = config.resendTimeoutMillis ?? DEFAULT_RESEND_TIMEOUT;
    this.catchupPollMillis = config.catchupPollMillis ?? this.resendTimeoutMillis;
    this.maxOfflineMillis = config.maxOfflineMillis ?? DEFAULT_MAX_OFFLINE_MILLIS;
    this.maxOfflinePending = config.maxOfflinePending ?? DEFAULT_MAX_OFFLINE_PENDING;
    this.transport = config.transport;
    this.clock = config.clock;
    this.idGenerator = config.idGenerator;
    this.observer = config.observer;
    this.committed = createDocument(config.columnOrder);
    this.view = this.committed;
    this.expectedRevision = this.committed.revision + 1;
    this.transport.setListener(this);
  }

  /** 接続を開始する（transport.connect → handleConnected → join 送信）。 */
  start(): void {
    this.transport.connect();
  }

  // ---- ローカル操作 ----

  /** ローカル Operation を楽観適用し送信する（未 ACK は pending に保持）。stopped 時は throw。 */
  submitLocalOperation(operation: DocumentOperation): OperationId {
    if (this.stopped) {
      throw new Error('ClientSession: stopped (reconnect window exceeded); editing disabled');
    }
    const operationId = createOperationId(this.idGenerator.next());
    this.lastClientSequence += 1;
    const envelope: ClientOperationEnvelope = {
      protocolVersion: this.protocolVersion,
      documentId: this.documentId,
      operationId,
      transactionId: createTransactionId(`tx-${operationId}`),
      actorId: this.userId,
      clientId: this.clientId,
      clientSequence: this.lastClientSequence,
      baseRevision: this.committed.revision,
      operation,
    };
    this.pending.push({ envelope, inverseSeed: emptyInverseSeed(), acknowledged: false, ackRevision: undefined, localNoop: false });
    this.rebuildView(); // 楽観適用（無効なら Conflict Queue へ）
    if (this.online && !this.stopped) {
      this.sendSubmit(envelope);
    }
    this.checkOfflineLimits();
    this.emitPendingIfChanged(); // 未送信 backlog の増加を通知
    return operationId;
  }

  /** Presence を送る（connection 単位・単調 sequence。userId/displayName を充填）。 */
  sendPresence(presence: PresenceUpdate): void {
    this.lastPresence = presence;
    this.presenceSequence += 1;
    const payload: PresencePayload = {
      userId: this.userId,
      displayName: this.displayName,
      activeCell: presence.activeCell,
      selectionRanges: presence.selectionRanges,
      editingCell: presence.editingCell,
    };
    this.transport.send({ type: 'presence', sequence: this.presenceSequence, payload });
  }

  /** heartbeat を送る（生存通知・注入クロックの sentAt）。 */
  sendHeartbeat(): void {
    this.transport.send({ type: 'heartbeat', sentAt: this.clock.now() });
  }

  /** 注入クロック駆動のタイマー処理（再送タイマー満了・offline 上限・欠落 catch-up の再要求）。app 層が周期呼び出しする。 */
  tick(): void {
    this.checkOfflineLimits();
    if (!this.online || this.stopped) {
      return;
    }
    const now = this.clock.now();
    if (this.hasUnackedPending() && now - this.lastSendAt >= this.resendTimeoutMillis) {
      this.resendAllPending();
    }
    // 周期的 catch-up ポーリング（DA D26: 検知できない tail 欠落・未知のサーバー前進を回復する）。
    // 受信済み revision より先を1件も受け取れず（buffer 空・後続 op も欠落）gap 検知が起きない静止系でも、
    // requestCatchup{afterRevision: expectedRevision-1} を周期送信すればサーバーが差分を返し収束する
    // （requestCatchup は既存プロトコル・afterRevision=expectedRevision-1 で全 catch-up ケースを包含）。
    // bootstrap 待ち（fresh join / 差分>閾値）中は catch-up を発行しない（P1-6/P1-7）: bootstrap は welcome と同梱で順序保証・
    // 信頼性のある transport（TCP）が確実に配送し、hub でも非 drop ゆえ「接続 open 中に bootstrap フレームだけ喪失」は到達不能。
    // requestCatchup を出すと全 operationLog の tail replay に退行し、かつ reconcile 無しの二重取得になる（Codex 第3回 P1-a）。
    if (this.awaitingBootstrap) {
      return;
    }
    if (now - this.lastPollAt >= this.catchupPollMillis) {
      this.lastPollAt = now;
      this.requestCatchup();
    }
  }

  // ---- TransportListener ----

  handleConnected(): void {
    this.online = true;
    this.hasConnected = true; // 以降の切断は「再接続ウィンドウ」＝offline 時間上限の対象になる
    this.awaitingSync = true;
    this.knownServerRevision = undefined;
    this.reconcileInfo = undefined; // 前接続の未適用 reconcile は破棄（この join の welcome.reconcile を正とする）
    this.welcomeSeen = false; // この接続の welcome をまだ受けていない（bootstrap 先着なら buffer・P1-c）
    this.bufferedBootstrap = undefined;
    this.sendJoin();
    this.emitConnection(); // online へ遷移（stopped 中は stopped が優先＝emitConnection が判定）
  }

  handleDisconnected(): void {
    // offlineSince は online→offline **遷移時のみ**設定する（Codex 第3回 P1-d）: 長時間 outage で再接続試行が失敗するたび
    // handleDisconnected が再発火する（既に offline）。毎回 reset すると offline 時間上限が永久に到達せず、低頻度編集が
    // 設定 window を超えて続けられる。初回切断時刻を保持し、経過を正しく測る。
    if (this.online) {
      this.offlineSince = this.clock.now();
    }
    this.online = false;
    this.emitConnection(); // offline へ遷移（トランスポートは指数バックオフで再接続を試行中）
  }

  handleServerMessage(message: ServerMessage): void {
    // 同期処理単位＝1 ServerMessage（rollback/replay 中に別受信が割り込まない・DA）。
    switch (message.type) {
      case 'welcome':
        this.handleWelcome(message);
        break;
      case 'bootstrap':
        this.handleBootstrap(message);
        break;
      case 'operations':
        this.handleOperations(message);
        break;
      case 'operationAck':
        this.handleAck(message);
        break;
      case 'operationRejected':
        this.handleRejected(message);
        break;
      case 'presenceSnapshot':
        this.handlePresenceSnapshot(message);
        break;
      case 'presenceDelta':
        this.handlePresenceDelta(message);
        break;
      case 'presenceRemoved':
        this.handlePresenceRemoved(message);
        break;
      case 'heartbeatAck':
        break; // PoC: 記録なし
    }
    // 1 ServerMessage 処理で pending 件数が変わり得る（ACK 除去・reconcile・rebuild）→ 変化時のみ通知（rejected は pushConflict で個別発火）。
    this.emitPendingIfChanged();
  }

  // ---- 受信処理 ----

  private handleWelcome(message: WelcomeMessage): void {
    this._connectionId = message.sessionId;
    this._colorKey = message.colorKey; // 自色（welcome 拡張・指示 3）
    // revision 連続性 fail-fast（DD-015・C11）: server が「client が権威 frontier より先」を検出＝巻き戻った（分岐した歴史）。
    // 判定は server 側（frontier 権威・応答順序入れ替えに非依存）。client committed<currentRevision の単純比較は in-process
    // reorder で stale welcome を誤検出するため使わない（server の diverged シグナルを正とする）。永続化下では通常起きない防御。
    if (message.diverged === true) {
      this.handleDivergence(message.currentRevision);
      return;
    }
    // この welcome が最新か（reorder で古い welcome が後着し得る・Codex P2）: currentRevision が既知 high-water 以上なら最新。
    // 古い welcome の reconcile を新しい join の分類として使わないため、reconcileInfo は最新 welcome の分だけ採用する。
    const isNewest = this.knownServerRevision === undefined || message.currentRevision >= this.knownServerRevision;
    this.welcomeSeen = true;
    // stale welcome（reorder で currentRevision が既適用 committed 未満）は knownServerRevision を**下げない**
    // （後続の ACK/operations が high-water を保つ・needsCatchup/maybeFinalizeSync の誤判定を避ける）。
    if (this.knownServerRevision === undefined || message.currentRevision > this.knownServerRevision) {
      this.knownServerRevision = message.currentRevision;
    }
    // 再接続 reconcile（DD-015・exactly-once・C2〜C4）を**保留**する（Codex P1-2）: ここで即適用すると受理済み依存元 op A を
    // 除去→committed が A を含む前に rebuild するため、A に依存する未処理 pending B が unknown-row で誤 Conflict 化する。
    // committed が権威化した後（bootstrap 受信直後 or tail drain 完了時）に applyReconcile で適用する。最新 welcome のみ採用（P2）。
    if (message.reconcile !== undefined && isNewest) {
      this.reconcileInfo = message.reconcile;
    }
    // reorder で bootstrap が welcome より先着していたら、reconcile 情報が揃った今処理する（Codex P1-c）。
    if (this.bufferedBootstrap !== undefined) {
      const buffered = this.bufferedBootstrap;
      this.bufferedBootstrap = undefined;
      this.awaitingBootstrap = false;
      this.handleBootstrap(buffered);
      return;
    }
    // bootstrap 判定（要確認②・server と対称）: fresh（committed=0）or 差分>閾値 は server が bootstrap を送るので待つ。
    // ここで catch-up を発行すると server が全 operationLog を返す＝全 replay 経路に戻るため、bootstrap 到着まで抑止（P1-6/P1-7）。
    const missedCount = message.currentRevision - this.committed.revision;
    const willReceiveBootstrap =
      message.currentRevision > 0 &&
      (this.committed.revision <= 0 || missedCount > CATCHUP_SNAPSHOT_THRESHOLD);
    if (willReceiveBootstrap) {
      this.awaitingBootstrap = true;
      return;
    }
    this.awaitingBootstrap = false;
    // 既知サーバー revision（currentRevision）に committed が未達なら差分を要求する
    // （初期/再接続の operations 配信が欠落しても welcome が到達すれば回復できる）。
    if (this.needsCatchup()) {
      this.requestCatchup();
    }
    this.maybeFinalizeSync();
  }

  /**
   * 保留中の再接続 reconcile（DD-015・exactly-once）を適用する。**呼び出し前に committed が権威化している**こと
   * （bootstrap 受信直後 or tail drain 完了時）が前提（Codex P1-2）。server の突合せ結果で未ACK pending を 3 分類する（C2〜C4）:
   * - **受理済（opId ∈ accepted）**: 効果は committed に含まれる（tail は echo でも除去済み）→ pending から除去。
   * - **reject 済（opId ∉ accepted かつ clientSequence≦acked）**: server は seq 消費済みで reject 通知が切断で喪失 →
   *   Conflict Queue（サイレント喪失0・再送しない＝client-sequence-violation ループ回避）。
   * - **未処理（clientSequence>acked）**: server 初見（transit 消失 or offline 追加）→ 保持して再送。
   * acknowledged 済み pending は別経路（echo）で処理するため保持。partition のみ行い **view の再構築は呼び出し側**が行う
   * （committed が権威化した状態で rebuild すれば受理済み依存元を含むため未処理依存 op が誤 Conflict 化しない）。
   */
  private applyReconcile(): void {
    const info = this.reconcileInfo;
    if (info === undefined) {
      return;
    }
    this.reconcileInfo = undefined; // 一度だけ適用
    const acceptedSet = new Set(info.acceptedOperationIds.map((id) => String(id)));
    const inFlightSet = new Set((info.inFlightOperationIds ?? []).map((id) => String(id)));
    const survived: PendingEntry[] = [];
    const rejectedEntries: PendingEntry[] = [];
    for (const entry of this.pending) {
      if (entry.acknowledged) {
        survived.push(entry);
        continue;
      }
      const opIdStr = String(entry.envelope.operationId);
      if (acceptedSet.has(opIdStr)) {
        continue; // durable-accepted（or noop）→ 除去（committed に反映済み・二重適用0）
      }
      if (inFlightSet.has(opIdStr)) {
        survived.push(entry); // pre-fsync accepted（未 durable）→ **保持**（除去も reject もしない・再送で dedup・Codex 第3回 P1-b）
        continue;
      }
      if (entry.envelope.clientSequence <= info.ackedClientSequence) {
        rejectedEntries.push(entry); // reject 済（通知喪失・ackCache 不在 かつ seq 消費済み）
        continue;
      }
      survived.push(entry); // 未処理 → 保持して再送
    }
    this.pending = survived;
    // reject 済み（通知喪失）op を Conflict Queue へ（元 operation 保持＝サイレント喪失0）。pending は survived へ更新済み
    // ゆえ pushConflict のイベントは正しい件数を報告する（Codex P2-1）。
    for (const entry of rejectedEntries) {
      this.pushConflict(this.makeConflictEntry(entry, 'rejected'));
    }
  }

  /** revision 連続性 fail-fast（DD-015・C11）: server 巻き戻り検出時に編集停止＋divergence 通知（黙って merge しない）。 */
  private handleDivergence(serverRevision: number): void {
    this.stopped = true; // 以降 submit は throw（分岐した歴史へ書き込ませない）
    this.emit({ type: 'divergence', serverRevision, committedRevision: this.committed.revision });
    this.emitConnection(); // stopped へ遷移を通知
  }

  /**
   * snapshot bootstrap（§8 既知制約回収・P1-6/P1-7）: 全 operationLog を replay せず document@revision から committed を確立する。
   * fresh join（committed.revision=0）でのみ前進する。deserialize は core の共有関数（server serialize と wire 一致）。
   * 初期文書（DD-026-1）: server は非空 document@0 への fresh join にも bootstrap@0 を送る。committed 0 かつ未 bootstrap のとき
   * だけ受理して空文書を初期文書へ差し替え、以後の重複 bootstrap@0（再接続）は従来どおり無視する。
   */
  private handleBootstrap(message: BootstrapMessage): void {
    // reorder で welcome より先着した bootstrap は buffer する（Codex P1-c）: reconcile 情報（welcome.reconcile）が無いまま
    // rebuild すると受理済み未ACK op を phantom duplicate-row conflict にして喪失する。welcome 受信時に処理する。
    if (!this.welcomeSeen) {
      this.bufferedBootstrap = message;
      return;
    }
    const acceptsInitialAtZero =
      message.revision === 0 && this.committed.revision === 0 && this._bootstrapRevision === undefined;
    if (message.revision <= this.committed.revision && !acceptsInitialAtZero) {
      this.awaitingBootstrap = false;
      return; // 既に同等以上（reconnect は tail 経路・二重 bootstrap を無視）
    }
    this.committed = deserializeDocument(message.document); // committed.revision = message.document.revision (= R)
    this.expectedRevision = this.committed.revision + 1;
    this._bootstrapRevision = message.revision;
    // R 以下の buffer は committed に取り込み済みゆえ破棄（重複適用防止）。
    for (const revision of [...this.revisionBuffer.keys()]) {
      if (revision < this.expectedRevision) {
        this.revisionBuffer.delete(revision);
      }
    }
    if (this.knownServerRevision === undefined || message.revision > this.knownServerRevision) {
      this.knownServerRevision = message.revision;
    }
    this.awaitingBootstrap = false;
    // reconnect-with-pending 保護（Codex P1）: サーバーが accepted 済みの pending は committed@R に既に含まれる。bootstrap は
    // operation envelope を運ばず own-echo で除去できないため、**効果が committed@R に入った acknowledged pending だけ**を除去する。
    // ackRevision > R（R+1.. の in-flight・echo が buffer 待ち）は保持する（Codex P1-d）: 除去すると依存する未処理 op が
    // committed@R で unknown-row になり誤 Conflict 化する。保持すれば rebuild で optimistic に効果が残り、echo/drain で正規化される。
    this.pending = this.pending.filter(
      (entry) => !(entry.acknowledged && (entry.ackRevision ?? 0) <= this.committed.revision),
    );
    // committed=R が権威化した本時点で reconcile を適用する（Codex P1-2）: 未ACK でも受理済み（acceptedOperationIds）op は
    // committed@R に含まれるため除去し、reject 済は Conflict・未処理と in-flight acked（ackRevision>R）は保持する。
    this.applyReconcile();
    this.rebuildView(); // 残 pending を committed@R へ optimistic 再適用（in-flight acked A も pending に残るため依存 B は valid）
    this.drainBuffer(); // buffer に R+1.. があれば連続適用（A@R+1 echo → own除去＋committed 前進）しつつ maybeFinalizeSync
  }

  private handleOperations(message: OperationsMessage): void {
    for (const envelope of message.operations) {
      if (envelope.revision < this.expectedRevision) {
        continue; // 期待より小さい revision は重複無視（I-3・S-I3）
      }
      this.revisionBuffer.set(envelope.revision, envelope);
    }
    this.drainBuffer();
  }

  private drainBuffer(): void {
    // バッファから nextExpectedRevision を連続適用（欠落で停止・順序を飛ばさない・S-I4）。
    for (;;) {
      const envelope = this.revisionBuffer.get(this.expectedRevision);
      if (envelope === undefined) {
        break;
      }
      this.revisionBuffer.delete(this.expectedRevision);
      this.reconcileServerOperation(envelope);
    }
    if (this.revisionBuffer.size > 0) {
      // gap 残存 → catch-up（gap 位置が変わったときだけ再要求＝重複抑止・S-I4/S-I5）
      if (this.lastCatchupRequestedRevision !== this.expectedRevision) {
        this.lastCatchupRequestedRevision = this.expectedRevision;
        if (this.online) {
          this.transport.send({ type: 'requestCatchup', afterRevision: this.expectedRevision - 1 });
          this.lastSendAt = this.clock.now();
        }
      }
    } else {
      this.lastCatchupRequestedRevision = undefined;
    }
    this.maybeFinalizeSync();
  }

  /** §7.7 rollback/replay: server op を committed へ適用 → own 除去 → 残 pending 再検証・再適用。 */
  private reconcileServerOperation(serverEnv: ServerOperationEnvelope): void {
    // committed は権威（rollback から導出しない・DA D22）。server op は Room 検証済ゆえ throw しない。
    this.committed = applyOperation(this.committed, serverEnv.operation, {
      revision: serverEnv.revision,
    }).document;
    this._appliedServerOpCount += 1; // 適用したサーバー op を計上（bootstrap 後は tail のみ＝全 replay 非依存の実証）
    this.expectedRevision = serverEnv.revision + 1;
    this.removeFromPending(serverEnv.operationId); // own 除去（冪等・operationId 一致・S-H2/H4）
    this.rebuildView(); // 残 pending 再検証＋再適用＋不成立は Conflict Queue（手順4-6）
  }

  private handleAck(message: OperationAckMessage): void {
    // ACK は「この op が revision まで確定した」を示す。committed が未達（operations エコー欠落）でも
    // 既知サーバー revision の下限にして catch-up で回復できるようにする（静止系で echo 欠落しても収束・DA D25）。
    if (this.knownServerRevision === undefined || message.revision > this.knownServerRevision) {
      this.knownServerRevision = message.revision;
    }
    const entry = this.pending.find((e) => e.envelope.operationId === message.operationId);
    if (entry === undefined) {
      return; // echo 先着で除去済み or duplicate ACK → no-op（S-H4）
    }
    entry.acknowledged = true; // 再送抑止
    entry.ackRevision = message.revision; // 確定 revision（bootstrap filter で「効果が committed@R に入ったか」判定・Codex P1-d）
    if (entry.localNoop) {
      // noop は operations エコーが来ない → ACK で pending 除去（S-E3・Q-1）
      this.removeFromPending(message.operationId);
      this.rebuildView();
    }
  }

  private handleRejected(message: OperationRejectedMessage): void {
    if (message.code === 'client-sequence-violation') {
      // server が期待する seq が pending 先頭より**小さい**とき（Codex 第3回 P1-c）: server 側で seq 消費が失われている
      // （restart で noop/reject の seq 消費が未 durable＝復旧後 seq が client より後退）。同一 seq を再送しても永久に violation
      // ループになるため、未ACK pending を expectedSequence から**連番へ再整列**する（operationId は dedup キーゆえ seq 振り直しは
      // 冪等・D27 完全再整列）。それ以外（通常の欠落＝server が client より進む）は従来どおり先頭から再送で回復。
      const expected = message.details?.expectedSequence;
      const firstUnacked = this.pending.find((e) => !e.acknowledged);
      if (expected !== undefined && firstUnacked !== undefined && expected < firstUnacked.envelope.clientSequence) {
        this.rebaselinePendingSequence(expected);
      }
      this.resendAllPending();
      return;
    }
    const index = this.pending.findIndex((e) => e.envelope.operationId === message.operationId);
    if (index === -1) {
      return; // 既に除去済み（reject は二重適用を起こさない）
    }
    const entry = this.pending[index];
    this.pending.splice(index, 1);
    this.pushConflict(
      this.makeConflictEntry(entry, 'rejected', message.details?.violations, message.code, message.details),
    );
    this.rebuildView(); // reject 済み op は再送しない（pending から除去済み・指示 2）
  }

  private handlePresenceSnapshot(message: PresenceSnapshotMessage): void {
    this.knownPresence.clear();
    for (const user of message.users) {
      if (user.connectionId === this._connectionId) {
        continue; // 自分は除外
      }
      this.knownPresence.set(user.connectionId, user);
    }
  }

  private handlePresenceDelta(message: PresenceDeltaMessage): void {
    if (message.presence.connectionId === this._connectionId) {
      return;
    }
    this.knownPresence.set(message.presence.connectionId, message.presence);
  }

  private handlePresenceRemoved(message: PresenceRemovedMessage): void {
    this.knownPresence.delete(message.sessionId);
  }

  // ---- rollback/replay 本体 ----

  /**
   * committed に pending を順に再適用して view を再構築する（§7.7 手順4-6）。
   * validateOperation（core 共有・指示 1）で違反する pending は Conflict Queue へ。
   * 先行 pending が失効した行に触れる後続 pending は依存失効（連鎖・S-H3）。
   */
  private rebuildView(): void {
    let doc = this.committed;
    let provisional = this.committed.revision;
    const survived: PendingEntry[] = [];
    const conflicts: ConflictQueueEntry[] = []; // 収集して this.pending 更新後に push（イベントの件数を正にする・Codex P2-1）
    const invalidatedRows = new Set<RowId>();
    for (const entry of this.pending) {
      const op = entry.envelope.operation;
      const touched = touchedRows(op);
      const dependsOnInvalidated = touched.some((r) => invalidatedRows.has(r));
      const violations = dependsOnInvalidated ? [] : validateOperation(doc, op);
      if (!dependsOnInvalidated && violations.length === 0) {
        provisional += 1;
        const result = applyOperation(doc, op, { revision: provisional });
        const localNoop = isEmptyChangeSet(result.changeSet);
        if (localNoop && entry.acknowledged) {
          // ACK 済みかつ再適用が空 changeSet ＝ サーバーも noop 確定（競合 DeleteRows の敗者＝既に
          // tombstone 済み行への再 Delete・S-E4）。noop は operations エコーが来ないため echo 経由では
          // pending から除去されず、noop ACK が「並行 delete の echo」より先着したケースでは localNoop=false
          // のまま残り続けて収束が止まる（Codex [P1]・DA D33）。committed が並行 delete を取り込んで空
          // changeSet 化した本時点で除去する。seq は消費済み（ACK 済み）ゆえ除去しても再送順序は不変・二重適用0。
          continue; // survived に積まない＝除去。doc は空 changeSet ゆえ据え置きで view 不変。
        }
        doc = result.document;
        survived.push({
          envelope: entry.envelope,
          inverseSeed: result.inverseSeed,
          acknowledged: entry.acknowledged,
          ackRevision: entry.ackRevision,
          localNoop,
        });
      } else {
        for (const r of touched) {
          invalidatedRows.add(r);
        }
        conflicts.push(
          this.makeConflictEntry(
            entry,
            dependsOnInvalidated ? 'dependency' : 'revalidation-failed',
            violations,
          ),
        );
      }
    }
    this.pending = survived;
    this.view = doc;
    // this.pending を survived へ更新した後に conflict を push する（rejected イベントが再構築後の正しい pending 件数を報告する）。
    for (const conflict of conflicts) {
      this.pushConflict(conflict);
    }
  }

  // ---- 再送・再接続 ----

  private sendJoin(): void {
    // fresh join（committed 空）はサーバーから snapshot bootstrap を受ける（全 operationLog replay を避ける・P1-6/P1-7）。
    // reconnect（committed.revision>0）は tail（差分）or 差分>閾値で snapshot 再取得（handleWelcome で対称判定）。
    this.awaitingBootstrap = this.committed.revision === 0;
    // DD-015 reconcile: 未ACK pending の {operationId, clientSequence} を添えて server と突合せる（bounded ≤ maxOfflinePending）。
    // server は受理済/未処理を判定し welcome.reconcile で返す（exactly-once・un-acked-drop race 封鎖・C2〜C4）。
    const pending = this.pending
      .filter((e) => !e.acknowledged)
      .map((e) => ({ operationId: e.envelope.operationId, clientSequence: e.envelope.clientSequence }));
    this.transport.send({
      type: 'join',
      protocolVersion: this.protocolVersion,
      documentId: this.documentId,
      lastAppliedRevision: this.committed.revision, // 先にサーバー差分を要求（§8.5）
      clientId: this.clientId, // 再接続で不変（S-J4）
      pending,
    });
    this.lastSendAt = this.clock.now();
  }

  private sendSubmit(envelope: ClientOperationEnvelope): void {
    this.transport.send({ type: 'submitOperation', envelope });
    this.lastSendAt = this.clock.now();
  }

  /**
   * 未ACK pending の clientSequence を expected から連番へ振り直す（Codex 第3回 P1-c・D27 完全再整列）。
   * server が期待する seq（restart で noop/reject の seq 消費が失われ後退した高水位）へ client を再整列する。operationId は不変
   * （dedup キー）ゆえ既に受理済みの op は再送しても server が duplicate ACK で冪等に救済し、未受理は連番 seq で受理される。
   */
  private rebaselinePendingSequence(expected: number): void {
    let seq = expected;
    for (const entry of this.pending) {
      if (!entry.acknowledged) {
        entry.envelope = { ...entry.envelope, clientSequence: seq }; // operationId/operation/baseRevision は不変
        seq += 1;
      }
    }
    this.lastClientSequence = seq - 1; // 以降の新規 op が再整列後の連番を継続する
  }

  /** un-ACK の pending を先頭から同一 operationId・同一 clientSequence で再送（指示 2）。 */
  private resendAllPending(): void {
    if (!this.online || this.stopped) {
      return;
    }
    for (const entry of this.pending) {
      if (!entry.acknowledged) {
        this.transport.send({ type: 'submitOperation', envelope: entry.envelope });
      }
    }
    this.lastSendAt = this.clock.now();
  }

  /** サーバー差分が target まで届いたら pending 再送・Presence 再登録（§8.5・先に差分→後に再送）。 */
  private maybeFinalizeSync(): void {
    if (!this.awaitingSync || this.knownServerRevision === undefined) {
      return;
    }
    if (this.revisionBuffer.size > 0) {
      return; // まだ catch-up 中
    }
    if (this.expectedRevision <= this.knownServerRevision) {
      return; // committed が target 未達
    }
    // committed が target（frontier）に到達＝全受理済み効果が committed に入った本時点で reconcile を適用する（Codex P1-2）。
    // tail 経路では own accepted は echo 済み（applyReconcile の accepted 除去は no-op）。reject 済（通知喪失）を Conflict へ、
    // 未処理を保持する。committed が権威化した状態で rebuild するため受理済み依存元を含み未処理依存 op が誤 Conflict 化しない。
    if (this.reconcileInfo !== undefined) {
      this.applyReconcile();
      this.rebuildView();
    }
    this.awaitingSync = false;
    this.resendAllPending(); // 生存 pending を再送（stale は既に Conflict Queue へ・S-J2/J3）
    if (this.lastPresence !== undefined) {
      this.sendPresence(this.lastPresence); // 新 connectionId で Presence 再登録（デモ再表示）
    }
  }

  private checkOfflineLimits(): void {
    if (this.stopped || this.online) {
      return;
    }
    // 初回接続前（connecting）は offline 時間上限を適用しない（offlineSince 未確定＝real clock で誤発火するのを防ぐ・
    // 例: playground/テストが接続確立前に tick する場合）。切断からの経過は hasConnected 後にのみ数える。
    if (this.hasConnected && this.clock.now() - this.offlineSince > this.maxOfflineMillis) {
      this.stopped = true; // 切断時間上限（S-J5・Q-4）
    }
    if (this.pending.length > this.maxOfflinePending) {
      this.stopped = true; // 切断中 pending 件数上限（S-J5・Q-4）
    }
    if (this.stopped) {
      // 編集停止を通知する（要確認①: 接続リトライは継続するが submit は不可＝§6「一時切断」を超えた境界）。
      this.emitConnection();
    }
  }

  private needsCatchup(): boolean {
    if (this.revisionBuffer.size > 0) {
      return true; // gap がバッファに残る（先着 revision が未適用）
    }
    // 既知サーバー revision（welcome.currentRevision）に committed が未達（進めるバッファも無い）
    return this.knownServerRevision !== undefined && this.expectedRevision <= this.knownServerRevision;
  }

  private requestCatchup(): void {
    if (!this.online) {
      return;
    }
    this.transport.send({ type: 'requestCatchup', afterRevision: this.expectedRevision - 1 });
    this.lastSendAt = this.clock.now();
  }

  private removeFromPending(operationId: OperationId): boolean {
    const index = this.pending.findIndex((e) => e.envelope.operationId === operationId);
    if (index === -1) {
      return false;
    }
    this.pending.splice(index, 1);
    return true;
  }

  private hasUnackedPending(): boolean {
    return this.pending.some((e) => !e.acknowledged);
  }

  private makeConflictEntry(
    entry: PendingEntry,
    reason: ConflictReason,
    violations?: OperationViolation[],
    code?: RejectCode,
    details?: RejectDetails,
  ): ConflictQueueEntry {
    return {
      operationId: entry.envelope.operationId,
      operation: cloneOperation(entry.envelope.operation), // 深いコピー（コピー可能に保全）
      clientSequence: entry.envelope.clientSequence,
      baseRevision: entry.envelope.baseRevision,
      reason,
      code,
      violations: violations !== undefined && violations.length > 0 ? violations : undefined,
      details,
    };
  }

  // ---- イベント通知（DD-015 要確認③）----

  /** Conflict Queue へ追加し reject イベントを発火する（全ての conflict 追加はここを通す＝通知漏れ防止）。 */
  private pushConflict(entry: ConflictQueueEntry): void {
    this.conflicts.push(entry);
    this.emit({ type: 'rejected', entry, pendingCount: this.pending.length });
  }

  /** 接続状態を（変化時のみ）通知する。stopped が online/offline に優先する。 */
  private emitConnection(): void {
    const state: ConnectionState = this.stopped ? 'stopped' : this.online ? 'online' : 'offline';
    if (state !== this.lastConnectionState) {
      this.lastConnectionState = state;
      this.emit({ type: 'connection', state, pendingCount: this.pending.length });
    }
  }

  /** pending 件数を（変化時のみ）通知する（未送信/未ACK backlog の可視化）。 */
  private emitPendingIfChanged(): void {
    if (this.pending.length !== this.lastEmittedPendingCount) {
      this.lastEmittedPendingCount = this.pending.length;
      this.emit({ type: 'pending', pendingCount: this.pending.length });
    }
  }

  private emit(event: SessionEvent): void {
    this.observer?.(event);
  }

  // ---- 検査用（テスト・Phase 4 デモ）----

  get committedDocument(): SheetDocument {
    return this.committed;
  }

  get viewDocument(): SheetDocument {
    return this.view;
  }

  committedHash(): string {
    return documentHash(this.committed);
  }

  viewHash(): string {
    return documentHash(this.view);
  }

  get nextExpectedRevision(): number {
    return this.expectedRevision;
  }

  /** committed へ適用したサーバー op 総数（AC1/AC8: bootstrap 後の join/再読込は tail のみ＝この値が小さい＝全 replay 非依存）。 */
  get appliedServerOpCount(): number {
    return this._appliedServerOpCount;
  }

  /** snapshot bootstrap で確立した committed revision（未 bootstrap は undefined。全 replay 非依存の確証）。 */
  get bootstrapRevision(): number | undefined {
    return this._bootstrapRevision;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  pendingOperationIds(): OperationId[] {
    return this.pending.map((e) => e.envelope.operationId);
  }

  get conflictQueue(): readonly ConflictQueueEntry[] {
    return this.conflicts;
  }

  get connectionId(): string | undefined {
    return this._connectionId;
  }

  get colorKey(): string | undefined {
    return this._colorKey;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get isOnline(): boolean {
    return this.online;
  }

  /** 他接続の Presence（Phase 4 デモの名前・色表示用。自分は含まない）。 */
  knownPresences(): UserPresence[] {
    return [...this.knownPresence.values()];
  }

  /**
   * view を pending の inverseSeed で逆順 rollback した baseline の hash（DA 逆操作復元の検証用）。
   * 行構造・空セル前値では committed と厳密一致。既存セル上書きは InverseSeed に before-revision が無く
   * 非厳密（D22）。ゆえに committed は本メソッドから導出せず権威管理する（収束担保）。
   */
  rollbackBaselineHash(): string {
    let doc = this.view;
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      doc = applyInverseSeed(doc, this.pending[i].inverseSeed);
    }
    return documentHash(doc);
  }
}

// ---- 純粋ヘルパー ----

/**
 * InverseSeed を逆適用して doc を 1 Operation 分だけ rollback する（§7.7 手順1・Phase 3 消費者契約）。
 * - insertedRowIds を除去（rowOrder/rowMeta/cells）。
 * - deletedRows を un-tombstone in place（index で splice しない・DA D10）。
 * - cells を前値へ復元（後ろから＝forward の逆順・DA D15）。前値=blank は不在へ（行/空セルは厳密復元）。
 *   前値=非空は値のみ復元（InverseSeed は before-revision を持たない＝非厳密・D22）。
 */
export function applyInverseSeed(doc: SheetDocument, seed: InverseSeed): SheetDocument {
  const next = cloneDocument(doc);
  for (const rowId of seed.insertedRowIds) {
    const index = next.rowOrder.indexOf(rowId);
    if (index !== -1) {
      next.rowOrder.splice(index, 1);
    }
    deleteRowCells(next, rowId); // slot 解決に rowMeta を使うため rowMeta.delete より前に消す
    next.rowMeta.delete(rowId);
  }
  for (const deleted of seed.deletedRows) {
    const meta = next.rowMeta.get(deleted.rowId);
    if (meta !== undefined) {
      meta.tombstone = deleted.meta.tombstone; // 削除前（false）へ un-tombstone
      meta.lastChangedRevision = deleted.meta.lastChangedRevision;
    }
  }
  for (let i = seed.cells.length - 1; i >= 0; i -= 1) {
    const change = seed.cells[i];
    const before = change.value;
    if (before === undefined || before.kind === 'blank') {
      deleteCell(next, change.rowId, change.columnId); // 前値=空 → 不在へ（hash 上等価・S-B3）
      continue;
    }
    // before-revision 不明（D22）。値のみ復元し revision は 0（既存セル上書きの rollback は非厳密）。
    setCell(next, change.rowId, change.columnId, { value: cloneCellScalar(before), lastChangedRevision: 0 });
  }
  return next;
}

/** Operation が触れる RowId（依存失効の判定用）。 */
function touchedRows(op: DocumentOperation): RowId[] {
  switch (op.type) {
    case 'setCells':
      return op.changes.map((c) => c.rowId);
    case 'insertRows':
      return op.rows.map((r) => r.rowId);
    case 'deleteRows':
      return op.rowIds;
  }
}

/** Operation を深くコピーする（Conflict Queue の「自分の値」保全用・as 不使用）。 */
function cloneOperation(op: DocumentOperation): DocumentOperation {
  switch (op.type) {
    case 'setCells': {
      const changes: SetCellsOperation['changes'] = op.changes.map((c) =>
        c.beforeRevision === undefined
          ? { rowId: c.rowId, columnId: c.columnId, value: cloneCellScalar(c.value) }
          : {
              rowId: c.rowId,
              columnId: c.columnId,
              beforeRevision: c.beforeRevision,
              value: cloneCellScalar(c.value),
            },
      );
      return { type: 'setCells', conflictPolicy: op.conflictPolicy, changes };
    }
    case 'insertRows':
      return {
        type: 'insertRows',
        afterRowId: op.afterRowId,
        rows: op.rows.map((r) => (r.height === undefined ? { rowId: r.rowId } : { rowId: r.rowId, height: r.height })),
      };
    case 'deleteRows':
      return { type: 'deleteRows', rowIds: [...op.rowIds] };
  }
}

function isEmptyChangeSet(changeSet: ChangeSet): boolean {
  return (
    changeSet.cells.length === 0 &&
    changeSet.rowsInserted.length === 0 &&
    changeSet.rowsDeleted.length === 0
  );
}

function emptyInverseSeed(): InverseSeed {
  return { cells: [], insertedRowIds: [], deletedRows: [] };
}
