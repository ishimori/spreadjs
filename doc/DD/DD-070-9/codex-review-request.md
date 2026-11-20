# Codexレビュー依頼: DD-070-9（見せる行と並び・共同編集モード）

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製スプレッドシート型入力基盤（Canvas グリッド・日本語 IME を壊さない常駐 textarea・サーバー主導の共同編集）。DD-070-8 で `setRowView(rowIds | null)`・`visibleRowIds()`（consumer が計算した並べ替え・絞り込みの並びを、表を作り直さずに見せる・view-local）を単独モードで作った（アーカイブ: `doc/archived/DD/DD-070-8_見せる行と並び（単独モード）.md`）。本 DD はそれを共同編集モードで確かめ、壊れたところを直した。

DD 本文: `doc/DD/DD-070-9_見せる行と並び（共同編集モード）.md`（決定事項 1〜8）。仕様は確定済みで、本レビューの対象は**実装とテストが決定事項どおり正しく作られているか**。

## レビュー対象差分

コミット 495e5f4 の変更すべて（DD 文書と本依頼書は対象外）。

## 決定事項（要点）

1. 並びは参加者ごと（view-local）。他の参加者の画面・文書・Undo は変えない
2. 他の参加者が挿した行は、文書の並びで一つ前の見えている行のすぐ後に出る。消した行は抜ける（選択中なら近くの見えている行へ）
3. 他の参加者が隠れている行の値を変えても画面には出ない（`getRows` では読める）。見えている行の値が変わっても並び直さない
4. 自分の操作がサーバーに拒否されて巻き戻ったとき: 拒否された挿入の行は抜け、拒否された削除の行は元の並びの位置に戻る
5. 再接続で同じ行 ID の行は並びを保つ。切れている間に他の参加者が挿した行は「後からできた行」
6. 他の参加者が隠れている行にいるときは、その枠と名前タグを描かない
8. サーバーの初回の状態を受け取る前に呼んだ `setRowView` は、受け取った後に組み立てて反映する（命令の保留 `runOrDefer` に積み、毎フレームの drain で確かめ直す）。`visibleRowIds` は受け取る前は `[]`

## 実装の要点

- `packages/grid/src/mount/row-view-switch.ts`: 依存 `deferUntilInitialState(run)` を足し、`set`（結線の後）と `attach`（結線の前に受けた指定）で、初回の状態の前なら予約する
- `packages/grid/src/mount-controller.ts`: `deferUntilInitialState` の実体（`commands.runOrDefer(attempt, initialStateArrived)`。drain で呼ばれた `attempt` がまだ受け取っていなければ積み直す）
- `apps/playground/src/integration/main.ts`: E2E 用の `?rowview=`（mount の直後に `setRowView`）
- テスト: `packages/grid/src/mount/row-view-switch.test.ts`・E2E `apps/playground/e2e/row-view-collab.spec.ts`（2 クライアント・共有の文書を壊さないよう B が先頭へ挿した新しい行だけを使い最後に消す。拒否は認可フック E2E 用サーバー）

## 評価基準（この観点で見てほしい）

1. **初回の状態の前の予約（最重要）**: drain の条件（`canRunCommandsNow`・`canRunColumnCommandsNow`）と予約の積み直しで、取りこぼし・無限に積み直す・毎フレームの費用・他の保留命令（`scrollToRow`・`setActiveCell`）との順序の崩れが起きないか。予約の後に `setRowView` をもう一度呼んだとき・destroy の後・再接続の bootstrap（初回でない状態の入れ替え）・空の文書（初回の描画が立たない）
2. **共同編集の経路での並び**: リモートの挿入・削除・拒否の巻き戻し（`rebuildView`）・catch-up・bootstrap の文書の入れ替えのそれぞれで、`DocumentView` の「呼んだ時点にあった行」（known）と並びが決定どおりになるか。テストが確かめていない経路（他の参加者の `setRows` 相当・同じ行 ID の削除と再出現・自分の未確定の挿入がサーバーで別の位置に並び直る）
3. **E2E の確かさ**: 各テストが決定事項を本当に確かめているか（偽の成功になっていないか）、共有の文書・認可サーバーの lock を他の spec に漏らさないか、不安定になる待ち方が無いか
4. **在席（presence）**: 隠れている行にいる他の参加者の枠・自分の選択が隠れたときの知らせ直し

## 対象外

- 仕様の当否（一度きりの並び・view-local）
- DD-070-8 で直してレビュー済みの部品（並びの組み立て・自動の行高・結合・再ベース）。ただし共同編集の経路で壊れるなら指摘してほしい
- 既存の他の機能

## 出力形式

指摘ごとに「重要度（P1/P2/P3）・ファイルと行・何が起きるか（具体的な条件）・直し方」。指摘が無ければ「指摘なし」と書く。
