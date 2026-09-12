// プロトコルメッセージ型（DD-003 Phase 2・主セッション指示 2・型のみ / ランタイムコードなし）。
// protocol-subset.md §1（採用メッセージ）・§3（reject コード）・§6（Presence）を型で確定する。
// server-core と Phase 3 クライアントの両方がここを import する（クライアントが server-core に依存しない構成を保つ）。
//
// 配置判断（DDログ記録）: Operation Envelope（Client/Server）は Phase 1 で operations.ts に定義済みのため
// ここで二重定義せず type import して message でラップする。message union / reject コード / Presence 型のみ本ファイルに追加する。

import type { DocumentSnapshot } from './document-snapshot';
import type { ClientOperationEnvelope, ServerOperationEnvelope } from './operations';
import type { OperationViolation } from './validate';

import type { ColumnId, DocumentId, OperationId, RowId } from '@nanairo-sheet/types';

// ---- reject コード（protocol-subset §3。duplicate-row は指示 3 で新設）----

export type RejectCode =
  | 'stale-cell-revision'
  | 'target-row-deleted'
  | 'unknown-anchor'
  | 'unknown-row'
  | 'unknown-column'
  | 'invalid-base-revision'
  | 'client-sequence-violation'
  | 'duplicate-row';

/** reject の details。code ごとに使うフィールドが異なる最小構造（any 不使用）。 */
export interface RejectDetails {
  violations?: OperationViolation[]; // 検証 reject。SetCells 原子性で全違反を列挙する（§3）
  currentRevision?: number; // invalid-base-revision
  expectedSequence?: number; // client-sequence-violation
  receivedSequence?: number; // client-sequence-violation
}

// ---- Presence（protocol-subset §6・connection 単位）----

export interface CellAddressById {
  rowId: RowId;
  columnId: ColumnId;
}

/** 矩形選択範囲（RowId/ColumnId 参照。§9.2）。 */
export interface SelectionById {
  startRowId: RowId;
  startColumnId: ColumnId;
  endRowId: RowId;
  endColumnId: ColumnId;
}

/** クライアントが送る Presence ペイロード（3 種フィールド＋識別）。colorKey/connectionId はサーバー付与ゆえ含まない。 */
export interface PresencePayload {
  userId: string;
  displayName: string;
  activeCell?: CellAddressById | undefined;
  selectionRanges: SelectionById[];
  editingCell?: CellAddressById | undefined;
}

/** サーバーが配信する Presence（connectionId/colorKey/sequence をサーバー付与）。 */
export interface UserPresence extends PresencePayload {
  connectionId: string;
  colorKey: string;
  sequence: number;
}

// ---- Client → Server（§1）----

/** 再接続 reconcile 用の未ACK pending 参照（DD-015・exactly-once）。operationId と clientSequence だけを運ぶ（bounded ≤ maxOfflinePending）。 */
export interface PendingOperationRef {
  operationId: OperationId;
  clientSequence: number;
}

export interface JoinMessage {
  type: 'join';
  protocolVersion: number;
  documentId: DocumentId;
  lastAppliedRevision: number;
  clientId: string;
  /**
   * DD-015: 再接続時の未ACK pending 参照（reconcile 用）。server は operationId が確定ログ（ackCache）に在るかで
   * accepted/未処理を判定し、welcome.reconcile で返す（受理済は除去・未処理は再送＝un-acked-drop race 封鎖・exactly-once）。
   * 省略（legacy/synthetic）時は reconcile を行わない（従来の再送経路）。
   */
  pending?: PendingOperationRef[];
}

export interface SubmitOperationMessage {
  type: 'submitOperation';
  envelope: ClientOperationEnvelope;
}

export interface PresenceClientMessage {
  type: 'presence';
  sequence: number; // connection 単位で単調増加
  payload: PresencePayload;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  sentAt: number;
}

export interface RequestCatchupMessage {
  type: 'requestCatchup';
  afterRevision: number;
}

export type ClientMessage =
  | JoinMessage
  | SubmitOperationMessage
  | PresenceClientMessage
  | HeartbeatMessage
  | RequestCatchupMessage;

/** join を除くクライアントメッセージ（確立済み接続からのメッセージ）。Room.handleMessage の入力。 */
export type ClientMessageExceptJoin = Exclude<ClientMessage, JoinMessage>;

