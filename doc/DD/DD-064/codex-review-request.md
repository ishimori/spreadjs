# Codexレビュー依頼: DD-064（セルの結合・2段の見出し）

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製リアルタイム共同編集スプレッドシート型入力基盤（依存ゼロのCanvasグリッドコア＋Hono/wsサーバー）。consumer（広島空港の計画策定システムの試作・単独モード・React 19）が、明細ごとに「予算・実績＋見通し・差異」の3行で、属性の列（No・事業・科目など）を3行にまたがって結合した Excel と同じ形の入力シートを作るため、次の2つを足した:

- **セルの結合**（表示のための結合・view-local）: mount オプション `mergedCells` と両モードの命令 `setMergedCells`。範囲は1つのセルとして描き、選択・移動・コピー・貼り付けを範囲に合わせる。結合したセルは読むだけ
- **2段の見出し**: mount オプション `columnGroups`（列のまとまりの名前を見出しの上の段に出す・表示だけ）

DD 本文: `doc/DD/DD-064_セルの結合（consumer 駆動・計画策定の入力シート）.md`（論点1〜12・決定事項・受け入れ基準）。公開 API の細目の正本: `doc/DD/DD-064/contract.md`。仕様はユーザーが推奨案で確定済みで、本レビューの対象は**実装が契約どおり正しく作られているか**であり、**設計判断そのものの当否は問わない**（後述「対象外」）。

## レビュー対象差分

コミット（スクリプトが `git show <sha>` で渡すもの）の変更すべて。DD 文書と本依頼書は対象外。

## 決定事項（この実装の正・詳細は contract.md）

結合（contract §1〜5）:
1. 指定は左上のセル（`rowId`・`columnId`）＋ `rowSpan`・`columnSpan`（省略 1）。形の誤り（未知の列・右端を越える・固定列の境界をまたぐ・1×1・span が 1 以上の整数でない・同じ左上の重複）は、mount オプションなら fail-fast（`merged-cells-invalid`）、`setMergedCells` ならその指定だけ捨てて warn
2. 行に張るのは**次の描画の時**（`setData`・`setMergedCells` を同じ処理の中でどちらの順に呼んでも、古い行の並びで張らない）。張る時に範囲の行 ID を覚え、以後はその行で持つ。範囲の上下に行が入っても一緒に動く。覚えた行が欠けた・間に行が入った・並びが変わったら捨てる（`merged-cell-broken`）。左上の行が無い・行が足りない間は保留（`merged-cell-unresolved`・行が届けば張る・行が 0 件の間は判定しない）。固定行の境界をまたぐ・先の指定と重なる結合は描かない（`merged-cell-conflict`）。warn は1つの指定・理由ごとに1回
3. `setMergedCells` は全体を置き換え、同じ内容でも次の描画の時の行で張り直す（同じ指定の「張れない」warn は出し直さない）。boot 前は最後の1回を保留。throw しない
4. 結合範囲のセルは読むだけ: 入口（印字キー・F2・ダブルクリック・IME・Delete/Backspace・候補欄・カレンダー）を止める。貼り付け・範囲の消去・cut は範囲のセルだけ飛ばす。**送信直前の保証層（readOnly の chokepoint）には入れない**（Undo/Redo・setData・setRows・リモートは通す）
5. 選択: 範囲の中のクリック・`setActiveCell`・移動の結果は左上へ。矢印・Tab・Enter は範囲を1セルとして動く（左上から下・右は範囲の外へ。端で出られなければ動かない）。編集中の確定と移動の先が範囲の中でも左上へ。範囲の選択（Shift＋矢印・Shift＋クリック・ドラッグ）は結合を含むまで広げ、1つの結合そのものは単一選択。Shift＋矢印の焦点が結合の中なら結合の端から外へ動く。ホバー・リンク・Presence は左上・範囲全体で扱う
6. コピーは左上に値・残りは空（範囲の中の他のセルに値があっても空）
7. 描画: 範囲を1つの大きなセルとして描く（背景・文字・書式・状態表示は左上のもの。範囲の中のグリッド線と `rowBorders`・`columnBorders`・`defaultRowBorder` の範囲の中の部分は描かない）。文字はふつうのセルと同じ決まり（縦の中央・数値は右寄せ・折り返しの列は上から）で範囲の中、収まらなければ …、右隣へはみ出さない。左のセルの文字も結合の手前で止まる。結合範囲の文字で行の高さを自動で伸ばさない。列幅の自動調整は左上以外と2列以上の結合を測らない

2段の見出し（contract §6）:
8. `columnGroups: [{ caption, columnIds }]`（mount 固定）。1件以上で見出しを 48px（24＋24）にし、まとめた列は上の段にまとまりの名前・下の段に列の名前、まとめていない列は2段ぶんの中央。形の誤り（隣り合っていない・重なる・固定列の境界をまたぐ等）は `column-display-invalid`。上の段のクリックは `header-click` を出さない。上の段のまとまりの中の境界では列幅を変えない

React（contract §7）:
9. `mergedCells` props は値（参照）が変わっても開き直さず `setMergedCells` を呼ぶ（handle には出さない）。`columnGroups` は識別系

## 実装の要点

