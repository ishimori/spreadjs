# DD-066: 結合したセルを選んだときの二重の枠（consumer 駆動・DD-064 の取りこぼし）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-11-08 | 2026-11-08 | 完了 | 二重枠・固定帯へのはみ出しを修正。alpha.20を作成、unit1681・E2E303件成功。実IME・consumer確認は未保証境界へ |

> アプローチ: バグ修正・フルパス（画面の見た目の不具合で、consumer の画面で再現している）
> リスク: なし（認可・DBスキーマ・外部I/F・機密情報に触れない）
> エビデンス: 画面キャプチャ（Playwright MCP）と、textarea の矩形の E2E

```text
Risk Class: A（選んだセルの枠を兼ねる textarea の配置を変える。IME 状態機械・protocol・公開 API は変えない）
Risk Triggers: textarea（配置の矩形）・selection（結合の左上を選んでいる間の見た目）
Human Spec Gate: passed（2026-11-08・ユーザー「論点は推奨案でOK」。着手の時期だけ「DD-065 の完了後」に変えた）
Codex: high（textarea の配置だけで、状態機械は変えないため xhigh にしない）
Manual Gate: 実 IME（Microsoft IME）で、結合から隣のセルへ矢印キーで移って日本語入力を始め、変換の窓が隣のセルの位置に出ること（クローズはブロックしない）
External Review: なし
Evidence Level: standard
```

## 概要

| Bug# | 概要 | 重要度 |
|------|------|--------|
| 1 | 結合したセルを選ぶと、範囲全体の枠と塗りの中に、左上のセル1つぶんの枠がもう1つ重なって見える。自動 focus なしの mount 直後など、選択が overlay へ初期反映される前は1セルぶんの枠だけが出る。クリック後の blur では外枠は残る | MEDIUM |

- Excel では、結合したセルを選ぶと範囲全体を囲む枠が1つだけ出る（範囲の中に1セルぶんの枠は出ない）［判断。consumer のユーザーと確認］
- 操作（選択・移動・貼り付け）は DD-064 の契約どおりで、見た目だけの問題
- consumer の画面（hiroshima-keikaku の入力シート・alpha.19）: `C:/repo/hiroshima-keikaku/doc/archived/DD/DD-001-16/sdk-merge-selected-inner-frame.png`（consumer の DD-001-16 はアーカイブ済み）。3行×1列の結合（内容の列）を選んだところで、外枠の中の1行目に枠が重なっている

## 原因分析

選んだセルの枠は2つの層が描いている。

- 範囲の塗りと外枠: render の overlay 層（`packages/render/src/overlay-layer.ts` の `drawSelection`）。選択は結合を含むまで広げてあるので、範囲全体に描ける
- 選んだセル1つぶんの枠: 常駐の textarea の枠（`border: 2px solid`・背景は透明）。置き場所は `packages/grid/src/integration-editor.ts` の `refreshPlacement` が `computeEditorPlacement(transform, rowIndex, colIndex, …)`（`packages/grid/src/editor-placement.ts`）で求めた**セル1つの矩形**。結合を見ていない。高さは `applyHeight` でその矩形の高さになる

このため、アクティブセルが結合の左上にある間、textarea の枠が左上のセル1つぶんの大きさで描かれる。Playwright MCP で3行の結合（80×66 CSS px）に80×22の textarea が重なることを確認した。

初期表示の原因はフォーカスではなく、overlay が描く選択の shadow が最初の onChange まで空のため。自動 focus なしの mount 直後と、クリック後に blur した状態を分けて確認し、後者では外枠が残った。起票時の「フォーカスが無いと overlay が選択を描かない」という説明を訂正する。

同じ層でも、他の参加者の枠（Presence）は結合を見ている（`overlay-layer.ts` の `frame.mergedRanges?.at(...)`）。自分の textarea だけが漏れている。

> 詳細: `DD-066/cause-analysis.md`・`DD-066/bug-report.md`。修正前の画像7枚と数値 `DD-066/reproduction.json` を取得済み

## 検討内容

