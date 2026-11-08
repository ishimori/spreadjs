// base レイヤー描画（計画書 §12.1/§12.2/§12.4/§12.5）: セル背景・文字・罫線・ヘッダー。
// 固定行列は 4 象限を clip region で 1 Canvas に描く（§12.2）。罫線は device pixel へ snap（§12.4）。
// 文字は measureText キャッシュ＋セル clip（§12.5）。可視非空セルのみ chunk-store の範囲クエリで描く。
//
// 本モジュールは Canvas API に依存する（描画アダプタの隔離）。座標計算は viewport.ts に委ね、
// ここは「与えられた ViewportTransform をどう塗るか」だけを持つ。単体テストは座標側（viewport 等）で行う。

import type { CellRange, MergeIndex } from '@nanairo-sheet/selection';

import type { ChunkStore } from './chunk-store';
import { drawBorders, drawHeaderBottomBorder, isPatternBorder, type BorderLayerDeps, type BoundaryBorder } from './border-layer';
import { deviceLineWidth, normalizeDpr, snapToDevice } from './dpi';
import { createTextMetricsCache, type TextMetricsCache } from './text-cache';
import { MAX_LEFT_INFLOW_SCAN, nearestLeftNonEmpty, overflowRightExtent } from './text-overflow';
import type { CellRect, PaneId, PaneRange, ViewportTransform } from './viewport';

/** 1 フレーム分の viewport 情報（base/overlay 共通）。 */
export interface FrameViewport {
  readonly transform: ViewportTransform;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly dpr: number;
}

/**
 * 解決済みのセル書式（DD-027-3・セル書式モデル）。grid 側が mount 時にプリコンパイルした「列→値→style」Map を
 * base-layer の getCellStyle フックで束縛し、可視非空セルの描画時に O(1) 解決する。全フィールド任意
 * （DOM 非依存＝render 側が描画契約として保持。色文字列は検査しない＝canvas fillStyle は不正値を無視）。
 */
export interface ResolvedCellStyle {
  /** セル背景色（罫線幅ぶん inset して文字より先に塗る＝罫線保存）。 */
  readonly cellBackground?: string;
  /** 文字色（数値既定色より優先・右寄せは維持）。 */
  readonly textColor?: string;
  /** true=値を丸角チップ（バッジ）で描画（右隣へオーバーフローしない）。 */
  readonly badge?: boolean;
  /** チップ背景色（badge:true 時。既定は cellBackground 系）。 */
  readonly badgeColor?: string;
}

/**
 * 解決済みの描画テキストの装飾（DD-059・負の数の表示書式）。grid 側が表示書式からプリコンパイルした列ごとの不変
 * オブジェクトを base-layer の cellTextDecoration フックで束縛し、可視非空セルの描画時に解決する（DOM 非依存の描画契約）。
 */
export interface ResolvedTextDecoration {
  /** 文字色（負の数の色）。getCellStyle の textColor が勝ち、既定の数値/文字色より優先する。 */
  readonly textColor?: string;
  /** 数値の右に空ける余白の文字（括弧表記の列の正の数と 0 = `)`・Excel の `_)`）。cell font で測った幅だけ右端をあける。 */
  readonly trailingPad?: string;
}

/** セルの状態表示の水準（DD-060）。 */
export type CellStatusLevel = 'error' | 'warning';

/** 行内で状態表示を持つセル（DD-060・列 index と水準）。grid 側が RowId/ColumnId を描画時に index へ解決して渡す。 */
export interface CellStatusMark {
  readonly colIndex: number;
  readonly level: CellStatusLevel;
}

/** 状態表示の色（DD-060・固定。枠＝罫線の内側の 2px・背景＝セル全体）。 */
export const CELL_STATUS_COLORS: Readonly<Record<CellStatusLevel, { readonly frame: string; readonly background: string }>> = {
  error: { frame: '#d93025', background: '#fce8e6' },
  warning: { frame: '#e37400', background: '#fef7e0' },
};

/** 状態表示の色の上書き（DD-061・省略した水準・項目は `CELL_STATUS_COLORS`）。 */
export type CellStatusColorOverrides = Readonly<
  Partial<Record<CellStatusLevel, { readonly frame?: string; readonly background?: string }>>
>;

/** 状態表示の枠の太さ（CSS px・DD-060）。device px へ丸めて描く。 */
export const CELL_STATUS_FRAME_WIDTH = 2;

/** 2段の見出しの上の段に描く列のまとまり（DD-064 K4）。列は表示 index の半開区間（固定列の境界をまたがない）。 */
export interface ColumnGroupSpan {
  readonly colStart: number;
  readonly colEnd: number;
  readonly caption: string;
}

/** 2段の見出し（DD-064 K4）。`height` は上の段の高さ（px）で、`headerHeight` はこれを含む見出し全体の高さ。 */
export interface ColumnGroupBand {
  readonly height: number;
  readonly groups: readonly ColumnGroupSpan[];
}

/** 結合範囲の viewport 矩形（左上のセルの左上から右下のセルの右下まで）。範囲は固定行列の境界をまたがない前提。 */
export function mergedCellRect(transform: ViewportTransform, range: CellRange): CellRect {
  const topLeft = transform.cellRect(range.rowStart, range.colStart);
  const bottomRight = transform.cellRect(range.rowEnd - 1, range.colEnd - 1);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x + bottomRight.width - topLeft.x,
    height: bottomRight.y + bottomRight.height - topLeft.y,
  };
}

export interface BaseLayerColors {
  readonly cellBackground: string;
  readonly frozenBackground: string;
  readonly gridLine: string;
  readonly headerBackground: string;
  readonly headerText: string;
  readonly cellText: string;
  readonly numberText: string;
  /** ハイパーリンク列の文字色（DD-027-2・リンク色＋下線）。 */
  readonly linkText: string;
}

export const DEFAULT_BASE_COLORS: BaseLayerColors = {
  cellBackground: '#ffffff',
  frozenBackground: '#f8fbff',
  gridLine: '#d4d4d4',
  headerBackground: '#f3f3f3',
  headerText: '#555555',
  cellText: '#202124',
  numberText: '#1a4f8a',
  linkText: '#1a73e8',
};

