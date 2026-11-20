# DD-070-3: 下方向・右方向へのコピー（Ctrl+D・Ctrl+R）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-11-20 | 2026-11-20 | 完了 | Ctrl+D・Ctrl+R を貼り付けと同じ経路で追加。Codex high の 5 件（P1×1・P2×3・P3×1）を直した。配布は親 DD-070 でまとめて |

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
- [x] 受け入れ基準を1項目ずつ照合
- [x] 📄 quick-start・CHANGELOG（Unreleased）・features.json
- [x] 😈 セルフレビュー1巡
- [x] 🔬 全回帰1回

## 検証（2026-11-20）

| AC | 結果 | 根拠 |
|---|---|---|
| 1 | 達成 | 単体（`fillRanges`・`buildFill`）・E2E（範囲の Ctrl+D・1 セルの Ctrl+D／Ctrl+R・先頭の行は何もしない・選択の矩形が保たれる） |
| 2 | 達成 | E2E（読むだけの列を飛ばして `cells-skipped`〔fill〕・`validateCell` の拒否で検証を通る写す先も書かない・Ctrl+Z の 1 回で戻る） |
| 3 | 達成 | 単体（キーの判定・段の順）・E2E（編集中・検索欄で既定を止め、文書と検索文字を変えない。headless は Ctrl+R で再読み込みしないため `defaultPrevented` で確かめる） |
| 4 | 達成 | E2E（表全体が readOnly で `edit-blocked`〔fill〕） |
| 5 | 達成 | union の拡張・CHANGELOG（Unreleased）・quick-start・features.json（`clipboard`） |

## 既知の未保証境界

- ドラッグのフィルハンドル・連続データ（1, 2, 3…）の作成は無い（親 DD-070 の決定で後回し）
- 実ブラウザー（headed）で Ctrl+D のブックマーク・Ctrl+R の再読み込みが起きないことは確かめていない（headless では既定の動きが起きないため、`defaultPrevented` だけを確かめた）
- 共同編集モードの E2E は足していない（書き込みは貼り付けと同じ共通の経路）

## ログ

### 2026-11-20
- 起票（親 DD-070 の子DD 3）。決定事項は推奨案で確定
- 実装: 写す元と先の決定・SetCells の組み立て・キーの判定を `fill-ops.ts`（純粋関数）に置き、`mount/edit-commands.ts` の `performFill` が貼り付けと同じ経路（`filterReadOnlyCells`・`rejectInvalidCells`・`submitSetCells`・`editBlocked.skipped`）で書く。キーは `mount/keyboard.ts` の段 `fill`（Undo の次）
- テスト: 単体（`fill-ops.test.ts` 11 件・`keyboard.test.ts` の段の順と fill の段 1 件）・E2E `fill-keys.spec.ts` 6 件が成功。headless の Chromium は Ctrl+R で再読み込みしない（確かめた）ため、編集中に既定を止めたことは keydown の `defaultPrevented` で確かめる
- 機械検証: typecheck・consumer-strict・lint（boundary・size）・test（全件）・build が成功。公開 .d.ts の snapshot は union への `'fill'` の追加と JSDoc だけを確かめて更新
- 実装をコミット（e6a4855）し、Codex high にレビューを依頼（`DD-070-3/codex-review-result.md`）
- Codex の指摘（5 件・すべて妥当と判断して採用）:
  1. P1: 写す元を生の値のポートで読んでいたため、結合範囲の左上以外の画面に出ていない値を写した → コピーと同じポート（左上以外は空）で読む。単体・E2E を足した
  2. P2: 同じ値かを表示文字列で比べていた（`stringColumns` の "007" と数値 7 を別とみなす・文字列 "7" と数値 7 を同じとみなす）→ 写す先の列の設定で型変換した値と、写す先の view の型つきの値を比べる。単体を足した
  3. P2: 検索つき候補欄の検索欄に焦点があると、keydown が常駐 textarea の段に届かず Ctrl+R で再読み込みできた → 検索欄でも Ctrl+D・Ctrl+R の既定だけを止める（写さない・検索文字を変えない）。playground に検索つきの列の指定（`!search`）を足して E2E
  4. P2: 全体拒否の E2E が部分適用でも通った → 検証を通る写す先（col-d）も書かないこと・`cell-commit` が増えないことを確かめる
  5. P3: 選択を保つ E2E がアクティブセルしか見ていなかった → 矩形も確かめる
  - 指摘とは別に、写す前に開いている候補欄・カレンダーを閉じるようにした（値を変えたセルの上で候補欄が古い表示のまま残らないように）
- 修正をコミット（35e98d7）。DD-070-4 の作業中の変更を退避して、この子DDだけの状態で typecheck・lint（boundary・size）・test（1,765 件）が成功。E2E は fill-keys 8 件・column-types-select・number-column（作業ツリー）が成功
- 製品化6観点: ①公開 API は union の拡張のみ（`'fill'`）②Facade の境界: 変更なし ③再利用性: Excel と同じ汎用の操作 ④拡張性: なし ⑤DX: quick-start・CHANGELOG ⑥互換性: union の拡張とキーの既定の変化（Ctrl+D・Ctrl+R）を CHANGELOG の Changed に記録
- 完了。アーカイブ（DD 本体と `DD-070-3/` を移す・DD-INDEX・DOC-MAP）