| # | 論点 | 推奨案 |
|---|---|---|
| 1 | 直し方 | **アクティブセルが結合の左上にある間、textarea を結合の範囲の矩形に置く**（Excel と同じく枠は範囲全体の1つになる。自動 focus なしの mount 直後も範囲全体の枠が出る）。結合したセルは読むだけで編集が始まらない（DD-064 契約 §2）ので、範囲の大きさにするのは Navigation の間だけで足りる。範囲の外へ出たら従来どおりセル1つの矩形に戻す。textarea の枠を消して overlay の枠に任せる案は採らない（初期選択の shadow が未設定の間は overlay が選択を描かず、選んだセルを示すものが無くなる。focus ではなく初期反映の問題と Phase 0 で訂正） |
| 2 | 範囲の一部が隠れたとき | 縦に長い結合は、上の端だけが見出し・固定の帯の下へ隠れる状態が起きやすい。`computeEditorPlacement` は一部でも見えていれば矩形を切らずに返すので、範囲の矩形をそのまま使うと、枠が見出し・固定の帯の上へはみ出すおそれがある。**Phase 0 で今の1セルのときのはみ出し方を確かめ、結合では枠をデータ領域（pane）の中に収める**（overlay の選択の枠と同じ見え方。収め方は実装時に決めてよい） |
| 3 | DD-065 との順番と配布 | **DD-065 には混ぜない**（DD-065 は挙動を変えず、既存テストの期待値を書き換えない分割のため）。起票時、DD-065 は `mount-controller.ts` を分けている最中（未コミットの変更あり）なので、**DD-065 のその区画のコミットの後**に着手する（DD-065 は機能の DD と交互に進められる前提）。置き場所の計算は `editor-placement.ts`・`integration-editor.ts` 側に寄せ、`mount-controller.ts`（サイズのガードの baseline 4,567 行に対し起票時 4,561 行）の行を増やさない。直したら**この修正で alpha.20 を配る**（consumer は 11/12 にユーザーの確認、11/13 に先方へ試作を渡す。DD-065 の途中の区画が入っても、各区画は挙動を変えずテストが通る状態で終える約束なので配ってよい［判断］） |

## 決定事項

- 2026-11-08（ユーザー）: 見た目に違和感があるので直したい。spreadjs に DD を起票する
- 2026-11-08（ユーザー）: 論点1〜3 は推奨案で確定（「論点は推奨案でOK」）。ただし着手の時期は、論点3 の「DD-065 のその区画のコミットの後」ではなく **DD-065 の完了後**にする（「DD-065が終わるまで待ちましょう」）。DD-066 の配線を足す所（editor の生成と描き直し）を、DD-065 が `mount/` へ移している最中のため
- 2026-11-08（ユーザー）: それまでは Phase 0 だけを進める。Phase 0 の成果物は Codex にレビューを依頼し、指摘は妥当性を判断して Claude が直す
- 2026-11-08（ユーザー）: DD-065 完了後に「では、続いて、DD-066を開始してください」。中断していた Phase 0 を再開。確定済みの論点1〜3を引き継ぎ、Phase 0 の再現・原因のユーザーレビュー後に Phase 1 へ進む

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
- [x] 論点1〜3 を決めて決定事項へ書く（Human Spec Gate）
- [x] 原因箇所を確かめ、`DD-066/cause-analysis.md` に書く（上の原因分析の裏付け。今の1セルのときに、一部だけ見えているセルの枠が見出し・固定の帯へはみ出すかも見る）
- [x] playground（`standalone.html` の結合の URL 指定）で再現し、📸 修正前のキャプチャ（クリック後・mount 直後・上の端が隠れたとき）を `DD-066/` に置く（自動 focus と区別する public mount の再現 fixture も使用）
- [x] 📝 `DD-066/bug-report.md` を書く
- [x] Codex レビュー（high。対象は Phase 0 の成果物＝DD 本文・cause-analysis.md・bug-report.md。2026-11-08 のユーザー指示）。指摘なし。結果は `DD-066/codex-review-result.md`
- [x] 👀 ユーザーレビュー（再現と原因の合意。ゲート。2026-11-08「この原因・方針で修正へ進める」）
- [x] 🔬 機械検証: `bash scripts/doc-check.sh`・`bash scripts/dd-health.sh --dd DD-066`・差分の確認。Phase 0 は文書とエビデンスだけの変更なので SDK の全体テストは追加しない

### Phase 1: コード修正・テスト
- [x] `packages/grid/src/editor-placement.ts`・`integration-editor.ts`: アクティブセルが結合の左上にある間（Navigation）、textarea を結合の範囲の矩形に置く。範囲の一部が隠れたときの収め方（論点2）。`mount-controller.ts` の行は増やさない
- [x] 同根の横展開: `computeEditorPlacement` をアクティブセルに使うほかの所（日付のカレンダー・候補欄の位置の基準）で、結合の扱いが食い違わないか確かめる（どちらも結合の範囲では開かない）
- [x] unit（配置の純関数）と E2E（受け入れ基準1〜5）を足す
- [x] 🔬 機械検証: 対象の unit・E2E → 全パス。`npm run lint`（サイズのガードを含む）→ パス