export interface BaseLayerDeps extends BorderLayerDeps {
  readonly ctx: CanvasRenderingContext2D;
  readonly store: ChunkStore;
  readonly headerWidth: number;
  readonly headerHeight: number;
  readonly colors?: BaseLayerColors;
  readonly cellFont?: string;
  readonly columnFont?: (colIndex: number) => string | undefined;
  readonly headerFont?: string;
  /**
   * measureText キャッシュ（DD-012-5）。指定すると base-layer は自前生成せず共有インスタンスを使う。
   * 自動行高計算（DocumentView）と行分割キャッシュ（wrapLines）を共有し、描画と行高の line 数を一致させる。
   */
  readonly textCache?: TextMetricsCache;
  /** 列 index が折り返し（wrap）列か（DD-012-5 D1・列単位 wrap）。未指定なら全列オーバーフロー扱い。 */
  readonly isWrapColumn?: (colIndex: number) => boolean;
  /**
   * 列 index がハイパーリンク列か（DD-027-2）。リンク列のセルはリンク色＋下線・**自セル内 fitText クリップ**で描く
   * （オーバーフロー対象外＝クリック領域と描画を一致させる）。数値に解釈される値もリンク列ではリンク描画を優先する。
   * 未指定なら全列リンクでない扱い（現行挙動）。
   */
  readonly isLinkColumn?: (colIndex: number) => boolean;
  /**
   * セル書式解決フック（DD-027-3・isWrapColumn/isLinkColumn と同型・DOM 非依存）。可視非空セルの描画時に
   * 「列 index・表示値」で解決済み style（背景色・文字色・バッジ）を返す（無ければ undefined＝書式なし）。
   * grid 側がプリコンパイル済み Map の O(1) lookup を束縛する。未指定なら全セル書式なし（現行描画・AC3）。
   */
  readonly getCellStyle?: (colIndex: number, value: string) => ResolvedCellStyle | undefined;
  /**
   * 列ヘッダーの表示ラベル解決フック（DD-033-2・列見出しキャプション）。列 index → ヘッダーに描く文字列を返す
   * （未指定なら A/B/C… の列記号＝現行挙動）。長いキャプションは `columnHeaderRect` 幅で fitText クリップされ
   * 隣接ヘッダーへ重ならない。DOM/grid 型非依存の構造フック（R7）。
   */
  readonly columnHeaderLabel?: (colIndex: number) => string;
  /**
   * セル描画テキストの整形フック（DD-033-2・数値/日付の表示書式）。可視非空セルの描画時に「列 index・raw 値」から
   * 描画テキスト（display）を返す（未指定なら恒等＝raw をそのまま描く・現行挙動）。**判定（数値右寄せ・getCellStyle の
   * match・isLinkColumn/isWrapColumn）は raw のまま**行い、描画テキストだけを display に差し替える（判定は raw・描画は
   * display）。grid 側がプリコンパイル済みの raw→display 写像を束縛する。DOM/grid 型非依存の構造フック（R7）。
   */
  readonly formatCellText?: (colIndex: number, rawValue: string) => string;
  /**
   * 描画テキストの装飾フック（DD-059・負の数の表示書式）。可視非空セルの描画時に「列 index・raw 値」から文字色と
   * 数値の右余白を返す（無ければ undefined）。文字色の優先順位は getCellStyle の textColor ＞ 本フックの textColor ＞
   * 既定の数値/文字色（バッジの文字色も同じ）。右余白は数値セル（右寄せ）だけに効く。判定は formatCellText と同じく raw。
   * 未指定なら装飾なし（現行描画と完全一致）。DOM/grid 型非依存の構造フック（R7）。
   */
  readonly cellTextDecoration?: (colIndex: number, rawValue: string) => ResolvedTextDecoration | undefined;
  /**
   * 列単位の静的背景色フック（DD-036 C2）。列 index → CSS color（未指定列は undefined）。**値によらず列全体**を塗る
   * ため、pane 背景の直後・罫線描画の**前**に列バンドとして塗る（＝空セルも塗られ、罫線・値・選択は上に乗る）。
   * 値ベース書式（getCellStyle の cellBackground）は可視非空セルの描画時に後から上塗りされる＝**値ベースが勝つ**。
   * 未指定なら列バンド描画そのものを行わない（現行描画と完全一致・コスト増ゼロ）。
   */
  readonly columnBackground?: (colIndex: number) => string | undefined;
  /**
   * 行単位の静的背景色フック（DD-045）。行 index → CSS color（未指定行は undefined）。列背景の後に横バンドで塗り、
   * 行と列の交差では行を優先する。値ベース書式はさらに後から上塗りされる。未指定なら追加描画ゼロ。
   */
  readonly rowBackground?: (rowIndex: number) => string | undefined;
  /**
   * セルの状態表示フック（DD-060）。行 index → その行で状態表示を持つセル（無ければ undefined）。値の有無によらず、
   * 行背景の後・罫線の前にセル全体の背景を塗り、値の後に罫線の内側の枠を描く（色は `CELL_STATUS_COLORS`）。
   * 状態のあるセルでは値ベース書式の背景を塗らない（状態の背景が勝つ）。文字・バッジは背景の上に描く。
   * pane ごとに可視行の数だけ呼ぶ。未指定なら追加描画ゼロ。
   */
  readonly cellStatusesInRow?: (rowIndex: number) => readonly CellStatusMark[] | undefined;
  /** 状態表示の色の上書き（DD-061）。未指定・省略した項目は `CELL_STATUS_COLORS`。不正な色は既定色で描く。 */
  readonly cellStatusColors?: CellStatusColorOverrides;
  /**
   * 結合範囲（DD-064）。描画のたびに呼ぶ。範囲は表示 index の半開区間で、重ならず、固定行列の境界をまたがない
   * （grid が解決済みのものだけを渡す）。範囲の中のセルはふつうの経路で描かず（右隣へのはみ出しも結合の手前で止める）、
   * 最後に範囲を 1 つの大きなセルとして描き直す（背景・文字・状態表示は左上のセルのもの・範囲の中の罫線は描かない）。
   * 未指定・0 件なら追加の描画ゼロ（現行描画と完全一致）。
   */
  readonly mergedRanges?: () => MergeIndex | undefined;
  /**
   * 2段の見出し（DD-064 K4）。上の段にまとまりの名前、下の段にまとめた列の名前を描き、まとめていない列は 2 段ぶんの
   * 高さの中央に名前を描く。`headerHeight` は 2 段ぶんの高さを渡す。未指定なら 1 段（現行描画と完全一致）。
   */
  readonly columnGroupBand?: ColumnGroupBand;
  /** 固定列数（DD-012-5 D2・オーバーフロー左外流入が pane 境界＝固定/本体境界を越えないための下限）。 */
  readonly frozenColCount?: number;
  /** wrap 折り返し行の行高（px・DD-012-5 D4/D5・自動行高計算と一致させる）。 */
  readonly lineHeight?: number;
}

export interface BaseLayer {
  draw(frame: FrameViewport): void;
  /** measureText キャッシュ（Web font 読込・DPR 変更で clear する）。 */
  readonly textCache: TextMetricsCache;
}

/** セル文字の左右パディング（px・DD-012-5 で自動行高計算と共有）。 */
export const CELL_TEXT_PADDING = 5;
/** wrap 折り返し行の既定行高（px・13px フォント想定・自動行高計算と一致させる）。 */
export const CELL_TEXT_LINE_HEIGHT = 16;
const CELL_PADDING = CELL_TEXT_PADDING;
/** バッジ（丸角チップ）のテキスト左右パディング（px・DD-027-3・auto-fit のチップ幅計算と共有）。 */
export const BADGE_TEXT_PADDING = 6;
/** バッジ（丸角チップ）の既定背景色（badgeColor/cellBackground 未指定時・DD-027-3）。 */
const BADGE_DEFAULT_BACKGROUND = '#e8eaed';
/** CSS font 文字列から px サイズを取り出す（"13px system-ui" → 13）。取れなければ既定 13。 */
function parseFontSizePx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m !== null ? Number(m[1]) : 13;
}
/**
 * リンク列下線のテキスト中心（middle baseline）からの下方オフセット（px）。フォントサイズに比例させる
 * （Fable P3: 13px ハードコードを廃し cellFont 差し替えでも下線がずれない）。13px で従来値 7 に一致。
 */
