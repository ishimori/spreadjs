# DD-039: 固定ペインのヘッダー clip 漏れ（consumer 駆動: 松下 納入計画・生産納期）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-03 | 2026-09-03 | 進行中 | 不具合修正。固定ペインの列見出し／行番号に、スクロール側の見出しが重なって描かれる。要件正本は松下リポ `doc/DD/DD-014/sdk-requirements.md` **§C 追補 C7**。原因は `base-layer.ts` の `drawHeaders` が pane 境界で clip を分けていないこと。**Phase 1・2 完了＝AC1〜7 充足**（unit 4 件・E2E 2 件を追加し、いずれも修正前コードでは fail することを実証。全回帰 green: unit 1216・E2E 154。frameP95 は修正前後とも 16.8ms）。Codex medium・M1 は未実施 |

> アプローチ: バグ修正（原因は実読で特定済み。描画のみ・公開 API 変更なし。guides.md §1）

```text
Risk Class: B（描画層のみ。公開 API・Command/Event・protocol・永続化に触れない）
Risk Triggers: なし（base-layer の clip 矩形の分割だけ。IME・editor・sequencer・snapshot は無改変）
Human Spec Gate: skipped（不具合修正で「正しい挙動」は自明＝セル描画と同じ pane clip に揃える）
Codex: medium（実装完了後にユーザー指示で CLI 実行）
Manual Gate: あり・クローズ非ブロック（M1=固定列 5・固定行 1 の実機での見え方）。未実施なら「既知の未保証境界」へ移送
External Review: なし
Evidence Level: standard
```

## 目的

**固定行列を使ったまま横／縦スクロールすると、固定ペインのヘッダーが読めなくなる**不具合を直す。
セル本体は pane ごとに clip されていて正しいので、**ヘッダー帯だけを同じ扱いに揃える**。

## 背景・課題

松下 納入計画（③）が DD-036 の `frozenColumnCount: 5` を適用したところ、横スクロール時に固定列の見出しが壊れた。
consumer 側の切り分けで **`frozenColumnCount: 1`（SDK 既定）でも再現**することを確認済み＝**DD-036 が持ち込んだ退行ではなく、固定列機能に元からある不具合**。
既定値が 1 で固定列が狭く、キャプション未指定なら列記号 1 文字だったため、これまで表面化していなかった。

### 症状（consumer 実機・2026-09-03）

| # | 軸 | 条件 | 症状 |
|---|----|------|------|
| 1 | 列 | `frozenColumnCount ≥ 1` で**横**スクロール | 固定ペインの列見出しに、固定帯の裏へ隠れたはずのスクロール列の見出しが重なって描かれる。例（松下③・固定 5 列・`scrollLeft=1200`）: `区分`＋`4/13`、`行区分`＋`4/14`、`注記`＋`4/15` が重なる。`scrollLeft=0` では正常 |
| 2 | 行 | `frozenRowCount ≥ 1` で**縦**スクロール | 行番号帯で同じことが起きる。例（松下①・固定 1 行・6 ホイール分スクロール）: 固定行の行番号 `1` の上にスクロール行の `29` が重なる。**現行の既定値のまま出荷済みの consumer で発生している** |

- **セル本体・列背景（`columnBackgrounds`）・`readOnlyRows`・`scrollToColumn` はいずれも正常**。値・編集・計算に影響はない（表示のみ）
- 証跡: 松下リポ `doc/DD/DD-014-2/e2e-2-header-defect.png`

### 根本原因（`packages/render/src/base-layer.ts` の `drawHeaders` を実読・確定）

- **列記号ヘッダー（上帯）**: `ctx.rect(headerWidth, 0, viewportWidth - headerWidth, headerHeight)` という**単一の clip**を張ったうえで、`corner`（固定列）と `body`（スクロール列）の見出しを**同じ clip の中に**描いている。`body` 側の `columnHeaderRect(col)` は `headerWidth + offsetOf(col) - scrollLeft` を返すため、固定帯の裏へ回った列の x が固定帯の内側に落ち、そのまま上書きされる
- **行番号ヘッダー（左帯）**: `ctx.rect(0, headerHeight, headerWidth, viewportHeight - headerHeight)` で同じ構造。`corner`（固定行）と `body`（スクロール行）を単一 clip で描いている
- **セル本体はこの問題を持たない**。pane ごとに `pane.clip` を張って描くため、pane 境界で確実に切られる（§12.2 の 4 象限モデル）
- 分割に必要な材料は既にある: `ViewportTransform` の `frozenWidth()` / `frozenHeight()`（`editor-placement`・`scroll-anchor` が使用中）

