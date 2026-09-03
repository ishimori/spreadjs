// base レイヤー描画（計画書 §12.1/§12.2/§12.4/§12.5）: セル背景・文字・罫線・ヘッダー。
// 固定行列は 4 象限を clip region で 1 Canvas に描く（§12.2）。罫線は device pixel へ snap（§12.4）。
// 文字は measureText キャッシュ＋セル clip（§12.5）。可視非空セルのみ chunk-store の範囲クエリで描く。
//
// 本モジュールは Canvas API に依存する（描画アダプタの隔離）。座標計算は viewport.ts に委ね、
// ここは「与えられた ViewportTransform をどう塗るか」だけを持つ。単体テストは座標側（viewport 等）で行う。

import type { ChunkStore } from './chunk-store';
import { deviceLineWidth, snapToDevice } from './dpi';
import { createTextMetricsCache, type TextMetricsCache } from './text-cache';
import { MAX_LEFT_INFLOW_SCAN, nearestLeftNonEmpty, overflowRightExtent } from './text-overflow';
import type { PaneId, PaneRange, ViewportTransform } from './viewport';

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

export interface BaseLayerDeps {
  readonly ctx: CanvasRenderingContext2D;
  readonly store: ChunkStore;
  readonly headerWidth: number;
  readonly headerHeight: number;
  readonly colors?: BaseLayerColors;
  readonly cellFont?: string;
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
  const cellFont = deps.cellFont ?? '13px system-ui, sans-serif';
  const linkUnderlineOffsetPx = linkUnderlineOffset(parseFontSizePx(cellFont));
  const headerFont = deps.headerFont ?? '12px system-ui, sans-serif';
  const isWrapColumn = deps.isWrapColumn ?? (() => false);
  const isLinkColumn = deps.isLinkColumn ?? (() => false);
  const getCellStyle = deps.getCellStyle ?? (() => undefined);
  // DD-033-2: 表示書式フック（未指定なら恒等＝raw 素通し）。判定は raw・描画は display（下の visitor 参照）。
  const formatCellText = deps.formatCellText ?? ((_col: number, raw: string) => raw);
  const columnHeaderLabelFn = deps.columnHeaderLabel;
  const frozenColCount = deps.frozenColCount ?? 0;
  const cellFontSizePx = parseFontSizePx(cellFont);
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
      const boundary =
        col === pane.cols.end ? right : transform.cellRect(pane.rows.start, col).x;
      const x = snapToDevice(boundary, dpr);
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    // 横罫線（行境界）。
    for (let row = pane.rows.start; row <= pane.rows.end; row += 1) {
      const boundary =
        row === pane.rows.end ? bottom : transform.cellRect(row, pane.cols.start).y;
      const y = snapToDevice(boundary, dpr);
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
  };

