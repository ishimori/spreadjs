# DD-066: 結合したセルを選んだときの二重の枠（consumer 駆動・DD-064 の取りこぼし）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-11-08 | 2026-11-08 | 検討中 | 起票のみ。論点1〜3 は Human Spec Gate 待ち |

> アプローチ: バグ修正・フルパス（画面の見た目の不具合で、consumer の画面で再現している）
> リスク: なし（認可・DBスキーマ・外部I/F・機密情報に触れない）
> エビデンス: 画面キャプチャ（Playwright MCP）と、textarea の矩形の E2E

```text
Risk Class: A（選んだセルの枠を兼ねる textarea の配置を変える。IME 状態機械・protocol・公開 API は変えない）
Risk Triggers: textarea（配置の矩形）・selection（結合の左上を選んでいる間の見た目）
Human Spec Gate: required（論点1〜3。起票時の推奨案あり）
Codex: high（textarea の配置だけで、状態機械は変えないため xhigh にしない）
Manual Gate: 実 IME（Microsoft IME）で、結合から隣のセルへ矢印キーで移って日本語入力を始め、変換の窓が隣のセルの位置に出ること（クローズはブロックしない）
External Review: なし
Evidence Level: standard
```

## 概要

| Bug# | 概要 | 重要度 |
|------|------|--------|
| 1 | 結合したセルを選ぶと、範囲全体の枠と塗りの中に、左上のセル1つぶんの枠がもう1つ重なって見える。表にフォーカスが無いとき（mount 直後など）は、左上のセル1つぶんの枠だけが出て、範囲全体の枠が出ない | MEDIUM |

- Excel では、結合したセルを選ぶと範囲全体を囲む枠が1つだけ出る（範囲の中に1セルぶんの枠は出ない）［判断。consumer のユーザーと確認］
- 操作（選択・移動・貼り付け）は DD-064 の契約どおりで、見た目だけの問題
- consumer の画面（hiroshima-keikaku の入力シート・alpha.19）: `C:/repo/hiroshima-keikaku/doc/DD/DD-001-16/sdk-merge-selected-inner-frame.png`。3行×1列の結合（内容の列）を選んだところで、外枠の中の1行目に枠が重なっている

## 原因分析

選んだセルの枠は2つの層が描いている。

- 範囲の塗りと外枠: render の overlay 層（`packages/render/src/overlay-layer.ts` の `drawSelection`）。選択は結合を含むまで広げてあるので、範囲全体に描ける
- 選んだセル1つぶんの枠: 常駐の textarea の枠（`border: 2px solid`・背景は透明）。置き場所は `packages/grid/src/integration-editor.ts` の `refreshPlacement` が `computeEditorPlacement(transform, rowIndex, colIndex, …)`（`packages/grid/src/editor-placement.ts`）で求めた**セル1つの矩形**。結合を見ていない。高さは `applyHeight` でその矩形の高さになる

このため、アクティブセルが結合の左上にある間、textarea の枠が左上のセル1つぶんの大きさで描かれる。表にフォーカスが無いと overlay の選択の塗り・外枠が出ないので、textarea の枠（1セルぶん）だけが見える［資料: alpha.19 のソースと consumer の画面。Phase 0 で確かめる］。

同じ層でも、他の参加者の枠（Presence）は結合を見ている（`overlay-layer.ts` の `frame.mergedRanges?.at(...)`）。自分の textarea だけが漏れている。

> 詳細: Phase 0 で `DD-066/cause-analysis.md` に書く

## 検討内容

| # | 論点 | 推奨案 |
|---|---|---|
| 1 | 直し方 | **アクティブセルが結合の左上にある間、textarea を結合の範囲の矩形に置く**（Excel と同じく枠は範囲全体の1つになる。mount 直後のフォーカスが無いときも範囲全体の枠が出る）。結合したセルは読むだけで編集が始まらない（DD-064 契約 §2）ので、範囲の大きさにするのは Navigation の間だけで足りる。範囲の外へ出たら従来どおりセル1つの矩形に戻す。textarea の枠を消して overlay の枠に任せる案は採らない（フォーカスが無い間は overlay が選択を描かず、選んだセルを示すものが無くなる） |
| 2 | 範囲の一部が隠れたとき | 縦に長い結合は、上の端だけが見出し・固定の帯の下へ隠れる状態が起きやすい。`computeEditorPlacement` は一部でも見えていれば矩形を切らずに返すので、範囲の矩形をそのまま使うと、枠が見出し・固定の帯の上へはみ出すおそれがある。**Phase 0 で今の1セルのときのはみ出し方を確かめ、結合では枠をデータ領域（pane）の中に収める**（overlay の選択の枠と同じ見え方。収め方は実装時に決めてよい） |
| 3 | DD-065 との順番と配布 | **DD-065 には混ぜない**（DD-065 は挙動を変えず、既存テストの期待値を書き換えない分割のため）。起票時、DD-065 は `mount-controller.ts` を分けている最中（未コミットの変更あり）なので、**DD-065 のその区画のコミットの後**に着手する（DD-065 は機能の DD と交互に進められる前提）。置き場所の計算は `editor-placement.ts`・`integration-editor.ts` 側に寄せ、`mount-controller.ts`（サイズのガードの baseline 4,567 行に対し起票時 4,561 行）の行を増やさない。直したら**この修正で alpha.20 を配る**（consumer は 11/12 にユーザーの確認、11/13 に先方へ試作を渡す。DD-065 の途中の区画が入っても、各区画は挙動を変えずテストが通る状態で終える約束なので配ってよい［判断］） |

