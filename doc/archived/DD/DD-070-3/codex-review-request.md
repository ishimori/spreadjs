# Codexレビュー依頼: DD-070-3（下方向・右方向へのコピー Ctrl+D・Ctrl+R）

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製スプレッドシート型入力基盤（Canvas グリッド・日本語 IME を壊さない常駐 textarea・サーバー主導の共同編集）。consumer（Excel の管理表を置き換える登録画面）の依頼で、Excel と同じ Ctrl+D（上のセルを下へ写す）と Ctrl+R（左のセルを右へ写す）を足した。

DD 本文: `doc/DD/DD-070-3_下方向・右方向へのコピー（Ctrl+D・Ctrl+R）.md`（決定事項 1〜6・受け入れ基準）。手引き: `doc/quick-start.md` の「下方向・右方向へのコピー」。仕様は確定済みで、本レビューの対象は**実装が決定事項どおり正しく作られているか**。

## レビュー対象差分

コミットの変更すべて（DD 文書と本依頼書は対象外）。

## 決定事項

1. Ctrl+D: 範囲が 2 行以上なら各列で一番上のセルを残りの行へ。1 行（1 セル）なら上の行のセルを範囲へ（先頭の行なら何もしない）。Ctrl+R は列の向き。範囲は貼り付けと同じ `selectedRange`（結合の左上だけを選べば結合全体）
2. 写す値は表示文字列を貼り付けと同じ型変換（`parseCellInput`・`stringColumns` は文字列のまま）に通したもの。写す先の値が同じセルは書かない。空を写すと空にする
3. 書き込みは貼り付けと同じ経路: 読むだけのセル・結合範囲は飛ばして `cells-skipped`（`operation: 'fill'`）、`validateCell` は 1 件でも拒否すれば全体を拒否（`cell-invalid` の `source: 'fill'`）、Undo は 1 回、共同編集は 1 つの SetCells（OCC の beforeRevision 付き）。上限（10 万セル）超は実行前に拒否（`range-too-large`）。選択は動かさない
4. 表全体が `readOnly` なら書かずに `edit-blocked`（`input: 'fill'`）
5. 裁くのは Navigation の位相で変換中でないときだけ。編集中（Navigation でない位相）は何もせず既定（ブックマーク・再読み込み）を止める（consume → preventDefault）。変換中は触らない。Shift・Alt つきは裁かない
6. union の拡張（`GridEditBlockedInput`・`cells-skipped` の `operation`・`cell-invalid` の `source` に `'fill'`）

## 実装の要点

- `packages/grid/src/fill-ops.ts`（新規）: `fillRanges`・`buildFill`・`decideFillKey`
- `packages/grid/src/mount/edit-commands.ts`: `performFill`
- `packages/grid/src/mount/keyboard.ts`: 段 `fill`（`undoRedo` の次・`KEY_HANDLER_ORDER`）
- `packages/grid/src/index.ts`・`mount/constants.ts`・`mount/edit-blocked.ts`・`mount-controller.ts`: 型と配線
- テスト: `fill-ops.test.ts`・`mount/keyboard.test.ts`・E2E `apps/playground/e2e/fill-keys.spec.ts`

## 評価基準（この観点で見てほしい）

1. **書き込みの正しさ（最重要）**: 写す元と先のセルの対応（固定行列・結合・範囲の向き・ドラッグで右下から選んだ範囲）、型の保ち方（数値・日付・文字列・`stringColumns`・先頭ゼロの文字列）、同じ値を書かない判定の誤り、読むだけのセルの飛ばし方、validateCell・Undo・cell-commit・共同編集の OCC（beforeRevision の捕捉元が committed で正しいか・pending の自分の変更が写す元にある場合）
2. **キーの裁定と IME**: 段の順序で既存のキー（Undo・行操作・候補欄・カレンダー・読み取り専用の段）を壊していないか、変換中・変換確定直後・候補欄やカレンダーが開いている間・読み取り専用のセルの上での挙動、編集中に既定を止めることの副作用（textarea の中の文字の編集を壊さないか）
3. **通知**: `edit-blocked`・`cells-skipped`・`cell-invalid` が 1 回の操作で 1 回か、出す時点（書き込みの後）
4. **既存挙動の非破壊**: 貼り付け・範囲の消去・Undo の経路、`KEY_HANDLER_ORDER` の他の段

## 対象外

- 仕様の当否（Excel との細かな違い・フィルハンドルが無いこと）
- 既存の他の機能

## 出力形式

指摘ごとに「重要度（P1/P2/P3）・ファイルと行・何が起きるか（具体的な条件）・直し方」。指摘が無ければ「指摘なし」と書く。
