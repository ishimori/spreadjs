# DD-070-5: 表のデータを読む API

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-11-20 | 2026-11-20 | 進行中 | 親=DD-070（第5子） |

> アプローチ: TDD（読み取りは純粋関数で固め、結線は E2E で確かめる）
> リスク: なし（認可・DBスキーマ・外部I/F・機密情報に触れない）

```text
Risk Class: B（読むだけの公開命令を 1 つ足す。文書・入力の経路は変えない）
Risk Triggers: 公開 API の追加
Human Spec Gate: passed（親 DD-070 の決定事項。細目は推奨案）
Codex: high（実装後 1 回）
Manual Gate: なし
External Review: なし
Evidence Level: minimal
```

## 目的

consumer が表の今のデータを読めるようにする。共同編集モードでは画面側の consumer が表のデータを持っていないため、並べ替えの比べ方・絞り込みの候補・CSV の書き出しを consumer が作るのに要る（両モード共通）。

## 背景・課題

- 共同編集モードの consumer は、開いたときのデータ（snapshot）を受け取らず（`remote-change` は開いた後の確定だけ）、表のデータを読む手段が無い
- 単独モードでも、SDK の文書（自分の確定を含む）が一番新しい。consumer の手元のデータは `cell-commit` の反映が遅れうる

## 決定事項

- 2026-11-20（親 DD-070・推奨案で確定）:
  1. 命令 `GridInstance.getRows(options?)` → `readonly GridRowData[]`（`{ rowId, cells }`。`cells` は ColumnId → 表示文字列で、空のセルは載せない＝`setData` の行と同じ形・同じ文字列。数値は桁区切りなしの正準形・日付は `YYYY-MM-DD`）
  2. 行は文書の並び（削除した行は含めない）で全部。後の DD-070-8 で画面だけの並べ替え・絞り込みを足しても、`getRows` は隠れた行も含めて文書の並びで返す（絞り込みを掛け直すための元データ。画面の並びは別の命令で返す）
  3. `options.columnIds` で読む列を絞れる（並べ替えのキーの列だけなど。未知の列は無視）。`options.rowIds` で読む行を絞れる（並びは文書の並び。未知・削除済みは無視）
  4. 値は自分の未確定の変更を含む今の値（画面に描いているのと同じ view）。編集中のセルの下書き（textarea の中）は含めない
  5. boot 前・destroy 後は `[]`。同期で返す（呼んだ処理の中で `setData` の直後に読めば新しい行）。React の ref handle にも出す
  6. 大きい表（180 列 × 数万行）では全部を読むと重い（文字列を全部作る）。CHANGELOG・quick-start に「並べ替え・絞り込みには `columnIds` で必要な列だけ読む」を書く

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | `getRows()` が文書の並びの全部の行を `{ rowId, cells }`（空のセルは無し）で返し、`setData` に渡すと同じ表になる | 単体（`mount/read-rows.test.ts`）・E2E |
| 2 | `columnIds`・`rowIds` で絞れる。未知は無視 | 単体 |
| 3 | 確定した直後・`setData` の直後に同じ処理の中で読むと新しい値・新しい行 | E2E |
| 4 | 共同編集モードで、他の参加者の確定も読める | E2E（統合サーバー） |
| 5 | 公開型・React・CHANGELOG・quick-start がそろう | typecheck・`npm test` |

## タスク一覧

### Phase 1: 実装と検証
- [x] `packages/grid/src/mount/read-rows.ts`（新規）: 文書から行を読む純粋関数
- [x] `packages/grid/src/index.ts`・`mount-controller.ts`: 公開型 `GridRowData`・`GridReadRowsOptions` と `getRows`
- [x] `packages/react/src/index.ts`: ref handle の `getRows`
- [x] 🔬 単体: `npx vitest run packages/grid/src/mount/read-rows.test.ts` → 成功
- [x] 🔬 E2E: `npx playwright test --config apps/playground/playwright.config.ts read-rows` → 成功

### 完了前チェック
- [ ] 受け入れ基準を1項目ずつ照合
- [x] 📄 quick-start・CHANGELOG（Unreleased）・features.json（`collab`）
- [ ] 😈 セルフレビュー1巡
- [ ] 🔬 全回帰1回

## ログ

### 2026-11-20
- 起票（親 DD-070 の子DD 5）。決定事項は推奨案で確定
- 実装: `mount/read-rows.ts`（文書から文書の並びで読む純粋関数・空の行は列を走査しない）と `GridInstance.getRows`（`session.viewDocument` を読む）。React の ref handle にも
- テスト: 単体 4 件（`read-rows.test.ts`）・E2E 2 件（`read-rows.spec.ts`。単独モードの確定・setData の直後・round-trip、共同編集モードで他の参加者の確定）が成功
