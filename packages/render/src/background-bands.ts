// 背景の塗り分け（DD-036 C2 の列・DD-045 の行・DD-069 のセル）。base-layer.ts から切り出した
// （DD-069: base-layer.ts がファイルの行数の上限〔DD-065 サイズのガード〕を超えていて、機能を足す前に空ける必要があった）。
//
// 重ね順: pane 背景 → 列の帯 → 行の帯 → セルの背景 →（以降は base-layer）状態表示・値ベース書式の背景 → 罫線 → 文字。
// どれも罫線より前に塗る（罫線は base-layer が後から引くので消えない）。色ごとに一度 pane 背景を代入してから候補色を
// 代入する: Canvas は不正な色の代入を**無視**して直前の色を残すため、不正な色の帯・セルが前の色で塗られるのを防ぐ
// （不正な色は pane 背景で塗られる＝現行の見た目のまま・DD-036 Codex P2）。

import type { PaneRange, ViewportTransform } from './viewport';

/** 行内でセルごとの背景色を持つセル（DD-069・列 index と CSS color）。grid 側が RowId/ColumnId を描画時に index へ解決して渡す。 */
export interface CellBackgroundMark {
  readonly colIndex: number;
  readonly color: string;
}

export interface BackgroundBandsDeps {
  readonly ctx: CanvasRenderingContext2D;
  /** 列 index → CSS color（未指定列は undefined）。値によらず列全体を塗る（DD-036 C2）。 */
  readonly columnBackground?: (colIndex: number) => string | undefined;
  /** 行 index → CSS color（未指定行は undefined）。列の帯の後に塗る＝交差は行が勝つ（DD-045）。 */
  readonly rowBackground?: (rowIndex: number) => string | undefined;
  /** 行 index → その行でセルごとの背景色を持つセル（無ければ undefined）。行の帯の後に塗る＝セルが勝つ（DD-069）。 */
  readonly cellBackgroundsInRow?: (rowIndex: number) => readonly CellBackgroundMark[] | undefined;
}

export interface BackgroundBands {
  /** pane 内の指定列を「可視行範囲いっぱいの縦の帯」として 1 列 1 回で塗る（空セルも含む列全体＝列数ぶんの fillRect で足りる）。 */
  drawColumnBackgrounds(transform: ViewportTransform, pane: PaneRange, paneBackground: string): void;
  /** pane 内の指定行を「可視列範囲いっぱいの横の帯」として 1 行 1 回で塗る。 */
  drawRowBackgrounds(transform: ViewportTransform, pane: PaneRange, paneBackground: string): void;
  /** pane 内のセルごとの背景を塗る。列は pane ごとに切り分ける（固定列と本体の境界で同じセルを二重に塗らない）。 */
  drawCellBackgrounds(transform: ViewportTransform, pane: PaneRange, paneBackground: string): void;
  /** 列・行・セルの背景を重ね順どおりに矩形 1 つへ塗る（結合範囲の描き直し・DD-064。背景は左上のセルのもの）。 */
  fillLayers(row: number, col: number, x: number, y: number, width: number, height: number, paneBackground: string): void;
}

export function createBackgroundBands(deps: BackgroundBandsDeps): BackgroundBands {
  const { ctx, columnBackground, rowBackground, cellBackgroundsInRow } = deps;
  const isEmptyPane = (pane: PaneRange): boolean => pane.rows.end <= pane.rows.start || pane.cols.end <= pane.cols.start;
  const fill = (color: string, paneBackground: string, x: number, y: number, width: number, height: number): void => {
    ctx.fillStyle = paneBackground;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, width, height);
  };
  const cellBackgroundAt = (row: number, col: number): string | undefined =>
    cellBackgroundsInRow?.(row)?.find((mark) => mark.colIndex === col)?.color;

  return {
    drawColumnBackgrounds(transform, pane, paneBackground) {
      if (columnBackground === undefined || isEmptyPane(pane)) {
        return;
      }
      const top = transform.cellRect(pane.rows.start, pane.cols.start).y;
      const lastRow = transform.cellRect(pane.rows.end - 1, pane.cols.start);
      const height = lastRow.y + lastRow.height - top;
      for (let col = pane.cols.start; col < pane.cols.end; col += 1) {
        const color = columnBackground(col);
        if (color !== undefined) {
          const rect = transform.cellRect(pane.rows.start, col);
          fill(color, paneBackground, rect.x, top, rect.width, height);
        }
      }
    },
    drawRowBackgrounds(transform, pane, paneBackground) {
      if (rowBackground === undefined || isEmptyPane(pane)) {
        return;
      }
      const left = transform.cellRect(pane.rows.start, pane.cols.start).x;
      const lastCol = transform.cellRect(pane.rows.start, pane.cols.end - 1);
      const width = lastCol.x + lastCol.width - left;
      for (let row = pane.rows.start; row < pane.rows.end; row += 1) {
        const color = rowBackground(row);
        if (color !== undefined) {
          fill(color, paneBackground, left, transform.cellRect(row, pane.cols.start).y, width, transform.cellRect(row, pane.cols.start).height);
        }
      }
    },
    drawCellBackgrounds(transform, pane, paneBackground) {
      if (cellBackgroundsInRow === undefined || isEmptyPane(pane)) {
        return;
      }
      for (let row = pane.rows.start; row < pane.rows.end; row += 1) {
        const marks = cellBackgroundsInRow(row);
        if (marks === undefined) {
          continue;
        }
        for (const mark of marks) {
          if (mark.colIndex < pane.cols.start || mark.colIndex >= pane.cols.end) {
            continue;
          }
          const rect = transform.cellRect(row, mark.colIndex);
          fill(mark.color, paneBackground, rect.x, rect.y, rect.width, rect.height);
        }
      }
    },
    fillLayers(row, col, x, y, width, height, paneBackground) {
      for (const color of [columnBackground?.(col), rowBackground?.(row), cellBackgroundAt(row, col)]) {
        if (color !== undefined) {
          fill(color, paneBackground, x, y, width, height);
        }
      }
    },
  };
}
