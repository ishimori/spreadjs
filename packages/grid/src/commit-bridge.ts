// commit-bridge（DD-005 Phase 3・#3/#7）: IME 確定ドラフト → SetCells Operation への変換ロジック（DOM 非依存）。
//
// 【最重要原則との整合】ClientSession だけが Document State の唯一の正本。この層は「確定した draft を
// どの RowId/ColumnId へ・どの beforeRevision で SetCells 化するか」を決める純粋関数だけを持つ。
// 実際の submit（楽観適用→pending→送信）は ClientSession.submitLocalOperation が行う（この層は生成のみ）。
//
// #3 beforeRevision はセル単位:
//   - 編集開始時に **対象セルの lastChangedRevision** を保持し（captureEditStartRevision）、
//     SetCells.changes[].beforeRevision に使う（文書全体 revision ではない）。
//   - 未書込セルの現在 revision は 0（server の validate.ts と整合＝blank を beforeRevision:0 で書く）。
//   - これにより「別セルの更新だけでは同一セル競合にならない」（server validateSetCells がセル単位で照合）。
//
// #7 Commit 順序（この層が担うのは 3〜5）:
//   3. 対象 RowId/ColumnId の生存確認（削除済みなら無効 RowId へ Commit しない・#4）
//   4. 編集開始時の beforeRevision を取得（= EditTarget.startRevision・編集開始で凍結）
//   5. SetCells を生成（呼び出し側が ClientSession へ submit → ACK/reject）

import { getCell, parseCellInput } from '@nanairo-sheet/core';
import type { CellScalar, SetCellsOperation, SheetDocument } from '@nanairo-sheet/core';
import type { ColumnId, RowId } from '@nanairo-sheet/types';

/** 編集対象（表示 index ではなく RowId/ColumnId で保持・#4）。startRevision は編集開始で凍結する（#3）。 */
export interface EditTarget {
  readonly rowId: RowId;
  readonly columnId: ColumnId;
  /** 編集開始時の対象セル lastChangedRevision（= SetCells.beforeRevision）。 */
  readonly startRevision: number;
}

/**
 * 編集開始時に対象セルの lastChangedRevision を取得する（#3）。
 * 未書込セル（getCell===undefined）は 0 とみなす（server validate.ts の `?? 0` と一致）。
 */
export function captureEditStartRevision(
  doc: SheetDocument,
  rowId: RowId,
  columnId: ColumnId,
): number {
  return getCell(doc, rowId, columnId)?.lastChangedRevision ?? 0;
}

/**
 * 確定ドラフト文字列を CellScalar へ変換する（型変換・標準セット）。
 * 変換規則の正本は core の parseCellInput（受理書式表・偽陽性防止・DD-012-1）。
 * commit 経路はここへ委譲し、composition 中の状態機械・textarea には触れない（IME 不変条件維持）。
 * `isStringColumn`（RC12・DD-052-2）が true の列は型変換をスキップし常に string で保つ。
 */
export function draftToScalar(text: string, isStringColumn = false): CellScalar {
  return parseCellInput(text, { forceString: isStringColumn });
}

/** RowId が生存しているか（未知/tombstone は false）。削除判定は index 範囲でなく tombstone で行う（#4）。 */
export function isRowLive(doc: SheetDocument, rowId: RowId): boolean {
  const meta = doc.rowMeta.get(rowId);
  return meta !== undefined && !meta.tombstone;
}

/** 編集対象セルが生存しているか（RowId が生きていて ColumnId が列順に存在する）。 */
export function isTargetLive(doc: SheetDocument, target: EditTarget): boolean {
  return isRowLive(doc, target.rowId) && doc.columnOrder.includes(target.columnId);
}

export type CommitOutcome =
  | { readonly kind: 'submit'; readonly operation: SetCellsOperation }
  | { readonly kind: 'target-deleted' };

/**
 * #7 の 3〜5: 生存確認 → beforeRevision（凍結済み startRevision）→ SetCells 生成。
 * 対象が削除されていれば 'target-deleted' を返し **無効 RowId へは Commit しない**（#4・呼び出し側が退避）。
 */
export function resolveCommit(
  committedDoc: SheetDocument,
  target: EditTarget,
  value: CellScalar,
): CommitOutcome {
  if (!isTargetLive(committedDoc, target)) {
    return { kind: 'target-deleted' };
  }
  const operation: SetCellsOperation = {
    type: 'setCells',
    conflictPolicy: 'reject-overlap',
    changes: [
      {
        rowId: target.rowId,
        columnId: target.columnId,
        beforeRevision: target.startRevision, // セル単位 beforeRevision（#3）
        value,
      },
    ],
  };
  return { kind: 'submit', operation };
}

/**
 * #9 競合検知: 編集開始時 revision と現在の committed セル revision が乖離したか
 * （＝編集中に別クライアントが同一セルを確定した）。true なら競合インジケーターを出す。
 * IME draft には一切触れない（#8）。判定は committed（サーバー確定）に対して行う。
 */
export function isEditTargetStale(committedDoc: SheetDocument, target: EditTarget): boolean {
  const current = getCell(committedDoc, target.rowId, target.columnId)?.lastChangedRevision ?? 0;
  return current !== target.startRevision;
}
