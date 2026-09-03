// resize-interaction（DD-012-4）: 列ヘッダー右端／行ヘッダー下端のドラッグによる列幅・行高リサイズの
// **純粋計算**（DOM 非依存・ViewportTransform だけに依存）。ヒット判定・クランプ・ドラッグ中サイズ算出を
// ここへ集約し、mount-controller は pointer イベント配線と Axis 更新だけを担う（テスト容易性・§13.3）。
//
// 座標系は viewport.ts と同一（stage-local CSS px）。境界の掴み代（handle）はヘッダー境界線の ±handlePx。
// ヘッダー境界は「列 c の右端＝列 c+1 の左端」を共有するため、どちらの側から掴んでも列 c を対象にする
// （Excel 準拠。行も同様）。判定は境界線までの距離で行い、末尾要素より外側の空白帯（hitTest が最終列/行へ
// クランプする領域）を誤ってリサイズ対象にしない。frozen 境界越え（隣接でない列）は adjacency で除外する。

import type { ViewportTransform } from '@nanairo-sheet/render';

/** 掴み代（ヘッダー境界線からの許容 px・D3）。 */
export const RESIZE_HANDLE_PX = 4;
/** 列幅クランプ（D3）。 */
export const COLUMN_MIN_WIDTH = 20;
export const COLUMN_MAX_WIDTH = 2000;
/** 行高クランプ（D3）。 */
export const ROW_MIN_HEIGHT = 16;
export const ROW_MAX_HEIGHT = 2000;
/** 隣接判定の許容誤差（prefix sum は厳密一致するが浮動小数の丸めを吸収）。 */
const ADJACENCY_EPS = 0.5;

/** リサイズ対象（index はリサイズされる列/行の表示 index）。 */
export type ResizeTarget =
  | { readonly axis: 'column'; readonly index: number }
  | { readonly axis: 'row'; readonly index: number };

/** resizeHitTest の設定。rowCount/colCount は空 Axis での getId 例外を避けるためのガードに使う。 */
export interface ResizeHitConfig {
  readonly headerWidth: number;
  readonly headerHeight: number;
  readonly rowCount: number;
  readonly colCount: number;
  /** 掴み代（省略時 RESIZE_HANDLE_PX）。 */
  readonly handlePx?: number;
}

export function clampColumnWidth(px: number): number {
  return Math.min(Math.max(px, COLUMN_MIN_WIDTH), COLUMN_MAX_WIDTH);
}

export function clampRowHeight(px: number): number {
  return Math.min(Math.max(px, ROW_MIN_HEIGHT), ROW_MAX_HEIGHT);
}

/**
 * (x, y)（stage-local CSS px）がヘッダー境界線の掴み代内なら、リサイズ対象を返す（無ければ null）。
 * - 列ヘッダー帯（y < headerHeight かつ x >= headerWidth）: 列 c の右境界の ±handle 内 → 列 c。
 *   列 c の左境界（= 列 c-1 の右境界）の ±handle 内 かつ 列 c-1 が viewport 上で隣接 → 列 c-1。
 * - 行ヘッダー帯（x < headerWidth かつ y >= headerHeight）: 同様。
 * corner（両ヘッダー）・セル領域・末尾要素より外側の空白帯は対象外。
 */
export function resizeHitTest(
  transform: ViewportTransform,
  x: number,
  y: number,
  cfg: ResizeHitConfig,
): ResizeTarget | null {
  const handle = cfg.handlePx ?? RESIZE_HANDLE_PX;

  // 列ヘッダー帯（corner を除く）。
  if (y < cfg.headerHeight && x >= cfg.headerWidth && cfg.colCount > 0) {
    const hit = transform.hitTest(x, y);
    if (hit.area !== 'column-header') {
      return null;
    }
    const c = hit.colIndex;
    const rect = transform.columnHeaderRect(c);
    // 右境界の ±handle 内 → 列 c（空白帯は境界線から離れるので abs で除外される）。
    if (Math.abs(x - (rect.x + rect.width)) <= handle) {
      return { axis: 'column', index: c };
    }
    // 左境界の ±handle 内 かつ 列 c-1 が実際に隣接（右端が rect.x に一致）→ 列 c-1。
    if (c > 0 && Math.abs(x - rect.x) <= handle) {
      const prev = transform.columnHeaderRect(c - 1);
      if (Math.abs(prev.x + prev.width - rect.x) <= ADJACENCY_EPS) {
        return { axis: 'column', index: c - 1 };
      }
    }
    return null;
  }

  // 行ヘッダー帯（corner を除く）。
  if (x < cfg.headerWidth && y >= cfg.headerHeight && cfg.rowCount > 0) {
    const hit = transform.hitTest(x, y);
    if (hit.area !== 'row-header') {
      return null;
    }
    const r = hit.rowIndex;
    const rect = transform.rowHeaderRect(r);
    if (Math.abs(y - (rect.y + rect.height)) <= handle) {
      return { axis: 'row', index: r };
    }
    if (r > 0 && Math.abs(y - rect.y) <= handle) {
      const prev = transform.rowHeaderRect(r - 1);
      if (Math.abs(prev.y + prev.height - rect.y) <= ADJACENCY_EPS) {
        return { axis: 'row', index: r - 1 };
      }
    }
    return null;
  }

  return null;
}

