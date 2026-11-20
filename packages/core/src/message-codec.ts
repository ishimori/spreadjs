// JSON 境界の型安全デコード（純粋・Node/DOM 非参照）。`JSON.parse` の結果（unknown）を
// ClientMessage / ServerMessage へユーザー定義型ガード（`v is T`・coding-standards P02 準拠）で narrow する。
//
// 検査方針: 判別子 `type` を既知集合で確認し、Room / ClientSession が読むトップレベル必須フィールドの型を検査する。
// envelope / payload / operation の内部（セル値の詳細等）は **PoC 開発用サーバー境界（両端が自製）** ゆえ信頼する
// （本番相当の完全バリデーションはスコープ外＝protocol-subset の予約項目）。不正は undefined を返し、
// 呼び出し側が接続 close（server）または drop+log（client）で処理する。server.ts / ws-transport.ts が共有する。

import type { DocumentOperation } from './operations';
import type { ClientMessage, PresencePayload, ServerMessage } from './protocol';

/** unknown を「文字列キーの record」へ絞り込む（プロトタイプ無し null は除外）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ---- Client → Server ----

/** JSON.parse 結果を ClientMessage へデコードする（不正なら undefined）。 */
export function decodeClientMessage(raw: unknown): ClientMessage | undefined {
  return isClientMessage(raw) ? raw : undefined;
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  switch (value.type) {
    case 'join':
      return (
        typeof value.protocolVersion === 'number' &&
        typeof value.documentId === 'string' &&
        typeof value.lastAppliedRevision === 'number' &&
        typeof value.clientId === 'string' &&
        // DD-015 reconcile 用の pending 参照（任意・省略可）。存在時は配列（内部詳細は両端自製ゆえ信頼）。
        (value.pending === undefined || Array.isArray(value.pending))
      );
    case 'submitOperation':
      return isClientEnvelope(value.envelope);
    case 'presence':
      return typeof value.sequence === 'number' && isPresencePayload(value.payload);
    case 'heartbeat':
      return typeof value.sentAt === 'number';
    case 'requestCatchup':
      return typeof value.afterRevision === 'number';
    default:
      return false;
  }
}

function isClientEnvelope(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.operationId === 'string' &&
    typeof value.clientId === 'string' &&
    typeof value.clientSequence === 'number' &&
    typeof value.baseRevision === 'number' &&
    typeof value.documentId === 'string' &&
    isDocumentOperation(value.operation)
  );
}

function isDocumentOperation(value: unknown): value is DocumentOperation {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  switch (value.type) {
    case 'setCells':
      return Array.isArray(value.changes) && value.conflictPolicy === 'reject-overlap';
    case 'insertRows':
      return Array.isArray(value.rows) && (value.afterRowId === null || typeof value.afterRowId === 'string');
    case 'deleteRows':
      return Array.isArray(value.rowIds);
    default:
      return false;
  }
}

function isReconcileInfo(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.ackedClientSequence === 'number' &&
    Array.isArray(value.acceptedOperationIds) &&
    (value.inFlightOperationIds === undefined || Array.isArray(value.inFlightOperationIds)) // DD-015 P1-b（任意）
  );
}

function isPresencePayload(value: unknown): value is PresencePayload {
  return (
    isRecord(value) &&
    typeof value.userId === 'string' &&
    typeof value.displayName === 'string' &&
    Array.isArray(value.selectionRanges)
  );
}

// ---- Server → Client ----

/** JSON.parse 結果を ServerMessage へデコードする（不正なら undefined）。 */
export function decodeServerMessage(raw: unknown): ServerMessage | undefined {
  return isServerMessage(raw) ? raw : undefined;
}

function isServerMessage(value: unknown): value is ServerMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  switch (value.type) {
    case 'welcome':
      return (
        typeof value.sessionId === 'string' &&
        typeof value.colorKey === 'string' &&
        typeof value.currentRevision === 'number' &&
        // DD-015 再接続 reconcile（任意・省略可）。存在時は {ackedClientSequence:number, acceptedOperationIds:array}。
        (value.reconcile === undefined || isReconcileInfo(value.reconcile)) &&
        (value.diverged === undefined || typeof value.diverged === 'boolean') && // DD-015 revision 連続性 fail-fast（任意）
        (value.bootstrapFollows === undefined || typeof value.bootstrapFollows === 'boolean') // DD-070-9（任意）
      );
    case 'operations':
      return (
        typeof value.fromRevision === 'number' &&
        typeof value.toRevision === 'number' &&
        Array.isArray(value.operations)
      );
    case 'bootstrap':
      // snapshot bootstrap（DD-014-1）: document（正準構造）＋revision。両端が自製ゆえ内部詳細は信頼する
      // （decode 方針の踏襲）。document は DocumentSnapshot（rowOrder/rowMeta/columnOrder/cells）。
      return typeof value.revision === 'number' && isRecord(value.document);
    case 'operationAck':
      return typeof value.operationId === 'string' && typeof value.revision === 'number';
    case 'operationRejected':
      return typeof value.operationId === 'string' && typeof value.code === 'string';
    case 'presenceSnapshot':
      return Array.isArray(value.users);
    case 'presenceDelta':
      return isRecord(value.presence) && typeof value.presence.connectionId === 'string';
    case 'presenceRemoved':
      return typeof value.sessionId === 'string';
    case 'heartbeatAck':
      return typeof value.serverTime === 'number';
    default:
      return false;
  }
}
