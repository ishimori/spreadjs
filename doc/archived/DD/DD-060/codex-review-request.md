# Codexレビュー依頼: DD-060（セル入力の検証とエラー表示＝セルの状態表示）

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製リアルタイム共同編集スプレッドシート型入力基盤（依存ゼロのCanvasグリッドコア＋Hono/wsサーバー）。DD-060 は consumer（OFIC・管理会計の入力画面）の要求 O2:

- 業務側が確定後に検証した結果を、**そのセルの上**に出したい（先方の現行 Excel は申請時にセルを検査してエラーのセルに色を付ける）。従来は `columnFormats`（表示文字列の完全一致）・`rowBackgrounds`（行全体）しかなく、セル単位に印を付けられなかった

DD 本文は `doc/DD/DD-060_セル入力の検証とエラー表示.md`（決定事項 1〜4・詳細設計・受け入れ基準 1〜8）。Human Spec Gate はユーザー承認済みで、本レビューの対象は**実装が決定どおり正しく作られているか**であり、**設計判断そのものの当否は問わない**（後述「対象外」）。

## レビュー対象差分

未コミット変更すべて（`git status`・`git diff HEAD`）。untracked の新規ファイル:

- `packages/grid/src/standalone-session.dd060.test.ts`
- `packages/render/src/base-layer.dd060.test.ts`
- `apps/playground/e2e/cell-status.spec.ts`

`doc/DD/DD-060/`（本依頼書）と DD 本文はレビュー対象外。直前のコミット（DD-059 負の数の表示書式・`c61e841`）は別DDで、対象外。

## 決定事項（この実装の正）

1. 案B（セル単位の状態表示）だけを出す。確定そのものを止める検証フック（案A）は作らない
2. 表示: `error` = 赤枠 2px（`#d93025`）＋背景 `#fce8e6`、`warning` = 橙枠 2px（`#e37400`）＋背景 `#fef7e0`。値の有無によらず付く（空のセルにも）。枠はセルの内側（罫線の内側）。背景は列背景・行背景・値の書式（`columnFormats` の `cellBackground`）より優先し、文字・バッジ・枠はその上。色は固定
3. メッセージは描かず、`cell-hover` イベントの新フィールド `status?: { level; message? }` に載せる（状態のないセルではキー自体を付けない）。ホバー中のセルの状態が `setRows`／`setData` で変わったら、同じセルのままでも `cell-hover` を出し直す
4. `GridStandaloneRow.cellStatus`（ColumnId → 状態）。`setRows` では渡した行の状態を丸ごと置き換え、省略した行は保持、`{}` で消す（行の `readOnlyColumns` と同じ）。`setData`／`initialData` では作り直す。未知列は静かにスキップ、`level` が `error`/`warning` 以外のセルは無視して診断 `warn`（`cell-status-invalid`）を1回。状態は文書のデータではない（cell-commit・コピー TSV・Undo/Redo の対象外、利用者がセルを編集しても消えない）。単独モード専用

## 実装の要点

