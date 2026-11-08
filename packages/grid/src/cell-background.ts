// cell-background（DD-069）: セルごとの背景色（GridStandaloneRow.cellBackgrounds・setCellBackgrounds）の置き場（DOM 非依存）。
//
// 背景色は文書のデータではなく view-local（値・Undo・cell-commit・protocol に入れない）。描画は render の
// background-bands（cellBackgroundsInRow フック）。置き場と注入の決まりは cell-status（DD-060〜062）と同じにする。

import { isPlainRecord } from './cell-status';

/**
 * セルごとの背景色の置き場（DD-069・view-local）。RowId → ColumnId → CSS color。単独モードの `setRows`／`setData`／
 * `initialData` の `cellBackgrounds` と、両モード共通の `setCellBackgrounds` が同じ置き場を使う。
 */
export interface CellBackgroundStore {
  /**
   * 1 行の背景を丸ごと置き換える（`{}` で消す）。Record でない値はその行を変えずに RowId を `invalid` へ積み、
   * 色が文字列でない・空白だけのセルは落として `RowId/ColumnId` を積む。置き換えたら true。
   */
  replaceRow(rowId: string, cellBackgrounds: unknown, invalid: string[]): boolean;
  /** 全部消す（単独モードの `setData`＝文書の丸ごと差し替え）。 */
  clear(): void;
  /** この行で背景色を持つセル（ColumnId → CSS color）。無ければ undefined（描画フックが行ごとに引く）。 */
  row(rowId: string): ReadonlyMap<string, string> | undefined;
  /** 1 件でも背景色があるか（描画フックの早期リターン用）。 */
  hasAny(): boolean;
}

/**
 * 置き場を作る。`isKnownColumn` があれば未知の列を入力時に静かに落とす（単独モード＝列が mount 時に確定）。無ければ列を
 * そのまま持ち、描画側で解決できない列を描かない（共同編集モード）。渡されたオブジェクトは保持せず写しを作る。
 * CSS の色としての妥当性は検査しない（`rowBackgrounds` と同じ。不正な色は描画側で pane の背景になる）。
 */
export function createCellBackgroundStore(isKnownColumn: ((columnId: string) => boolean) | undefined): CellBackgroundStore {
  const byRow = new Map<string, ReadonlyMap<string, string>>();
  return {
    replaceRow(rowId, cellBackgrounds, invalid) {
      if (!isPlainRecord(cellBackgrounds)) {
        invalid.push(rowId);
        return false;
      }
      const colors = new Map<string, string>();
      for (const [columnId, color] of Object.entries(cellBackgrounds)) {
        if (isKnownColumn !== undefined && !isKnownColumn(columnId)) {
          continue;
        }
        if (typeof color !== 'string' || color.trim() === '') {
          invalid.push(`${rowId}/${columnId}`);
          continue;
        }
        colors.set(columnId, color);
      }
      if (colors.size > 0) {
        byRow.set(rowId, colors);
      } else {
        byRow.delete(rowId);
      }
      return true;
    },
    clear() {
      byRow.clear();
    },
    row: (rowId) => byRow.get(rowId),
    hasAny: () => byRow.size > 0,
  };
}

/** 無視した不正な指定（`replaceRow` が積んだもの）を1件の診断メッセージにまとめる。 */
export function cellBackgroundInvalidMessage(invalid: readonly string[]): string {
  return (
    `cellBackgrounds: 不正な指定 ${invalid.join(', ')} を無視しました（RowId/ColumnId は色が文字列でない・空白だけのセル、` +
    'RowId だけのものは cellBackgrounds がオブジェクトでない行）'
  );
}
