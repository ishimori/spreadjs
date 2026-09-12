// popup-placement（DD-055・ReadyCrew RC16）: セルに対して開く候補欄（選択式のドロップダウン・日付のカレンダー）の
// 位置を決める純関数（DOM 非依存＝TDD 対象）。
//
// 候補欄は stage（overflow:hidden）の子で、枠を越えた部分は描かれない。可視域（ネイティブスクロールバーを除いた
// scroller の client 寸法・原点は stage の左上）の中に収める:
//   - 縦: 下の余白に入りきれば従来どおりセルの真下。入りきらず上の余白のほうが広ければセルの上（候補欄の下端を
//     セルの上端に揃える）。高さは開いた側の余白を上限にし、はみ出す分は候補欄の内部スクロールにする。上端は
//     stage の上端（列見出しに重なってよい）。
//   - 向きは開いた時点で決め、開いている間は呼び出し側が保持して渡す（スクロール・絞り込みで上下に跳ねない）。
//   - 横: 可視域の右端を越えるなら右端に揃うまで左へずらす（左端 0 でクランプ）。

import type { CellRect } from '@nanairo-sheet/render';

/** 可視域の幅・高さ（stage 座標。ネイティブスクロールバーを除く）。 */
export interface VisibleArea {
  readonly width: number;
  readonly height: number;
}

/** 候補欄をセルのどちら側に開くか。 */
export type PopupDirection = 'down' | 'up';

export interface PopupPlacementInput {
  /** 候補欄を開くセルの矩形（stage 座標）。 */
  readonly cellRect: CellRect;
  readonly popupWidth: number;
  /** 余白で縮める前の候補欄の高さ（内容の高さ。既定の上限があればそれ以下へ丸めた値）。 */
  readonly popupHeight: number;
  readonly visibleArea: VisibleArea;
  /** 開いた時点で決めた向き。渡せばそれを保つ（未指定なら余白から決める）。 */
  readonly direction?: PopupDirection | undefined;
}

export interface PopupPlacement {
  readonly direction: PopupDirection;
  readonly left: number;
  readonly top: number;
  /** 開いた側の余白の高さ（候補欄の高さの上限。はみ出す分は内部スクロール）。 */
  readonly maxHeight: number;
}

export function computePopupPlacement(input: PopupPlacementInput): PopupPlacement {
  const { cellRect, popupWidth, popupHeight, visibleArea } = input;
  const cellBottom = cellRect.y + cellRect.height;
  const spaceBelow = Math.max(0, visibleArea.height - cellBottom);
  const spaceAbove = Math.max(0, cellRect.y);
  const direction = input.direction ?? (popupHeight <= spaceBelow || spaceBelow >= spaceAbove ? 'down' : 'up');
  const maxHeight = direction === 'down' ? spaceBelow : spaceAbove;
  const top = direction === 'down' ? cellBottom : cellRect.y - Math.min(popupHeight, maxHeight);
  const left = Math.max(0, Math.min(cellRect.x, visibleArea.width - popupWidth));
  return { direction, left, top, maxHeight };
}
