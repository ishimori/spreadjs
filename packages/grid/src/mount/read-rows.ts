// 表のデータを読む（GridInstance.getRows・DD-070-5）。文書（自分の未確定の変更を含む view）から、文書の並びで行を読む純粋関数。
// 返す形は単独モードの行データ（GridStandaloneRow）と同じ `{ rowId, cells }`（空のセルは載せない・値は cell-commit と同じ表示文字列）
// なので、そのまま setData に渡せば同じ表になる。画面だけの並べ替え・絞り込み（DD-070-8）の影響は受けない（文書の並び・全部の行）。

import { displayRowOrder, getCell, slotOf } from '@nanairo-sheet/core';
import type { SheetDocument } from '@nanairo-sheet/core';
import type { ColumnId, RowId } from '@nanairo-sheet/types';

import { cellScalarToDisplay } from '../document-view';
import type { GridReadRowsOptions, GridRowData } from '../index';

/** options を検査して読む列・行を決める（未知・削除済みは静かに無視。不正な型は「指定なし」として扱わずに空にする）。 */
function selectColumns(doc: SheetDocument, columnIds: GridReadRowsOptions['columnIds']): readonly ColumnId[] {
  if (columnIds === undefined) {
    return doc.columnOrder;
  }
  if (!Array.isArray(columnIds)) {
    return [];
  }
  const wanted = new Set(columnIds.map((id) => String(id)));
  return doc.columnOrder.filter((columnId) => wanted.has(String(columnId)));
}

function selectRows(doc: SheetDocument, rowIds: GridReadRowsOptions['rowIds']): readonly RowId[] {
  const order = displayRowOrder(doc);
  if (rowIds === undefined) {
    return order;
  }
  if (!Array.isArray(rowIds)) {
    return [];
  }
  const wanted = new Set(rowIds.map((id) => String(id)));
  return order.filter((rowId) => wanted.has(String(rowId)));
}

export function readRows(doc: SheetDocument, options?: GridReadRowsOptions): GridRowData[] {
  const columns = selectColumns(doc, options?.columnIds);
  const rows = selectRows(doc, options?.rowIds);
  const out: GridRowData[] = [];
  for (const rowId of rows) {
    const cells: Record<string, string> = {};
    // 空の行は列を走査しない（疎な表で O(行×列) にしない・DocumentView.queryRange と同じ）。
    const slot = slotOf(doc, rowId);
    if (slot !== undefined && doc.cells.hasRow(slot)) {
      for (const columnId of columns) {
        const record = getCell(doc, rowId, columnId);
        if (record === undefined) {
          continue;
        }
        const text = cellScalarToDisplay(record.value);
        if (text !== '') {
          cells[String(columnId)] = text;
        }
      }
    }
    out.push({ rowId: String(rowId), cells });
  }
  return out;
}
