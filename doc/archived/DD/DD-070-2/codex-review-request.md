# Codexレビュー依頼: DD-070-2（選択の変更とダブルクリックの通知）

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製スプレッドシート型入力基盤（Canvas グリッド・依存ゼロのコア＋React ラッパー）。consumer（Excel の管理表を置き換える一覧・登録画面）が「一覧の行から詳細を開く・選んだ行の詳細を横に出す」を作れるよう、次を足した:

- イベント `selection-change { activeCell, range }` と命令 `GridInstance.selection()`（React の ref handle にも）
- イベント `cell-dblclick { rowId, columnId }`

DD 本文: `doc/DD/DD-070-2_選択の変更とダブルクリックの通知.md`（決定事項・受け入れ基準）。手引き: `doc/quick-start.md` の「選択の変更とダブルクリックの通知」。仕様はユーザーと確定済みで、本レビューの対象は**実装が決定事項どおり正しく作られているか**。

## レビュー対象差分

コミットの変更すべて（DD 文書と本依頼書は対象外）。

## 決定事項

1. `selection-change`（両モード）: `activeCell` は選択中のセル（行が無ければ null）。`range` は枠を描いている範囲（左上・右下の行 ID・列 ID。1 セルだけのときも 1 × 1。結合の左上ならその結合全体。ドラッグ中はドラッグの範囲）
2. 前に知らせた内容と変わったときだけ、描画のループ（rAF）の終わりで 1 フレームに 1 回まで出す。初回のデータの描画の後に最初の選択を 1 回。行の並びが変わって番号だけが変わったときは出さない（ID で比べる）。ループの中で出すので購読者から命令 API を呼んでよい
3. `selection()` は呼んだ時点の選択を返す（イベントより先に直前の操作の結果）。行が無い・boot 前・destroy 後は両方 null
4. `cell-dblclick`（両モード）: 本体のセルのダブルクリックで、SDK の既定の動き（編集の開始・候補欄・カレンダー・読むだけのセルの `edit-blocked`）の後に出す。既定の動きは止めない。結合範囲は左上のセル。見出し・列の境界（幅の自動調整）・行番号では出さない

## 実装の要点

- `packages/grid/src/mount/selection-notify.ts`（新規）: `current()`（editor の `getActiveCell` と selection-controller の `getDragRange() ?? selectedRange(active)` を `view.rowIdAt/columnIdAt` で ID へ）と `check()`（前のキーと比べて emit）
- `packages/grid/src/mount/render.ts`: `masterLoop` の終わり（保留命令の適用の後）に `afterFrame()`
- `packages/grid/src/mount/pointer.ts`: dblclick の cell 分岐を `handleCellDoubleClick` に切り出し（中身は従来どおり）、先に左上の ID を決めてから既定の動き → `cell-dblclick`
- `packages/grid/src/index.ts`・`mount-controller.ts`: 公開型と配線。`packages/react/src/index.ts`: ref handle
- テスト: `mount/selection-notify.test.ts`（9）・E2E `apps/playground/e2e/selection-dblclick.spec.ts`（4）

検証済み: unit 全件・typecheck・consumer-strict・lint（boundary・size）・build・関係する E2E 39 件。

## 評価基準（この観点で見てほしい）

1. **通知の過不足（最重要）**: 選択が変わったのに出ない経路（キー・ポインタ・ドラッグの開始と終わり・Shift＋クリック・Escape・`setActiveCell`・行の挿入削除の再ベース・`setData`/`setRows` で行が減る・結合の左上への寄せ・Undo/Redo・貼り付け後の選択の移動・リモートの構造変更）、変わっていないのに出る経路（再描画・スクロール・編集の開始・IME の変換中）
2. **中身の正しさ**: `range` が実際に枠を描いている範囲と一致するか（結合・明示レンジ・ドラッグ・固定行列）、`activeCell` が null になる条件、範囲の端が表示の外になる場合
3. **時点と再入**: rAF の終わりで出すことで、購読者が `setActiveCell`・`setData` などを呼んだときに状態が壊れないか、destroy の後に出ないか、タブが隠れているときの扱い
4. **ダブルクリック**: 既定の動きが従来と同一か（切り出しのリファクタで分岐・順序・return が変わっていないか）、左上の ID を既定の動きの前に決めることの正しさ、読むだけの表・選択式・日付・列の境界での出方
5. **コスト**: 毎フレームの比較が大きい表（5 万行）でも無視できるか

## 対象外

- 仕様（イベントの形・発火の粒度）の当否
- 既存の他の機能

## 出力形式

指摘ごとに「重要度（P1/P2/P3）・ファイルと行・何が起きるか（具体的な条件）・直し方」。指摘が無ければ「指摘なし」と書く。