### Phase 2: 修正後エビデンス・配布
- [x] 📸 修正後のキャプチャ（Phase 0 と同じ場面）を `DD-066/` に置き、📝 `DD-066/verification.md`（Before/After）を書く
- [x] 配布の前の検証（typecheck・typecheck:consumer-strict・lint・test・build）を1回通し、alpha.20 を作って consumer へ渡す（論点3）。CHANGELOG に1行（ZIP・手順を用意、取り込みはAC6）
- [x] 🔬 機械検証: `bash scripts/release/build-release.sh --skip-verify` → tarball と manifest（`closureDirty=false`）。`bash scripts/consumer-harness.sh` → PASS

### 完了前チェック
- [x] 受け入れ基準を1項目ずつ照合（AC6 は consumer 側＝未保証境界へ）
- [x] 製品化6観点（`doc/plan/dd-risk-class-header.md` §2）を確かめる（公開 API 変更なし。verification.md）
- [x] 😈 セルフレビュー1巡（「どこが壊れるか」を探す。読み返す価値のある所見のみログへ）
- [x] 🔬 全回帰1回（typecheck・consumer-strict・lint・test・build・playground E2E・showcase E2E）

## 既知の未保証境界

- 実 Microsoft IME で、結合の隣の編集セルへ移った後の変換窓の位置は未確認（合成compositionとは区別）。クローズをブロックしないManual Gateとして移送
- AC6のconsumer（hiroshima-keikaku）への取り込みと入力シートの画面確認は未実施。alpha.20のZIP・手順を用意し、consumer側の後続作業へ移管

## ログ

### 2026-11-08
- DD作成（consumer 駆動。hiroshima-keikaku DD-001-16 のセッションから起票した）。consumer が alpha.19 を入力シートに取り込んで画面で確かめたところで見つけた（同 DD-001-16 のログ「表の部品（SDK）への所見」）。ユーザーの指示「見た目に違和感があるから修正したい」「DD-066 を起票してください」。実装は未着手
- 起票時の状態: DD-065 が `mount-controller.ts` を分けている最中（7c68a45 の後に未コミットの変更と `packages/grid/src/mount/`）。このセッションは DD-065 のファイルに触れていない
- 着手（ユーザー指示「DD-065が終わるまで待ちましょう。PH0だけやっておいて。論点は推奨案でOK。Codexにレビュー依頼してください」）。DD-065 と並行しない理由: DD-066 の修正は、editor へ結合を渡す配線を足さないと成り立たない（alpha.19 では `mount-controller.ts` の `placementConfig()`・`redraw()`・`createIntegrationEditor({...})`）。そこは DD-065 が今動かしている区画で、3f7254b で `placementConfig`・`redraw` は `mount/render.ts` へ移り、editor の生成まわりは `mount/editor-wiring.ts` を作成中（未コミット）。同じ作業ツリーで並行すると、DD-065 の編集・コミット・テストにこちらの途中の変更が混ざる
- Phase 0 の途中の所見（コードを読んだだけ。ブラウザーでの再現はまだ）
  - consumer のキャプチャはアーカイブ先へ移っていた（概要のパスを直した）。キャプチャでは No・科目の列も3行の結合に見え、mount 直後のアクティブセル (0,0) が結合の左上にあたる
  - mount 直後に範囲の枠が出ないのは、フォーカスのせいではなく、overlay が描く選択（`selection` の shadow）が最初の onChange まで null のためと読める（alpha.19＝bd2985f の `mount-controller.ts` L301・L564〜576・L3741。`overlayFrame` にフォーカスの条件は無い。(0,0) が結合の左上なら、左上への寄せ〔`normalizeActiveIntoMerge`〕が動かず onChange が来ない）。原因分析の「フォーカスが無いと overlay が選択を描かない」と、論点1 で採らない案の理由（同じ前提）は、再現で確かめてから直す。直し方の結論（textarea を範囲の矩形に置く）は変わらない見込み
