# Codexレビュー依頼: DD-055（候補欄のはみ出しと長文編集欄の高さ）

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製リアルタイム共同編集スプレッドシート型入力基盤（依存ゼロのCanvasグリッドコア＋Hono/wsサーバー）。DD-055 は consumer（ReadyCrew）が本番（0.1.0-alpha.9）で発見した表示不具合2件の修正:

- **RC16**: 可視域の下端近くのセルで選択式のドロップダウン・日付のカレンダーを開くと、候補欄が常にセルの下に開き、枠（stage・`overflow:hidden`）と横スクロールバーの位置で切れて候補を選べない。右端近くの列でも右へはみ出して切れる
- **RC17**: 行の高さが 128px を超える wrap 列のセルを編集すると、編集欄が上部 128px（DD-052-1 の伸長上限）で止まり、その下にシートの描画が見える

DD 本文は `doc/DD/DD-055_候補欄のはみ出しと長文編集欄の高さ.md`（決定事項・受け入れ基準）、修正前の再現は `doc/DD/DD-055/bug-report.md`。Human Spec Gate（論点1〜5）はユーザー承認済みで、本レビューの対象は**実装が決定どおり正しく作られているか**であり、**設計判断そのものの当否は問わない**（後述「対象外」）。

## レビュー対象差分

未コミット変更すべて（`git status`・`git diff HEAD`・untracked の `packages/grid/src/popup-placement.ts`・`packages/grid/src/popup-placement.test.ts`・`doc/DD/DD-055/`）。

- `doc/DD/DD-055_*.md` と `doc/DD/DD-INDEX.md` の起票分（別セッションで作成済み）はレビュー対象外

## 決定事項（DD-055 論点1〜5。この実装の正）

1. 候補欄の縦: 下の余白に入りきらず、上の余白のほうが広ければセルの上に開く。高さは開いた側の余白に収め、はみ出す分は内部スクロール。余白の下端は `scroller.clientHeight`（横スクロールバーを除く）、上端は stage の上端（列見出しに重なってよい）
2. 向きは開いた時点で決め、開いている間は保持する。スクロール・絞り込みでは位置だけ追従し、上向きは候補欄の下端をセルの上端に揃える
3. 横: 可視域の右端を越えるなら左へずらして収める（左端 0 でクランプ）
4. 長文の編集欄の上限は `max(セルの高さ, 128px)`。1行の高さのセルの伸び方（DD-052-1）は変えない
5. 編集欄が可視域の下端を越えるなら、高さを可視域の下端までに縮めて内部スクロールにする（1行分の高さは下回らない）

## 実装の要点

- `packages/grid/src/popup-placement.ts`（新規）: 純関数 `computePopupPlacement({ cellRect, popupWidth, popupHeight, visibleArea, direction? })` → `{ direction, left, top, maxHeight }`。上向きの `top` は `cellRect.y - min(popupHeight, maxHeight)`
- `packages/grid/src/select-editor.ts`・`packages/grid/src/date-editor.ts`（DOM アダプタ）:
  - 開いた時点の向きを `direction` に保持（`close`/`confirmValue` で null、`open` で決め直し）。suggest モード（DD-037 の入力中の候補）は `open({ rect: null })` で開き、同じフレームの `refresh` で最初に配置したときに向きが決まる
  - 毎フレームの `place*()` で「余白で縮める前の高さ」を `scrollHeight + (offsetHeight - clientHeight)` で測り（listbox は既定上限 220px まで）、純関数の結果を `left/top/maxHeight` に反映。`max-height` を変えずに測る（測る間に内部スクロール位置を切り詰めないため）
  - 可視域は config の getter `visibleArea()`（開いている間の配置でだけ読む）
  - listbox: `open` での `paintHighlight()` を配置の後へ移動（高さが決まってから現値のハイライトを表示範囲へスクロール）
  - カレンダー: `overflowY:auto` を追加。`open` とキー移動（`moveDays`/`moveMonths`）の後にハイライトの日を表示範囲へスクロール（`revealHighlighted`）
- `packages/grid/src/editor-placement.ts`: 純関数 `computeWrapEditorHeight({ cellTop, cellHeight, contentHeight, visibleBottom, minHeight })` → `{ height, scroll }` と `MAX_WRAP_EDITOR_HEIGHT`（integration-editor.ts から移動）
- `packages/grid/src/integration-editor.ts` の `applyHeight()`: 中身の高さを**高さ 0 にしてから** `scrollHeight` で測る。従来はセルの高さへ戻して測っていたが、今回セルより低く縮める場合があり、セルの高さへ戻すと測るたびに内部スクロール位置が切り詰められる（E2E の AC8 2件目で、旧方式だと失敗することを確認済み）。可視域は config の optional getter `visibleArea`（wrap 列の編集中だけ読む）。1行分＝`CELL_TEXT_LINE_HEIGHT + 4`（上下の枠）
- `packages/grid/src/mount-controller.ts`: `visibleArea()`（`min(stage の寸法, scroller の client 寸法)`・client 寸法が 0 なら stage）を追加。DD-046 の `ensureCellVisible` も同じ関数を使うよう置き換え、3つの factory に getter を渡す
- DD の修正方針は「可視域を `open()`/`refresh()` の引数で渡す」例を挙げていたが、閉じている間に scroller の client 寸法を毎フレーム読まないよう config の getter にした

## 評価基準（この観点で見てほしい）

1. **決定事項との一致**: 上記 1〜5 のとおりに動くか。特に向きの保持（suggest モードで最初の配置時に決まる流れを含む）と、上向きのときに絞り込みで候補欄が低くなってもセルの上端から離れないこと
2. **既存挙動の非破壊**: 下に余白のあるセル（従来どおり下）、1行の高さの wrap セル（128px まで伸びて内部スクロール）、非 wrap 列の編集欄、IME の経路（composition 中に value/selection を書かない I-3、候補クリックで focus が textarea に残る I-5）が変わっていないか。高さ 0 で測る変更が DD-052-1 の伸び方を変えていないか
3. **毎フレームのレイアウトの読み書き**: `place*()`・`applyHeight()` の読み取り（`scrollHeight`/`offsetHeight`/`clientHeight`）と style 書き込みの順序で、内部スクロール位置の切り詰め・ちらつき・不要な強制レイアウトを増やしていないか
4. **境界条件**: セルが可視域の端から一部はみ出している・候補欄が可視域より広い・余白が 0・固定行/固定列のセル・初期レイアウトで `scroller.clientWidth/Height` が 0
5. **テストの効き**: `popup-placement.test.ts`・`editor-placement.test.ts` の追加分と、E2E（`apps/playground/e2e/column-types-select.spec.ts`・`date-column.spec.ts`・`wrap-cell-editing.spec.ts` の `DD-055` ケース）が上記を本当に検出できるか（アサーションが緩すぎないか）。E2E は headless Chromium がスクロールバーを隠すため、scroller の right/bottom を 16px 空けてスクロールバーを模擬している（DD-046 と同じ方法・`integration-helpers.ts` の `emulateScrollbars`）

## 対象外（指摘しても採用しない観点）

- 論点1〜5 の設計選択そのものの当否（Human Spec Gate 済み）
- 命名の好み（既存コードの命名規則と整合していればよい）
- 本DDの範囲外の改善提案（例: 候補欄の幅の上限、競合 badge の右端クランプ、行の高さが可視域より高いセルでのスクロール追従の往復〔既存挙動〕）
- DD-052-1 の既知の境界（textarea の枠 4px 分の見切れ）
- CHANGELOG・DD 文書の文体
