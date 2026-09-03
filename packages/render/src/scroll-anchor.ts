// ScrollAnchor（計画書 §13.4）: 行高変更・行挿入・リモート構造更新で画面が跳ばないよう、
// スクロール域先頭の論理セル（rowId＋行内オフセット / columnId＋列内オフセット）を保持し、
// 構造変更後に同じ ID を基準に scrollTop/Left を補正する。DOM 非依存の純粋計算。

import type { ColumnId, RowId } from '@nanairo-sheet/types';

import type { Axis } from './axis';

/** §13.4 の ScrollAnchor。indexHint は PoC のアンカー行消失時フォールバック用。 */
export interface ScrollAnchor {
  readonly rowId: RowId;
  readonly offsetWithinRow: number;
  readonly columnId: ColumnId;
  readonly offsetWithinColumn: number;
  /** 捕捉時の行 index（アンカー行が削除された場合の近傍フォールバックに使う）。 */
  readonly rowIndexHint: number;
  /** 捕捉時の列 index。 */
  readonly columnIndexHint: number;
}

export interface AnchorCaptureParams {
  readonly rowAxis: Axis<RowId>;
  readonly colAxis: Axis<ColumnId>;
  readonly frozenRowCount: number;
  readonly frozenColCount: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

export interface AnchorRestoreParams {
  readonly rowAxis: Axis<RowId>;
  readonly colAxis: Axis<ColumnId>;
  readonly frozenRowCount: number;
  readonly frozenColCount: number;
  readonly anchor: ScrollAnchor;
}

/**
 * スクロール域先頭の論理セルをアンカーとして捕捉する。
 *
 * DD-036（Codex P2）: 固定数は**軸の要素数でクランプ**する（`ViewportTransform` と同じ扱い）。`frozenColCount` が
 * 列数以上（＝全列が固定でスクロール域が空）のとき、クランプしないと index が count と等しくなり `Axis.getId` が
 * 範囲外で throw して描画ループが止まる。全固定の軸では最終要素をアンカーにする（そもそもスクロールしないため
 * 補正は恒等になる）。
 */
export function captureAnchor(params: AnchorCaptureParams): ScrollAnchor {
  const { rowAxis, colAxis, scrollTop, scrollLeft } = params;
  const frozenRowCount = clampFrozen(params.frozenRowCount, rowAxis.count());
  const frozenColCount = clampFrozen(params.frozenColCount, colAxis.count());
  const frozenHeight = rowAxis.offsetOf(frozenRowCount);
  const frozenWidth = colAxis.offsetOf(frozenColCount);

  // スクロール域の見えている先頭の content 座標。
  const topContent = frozenHeight + scrollTop;
  const leftContent = frozenWidth + scrollLeft;
  const rowIndex = clampIndex(Math.max(rowAxis.indexAt(topContent), frozenRowCount), rowAxis.count());
  const colIndex = clampIndex(Math.max(colAxis.indexAt(leftContent), frozenColCount), colAxis.count());

  return {
    rowId: rowAxis.getId(rowIndex),
    offsetWithinRow: topContent - rowAxis.offsetOf(rowIndex),
    columnId: colAxis.getId(colIndex),
    offsetWithinColumn: leftContent - colAxis.offsetOf(colIndex),
    rowIndexHint: rowIndex,
    columnIndexHint: colIndex,
  };
}

/** 固定数を [0, count] へクランプする（ViewportTransform と同じ扱い・DD-036）。 */
function clampFrozen(frozen: number, count: number): number {
  return Math.min(Math.max(frozen, 0), count);
}

/** index を実在範囲 [0, count-1] へクランプする（全固定・空 Axis で getId が throw しないように・DD-036）。 */
function clampIndex(index: number, count: number): number {
  return Math.min(Math.max(index, 0), Math.max(count - 1, 0));
}

/** 削除でアンカー ID が消えた場合に、index ヒントを新 count でクランプして近傍へフォールバック。 */
function resolveIndex<Id extends string>(axis: Axis<Id>, id: Id, indexHint: number): number {
  const found = axis.getIndex(id);
  if (found >= 0) {
    return found;
  }
  const count = axis.count();
  if (count === 0) {
    return 0;
  }
  return Math.min(Math.max(indexHint, 0), count - 1);
}

/**
 * 構造変更後、アンカーを基準に scrollTop/Left を補正して画面が跳ばないようにする。
 * アンカー行/列が残っていればその ID 位置、削除されていれば index ヒントの近傍へ寄せる。
 */
export function correctScroll(params: AnchorRestoreParams): { scrollTop: number; scrollLeft: number } {
  const { rowAxis, colAxis, anchor } = params;
  // DD-036: 捕捉側と同じくクランプする（全固定でも offsetOf が総サイズを返し、補正が恒等になる）。
  const frozenHeight = rowAxis.offsetOf(clampFrozen(params.frozenRowCount, rowAxis.count()));
  const frozenWidth = colAxis.offsetOf(clampFrozen(params.frozenColCount, colAxis.count()));

  const rowIndex = resolveIndex(rowAxis, anchor.rowId, anchor.rowIndexHint);
  const colIndex = resolveIndex(colAxis, anchor.columnId, anchor.columnIndexHint);

  const topContent = rowAxis.offsetOf(rowIndex) + anchor.offsetWithinRow;
  const leftContent = colAxis.offsetOf(colIndex) + anchor.offsetWithinColumn;

  return {
    scrollTop: Math.max(0, topContent - frozenHeight),
    scrollLeft: Math.max(0, leftContent - frozenWidth),
  };
}
