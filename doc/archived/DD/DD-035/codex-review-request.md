# DD-035 Codex レビュー依頼（列タイプ拡張と命令 API）

## 背景・目的

consumer（松下 生産納期・React `<NanairoSheetView mode="collaboration">`）が持ち越した SDK 側 4 要件を提供する。
正本: `doc/DD/DD-035_列タイプ拡張と命令API.md`（決定事項・AC）と `doc/DD/DD-035/contract.md`（公開 API 契約）。

- **R2** 日付列 `columnTypes: { type:'date', openOn? }` — カレンダーのポップオーバー（select-editor の listbox と同方式の別 DOM）。
  確定は既存 chokepoint `submitSetCells`（Undo・cell-commit・OCC は既存経路）。手入力（印字文字→textarea）は従来どおり併存。
- **R4** 列単位 readOnly `readOnlyColumns: string[]` — DD-033-1 のグリッド readOnly の 2 層抑止（入口＋chokepoint）を「アクティブセルの列」条件へ拡張。
  貼り付け・範囲クリア・cut は readOnly 列のセルだけスキップ。常駐 textarea は列に応じて `readOnly` 属性を動的同期＋編集 DOM イベント dispatch 抑止。
- **R6** `GridInstance.scrollToRow(rowId)` / `setActiveCell(rowId, columnId)` — 構造 dirty 中（setData／insertRows 直後）は保留し、次の構造 flush（scroll anchor 補正・K3 再ベース）の**後**に適用。
- **R7** React handle へ `insertRows/deleteRows/scrollToRow/setActiveCell`＋列スキーマ props 6 点（`columnTypes/columnFormats/columnCaptions/columnDisplayFormats/readOnly/readOnlyColumns`・識別系＝値変更で remount）。

## 対象差分（未コミット・`--uncommitted`）

| 領域 | ファイル |
|---|---|
| 公開面 | `packages/grid/src/index.ts`（GridInstance 2 メソッド・`readOnlyColumns`・date 型 export・JSDoc）／`packages/react/src/index.ts`（handle 4・props 6） |
| 列タイプ | `packages/grid/src/column-types.ts`（`GridDateColumnType`・registry: date/readOnly 参照・検証） |
| 配線 | `packages/grid/src/mount-controller.ts`（保留キュー／scrollToRow・setActiveCell／列 readOnly 入口＋chokepoint／date picker 配線／debug API） |
| textarea | `packages/grid/src/integration-editor.ts`（`isInputLocked` 動的ガード・`setInputLock` 属性同期。**editor-state-machine・ime-editing-session は無改変**） |
| 純関数 | `packages/grid/src/readonly-policy.ts`（SetCells フィルタ）／`packages/grid/src/date-editor.ts`（新規: LocalDate 演算・カレンダー制御・キー裁定・DOM アダプタ） |
| テスト | `packages/grid/src/{readonly-columns,date-editor}.test.ts`・`packages/react/src/nanairo-sheet-view.dd035.test.ts`・`apps/playground/e2e/{imperative-nav,react-facade-handle,readonly-columns,date-column}.spec.ts` |
| ハーネス | `apps/playground/src/integration/{standalone-main,main,react-main}.ts`・`apps/playground/e2e/react-facade-helpers.ts`・`packages/grid/src/internal.ts` |
| 記録 | `CHANGELOG.md`・`apps/showcase/src/features.json`・`tests/contract/__snapshots__/facade-surface.test.ts.snap`（追加のみ）・DD 本文・contract.md |

## 評価基準（この観点で指摘してほしい）

1. **IME 不変条件（最重要）**: 常駐 textarea の `readOnly` 属性を activeCell の列に応じて動的に切り替える（`setInputLock`・非 composing 時のみ）ことが、
   composition 中の I-3（textarea の value/selection/DOM 親を触らない）や focus 保持（I-5）を破る経路が無いか。`isInputLocked` の dispatch 抑止が
   readOnly=false・未ロック経路の挙動を変えていないか。
2. **保証層の網羅性**: 列 readOnly で「readOnly 列への文書 Operation 送信ゼロ」が構造的に成立しているか。特に (a) Undo/Redo 補償 (b) 選択式確定 (c) 日付確定
   (d) K4 draft 退避 (e) debug API `submitInsertRowsAfter` 等の行操作（列非依存＝許可で正しいか）。
3. **R6 の順序・競合**: 保留キューが masterLoop の「captureAnchor → captureRebaseState → flush → applyRebaseState → correctScroll → drain」の順で
   正しいか。K3 再ベース（`applyRebaseState` の pointerdownCell）と保留 `setActiveCell` の pointerdownCell が同一フレームで連続する場合の
   状態機械への影響（editing/composition 位相・pendingNavigation）。E2E 初回に「先頭挿入＋setActiveCell 後の印字が旧アクティブセルへ確定」が
   1 回だけ観測され再現していない（DD ログ Phase 2）。**再現しうる経路があれば最優先で指摘してほしい。**
4. **OCC・削除競合**: 日付確定（`confirmDate`）の beforeRevision 凍結・行削除時の実行前拒否が `confirmSelect` と同等か。ポップアップ表示中の
   リモート更新（同セル値変更・行削除・画面外スクロール）で不整合が残らないか。
5. **React 写像**: `mountKeyOf` の値直列化（列スキーマ 6 props）で remount が意図どおりか、`toMountOptions` の undefined 素通しが grid 側の
   現行挙動（未指定＝無効）と一致するか。handle の未 mount 時の扱い。
6. **公開契約・後方互換**: 追加のみで既存シグネチャ不変か。`ColumnTypeConfigError.reason` union 拡張・`createColumnTypeRegistry` の optional 引数追加の影響。
7. **テスト不足**: 上記 1〜4 を synthetic で検証できていない箇所。E2E の決定性（poll の使い方・フレーク要因）。

## 対象外（指摘不要）

- 仕様の妥当性そのもの（openOn の 2 値・readOnly 列のスキップ方針・setActiveCell の focus 奪取・最小スクロール）は Spec Gate で確定済み（contract.md）。
- 実 IME の Manual Gate（T1/M1）はクローズ非ブロックで別途。
- CSS・見た目（カレンダーの配色・サイズ）。
- 共同編集サーバー側の列権限（将来スコープ）。

## 出力形式

findings を P1（データ消失・不変条件違反・送信ゼロの破れ）／P2（誤動作・回帰）／P3（保守性・テスト）で分類し、
各 finding に「ファイル:行・再現手順 or 反例・推奨修正」を付けてほしい。総評は「マージ可／条件付き／要修正」の 1 行。
