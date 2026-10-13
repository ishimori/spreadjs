// 高 DPI（devicePixelRatio）ユーティリティ（計画書 §12.4）。
// DOM 非依存の純粋関数のみ。実際の Canvas 確保・scale 適用は base-layer / main が行う。
//
// 方針: バッキングストア = CSS サイズ × DPR。コンテキストは scale(dpr, dpr) 済みとし、
// 描画座標は CSS px で統一する。1px 罫線は device pixel へ snap して非整数 DPR でも
// にじまないようにする（DD-002 の「round+0.5」を DPR 対応へ一般化したもの）。

/** CSS ピクセルの幅・高さ。 */
export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

/** 有効な DPR を返す（0・NaN・負値は 1 に丸める）。 */
export function normalizeDpr(dpr: number): number {
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/** Canvas の表示原点を最寄りの実画素へ移す CSS offset（最大 0.5 device px）。 */
export function devicePixelOffset(cssOrigin: number, dpr: number): number {
  const d = normalizeDpr(dpr);
  return Math.round(cssOrigin * d) / d - cssOrigin;
}

/** CSS サイズからバッキングストア（実ピクセル）サイズを算出する。 */
export function backingSize(cssSize: PixelSize, dpr: number): PixelSize {
  const d = normalizeDpr(dpr);
  return {
    width: Math.round(cssSize.width * d),
    height: Math.round(cssSize.height * d),
  };
}

/**
 * scale(dpr, dpr) 済みコンテキストで device 1px の罫線を描くための CSS 座標を返す。
 * device 上で `round(css*dpr) + 0.5` になるよう CSS 座標へ逆算する。
 * これに `deviceLineWidth(dpr)` を lineWidth に使うと、任意 DPR で 1 device px のくっきり線になる。
 */
export function snapToDevice(css: number, dpr: number): number {
  const d = normalizeDpr(dpr);
  return (Math.round(css * d) + 0.5) / d;
}

/** scale(dpr, dpr) 済みコンテキストで device 1px 相当の lineWidth（CSS 単位）。 */
export function deviceLineWidth(dpr: number): number {
  return 1 / normalizeDpr(dpr);
}
