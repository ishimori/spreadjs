# DD-045 公開 API 契約（行単位の静的背景色）

> DD-036 C2（列単位の静的背景色）と C3（RowId 契約）を行方向へ合成する。
> Experimental 0.x（ADR-0015）。すべて **view-local**（文書状態・protocol・snapshot・hash・コピー TSV は不変）。

## 1. 公開 API

```ts
interface GridCommonMountOptions {
  /** RowId → CSS color（値によらない行全体の背景色）。 */
  readonly rowBackgrounds?: Readonly<Record<string, string>>;
}

interface NanairoSheetViewCommonProps {
  /** grid の rowBackgrounds へ 1:1 写像する。 */
  readonly rowBackgrounds?: Readonly<Record<string, string>>;
}
```

- 両モード共通・mount 時固定。React Facade では識別系 props とし、キー順を正準化した値が変わったときだけ remount する。
- 未指定または空オブジェクトなら行背景の解決・描画経路を束縛せず、DD-045 以前の描画と完全に一致させる。

## 2. 描画と優先順位

- **空セルも塗る**。pane 内の指定行を可視列範囲いっぱいの横バンドとして、1 行につき 1 回描く。
- 描画順は「pane 背景 → 静的列背景 → **静的行背景** → 罫線 → セル値（値ベース背景 → 文字）」とする。
  - 行背景と `columnBackgrounds` が交差したセルは **行背景が勝つ**。結論行などの横帯を途切れさせない。
  - `columnFormats` の値ベース背景が解決された非空セルは **値ベースが勝つ**。列/行の静的背景で同じ合成規則を使う。
  - 罫線・選択・Presence・編集インジケーター等のオーバーレイは従来どおり上に乗る。
- 固定 pane も塗る。`frozenBackground` より行背景を優先し、固定列境界の左右で同じ色にする。
- 横スクロール後も各 pane の可視列範囲を塗り直し、帯を切らさない。

## 3. RowId 契約

- 指定キーは行 index ではなく RowId。描画時に `rowIndex → 現在の RowId → 色` を解決するため、行挿入・削除後も同じ行実体へ追従する。
- 行は初期データ到着前に全 ID を検証できない。未知 RowId は mount を失敗させず、初回描画後に診断 warn
  `row-background-unknown` を 1 回だけ出す。後から同じ RowId が現れれば、その時点から背景色を適用する。
- 重複指定は Record の最終値へ正規化されるため無害。実行時に警告を繰り返さない。

## 4. 不正設定

- 空文字・空白のみの色は構成ミスとして mount 時に fail-fast する。公開 error は既存経路の
  `phase='config'` / `code='column-types-invalid'` を使い、新しい公開エラーコードは追加しない。
- CSS color 文字列そのものの妥当性は検査しない（`columnBackgrounds` / `columnFormats` と同じ）。Canvas が不正値を無視しても
  直前行の色が漏れないよう、行バンドごとに pane 背景へ `fillStyle` を戻してから候補色を設定する。

## 5. 非機能・非スコープ

- 背景色は文書 Operation、永続化、共同編集 protocol、snapshot、hash、セル値、`cell-commit`、コピー TSV を変更しない。
- 指定行が無いフレームは追加描画ゼロ。指定行が可視なら 4 pane 合計でも O（可視指定行数）の `fillRect` に閉じる。
- 実行時 setter、セル単位背景、背景色の共同編集共有、サーバー側強制は追加しない。

