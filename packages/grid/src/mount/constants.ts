// grid の mount 配線の部品（DD-065 で mount-controller.ts から分けた）が共有する定数と小さな補助。

import type { GridPresenceUser } from '../index';

export const HEADER_WIDTH = 52;
/** 見出し 1 段の高さ（DD-064 K4: 2段の見出しでは上の段・下の段がそれぞれこの高さ）。 */
export const HEADER_HEIGHT = 24;
export const ROW_HEIGHT = 22;
export const COL_WIDTH = 80;
/** DD-063: 確定前の検証をする経路（`cell-invalid` の `source`）。 */
export type CellValidationSource = 'edit' | 'select' | 'date' | 'paste';
export const TICK_INTERVAL_MS = 1_000;
// リンク列 dblclick の2打目抑止窓（ms・DD-027-2）。同一セルでこの間隔内の連打は「2打目」と見なし link-open を再発火しない
// （実ブラウザーは PointerEvent.detail>=2 が主判定・本窓は detail=0 固定の synthetic 環境を補完する）。標準 dblclick 相当。
export const LINK_DBLCLICK_MS = 400;
// auto-fit の非空セル走査上限（DD-027-3・C級）。50k 行列の単発 dblclick でも予算内に収めるため、これを超えたら
// それまでの最大幅を採用して打ち切る（診断 info）。
export const AUTO_FIT_MAX_SCAN = 10_000;
// DD-035 R6: 命令 API（scrollToRow/setActiveCell）の保留上限（構造 flush 待ち・初回描画待ち）。
export const PENDING_COMMANDS_MAX = 64;
// DD-049 H5: 参加者なし（単独モード・初回 join 前・destroy 後）の共有空一覧。
export const NO_PRESENCE_USERS: readonly GridPresenceUser[] = Object.freeze([]);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
