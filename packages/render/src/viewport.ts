// ViewportTransform: scrollTop/Left・固定行列・viewport サイズから、4 象限 pane ごとの
// 可視範囲（overscan 込み）・セル矩形・ヒットテストを算出する（計画書 §12.2・§12.6・§13.3）。
//
// 座標変換はここへ集約し、描画（base/overlay）・ヒットテスト・将来の textarea 位置で
// 同一実装を使う（§12.2）。DOM 非依存の純粋計算（Canvas も scroll 要素も参照しない）。
//
// 座標モデル:
//   - header gutter: 左に幅 headerWidth（行番号列）・上に高さ headerHeight（列記号行）。常に固定。
//   - 固定行/列: データ先頭 frozenRowCount 行・frozenColCount 列。スクロールしても動かない。
//   - スクロール列の viewport X = headerWidth + colAxis.offsetOf(c) - scrollLeft
//     （固定列は scrollLeft=0 と同じ式。offsetOf(frozenColCount) が固定幅）。行も同様。

import type { ColumnId, RowId } from '@nanairo-sheet/types';

import type { Axis } from './axis';

/** 4 象限の pane 種別。 */
export type PaneId = 'corner' | 'top' | 'left' | 'body';

/** 半開区間 [start, end) の index 範囲。 */
export interface IndexRange {
  readonly start: number;
  readonly end: number;
}

/** 1 pane の可視 index 範囲。 */
export interface PaneRange {
  readonly pane: PaneId;
  readonly rows: IndexRange;
  readonly cols: IndexRange;
  /** この pane の viewport クリップ矩形（CSS px）。 */
  readonly clip: CellRect;
}

/** CSS px の矩形。 */
export interface CellRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** ヒットテスト結果（§12.6）。 */
export interface GridHit {
  /** DD-070-7: `none` は見えている列が無い所（全部の列を隠した・固定列の右に見えている列が無い）。 */
  readonly area: 'cell' | 'row-header' | 'column-header' | 'corner' | 'none';
  readonly rowIndex: number;
  readonly colIndex: number;
  readonly rowId?: RowId;
  readonly columnId?: ColumnId;
  /** セル/ヘッダー内の相対座標（CSS px）。 */
  readonly localX: number;
  readonly localY: number;
}

/** ViewportTransform 構築パラメータ。 */
export interface ViewportConfig {
  readonly rowAxis: Axis<RowId>;
  readonly colAxis: Axis<ColumnId>;
  readonly headerWidth: number;
  readonly headerHeight: number;
  readonly frozenRowCount: number;
  readonly frozenColCount: number;
  /** Canvas（＝可視領域）の CSS 幅・高さ。 */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  /** overscan（px）。縦は画面高の 0.5〜1.0 倍が目安（§13.3）。 */
  readonly overscanX: number;
  readonly overscanY: number;
}

export interface ViewportTransform {
  /** 4 象限 pane の可視範囲（描画対象が無い pane は空 range）。 */
  panes(): readonly PaneRange[];
  /** セル (rowIndex, colIndex) の viewport 矩形（CSS px）。固定セルはスクロール非依存。 */
  cellRect(rowIndex: number, colIndex: number): CellRect;
  /** 列記号ヘッダー（列 colIndex）の矩形。 */
  columnHeaderRect(colIndex: number): CellRect;
  /** 行番号ヘッダー（行 rowIndex）の矩形。 */
  rowHeaderRect(rowIndex: number): CellRect;
  /** point→cell/ヘッダーのヒットテスト（DOM 非探索）。 */
  hitTest(x: number, y: number): GridHit;
  /** 現在の pane 群で描画される可視セル総数（overscan 込み）。 */
  visibleCellCount(): number;
  /** スクロール可能な内容サイズ（spacer の寸法に使う）。 */
  scrollableWidth(): number;
  scrollableHeight(): number;
  /** 固定領域の寸法（header は含まない）。 */
  frozenWidth(): number;
  frozenHeight(): number;
}