## 検討内容

| # | 論点 | 選択肢 | 推奨と理由 |
|---|------|--------|-----------|
| 1 | clip の分け方 | (a) ヘッダー帯を「固定側」「スクロール側」の 2 回に分けて描く（各 `ctx.save()`/`clip()`/`restore()`）/ (b) 描画前に列/行ごとの可視判定で間引く | **(a)**。セル本体と同じ考え方（pane ごとの clip）に揃うので、将来 pane が増えても破綻しない。(b) は「はみ出した文字の一部だけ見せる」正しい見え方（固定境界で文字が切れる）を作れない |
| 2 | 固定側の clip 幅 | (a) `headerWidth` 〜 `headerWidth + frozenWidth()` / (b) corner pane の `clip` をそのまま流用 | **(a)**。corner pane の clip は**縦方向がヘッダー帯と違う**（セル領域用）ため流用できない。横は `frozenWidth()`、縦は `frozenHeight()` から矩形を組み直す |
| 3 | 固定数 0 のとき | (a) 分割せず現行と同じ 1 回描画へ倒す / (b) 幅 0 の clip を張って 2 回描く | **(a)**。`frozenColumnCount: 0` は③が実際に使っている設定（見出し行を持たないシート）で、無駄な clip を張らない。分岐 1 つで済む |
| 4 | 回帰の担保 | (a) `base-layer` の描画単体テスト（clip 矩形の呼び出し記録を検証）＋ E2E スクショ / (b) E2E のみ | **(a)**。DD-004 の 4 象限シナリオが既にあるので、そこへ「固定帯にスクロール側の見出しが描かれない」ことを足す。描画は Canvas なので、ctx のスパイで `clip` 矩形と `fillText` の x/y を検証するのが確実 |
| 5 | 修正範囲 | (a) 列・行の両方を同時に直す / (b) 列だけ先に直す | **(a)**。同一関数の同一構造で、片方だけ直すともう片方が「直っていない理由」を説明できなくなる。行側は**現行の既定値（固定行 1）のまま出荷済み consumer で発生している**ため優先度は同じ |

## 決定事項

（📐 実読で確定・2026-09-03。論点 1〜5 は上表の推奨どおり採用し、実装の形だけ以下で具体化した）

### 漏れる機序（実読で確定）

`scrollColRange()` は `colAxis.indexAt(frozenWidth + scrollLeft - overscanX)` から始まる。つまり `body.cols` には
**固定境界に半分だけかかる列**と **overscan 分の列**が必ず含まれる。その列の
`columnHeaderRect(col).x = headerWidth + offsetOf(col) - scrollLeft` は固定帯の内側（`< headerWidth + frozenWidth`）に落ち、
単一 clip のため固定列の見出しの上へそのまま描かれる。行も同型（`scrollRowRange` / `rowHeaderRect`）。
セル本体が無事なのは `drawPane` が `pane.clip`（body は `bodyOriginX`/`bodyOriginY` 始まり）で切っているため。

### 修正の形

変更は `drawHeaders` の 2 か所（列記号帯・行番号帯）だけ。**帯の背景 fill・左上コーナー・境界線は 1 行も動かさない**
（＝AC3・AC4 を差分の構造で担保する）。現行の帯 clip はそのまま残し、その**内側に入れ子で** clip を張って
テキスト描画だけを 2 回に分ける（入れ子 clip は交差なので帯からはみ出さない）。