/**
 * ドラッグ中のポインタ位置（stage-local coord）と対象の左端/上端（edge・viewport 座標）から
 * 新しいサイズ（px・クランプ済み）を求める。列は x−左端、行は y−上端。edge は毎 move で現在 transform から
 * 再解決すること（スクロールや他クライアントの構造Op で対象の viewport 位置が動くため・DD-012-4 Codex[P2]）。
 */
export function computeResizeSize(axis: 'column' | 'row', coord: number, edge: number): number {
  return axis === 'column' ? clampColumnWidth(coord - edge) : clampRowHeight(coord - edge);
}

/** auto-fit（DD-027-3・列内容 + 左右パディング）の列幅計算。 */
export interface AutoFitColumnInput {
  /** 列内の非空セル内容の最大表示幅（px・text-cache measureWidth 済み。バッジ値はチップ幅・空列は 0）。 */
  readonly maxContentWidth: number;
  /** 列ヘッダーラベル（A, B, ...）の表示幅（px・Excel 準拠で含める）。 */
  readonly headerLabelWidth: number;
  /** セル文字の左右パディング合計（px・CELL_TEXT_PADDING * 2）。 */
  readonly padding: number;
}

/**
 * ダブルクリック auto-fit の列幅を算出する（DD-027-3・C級・純関数＝TDD 対象）。列の最長表示内容とヘッダーラベル幅の
 * 大きい方 ＋ 左右パディングを clampColumnWidth（20〜2000px）で丸める。走査打ち切り（10,000 セル超）は呼び出し側が
 * それまでの最大値を maxContentWidth に渡すため、本関数は打ち切りの有無に依存しない（計算は同一）。
 */
export function autoFitColumnWidth(input: AutoFitColumnInput): number {
  const content = Math.max(0, input.maxContentWidth, input.headerLabelWidth);
  return clampColumnWidth(Math.ceil(content) + input.padding);
}

/** auto-fit 走査の結果（DD-027-3・Fable P2・純関数＝TDD 対象）。 */
export interface AutoFitScan {
  /** 走査したセル内容の最大表示幅（px・measure + badgeExtra）。 */
  readonly maxContentWidth: number;
  /** measure した非空セル数（打ち切り時は maxScan）。 */
  readonly scanned: number;
  /** maxScan を超える非空セルがあり打ち切ったか。 */
  readonly truncated: boolean;
}

/**
 * auto-fit の列内容最大幅を求める（DD-027-3・Fable P2・純関数＝TDD 対象）。非空セル値配列を `maxScan` で打ち切り、
 * `measure`（text-cache 幅）と `badgeExtra`（バッジのチップ余白）を注入して最大幅を返す。呼び出し側は queryRange の
 * 中断（visitor が false）で `cellValues` を **maxScan+1 件までに束ねて**渡す（走査の予算保護＝50k 行列でも定数コスト）。
 * `truncated` は「maxScan を超える非空セルが存在した」＝`cellValues.length > maxScan` で判定する。
 */
export function computeAutoFitContentWidth(
  cellValues: readonly string[],
  measure: (value: string) => number,
  badgeExtra: (value: string) => number,
  maxScan: number,
): AutoFitScan {
  let maxContentWidth = 0;
  let scanned = 0;
  for (const value of cellValues) {
    if (scanned >= maxScan) {
      break; // 打ち切り: それまでの最大値を採用（measure しない・予算保護）
    }
    scanned += 1;
    const width = measure(value) + badgeExtra(value);
    if (width > maxContentWidth) {
      maxContentWidth = width;
    }
  }
  return { maxContentWidth, scanned, truncated: cellValues.length > maxScan };
}
