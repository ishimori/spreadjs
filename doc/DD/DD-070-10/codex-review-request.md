# Codexレビュー依頼: DD-070-10（入力確定を表の大きさに比例させない）

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製スプレッドシート型入力基盤（Canvas グリッド・サーバー主導の共同編集）。core の `applyOperation`（`packages/core/src/apply.ts`）は「入力の文書を壊さない」ために、操作のたびに `cloneDocument` で文書を丸ごと深く複製していた。180 列 × 50,000 行で 1 セルの確定に 1.6 秒かかっていた（DD-070-1 の計測）。

本 DD は、この複製を構造共有（copy-on-write）に変えた。`applyOperation` は単独モードの確定、共同編集のクライアントの楽観適用と再ベース、サーバーの sequencer が共有している。DD 本文は `doc/DD/DD-070-10_入力確定を表の大きさに比例させない.md`（決定事項 1〜5）。仕様は確定済みで、本レビューの対象は**実装が決定事項どおり正しく、共有した構造への書き込みが他の文書へ漏れないか**。

## レビュー対象差分

コミット {SHA} の変更すべて（DD 文書と本依頼書は対象外）。

## 実装の要点

- `packages/core/src/cell-store.ts`
  - `fork()` を足した。チャンク（256 行）と行（列の昇順の並列配列）を共有し、`ownedChunks`・`ownedRows`（WeakSet）に入っていないものは書く前に写す。
  - fork したときは、元の側の owned も空に戻す。
  - `clone()` は今までどおり深い複製。
- `packages/core/src/document.ts`
  - `forkDocument` を足した。cells は fork、rowOrder・rowMeta は共有し、モジュールの WeakSet `sharedRowAxis` で共有中を記録する。
  - `writableRowOrder`・`writableRowMeta` は、共有中なら写して差し替える。
  - `cloneDocument` は深い複製のまま。
- `packages/core/src/apply.ts`
  - `applyOperation` は `forkDocument` を使う。
  - insertRows は書く前に writable を取る。
  - deleteRows は RowMeta をその場で書き換えず差し替える。
  - `replayAcceptedOperations`（in-place）は変えていない。
- テスト
  - `packages/core/src/fork.test.ts`: fork の木・文書の木へ無作為に書き、どれも深い複製の経路と一致するか。100 万セルでの時間のガード。
  - E2E `apps/playground/e2e/zz-rm-database-perf.spec.ts` の入力確定を判定に戻した。

## 評価基準（この観点で見てほしい）

1. **共有した構造への書き込みの漏れ（最重要）**
   - core の中と外（`packages/collab`・`packages/grid`・`packages/server`・`packages/server-hono`）で、`applyOperation` の結果または入力の文書の次のものを、その場で書き換える経路が残っていないか: `rowOrder`・`rowMeta`・`RowMeta`・`CellRecord`・`CellScalar`・`cells`。
   - 特に見てほしい経路:
     - `replayAcceptedOperations` に `applyOperation` の結果を渡す経路
     - collab の `committed`・`view`・`rebuildView`・`applyInverseSeed`
     - サーバーの永続化（snapshot の直列化を後で行う経路）
     - 読み取り用に返した配列を呼び出し側が変える経路
2. **CellStore の copy-on-write の正しさ**
   - fork の連鎖（a→b→c）、fork の後に元の側へ書く、`deleteRow`・`delete`。
   - 数え（`nonEmptyCount`・`approxMemoryBytes` の文字数）の食い違い、チャンクの境界。
3. **WeakSet `sharedRowAxis` の作り**
   - 共有の記録の付け漏れ・外し漏れ。
   - fork の後に元の文書を in-place で書く経路（replay の base）。
   - core のモジュールが二重に読み込まれた場合の危うさ。
4. **費用**
   - 構造共有で別の経路が表の大きさに比例していないか。例: 行の挿入・削除ごとの rowMeta Map の写し、collab の再ベースで pending の数だけ fork する費用、メモリの保持（古い文書が共有のチャンクを持ち続ける）。
5. **テストの確かさ**
   - fork.test.ts の無作為の木が、漏れを本当に検出できる作りか（参照が独立しているか・比べる中身が足りているか）。

## 対象外

- 仕様の当否（構造共有にすること自体）
- メモリの上限（約 420 万セルで 300 MB）を下げる話
- 既存の他の機能

## 出力形式

指摘ごとに「重要度（P1/P2/P3）・ファイルと行・何が起きるか（具体的な条件）・直し方」。指摘が無ければ「指摘なし」と書く。
