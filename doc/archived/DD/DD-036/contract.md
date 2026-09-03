# DD-036 公開 API 契約（固定列・列背景・行 readOnly・scrollToColumn）

> 決定事項の詳細正本。DD 本文「決定事項」の①〜⑥を実装可能な粒度まで落とす（DD-035/contract.md と同形式）。
> Experimental 0.x（ADR-0015）。すべて **view-local**（文書状態・protocol・snapshot・hash は不変）。

## 1. C1 固定行列数（`frozenRowCount` / `frozenColumnCount`）

```ts
interface GridCommonMountOptions {
  /** 固定行数（先頭 n 行。既定 1）。 */
  readonly frozenRowCount?: number;
  /** 固定列数（先頭 n 列。既定 1）。 */
  readonly frozenColumnCount?: number;
}
```

- **既定は現行値 1／1**（未指定なら現行と完全一致・後方互換）。`0` を渡せば固定なしにできる。
- **受理形**: 0 以上の有限整数。非整数・負・NaN・非 number は診断 warn（code=`frozen-count-invalid`）を出して**既定 1 へ倒す**（mount は成功する＝構成不整合ではないため fail-fast しない＝`readOnly` の boolean 検証と同方針）。
- **行数・列数超過**: `ViewportTransform` が `Math.min(count)` で自クランプする（全行/全列が固定＝スクロール領域が空になるだけ）。mount は成功し追加の診断も出さない。
- **view-local**: 文書状態にしない。設定が異なるクライアントは異なる見え方をする（`cell-format-sharing-design.md` の共有化スコープへ）。
- **mount 時固定**（実行時切替は対象外）。React では識別系 props＝値変更で remount。

## 2. C2 列単位の静的背景色（`columnBackgrounds`）

```ts
interface GridCommonMountOptions {
  /** 列 ID → CSS color（値によらない列全体の背景色）。 */
  readonly columnBackgrounds?: Readonly<Record<string, string>>;
}
```

- **空セルも塗る**（`columnFormats` は非空セルのみ＝別経路）。描画順は「pane 背景 → **静的列背景バンド** → 罫線 → セル値（値ベース書式の背景 → 文字）」。
  罫線・選択・Presence・カレンダー等のオーバーレイは従来どおり上に乗る。
- **優先順位**: 同一セルに `columnFormats` の値ベース背景が解決されたら**値ベースが勝つ**（後から上塗り）。値ベース書式が無いセル（空セル・非一致値）は静的列色のまま。
- **固定 pane も塗る**（`frozenBackground` より優先＝固定列にも網掛けを付けられる）。
- **不正設定は mount 時 fail-fast**（`error` phase=`config`・code=`column-types-invalid`＝既存 code を流用）:
  未知列（`columnOrder` に無い）／空文字・空白のみの色。色文字列そのものの妥当性は検査しない（Canvas `fillStyle` は不正値を無視＝安全・`columnFormats` と同方針）。
- **view-local**・mount 時固定。React では識別系 props。

## 3. C3 行単位 readOnly（`readOnlyRows`）

```ts
interface GridCommonMountOptions {
  /** 読み取り専用行（RowId 文字列の配列）。 */
  readonly readOnlyRows?: readonly string[];
}
```

`readOnlyColumns`（DD-035 R4）と**同じ 2 層抑止＋範囲スキップ**を行方向へ適用する。列と行の**両方**が指定されていれば和（どちらかに該当するセルが readOnly）。

- **抑止（入口）**: 対象行のセルがアクティブな間、編集開始（印字キー・F2・ダブルクリック・IME）／Delete・Backspace クリア／選択式ドロップダウン／日付カレンダーを開かない。常駐 textarea は `readOnly` 属性になる（実 IME を物理遮断）＝DD-035 R4 の列ロックと同じ機構（`isInputLocked` / `setInputLock` の判定条件に行を足すだけ・**`integration-editor.ts` は無改変**）。
- **範囲操作**: 範囲貼り付け・範囲クリア（Delete）・cut のクリアは対象行のセルだけ**スキップ**して他行へ適用（TSV の行位置はずらさない・全セルスキップなら no-op）。診断 info `readonly-row-skipped`。
  明示レンジのある Delete は列版と同じく裁定を通さず範囲クリアへ流す（readOnly 行アンカーからでも他行はクリアされる＝DD-035 Codex P2 と同型）。
- **保証層（chokepoint）**: 対象行への変更を含む SetCells は `submitSetCells`（undo 記録前）と `submitToBackend`（絶対防衛線・Undo/Redo 補償を含む）で op 全体を破棄する。診断 warn `readonly-row-blocked`。
- **維持**: 範囲選択・コピー・スクロール・リサイズ・link-open・**行挿入削除**・`setData`・リモート受信反映・サーバー起点操作。
- **未知 rowId は診断 warn のみ**（code=`readonly-row-unknown`）。列（`columnOrder` で mount 時に全 ID 既知）と違い行は初期データ到着前に検証できないため fail-fast しない。判定は**初回描画の直後に 1 回だけ**行う（それ以降の行削除・tombstone は警告しない＝実行時に警告を出し続けない）。
- **重複指定**は無害（集合として扱う・fail-fast しない＝列版の `readonly-duplicate-column` とは分ける）。
- **権限制御ではない**（サーバー側強制なし＝`readOnly` / `readOnlyColumns` と同じ）。
- **mount 時固定**。行の動的化（`setReadOnlyRows` / `setData` 同梱）は要求が出たときの拡張点。

## 4. C4 `scrollToColumn`

```ts
interface GridInstance {
  /** 指定列を可視域へ（最小スクロール・縦は動かさない）。未知 ColumnId は診断 warn のみ。 */
  scrollToColumn(columnId: string): void;
}
```

- `scrollToRow` の鏡像。**縦スクロールは動かさない**（`ensureCellVisible` に軸指定を追加し、`scrollToRow`＝`'vertical'`・`scrollToColumn`＝`'horizontal'` を明示する。従来の `col: 0` 依存＝「index 0 は固定列」という暗黙前提を廃止し、`frozenColumnCount: 0` でも成立させる）。
- **最小スクロール**（可視なら動かさない）。固定列（index < 固定列数）は常に可視のため無変更。
- 構造 dirty 中（`setData` / 行挿入削除の直後）は DD-035 R6 の保留・同期 flush 機構をそのまま共有する（呼び出しから戻った時点で適用済み）。
- 未知 ColumnId は診断 warn（code=`scroll-column-unknown`）のみで no-op。
- React handle `scrollToColumn(columnId)` を追加（未 mount 時は warn して無視＝他 handle と同じ）。

## 5. React props / handle（写像）

| grid mount option | React props | 分類 |
|---|---|---|
| `frozenRowCount` | `frozenRowCount` | 識別系（値変更で remount） |
| `frozenColumnCount` | `frozenColumnCount` | 識別系 |
| `columnBackgrounds` | `columnBackgrounds` | 識別系（Record＝キー順非依存の正準直列化） |
| `readOnlyRows` | `readOnlyRows` | 識別系（集合＝ソートして直列化） |
| `GridInstance.scrollToColumn` | `handle.scrollToColumn` | 命令 API |

## 6. 追加しないもの

- 公開 `GridErrorCode` / `GridConflictCode` は追加しない（不正設定は既存 `column-types-invalid`）。
- 固定行列・列背景・行 readOnly の**文書状態化・共有**（`cell-format-sharing-design.md` のスコープ）。
- `scrollToColumn` の align 指定（先頭/中央寄せ）＝最小スクロールのみ。
- 行 readOnly のサーバー側強制（共同編集の行権限）。
