// editor-placement（DD-005 Phase 3・§13.5・AC3）: 編集 textarea の配置矩形を ViewportTransform から算出する
// 純粋関数（DOM 非依存）。座標変換は viewport.ts へ集約されているため、ここは可視判定と pane 区別だけを担う。
//
// 固定領域とスクロール領域の pane 区別（§13.5）:
//   - スクロール pane のセルは固定バンド/ヘッダーの下へスクロールされると隠れる（minX/minY = header + frozen 寸法）。
//   - 固定行/固定列のセルはスクロールで動かない（minX/minY = header のみ）。
// transform.cellRect は固定/スクロールを内部で吸収するので、可視判定だけ pane を区別すればよい。
//
// wrap 列を編集中の textarea の高さ（RC2・DD-055）も同じく DOM 非依存の純関数としてここに置く。

import { CELL_TEXT_LINE_HEIGHT } from '@nanairo-sheet/render';
import type { CellRect, ViewportTransform } from '@nanairo-sheet/render';

export interface PlacementConfig {
  readonly headerWidth: number;
  readonly headerHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly frozenRowCount: number;
  readonly frozenColCount: number;
}

export interface EditorPlacement {
  /** 編集セルが可視データ領域に（一部でも）出ているか。false なら textarea を隠す。 */
  readonly visible: boolean;
  /** 編集セルの viewport 矩形（CSS px・base/overlay と同一座標系）。 */
  readonly rect: CellRect;
}

const HIDDEN: CellRect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * 表示 index（rowIndex/colIndex）から textarea の配置を算出する。
 * index<0（RowId/ColumnId が現在の Axis に無い＝スクロール外/削除）は非可視。
 */
export function computeEditorPlacement(
  transform: ViewportTransform,
  rowIndex: number,
  colIndex: number,
  cfg: PlacementConfig,
): EditorPlacement {
  if (rowIndex < 0 || colIndex < 0) {
    return { visible: false, rect: HIDDEN };
  }
  const rect = transform.cellRect(rowIndex, colIndex);
  // pane 区別（§13.5）: スクロールセルは frozen バンド下へ隠れうる。固定セルは header 直下から可視。
  const minX = colIndex < cfg.frozenColCount ? cfg.headerWidth : cfg.headerWidth + transform.frozenWidth();
  const minY = rowIndex < cfg.frozenRowCount ? cfg.headerHeight : cfg.headerHeight + transform.frozenHeight();
  const visible =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x + rect.width > minX &&
    rect.x < cfg.viewportWidth &&
    rect.y + rect.height > minY &&
    rect.y < cfg.viewportHeight;
  return { visible, rect };
}

/** RC2（DD-052-1）: wrap 列の編集欄が内容に合わせて下へ伸びる上限（8 行相当）。超えたら内部スクロールに切り替える。 */
export const MAX_WRAP_EDITOR_HEIGHT = 8 * CELL_TEXT_LINE_HEIGHT;

export interface WrapEditorHeightInput {
  /** 編集セルの上端（stage 座標）。 */
  readonly cellTop: number;
  readonly cellHeight: number;
  /** 編集欄の中身の高さ（textarea の scrollHeight）。 */
  readonly contentHeight: number;
  /** 可視域の下端（stage 座標・横スクロールバーを除く）。 */
  readonly visibleBottom: number;
  /** 可視域の下端で縮めるときの下限（1 行分の高さ）。 */
  readonly minHeight: number;
}

export interface WrapEditorHeight {
  readonly height: number;
  /** 中身が編集欄に収まらない（内部スクロールにする）。 */
  readonly scroll: boolean;
}

/**
 * wrap 列を編集中の編集欄の高さ（RC2・DD-055 RC17）。中身に合わせて下へ伸ばし、上限は `max(セルの高さ, 128px)`
 * （行が高いセルでもセル全体を覆う。1 行の高さのセルは従来どおり 128px まで）。可視域の下端を越える分は縮める
 * （1 行分の高さは残す）。収まらない分は内部スクロールにする。
 */
export function computeWrapEditorHeight(input: WrapEditorHeightInput): WrapEditorHeight {
  const { cellTop, cellHeight, contentHeight, visibleBottom, minHeight } = input;
  const wanted = Math.min(Math.max(cellHeight, contentHeight), Math.max(cellHeight, MAX_WRAP_EDITOR_HEIGHT));
  const height = Math.min(wanted, Math.max(visibleBottom - cellTop, Math.min(minHeight, wanted)));
  return { height, scroll: contentHeight > height };
}