- 再現の手順の判断: DD-065 が本体の作業ツリーの `packages/` を編集し続けるため、alpha.19（bd2985f）を git worktree でスクラッチパッドへ取り出し、そこで `npm ci` して Vite を起動する方針にした。`apps/playground/vite.config.ts` に alias が無く、SDK は node_modules のリンク経由で解決されるので、本体の node_modules を流用すると DD-065 の途中のコードを読んでしまう。ポートは DD-065 の E2E（5199 ほか）・dev-start（5885）と別にする
- 中断（ユーザー指示「一旦ここで作業中止」）。後片付け: 再現用の worktree（スクラッチパッドの `dd066-repro`。中断の指示の時点で `npm ci` は最後まで終わっていた）を削除し、`git worktree prune`。npm が作ったリンクは worktree の中の `packages/` を指していて、本体の作業ツリーと DD-065 のファイルは変わっていない。Codex レビューは未実施
- 再開の入口: Phase 0 の 2 つ目のタスク（`DD-066/cause-analysis.md`）から。上の所見を裏付け、再現とキャプチャは上の worktree の手順で取る。Codex レビューは Phase 0 の成果物が揃ってから依頼する（DD-065 の未コミットの変更がまだ同じ作業ツリーにあれば、`--uncommitted` の依頼書で対象を DD-066 のファイルに限り、コードは `git show bd2985f:<path>` で読ませる）。DD-065 の完了後は配線の置き場所が `mount/` の部品になるので、Phase 1 のタスクの「`mount-controller.ts` の行は増やさない」は再開時に読み替える
- 再開（ユーザー指示「では、続いて、DD-066を開始してください」）。DD-065 は 7951231 で完了・作業ツリーも clean。再現用の別 worktree は不要になったため現行 checkout と Vite :5885 を使用。`editor-placement.ts`・`integration-editor.ts`・`overlay-layer.ts` は alpha.19 の bd2985f と同一であることを git diff で確認
- Phase 0 再現: textarea 80×22 に対して3行の結合は80×66。初期 focus なし・クリック・blur・一部だけ可視・左上だけ不可視・固定列の横スクロールを確認し、修正前7枚と reproduction.json を保存。通常の1セルでも固定帯へのはみ出しを確認（通常セルの配置修正は対象外）
- 原因の訂正: 初期表示で外枠が無いのは focus ではなく selection shadow の初期反映前。focus=false の mount 直後は overlay の測定ピクセルが透明、クリック後の blur では塗りが残る。枠を結合全体へ広げ、pane で clip する既決方針は維持
- Phase 0 の cause-analysis.md・bug-report.md と本 DD を Codex high でレビューする。SDK 本体は未変更。文書整合・レビュー後、既存の「再現と原因の合意」のユーザーゲートへ提示する
- Phase 0 の Codex high レビュー完了: 指摘なし。本文・原因・数値・画像7枚と実装を照合し、初期表示の説明と Navigation 限定の修正方針の整合を確認（`DD-066/codex-review-result.md`）。採用／見送りの指摘は0件
- Phase 0 の文書検証: doc-check・DD-066 health・git diff --check 成功。SDK・依存・設定の変更なし。修正の前に、既存タスク「ユーザーレビュー（再現と原因の合意。ゲート）」として bug-report.md を提示する
- Phase 0 のユーザー合意を取得（「この原因・方針で修正へ進める（推奨）」）。Navigation の結合全体の矩形と pane 内の clip、通常セルへの復帰を実装する
- Phase 1: 結合全体の配置とclipを返す純関数を追加し、Navigation中だけ editor へ適用。結線は既存の mount/editor-wiring.ts の getter を使用。mount-controller.ts は605行のまま。通常セル・wrap・候補欄・日付の既存配置関数は変更しない
- 対象検証: 配置の unit 8件・実物 E2E 8件を追加し成功。既存配置17件・IME結線26件も成功。MCPで修正前と同じ7場面のAfterを取得し、枠の重なり・固定帯へのはみ出しの解消を確認（verification.md）
- alpha.20: 10 package と lockfile を更新し、README・CHANGELOG（DD-065同梱を含む）・機能カタログ・DD-064契約を同期。配布対象を76c4986でコミット
- 76c4986 の静的検証: typecheck・consumer-strict・lint・build 成功。unitは並行検証時にGit準備のbeforeAllが10秒でタイムアウトしたため、他の検証終了後に再実行し162ファイル・1,681件成功（テストやtimeoutの変更なし）。consumer-harnessも10 tarballのpack→install→tsc成功
- 全回帰完了（76c4986・Windows・Node 24.22.1／npm 11.19.1）: playground E2E298件・showcase E2E5件成功。配布対象のソース・依存・設定は以後変更せず、上記の型検査・lint・unit・buildと合わせて最終検証として記録（verification.md）
- 配布: `build-release.sh --skip-verify --out release/0.1.0-alpha.20` 成功。10 tarball・141 files、test/spec・tsconfigなし、全entrypointあり。manifestは76c498617426321d9ddf1b83b1c7c9aa4d734511・closureDirty=false（gitDirty=trueは文書だけ）。verify-manifest成功
- ZIP `release/nanairo-sheet-0.1.0-alpha.20.zip`（451,001 bytes・SHA-256 `07a5e4ca75bf84969618056d3a5df413e95c63c3a5d16b54cdd5cd0d154ed6a1`）。12 entryすべてを元ファイルとSHA-256照合。consumer手順はhandoff.md、ZIPのREADMEも同じ。実際のconsumerリポジトリの変更・pushは行っていない
- 受け入れ基準1〜5・製品化6観点を確認。AC6と実IMEを既知の未保証境界へ移送して完了。DD本文・添付を一緒にアーカイブし、INDEXを再生成。doc-check・DD-066 health・差分確認は成功