- `packages/grid/src/index.ts`: 公開型 `GridCellStatus`、`GridStandaloneRow.cellStatus`、`cell-hover` の `status?`（公開 `.d.ts` は追加のみ。`tests/contract` の snapshot 更新済み）
- `packages/grid/src/standalone-session.ts`: `cellReadOnly` と同じ形で `cellStatus: Map<rowId, Map<columnId, GridCellStatus>>` を保持。`normalizeCellStatus` で既知列だけを写し（consumer のオブジェクトは保持しない）、不正な level を集めて `onCellStatusInvalid` へ1回通知。`setRows` の戻り値に `cellStatusUpdated`。状態だけの変更は `view.markCellDirty()`（行 Axis は作り直さない・Undo に記録しない）
- `packages/render/src/base-layer.ts`: フック `cellStatusesInRow(rowIndex) => CellStatusMark[] | undefined`。pane ごとに可視行で印を集め（`collectPaneStatuses`・列は pane の範囲で切り分け）、行背景の後・罫線の前でセル全体の背景、値の後で罫線の内側の枠（4本の fillRect・端と太さを device px へ丸める）。状態のあるセルでは値の書式の背景（`drawCellBackground`）を塗らない
- `packages/grid/src/mount-controller.ts`:
  - 単独モードでだけフックを束縛し（`cellStatusMarksAt`。状態0件なら即 undefined）、描画のたびに RowId/ColumnId を index へ解決
  - `updateCellHover` は `cellHoverEvent` で `status` を載せ、直近に載せた状態を `hoveredStatus` に覚える。`refreshHoverStatus` は状態（level・message）が変わったときだけ `runOrDefer` で出し直す（setData 直後は構造 flush 後の矩形を使う。行が消えていれば出さない）
  - `applyStandaloneData` のアクティブセルのクランプを `clampActiveCellToDocument` へ切り出し、出し直しをクランプの**後**に呼ぶ（出し直しが構造 flush を同期で走らせうるため、クランプとの順序を従来どおりに保つ意図）
  - `onCellStatusInvalid` → `diag.emit('warn', 'cell-status-invalid', …)`
- 文書: `doc/quick-start.md`（使い方）・`CHANGELOG.md`（Unreleased の Added）・`apps/showcase/src/features.json`（column-types）

検証済み: unit 1501件・typecheck・consumer-strict・lint・E2E（新規3件＋関連既存20件）green。

## 評価基準（この観点で見てほしい）

1. **決定事項との一致**: 上記 1〜4 のとおりに動くか。特に「省略は保持・`{}` で消す・渡した行は丸ごと置き換え」、削除済み RowId・新規行への指定、`setData` での作り直し
2. **既存挙動の非破壊**: 状態を使わない画面の描画（フック未束縛の共同編集モード・状態0件の単独モード）が従来と同一か。`applyStandaloneData` の切り出しで setData 後のアクティブセルのクランプ・Undo 全消去・IME 合成中の扱い（I-3）が変わっていないか。`setRows` の Undo 記録・cell-commit が変わっていないか
3. **cell-hover の出し直し**: `refreshHoverStatus` の比較・`runOrDefer` の使い方（構造 dirty 時の同期 flush、`canRunCommandsNow` が false の間の保留、保留中にポインタが別セルへ移った場合、destroy 後）で、誤ったセル・誤った矩形・重複の `cell-hover` を出さないか。`hoveredStatus` の更新漏れで、出し直しが起きない・余計に起きる経路がないか
4. **描画の正しさ**: 枠の座標（罫線は `snapToDevice` の device px 1列を占める前提）が非整数 DPR・可変の列幅/行高・固定行列の pane 境界・pattern 罫線（`isPatternBorder`）で崩れないか。状態の背景と、値の書式の背景・バッジ・リンク・数値右寄せ・wrap・オーバーフロー（左外からの流入を含む）との合成順に穴がないか
5. **描画コスト**: 状態0件のときの追加コスト（フック呼び出し・Map 生成・配列生成）が可視行数に比例する程度に収まっているか。状態が多い行での毎フレームの割り当て
6. **型と公開面**: `exactOptionalPropertyTypes` 下で `status`/`message` のキーを `undefined` で作っていないか。JS の consumer から来る不正値（`null`・数値の message・非オブジェクト）で例外にならないか
7. **テストの効き**: `standalone-session.dd060.test.ts`・`base-layer.dd060.test.ts`・`cell-status.spec.ts` が上記を本当に検出できるか（アサーションが緩すぎないか）

## 対象外（指摘しても採用しない観点）

- 決定事項 1〜4 の設計選択そのものの当否（Human Spec Gate 済み。例: 色を設定可能にする・SDK がツールチップを描く・確定を止めるフック・行単位ではなくセル単位の差分更新）
- 共同編集モードでの状態表示（単独モード専用と決定済み）
- 命名の好み（既存コードの命名規則と整合していればよい）
- 本DDの範囲外の改善提案・既存コードの別件の不具合（見つけたら「別件」として1行で挙げるのは歓迎）
- CHANGELOG・quick-start・DD 文書の文体
