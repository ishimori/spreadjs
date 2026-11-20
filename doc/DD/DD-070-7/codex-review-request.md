# Codexレビュー依頼: DD-070-7（見せる列の切り替え）

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製スプレッドシート型入力基盤（Canvas グリッド・日本語 IME を壊さない常駐 textarea・サーバー主導の共同編集）。consumer（180 列の一覧）が列を作り直さずに隠す・見せる（列のまとまりの折りたたみを含む）ため、`hiddenColumns`（mount）と `setHiddenColumns`（命令）を足した。

DD 本文: `doc/DD/DD-070-7_見せる列の切り替え.md`（決定事項 1〜6）。手引き: `doc/quick-start.md` の「見せる列の切り替え」。仕様は確定済みで、本レビューの対象は**実装が決定事項どおり正しく作られているか**。

## レビュー対象差分

コミットの変更すべて（DD 文書と本依頼書は対象外）。

## 決定事項（要点）

1. `hiddenColumns`（初期値）と `setHiddenColumns(columnIds)`（丸ごと置き換え・`[]` で全部見せる）。view-local・両モード・開き直さない。React は prop の参照が変われば setter
2. 隠した列は列の Axis に幅 0 で残す（列の並びと番号は変えない）。2 段の見出し・罫線・結合・固定列数・列ごとの設定は番号のまま効く。保存する列幅（`layout` の `columnWidths`）に 0 は入れない（見せると元の幅）
3. 当たり判定は隠した列を選ばない（クリック・ドラッグ・列幅の境界のつまみ）
4. 選択中のセルが隠した列に入ったら、動いてきた向きの次の見えている列へ寄せる（無ければ逆の向き）。矢印・Tab・Enter・`setActiveCell`・隠したときの今のセルを含む。結合の左上へ寄せるのと同じ onChange で行う。全部の列を隠したときは寄せない
5. 範囲の選択・コピー・貼り付けは隠した列を含む（Excel と同じ）。`scrollToColumn` は隠した列なら何もしない
6. 未知の列は捨てて診断 warn。配列でなければ何も変えない

## 実装の要点

- `packages/render/src/axis.ts`: 大きさ 0 の項目を当たり判定で選ばない（`visibleNear`）
- `packages/grid/src/document-view.ts`: `setHiddenColumns`・`isColumnHidden`・`hasHiddenColumns`（列幅の override に 0 を重ねて列の Axis を作り直す）・`setColumnWidth` は隠した列なら override だけ・`flush` の `columnLayoutChanged`
- `packages/grid/src/mount/hidden-columns.ts`（新規）: 検査・結線前の保留・`normalizeActiveCell`
- `packages/grid/src/mount/editor-wiring.ts`（onChange で寄せる）・`mount/render.ts`（scroll の幅）・`mount/commands.ts`（`scrollToColumn`）・`resize-interaction.ts`（左の境界で隠した列を飛ばす）・`mount-controller.ts`・`index.ts`・`packages/react/src/index.ts`
- テスト: render `axis.test.ts`・grid `document-view.test.ts`・`mount/hidden-columns.test.ts`・E2E `apps/playground/e2e/hidden-columns.spec.ts`

## 評価基準（この観点で見てほしい）

1. **幅 0 の列が残す不具合（最重要）**: 描画（文字の右へのはみ出しが隠した列を越えて描かれる・固定列の帯・罫線・結合・2 段の見出しの上の段の幅・選択枠・他の参加者の枠）、編集欄の位置（隠した列のセルが編集中になる経路が残っていないか）、列幅の自動調整、`ensureCellVisible`
2. **選択の寄せ**: 寄せる向きの判定（`lastActiveCol` の更新の時点が正しいか）、IME の変換中・編集中に隠したとき、Shift＋矢印・ドラッグで範囲の端が隠した列に入ったとき、行の挿入削除・`setData` の後、結合の左上への寄せとの順序
3. **当たり判定**: 先頭・末尾・連続して隠した列、固定列の境界、列幅の境界のつまみ（右の境界・左の境界）
4. **作り直しの費用と状態**: 列の Axis を作り直すことでスクロール位置・選択・Undo・列幅の override が保たれるか、`markViewportDirty` だけで足りるか（構造の flush が要るか）、共同編集モード
5. **React**: prop の参照比較・未 mount 時

## 対象外

- 仕様の当否（Excel と同じく範囲の操作に隠した列を含めること）
- 既存の他の機能

## 出力形式

指摘ごとに「重要度（P1/P2/P3）・ファイルと行・何が起きるか（具体的な条件）・直し方」。指摘が無ければ「指摘なし」と書く。