function clampRange(start: number, end: number, min: number, max: number): IndexRange {
  const s = Math.min(Math.max(start, min), max);
  const e = Math.min(Math.max(end, s), max);
  return { start: s, end: e };
}

export function createViewportTransform(config: ViewportConfig): ViewportTransform {
  const {
    rowAxis,
    colAxis,
    headerWidth,
    headerHeight,
    viewportWidth,
    viewportHeight,
    scrollLeft,
    scrollTop,
    overscanX,
    overscanY,
  } = config;

  const rowCount = rowAxis.count();
  const colCount = colAxis.count();
  const frozenRowCount = Math.min(Math.max(config.frozenRowCount, 0), rowCount);
  const frozenColCount = Math.min(Math.max(config.frozenColCount, 0), colCount);

  const frozenWidth = colAxis.offsetOf(frozenColCount);
  const frozenHeight = rowAxis.offsetOf(frozenRowCount);
  const bodyOriginX = headerWidth + frozenWidth;
  const bodyOriginY = headerHeight + frozenHeight;

  // スクロール列の viewport X（固定列も同式・scrollLeft=0 相当）。
  const colViewportX = (colIndex: number): number =>
    headerWidth + colAxis.offsetOf(colIndex) - (colIndex < frozenColCount ? 0 : scrollLeft);
  const rowViewportY = (rowIndex: number): number =>
    headerHeight + rowAxis.offsetOf(rowIndex) - (rowIndex < frozenRowCount ? 0 : scrollTop);

  // 固定列 index 範囲: [0, frozenColCount)。
  const frozenColRange: IndexRange = { start: 0, end: frozenColCount };
  const frozenRowRange: IndexRange = { start: 0, end: frozenRowCount };

  // 可視スクロール列範囲（overscan 込み・[frozenColCount, colCount) にクランプ）。
  const scrollColRange = (): IndexRange => {
    if (bodyOriginX >= viewportWidth || frozenColCount >= colCount) {
      return { start: frozenColCount, end: frozenColCount };
    }
    // 左端 content offset = frozenWidth + scrollLeft、右端 = scrollLeft + (viewportWidth - headerWidth)。
    const leftContent = frozenWidth + scrollLeft - overscanX;
    const rightContent = scrollLeft + (viewportWidth - headerWidth) + overscanX;
    const start = Math.max(colAxis.indexAt(leftContent), frozenColCount);
    const end = colAxis.indexAt(rightContent) + 1; // end は排他
    return clampRange(start, end, frozenColCount, colCount);
  };

  const scrollRowRange = (): IndexRange => {
    if (bodyOriginY >= viewportHeight || frozenRowCount >= rowCount) {
      return { start: frozenRowCount, end: frozenRowCount };
    }
    const topContent = frozenHeight + scrollTop - overscanY;
    const bottomContent = scrollTop + (viewportHeight - headerHeight) + overscanY;
    const start = Math.max(rowAxis.indexAt(topContent), frozenRowCount);
    const end = rowAxis.indexAt(bottomContent) + 1;
    return clampRange(start, end, frozenRowCount, rowCount);
  };

  const makeClip = (x: number, y: number, right: number, bottom: number): CellRect => ({
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  });

  const transform: ViewportTransform = {
    panes() {
      const sCols = scrollColRange();
      const sRows = scrollRowRange();
      const result: PaneRange[] = [];
      // corner: 固定行 ∩ 固定列
      result.push({
        pane: 'corner',
        rows: frozenRowRange,
        cols: frozenColRange,
        clip: makeClip(headerWidth, headerHeight, bodyOriginX, bodyOriginY),
      });
      // top: 固定行 ∩ スクロール列
      result.push({
        pane: 'top',
        rows: frozenRowRange,
        cols: sCols,
        clip: makeClip(bodyOriginX, headerHeight, viewportWidth, bodyOriginY),
      });
      // left: スクロール行 ∩ 固定列
      result.push({
        pane: 'left',
        rows: sRows,
        cols: frozenColRange,
        clip: makeClip(headerWidth, bodyOriginY, bodyOriginX, viewportHeight),
      });
      // body: スクロール行 ∩ スクロール列
      result.push({
        pane: 'body',
        rows: sRows,
        cols: sCols,
        clip: makeClip(bodyOriginX, bodyOriginY, viewportWidth, viewportHeight),
      });
      return result;
    },
    cellRect(rowIndex, colIndex) {
      return {
        x: colViewportX(colIndex),
        y: rowViewportY(rowIndex),
        width: colAxis.size(colIndex),
        height: rowAxis.size(rowIndex),
      };
    },
    columnHeaderRect(colIndex) {
      return {
        x: colViewportX(colIndex),
        y: 0,
        width: colAxis.size(colIndex),
        height: headerHeight,
      };
    },
    rowHeaderRect(rowIndex) {
      return {
        x: 0,
        y: rowViewportY(rowIndex),
        width: headerWidth,
        height: rowAxis.size(rowIndex),
      };
    },
    hitTest(x, y) {
      // 列方向の解決。
      let colIndex: number;
      if (x < headerWidth) {
        colIndex = -1;
      } else if (x < bodyOriginX) {
        // 固定列バンド（スクロール非依存）。
        colIndex = Math.min(colAxis.indexAt(x - headerWidth), Math.max(frozenColCount - 1, 0));
      } else {
        colIndex = Math.max(colAxis.indexAt(x - headerWidth + scrollLeft), frozenColCount);
      }
      // 行方向の解決。
      let rowIndex: number;
      if (y < headerHeight) {
        rowIndex = -1;
      } else if (y < bodyOriginY) {
        rowIndex = Math.min(rowAxis.indexAt(y - headerHeight), Math.max(frozenRowCount - 1, 0));
      } else {
        rowIndex = Math.max(rowAxis.indexAt(y - headerHeight + scrollTop), frozenRowCount);
      }

      // 領域判定。
      if (y < headerHeight && x < headerWidth) {
        return { area: 'corner', rowIndex: -1, colIndex: -1, localX: x, localY: y };
      }
      // DD-070-7（Codex P1）: 当たった列が隠した列（幅 0）なら、見えている列が無い所（セルにも見出しにも境界にもしない）。
      if (colIndex >= 0 && colIndex < colAxis.count() && colAxis.size(colIndex) === 0) {
        return { area: 'none', rowIndex: -1, colIndex: -1, localX: x, localY: y };
      }
      if (y < headerHeight && x < headerWidth) {
        return { area: 'corner', rowIndex: -1, colIndex: -1, localX: x, localY: y };
      }
      if (y < headerHeight) {
        const rect = transform.columnHeaderRect(colIndex);
        return {
          area: 'column-header',
          rowIndex: -1,
          colIndex,
          columnId: colAxis.getId(colIndex),
          localX: x - rect.x,
          localY: y,
        };
      }
      if (x < headerWidth) {
        const rect = transform.rowHeaderRect(rowIndex);
        return {
          area: 'row-header',
          rowIndex,
          colIndex: -1,
          rowId: rowAxis.getId(rowIndex),
          localX: x,
          localY: y - rect.y,
        };
      }
      const rect = transform.cellRect(rowIndex, colIndex);
      return {
        area: 'cell',
        rowIndex,
        colIndex,
        rowId: rowAxis.getId(rowIndex),
        columnId: colAxis.getId(colIndex),
        localX: x - rect.x,
        localY: y - rect.y,
      };
    },
    visibleCellCount() {
      let total = 0;
      for (const pane of transform.panes()) {
        total += (pane.rows.end - pane.rows.start) * (pane.cols.end - pane.cols.start);
      }
      return total;
    },
    scrollableWidth() {
      return headerWidth + colAxis.totalSize();
    },
    scrollableHeight() {
      return headerHeight + rowAxis.totalSize();
    },
    frozenWidth() {
      return frozenWidth;
    },
    frozenHeight() {
      return frozenHeight;
    },
  };
  return transform;
}
