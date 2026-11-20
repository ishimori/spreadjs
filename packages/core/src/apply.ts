// 決定論的適用関数（計画書 §7.6）。サーバー（sequencer）とクライアント（session）が共有する（§5.3）。
// 時刻・乱数・DOM・ネットワークを参照せず、同一 (文書, Operation, 付与revision) → 同一 ApplyResult。
// 付与 revision は呼び出し側（サーバー付与＝committed / クライアント楽観＝暫定）が ctx で渡す。
// 入力文書は破壊しない（forkDocument の構造共有の作業文書で二相適用・DD-070-10。費用は表の大きさに比例しない）。
//
// 検査の分担: apply が投げる ApplyError は「文書だけで判定できる構造エラー」= unknown-row /
// target-row-deleted / unknown-anchor / unknown-column（DD-010・列固定違反）。すべて validateOperation が
// 先に検出でき「validate===[] ⇒ apply は throw しない」契約を保つ（phase1-design §4・protocol-subset §3。S-A6〜A8）。
// SetCells の beforeRevision による stale 検査（stale-cell-revision）は Room 現在 revision との
// 照合が要るため Phase 2 サーバー（sequencer）の責務とし、apply 層では beforeRevision を参照しない。

import type { ColumnId, RowId } from '@nanairo-sheet/types';

import {
  cloneCellScalar,
  columnIndexOf,
  forkDocument,
  getCell,
  resolveAnchorIndex,
  setCell,
  writableRowMeta,
  writableRowOrder,
} from './document';
import type { RowMeta, SheetDocument } from './document';
import type {
  CellScalar,
  DeleteRowsOperation,
  DocumentOperation,
  InsertRowsOperation,
  SetCellsOperation,
} from './operations';

export interface CellChange {
  rowId: RowId;
  columnId: ColumnId;
  before: CellScalar | undefined;
  after: CellScalar | undefined;
}

export interface ChangeSet {
  cells: CellChange[];
  rowsInserted: RowId[];
  rowsDeleted: RowId[]; // 実際に tombstone 化した分のみ（再Delete no-op は含めない）
}

/**
 * rollback 用の逆操作生成データ（§7.6/7.7。Phase 3 で session.ts が消費する）。
 * Phase 3 消費者への契約:
 * - `cells` は変更前値。rollback では **後ろから順に**（forward の逆順で）適用する
 *   （同一 SetCells 内で同一セルを複数回書いた場合の正しい復元のため・DA D15）。空セルの前値は
 *   `{kind:'blank'}` として保持し、rollback で blank を書く（不在との差は hash 上等価・S-B3）。
 * - `insertedRowIds` は rowOrder / rowMeta / cells から除去する。
 * - `deletedRows` は un-tombstone で復元する（本モデルの DeleteRows は tombstone のみで rowOrder から
 *   物理削除しないため、行は現位置に残っている）。`index` は **削除時点**の rowOrder 位置で、参考情報。
 *   以後の InsertRows で位置がずれ得るので、index を使った物理再挿入はしない（un-tombstone in place・DA D10）。
 */
export interface InverseSeed {
  cells: Array<{ rowId: RowId; columnId: ColumnId; value: CellScalar | undefined }>; // 変更前値
  insertedRowIds: RowId[]; // 逆操作で削除すべき行
  deletedRows: Array<{ rowId: RowId; index: number; meta: RowMeta }>; // 逆操作で復元する行（tombstone 前 meta）
}

export interface ApplyResult {
  document: SheetDocument; // 適用後の新文書（入力は不変）
  changeSet: ChangeSet;
  inverseSeed: InverseSeed;
  dirtyRegions: RowId[]; // 再描画対象（PoC は行集合で十分）
  formulaInvalidations: never[]; // PoC はスコープ外（常に []）
}

export type ApplyErrorCode =
  | 'unknown-row'
  | 'target-row-deleted'
  | 'unknown-anchor'
  | 'unknown-column';

export class ApplyError extends Error {
  readonly code: ApplyErrorCode;
  readonly offending: unknown; // 違反 change/row の一覧（reject details の元）

  constructor(code: ApplyErrorCode, offending: unknown, message?: string) {
    super(message ?? code);
    this.name = 'ApplyError';
    this.code = code;
    this.offending = offending;
  }
}

