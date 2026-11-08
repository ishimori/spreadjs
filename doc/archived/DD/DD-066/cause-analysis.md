# DD-066 原因分析

確認日: 2026-11-08。対象: `7951231`（DD-065 完了後の未修正 SDK）。Phase 0 の調査であり、SDK のソースは変更していない。

## Bug#1: 結合範囲の内側に1セルの枠が残る

結合範囲の選択を描く Canvas overlay と、アクティブセルの枠を持つ常駐 textarea が、異なる矩形を使っている。

| 層 | 根拠となる実装 | 現状 |
|---|---|---|
| Canvas overlay | `packages/grid/src/mount/render.ts` の `overlayFrame()`、`packages/render/src/overlay-layer.ts` の `drawSelection()` | `expandRangeToMerges()` で範囲全体を囲み、pane ごとに clip する |
| 常駐 textarea | `packages/grid/src/integration-editor.ts` の `refreshPlacement()` → `packages/grid/src/editor-placement.ts` の `computeEditorPlacement()` | `transform.cellRect(rowIndex, colIndex)` で1セルだけを計算。結合の情報を受け取っていない |
| textarea の枠と高さ | `integration-editor.ts` の初期スタイル・`port.place()`・`applyHeight()` | 枠は `2px solid #1a73e8`。Navigation 中の高さは渡された矩形の高さのまま |

3行×1列の場合、結合範囲は80×66 CSS pxなのに、textarea は80×22 CSS pxのまま。クリック後は外周と1行目の内枠が同時に見える。値・選択の正規化・結合からの移動の不具合ではない。

### 初期表示の訂正: フォーカスだけでは説明できない

`render.ts` は選択の shadow を `null` で初期化し、`editor-wiring.ts` の `onChange()` で `setActiveShadow()` する。最初から(0,0)が結合の左上なら、`merges.normalizeActiveCell()` は移動不要で何もしないため、初回の shadow が未設定のまま描かれる経路がある。

標準の standalone playground は mount の後に `instance.focus()` を呼ぶため、フォーカスしない SDK mount を調べるには、この自動 focus を避けて public `mount()` で同じコンテナへ再 mount する必要があった。

| 状態 | textarea に focus | overlay の同一ピクセル（RGBA） | textarea |
|---|---|---|---|
| 自動 focus なしで mount 直後 | false | `[0,0,0,0]` | 80×22 |
| 同じ結合の中をクリック | true | `[25,115,230,31]` | 80×22 |
| クリック後に blur | false | `[25,115,230,31]` | 80×22 |

focus が無くなっても外枠の塗りは残った。起票時の「フォーカスが無いと overlay が選択を描かない」は誤りで、**選択の初期反映前**と**反映後の blur**を区別すべきだった。採用済みの方針（textarea を結合全体へ広げる）は維持する。overlay の枠だけに任せる方式では、初期反映前の表示が解決しない。

## 一部だけ見えるときの境界

`computeEditorPlacement()` は1セルと pane の交差の有無だけを見て、返す矩形は切り詰めない。textarea は stage 直下にあり、stage 全体の `overflow:hidden` だけではヘッダー・固定帯へのはみ出しを防げない。

固定1行・固定1列、r2/col-b の例（行高22、列幅80、ヘッダー高24）:

- pane 上端は46。scrollTop≈33.333 のとき、セルの上端は約34.667で、textarea の枠が約11.333pxだけ固定行へ入り込む。結合なしの1セルでも同じ現象を確認した
- 同じ場所を3行結合すると、正しい範囲は y≈34.667・高さ66。単純に高さだけを増やすと、上端の枠のはみ出しが残る
- scrollTop=50では、左上の1セルは y=18..40で pane より上へ隠れるが、結合全体は y=18..84で、46..84の38pxはまだ見える。現状の textarea は左上セルだけで可視判定するため `display:none` になる
- フォーカス中の textarea がこの条件で非表示になると blur が発生し、選択の可視域追従により scrollTop が22へ戻る場合も観測した。範囲の可視判定と、focus を失わないことを回帰確認する

固定2列の中の3行×2列結合でも、横スクロール120後に正しい範囲は x=52・160×66なのに textarea は x=52・80×22。固定帯の所属は正しく、枠の矩形だけが小さい。

## 修正方針（論点1・2の具体化、実装はゲート通過後）

1. Navigation 中に結合の左上を示すときだけ、配置と可視判定に結合全体の矩形を使う。`mergedCellRect()` 相当の共通計算で Canvas と揃える
2. 結合全体の実際の座標を保ち、枠をその pane のデータ領域と交差する部分だけに表示する。clip で隠れた上端へ新しい枠を描き直したり、textarea 自体を見えている場所へずらしたりしない
3. 結合の外へ出たら、1セルの矩形と既存の編集経路へ戻す。wrap・候補欄・日付の配置、composition 中の value/selection/DOM親を変更しない
4. DD-065 後の結線は `mount/editor-wiring.ts` と `mount/render.ts`。既存の結合 owner の getter を渡し、組み立てファイルの再肥大を避ける

実装時の候補は、配置の純関数が「実矩形と pane の clip」を返し、Navigation 中の結合セルにだけ DOM の clip を適用する方式。CSSの実装方法は確定しておらず、既存の1セルの見え方は本 DD では変えない。

## 影響と検証範囲

- 両モード共通の editor 配置の問題。Phase 0 の画面再現は単独モードで実施。共同編集モードは Phase 1 以降の回帰対象
- `editor-placement.ts`・`integration-editor.ts`・`overlay-layer.ts` は alpha.19 の `bd2985f` と差分なし。調査は現行 checkout を使い、DD-065 の分割中コードを避けるための旧 worktree は再作成していない
- 対象テスト: 配置の純関数（縦・横・固定・スクロール・一部／全部不可視）、実物 E2E（初期 focus なし・クリック・blur・隣のセルへ戻る・合成 composition・スクロール・候補欄・日付・wrap）
- 実 Microsoft IME と consumer の画面への適用は未確認。公開 API・文書データ・protocol を変える必要はない

数値と画像は `reproduction.json`、`bug-report.md` を参照。
