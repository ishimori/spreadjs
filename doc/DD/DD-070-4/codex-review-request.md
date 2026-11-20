# Codexレビュー依頼: DD-070-4（数値の列型）

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製スプレッドシート型入力基盤（Canvas グリッド・日本語 IME を壊さない常駐 textarea・サーバー主導の共同編集）。consumer（Excel の管理表を置き換える登録画面。wt%・比率・ppb・単価の列がある）の依頼で、数値だけを通す列タイプを足した。

DD 本文: `doc/DD/DD-070-4_数値の列型.md`（決定事項 1〜6・受け入れ基準）。手引き: `doc/quick-start.md` の「数値の列」。仕様は確定済みで、本レビューの対象は**実装が決定事項どおり正しく作られているか**。

## レビュー対象差分

コミットの変更すべて（DD 文書と本依頼書は対象外）。

## 決定事項

1. `columnTypes: { col: { type: 'number', invalidMessage? } }`（公開型 `GridNumberColumnType`）。既定のメッセージは「数値を入力してください」
2. 確定しようとしている値が空でなく、SDK の型変換（`parseCellInput`）の結果が数値でなければ拒否（全角数字・全角マイナス・3 桁区切りは数値として通す。日付の形・`12.5%`・`<0.1`・`ND` は拒否）
3. 拒否の経路は `validateCell`（DD-063）と同じ: 入力を捨てて `cell-invalid`。貼り付け・Ctrl+D／Ctrl+R は 1 件でも不正なら全体を拒否し、不正なセルを全部載せる。検証しない経路も DD-063 と同じ（空にする確定・Undo/Redo・`setRows`/`setData`・リモート）
4. 数値として通ったセルは、そのあと `validateCell` にも渡す。数値でなかったセルは `validateCell` を呼ばない
5. `stringColumns` と同じ列・空の `invalidMessage` は mount 時に fail-fast（`column-types-invalid`）
6. 両モード共通。文書・Operation・snapshot は変えない

## 実装の要点

- `packages/grid/src/column-types.ts`: `GridNumberColumnType`・registry の `isNumberColumn`・`hasAnyNumberColumn`・`numberInvalidMessage`。`stringColumns` を受けて併用を検査。サイズのガード（循環的複雑度 30）に収めるため、既存の検査を `checkReadOnlyColumns`・`checkColumnType` に切り出した（中身は従来どおり）
- `packages/grid/src/mount/edit-submit.ts`: `rejectInvalidCells` で数値の列を consumer の `validateCell` より先に判定
- `packages/grid/src/mount/config.ts`・`mount-controller.ts`・`index.ts`: 配線と公開型
- テスト: `column-types.test.ts`・`mount/edit-submit.test.ts`・E2E `apps/playground/e2e/number-column.spec.ts`

## 評価基準（この観点で見てほしい）

1. **拒否の過不足（最重要）**: 数値の列への確定のどの経路が関所（`rejectInvalidCells`）を通らずに数値でない値を書けるか（IME 確定・Enter／Tab／矢印での確定と移動・変換確定直後のクリック・`setReadOnly` の切り替えで確定する編集中のセル・`flush()` で確定するセル・貼り付け・Ctrl+D／Ctrl+R・切り取りの書き戻し・Undo/Redo）。逆に、通すべき値（全角・桁区切り・負数・小数）を拒否する経路が無いか
2. **型変換との一致**: 判定を `change.value.kind` で行うことが、各経路の型変換（`stringColumns`・`parseCellInput` の呼び方）と食い違わないか
3. **validateCell との組み合わせ**: 呼ぶ・呼ばないの条件、例外を投げたときの扱い、通知（`cell-invalid`）の中身と時点
4. **切り出したリファクタ**: `checkReadOnlyColumns`・`checkColumnType` で検査の順序・例外の種類・メッセージが変わっていないか（特に読み取り専用列の検査が列タイプより先に行われる順序）
5. **既存挙動の非破壊**: 数値の列を使わない画面で `rejectInvalidCells` の動き・コストが従来と同じか

## 対象外

- 仕様の当否（`<0.1` などを拒否すること・IME を自動で切り替えないこと）
- 既存の他の機能

## 出力形式

指摘ごとに「重要度（P1/P2/P3）・ファイルと行・何が起きるか（具体的な条件）・直し方」。指摘が無ければ「指摘なし」と書く。
