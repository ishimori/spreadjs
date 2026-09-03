# DD-035 公開 API 契約（R2/R4/R6/R7 ＋ React 写像）

> 本DDで確定した公開面の正本（DD本文「決定事項」から参照）。実装の JSDoc（`packages/grid/src/index.ts`・`packages/react/src/index.ts`）と
> 公開 .d.ts snapshot（`tests/contract/__snapshots__/facade-surface.test.ts.snap`）が機械的な写し。乖離したら本ファイルを直す。
> すべて Experimental 0.x・**追加のみ**（既存シグネチャの変更・削除なし）。

## 1. R2 日付列（`columnTypes` の `date` 種）

```ts
interface GridDateColumnType {
  readonly type: 'date';
  /** カレンダーを開く操作。既定 'dblclick'。 */
  readonly openOn?: 'dblclick' | 'icon';
}
type GridColumnType = GridSelectColumnType | GridLinkColumnType | GridDateColumnType;
```

| 項目 | 契約 |
|---|---|
| 開き方 `'dblclick'`（既定） | ダブルクリック／F2／Enter（修飾なし）／Alt+↓／セル右端の 📅 アイコンクリック でカレンダーが開く。**印字文字キーは従来どおり textarea 手入力を開始**（手入力併存） |
| 開き方 `'icon'` | 📅 アイコンクリック／Alt+↓ のみ。ダブルクリック・F2・Enter は従来どおり textarea 編集（既存値の部分修正を優先する列向け） |
| 表示中の操作 | ←→↑↓=日移動・PageUp/PageDown=月移動・Enter=確定・Esc/Tab=取消・「今日」「クリア」ボタン・日クリック=確定。他キーは握り潰す（textarea へ漏らさない）。日/月移動は 0001〜9999 年の範囲内のみ（範囲外へ出る移動は no-op・Codex P2） |
| 初期表示 | セル値が LocalDate 正準（`YYYY-MM-DD`）ならその月・その日をハイライト、それ以外（空・非日付文字列）は今日（ブラウザのローカル日付） |
| 確定値 | `YYYY-MM-DD`（ADR-0012 LocalDate 正準値・`kind:'date'`）。「クリア」は blank。既存の確定 chokepoint（`submitSetCells`）へ流す＝Undo 記録・cell-commit 通知・OCC（開いた時点で beforeRevision 凍結）が既存経路で成立 |
| 閉じる条件 | 確定／取消／外クリック／textarea blur／composition 開始・非 Navigation 遷移／対象セル消失（診断 `date-target-removed`）／画面外スクロール |
| 手入力 | 無改変（`2026/7/31` → `2026-07-31` 正準化は core `parseCellInput` のまま）。**日付列でも非日付文字列の手入力は拒否しない**（link 列と同じく型は「編集 UI の選択」であって入力規則ではない・拡張点として `strict` を将来検討） |
| 表示書式 | `columnDisplayFormats`（DD-033-2・date pattern）を併用する（列タイプは描画に関与しない） |
| 併用 | wrap 列・columnFormats・columnDisplayFormats と併用可。同一列に select/link と同居は不可（Record の型で排他） |
| readOnly | グリッド readOnly・列 readOnly（R4）の列では開かない（アイコンも出さない） |
| IME 不変条件 | editor-state-machine・ime-editing-session 無改変。カレンダーは常駐 textarea と別 DOM（listbox と同方式）。focus は textarea のまま（pointerdown preventDefault） |
| 不正設定 | 未知列・不正 `openOn` は mount 時 `error`（phase=config・code=`column-types-invalid`）で fail-fast（select/link と同経路） |

## 2. R4 列単位 readOnly（`readOnlyColumns`）

```ts
interface GridCommonMountOptions {
  /** 読み取り専用列（ColumnId 文字列の配列）。両モード共通・mount 時固定。 */
  readonly readOnlyColumns?: readonly string[];
}
```

| 項目 | 契約 |
|---|---|
| 抑止（入口） | 指定列のセルで 編集開始（印字キー・F2・ダブルクリック・IME）／Delete・Backspace クリア／選択式ドロップダウン／日付カレンダー を開かない（明示レンジありの Delete は範囲クリア＝下記スキップ規則へ流す・Codex P2）。常駐 textarea はアクティブセルが指定列にある間 `readOnly` 属性（実 IME 物理遮断）＋ input/composition dispatch 抑止（synthetic 論理遮断）＝DD-033-1 と同じ 2 経路 |
| 範囲操作 | 範囲貼り付け・範囲クリア（Delete）・cut のクリアは**指定列のセルだけスキップ**し他列へ適用する（TSV の列位置はずらさない）。全セルがスキップなら no-op。スキップ発生時は診断 info `readonly-column-skipped`（件数付き） |
| 保証層（chokepoint） | `submitSetCells`／`submitToBackend` で指定列への変更を含む SetCells は **op 全体を破棄**（診断 warn `readonly-column-blocked`）。入口をすり抜ける将来の編集経路でも指定列への文書 Operation 送信ゼロ |
| 維持 | 範囲選択・コピー・スクロール・リサイズ・link-open・行挿入削除（行操作は列非依存）・setData・リモート受信反映・サーバー起点操作（U3） |
| 診断 | 抑止ごとに info `readonly-column-blocked`。公開 error/conflict code の追加なし（DD-033-1 と同方針） |
| 権限 | **権限制御ではない**（サーバー側強制なし・共同編集の列権限は将来スコープ＝要件メモ R4 のとおり本DD対象外） |
| 不正設定 | 未知列・重複は mount 時 `column-types-invalid` で fail-fast。`readOnly:true` との併用は冗長だが許可（グリッド readOnly が優先） |

