# DD-070-3: 下方向・右方向へのコピー（Ctrl+D・Ctrl+R）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-11-20 | 2026-11-20 | 進行中 | 親=DD-070（第3子） |

> アプローチ: TDD（どのセルから・どのセルへ写すかは純粋関数で固め、キーと結線は単体と E2E で確かめる）
> リスク: なし（認可・DBスキーマ・外部I/F・機密情報に触れない）

```text
Risk Class: B（キーの裁定に段を 1 つ足し、書き込みは貼り付けと同じ経路〔読むだけのセルを飛ばす・validateCell・Undo・OCC〕に乗せる）
Risk Triggers: 入力の経路（キー）。公開イベントの union の拡張（'fill'）
Human Spec Gate: passed（親 DD-070 の決定事項。細目は推奨案で確定・下の決定事項）
Codex: high（実装後 1 回）
Manual Gate: なし
External Review: なし
Evidence Level: standard
```

## 目的

Excel と同じ Ctrl+D（上のセルを下へ写す）と Ctrl+R（左のセルを右へ写す）で、登録画面の連続入力を速くする。

## 背景・課題

- consumer の依頼 #7（フィルハンドル／Ctrl+D）。ドラッグのフィルハンドルは後回し（親の決定）で、この子DDはキーの 2 つだけ
- ブラウザーでは Ctrl+D がブックマーク、Ctrl+R が再読み込み。グリッドに入力の焦点がある間に押すと、入力中の内容を失う（再読み込み）

## 決定事項

- 2026-11-20（親 DD-070・推奨案で確定）:
  1. Ctrl+D: 選択範囲が 2 行以上なら、各列で範囲の一番上のセルを残りの行へ写す。1 行（1 セルを含む）なら、すぐ上の行のセルを範囲へ写す（先頭の行なら何もしない）。Ctrl+R は同じことを列の向きで行う（2 列以上なら一番左の列を右へ、1 列なら左の列から）。結合の左上だけを選んでいるときは結合全体を範囲とみなす（貼り付けと同じ `selectedRange`）
  2. 写す値はセルの表示文字列を貼り付けと同じ型変換に通したもの（`stringColumns` は文字列のまま）＝コピーして貼り付けたのと同じ結果。写す先の値が同じセルは書かない（変わるセルが無ければ何もしない）。空のセルを写すと写す先は空になる
  3. 書き込みは貼り付けと同じ経路: 読むだけのセル・結合範囲は飛ばして `cells-skipped`（`operation: 'fill'`）、`validateCell` は 1 件でも拒否すれば全体を拒否（`cell-invalid` の `source: 'fill'`）、Undo は 1 回で戻る、共同編集は 1 つの SetCells（OCC）。上限（10 万セル）を超える範囲は実行前に拒否（`range-too-large`）。選択は動かさない
  4. 表全体が `readOnly` のときは書かずに `edit-blocked`（`input: 'fill'`）
  5. キーを裁くのは Navigation の位相で変換中でないときだけ。編集中（Editing）に押した Ctrl+D・Ctrl+R は何もせず、ブラウザーの既定（ブックマーク・再読み込み）も止める。変換中は触らない（IME の経路を変えない）。Shift・Alt つきは裁かない
  6. union の拡張: `GridEditBlockedInput` に `'fill'`、`cells-skipped` の `operation` と `cell-invalid` の `source` に `'fill'`

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | 2 行以上を選んで Ctrl+D → 各列の一番上の値が下の行へ入る。1 セルで Ctrl+D → 上のセルの値が入る。Ctrl+R も同様（列の向き） | 単体（`fill-ops.test.ts`）・E2E（`fill-keys.spec.ts`） |
| 2 | 読むだけのセルは飛ばして `cells-skipped`、`validateCell` の拒否で全体が入らない、Ctrl+Z で 1 回で戻る | 単体・E2E |
| 3 | 編集中の Ctrl+D・Ctrl+R はブラウザーの既定を止め、文書を変えない。変換中は裁かない | 単体（キーの判定）・E2E |
| 4 | 表全体が readOnly なら `edit-blocked`（`fill`）で文書は変わらない | E2E |
| 5 | 公開型・CHANGELOG・quick-start・features.json がそろう | typecheck・`npm test` |

## タスク一覧

### Phase 1: 実装と検証
- [ ] `packages/grid/src/fill-ops.ts`（新規）: 写す元と先の範囲の決定（`fillRanges`）と SetCells の組み立て（`buildFill`）、キーの判定（`decideFillKey`）
- [ ] `packages/grid/src/mount/edit-commands.ts`: `performFill(direction)`（readOnly・上限・読むだけのセル・validateCell・submit・通知）
- [ ] `packages/grid/src/mount/keyboard.ts`: 段 `fill`（Undo の次）
- [ ] 公開型の union の拡張（`index.ts`・`mount/constants.ts`・`mount/edit-blocked.ts`）
- [ ] 🔬 単体: `npx vitest run packages/grid/src/fill-ops.test.ts packages/grid/src/mount/keyboard.test.ts` → 成功
- [ ] 🔬 E2E: `npx playwright test --config apps/playground/playwright.config.ts fill-keys` → 成功

### 完了前チェック
- [ ] 受け入れ基準を1項目ずつ照合
- [x] 📄 quick-start・CHANGELOG（Unreleased）・features.json
- [ ] 😈 セルフレビュー1巡
- [ ] 🔬 全回帰1回

## ログ

### 2026-11-20
- 起票（親 DD-070 の子DD 3）。決定事項は推奨案で確定
- 実装: 写す元と先の決定・SetCells の組み立て・キーの判定を `fill-ops.ts`（純粋関数）に置き、`mount/edit-commands.ts` の `performFill` が貼り付けと同じ経路（`filterReadOnlyCells`・`rejectInvalidCells`・`submitSetCells`・`editBlocked.skipped`）で書く。キーは `mount/keyboard.ts` の段 `fill`（Undo の次）
- テスト: 単体（`fill-ops.test.ts` 11 件・`keyboard.test.ts` の段の順と fill の段 1 件）・E2E `fill-keys.spec.ts` 6 件が成功。headless の Chromium は Ctrl+R で再読み込みしない（確かめた）ため、編集中に既定を止めたことは keydown の `defaultPrevented` で確かめる
- 機械検証: typecheck・consumer-strict・lint（boundary・size）・test（全件）・build が成功。公開 .d.ts の snapshot は union への `'fill'` の追加と JSDoc だけを確かめて更新
