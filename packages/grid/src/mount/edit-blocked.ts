// 読むだけのセルへの編集を止めたときの consumer への通知（DD-069）。`edit-blocked`（選択中のセル・ダブルクリックしたセル）と
// `cells-skipped`（範囲の操作で飛ばしたセル）を組み立てて GridEvent として出す。止める判断そのものは従来どおり keyboard・
// pointer・edit-commands・cell-lock が持ち、ここは「どのセルを・何の操作で・なぜ」を公開の形にするだけ（DOM 非依存）。

import { mergeAnchorOf } from '@nanairo-sheet/selection';

import type { GridBackend } from '../grid-backend';
import type { GridCellRef, GridEditBlockedInput, GridEditBlockedReason, GridEvent } from '../index';
import type { IntegrationEditor } from '../integration-editor';
import type { CellLock } from './cell-lock';
import type { MountMerges } from './merges';

/**
 * 選択中のセルで編集を始めるキーを、通知の操作へ写す（編集を始めないキーは undefined）。F2・Delete・Backspace は修飾の有無に
 * よらない（readonly-policy の抑止と同じ）。印字キーは修飾なしの 1 文字と、日本語入力オンの打鍵（key が `Process`）。
 */
export function blockedKeyInput(input: { readonly key: string; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly altKey: boolean }):
  | GridEditBlockedInput
  | undefined {
  if (input.key === 'F2') {
    return 'f2';
  }
  if (input.key === 'Delete' || input.key === 'Backspace') {
    return 'delete';
  }
  if (input.ctrlKey || input.metaKey || input.altKey) {
    return undefined;
  }
  return input.key === 'Process' || input.key.length === 1 ? 'key' : undefined;
}

export interface EditBlockedDeps {
  emit(event: GridEvent): void;
  backend(): GridBackend | undefined;
  editor(): IntegrationEditor | undefined;
  readonly cellLock: Pick<CellLock, 'isReadOnlyColumnIndex' | 'isReadOnlyRowIndex' | 'isReadOnlyCellIndex'>;
  readonly merges: Pick<MountMerges, 'isMergedCellIndex' | 'current'>;
  isReadOnly(): boolean;
}

export interface EditBlocked {
  /** 選択中のセルで止めた（キー・表全体が読み取り専用のときの貼り付け・切り取り・範囲の消去）。読むだけでなければ出さない。 */
  atActive(input: GridEditBlockedInput): void;
  /** 表示 index のセルで止めた（ダブルクリック）。結合範囲の中なら左上のセルとして知らせる。読むだけでなければ出さない。 */
  atCell(row: number, col: number, input: GridEditBlockedInput): void;
  /** 範囲の操作で飛ばしたセル（0 件なら出さない）。 */
  skipped(operation: 'paste' | 'cut' | 'clear', cells: readonly GridCellRef[]): void;
}

export function createEditBlocked(deps: EditBlockedDeps): EditBlocked {
  const { cellLock, merges } = deps;

  /** 止めた理由。重なるときは 表全体 → 結合範囲 → 行 → 列 → 行データのセル の順で先のものを選ぶ。 */
  function reasonAt(row: number, col: number): GridEditBlockedReason | undefined {
    if (deps.isReadOnly()) {
      return 'grid-readonly';
    }
    if (merges.isMergedCellIndex(row, col)) {
      return 'merged';
    }
    if (cellLock.isReadOnlyRowIndex(row)) {
      return 'readonly-row';
    }
    if (cellLock.isReadOnlyColumnIndex(col)) {
      return 'readonly-column';
    }
    return cellLock.isReadOnlyCellIndex(row, col) ? 'readonly-cell' : undefined;
  }

  function notify(row: number, col: number, input: GridEditBlockedInput): void {
    const backend = deps.backend();
    const reason = reasonAt(row, col);
    if (backend === undefined || reason === undefined) {
      return;
    }
    const anchor = mergeAnchorOf(merges.current(), { row, col });
    const rowId = backend.view.rowIdAt(anchor.row);
    const columnId = backend.view.columnIdAt(anchor.col);
    if (rowId === undefined || columnId === undefined) {
      return;
    }
    deps.emit({ type: 'edit-blocked', rowId: String(rowId), columnId: String(columnId), input, reason });
  }

  return {
    atActive(input) {
      const editor = deps.editor();
      if (editor !== undefined) {
        const active = editor.session.getActiveCell();
        notify(active.row, active.col, input);
      }
    },
    atCell: notify,
    skipped(operation, cells) {
      if (cells.length > 0) {
        deps.emit({ type: 'cells-skipped', operation, cells: [...cells] });
      }
    },
  };
}
