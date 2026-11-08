# Codexレビュー依頼: DD-069（セルごとの背景色と読むだけのセルへの入力の通知）

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製リアルタイム共同編集スプレッドシート型入力基盤（依存ゼロのCanvasグリッドコア＋Hono/wsサーバー）。consumer（広島空港の計画策定システムの試作・単独モード・React 19）の部署別シートで、セルの背景を「白＝入力できる／灰＝読むだけ（式の結果）」に分け、読むだけのセルに打ったら理由と直す先を出すため、次の2つを足した:

- **K8 セルごとの背景色**（view-local）: 単独モードの行データ `GridStandaloneRow.cellBackgrounds`（ColumnId → CSS color）と両モードの命令 `GridInstance.setCellBackgrounds(rows)`。置き場の決まりは既存の `cellStatus`（DD-060〜062）と同じ
- **K11 読むだけのセルへの入力の通知**: イベント `edit-blocked`（選択中のセル・ダブルクリックしたセルで編集を止めた）と `cells-skipped`（貼り付け・切り取り・範囲の消去で読むだけのセルを飛ばした）。止める判断そのものは変えず、止めた所から通知を出す

DD 本文: `doc/DD/DD-069_セルごとの背景色と読むだけのセルへの入力の通知（consumer 駆動・計画策定の部署別シート）.md`（論点1〜6・決定事項・受け入れ基準）。consumer 向けの手引き: `doc/quick-start.md` の「セルごとの背景色」「読むだけのセルへの入力の通知」の節。仕様はユーザーが推奨案で確定済みで、本レビューの対象は**実装が決定事項どおり正しく作られているか**であり、**設計判断そのものの当否は問わない**（後述「対象外」）。

## レビュー対象差分

コミット（スクリプトが `git show <sha>` で渡すもの）の変更すべて。DD 文書と本依頼書は対象外。

## 決定事項（この実装の正・詳細は DD の決定事項）

K8:
1. 置き場は `CellBackgroundStore`（`cellStatus` と同じ形）。単独モードの `initialData`・`setData`（作り直す）・`setRows`（渡した行を丸ごと置き換え・省略した行は保つ・`{}` で消す）と、両モードの `setCellBackgrounds` が同じ置き場を使う。単独モードの boot 前の `setCellBackgrounds` は `setData`/`setRows` と同じ queue に積み、呼んだ順に適用する。共同編集モードは各クライアントの画面だけ（サーバーへ送らない）
2. view-local: 文書・Operation・cell-commit・Undo/Redo・コピー・snapshot は変わらない
3. 重なり順: pane → 列の背景 → 行の背景 → **セルの背景** → 値ベース書式 → 状態表示（値ベース書式と状態表示の順は従来どおり）。結合範囲は左上のセルの色で範囲全体（範囲の中の他の行の指定は描かない）
4. 未知の列は静かに飛ばす（単独モード）。空・空白だけ・文字列でない色はそのセルだけ捨てて診断 warn `cell-background-invalid`（mount 時も例外にしない）。`cellBackgrounds` がオブジェクトでない行・rows が配列でない・要素が壊れているときも例外にせず診断。CSS の色としての妥当性は検査しない（不正な色は pane の背景で塗り、前の色を引き継がない）

K11:
5. `edit-blocked { rowId, columnId, input, reason }`。`input`: `key`（修飾なしの 1 文字と日本語入力オンの打鍵 `Process`）・`delete`（Delete・Backspace。修飾の有無によらない）・`f2`・`dblclick`・`paste`・`cut`・`clear`。`reason` が重なるときは `grid-readonly` → `merged` → `readonly-row` → `readonly-column` → `readonly-cell` の順で先のもの。結合範囲は左上のセルとして知らせる
6. 1 回の操作で 1 回。抑止して消費するキー（F2・Delete・Backspace）は抑止した段で、素通しする印字キー（textarea の readOnly で止まる）は通知だけして流す。表全体が readOnly で選択中のセルも読むだけのとき、表全体の段だけが知らせる。変換中（`isComposing`）・Navigation でない位相では知らせない
7. 範囲を選んだ Delete は従来どおり範囲の消去へ流す（`edit-blocked` を出さない）
8. 貼り付け・切り取り・範囲の消去で飛ばしたセルは、1 つだけでも `cells-skipped { operation, cells }`（`edit-blocked` にしない）。結合範囲は覆うセルを全部含む。通知は書き込みの後（貼り付けは選択の移動の後）。`validateCell` で貼り付け全体を拒否したときは出さない。表全体が readOnly のときの貼り付け・切り取り・範囲の消去は選択中のセルで `edit-blocked`
9. 出さない: 入力できるセルの編集・移動キー・コピー・修飾キーつきのショートカット・`setRows`/`setData`・リモートの変更・選択式の候補欄を開く操作（Alt+↓・検索つきの列の 1 回のクリック）と日付のカレンダーを止めたとき
10. 既存の診断（`readonly-*-blocked`／`-skipped`・`merged-cell-*`）とキーの優先順位（`KEY_HANDLER_ORDER`）は変えない

React: 11. ref handle に `setCellBackgrounds`（mount 前は無視＋warn）。イベントは `onEvent` でそのまま届く

## 実装の要点

