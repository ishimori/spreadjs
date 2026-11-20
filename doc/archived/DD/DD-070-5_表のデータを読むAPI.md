# DD-070-5: 表のデータを読む API

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-11-20 | 2026-11-20 | 完了 | getRows を追加（両モード・React）。Codex high の 8 件（P2×6・P3×2）に対応（指数表記の修正・rejected の時点・初回同期前は空を含む）。配布は親 DD-070 でまとめて |

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
- [x] 受け入れ基準を1項目ずつ照合
- [x] 📄 quick-start・CHANGELOG（Unreleased）・features.json（`collab`）
- [x] 😈 セルフレビュー1巡
- [x] 🔬 全回帰1回

## 検証（2026-11-20）

| AC | 結果 | 根拠 |
|---|---|---|
| 1 | 達成 | 単体（文書の並び・空のセルは無し・数値と日付の形・削除した行は無し・`__proto__` の列）・E2E（単独モードで全部の行・`setData` に戻すと同じ値） |
| 2 | 達成 | 単体（`columnIds`・`rowIds`・未知は無視・文字列でない ID は無視・配列でなければ空） |
| 3 | 達成 | E2E（確定の直後・`setData` の直後に同じ処理の中で読むと新しい値と行） |
| 4 | 達成 | E2E（共同編集モードで他の参加者の確定を読める）・単体（自分の未確定の変更を含む view を読む・初回の状態を受け取る前は空・collab の `hasInitialState` と `rejected` の時点） |
| 5 | 達成 | 公開型 2 つ・`getRows`・React の ref handle・CHANGELOG・quick-start・features.json（`collab`） |

## 既知の未保証境界

- 返すのは行 ID とセルの値だけ（行データの `readOnlyColumns`・`cellStatus`・`cellBackgrounds` は含まない）。`setData` に戻すときは consumer が合成する
- 180 列 × 数万行を全部読むと重い（全部のセルの文字列を作る）。必要な列だけを `columnIds` で読む
- 共同編集モードで、自分の未確定の変更が読めることは単体で確かめた（E2E で送信を止めた状態は作っていない）
- E2E の `undo-redo-collab.spec.ts` の UE-8 は `clipboard.spec.ts` の後に続けて流すと落ちる（同じサーバーの文書を共有する順の依存）。この子DDの変更の前の HEAD でも同じく落ちることを確かめた（単独では成功）。この子DDの範囲外

## ログ

### 2026-11-20
- 起票（親 DD-070 の子DD 5）。決定事項は推奨案で確定
- 実装: `mount/read-rows.ts`（文書から文書の並びで読む純粋関数・空の行は列を走査しない）と `GridInstance.getRows`（`session.viewDocument` を読む）。React の ref handle にも
- テスト: 単体 4 件（`read-rows.test.ts`）・E2E 2 件（`read-rows.spec.ts`。単独モードの確定・setData の直後・round-trip、共同編集モードで他の参加者の確定）が成功
- 実装をコミット（251692d）し、Codex high にレビューを依頼（`DD-070-5/codex-review-result.md`）
- Codex の指摘（8 件・すべて妥当と判断して対応）:
  1. P2: 共同編集で拒否の通知（`rejected`）を、拒否した操作を除いて view を作り直す前に出していた（購読者がその場で読むと拒否した値が残る）→ collab の `handleRejected` で view を作り直してから知らせる。作り直しで見つかる依存の競合より先に拒否そのものを知らせる順は保つ（`rebuildView(leading)`）。collab の単体を足した
  2. P2: 共同編集でサーバーの初回の状態（bootstrap）を受け取る前に `getRows` が一部の行（自分で挿した行だけ）を返しえた → `ClientSession.hasInitialState`（welcome で bootstrap 不要と分かった・bootstrap を受理した時に立て、下ろさない）を足し、立つ前は空を返す。collab と grid の単体を足した
  3. P2: `0.0000001` のような数値の表示文字列が `1e-7`（指数表記）になり、`setData` に戻すと文字列になった → 表示文字列を指数表記の無い十進にした（`numberToPlainString`。値は変わらない）。表示・`cell-commit`・コピー・`remote-change` に効く（CHANGELOG の Changed）
  4. P2: `__proto__` などの列 ID が `{}` の自身の項目にならない → プロトタイプの無い辞書にした
  5. P2: `getCell` がセルごとに `columnOrder.indexOf` していた → 列の位置を行のループの外で一度だけ引く
  6. P2: `setData({ rows: getRows() })` で行データの設定が消えることが分からない → JSDoc と手引きに、含まないものと合成の要否を書いた
  7. P3: 文字列でない ID（`null` など）を `String` で変換して実在の列に一致させていた → 文字列だけを受け付ける
  8. P3: 自分の未確定の変更を読むことが確かめられていない → `readRowsFromBackend` に分けて、view と committed が違う単体で確かめる（E2E で送信を止めるのは重いので見送り・未保証境界へ）
- 修正をコミット（6f0e886）。typecheck・lint・test（1,782 件）が成功。E2E は read-rows・remote-change・validate-cell・range-selection・clipboard（共同編集）・undo-redo-collab が成功（UE-8 の順の依存は上の未保証境界）
- 製品化6観点: ①公開 API は追加（命令 1・型 2）と、数値の表示文字列・`rejected` の時点の変更（Changed に記録）②Facade の境界: collab の getter は grid の内部の型（GridBackendSession の任意の項目）だけで使い、公開しない ③再利用性: 汎用の読み取り ④拡張性: なし ⑤DX: quick-start・CHANGELOG ⑥互換性: 数値の表示が変わるのは指数表記になる値だけ
- 完了。アーカイブ（DD 本体と `DD-070-5/` を移す・DD-INDEX・DOC-MAP）