## 3. R6 命令 API（GridInstance）

```ts
interface GridInstance {
  /** 指定行が可視域に無ければ最小スクロールで可視化する（Excel の scroll-follow と同じ）。 */
  scrollToRow(rowId: string): void;
  /** アクティブセルを移動し可視化する（クリックと同経路＝編集中なら確定して移動・グリッドへ focus）。 */
  setActiveCell(rowId: string, columnId: string): void;
}
```

| 項目 | 契約 |
|---|---|
| 解決 | RowId/ColumnId 文字列 → 現在の表示 index。未知（tombstone・未知列）は診断 warn（`scroll-row-unknown`／`active-cell-unknown`）で no-op（同期 throw しない・公開 rejected は出さない＝文書 Operation ではない） |
| タイミング | 構造 dirty（`setData`／行挿入削除の直後で Axis 未再構築）のときは**その場で構造 flush（scroll anchor 補正・K3 再ベース）を同期実行してから適用**する（Codex P1: 次 rAF まで保留すると直後の打鍵が旧セルへ確定する）。boot 未完了・初回描画前だけは保留し初回描画後に適用（保留中は入力を遮断・上限 64）。`setData(...)` → 直後の `scrollToRow(newId)` が同期で成立する（松下 DD-012-1 の実測課題の回答） |
| setActiveCell の副作用 | `pointerdownCell` と同経路: 明示レンジ解除・編集中なら確定して移動・composition 中は pendingNavigation・常駐 textarea へ focus（利用側がボタン起点で「追加行へ入力開始」できる）。開いている選択式/日付ポップアップは閉じる |
| 両モード | standalone／collaboration とも同一。共同編集の受信反映後（リモート挿入行）にも rowId で解決できる |
| readOnly | 閲覧系ゆえ readOnly でも動く |

## 4. R7 React handle（`NanairoSheetViewHandle`）

```ts
interface NanairoSheetViewHandle {
  setData(data: GridStandaloneData): void;
  focus(): void;
  connectionState(): GridConnectionState;
  // DD-035 追加（すべて GridInstance 直結・未 mount 時は診断 warn `handle-before-mount` で無視）
  insertRows(options: { readonly afterRowId: string | null; readonly count?: number }): void;
  deleteRows(rowIds: readonly string[]): void;
  scrollToRow(rowId: string): void;
  setActiveCell(rowId: string, columnId: string): void;
}
```

## 5. React props（列スキーマ系の写像＝R2/R4 を React consumer から使うための前提）

`NanairoSheetViewCommonProps` へ以下を追加する（いずれも grid の同名 mount オプションへ 1:1 写像・**識別系＝mount 固定・変更で自動 remount**）:
`columnTypes` / `columnFormats` / `columnCaptions` / `columnDisplayFormats` / `readOnly` / `readOnlyColumns`。
mountKey は値で直列化する（毎 render の新規リテラルで remount しない・`wrapColumns` と同じ）。Record 系はキー順に依存しない正準化・`readOnlyColumns` は集合（並び順非依存）、select の候補順・`columnOrder`・`wrapColumns` は順序を保つ（Codex P2）。

> 背景: 起票時の実調査で、React Facade は DD-027/033 の列スキーマ系オプションを一切写像していなかった（松下は `<NanairoSheetView mode="collaboration">` を使用）。
> これを埋めないと R2/R4 は consumer から到達不能になるため本DDのスコープに含める（薄い写像＝契約 §1 の範囲内・新概念なし）。

## 6. 診断コード（onDiagnostic・公開 error/conflict code ではない）

| code | level | 発生 |
|---|---|---|
| `readonly-column-blocked` | info（chokepoint 到達時は warn） | 列 readOnly の入口抑止／保証層破棄 |
| `readonly-column-skipped` | info | 貼り付け・範囲クリア・cut で列 readOnly セルをスキップ（`skipped=N`） |
| `date-open` / `date-target-removed` | info / warn | カレンダー開閉・対象セル消失で閉じた |
| `scroll-row-unknown` / `active-cell-unknown` | warn | R6 の未知 RowId/ColumnId |
| `handle-before-mount` | warn（React Facade） | 既存。R7 追加メソッドも同コードで統一 |