| 帯 | 固定側の clip | スクロール側の clip | 描く範囲 |
|----|--------------|-------------------|---------|
| 列記号（上） | `rect(headerWidth, 0, frozenW, headerHeight)` | `rect(headerWidth + frozenW, 0, viewportWidth - headerWidth - frozenW, headerHeight)` | `corner.cols` / `body.cols` |
| 行番号（左） | `rect(0, headerHeight, headerWidth, frozenH)` | `rect(0, headerHeight + frozenH, headerWidth, viewportHeight - headerHeight - frozenH)` | `corner.rows` / `body.rows` |

- `frozenW = transform.frozenWidth()` / `frozenH = transform.frozenHeight()`（論点 2(a)）。corner pane の clip は
  `y` が `headerHeight` 始まり＝帯と食い違うため流用しない
- **幅・高さが 0 以下の側は clip を張らずスキップ**する（`drawPane` の既存ガードと同じ書き方）。
  これで論点 3(a) は専用の分岐なしに成立する — `frozenW === 0` のときスクロール側の clip 矩形は
  現行の帯 clip と**数値まで一致**し、描画列も `body.cols` だけになるため、現行と同一の描画に落ちる
- 矩形は既存の書き方に合わせて `Math.max(0, …)` で潰す（固定帯が viewport より広い異常構成でも負の幅を作らない）

### 検証の形（論点 4(a) の具体化）

既存の `base-layer.dd036.test.ts` の ctx スタブは `rect`/`clip` を記録せず `fillText` も本文しか残さないため、
**DD-039 用に clip 矩形と fillText の x/y まで記録するスタブを新設**する（`base-layer.dd039.test.ts`・dd036 の書き方に倣う）。
検証するのは「固定側 clip の内側で描かれた見出しが `corner` のものだけであること」＝ AC1・AC2。

### 制約

- **無改変制約**: `packages/ime/*`・`editor-state-machine`・`ime-editing-session`・`mount-controller` の editor 経路は無改変。変更は `packages/render/src/base-layer.ts` の `drawHeaders` に閉じる（実読の結果、閉じることを確認済み）
- **公開 API は追加も変更もしない**（描画の見え方だけが変わる）。CHANGELOG は Fixed 節へ記載する
- AC6 について: 1 フレームあたりの `clip` 呼び出しは帯あたり 1 → 最大 3（帯 1 ＋ 内側 2）。`fillRect` / `fillText` の回数は不変

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 | 結果 |
|---|------------------------|---------|------|
| 1 | `frozenColumnCount ≥ 1` で横スクロール → 固定列の見出しに**スクロール列の見出しが一切描かれない**。固定境界をまたぐ見出しは境界で切れる | unit（ctx スパイ: clip 矩形と fillText の x）＋ E2E | ✅ `base-layer.dd039.test.ts` #1・`frozen-panes.spec.ts` DD-039 AC1（修正前コードでは fail することを実証） |
| 2 | `frozenRowCount ≥ 1` で縦スクロール → 行番号帯で同じ（固定行の番号にスクロール行の番号が重ならない） | unit ＋ E2E | ✅ 同 #2・DD-039 AC2（同上） |
| 3 | `frozenColumnCount: 0` / `frozenRowCount: 0` のとき、描画結果が修正前と同一 | unit | ✅ 同 #3（clip は帯 2 枚のみ＝入れ子なし。修正前後とも pass） |
| 4 | 固定数が既定（1／1）の既存 consumer で、`scrollLeft=0` かつ `scrollTop=0` の初期表示が修正前と同一 | unit ＋ 既存 E2E 無修正 green | ✅ 同 #4・既存 `frozen-panes.spec.ts` AC1/AC2 無修正 green |
| 5 | セル本体・列背景（`columnBackgrounds`）・選択・Presence・オーバーフロー表示に変化がない | 既存の全回帰 | ✅ unit 1216 / E2E 154 全 green（overlay-layer は無改変） |
| 6 | 描画フレーム予算に回帰がない（ヘッダー描画の clip が 1 回 → 最大 2 回になる影響） | headed 計測 | ✅ `frameP95` は修正前後とも 16.8ms（予算 33ms）。`test-results/dd-evidence/DD-039/perf-comparison.json` |
| 7 | 公開 .d.ts snapshot に差分なし・CHANGELOG の Fixed に記載・boundary lint new=0 | contract test ＋ lint | ✅ `tests/contract/facade-surface.test.ts` green・CHANGELOG Fixed 追記・boundary new=0 |

