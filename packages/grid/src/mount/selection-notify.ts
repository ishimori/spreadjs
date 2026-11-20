// 選択の変更の通知（selection-change）と今の選択（GridInstance.selection）。DD-070-2。
//
// 選択の正本は editor（activeCell）と selection-controller（明示レンジ・ドラッグ）で、本モジュールは読むだけ。
// 描画のループ（rAF）の終わりに今の選択を ID で組み立て、前に知らせた内容と変わったときだけ 1 回知らせる
// （ドラッグ・キーや API の連打は 1 フレームに 1 回へまとまる。ループの外で出すので、購読者から命令 API を呼んでも
// editor の処理の途中と競合しない）。行の並びが変わって番号だけが変わったときは ID が同じなので知らせない。

import { singleCell } from '@nanairo-sheet/selection';
import type { CellRange } from '@nanairo-sheet/selection';

import type { GridBackend } from '../grid-backend';
import type { GridCellRange, GridCellRef, GridEvent, GridSelection } from '../index';
import type { IntegrationEditor } from '../integration-editor';
import type { SelectionController } from '../selection-controller';

export interface SelectionNotifyDeps {
  readonly selectionCtrl: Pick<SelectionController, 'getDragRange' | 'selectedRange'>;
  backend(): Pick<GridBackend, 'view'> | undefined;
  editor(): Pick<IntegrationEditor, 'session'> | undefined;
  isFirstDataDrawn(): boolean;
  isDestroyed(): boolean;
  emit(event: GridEvent): void;
}

export interface SelectionNotify {
  /** 今の選択（boot 前・行が無い・destroy 後は両方 null）。 */
  current(): GridSelection;
  /** 描画のループの終わりに呼ぶ。前に知らせた内容と変わっていれば selection-change を出す。 */
  check(): void;
}

const EMPTY: GridSelection = { activeCell: null, range: null };

function keyOf(selection: GridSelection): string {
  const { activeCell, range } = selection;
  const a = activeCell === null ? '' : `${activeCell.rowId}\u0000${activeCell.columnId}`;
  const r =
    range === null ? '' : `${range.startRowId}\u0000${range.startColumnId}\u0000${range.endRowId}\u0000${range.endColumnId}`;
  return `${a}\u0001${r}`;
}

export function createSelectionNotify(deps: SelectionNotifyDeps): SelectionNotify {
  let lastKey: string | null = null;

  function current(): GridSelection {
    if (deps.isDestroyed()) {
      return EMPTY;
    }
    const view = deps.backend()?.view;
    const editor = deps.editor();
    if (view === undefined || editor === undefined) {
      return EMPTY;
    }
    const active = editor.session.getActiveCell();
    const activeRowId = view.rowIdAt(active.row);
    const activeColumnId = view.columnIdAt(active.col);
    if (activeRowId === undefined || activeColumnId === undefined) {
      return EMPTY;
    }
    const activeCell: GridCellRef = { rowId: String(activeRowId), columnId: String(activeColumnId) };
    // 枠を描いている範囲（ドラッグ中はドラッグの範囲・明示レンジ・1 セル〔結合の左上なら結合全体〕）。
    const drawn: CellRange = deps.selectionCtrl.getDragRange() ?? deps.selectionCtrl.selectedRange(active);
    return { activeCell, range: toIdRange(view, drawn) ?? toIdRange(view, singleCell(active)) };
  }

  return {
    current,
    check() {
      if (deps.isDestroyed() || !deps.isFirstDataDrawn()) {
        return;
      }
      const selection = current();
      const key = keyOf(selection);
      if (key === lastKey) {
        return;
      }
      lastKey = key;
      deps.emit({ type: 'selection-change', activeCell: selection.activeCell, range: selection.range });
    },
  };
}

/** 表示 index の半開区間を左上・右下の ID へ。表示の外にはみ出す端は表示の中へ詰める（無ければ null）。 */
function toIdRange(view: Pick<GridBackend['view'], 'rowIdAt' | 'columnIdAt'>, range: CellRange): GridCellRange | null {
  const startRowId = view.rowIdAt(range.rowStart);
  const startColumnId = view.columnIdAt(range.colStart);
  const endRowId = view.rowIdAt(range.rowEnd - 1);
  const endColumnId = view.columnIdAt(range.colEnd - 1);
  if (startRowId === undefined || startColumnId === undefined || endRowId === undefined || endColumnId === undefined) {
    return null;
  }
  return {
    startRowId: String(startRowId),
    startColumnId: String(startColumnId),
    endRowId: String(endRowId),
    endColumnId: String(endColumnId),
  };
}
