// 表のデータを読む（GridInstance.getRows・DD-070-5）。文書（自分の未確定の変更を含む view）から、文書の並びで行を読む純粋関数。
// 返す形は単独モードの行データ（GridStandaloneRow）と同じ `{ rowId, cells }`（空のセルは載せない・値は cell-commit と同じ表示文字列）
// なので、そのまま setData に渡せば同じ表になる。画面だけの並べ替え・絞り込み（DD-070-8）の影響は受けない（文書の並び・全部の行）。

import { displayRowOrder, slotOf } from '@nanairo-sheet/core';
import type { SheetDocument } from '@nanairo-sheet/core';
import type { ColumnId, RowId } from '@nanairo-sheet/types';

import { cellScalarToDisplay } from '../document-view';
import type { GridBackend } from '../grid-backend';
import type { GridReadRowsOptions, GridRowData } from '../index';

/** 文字列の ID だけを集める（Codex P3: `String(null)` が実在の列 'null' に一致する・toString の無い値で例外になるのを防ぐ）。 */
function stringIds(ids: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    if (typeof id === 'string') {
      out.add(id);
    }
  }
  return out;
}

/**
 * GridInstance.getRows の本体（DD-070-5）。自分の未確定の変更を含む view を読む。共同編集でサーバーの初回の状態を
 * 受け取る前は空（Codex P2: その間の view はサーバーの既存の行を欠く＝一部の行だけを返さない）。
 */
export function readRowsFromBackend(backend: Pick<GridBackend, 'session'> | undefined, options?: GridReadRowsOptions): GridRowData[] {
  if (backend === undefined || backend.session.hasInitialState === false) {
    return [];
  }
  return readRows(backend.session.viewDocument, options);
}

/**
 * options を検査して読む列と、その列の位置（columnOrder の index）を決める（未知は静かに無視。配列でなければ空）。
 * 位置を行のループの外で一度だけ引く（Codex P2: getCell は呼ぶたびに columnOrder.indexOf する＝5 万行で数百万回の比較）。
 */
function selectColumns(doc: SheetDocument, columnIds: GridReadRowsOptions['columnIds']): ReadonlyArray<readonly [ColumnId, number]> {
  const all = doc.columnOrder.map((columnId, index) => [columnId, index] as const);
  if (columnIds === undefined) {
    return all;
  }
  if (!Array.isArray(columnIds)) {
    return [];
  }
  const wanted = stringIds(columnIds);
  return all.filter(([columnId]) => wanted.has(String(columnId)));
}

function selectRows(doc: SheetDocument, rowIds: GridReadRowsOptions['rowIds']): readonly RowId[] {
  const order = displayRowOrder(doc);
  if (rowIds === undefined) {
    return order;
  }
  if (!Array.isArray(rowIds)) {
    return [];
  }
  const wanted = stringIds(rowIds);
  return order.filter((rowId) => wanted.has(String(rowId)));
}

export function readRows(doc: SheetDocument, options?: GridReadRowsOptions): GridRowData[] {
  const columns = selectColumns(doc, options?.columnIds);
  const rows = selectRows(doc, options?.rowIds);
  const out: GridRowData[] = [];
  for (const rowId of rows) {
    // Codex P2: 列 ID は任意の文字列（`__proto__`・`toString` も有効）なので、プロトタイプの無い辞書に入れる。
    const cells = Object.create(null) as Record<string, string>;
    // 空の行は列を走査しない（疎な表で O(行×列) にしない・DocumentView.queryRange と同じ）。
    const slot = slotOf(doc, rowId);
    if (slot !== undefined && doc.cells.hasRow(slot)) {
      for (const [columnId, columnIndex] of columns) {
        const record = doc.cells.get(slot, columnIndex);
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
