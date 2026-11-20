// 選択の変更の通知（selection-change）と今の選択（GridInstance.selection）。DD-070-2。
//
// 選択の正本は editor（activeCell）と selection-controller（明示レンジ・ドラッグ）で、本モジュールは読むだけ。
// 描画のループ（rAF）の終わりに今の選択を ID で組み立て、前に知らせた内容と変わったときだけ 1 回知らせる
// （ドラッグ・キーや API の連打は 1 フレームに 1 回へまとまる。ループの外で出すので、購読者から命令 API を呼んでも
// editor の処理の途中と競合しない）。行の並びが変わって番号だけが変わったときは ID が同じなので知らせない。
//
// 毎フレームの費用（Codex P2）: 選択を組み立てる元（アクティブセルの番号・selection-controller の版・行 Axis の再構築の回数・
// 張った結合）が前のフレームと同じなら、範囲を組み立て直さない（結合を含めた広げ直しを毎フレーム走らせない）。

import { singleCell } from '@nanairo-sheet/selection';
import type { CellRange, MergeIndex } from '@nanairo-sheet/selection';

import type { GridBackend } from '../grid-backend';
import type { GridCellRange, GridCellRef, GridEvent, GridSelection } from '../index';
import type { IntegrationEditor } from '../integration-editor';
import type { SelectionController } from '../selection-controller';

export interface SelectionNotifyDeps {
  readonly selectionCtrl: Pick<SelectionController, 'getDragRange' | 'selectedRange' | 'revision'>;
  backend(): Pick<GridBackend, 'view'> | undefined;
  editor(): Pick<IntegrationEditor, 'session'> | undefined;
  /** 張った結合（同じ内容の間は同じ参照）。組み立て直しの要否の判定に使う。 */
  merges(): MergeIndex;
  isFirstDataDrawn(): boolean;
  isDestroyed(): boolean;
  /** 保留中の行の構造変更（setData・行の挿入削除の直後）を今すぐ Axis へ反映する（selection() の同期の読み取り用）。 */
  flushPendingStructure(): void;
  emit(event: GridEvent): void;
}

export interface SelectionNotify {
  /** 今の選択（保留中の構造変更を反映してから読む。boot 前・行が無い・destroy 後は両方 null）。 */
  current(): GridSelection;
  /** 描画のループの終わりに呼ぶ。前に知らせた内容と変わっていれば selection-change を出す。 */
  check(): void;
}

const EMPTY: GridSelection = { activeCell: null, range: null };

/** 組み立ての元。全部が前と同じなら選択も同じ（ID は行 Axis が作り直されない限り番号から一意に決まる）。 */
interface Source {
  readonly row: number;
  readonly col: number;
  readonly selectionRevision: number;
  readonly structuralRebuilds: number;
  readonly merges: MergeIndex;
}

function sameSource(a: Source | null, b: Source): boolean {
  return (
    a !== null &&
    a.row === b.row &&
    a.col === b.col &&
    a.selectionRevision === b.selectionRevision &&
    a.structuralRebuilds === b.structuralRebuilds &&
    a.merges === b.merges
  );
}

function sameCellRef(a: GridCellRef | null, b: GridCellRef | null): boolean {
  return a === b || (a !== null && b !== null && a.rowId === b.rowId && a.columnId === b.columnId);
}

function sameRange(a: GridCellRange | null, b: GridCellRange | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.startRowId === b.startRowId &&
      a.startColumnId === b.startColumnId &&
      a.endRowId === b.endRowId &&
      a.endColumnId === b.endColumnId)
  );
}

export function createSelectionNotify(deps: SelectionNotifyDeps): SelectionNotify {
  let lastSelection: GridSelection | null = null;
  let lastSource: Source | null = null;

  /** 今の Axis のまま選択を組み立てる（保留中の構造変更は反映しない＝描画のループの中で使う）。 */
  function build(): { readonly selection: GridSelection; readonly source: Source | null } {
    if (deps.isDestroyed()) {
      return { selection: EMPTY, source: null };
    }
    const view = deps.backend()?.view;
    const editor = deps.editor();
    if (view === undefined || editor === undefined) {
      return { selection: EMPTY, source: null };
    }
    const active = editor.session.getActiveCell();
    const source: Source = {
      row: active.row,
      col: active.col,
      selectionRevision: deps.selectionCtrl.revision(),
      structuralRebuilds: view.structuralRebuildCount,
      merges: deps.merges(),
    };
    const activeRowId = view.rowIdAt(active.row);
    const activeColumnId = view.columnIdAt(active.col);
    if (activeRowId === undefined || activeColumnId === undefined) {
      return { selection: EMPTY, source };
    }
    const activeCell: GridCellRef = { rowId: String(activeRowId), columnId: String(activeColumnId) };
    // 枠を描いている範囲（ドラッグ中はドラッグの範囲・明示レンジ・1 セル〔結合の左上なら結合全体〕）。
    const drawn: CellRange = deps.selectionCtrl.getDragRange() ?? deps.selectionCtrl.selectedRange(active);
    return { selection: { activeCell, range: toIdRange(view, drawn) ?? toIdRange(view, singleCell(active)) }, source };
  }

  return {
    current() {
      if (deps.isDestroyed()) {
        return EMPTY;
      }
      // Codex P2: setData・行の挿入削除の直後に同じ処理の中で読んでも、新しい行の並び（と再ベースした選択）で返す。
      deps.flushPendingStructure();
      return build().selection;
    },
    check() {
      if (deps.isDestroyed() || !deps.isFirstDataDrawn()) {
        return;
      }
      const view = deps.backend()?.view;
      const editor = deps.editor();
      if (view !== undefined && editor !== undefined && lastSelection !== null) {
        const active = editor.session.getActiveCell();
        const probe: Source = {
          row: active.row,
          col: active.col,
          selectionRevision: deps.selectionCtrl.revision(),
          structuralRebuilds: view.structuralRebuildCount,
          merges: deps.merges(),
        };
        if (sameSource(lastSource, probe)) {
          return; // 元が同じ＝選択も同じ（組み立て直さない）
        }
      }
      const { selection, source } = build();
      lastSource = source;
      if (
        lastSelection !== null &&
        sameCellRef(lastSelection.activeCell, selection.activeCell) &&
        sameRange(lastSelection.range, selection.range)
      ) {
        return;
      }
      lastSelection = selection;
      deps.emit({ type: 'selection-change', activeCell: selection.activeCell, range: selection.range });
    },
  };
}

/** 表示 index の半開区間を左上・右下の ID へ（端が表示の外なら null）。 */
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