function linkUnderlineOffset(fontSizePx: number): number {
  return Math.round(fontSizePx / 2) + 1;
}
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/** 表示文字列が数値（右寄せ・オーバーフロー対象外）か。base-layer と自動行高計算で同一判定を使う。 */
export function isNumericCell(value: string): boolean {
  return NUMERIC_RE.test(value);
}

/** 列 index → A, B, ..., Z, AA, ... の列記号（DD-027-3・auto-fit のヘッダー幅測定と実描画で共有＝Fable P3）。 */
export function columnLabel(col: number): string {
  let n = col;
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

function findPane(panes: readonly PaneRange[], id: PaneId): PaneRange {
  const found = panes.find((p) => p.pane === id);
  if (found === undefined) {
    throw new Error(`pane ${id} が見つからない`);
  }
  return found;
}

export function createBaseLayer(deps: BaseLayerDeps): BaseLayer {
  const { ctx, store, headerWidth, headerHeight } = deps;
  const colors = deps.colors ?? DEFAULT_BASE_COLORS;
  const defaultCellFont = deps.cellFont ?? '13px system-ui, sans-serif';
  let cellFont = defaultCellFont;
  let linkUnderlineOffsetPx = linkUnderlineOffset(parseFontSizePx(cellFont));
  const headerFont = deps.headerFont ?? '12px system-ui, sans-serif';
  const isWrapColumn = deps.isWrapColumn ?? (() => false);
  const isLinkColumn = deps.isLinkColumn ?? (() => false);
  const getCellStyle = deps.getCellStyle ?? (() => undefined);
  // DD-033-2: 表示書式フック（未指定なら恒等＝raw 素通し）。判定は raw・描画は display（下の visitor 参照）。
  const formatCellText = deps.formatCellText ?? ((_col: number, raw: string) => raw);
  // DD-059: 表示書式由来の装飾フック（負の数の色・括弧表記の右余白）。未指定なら装飾なし。
  const cellTextDecoration = deps.cellTextDecoration ?? (() => undefined);
  const columnHeaderLabelFn = deps.columnHeaderLabel;
  const columnBackgroundFn = deps.columnBackground;
  const rowBackgroundFn = deps.rowBackground;
  const cellStatusesInRowFn = deps.cellStatusesInRow;
  const cellStatusColors = deps.cellStatusColors;
  /**
   * 状態表示の色を fillStyle に入れる（DD-061）。既定色を入れてから上書きする: Canvas は不正な色の代入を無視して
   * 直前の色を残すため、上書きだけだと前のセルの色を引き継ぐ（engineering-patterns #27）。
   */
  const setStatusFill = (level: CellStatusLevel, part: 'frame' | 'background'): void => {
    ctx.fillStyle = CELL_STATUS_COLORS[level][part];
    const custom = cellStatusColors?.[level]?.[part];
    if (custom !== undefined) {
      ctx.fillStyle = custom;
    }
  };
  const frozenColCount = deps.frozenColCount ?? 0;
  let cellFontSizePx = parseFontSizePx(cellFont);
  const useColumnFont = (col: number): void => {
    const next = deps.columnFont?.(col) ?? defaultCellFont;
    if (next !== cellFont) {
      cellFont = next;
      cellFontSizePx = parseFontSizePx(next);
      linkUnderlineOffsetPx = linkUnderlineOffset(cellFontSizePx);
    }
    ctx.font = cellFont;
  };
  const lineHeight = deps.lineHeight ?? CELL_TEXT_LINE_HEIGHT;
  const textCache =
    deps.textCache ??
    createTextMetricsCache((text, font) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    });

  const drawPaneGrid = (frame: FrameViewport, pane: PaneRange): void => {
    const { transform, dpr } = frame;
    if (pane.rows.end <= pane.rows.start || pane.cols.end <= pane.cols.start) {
      return;
    }
    ctx.strokeStyle = colors.gridLine;
    ctx.lineWidth = deviceLineWidth(dpr);
    ctx.beginPath();
    const top = transform.cellRect(pane.rows.start, pane.cols.start).y;
    const firstRect = transform.cellRect(pane.rows.start, pane.cols.start);
    const lastRect = transform.cellRect(pane.rows.end - 1, pane.cols.end - 1);
    const bottom = lastRect.y + lastRect.height;
    const left = firstRect.x;
    const right = lastRect.x + lastRect.width;
    // 縦罫線（列境界）。
    for (let col = pane.cols.start; col <= pane.cols.end; col += 1) {
      if (isPatternBorder(deps.columnBorder?.(col))) continue;
      const boundary =
        col === pane.cols.end ? right : transform.cellRect(pane.rows.start, col).x;
      const x = snapToDevice(boundary, dpr);
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    // 横罫線（行境界）。
    for (let row = pane.rows.start; row <= pane.rows.end; row += 1) {
      if (isPatternBorder(deps.rowBorder?.(row))) continue;
      const boundary =
        row === pane.rows.end ? bottom : transform.cellRect(row, pane.cols.start).y;
      const y = snapToDevice(boundary, dpr);
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
  };

  /**
   * wrap 列セル: 折り返し複数行をセル内に clip して描く（DD-012-5 D4）。clipTop/clipBottom は pane 可視帯（Codex P1 対策）。
   * rect はセルの矩形（DD-064: 結合範囲では範囲全体の矩形）。
   */
  const drawWrapCell = (rect: CellRect, value: string, clipTop: number, clipBottom: number): void => {
    const maxWidth = rect.width - CELL_PADDING * 2;
    const lines = textCache.wrapLines(value, cellFont, maxWidth);
    ctx.textAlign = 'left';
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    if (lines.length <= 1) {
      ctx.fillText(lines[0] ?? value, rect.x + CELL_PADDING, rect.y + rect.height / 2);
    } else {
      // pane 可視帯に交差する行だけ描く（超長文でも O(可視行数)。無制限 fillText でフレームが凍る回帰を防ぐ・Codex P1）。
      const top = rect.y + CELL_PADDING;
      const first = Math.max(0, Math.floor((clipTop - top) / lineHeight));
      const last = Math.min(lines.length, Math.ceil((clipBottom - top) / lineHeight) + 1);
      for (let i = first; i < last; i += 1) {
        ctx.fillText(lines[i] ?? '', rect.x + CELL_PADDING, top + lineHeight / 2 + i * lineHeight);
      }
    }
    ctx.restore();
  };

  /**
   * 左寄せ文字列セル: 右方向の連続空セルへオーバーフロー描画する（DD-012-5 D2）。
   * 非空セル手前で止まったら省略記号でクリップ（AC2）、可視端まで空なら全文（pane clip で自然に切れる・AC1）。
   */
  const drawOverflowCell = (
    transform: ViewportTransform,
    row: number,
    col: number,
    value: string,
    maxColExclusive: number,
    isEmptyAt: (col: number) => boolean,
  ): void => {
    const rect = transform.cellRect(row, col);
    ctx.textAlign = 'left';
    // 高速パス: 自セル内に収まる文字列はオーバーフロー走査せず素描画する（DD-012-2 予算保護・非オーバーフロー時は従来コスト）。
    if (textCache.measureWidth(value, cellFont) <= rect.width - CELL_PADDING * 2) {
      ctx.fillText(value, rect.x + CELL_PADDING, rect.y + rect.height / 2);
      return;
    }
    const ext = overflowRightExtent(col, maxColExclusive, isEmptyAt, deps.columnBorder === undefined ? undefined : (index) => deps.columnBorder?.(index) !== undefined);
    let rightEdge = rect.x + rect.width;
    if (ext.endColExclusive > col + 1) {
      const lastRect = transform.cellRect(row, ext.endColExclusive - 1);
      rightEdge = lastRect.x + lastRect.width;
    }
    if (ext.blocked) {
      // 非空セル手前でクリップ（省略記号）。延長幅ぶんまで載せ、収まらなければ … で切る（AC1/AC2）。
      const availWidth = rightEdge - CELL_PADDING - (rect.x + CELL_PADDING);
      const maxWidth = Math.max(rect.width - CELL_PADDING * 2, availWidth);
      const text = textCache.fitText(value, cellFont, maxWidth);
      ctx.fillText(text, rect.x + CELL_PADDING, rect.y + rect.height / 2);
    } else {
      // 可視端まで空 → 全文を描き pane clip に任せる（Excel 風のハードクリップ・AC1）。
      ctx.fillText(value, rect.x + CELL_PADDING, rect.y + rect.height / 2);
    }
  };

  /**
   * リンク列セル（DD-027-2）: リンク色＋下線・自セル内 fitText クリップで描く（オーバーフローしない＝クリック領域と一致）。
   * 数値に解釈される値もリンク列ではリンク描画を優先する（表示文字列は不変・左寄せ）。下線は fitText 後の実文字幅ぶん。
   */
  const drawLinkCell = (rect: CellRect, dpr: number, value: string): void => {
    const maxWidth = rect.width - CELL_PADDING * 2;
    const text = textCache.fitText(value, cellFont, maxWidth);
    const x = rect.x + CELL_PADDING;
    const y = rect.y + rect.height / 2;
    ctx.fillStyle = colors.linkText;
    ctx.textAlign = 'left';
    ctx.fillText(text, x, y);
    // 下線: テキスト中心の少し下（≈フォント下端）へ 1 device px。実文字幅ぶんだけ引く（クリップ後の text 幅）。
    const width = Math.min(textCache.measureWidth(text, cellFont), maxWidth);
    if (width > 0) {
      const underlineY = snapToDevice(y + linkUnderlineOffsetPx, dpr);
      ctx.fillRect(x, underlineY, width, deviceLineWidth(dpr));
    }
  };

  /**
   * セル書式の背景色（DD-027-3）: セル矩形から罫線幅ぶん inset した矩形を塗る（罫線を保存・文字より先に塗る＝1 pass 維持）。
   * queryRange visitor の先頭で呼ぶ（背景 → 文字の順）。inset は device 罫線幅を CSS px へ戻したぶん（DPR 追従）。
   */
  const drawCellBackground = (
    transform: ViewportTransform,
    dpr: number,
    row: number,
    col: number,
    background: string,
  ): void => {
    const rect = transform.cellRect(row, col);
    const inset = deviceLineWidth(dpr) / dpr; // 罫線 1 device px を CSS px へ（罫線を上書きしないための余白）
    // patternの隙間まで値背景を保つ。solid/無指定は従来のinsetを維持する。
    const left = isPatternBorder(deps.columnBorder?.(col)) ? 0 : inset;
    const top = isPatternBorder(deps.rowBorder?.(row)) ? 0 : inset;
    const w = rect.width - left;
    const h = rect.height - top;
    if (w <= 0 || h <= 0) {
      return;
    }
    ctx.fillStyle = background;
    ctx.fillRect(rect.x + left, rect.y + top, w, h);
  };

  /** 丸角矩形のパスを引く（バッジチップ・ctx.roundRect 非依存で決定的に描く）。 */
  const roundRectPath = (x: number, y: number, w: number, h: number, r: number): void => {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  };

  /**
   * バッジ（丸角チップ）セル（DD-027-3）: 値を badgeColor 塗りの丸角チップ＋textColor 文字（単行 fitText クリップ）で描く。
   * **オーバーフロー対象外**（チップ描画が崩れるため・リンク列と同じ裁定＝DD-027-2）。数値/wrap 列でもチップが勝つ。
   * 背景色（cellBackground）は本メソッドの前に drawCellBackground で既に塗られている（チップはその上へ重ねる）。
   * `decorationColor` は負の数の色（DD-059）で、style.textColor が無いときだけ使う。右余白はチップには付けない。
   */
  const drawBadgeCell = (
    rect: CellRect,
    value: string,
    style: ResolvedCellStyle,
    decorationColor: string | undefined,
  ): void => {
    const maxTextWidth = rect.width - CELL_PADDING * 2 - BADGE_TEXT_PADDING * 2;
    const text = textCache.fitText(value, cellFont, Math.max(0, maxTextWidth));
    const textWidth = Math.min(textCache.measureWidth(text, cellFont), Math.max(0, maxTextWidth));
    const chipHeight = Math.min(rect.height - 4, cellFontSizePx + 8);
    const chipWidth = Math.min(textWidth + BADGE_TEXT_PADDING * 2, rect.width - CELL_PADDING * 2);
    const chipX = rect.x + CELL_PADDING;
    const chipY = rect.y + (rect.height - chipHeight) / 2;
    ctx.fillStyle = style.badgeColor ?? style.cellBackground ?? BADGE_DEFAULT_BACKGROUND;
    roundRectPath(chipX, chipY, Math.max(0, chipWidth), Math.max(0, chipHeight), chipHeight / 2);
    ctx.fill();
    // 既定色を先に入れてから上書きする（Canvas は不正な色の代入を無視して直前のチップ色を残すため・DD-059）。
    ctx.fillStyle = colors.cellText;
    const textColor = style.textColor ?? decorationColor;
    if (textColor !== undefined) {
      ctx.fillStyle = textColor;
    }
    ctx.textAlign = 'left';
    ctx.fillText(text, chipX + BADGE_TEXT_PADDING, rect.y + rect.height / 2);
  };

  /**
   * 1 セルの値を描く（書式背景 → バッジ/リンク/数値/wrap/オーバーフロー・Pass 1 と結合の描き直しで共有）。
   * `merged` のとき（DD-064）は rect が結合範囲全体で、書式の背景は呼び出し側（drawPaneMerges）が塗り済み。
   * ふつうの文字は右隣へはみ出させず、範囲に収まらなければ … で切る。
   */
  const drawCellValue = (
    frame: FrameViewport,
    row: number,
    col: number,
    value: string,
    rect: CellRect,
    options: {
      readonly maxCol: number;
      readonly isEmpty: (col: number) => boolean;
      readonly clipTop: number;
      readonly clipBottom: number;
      readonly hasStatus: boolean;
      readonly merged: boolean;
    },
  ): void => {
    const { transform } = frame;
    // DD-033-2: 描画テキストを display に確定する（判定は raw・描画は display）。書式のない列・非該当 raw は raw 恒等。
    const display = formatCellText(col, value);
    // DD-027-3: セル書式（値ベース・非空セルのみ）。**match は raw 完全一致のまま**（display で match しない・DD-033-2）。
    // 背景色は罫線 inset で文字より先に塗る（罫線保存・1 pass）。
    useColumnFont(col);
    const style = getCellStyle(col, value);
    // DD-059: 表示書式由来の装飾（負の数の色・括弧表記の右余白）。formatCellText と同じく判定は raw。
    const decoration = cellTextDecoration(col, value);
    // DD-060: 状態表示のあるセルは値ベース書式の背景を塗らない（先に塗った状態の背景を消さない）。
    if (!options.merged && style?.cellBackground !== undefined && !options.hasStatus) {
      drawCellBackground(transform, frame.dpr, row, col, style.cellBackground);
    }
    // バッジは最優先（オーバーフロー/wrap/リンク/数値より前・単行チップ・右隣へはみ出さない＝DD-027-3）。
    // チップ文字は display で描く（match は raw・描画は display・DD-033-2）。
    if (style?.badge === true) {
      drawBadgeCell(rect, display, style, decoration?.textColor);
      return;
    }
    // リンク列は数値/wrap より優先（列タイプが勝つ・自セル内クリップ＝クリック領域と一致・DD-027-2）。
    // 書式 textColor はリンク色（linkText）で上書きされる（リンクの視認性を優先・背景色は既に塗り済み）。
    // リンク列は表示書式と併用不可（mount fail-fast）ゆえ display===raw だが、契約上 display を渡す。
    if (isLinkColumn(col)) {
      drawLinkCell(rect, frame.dpr, display);
      return;
    }
    // 数値右寄せ判定は **raw** で行う（書式済み "1,234.5" は NUMERIC_RE 不一致＝display で判定すると右寄せが壊れる・DD-033-2）。
    const isNumber = isNumericCell(value);
    // 文字色: columnFormats の textColor（DD-027-3）＞ 負の数の色（DD-059）＞ 数値/文字の既定色（右寄せ等の配置は維持）。
    // 既定色を先に入れてから上書きする（Canvas は不正な色の代入を無視して直前の色を残すため・DD-036 と同じ理由）。
    ctx.fillStyle = isNumber ? colors.numberText : colors.cellText;
    const textColor = style?.textColor ?? decoration?.textColor;
    if (textColor !== undefined) {
      ctx.fillStyle = textColor;
    }
    // wrap 列は表示書式と併用不可（mount fail-fast）ゆえ display===raw だが、契約上 display を描く。
    if (!isNumber && isWrapColumn(col)) {
      drawWrapCell(rect, display, options.clipTop, options.clipBottom);
      return;
    }
    if (isNumber) {
      // DD-059: 括弧表記の列の正の数と 0 は右に `)` 1文字分をあけ、負の数 `(1,234)` と一の位をそろえる（Excel の `_)`）。
      const pad = decoration?.trailingPad === undefined ? 0 : textCache.measureWidth(decoration.trailingPad, cellFont);
      ctx.textAlign = 'right';
      const text = textCache.fitText(display, cellFont, rect.width - CELL_PADDING * 2 - pad);
      ctx.fillText(text, rect.x + rect.width - CELL_PADDING - pad, rect.y + rect.height / 2);
      return;
    }
    if (options.merged) {
      // DD-064: 結合範囲の文字は範囲の中だけ（右隣へはみ出さない）。収まらなければ … で切る。
      ctx.textAlign = 'left';
      const text = textCache.fitText(display, cellFont, Math.max(0, rect.width - CELL_PADDING * 2));
      ctx.fillText(text, rect.x + CELL_PADDING, rect.y + rect.height / 2);
      return;
    }
    drawOverflowCell(transform, row, col, display, options.maxCol, options.isEmpty);
  };

  const drawPaneValues = (frame: FrameViewport, pane: PaneRange, statuses: PaneStatuses | undefined): void => {
    const { transform } = frame;
    ctx.font = cellFont;
    ctx.textBaseline = 'middle';
    const maxCol = pane.cols.end;
    const clipTop = pane.clip.y;
    const clipBottom = pane.clip.y + pane.clip.height;
    // DD-064: 結合範囲のセルは空セルとして扱わない（左のセルの文字は結合の手前で止まる）。結合が無ければ現行と同じ判定。
    const merges = deps.mergedRanges?.();
    const mergeIndex = merges !== undefined && merges.size > 0 ? merges : undefined;
    const isMergedAt = (row: number, col: number): boolean => mergeIndex?.at(row, col) !== undefined;
    const isEmptyAt =
      mergeIndex === undefined
        ? (row: number) => (col: number): boolean => store.get(row, col) === ''
        : (row: number) => (col: number): boolean => store.get(row, col) === '' && !isMergedAt(row, col);

    // Pass 1: pane 内の非空セルを描く（書式背景 → バッジ/リンク/数値/wrap/オーバーフロー）。
    store.queryRange(pane.rows.start, pane.rows.end, pane.cols.start, pane.cols.end, (row, col, value) => {
      // DD-064: 結合範囲のセルはここで描かない（左上の値は drawPaneMerges が範囲全体に描く。左上以外の値は描かない）。
      if (mergeIndex !== undefined && isMergedAt(row, col)) {
        return;
      }
      drawCellValue(frame, row, col, value, transform.cellRect(row, col), {
        maxCol,
        isEmpty: isEmptyAt(row),
        clipTop,
        clipBottom,
        hasStatus: statuses?.get(row)?.has(col) === true,
        merged: false,
      });
    });

    // Pass 2: 可視範囲の左外にあるはみ出し元からの流入を描く（D3・最大 20 列遡り・pane 境界で停止）。
    // 固定列（frozenColCount）を越えて遡らない＝pane 境界でオーバーフローを止める（D2）。
    if (pane.cols.start > frozenColCount) {
      for (let row = pane.rows.start; row < pane.rows.end; row += 1) {
        // 可視左端セルが埋まっていれば左外流入は届かない（origin→可視の間に非空セルが要る）→ 走査省略（予算保護）。
        // DD-064: 可視左端が結合範囲なら同じく届かない（結合は空セルとして扱わない）。
        if (store.get(row, pane.cols.start) !== '' || isMergedAt(row, pane.cols.start)) {
          continue;
        }
        const isEmpty = isEmptyAt(row);
        const originCol = nearestLeftNonEmpty(pane.cols.start, frozenColCount, MAX_LEFT_INFLOW_SCAN, isEmpty, deps.columnBorder === undefined ? undefined : (index) => deps.columnBorder?.(index) !== undefined);
        if (originCol === null || isMergedAt(row, originCol)) {
          continue; // DD-064: 結合範囲は流入元にしない（範囲の文字は範囲の中だけ）
        }
        const value = store.get(row, originCol);
        // 数値・wrap・リンク列はオーバーフローしない（左寄せ文字列のみ流入・リンクは自セル内クリップ＝DD-027-2）。
        // 判定は **raw**（DD-033-2・date 書式列は非数値ゆえ左外流入し得る＝display で描く必要がある）。
        if (isNumericCell(value) || isWrapColumn(originCol) || isLinkColumn(originCol)) {
          continue;
        }
        // DD-027-3: バッジ指定値は単行チップ＝オーバーフロー対象外（流入させない）。textColor は流入文字にも適用する
        // （背景色は origin セル自身の矩形〔可視左外〕にのみ塗るため、ここでは塗らない＝流入先の空セルを汚さない）。
        useColumnFont(originCol);
        const originStyle = getCellStyle(originCol, value);
        if (originStyle?.badge === true) {
          continue;
        }
        // 既定色を先に入れてから上書きする（不正な色で直前の色を引き継がない・Pass 1 と同じ理由・DD-059）。
        ctx.fillStyle = colors.cellText;
        if (originStyle?.textColor !== undefined) {
          ctx.fillStyle = originStyle.textColor;
        }
        // DD-033-2: 流入も origin 列の書式で display を描く（判定は raw・描画は display）。
        drawOverflowCell(transform, row, originCol, formatCellText(originCol, value), maxCol, isEmpty);
      }
    }
  };

  /**
   * 静的列背景（DD-036 C2）: pane 内の指定列を「可視行範囲いっぱいの縦バンド」として 1 列 1 回で塗る。
   * セル単位に塗らないのは、空セルも含む列全体が対象で、かつ列数ぶんの fillRect で足りるため（描画予算）。
   * 罫線は本メソッドの後に引かれるため網掛けで消えない。
   */
  const drawColumnBackgrounds = (frame: FrameViewport, pane: PaneRange, paneBackground: string): void => {
    if (columnBackgroundFn === undefined) {
      return;
    }
    if (pane.rows.end <= pane.rows.start || pane.cols.end <= pane.cols.start) {
      return;
    }
    const { transform } = frame;
    const top = transform.cellRect(pane.rows.start, pane.cols.start).y;
    const lastRow = transform.cellRect(pane.rows.end - 1, pane.cols.start);
    const height = lastRow.y + lastRow.height - top;
    for (let col = pane.cols.start; col < pane.cols.end; col += 1) {
      const color = columnBackgroundFn(col);
      if (color === undefined) {
        continue;
      }
      const rect = transform.cellRect(pane.rows.start, col);
      // DD-036（Codex P2）: Canvas は不正な色の代入を**無視**する（例外は投げない）＝直前に設定した色がそのまま
      // 残る。列ごとに一度 pane 背景へ戻してから候補色を代入することで、不正色の列が「直前の列の色」で塗られる
      // のを防ぐ（不正色は pane 背景で塗られる＝見た目は現行どおり＝「Canvas が無視して安全」の契約を守る）。
      ctx.fillStyle = paneBackground;
      ctx.fillStyle = color;
      ctx.fillRect(rect.x, top, rect.width, height);
    }
  };

  /**
   * 静的行背景（DD-045）: pane 内の指定行を「可視列範囲いっぱいの横バンド」として 1 行 1 回で塗る。
   * 列背景の後に呼ぶため交差セルでは行背景が勝ち、罫線・値ベース書式は後から上に乗る。
   */
  const drawRowBackgrounds = (frame: FrameViewport, pane: PaneRange, paneBackground: string): void => {
    if (rowBackgroundFn === undefined) {
      return;
    }
    if (pane.rows.end <= pane.rows.start || pane.cols.end <= pane.cols.start) {
      return;
    }
    const { transform } = frame;
    const left = transform.cellRect(pane.rows.start, pane.cols.start).x;
    const lastCol = transform.cellRect(pane.rows.start, pane.cols.end - 1);
    const width = lastCol.x + lastCol.width - left;
    for (let row = pane.rows.start; row < pane.rows.end; row += 1) {
      const color = rowBackgroundFn(row);
      if (color === undefined) {
        continue;
      }
      const rect = transform.cellRect(row, pane.cols.start);
      // Canvas が不正色を無視して直前行の fillStyle を残しても色漏れしないよう、行ごとに pane 背景へ戻す。
      ctx.fillStyle = paneBackground;
      ctx.fillStyle = color;
      ctx.fillRect(left, rect.y, width, rect.height);
    }
  };

  /** pane 内の状態表示セル（行 index → 列 index → 水準）。1 つも無ければ undefined（DD-060）。 */
  type PaneStatuses = Map<number, Map<number, CellStatusLevel>>;

  const collectPaneStatuses = (pane: PaneRange): PaneStatuses | undefined => {
    if (cellStatusesInRowFn === undefined) {
      return undefined;
    }
    let result: PaneStatuses | undefined;
    for (let row = pane.rows.start; row < pane.rows.end; row += 1) {
      const marks = cellStatusesInRowFn(row);
      if (marks === undefined) {
        continue;
      }
      for (const mark of marks) {
        // 列は pane ごとに切り分ける（固定列と本体の境界で同じセルを二重に描かない）。
        if (mark.colIndex < pane.cols.start || mark.colIndex >= pane.cols.end) {
          continue;
        }
        result ??= new Map();
        let cols = result.get(row);
        if (cols === undefined) {
          cols = new Map();
          result.set(row, cols);
        }
        cols.set(mark.colIndex, mark.level);
      }
    }
    return result;
  };

  /** 状態表示の背景（DD-060）: セル全体を塗る。罫線はこの後に引くので消えない。 */
  const drawCellStatusBackgrounds = (frame: FrameViewport, statuses: PaneStatuses): void => {
    for (const [row, cols] of statuses) {
      for (const [col, level] of cols) {
        const rect = frame.transform.cellRect(row, col);
        setStatusFill(level, 'background');
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      }
    }
  };

  /**
   * 境界の線が占める device px 数（DD-060）。指定罫線は `borderBand` と同じ丸め、無ければグリッド線の 1 device px。
   * 線は境界の device px から floor(n/2) 手前で始まり n 続く（グリッド線は境界の device px そのもの）。
   */
  const boundaryPixels = (border: BoundaryBorder | undefined, d: number): number =>
    border === undefined ? 1 : Math.max(1, Math.round(border.width * d));

  /**
   * 状態表示の枠（DD-060）: 罫線の内側に 2px の枠を 4 本の fillRect で描く。各辺の罫線帯（グリッド線または
   * rowBorders/columnBorders。後段の drawBorders が上に描く）の内端から、隣の境界の罫線帯の手前までに収める
   * （太い罫線に上書きされない・Codex P2）。端と太さを device px へ丸め、非整数 DPR でもにじませない。
   */
  /**
   * 矩形 1 つに状態表示の枠を描く（DD-060。DD-064 で結合範囲にも使うため切り出した）。各辺の境界 index（左＝範囲の
   * 左端の列・上＝上端の行・右＝右端の次の列・下＝下端の次の行）で罫線帯の幅を引き、その内側に収める。
   */
  const drawStatusFrame = (
    rect: CellRect,
    level: CellStatusLevel,
    boundaries: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
    dpr: number,
  ): void => {
    const d = normalizeDpr(dpr);
    const thickness = Math.max(1, Math.round(CELL_STATUS_FRAME_WIDTH * d));
    const left = Math.round(rect.x * d) + Math.ceil(boundaryPixels(deps.columnBorder?.(boundaries.left), d) / 2);
    const top = Math.round(rect.y * d) + Math.ceil(boundaryPixels(deps.rowBorder?.(boundaries.top), d) / 2);
    const right = Math.round((rect.x + rect.width) * d) - Math.floor(boundaryPixels(deps.columnBorder?.(boundaries.right), d) / 2);
    const bottom = Math.round((rect.y + rect.height) * d) - Math.floor(boundaryPixels(deps.rowBorder?.(boundaries.bottom), d) / 2);
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) {
      return;
    }
    const tx = Math.min(thickness, width);
    const ty = Math.min(thickness, height);
    setStatusFill(level, 'frame');
    ctx.fillRect(left / d, top / d, width / d, ty / d);
    ctx.fillRect(left / d, (bottom - ty) / d, width / d, ty / d);
    ctx.fillRect(left / d, top / d, tx / d, height / d);
    ctx.fillRect((right - tx) / d, top / d, tx / d, height / d);
  };

  const drawCellStatusFrames = (frame: FrameViewport, statuses: PaneStatuses): void => {
    for (const [row, cols] of statuses) {
      for (const [col, level] of cols) {
        drawStatusFrame(frame.transform.cellRect(row, col), level, { left: col, top: row, right: col + 1, bottom: row + 1 }, frame.dpr);
      }
    }
  };

  /** 左上のセルの状態表示の水準（DD-064: 範囲の上の端が pane の可視行の外でも引けるよう、行のフックから直接引く）。 */
  const statusLevelAt = (row: number, col: number): CellStatusLevel | undefined => {
    const marks = cellStatusesInRowFn?.(row);
    return marks?.find((mark) => mark.colIndex === col)?.level;
  };

  /**
   * 結合範囲の描き直し（DD-064）: pane の可視範囲に交わる結合を、1 つの大きなセルとして上から描く（範囲の中のグリッド線・
   * 範囲の中のセルの背景と状態表示を覆う）。背景は左上の行・列のもの（pane 背景 → 列背景 → 行背景 → 状態表示 or
   * 値ベース書式の背景＝ふつうのセルと同じ優先順位）で、左・上の罫線を残すため罫線幅ぶん内側から塗る（drawCellBackground と同じ）。
   * 文字は範囲の矩形で clip して描き、状態表示の枠は範囲の外周の内側に描く。範囲は固定行列の境界をまたがない（grid が保証）。
   */
  const drawPaneMerges = (frame: FrameViewport, pane: PaneRange, paneBackground: string): void => {
    const merges = deps.mergedRanges?.();
    if (merges === undefined || merges.size === 0) {
      return;
    }
    if (pane.rows.end <= pane.rows.start || pane.cols.end <= pane.cols.start) {
      return;
    }
    const visible = merges.intersecting({
      rowStart: pane.rows.start,
      rowEnd: pane.rows.end,
      colStart: pane.cols.start,
      colEnd: pane.cols.end,
    });
    if (visible.length === 0) {
      return;
    }
    const { transform, dpr } = frame;
    const inset = deviceLineWidth(dpr) / dpr;
    const clipTop = pane.clip.y;
    const clipBottom = pane.clip.y + pane.clip.height;
    for (const merge of visible) {
      const row = merge.rowStart;
      const col = merge.colStart;
      const rect = mergedCellRect(transform, merge);
      const left = isPatternBorder(deps.columnBorder?.(col)) ? 0 : inset;
      const top = isPatternBorder(deps.rowBorder?.(row)) ? 0 : inset;
      const width = rect.width - left;
      const height = rect.height - top;
      if (width <= 0 || height <= 0) {
        continue;
      }
      const bx = rect.x + left;
      const by = rect.y + top;
      // 背景: ふつうのセルと同じ重ね順を範囲の矩形 1 つで再現する（不正な色は Canvas が無視する＝直前の色を引き継がないよう、
      // 色ごとに pane 背景へ戻してから代入する・drawColumnBackgrounds と同じ理由）。
      ctx.fillStyle = paneBackground;
      ctx.fillRect(bx, by, width, height);
      const columnColor = columnBackgroundFn?.(col);
      if (columnColor !== undefined) {
        ctx.fillStyle = paneBackground;
        ctx.fillStyle = columnColor;
        ctx.fillRect(bx, by, width, height);
      }
      const rowColor = rowBackgroundFn?.(row);
      if (rowColor !== undefined) {
        ctx.fillStyle = paneBackground;
        ctx.fillStyle = rowColor;
        ctx.fillRect(bx, by, width, height);
      }
      const level = statusLevelAt(row, col);
      const value = store.get(row, col);
      if (level !== undefined) {
        setStatusFill(level, 'background');
        ctx.fillRect(bx, by, width, height);
      } else if (value !== '') {
        const background = getCellStyle(col, value)?.cellBackground;
        if (background !== undefined) {
          ctx.fillStyle = background;
          ctx.fillRect(bx, by, width, height);
        }
      }
      if (value !== '') {
        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.width, rect.height);
        ctx.clip();
        ctx.font = cellFont;
        ctx.textBaseline = 'middle';
        drawCellValue(frame, row, col, value, rect, {
          maxCol: merge.colEnd,
          isEmpty: () => false,
          clipTop,
          clipBottom,
          hasStatus: level !== undefined,
          merged: true,
        });
        ctx.restore();
      }
      if (level !== undefined) {
        drawStatusFrame(rect, level, { left: col, top: row, right: merge.colEnd, bottom: merge.rowEnd }, dpr);
      }
    }
  };

  const drawPane = (frame: FrameViewport, pane: PaneRange): void => {
    if (pane.clip.width <= 0 || pane.clip.height <= 0) {
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.clip.x, pane.clip.y, pane.clip.width, pane.clip.height);
    ctx.clip();
    const paneBackground = pane.pane === 'body' ? colors.cellBackground : colors.frozenBackground;
    ctx.fillStyle = paneBackground;
    ctx.fillRect(pane.clip.x, pane.clip.y, pane.clip.width, pane.clip.height);
    // DD-036 C2: 静的列背景は pane 背景の直後・罫線の前（固定 pane でも frozenBackground より優先して塗る）。
    drawColumnBackgrounds(frame, pane, paneBackground);
    // DD-045: 静的行背景は列背景の後・罫線の前（交差は行が勝ち、値ベース書式はさらに上に乗る）。
    drawRowBackgrounds(frame, pane, paneBackground);
    // DD-060: 状態表示の背景は行背景の後・罫線の前、枠は値の後（文字・バッジより上、選択枠〔overlay〕より下）。
    const statuses = collectPaneStatuses(pane);
    if (statuses !== undefined) {
      drawCellStatusBackgrounds(frame, statuses);
    }
    drawPaneGrid(frame, pane);
    drawPaneValues(frame, pane, statuses);
    if (statuses !== undefined) {
      drawCellStatusFrames(frame, statuses);
    }
    // DD-064: 結合範囲は最後に 1 つの大きなセルとして描き直す（範囲の中の罫線・セルを覆う。指定罫線は後段の drawBorders が
    // 範囲の中を抜いて描く）。結合が無ければ何もしない。
    drawPaneMerges(frame, pane, paneBackground);
    ctx.restore();
  };

  // DD-039: ヘッダー帯の中を pane 境界で切り分けるための入れ子 clip。帯の clip の内側で呼ぶため
  // 交差＝帯からはみ出さない。幅・高さが 0 以下の側は clip を張らずスキップする（drawPane と同じガード）
  // ＝固定行列が 0 のときスクロール側の矩形は帯 clip と一致し、現行と同一の描画に落ちる。
  const withBandClip = (x: number, y: number, width: number, height: number, draw: () => void): void => {
    if (width <= 0 || height <= 0) {
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    draw();
    ctx.restore();
  };

  // DD-064 K4: 2段の見出し。上の段の高さ（0＝1段）と、列 index → まとまり（列は mount 時に固定＝作成時に引く表を作る）。
  const groupBandHeight =
    deps.columnGroupBand !== undefined && deps.columnGroupBand.groups.length > 0 ? deps.columnGroupBand.height : 0;
  const groupOfColumn = new Map<number, ColumnGroupSpan>();
  for (const group of deps.columnGroupBand?.groups ?? []) {
    for (let col = group.colStart; col < group.colEnd; col += 1) {
      groupOfColumn.set(col, group);
    }
  }

  const drawHeaders = (frame: FrameViewport): void => {
    const { transform, viewportWidth, dpr } = frame;
    const panes = transform.panes();
    const body = findPane(panes, 'body');
    const corner = findPane(panes, 'corner');

    // 列記号ヘッダー（上帯）。
    ctx.save();
    ctx.beginPath();
    ctx.rect(headerWidth, 0, Math.max(0, viewportWidth - headerWidth), headerHeight);
    ctx.clip();
    ctx.fillStyle = colors.headerBackground;
    ctx.fillRect(headerWidth, 0, viewportWidth, headerHeight);
    ctx.fillStyle = colors.headerText;
    ctx.font = headerFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const drawColHeader = (col: number): void => {
      const rect = transform.columnHeaderRect(col);
      // DD-064 K4: まとめた列は下の段の中央、まとめていない列は 2 段ぶんの中央（1 段なら従来どおり見出しの中央）。
      const labelY =
        groupBandHeight > 0 && groupOfColumn.has(col)
          ? groupBandHeight + (headerHeight - groupBandHeight) / 2
          : headerHeight / 2;
      // DD-033-2: キャプションフック未指定なら現行どおり列記号を素描画する（既存 consumer と完全一致・AC9）。
      if (columnHeaderLabelFn === undefined) {
        ctx.fillText(columnLabel(col), rect.x + rect.width / 2, labelY);
        return;
      }
      // キャプションは自ヘッダーセル幅で fitText クリップ（長い業務名が隣接ヘッダーへ重ならない・AC2）。中央寄せは維持。
      const label = columnHeaderLabelFn(col);
      const text = textCache.fitText(label, headerFont, Math.max(0, rect.width - CELL_PADDING * 2));
      ctx.font = headerFont; // fitText の measure コールバックが ctx.font を触るため描画前に復帰させる。
      ctx.fillText(text, rect.x + rect.width / 2, labelY);
    };
    /**
     * DD-064 K4: 帯（固定列・スクロール列のどちらか）の列範囲に交わるまとまりの名前と区切りの線を描く。まとまりは
     * 固定列の境界をまたがない（grid が保証）ので、帯の clip の中に収まる。名前はまとまりの幅の中央（範囲と一緒に動く）。
     */
    const drawColumnGroups = (colStart: number, colEnd: number): void => {
      if (groupBandHeight <= 0 || colEnd <= colStart) {
        return;
      }
      for (const group of deps.columnGroupBand?.groups ?? []) {
        if (group.colEnd <= colStart || group.colStart >= colEnd) {
          continue;
        }
        const first = transform.columnHeaderRect(group.colStart);
        const last = transform.columnHeaderRect(group.colEnd - 1);
        const x = first.x;
        const width = last.x + last.width - first.x;
        const text = textCache.fitText(group.caption, headerFont, Math.max(0, width - CELL_PADDING * 2));
        ctx.font = headerFont;
        ctx.fillStyle = colors.headerText;
        ctx.fillText(text, x + width / 2, groupBandHeight / 2);
        // 区切り: まとまりの下（上の段と下の段の間）と、まとまりの左右（上の段だけ）。
        ctx.strokeStyle = colors.gridLine;
        ctx.lineWidth = deviceLineWidth(dpr);
        ctx.beginPath();
        const y = snapToDevice(groupBandHeight, dpr);
        ctx.moveTo(x, y);
        ctx.lineTo(x + width, y);
        for (const edge of [x, x + width]) {
          const ex = snapToDevice(edge, dpr);
          ctx.moveTo(ex, 0);
          ctx.lineTo(ex, groupBandHeight);
        }
        ctx.stroke();
      }
    };
    const drawScrollColHeaders = (): void => {
      for (let col = body.cols.start; col < body.cols.end; col += 1) {
        drawColHeader(col);
      }
      drawColumnGroups(body.cols.start, body.cols.end);
    };
    // DD-039: 固定列の見出しとスクロール列の見出しを pane 境界で切り分ける。scrollColRange() は
    // 固定境界に半分かかる列と overscan 分の列を含むため、単一 clip だとそれらが固定帯の内側へ描かれる。
    const frozenW = transform.frozenWidth();
    if (frozenW <= 0) {
      // 固定列なし＝スクロール側の矩形が帯 clip と一致するので入れ子を張らない（現行と同一の描画）。
      drawScrollColHeaders();
    } else {
      withBandClip(headerWidth, 0, frozenW, headerHeight, () => {
        for (let col = corner.cols.start; col < corner.cols.end; col += 1) {
          drawColHeader(col);
        }
        drawColumnGroups(corner.cols.start, corner.cols.end);
      });
      withBandClip(headerWidth + frozenW, 0, viewportWidth - headerWidth - frozenW, headerHeight, drawScrollColHeaders);
    }
    ctx.restore();

    // 行番号ヘッダー（左帯）。
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, headerHeight, headerWidth, Math.max(0, frame.viewportHeight - headerHeight));
    ctx.clip();
    ctx.fillStyle = colors.headerBackground;
    ctx.fillRect(0, headerHeight, headerWidth, frame.viewportHeight);
    ctx.fillStyle = colors.headerText;
    ctx.font = headerFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const drawRowHeader = (row: number): void => {
      const rect = transform.rowHeaderRect(row);
      ctx.fillText(String(row + 1), headerWidth / 2, rect.y + rect.height / 2);
    };
    const drawScrollRowHeaders = (): void => {
      for (let row = body.rows.start; row < body.rows.end; row += 1) {
        drawRowHeader(row);
      }
    };
    // DD-039: 行番号も同型（固定行の番号にスクロール行の番号が重なるのを pane 境界で止める）。
    const frozenH = transform.frozenHeight();
    if (frozenH <= 0) {
      drawScrollRowHeaders();
    } else {
      withBandClip(0, headerHeight, headerWidth, frozenH, () => {
        for (let row = corner.rows.start; row < corner.rows.end; row += 1) {
          drawRowHeader(row);
        }
      });
      withBandClip(0, headerHeight + frozenH, headerWidth, frame.viewportHeight - headerHeight - frozenH, drawScrollRowHeaders);
    }
    ctx.restore();

    // 左上コーナー。
    ctx.fillStyle = colors.headerBackground;
    ctx.fillRect(0, 0, headerWidth, headerHeight);
    // ヘッダー境界線（device snap）。
    ctx.strokeStyle = colors.gridLine;
    ctx.lineWidth = deviceLineWidth(dpr);
    ctx.beginPath();
    const hx = snapToDevice(headerWidth, dpr);
    ctx.moveTo(hx, 0);
    ctx.lineTo(hx, frame.viewportHeight);
    ctx.stroke();
  };

  return {
    textCache,
    draw(frame) {
      ctx.clearRect(0, 0, frame.viewportWidth, frame.viewportHeight);
      // 4 象限を描画順（body → left → top → corner）で塗り、固定領域が上に来るようにする。
      const panes = frame.transform.panes();
      drawPane(frame, findPane(panes, 'body'));
      drawPane(frame, findPane(panes, 'left'));
      drawPane(frame, findPane(panes, 'top'));
      drawPane(frame, findPane(panes, 'corner'));
      drawHeaders(frame);
      drawBorders(ctx, frame, headerWidth, headerHeight, deps);
      drawHeaderBottomBorder(ctx, frame, headerHeight, colors.headerText);
    },
  };
}