// ---- Server → Client（§1）----

export interface Capabilities {
  protocolVersion: number;
}

/**
 * 再接続 reconcile 情報（DD-015・exactly-once）。join.pending に対する server 側の突合せ結果。
 * - `ackedClientSequence`: この clientId の処理済み clientSequence 高水位（clientSequenceTable）。
 * - `acceptedOperationIds`: join.pending のうち確定ログ（ackCache＝accepted/noop）に在る operationId 集合。
 * クライアントは opId が acceptedOperationIds に在れば **受理済として除去**、無くて clientSequence≦ackedClientSequence なら
 * **reject 済（通知喪失）として Conflict Queue**、それ以外（clientSequence 超）は **未処理として再送** する（fault matrix C2〜C4）。
 */
export interface ReconcileInfo {
  ackedClientSequence: number;
  acceptedOperationIds: OperationId[]; // durable（ackCache 在・revision≦frontier）＝client は除去（committed@frontier に反映済み）
  /**
   * DD-015 Codex 第3回 P1-b: **pre-fsync accepted**（ackCache 在だが revision>frontier＝未 durable な in-flight）の operationId。
   * client は除去も reject もせず **pending 保持（再送）**する。除去すると append 失敗時に喪失（P1-1）、reject 分類すると durable 化後に
   * false conflict（P1-b）になるため「unknown＝保持」が正。durable 化後は echo で committed へ入り removeFromPending で正規化される。
   * 省略/空は無し（永続化無効なら常に空＝全 accepted が durable）。
   */
  inFlightOperationIds?: OperationId[];
}

export interface WelcomeMessage {
  type: 'welcome';
  sessionId: string; // = connectionId（Presence 管理単位）
  colorKey: string; // 自接続の割当色（Phase 3 指示 3・自分の colorKey を join 時に知る＝welcome 拡張）
  currentRevision: number;
  capabilities: Capabilities;
  /** DD-015: 再接続 reconcile（join.pending を送った client にのみ返す。fresh/legacy は省略）。 */
  reconcile?: ReconcileInfo;
  /**
   * DD-015 revision 連続性 fail-fast（C11）: server が **join.lastAppliedRevision > 自身の durable frontier** を検出したとき true。
   * ＝client が server の権威履歴より先を持つ＝server が巻き戻った（非永続 server の再起動でデータ喪失した等）。
   * client は黙って merge せず編集停止する。判定は server 側（frontier は権威・応答の順序入れ替えに非依存）。省略/false は正常。
   */
  diverged?: boolean;
}

export interface OperationsMessage {
  type: 'operations';
  fromRevision: number;
  toRevision: number;
  operations: ServerOperationEnvelope[];
}

/**
 * snapshot bootstrap（DD-014-1・CG-3）: fresh join（lastAppliedRevision=0）に対しサーバーが返す。
 * クライアントは全 operationLog を replay せず、この document@revision から committed を確立し tail のみ適用する
 * （§8 既知制約「snapshotベース初期化」回収・P1-6/P1-7）。document は durable frontier 以下（未 durable を配らない）。
 */
export interface BootstrapMessage {
  type: 'bootstrap';
  document: DocumentSnapshot; // document@revision（durable frontier 以下の権威文書）
  revision: number; // = document.revision（committed の確定 revision）
}

export interface OperationAckMessage {
  type: 'operationAck';
  operationId: OperationId;
  revision: number;
}

export interface OperationRejectedMessage {
  type: 'operationRejected';
  operationId: OperationId;
  code: RejectCode;
  details?: RejectDetails;
}

export interface PresenceSnapshotMessage {
  type: 'presenceSnapshot';
  users: UserPresence[];
}

export interface PresenceDeltaMessage {
  type: 'presenceDelta';
  presence: UserPresence;
}

export interface PresenceRemovedMessage {
  type: 'presenceRemoved';
  sessionId: string; // = connectionId
}

export interface HeartbeatAckMessage {
  type: 'heartbeatAck';
  serverTime: number;
}

export type ServerMessage =
  | WelcomeMessage
  | OperationsMessage
  | BootstrapMessage
  | OperationAckMessage
  | OperationRejectedMessage
  | PresenceSnapshotMessage
  | PresenceDeltaMessage
  | PresenceRemovedMessage
  | HeartbeatAckMessage;
