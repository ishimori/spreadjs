// Excel 風テキストオーバーフローの走査純関数（DD-012-5 D2/D3）。DOM/Canvas 非依存で単体検証する。
// base-layer はここで決めた「延長範囲」「左外流入元」を使って、実際の Canvas 描画（clip 込み）を行う。
//
// 対象は左寄せ描画の文字列セルのみ（数値=右寄せ・wrap 列は対象外＝呼び出し側が除外する）。
// 右方向の連続空セルへ表示を延長し、非空セルの手前・pane（可視範囲）境界で止める。データは不変（描画のみ）。

/** 左外流入の遡り探索の最大列数（D3・境界として明記。20 列を超える流入は描画しない）。 */
export const MAX_LEFT_INFLOW_SCAN = 20;

/** オーバーフロー延長の結果。 */
export interface OverflowExtent {
  /** 延長が届く排他終端列（この列は含まない）。originCol+1 なら延長なし。 */
  readonly endColExclusive: number;
  /**
   * 非空セルで止まったか。true=範囲内の非空セル手前でクリップ（省略記号あり＝AC2）。
   * false=可視範囲端まで空が続いた（clip で自然に切れる＝AC1 のはみ出し全文）。
   */
  readonly blocked: boolean;
}

/**
 * originCol（左寄せ文字列セル）から右方向へ、連続する空セルを跨いだ延長範囲を求める。
 * maxColExclusive は pane の可視範囲終端（overscan 込み）。非空セルに当たればそこで止める（blocked）。
 */
export function overflowRightExtent(
  originCol: number,
  maxColExclusive: number,
  isEmpty: (col: number) => boolean,
  isBoundaryBlocked?: (boundaryIndex: number) => boolean,
): OverflowExtent {
  let c = originCol + 1;
  while (c < maxColExclusive && !isBoundaryBlocked?.(c) && isEmpty(c)) {
    c += 1;
  }
  // c < maxColExclusive なら非空セルで止まった（blocked）。c === maxColExclusive なら可視端まで空。
  return { endColExclusive: c, blocked: c < maxColExclusive || isBoundaryBlocked?.(c) === true };
}

/**
 * startColExclusive の左隣から最大 maxScan 列（かつ minCol 以上）を遡り、直近の非空セル列を返す（無ければ null）。
 * 可視範囲の左外にあるはみ出し元（D3）を見つけるために使う。pane 境界（minCol）を越えて遡らない。
 */
export function nearestLeftNonEmpty(
  startColExclusive: number,
  minCol: number,
  maxScan: number,
  isEmpty: (col: number) => boolean,
  isBoundaryBlocked?: (boundaryIndex: number) => boolean,
): number | null {
  let steps = 0;
  for (let c = startColExclusive - 1; c >= minCol && steps < maxScan; c -= 1, steps += 1) {
    if (isBoundaryBlocked?.(c + 1)) return null;
    if (!isEmpty(c)) {
      return c;
    }
  }
  return null;
}