export function applyOperation(
  doc: SheetDocument,
  op: DocumentOperation,
  ctx: { revision: number },
): ApplyResult {
  // 入力を破壊しないため構造共有の作業文書を 1 回作り、以降は作業文書を in-place で変更する（二相適用）。
  // 作業文書は書くチャンク・行・行の並びだけを写す（DD-070-10。以前の丸ごとの深い複製はセルの数に比例した）。
  const next = forkDocument(doc);
  return applyOperationInto(next, op, ctx.revision);
}

/**
 * 既に accepted 済みの operation 列を **単一の working document へ in-place 適用**して最終文書を返す
 * （再起動復旧・snapshot tail replay 用・DD-014）。op ごとの full clone を避けるため計算量は
 * O(clone 1 回 ＋ Σ変更) ＝ O(N²) 回避（AC4/AC5）。**base は破壊される**（呼び出し側が所有・共有参照を渡さないこと）。
 * ChangeSet/inverse は生成するが破棄してよい（呼び出し側は最終文書のみを使う）。
 */
export function replayAcceptedOperations(
  base: SheetDocument,
  ops: Iterable<{ operation: DocumentOperation; revision: number }>,
): SheetDocument {
  let doc = base;
  for (const entry of ops) {
    doc = applyOperationInto(doc, entry.operation, entry.revision).document;
  }
  return doc;
}

/** working document `next` を破壊的に変更して適用する（clone はしない）。applyOperation と replay が共有する。 */
function applyOperationInto(next: SheetDocument, op: DocumentOperation, revision: number): ApplyResult {
  switch (op.type) {
    case 'setCells':
      return applySetCells(next, op, revision);
    case 'insertRows':
      return applyInsertRows(next, op, revision);
    case 'deleteRows':
      return applyDeleteRows(next, op, revision);
    default:
      return assertNever(op);
  }
}

// 以下 apply* は渡された `next`（clone 済み working copy）を **in-place** で変更する（内部で clone しない）。
function applySetCells(next: SheetDocument, op: SetCellsOperation, revision: number): ApplyResult {
  // Phase 1: 全件を構造検証（部分適用しない＝原子性・I-5）。違反は種別ごとに収集し全件 reject。
  const unknownRows: RowId[] = [];
  const deletedRows: RowId[] = [];
  const unknownColumns: ColumnId[] = [];
  for (const change of op.changes) {
    const meta = next.rowMeta.get(change.rowId);
    if (meta === undefined) {
      unknownRows.push(change.rowId);
    } else if (meta.tombstone) {
      deletedRows.push(change.rowId);
    } else if (columnIndexOf(next, change.columnId) < 0) {
      // columnOrder 外の列は構造エラー（DD-010・列固定 PoC）。setCell の raw throw ではなく ApplyError で reject。
      unknownColumns.push(change.columnId);
    }
  }
  if (unknownRows.length > 0) {
    throw new ApplyError('unknown-row', unknownRows);
  }
  if (deletedRows.length > 0) {
    throw new ApplyError('target-row-deleted', deletedRows);
  }
  if (unknownColumns.length > 0) {
    throw new ApplyError('unknown-column', unknownColumns);
  }

  // Phase 2: working copy 上で確定（作業文書は applyOperation が 1 回だけ作った・replay は base そのもの）。
  // before は working copy から読み、同一 SetCells 内の複数変更（同一セルの連続書き）も正しく直前値を反映する。
  const cells: CellChange[] = [];
  const inverseCells: InverseSeed['cells'] = [];
  const dirty: RowId[] = [];
  const seenDirty = new Set<RowId>();

  for (const change of op.changes) {
    const before = readCellValueOrBlank(next, change.rowId, change.columnId);
    setCell(next, change.rowId, change.columnId, {
      value: cloneCellScalar(change.value),
      lastChangedRevision: revision,
    });
    cells.push({
      rowId: change.rowId,
      columnId: change.columnId,
      before: cloneCellScalar(before),
      after: cloneCellScalar(change.value),
    });
    inverseCells.push({
      rowId: change.rowId,
      columnId: change.columnId,
      value: cloneCellScalar(before),
    });
    if (!seenDirty.has(change.rowId)) {
      seenDirty.add(change.rowId);
      dirty.push(change.rowId);
    }
  }
  next.revision = revision;

  return {
    document: next,
    changeSet: { cells, rowsInserted: [], rowsDeleted: [] },
    inverseSeed: { cells: inverseCells, insertedRowIds: [], deletedRows: [] },
    dirtyRegions: dirty,
    formulaInvalidations: [],
  };
}

