// Operation / Envelope / CellScalar 型（データのみ・ロジックなし）。
// 計画書 §7.3〜7.5・Appendix A / DD-003 protocol-subset §2 と一致させる。
// ID 採番（RowId/operationId/transactionId）はここに含めない（§7.6 決定論。採番はクライアント
// Command 側の crypto.randomUUID、テストは注入シード ID）。ランタイム依存ゼロ・型のみ import。

import type {
  ColumnId,
  DocumentId,
  OperationId,
  RowId,
  TransactionId,
} from '@nanairo-sheet/types';

// セル値のスカラー（§6.4 の PoC サブセット）。文書モデル（document.ts の CellRecord.value）と
// Operation（SetCells の value）の双方が参照する最小の値型。
//
// date（DD-012-1・ADR-012）: 日付は **LocalDate（`YYYY-MM-DD` 文字列・計画書 D-08）** で保持する。
//   JS の `Date`（タイムゾーン/時刻を含む）を正規値にしない（cross-platform hash 決定性・環境非依存のため）。
//   value は必ず正準化済み（4桁年-2桁月-2桁日・実在する暦日）。生成は parseCellInput が保証する。
//   hash は `field(kind)`（'date' vs 'string'）で string と区別されるため、同じ文字列でも別値になる（正準性維持）。
export type CellScalar =
  | { readonly kind: 'blank' }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'date'; readonly value: string /* LocalDate: YYYY-MM-DD（正準化済み） */ };

/** SetCells の1件の変更。`beforeRevision` は Phase 2 サーバーの stale 検査用（apply 層は参照しない）。 */
export interface SetCellsChange {
  rowId: RowId;
  columnId: ColumnId;
  beforeRevision?: number;
  value: CellScalar;
}

/** SetCells: 全件適用または全件拒否の原子的 Operation（§7.5・I-5）。 */
export interface SetCellsOperation {
  type: 'setCells';
  changes: SetCellsChange[];
  conflictPolicy: 'reject-overlap'; // PoC 固定
}

/** InsertRows: `afterRowId` アンカーの直後へ挿入（null=先頭）。新 RowId は rows に同梱。 */
export interface InsertRowsOperation {
  type: 'insertRows';
  afterRowId: RowId | null;
  rows: Array<{ rowId: RowId; height?: number }>;
}

/** DeleteRows: rowIds をスロット tombstone 化（再 Delete は冪等 no-op）。 */
export interface DeleteRowsOperation {
  type: 'deleteRows';
  rowIds: RowId[];
}

export type DocumentOperation = SetCellsOperation | InsertRowsOperation | DeleteRowsOperation;

// ---- Envelope（protocol-subset §2。core に型定義し server-core / client が import する）----

/** SetCells reject 時の競合セル情報（§10.2。現在値・現在 revision を返す）。 */
export interface CellConflict {
  rowId: RowId;
  columnId: ColumnId;
  currentValue: CellScalar | undefined;
  currentRevision: number;
}

/** 競合メタデータ（ServerOperationEnvelope.conflict）。Phase 2 で拡張しうる最小形。 */
export interface ConflictMetadata {
  cells: CellConflict[];
}

/** クライアント→サーバーの Operation Envelope（§7.3）。 */
export interface ClientOperationEnvelope {
  protocolVersion: number;
  documentId: DocumentId;
  operationId: OperationId; // 冪等キー（文書単位で一意）
  transactionId: TransactionId; // 1利用者操作 = 1 transaction
  actorId: string; // userId
  clientId: string; // = clientSessionId。再接続で不変
  clientSequence: number; // clientId 単位で単調増加
  baseRevision: number; // 構築時の既知 revision（≤ currentRevision）
  operation: DocumentOperation;
}

/** サーバー→クライアントの Operation Envelope（§7.3。サーバー付与フィールドを追加）。 */
export interface ServerOperationEnvelope extends ClientOperationEnvelope {
  revision: number; // サーバー付与（単調増加）
  acceptedAt: string; // ISO 文字列（ログ/監査用。適用関数には渡さない）
  canonicalOperation: DocumentOperation; // 正準化後（PoC では operation と同一）
  conflict?: ConflictMetadata;
}