  /** wrap 列セル: 折り返し複数行をセル内に clip して描く（DD-012-5 D4）。clipTop/clipBottom は pane 可視帯（Codex P1 対策）。 */
  const drawWrapCell = (
    transform: ViewportTransform,
    row: number,
    col: number,
    value: string,
    clipTop: number,
    clipBottom: number,
  ): void => {
    const rect = transform.cellRect(row, col);
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
    const ext = overflowRightExtent(col, maxColExclusive, isEmptyAt);
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
  const drawLinkCell = (
    transform: ViewportTransform,
    dpr: number,
    row: number,
    col: number,
    value: string,
  ): void => {
    const rect = transform.cellRect(row, col);
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
    const w = rect.width - inset;
    const h = rect.height - inset;
    if (w <= 0 || h <= 0) {
      return;
    }
    ctx.fillStyle = background;
    ctx.fillRect(rect.x + inset, rect.y + inset, w, h);
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
   */
  const drawBadgeCell = (
    transform: ViewportTransform,
    row: number,
    col: number,
    value: string,
    style: ResolvedCellStyle,
  ): void => {
    const rect = transform.cellRect(row, col);
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
    ctx.fillStyle = style.textColor ?? colors.cellText;
    ctx.textAlign = 'left';
    ctx.fillText(text, chipX + BADGE_TEXT_PADDING, rect.y + rect.height / 2);
  };

  const drawPaneValues = (frame: FrameViewport, pane: PaneRange): void => {
    const { transform } = frame;
    ctx.font = cellFont;
    ctx.textBaseline = 'middle';
    const maxCol = pane.cols.end;
    const clipTop = pane.clip.y;
    const clipBottom = pane.clip.y + pane.clip.height;
    const isEmptyAt = (row: number) => (col: number): boolean => store.get(row, col) === '';

    // Pass 1: pane 内の非空セルを描く（書式背景 → バッジ/リンク/数値/wrap/オーバーフロー）。
    store.queryRange(pane.rows.start, pane.rows.end, pane.cols.start, pane.cols.end, (row, col, value) => {
      // DD-033-2: 描画テキストを display に確定する（判定は raw・描画は display）。書式のない列・非該当 raw は raw 恒等。
      const display = formatCellText(col, value);
      // DD-027-3: セル書式（値ベース・非空セルのみ）。**match は raw 完全一致のまま**（display で match しない・DD-033-2）。
      // 背景色は罫線 inset で文字より先に塗る（罫線保存・1 pass）。
      const style = getCellStyle(col, value);
      if (style?.cellBackground !== undefined) {
        drawCellBackground(transform, frame.dpr, row, col, style.cellBackground);
      }
      // バッジは最優先（オーバーフロー/wrap/リンク/数値より前・単行チップ・右隣へはみ出さない＝DD-027-3）。
      // チップ文字は display で描く（match は raw・描画は display・DD-033-2）。
      if (style?.badge === true) {
        drawBadgeCell(transform, row, col, display, style);
        return;
      }
      // リンク列は数値/wrap より優先（列タイプが勝つ・自セル内クリップ＝クリック領域と一致・DD-027-2）。
      // 書式 textColor はリンク色（linkText）で上書きされる（リンクの視認性を優先・背景色は既に塗り済み）。
      // リンク列は表示書式と併用不可（mount fail-fast）ゆえ display===raw だが、契約上 display を渡す。
      if (isLinkColumn(col)) {
        drawLinkCell(transform, frame.dpr, row, col, display);
        return;
      }
      // 数値右寄せ判定は **raw** で行う（書式済み "1,234.5" は NUMERIC_RE 不一致＝display で判定すると右寄せが壊れる・DD-033-2）。
      const isNumber = isNumericCell(value);
      // DD-027-3: textColor があれば数値/文字の既定色より優先する（右寄せ等の配置は維持）。
      ctx.fillStyle = style?.textColor ?? (isNumber ? colors.numberText : colors.cellText);
      // wrap 列は表示書式と併用不可（mount fail-fast）ゆえ display===raw だが、契約上 display を描く。
      if (!isNumber && isWrapColumn(col)) {
        drawWrapCell(transform, row, col, display, clipTop, clipBottom);
        return;
      }
      if (isNumber) {
        const rect = transform.cellRect(row, col);
        ctx.textAlign = 'right';
        const text = textCache.fitText(display, cellFont, rect.width - CELL_PADDING * 2);
        ctx.fillText(text, rect.x + rect.width - CELL_PADDING, rect.y + rect.height / 2);
        return;
      }
      drawOverflowCell(transform, row, col, display, maxCol, isEmptyAt(row));
    });

    // Pass 2: 可視範囲の左外にあるはみ出し元からの流入を描く（D3・最大 20 列遡り・pane 境界で停止）。
    // 固定列（frozenColCount）を越えて遡らない＝pane 境界でオーバーフローを止める（D2）。
    if (pane.cols.start > frozenColCount) {
      for (let row = pane.rows.start; row < pane.rows.end; row += 1) {
        // 可視左端セルが埋まっていれば左外流入は届かない（origin→可視の間に非空セルが要る）→ 走査省略（予算保護）。
        if (store.get(row, pane.cols.start) !== '') {
          continue;
        }
        const isEmpty = isEmptyAt(row);
        const originCol = nearestLeftNonEmpty(pane.cols.start, frozenColCount, MAX_LEFT_INFLOW_SCAN, isEmpty);
        if (originCol === null) {
          continue;
        }
        const value = store.get(row, originCol);
        // 数値・wrap・リンク列はオーバーフローしない（左寄せ文字列のみ流入・リンクは自セル内クリップ＝DD-027-2）。
        // 判定は **raw**（DD-033-2・date 書式列は非数値ゆえ左外流入し得る＝display で描く必要がある）。
        if (isNumericCell(value) || isWrapColumn(originCol) || isLinkColumn(originCol)) {
          continue;
        }
        // DD-027-3: バッジ指定値は単行チップ＝オーバーフロー対象外（流入させない）。textColor は流入文字にも適用する
        // （背景色は origin セル自身の矩形〔可視左外〕にのみ塗るため、ここでは塗らない＝流入先の空セルを汚さない）。
        const originStyle = getCellStyle(originCol, value);
        if (originStyle?.badge === true) {
          continue;
        }
        ctx.fillStyle = originStyle?.textColor ?? colors.cellText;
        // DD-033-2: 流入も origin 列の書式で display を描く（判定は raw・描画は display）。
        drawOverflowCell(transform, row, originCol, formatCellText(originCol, value), maxCol, isEmpty);
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
    ctx.fillStyle = pane.pane === 'body' ? colors.cellBackground : colors.frozenBackground;
    ctx.fillRect(pane.clip.x, pane.clip.y, pane.clip.width, pane.clip.height);
    drawPaneGrid(frame, pane);
    drawPaneValues(frame, pane);
    ctx.restore();
  };

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
      // DD-033-2: キャプションフック未指定なら現行どおり列記号を素描画する（既存 consumer と完全一致・AC9）。
      if (columnHeaderLabelFn === undefined) {
        ctx.fillText(columnLabel(col), rect.x + rect.width / 2, headerHeight / 2);
        return;
      }
      // キャプションは自ヘッダーセル幅で fitText クリップ（長い業務名が隣接ヘッダーへ重ならない・AC2）。中央寄せは維持。
      const label = columnHeaderLabelFn(col);
      const text = textCache.fitText(label, headerFont, Math.max(0, rect.width - CELL_PADDING * 2));
      ctx.font = headerFont; // fitText の measure コールバックが ctx.font を触るため描画前に復帰させる。
      ctx.fillText(text, rect.x + rect.width / 2, headerHeight / 2);
    };
    for (let col = corner.cols.start; col < corner.cols.end; col += 1) {
      drawColHeader(col);
    }
    for (let col = body.cols.start; col < body.cols.end; col += 1) {
      drawColHeader(col);
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
    for (let row = corner.rows.start; row < corner.rows.end; row += 1) {
      drawRowHeader(row);
    }
    for (let row = body.rows.start; row < body.rows.end; row += 1) {
      drawRowHeader(row);
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
    const hy = snapToDevice(headerHeight, dpr);
    ctx.moveTo(hx, 0);
    ctx.lineTo(hx, frame.viewportHeight);
    ctx.moveTo(0, hy);
    ctx.lineTo(viewportWidth, hy);
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
    },
  };
}
