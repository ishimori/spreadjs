# Codexレビュー依頼: DD-070-8（見せる行と並び）

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製スプレッドシート型入力基盤（Canvas グリッド・日本語 IME を壊さない常駐 textarea・サーバー主導の共同編集）。consumer（180 列 × 数万行の一覧）が表を作り直さずに並べ替える・絞り込むため、`setRowView(rowIds | null)` と `visibleRowIds()` を足した。並べ替え・絞り込みの計算は consumer が行い（`getRows` で値を読む）、SDK は渡された並びを見せるだけ。

DD 本文: `doc/DD/DD-070-8_見せる行と並び（単独モード）.md`（決定事項 1〜10）。手引き: `doc/quick-start.md` の「見せる行と並び」。仕様は確定済みで、本レビューの対象は**実装が決定事項どおり正しく作られているか**。共同編集モードでの確かめは次の DD-070-9 で行うが、両モード共通の部品（DocumentView・再ベース）に共同編集で壊れる作りがあれば指摘してほしい。

## レビュー対象差分

コミット 0a18e77 の変更すべて（DD 文書と本依頼書は対象外）。

## 決定事項（要点）

1. `setRowView(rowIds)`: 見せる行を見せる順に渡す。`null` で文書の並びへ戻す。view-local・開き直さない（Undo・スクロール位置を保つ）。`visibleRowIds()` は今見せている行を見せる順に返す
2. 一度きりの並び（Excel と同じ）: 値を変えても並び直さない
3. 呼んだ時点にあった行で渡さなかった行は隠す。呼んだ後にできた行は、文書の並びで一つ前の見えている行のすぐ後に見せる（無ければ先頭）。消した行は抜ける
4. 隠した行は範囲の操作（選択・コピー・切り取り・範囲の消去・貼り付け・Ctrl+D）の外。値は文書に残り `getRows` で読める
5. 選択は行 ID を追う（既存の構造の flush の再ベース）。選択中の行を隠したら近くの見えている行へ
6. 編集中に呼んだら編集中のセルを確定してから変える。IME の変換中なら変換が終わってから（`setReadOnly`・`setHiddenColumns` と同じ）
7. 固定行は見せる並びの先頭の n 行。行をまたぐ結合は並びが変わると張れなくなる（既存の決まりで捨てる）
8. `scrollToRow`・`setActiveCell` で隠した行を指したら何もしない（info `row-hidden`）。行の初回の未知の検査（`readOnlyRows`・`rowBackgrounds`・`rowBorders`）は隠れているだけの行を未知にしない
9. 不正な値は何も変えずに warn（`row-view-invalid`）。未知の行 ID は無視。重複は最初の 1 つ
10. 5 万行でも O(行数)。並びだけが変わったときは自動の行高を全件測り直さない

## 実装の要点

- `packages/grid/src/row-view.ts`（新規）: `buildViewRowOrder(base, spec)`（純粋関数）
- `packages/grid/src/document-view.ts`: `setRowView`・`hasRowView`・`isRowHiddenByView`・`viewRowIds`。`dirtyRowView` を `hasStructuralDirty` に含め、flush で行の Axis を作り直す（並びだけなら `measureMissingAutoRowHeights`）。隠れているだけの行の自動の行高は掃除しない
- `packages/grid/src/mount/row-view-switch.ts`（新規）: 検査・結線前の保留・編集中の確定・変換中の待ち（onChange から `scheduleCheck`）・`visibleRowIds`（保留中の構造を flush してから読む）
- `mount/commands.ts`（`row-hidden`）・`mount/cell-lock.ts`・`mount/config.ts`（未知の検査）・`mount/editor-wiring.ts`・`mount-controller.ts`（`flushPendingStructure` を関数に）・`index.ts`・`packages/react/src/index.ts`
- テスト: `row-view.test.ts`・`document-view.test.ts`・`mount/row-view-switch.test.ts`・E2E `apps/playground/e2e/row-view.spec.ts`・計測 `zz-row-view-perf.spec.ts`

## 評価基準（この観点で見てほしい）

1. **行の番号と行 ID の取り違え（最重要）**: 行の Axis の番号が文書の並びの番号と同じだと仮定している箇所が残っていないか。例: 範囲の操作（コピー・切り取り・消去・貼り付け・Ctrl+D・Ctrl+R）、行の挿入・削除のショートカットと `insertRows`（「選択中の行の下」が文書のどこになるか）、Undo／Redo の後の選択、`cell-commit`・`selection-change` の行 ID、`getRows`、結合・固定行・行の罫線・行の背景・読み取り専用の行・状態表示、自動の行高、`ensureCellVisible`・`scrollToRow`、他の参加者の枠
2. **後からできた行の位置**: `setRows` の新しい行・連続した挿入・隠れている行の後への挿入・先頭への挿入、`setData` での入れ直し（同じ行 ID なら並びは残る・新しい行 ID なら全部見える）、削除して同じ行 ID が再び現れる経路
3. **構造の flush と再ベース**: `dirtyRowView` だけのときに構造の flush（選択の再ベース・scroll anchor の補正・merges の作り直し）が漏れなく走るか、走らせすぎていないか。編集中・変換中の確定の順、候補欄・日付の閉じ方
4. **費用**: 5 万行での `setRowView`・その後の通常の編集・行の挿入（行の Axis の作り直しのたびに `buildViewRowOrder` が走る）、`isRowHiddenByView` の呼ばれ方
5. **React**: handle の mount 前の扱い

## 対象外

- 仕様の当否（一度きりの並び・隠した行を範囲の操作の外にすること）
- 共同編集モードの E2E（DD-070-9）
- 既存の他の機能

## 出力形式

指摘ごとに「重要度（P1/P2/P3）・ファイルと行・何が起きるか（具体的な条件）・直し方」。指摘が無ければ「指摘なし」と書く。
