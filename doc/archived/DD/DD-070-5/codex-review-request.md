# Codexレビュー依頼: DD-070-5（表のデータを読む API）

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製スプレッドシート型入力基盤（Canvas グリッド・サーバー主導の共同編集）。共同編集モードの画面側の consumer は表のデータを読む手段が無く、並べ替え・絞り込み・CSV の書き出しを作れない。そのため読むだけの命令 `GridInstance.getRows(options?)` を足した（両モード・React の ref handle にも）。

DD 本文: `doc/DD/DD-070-5_表のデータを読むAPI.md`（決定事項 1〜6）。手引き: `doc/quick-start.md` の「表のデータを読む」。仕様は確定済みで、本レビューの対象は**実装が決定事項どおり正しく作られているか**。

## レビュー対象差分

コミットの変更すべて（DD 文書と本依頼書、同じコミットに入った `doc/DD/DD-070-4/` のレビュー記録は対象外）。

## 決定事項

1. `getRows(options?)` → `readonly GridRowData[]`（`{ rowId, cells }`。`cells` は ColumnId → 表示文字列で空のセルは載せない＝`setData` の行と同じ形・同じ文字列）
2. 行は文書の並び（削除した行は含めない）で全部。将来の画面だけの並べ替え・絞り込みの影響は受けない
3. `options.columnIds`・`rowIds` で絞れる（未知・削除済みは無視。並びは文書の並び）
4. 値は自分の未確定の変更を含む今の値（view）。編集中のセルの下書きは含めない
5. boot 前・destroy 後は `[]`。同期で返す
6. 大きい表では全部を読むと重いことを手引きに書く

## 実装の要点

- `packages/grid/src/mount/read-rows.ts`（新規）: `readRows(doc, options)`
- `packages/grid/src/mount-controller.ts`: `getRows`（`lifecycle.backend()?.session.viewDocument`）
- `packages/grid/src/index.ts`: `GridRowData`・`GridReadRowsOptions`。`packages/react/src/index.ts`: ref handle
- テスト: `mount/read-rows.test.ts`・E2E `apps/playground/e2e/read-rows.spec.ts`

## 評価基準（この観点で見てほしい）

1. **値の正しさ（最重要）**: 表示文字列が `cell-commit`・`setData` の round-trip と一致するか（数値・日付・文字列・`stringColumns`）、`setData` に渡して同じ表になるか、view（committed＋自分の pending）を読むことの正しさ（共同編集の楽観適用・rollback/replay の途中・再接続中）、削除した行・tombstone の扱い
2. **境界**: boot 前・boot 中（snapshot の読み込み前）・destroy 後、不正な options（JS の consumer）で例外にならないか
3. **コスト**: 5 万行の表で `columnIds` を絞ったときに不要な走査をしていないか
4. **公開面**: R7（内部型を公開しない）、React の handle の網羅性チェック

## 対象外

- 仕様の当否（文字列で返すこと・画面の並びで返さないこと）
- 既存の他の機能

## 出力形式

指摘ごとに「重要度（P1/P2/P3）・ファイルと行・何が起きるか（具体的な条件）・直し方」。指摘が無ければ「指摘なし」と書く。
