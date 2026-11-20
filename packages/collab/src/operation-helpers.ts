// Operation の純粋な補助関数（依存失効の判定・Conflict Queue 用の深いコピー・空の ChangeSet の判定・空の InverseSeed）。
// DD-070-5 で session.ts から移した（中身は従来どおり。session.ts はサイズのガードの超過を増やせないため）。

import { cloneCellScalar } from '@nanairo-sheet/core';
import type { ChangeSet, DocumentOperation, InverseSeed, SetCellsOperation } from '@nanairo-sheet/core';
import type { RowId } from '@nanairo-sheet/types';

/** Operation が触れる RowId（依存失効の判定用）。 */
export function touchedRows(op: DocumentOperation): RowId[] {
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
export function cloneOperation(op: DocumentOperation): DocumentOperation {
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

export function isEmptyChangeSet(changeSet: ChangeSet): boolean {
  return (
    changeSet.cells.length === 0 &&
    changeSet.rowsInserted.length === 0 &&
    changeSet.rowsDeleted.length === 0
  );
}

export function emptyInverseSeed(): InverseSeed {
  return { cells: [], insertedRowIds: [], deletedRows: [] };
}
