// link-column（DD-027-2）: ハイパーリンク列のクリック裁定（候補追跡方式）の純関数。
//
// 【設計方針（📐 確定・既存クリック裁定へ上乗せ・T1 非該当）】
//   既存の pointerdown 経路（activeCell 移動・ドラッグ選択開始・Shift+クリック・IME/編集裁定）は無変更のまま、
//   「クリック完了」判定を pointerdown〜pointerup の候補追跡として上乗せする。本モジュールは「pointerdown 時点で
//   link 候補を武装（arm）してよいか」だけを純関数で決める（DOM 非依存＝TDD 対象）。候補の記録・ドラッグでの破棄・
//   pointerup での発火は mount-controller が担う（状態遷移は編集状態機械に触れない）。
//
// 【裁定表（arm 条件・AC1/AC3/AC4/AC8）】
//   button===0 && pointerType!=='touch' && isPrimaryClick && リンク列 && 値非空 && Navigation 位相 && 非 composing && 非 Shift のときだけ arm。
//   - isPrimaryClick=false（連打の2打目以降）: arm しない → dblclick 編集の 1 打目でのみ link-open が発火（📐 確定）。
//     ※ isPrimaryClick は mount-controller が算出する: 実ブラウザーは `PointerEvent.detail`（1打目=1・2打目=2+）で、
//       synthetic（Playwright は detail=0 固定）は「直近発火からの経過時間＋同一セル」の dblclick 判定で補う（同じ観測結果）。
//   - touch（タップ）: arm しない（Fable P2: 公開契約「キーボード/タッチでは発火しない」と一致させる。mouse・pen は arm）。
//   - Editing/Composing 中のクリック（phase!==Navigation / composing）: arm しない → 従来経路のまま（AC8）。
//   - Shift+クリック（レンジ拡張）: arm しない（AC3）。
//   - 空セル: arm しない（AC2・発火なし）。

import type { EditPhase } from '@nanairo-sheet/ime';

/** pointerdown 時点の候補武装判定の入力（すべて pointerdown 直前の状態＝pointerdownCell を呼ぶ前に採取する）。 */
export interface LinkCandidateInput {
  /** PointerEvent.button（主ボタン=0 のみ対象）。 */
  readonly button: number;
  /**
   * PointerEvent.pointerType（'mouse'|'pen'|'touch'|''）。touch は arm しない（Fable P2: 公開契約「タッチでは発火しない」と
   * 一致・実機タップの誤発火防止）。mouse・pen・空文字（synthetic 由来の未指定）は許可する。
   */
  readonly pointerType: string;
  /**
   * 単クリック/連打の1打目か（dblclick の2打目以降は false）。mount-controller が detail と time-guard から算出する
   * （📐 の「detail===1」を実ブラウザー/synthetic 両対応にした観測等価の判定）。
   */
  readonly isPrimaryClick: boolean;
  /** hit セルがリンク列か（列単位・registry.isLinkColumn）。 */
  readonly isLinkColumn: boolean;
  /** hit セルの表示値が非空か（空セルはリンク装飾も発火も無し）。 */
  readonly valueNonEmpty: boolean;
  /** pointerdown 直前の編集位相（Navigation のみ arm・編集中クリックは従来経路＝AC8）。 */
  readonly phase: EditPhase;
  /** 状態機械の内部 composing フラグ（変換中はクリックで発火しない・AC8）。 */
  readonly composing: boolean;
  /** Shift 併用か（Shift+クリック＝レンジ拡張は arm しない・AC3）。 */
  readonly shiftKey: boolean;
}

/**
 * pointerdown 時点で link 候補を武装（arm）してよいか（候補追跡方式・📐）。true のとき mount-controller は候補を
 * 記録し、ドラッグで開始セルを離れなければ pointerup で `link-open` を発火する。既存分岐（Shift+クリック・
 * リサイズ・編集中クリック・dblclick 2打目）はこの条件を満たさないため従来挙動が保存される。
 */
export function shouldArmLinkCandidate(input: LinkCandidateInput): boolean {
  return (
    input.button === 0 &&
    input.pointerType !== 'touch' &&
    input.isPrimaryClick &&
    input.isLinkColumn &&
    input.valueNonEmpty &&
    input.phase === 'Navigation' &&
    !input.composing &&
    !input.shiftKey
  );
}
