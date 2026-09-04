# Codex レビュー依頼 — DD-043 複数文書 serve（N 枚固定・resolver 契約）

## 対象

`git diff main~1..HEAD`（コミット `DD-043: 複数文書 serve（N 枚固定・resolver 契約）を実装・ADR-0025 を Accepted`）。
中心は `packages/server-hono/src/server.ts`（`startServer` の文書レジストリ化・upgrade/HTTP の文書解決・起動時の検疫）、
`packages/server-hono/src/index.ts`（Facade `serve()` の公開面）、`packages/server-hono/src/serve-types.ts`（公開型）、
`packages/grid/src/mount-controller.ts`（クライアントが `?documentId=` を名乗る）。

## 何をした変更か

1 プロセスで複数の文書（Book / board）を serve できるようにした。v1 は**起動時に決めた N 枚固定**。

- `ServeOptions.documents = { documentIds, resolve, defaultDocumentId? }`。`resolve(documentId)` が
  文書構成（`columnOrder` / `seedRows` / `persistenceDir` / `oplog` / `snapshotStore` / `initialDocument`）を引く。
  単一文書オプションとは排他。
- 接続が文書を名乗る: `/ws?documentId=`・`/config?documentId=`（`/snapshot` も同様）。無指定は既定文書。
  serve していない ID は 404。upgrade の評価順序は **authenticate → 文書解決**。
- 起動時の検疫（複数文書構成のみ）: 復旧に失敗した文書だけ外して残りで立ち上がる。
  **単一文書構成の復旧失敗は従来どおり起動失敗**（0 文書で listen しない）。
- `startServer` を「文書レジストリ（`Map<documentId, DocumentRuntime>`）＋文書ランタイム生成関数」へ分解した。
  単一文書構成は N=1 として同じ経路を通る。
- `RoomBridge` は担当文書 ID を持ち、**厳格接続**（複数文書構成 or `?documentId=` 明示）では
  join の申告 documentId 不一致を 1008 で切断する。従来の単一文書・無指定接続は受理し警告診断のみ（後方互換）。

## 評価してほしい観点（優先順）

1. **リソースリーク・後始末**: 起動が途中で失敗した経路（resolve の矛盾・spec 検証失敗・listen 失敗・
   http.Server 型不一致）で、既に構築済みの文書ランタイム（oplog/snapshot ハンドル・PersistentRoom）が
   確実に閉じられているか。検疫された文書のストアが開きっぱなしにならないか（`createDocumentRuntime` の catch）。
2. **後方互換の破壊**: 単一文書 consumer（`documents` 未指定）から見た挙動・公開 API・エラーメッセージ・
   診断コードが変わっていないか。`RunningServer` / `ServerInstance` のシグネチャ変更（引数追加）が
   既存呼び出しを壊していないか。
3. **文書間の分離**: 操作・presence・clientSequence 表・oplog の混入経路が残っていないか。
   特に「別文書を名乗る join」「`?documentId=` 未指定で複数文書構成に繋いだ接続」の扱い。
4. **並行・ライフサイクル**: sweep タイマーが全文書を回すこと、`stop()` の順序（タイマー停止 →
   各文書の durable flush → 認証待ち socket 破棄 → ws terminate → server.close）、
   `submit` の `closed` 判定と文書解決の順序に穴がないか。
5. **公開 API の設計**: `documents` の形（列挙 + resolver）が ADR-0025 の「無限 Book へは実装差し替えだけで到達する」
   契約を実際に満たしているか（`documentIds` 任意化 + 遅延 resolve への移行が公開面を壊さないか）。
6. **テストの穴**: `packages/server-hono/src/serve.documents.test.ts`（M1〜M7）と E2E
   `apps/playground/e2e/multi-document.spec.ts` が上記 1〜4 を実際に守っているか。落ちるべきケースで
   落ちないテスト（偽陽性）が無いか。

## 対象外（指摘不要）

- 仕様の是非そのもの（N 枚固定にした・動的作成を作らない・`/health` を変えない・実行時の文書単位隔離を
  作らない）は ADR-0025 と DD-043 でユーザー合意済みの決定。**設計判断のやり直し提案は不要**。
- 日本語コメントの分量・文体、既存コードのスタイル、既存の baseline 済み境界違反。
- `restoreFrom` / `integrationDataset`（デモ・検査専用の内部オプション）を複数文書構成で提供しないこと。
- ドキュメント（CHANGELOG / quick-start / features.json / ADR / DD）の文面。

## 参考

- 設計正本: `doc/adr/0025-multi-document-serve-and-unbounded-books.md`（Accepted・末尾に実装で確定した細目）
- DD: `doc/DD/DD-043_複数文書serve.md`（Phase 1 の確定・受け入れ基準・既知の未保証境界）
- コーディング基準: `doc/templates/coding-standards.md`
- 全回帰は green（`npm test` 1,229 / `npm run typecheck` / `npm run lint` / `npm run test:e2e` 157）。