- `packages/selection/src/merges.ts`（新規）: 結合の索引（`at`・`intersecting`・行ごとの表と prefix max）、`expandRangeToMerges`・`isSingleMergeRange`・`mergeAnchorOf`・`stepAcrossMerges`・`moveAcrossMerges`
- `packages/render/src/base-layer.ts`: `drawCellValue` を切り出し、Pass 1 で結合範囲のセルを飛ばし（結合は空セルとして扱わない）、`drawPaneMerges` で範囲を描き直す（罫線幅ぶん内側から背景・clip して値・状態の枠）。`drawStatusFrame` を矩形1つに一般化。2段の見出しは `columnGroupBand`
- `packages/render/src/border-layer.ts`: 線ごとに結合の内側の区間を求め、実線は残りの区間・点線は区間の中の点だけ描く（固定帯とスクロール帯で切り詰める）
- `packages/render/src/overlay-layer.ts`: Presence のアクティブセルが結合の中なら範囲全体
- `packages/grid/src/merged-cell-spec.ts`（新規・公開型と形の検査。公開宣言の閉包に入るため内部 package に依存しない）・`merged-cells.ts`（新規・解決の registry）・`column-groups.ts`（新規）
- `packages/grid/src/selection-controller.ts`: `merges` を受けて範囲を広げる・Shift＋矢印の焦点の動き
- `packages/grid/src/mount-controller.ts`:
  - `refreshMerges` を `redraw()` の先頭で呼ぶ。構造 flush では `resolveMerges` → `applyRebaseState` → `afterMergesChanged` の順（再ベースの正規化が古い索引を使わないため）
  - `normalizeActiveIntoMerge`（onChange の先頭・結合が変わった後）: Navigation のときだけ `pointerdownCell(anchor, { focus: false })`
  - `interceptKeydown`: 読み取り専用の入口抑止に結合を含める（`merged-cell-blocked`）。行操作キーの後・範囲の拡張の前に、結合を1セルとして動く移動（状態機械の1セル先と違うときだけ消費）
  - ポインター: クリック・ドラッグの起点・リンク候補・検索付き候補・ホバーを左上へ寄せる（Shift＋クリックの焦点は生のセル）。ダブルクリックを止める。上の段の `header-click` を出さない。上の段のまとまりの中の境界のリサイズを止める
  - `filterReadOnlyCells` に結合のスキップ（`merged-cell-skipped`）。コピーは `copyPort`（左上以外を空）
  - `ensureCellVisible` は結合の左上なら範囲全体を見せる（範囲が大きければ上端・左端を優先）。`performSetActiveCell` は左上へ
  - 見出しの高さは `headerHeight`（2段で 48）。wrap 列の自動行高から結合範囲を外す（`DocumentView.setAutoHeightSkip`）
- `packages/grid/src/integration-editor.ts`: `pointerdownCell(cell, { focus?: false })`（自動の正規化でフォーカスを奪わない）
- `packages/react/src/index.ts`: `mergedCells`（`setMergedCells` へ写す effect）・`columnGroups`（mountKey）
- playground: `?merged=`・`?colgroups=`（JSON）。E2E `apps/playground/e2e/merged-cells.spec.ts`

検証済み: unit 全件・typecheck・consumer-strict・lint（boundary 含む）・E2E（merged-cells 8件・全件）green。

## 評価基準（この観点で見てほしい）

1. **契約との一致**: 上記 1〜9 と contract.md のとおりに動くか
2. **選択・移動（最重要）**: アクティブセルの所有は IME 状態機械のまま（状態機械は無改変）で、前段の消費と onChange の正規化だけで左上へ寄せている。編集中・変換中（IME）・pendingNavigation・明示レンジの不変条件（anchor === activeCell）・ドラッグ・Shift＋クリック・行の挿入削除の再ベース・リモートの行操作で、アクティブセルが範囲の中（左上以外）に残る・別の行へ飛ぶ・入力が失われる経路が無いか。onChange の中から `pointerdownCell` を呼ぶ再入が安全か
3. **解決のタイミング**: 「描画の時に張る」ことで、描画の前のクリック・キー・コピー・貼り付けが画面と食い違わないか。`setData`・`setMergedCells`・`insertRows`・`scrollToRow`/`setActiveCell`（runOrDefer の同期 flush）を混ぜた呼び出し順、共同編集モードの snapshot 前後・再接続で、誤った行に張る・warn が溢れる・張れないまま残る経路が無いか
4. **読むだけの抜け**: 結合範囲の値が利用者の操作で変わる経路（候補欄・カレンダー・検索付き候補・貼り付けの敷き詰め・cut・範囲の Delete・IME）が残っていないか。逆に、結合の外の正当な操作を止めていないか
5. **描画**: 範囲の外への描き漏れ（固定 pane・スクロール・overscan・pane の clip）、範囲の中の線・値の残り、状態表示・書式・行背景・列背景の重ね順、点線の位相、2段の見出しの clip（DD-039 の帯ごとの clip）
6. **既存挙動の非破壊**: 結合・2段の見出しを使わない画面が従来と同一か（描画の呼び出し列・選択・キー・貼り付け・コピー・見出しの高さ・描画コスト）。base-layer のリファクタ（`drawCellValue`・`drawStatusFrame`・ヘルパーの引数を矩形へ）で振る舞いが変わっていないか
7. **公開面と型**: R7（公開宣言の閉包に内部 package 型を出さない）、`exactOptionalPropertyTypes`、JS の consumer から来る不正値（配列でない・壊れた要素）で例外にならないか
8. **テストの効き**: 追加した unit・E2E が上記を本当に検出できるか（アサーションが緩すぎないか）

## 対象外（指摘しても採用しない観点）

- 決定事項の設計選択そのものの当否（例: 文書の状態としての結合〔MergeCells〕にする案・結合したセルを編集できるようにする案・結合範囲に合わせて行の高さを伸ばす案・縮小/拡大の規則）
- 命名の好み（既存コードの命名規則と整合していればよい）
- 本DDの範囲外の改善提案・既存コードの別件の不具合（見つけたら「別件」として1行で挙げるのは歓迎）
- CHANGELOG・README・DD 文書の文体