- `packages/render/src/background-bands.ts`（新規）: 列・行・セルの背景と、結合範囲の重ね塗り（`fillLayers`）。`base-layer.ts` から列・行の帯を移した（サイズのガードの超過を増やさないため）
- `packages/render/src/base-layer.ts`: フック `cellBackgroundsInRow` を足し、`drawPane` と `drawPaneMerges` で `background-bands` を呼ぶ
- `packages/grid/src/cell-background.ts`（新規）: 置き場と診断メッセージ。`cell-status.ts` の `isPlainRecord` を公開して使う
- `packages/grid/src/standalone-session.ts`: 行データの `cellBackgrounds` の取り込み（`buildDocument`・`setRows`。背景だけの変更は `markCellDirty`）
- `packages/grid/src/mount/lifecycle.ts`: `setCellBackgrounds`・`applyCellBackgrounds`・boot 前の queue（kind `backgrounds`）
- `packages/grid/src/mount/base-layer-options.ts`: `cellBackgroundMarksAt`（RowId/ColumnId を描画のたびに index へ解決）
- `packages/grid/src/mount/edit-blocked.ts`（新規）: `blockedKeyInput`（キー → 操作）と `createEditBlocked`（理由・左上への寄せ・emit）
- `packages/grid/src/mount/keyboard.ts`: `notifyBlockedKey`（段 1 `readOnly` と段 2 `readOnlyCells` から呼ぶ。`(kind === 'key') !== suppressed` で 1 打鍵 1 回）
- `packages/grid/src/mount/pointer.ts`: ダブルクリックを止める 5 か所で `atCell`
- `packages/grid/src/mount/edit-commands.ts`・`mount/cell-lock.ts`: `filterReadOnlyCells(op, label, skipped?)` が飛ばしたセルを集め、範囲の消去・切り取り・貼り付けが書き込みの後に `skipped` を出す。表全体の readOnly の分岐で `atActive`
- `packages/grid/src/mount-controller.ts`・`index.ts`: 配線と公開型（`GridCellRef`・`GridEditBlockedInput`・`GridEditBlockedReason`・`GridCellBackgroundRow`、`GridEvent` の 2 種）
- `packages/react/src/index.ts`: ref handle の `setCellBackgrounds`
- テスト: render `base-layer.dd069.test.ts`、grid `mount/edit-blocked.test.ts`・`mount/keyboard.test.ts`（DD-069 の describe）・`standalone-session.dd069.test.ts`・`mount/lifecycle.test.ts`（DD-069）、react `nanairo-sheet-view.dd061.test.ts`（DD-069）、E2E `apps/playground/e2e/cell-backgrounds.spec.ts`・`edit-blocked.spec.ts`

検証済み: unit 全件・typecheck・consumer-strict・lint（boundary・size 含む）・build・E2E（上記 5 件）green。

## 評価基準（この観点で見てほしい）

1. **決定事項との一致**: 上記 1〜11 のとおりに動くか
2. **通知の過不足（最重要）**: 1 回の操作で 0 回・2 回になる経路が無いか。特に、キーの 2 段（表全体・読むだけのセル）の重なり、IME（`Process`・`isComposing`・変換の確定直後）、範囲の選択がある・無い、結合範囲の中（左上以外）、`readOnly` の実行時切替（`setReadOnly`）の前後、編集中（Editing 位相）・候補欄やカレンダーが開いている間。逆に、入力できるセル・移動・コピー・`setRows` で出る経路が無いか
3. **通知の中身**: `rowId`・`columnId` が正しいセルか（結合の左上・行の挿入削除の後・固定行列・並べ替えた行）、`reason` の優先順位、`cells-skipped` の `cells` が実際に飛ばしたセルと一致するか（列・行・セル・結合が重なるときに重複・漏れが無いか）
4. **順序と再入**: `cells-skipped` を書き込み（と選択の移動）の後に出しているか。購読者がその場で `setActiveCell`・`setRows`・`setCellBackgrounds`・`setReadOnly` を呼んでも、SDK の状態が壊れない・上書きされないか
5. **K8 の描画**: 重なり順、固定 pane と本体の境界での二重塗り・塗り漏れ、結合範囲、不正な色で前の色を引き継がないこと、`setRows`/`setCellBackgrounds` の後に描き直ること、背景を使わない画面の描画が従来と同一か（描画コスト・呼び出し列）
6. **K8 の置き場**: `setData`・`setRows`・`setCellBackgrounds`・boot 前の queue の呼び出し順、削除済みの RowId、共同編集モードの未知の列、JS の consumer の不正値で例外にならないか
7. **既存挙動の非破壊**: 止める判断・診断・キーの優先順位・貼り付けの選択の移動・Undo が変わっていないか。`base-layer.ts` から帯を移したリファクタで列・行の背景の描画が変わっていないか
8. **公開面と型**: R7（公開宣言の閉包に内部 package 型を出さない）、`exactOptionalPropertyTypes`、`GridEvent` の union の拡張の影響
9. **テストの効き**: 追加した unit・E2E が上記を本当に検出できるか（アサーションが緩すぎないか）

## 対象外（指摘しても採用しない観点）

- 決定事項の設計選択そのものの当否（例: 1 セルの貼り付けを `edit-blocked` にする案・選択中のセルを返す API を足す案・候補欄やカレンダーも通知する案・mount 時に fail-fast にする案）
- 命名の好み（既存コードの命名規則と整合していればよい）
- 本DDの範囲外の改善提案・既存コードの別件の不具合（見つけたら「別件」として1行で挙げるのは歓迎）
- CHANGELOG・quick-start・DD 文書の文体