function applyInsertRows(
  next: SheetDocument,
  op: InsertRowsOperation,
  revision: number,
): ApplyResult {
  const anchorIndex = resolveAnchorIndex(next, op.afterRowId);
  if (anchorIndex === undefined) {
    throw new ApplyError('unknown-anchor', op.afterRowId);
  }

  // 前提（呼び出し側の契約・DA D11）: op.rows の rowId は文書内で未使用（本番は crypto.randomUUID、
  // テストはシード一意）。既存 rowId を渡すと rowOrder に重複が入る。PoC は採番一意性を前提とし、
  // 専用エラーコードは設けない（apply の ApplyError は構造3種＝phase1-design §4 に限定）。
  const insertedRowIds: RowId[] = [];
  // P2-1（DD-021-3）: nextSlot の rowMeta 全走査（O(N)）を廃し、文書の maxSlot キャッシュから O(1) で採番する。
  // slot は max+1 から連番で、末尾で maxSlot を一括更新する（単調非減少・rollback でも減らさない）。
  let slot = next.maxSlot + 1;
  let insertAt = anchorIndex + 1; // アンカー直後（先頭=-1 のときは 0）
  // 共有しうる行の並び・行の情報は書く前に写す（forkDocument・DD-070-10。空 rows なら写さない）。
  const rowOrder = op.rows.length > 0 ? writableRowOrder(next) : [];
  const rowMeta = op.rows.length > 0 ? writableRowMeta(next) : new Map<RowId, RowMeta>();

  for (const rowSpec of op.rows) {
    rowOrder.splice(insertAt, 0, rowSpec.rowId);
    rowMeta.set(rowSpec.rowId, {
      id: rowSpec.rowId,
      slot,
      tombstone: false,
      lastChangedRevision: revision,
    });
    insertedRowIds.push(rowSpec.rowId);
    insertAt += 1;
    slot += 1;
  }
  if (insertedRowIds.length > 0) {
    next.maxSlot = slot - 1; // 最後に採番した slot（採番したときのみ更新＝空 rows で単調性を壊さない）
  }
  next.revision = revision;

  return {
    document: next,
    changeSet: { cells: [], rowsInserted: insertedRowIds, rowsDeleted: [] },
    inverseSeed: { cells: [], insertedRowIds: [...insertedRowIds], deletedRows: [] },
    dirtyRegions: [...insertedRowIds],
    formulaInvalidations: [],
  };
}

function applyDeleteRows(
  next: SheetDocument,
  op: DeleteRowsOperation,
  revision: number,
): ApplyResult {
  const rowsDeleted: RowId[] = [];
  const inverseDeleted: InverseSeed['deletedRows'] = [];

  for (const rowId of op.rowIds) {
    const meta = next.rowMeta.get(rowId);
    // 未知行・tombstone 済みは冪等 no-op（S-E2/E3）。全件 no-op でも changeSet 空で成功。
    if (meta === undefined || meta.tombstone) {
      continue;
    }
    const index = next.rowOrder.indexOf(rowId);
    inverseDeleted.push({ rowId, index, meta: { ...meta } }); // tombstone 前の状態を保存（復元用）
    // RowMeta は fork 元と共有しうるため、その場で書き換えず差し替える（DD-070-10）。
    writableRowMeta(next).set(rowId, { ...meta, tombstone: true, lastChangedRevision: revision });
    rowsDeleted.push(rowId);
  }
  next.revision = revision;

  return {
    document: next,
    changeSet: { cells: [], rowsInserted: [], rowsDeleted },
    inverseSeed: { cells: [], insertedRowIds: [], deletedRows: inverseDeleted },
    dirtyRegions: [...rowsDeleted],
    formulaInvalidations: [],
  };
}

// 既存セル値を返し、無ければ blank を返す（before/inverse 値を CellScalar に正規化する）。
function readCellValueOrBlank(doc: SheetDocument, rowId: RowId, columnId: ColumnId): CellScalar {
  const record = getCell(doc, rowId, columnId);
  return record === undefined ? { kind: 'blank' } : record.value;
}

function assertNever(value: never): never {
  throw new Error(`applyOperation: unexpected operation ${JSON.stringify(value)}`);
}