## 決定事項

- 2026-11-08（ユーザー）: 見た目に違和感があるので直したい。spreadjs に DD を起票する
- 論点1〜3 は Human Spec Gate で決める

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | 単独モードで3行×1列の結合の中をクリック → 選んだセルの枠は範囲全体の1つだけ（textarea の矩形が範囲の矩形と一致し、範囲の中に1セルぶんの枠が出ない） | E2E（textarea の矩形）・画面のキャプチャ（Before/After） |
| 2 | mount 直後（表にフォーカスが無い）で、アクティブセルが結合の左上 → 枠は範囲全体の1つ | E2E・画面のキャプチャ |
| 3 | 矢印キーで結合から隣のセルへ移る → 枠はそのセル1つぶんに戻る。そのセルで印字キー・IME（synthetic）の入力を始める → textarea はそのセルの位置・大きさ（従来どおり） | E2E |
| 4 | 結合の上の端が隠れるまで縦に動かす・固定列の中の結合を横に動かす → 枠は範囲と一緒に動き、見出し・固定の帯へはみ出さない（論点2） | E2E・画面のキャプチャ |
| 5 | 結合の無い表と結合の外のセルでは、textarea の位置・大きさと編集（wrap 列の伸び・候補欄・カレンダーの位置）が変わらない | 既存の unit・E2E が期待値を変えずに通る |
| 6 | 配布した alpha を consumer の入力シートに取り込む → 二重の枠が出ない | consumer 側（hiroshima-keikaku DD-001-16 の後続） |

## タスク一覧

### Phase 0: 調査・再現確認・修正前エビデンス
- [ ] 論点1〜3 を決めて決定事項へ書く（Human Spec Gate）
- [ ] 原因箇所を確かめ、`DD-066/cause-analysis.md` に書く（上の原因分析の裏付け。今の1セルのときに、一部だけ見えているセルの枠が見出し・固定の帯へはみ出すかも見る）
- [ ] playground（`standalone.html` の結合の URL 指定）で再現し、📸 修正前のキャプチャ（クリック後・mount 直後・上の端が隠れたとき）を `DD-066/` に置く
- [ ] 📝 `DD-066/bug-report.md` を書く
- [ ] 👀 ユーザーレビュー（再現と原因の合意。ゲート）

### Phase 1: コード修正・テスト
- [ ] `packages/grid/src/editor-placement.ts`・`integration-editor.ts`: アクティブセルが結合の左上にある間（Navigation）、textarea を結合の範囲の矩形に置く。範囲の一部が隠れたときの収め方（論点2）。`mount-controller.ts` の行は増やさない
- [ ] 同根の横展開: `computeEditorPlacement` をアクティブセルに使うほかの所（日付のカレンダー・候補欄の位置の基準）で、結合の扱いが食い違わないか確かめる（どちらも結合の範囲では開かない）
- [ ] unit（配置の純関数）と E2E（受け入れ基準1〜5）を足す
- [ ] 🔬 機械検証: 対象の unit・E2E → 全パス。`npm run lint`（サイズのガードを含む）→ パス

### Phase 2: 修正後エビデンス・配布
- [ ] 📸 修正後のキャプチャ（Phase 0 と同じ場面）を `DD-066/` に置き、📝 `DD-066/verification.md`（Before/After）を書く
- [ ] 配布の前の検証（typecheck・typecheck:consumer-strict・lint・test・build）を1回通し、alpha.20 を作って consumer へ渡す（論点3）。CHANGELOG に1行
- [ ] 🔬 機械検証: `bash scripts/release/build-release.sh --skip-verify` → tarball と manifest（`closureDirty=false`）。`npm run consumer-harness` → PASS

### 完了前チェック
- [ ] 受け入れ基準を1項目ずつ照合（AC6 は consumer 側＝未保証境界へ）
- [ ] 製品化6観点（`doc/plan/dd-risk-class-header.md` §2）を確かめる（公開 API は変えない見込み）
- [ ] 😈 セルフレビュー1巡（「どこが壊れるか」を探す。読み返す価値のある所見のみログへ）
- [ ] 🔬 全回帰1回（typecheck・consumer-strict・lint・test・build・playground E2E・showcase E2E）

## ログ

### 2026-11-08
- DD作成（consumer 駆動。hiroshima-keikaku DD-001-16 のセッションから起票した）。consumer が alpha.19 を入力シートに取り込んで画面で確かめたところで見つけた（同 DD-001-16 のログ「表の部品（SDK）への所見」）。ユーザーの指示「見た目に違和感があるから修正したい」「DD-066 を起票してください」。実装は未着手
- 起票時の状態: DD-065 が `mount-controller.ts` を分けている最中（7c68a45 の後に未コミットの変更と `packages/grid/src/mount/`）。このセッションは DD-065 のファイルに触れていない