## タスク一覧

### Phase 1: 実装前詳細化と修正
- [x] 📐 `drawHeaders` の周辺（`columnHeaderRect` / `rowHeaderRect` / `panes()` / `frozenWidth()` / `frozenHeight()`）を実読し、ヘッダー帯の矩形を pane 境界で分ける最小の変更を確定 → 「決定事項」へ記録（2026-09-03）
- [x] `packages/render/src/base-layer.ts`: 列記号ヘッダー・行番号ヘッダーをそれぞれ「固定側」「スクロール側」の 2 回に分けて clip → 描画（固定数 0 のときは現行どおり 1 回）
- [x] 🔬 機械検証: `npm run typecheck` / `npm run lint` / `npm test`（既存が無修正 green＝AC3・4・5）

### Phase 2: 回帰の追加と検証
- [x] `packages/render/src/base-layer` の描画テストへ「固定帯にスクロール側の見出しを描かない」ケースを追加（列・行の両方＝AC1・2）→ `base-layer.dd039.test.ts`（4 件）
- [x] playground E2E にスクショケースを追加（固定列 5 × 横スクロール／固定行 1 × 縦スクロール）→ `frozen-panes.spec.ts` に 2 件
- [x] 🔬 機械検証: 追加した unit / E2E が green（AC1・2）／wide-grid-perf ハーネスでフレーム予算の回帰なしを確認（AC6）
- [x] `CHANGELOG.md` の Fixed へ記載（AC7）
- [x] 📸 エビデンス: `test-results/dd-evidence/DD-039/`（E2E スクショ 2 点＋`perf-comparison.json`）

### 完了前チェック
- [x] 受け入れ基準を 1 項目ずつ照合
- [x] 😈 セルフレビュー 1 巡
- [x] 🔬 全回帰 1 回: `npm test` / `npm run typecheck` / `npm run lint` / `npm run test:e2e` → 全 green
- [ ] tarball 再生成は松下側 DD-014-2 が実施（`scripts/release/build-release.sh`）

## Manual Gate（クローズ非ブロック・正味）

| # | 項目 | 正味 | 結果 |
|---|------|------|------|
| M1 | 固定列 5・固定行 1 の実機での見え方（横／縦スクロール中にヘッダーが読めること・境界での文字切れが不自然でないこと） | 3 分 | 未実施 |

## ログ

### 2026-09-03
- 起票。松下 納入計画（DD-014-2）が DD-036 の `frozenColumnCount` を適用した実機検証で発見。DD-026 / DD-035 / DD-036 と同じく**松下側セッションが起票を代行**（以後は spreadjs 側のセッションで進める）
- 要件出所: 松下 `doc/DD/DD-014/sdk-requirements.md` **§C 追補 C7**（再現手順・切り分け・影響範囲を記載）
- consumer 側の切り分けで **`frozenColumnCount: 1`（SDK 既定）でも再現**＝DD-036 の退行ではないと確定。さらに**行番号帯にも対称の症状**があり、こちらは**固定行の既定値 1 のまま出荷済みの松下① 生産納期で現に発生している**
- 根本原因は起票時の実読で特定済み: `base-layer.ts` の `drawHeaders` が、列記号帯・行番号帯とも **`corner`（固定）と `body`（スクロール）を単一 clip の中に描いている**。セル本体は pane ごとの clip で描かれるため無事だった。分割に要る `frozenWidth()` / `frozenHeight()` は既存
- 番号は DD-038 の次として DD-039 を採番（DD-038 は Phase 2 実装が進行中のため、`base-layer.ts` は競合しない見込みだが着手前に確認すること）

