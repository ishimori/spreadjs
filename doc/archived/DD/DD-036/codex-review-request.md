# DD-036 Codex レビュー依頼（固定列・列背景・行 readOnly・scrollToColumn）

## 背景・目的

consumer（松下 納入計画＝③管理表・列＝日付の 382 列 × 80 行マトリクス）が要求する 4 機能を SDK へ提供する。
正本: `doc/DD/DD-036_固定列・列背景・行readOnly.md`（決定事項・AC）と `doc/DD/DD-036/contract.md`（公開 API 契約）。

- **C1 固定行列数** `frozenRowCount` / `frozenColumnCount` — これまで `mount-controller.ts` で `1` にハードコードされていた
  固定 pane 数を mount オプションへ開けた（既定 1／1＝現行と完全一致・view-local・mount 時固定）。
- **C2 静的列背景** `columnBackgrounds: Record<ColumnId, string>` — 値によらない列色。`columnFormats`（値ベース・非空セル
  のみ）とは**別解決器**で、pane 背景の直後・罫線の前に**列バンド**として塗る（空セルも塗る）。同一セルに値ベース背景が
  あれば**値ベースが勝つ**（後から上塗り）。
- **C3 行単位 readOnly** `readOnlyRows: string[]` — `readOnlyColumns`（DD-035 R4）の行版。判定条件に行を足すだけで
  入口抑止（keydown 裁定・textarea の readOnly 属性・dispatch 抑止）／範囲スキップ／chokepoint を共有する。
  **未知 rowId は診断 warn のみ**（初回描画後に 1 回判定）＝列の fail-fast とは扱いを分けた。
- **C4** `GridInstance.scrollToColumn(columnId)` ＋ React handle — `scrollToRow` の鏡像。`ensureCellVisible` に軸指定
  （`'both' | 'vertical' | 'horizontal'`）を追加し、`scrollToRow` の「col: 0 は固定列だから横が動かない」という暗黙前提を廃止した。

## 対象差分（未コミット・`--uncommitted`）

| 領域 | ファイル |
|---|---|
| 公開面 | `packages/grid/src/index.ts`（mount オプション 4・`scrollToColumn`・JSDoc）／`packages/react/src/index.ts`（props 4・handle 1・mountKey 正準化） |
| 座標・命令 | `packages/grid/src/mount-controller.ts`（固定数の解決と検証／`ensureCellVisible` の軸指定／`performScrollToColumn`／行 readOnly の判定・フィルタ・chokepoint・未知 rowId 警告） |
| 描画 | `packages/render/src/base-layer.ts`（`columnBackground` フック＝列バンド描画）／`packages/grid/src/format-rules.ts`（`compileColumnBackgrounds`・`FormatRuleConfigError.reason` に `empty-color` を追加） |
| 純関数 | `packages/grid/src/readonly-policy.ts`（行版 partition/touches・列版と共通の走査へ抽出） |
| テスト | `packages/render/src/{viewport.dd036,base-layer.dd036}.test.ts`・`packages/grid/src/dd036-options.test.ts`・`packages/react/src/nanairo-sheet-view.dd036.test.ts`・`packages/render/src/scroll-anchor.test.ts`／`packages/grid/src/editor-placement.test.ts`（追記）・`apps/playground/e2e/{frozen-panes,readonly-rows,imperative-nav,react-facade-handle,zz-wide-grid-perf}.spec.ts` |
| ハーネス | `apps/playground/src/integration/{standalone-main,main,react-main}.ts`（URL パラメータ `frozenrows/frozencols/colbg/readonlyrows/extracols`）・`apps/playground/e2e/{standalone,react-facade}-helpers.ts` |
| 記録 | `CHANGELOG.md`・`apps/showcase/src/features.json`・`tests/contract/__snapshots__/facade-surface.test.ts.snap`・DD 本文・`DD-036/{contract,measurement}.md` |

## 評価基準（この観点で指摘してほしい）

1. **固定数可変化の取りこぼし（最重要）**: `frozenRowCount/frozenColCount` を 1 以外（0・5・列数超過）にしたとき、
   「1 固定」を暗黙前提にしたコードが残っていないか。特に (a) `ensureCellVisible` の軸指定と最小スクロール条件
   (b) `flushStructural` の `hasBodyRows` (c) `editor-placement` の可視判定 (d) base-layer の**オーバーフロー左外流入**の
   停止条件（`pane.cols.start > frozenColCount`）(e) `scroll-anchor` の捕捉/補正 (f) resize-interaction の隣接判定。
   **固定行/列が 0 のとき・全列が固定のとき**に破綻する経路があれば最優先で指摘してほしい。
2. **行 readOnly の保証層の網羅性**: 「readOnly 行への文書 Operation 送信ゼロ」が構造的に成立しているか。特に
   (a) Undo/Redo 補償 (b) 選択式/日付の確定経路 (c) K4 draft 退避 (d) 行挿入削除で**行 index がずれた後**の判定
   （判定は RowId ベース・index ベースの箇所が混在していないか）(e) `setData` 再注入で同じ RowId が復活した場合
   (f) 列版と行版を**両方**指定したときのフィルタ合成（二重診断・kept 空判定）。
3. **静的列背景の描画契約**: 列バンドを pane ごとに 1 列 1 回 fillRect する実装が (a) 罫線・選択・Presence・
   編集 textarea・カレンダー/ドロップダウンの上下関係を壊していないか (b) 固定 pane（corner/top/left）と body の
   境界で塗り残し・はみ出しが出ないか (c) 自動行高（wrap 列）で pane の行範囲が可変のときバンド高さが足りるか
   (d) `columnFormats` の badge/textColor と重なったときの見た目の破綻。
4. **未知 rowId 警告の設計**: 初回描画後 1 回だけの判定は妥当か（`setData` 後に現れる RowId・共同編集で後から届く行を
   永久に「未知」と誤解させないか）。警告が出ない/出すぎるケース。
5. **React 写像**: `mountKey` の正準化（`readOnlyRows` はソート・`columnBackgrounds` はキー順非依存・固定数は素の数値）で
   remount が意図どおりか。`undefined` 素通しが grid 側の既定（1／1・判定 false）と一致するか。
6. **公開契約・後方互換**: 追加のみか。`FormatRuleConfigError.reason` の union 拡張（`empty-color`）の影響
   （DD-035 の `ColumnTypeConfigError.reason` 拡張と同型）。既定値 1 の維持で既存 consumer が無影響か。
7. **テスト不足**: 上記 1〜4 を unit/E2E で検証できていない箇所。E2E の決定性（Canvas の getImageData を使った
   ピクセル検証・poll の使い方・フレーク要因）。

## 対象外（指摘不要）

- 仕様の妥当性そのもの（view-local に留める判断・既定 1・未知 rowId を warn に留める裁定・最小スクロール・
  align 指定なし）は Spec Gate で確定済み（contract.md・DD 決定事項）。
- 実 IME の Manual Gate（T1/M1）はクローズ非ブロックで別途。
- CSS・見た目の好み（網掛け色・固定バンドの境界線デザイン）。
- 共同編集サーバー側の行権限（将来スコープ）。
- 計測記録の置き場を kpi-ledger.md から DD 添付へ変えた判断（`DD-036/measurement.md` §1 に理由記載）。

## 出力形式

findings を P1（データ消失・不変条件違反・送信ゼロの破れ）／P2（誤動作・回帰）／P3（保守性・テスト）で分類し、
各 finding に「ファイル:行・再現手順 or 反例・推奨修正」を付けてほしい。総評は「マージ可／条件付き／要修正」の 1 行。
