# DD-039 Codex レビュー依頼

## 対象

**コミット `dbd4947`「DD-039: 固定ペインのヘッダー clip 漏れを修正（Phase 1・2 完了・AC1〜7 充足）」の差分**。

| ファイル | 変更 |
|---|---|
| `packages/render/src/base-layer.ts` | `drawHeaders` の clip 分割（＋ヘルパー `withBandClip` を追加） |
| `packages/render/src/base-layer.dd039.test.ts` | 新規・unit 4 件 |
| `apps/playground/e2e/frozen-panes.spec.ts` | E2E 2 件と `regionSignature` / `scrollTop` ヘルパーを追加 |
| `CHANGELOG.md` | Fixed 節を新設 |
| `doc/DD/DD-039_*.md` / `doc/DD/DD-INDEX.md` | DD 本文・索引（レビュー対象外） |

## このDDの目的

固定行列（`frozenColumnCount` / `frozenRowCount`）を使ったまま横／縦スクロールすると、
**固定帯の裏へ回ったスクロール側の見出しが、固定ペインの見出しの上に描かれて読めなくなる**不具合の修正。
consumer（松下 納入計画・生産納期）の実機で発生していた表示バグで、値・編集・計算には影響しない。

## 原因（修正前の状態）

`drawHeaders` は列記号帯・行番号帯とも、`corner`（固定）と `body`（スクロール）の見出しを
**単一の帯 clip の中に**描いていた。`viewport.ts` の `scrollColRange()` は
`colAxis.indexAt(frozenWidth + scrollLeft - overscanX)` から始まるため、`body.cols` には
**固定境界に半分かかる列**と **overscan 分の列**が必ず含まれる。それらの
`columnHeaderRect(col).x = headerWidth + offsetOf(col) - scrollLeft` は固定帯の内側に落ちるので、
固定列の見出しの上へそのまま描かれていた。行も同型。
セル本体（`drawPane`）は pane ごとに `pane.clip` を張るため無事だった。

## 設計意図（この形にした理由）

1. **帯 clip・背景 fill・左上コーナー・境界線は一切動かさず**、帯 clip の**内側に入れ子 clip** を張って
   テキスト描画だけを固定側／スクロール側へ分けた。入れ子＝交差なので帯からはみ出さず、
   「修正前と同一であること」を差分の構造で担保する意図。
2. **固定幅／固定高が 0 のときは入れ子を張らず現行どおり 1 回で描く**（`frozenColumnCount: 0` は
   consumer が実際に使う設定なので、無駄な clip を張らない）。
3. clip 矩形は `ViewportTransform.frozenWidth()` / `frozenHeight()` から組む。corner pane の `clip` は
   縦方向がセル領域用（`y` が `headerHeight` 始まり）でヘッダー帯と食い違うため流用しない。

## 制約（守っているはずの前提）

- 変更は `packages/render/src/base-layer.ts` の `drawHeaders` に閉じる。`packages/ime/*`・
  `editor-state-machine`・`ime-editing-session`・`mount-controller` は無改変。
- 公開 API の追加・変更なし（`.d.ts` snapshot 差分なし）。boundary lint new=0。
- 全回帰 green（unit 1216 / E2E 154 / typecheck / lint）。
- 性能: `frameP95` は修正前後とも 16.8ms（予算 33ms）。修正前後で交互に 6 本計測済み。

## 評価してほしい観点（優先順）

1. **描画の正しさ・境界条件**: clip 矩形の算術に穴がないか。特に異常構成
   （固定帯が viewport より広い／全列固定＝`frozencols=99`／固定数が列数を超える／
   `viewportWidth - headerWidth - frozenW` が負）で、描画が消える・はみ出す・負幅の clip を張る等がないか。
2. **「修正前と同一」の主張が本当か**: `frozenColumnCount: 0` / `frozenRowCount: 0` のとき、
   および `scrollLeft = scrollTop = 0` の初期表示で、修正前と描画が変わっていないと言い切れるか。
3. **ctx 状態管理**: `save`/`restore` の対称性、`font` / `textAlign` / `textBaseline` / `fillStyle` の
   復帰、`beginPath` の位置。`drawColHeader` 内で `textCache.fitText` が `ctx.font` を触る経路との相互作用。
4. **テストの妥当性**: `base-layer.dd039.test.ts` の ctx スタブ（clip スタックの追跡）が
   Canvas の実挙動を取り違えていないか。assert が実装の写経になっていて別の壊れ方を素通ししないか。
   E2E の `regionSignature`（実ピクセルの FNV-1a 指紋）は flake しないか（DPR・アンチエイリアス・
   再描画タイミング）。**なお、修正前のコードでは unit 3/4・E2E 2/2 が実際に fail することは確認済み。**
5. **同根パターンの見落とし**: render 層に、pane 境界を無視した単一 clip の描画が他に残っていないか。
6. **コーディング規約との整合**: `doc/templates/coding-standards.md` の基準（命名・コメントの粒度・
   関数の責務）に照らして、`withBandClip` の導入位置とコメント量が適切か。

## 対象外（指摘不要）

- **仕様の是非**: 「固定境界をまたぐ見出しが境界で文字切れする見え方でよいか」は決定済み（セル本体と同じ扱いに揃える）。
- **overlay の Presence マーカーが pane 境界を無視している件**: 実読で把握済みで、**DD-041 として別途起票済み**。
  本 DD では `overlay-layer.ts` を意図的に触っていない。
- **性能最適化の提案**: 計測済みで予算内（frameP95 16.8ms / 予算 33ms）。さらなる最適化は本 DD のスコープ外。
- `CHANGELOG.md` の文面、DD 本文・DD-INDEX の書き方、release スクリプト、他 DD の差分。