### 2026-09-03（spreadjs 側セッションで着手）
- **Phase 1 の 📐 実読を完了**。読んだのは `base-layer.ts drawHeaders` / `viewport.ts`（`panes()`・`columnHeaderRect`・`rowHeaderRect`・`scrollColRange`・`frozenWidth`/`frozenHeight`）/ `overlay-layer.ts` / `base-layer.dd036.test.ts`。起票時の原因特定は**正しい**と確認し、さらに漏れる機序（overscan と境界にかかる列が必ず `body.cols` に入る）まで確定。修正の形・検証の形は「決定事項」へ記録
- **コード変更には着手していない**（ユーザー指示: 別セッションが作業中なので邪魔しない範囲で）。理由: 同リポジトリで `scripts/release/build-release.sh`（**作業ツリーから `npm pack`**）が回っており、`packages/**` を編集すると**書きかけのコードが相手の tarball へ混入する**。`npm test` / `npm run build` の同時実行も避けた。ビルド完了を確認してから Phase 1 の実装タスクから再開する
- 競合の確認: 起票時のメモ「DD-038 が Phase 2 実装中」は解消済み（DD-038 は `6f5cbab` で完了・アーカイブ）。`base-layer.ts` の最終更新は DD-036（`ca33b9f`）で、**現在この DD 以外に触っているものはない**
- 所見（**本 DD のスコープ外・要判断**）: `overlay-layer.ts` の選択枠・ドラッグ枠は `rangePiecesAcrossPanes` で pane ごとに clip しており正しいが、**Presence マーカーだけは `contentClip`（ヘッダーを除いた全セル領域）で描いており**、スクロール行列の Presence が固定ペインへはみ出しうる。ヘッダー帯の欠陥とは別物で、AC5（Presence 不変）にも触れるため DD-039 では扱わない。別 DD 化するか既知の未保証境界に置くかはユーザー判断
  → **ユーザー指示で `DD-041` として起票**（実読で範囲を再確定: 壊れているのは activeCell 枠と名前タグだけで、Presence の選択範囲ハイライトは pane 分割済み＝正しい）

### 2026-09-03（実装・Phase 1〜2 完了）
- ビルド完了の確認後に実装を再開（`packages/render/**` に限定・release スクリプトは別セッションが作業中のため触っていない）
- `base-layer.ts` の `drawHeaders` を修正。帯の背景 fill・左上コーナー・境界線は無改変で、**帯 clip の内側に入れ子 clip を張ってテキスト描画だけを固定側／スクロール側に分けた**。固定幅・固定高が 0 のときは入れ子を張らず現行どおり 1 回で描く（論点3(a) を実装レベルでも守る＝無駄な clip を張らない）
- 追加テスト `base-layer.dd039.test.ts`（4 件）: ctx スパイで **各 fillText がどの clip の内側で呼ばれたか**を記録して検証する。「固定帯の内側に落ちるスクロール列/行が実在すること」も同時に assert し、テストが空振りしないようにした
- **テストの有効性を実証**: 修正前のコード（`git show HEAD:` のコピー）に同じテストを当てると **unit 3/4 が fail**（`expected 52 to be 292` 等＝スクロール列の見出しが帯 clip の中で描かれていた）、**E2E も 2/2 が fail**。「固定 0 なら現行と同一」の 1 件だけは修正前後とも pass＝AC3 の意味どおり
- E2E は `frozen-panes.spec.ts` へ 2 件追加。**固定側のヘッダー帯の実ピクセル指紋（FNV-1a）がスクロール前後で一致すること**を検証する（スクロール側の指紋が変化したことを先に確認して再描画を担保）
- AC6 計測: `zz-wide-grid-perf`（382 列・--headed）を **修正前後で交互に 6 本**実行。横スクロールの `frameP95` は**修正前後とも 16.8ms**（予算 33ms）で同一。`initialDrawMs` は最初の 2 本だけ 125/130ms と高かったが、順序を入れ替えると修正後も 92.9〜97.7ms で修正前（87.9〜101.9ms）と重なる＝**暖機影響であって本修正に起因しない**。記録は `test-results/dd-evidence/DD-039/perf-comparison.json`
- `features.json` は更新しない（機能の追加・提供開始・スコープ変更ではなく、既掲載機能〔固定列・列網掛け〕の不具合修正のため。AGENTS.md の更新義務の対象外）
