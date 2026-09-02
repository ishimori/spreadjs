# DD-026: consumer 統合①: 松下 生産納期（保存 Adapter・認証境界・サーバー起点操作）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-03 | 2026-09-03 | 進行中 | consumer を松下 生産納期へ変更（D-007）。Phase 1〜4 完了（DD-026-1〜3 実装・1018 test green・公開型 snapshot 更新）。残: Codex レビュー反映 → Phase 5（consumer 側 Manual Gate・KPI-1/5 は松下 DD-012-2 で採取） |

```text
Risk Class: A
Risk Triggers: 永続化境界を変更（OpLogStore/SnapshotStore の外部注入・初期文書の外部供給）／protocol・sequencer 経路を変更（actorId のサーバー上書き・サーバー起点 SetCells）／Stable 前の公開 API（server-hono ServeOptions・ServerInstance）を拡張／consumer の認証（JWT Cookie）を信頼境界に組み込む
Human Spec Gate: required（Phase 1 の公開契約案をユーザーレビューで確定してから実装。子 DD ごとに再判定）→ 代行確定（ユーザー指示「迷ったら推奨案で決めて」2026-09-03・論点①〜⑥と要確認④を推奨案で確定＝contract.md §1）
Codex: 子 26-3（sequencer 経路にサーバー起点操作を追加）は xhigh 1回。26-1/26-2 は high → 全差分まとめて xhigh 1 回で実施
Manual Gate: あり（実機: consumer の 2 ブラウザ・2 ユーザーで同一セル編集→収束、JWT なし接続→拒否、サーバー再起動→復旧。synthetic と実 IME を混同しない）
External Review: なし（Phase 境界・API 確定は Codex＋ユーザーゲート）
Evidence Level: standard
```

> アプローチ: TDD（公開契約と sequencer／永続化の振る舞いが中心。子 DD ごとに再判定。統合の証拠は consumer 側の実機 Manual Gate）
> リスク: あり（永続化 — 26-1 / 認証・protocol — 26-2・26-3 / 公開 API 拡張 — 全子）

## 目的

共同編集モードを **consumer の Postgres と認証につないで実案件で稼働させる**（憲章 §11.4・S2-1・S2-6）。SDK 側に無い 3 つの口を公開 API として追加し、consumer（松下 生産納期）が「受理した操作を同一トランザクションで業務表へ投影」「JWT Cookie で接続を認証」「サーバーから補完・算出列を書く」を SDK を fork せずに実現できることを実証する。

- **U1** 永続化ストアの差し替え口（`OpLogStore` / `SnapshotStore` の注入と初期文書の外部供給）
- **U2** 認証フック（WebSocket upgrade 時に検証し、envelope の `actorId` をサーバーが上書き）
- **U3** サーバー起点の操作（`ServerInstance.submit(setCells, { actorId })` が通常の受理経路を通る）
- U4 複数文書は本 DD の範囲外（管理表②③の編集化で別 DD）

## 背景・課題

- ロードマップ（`phase2-dd-roadmap.md` §1・§2）: DD-026 = consumer 統合①（保存 Adapter・認証境界）。2026-07-16 の順序入替で機能 DD 群を先行させ、DD-026 は復帰待ちだった。当初の consumer は housing-e-kintai-next（FastAPI・単独グリッド先行）。**松下案件で共同編集が最重要要件となり、consumer を松下へ変更**する（D-007・ロードマップ §2 へ記録済み）
- consumer の現状（2026-09-03 実測）: DD-009 で単独グリッドモードを統合済み（React 19 + Vite 8 / Hono + Prisma + PostgreSQL / JWT httpOnly Cookie）。共同編集化の設計は consumer 側 DD-012-2 に確定済み。正本は consumer の Postgres（1 行 1 レコード）で、シート同期サーバーの操作ログもそこへ置く
- SDK の現状（着手前）: `serve()` は `persistenceDir`（ファイル固定）。`OpLogStore`（append / readAll / close）と `SnapshotStore` は内部 interface で差し替え可能だが公開されていない。WebSocket upgrade に検証口が無く `actorId` / `clientId` / `displayName` はクライアント申告。サーバーから文書へ操作を差し込む口が無く、共同編集モードでは `cell-commit` も発火しない
- KPI 台帳: KPI-1（コア変更 0 件）・KPI-5（基本業務入力画面の統合 ≤ 2 開発日）は本 DD で採取。**KPI-4（初回表示 ≤ 30 分）は consumer が DD-009 で導入済みのため自然採取できない** → 台帳 §3.1 へ「採取不能・理由」を記録済み・統合②で採取

## 検討内容

| # | 論点 | 選択肢 | 仮説 |
|---|------|--------|------|
| ① | U1 ストア注入の形 | (a) `serve({ oplog?, snapshotStore? })` に実装を渡す（省略時は従来のファイル or メモリ） / (b) `createServer()` を新設し `serve()` は薄い既定 | **(a)**。既存 consumer（quick-start）を壊さず、追加 2 オプションで済む。`persistenceDir` との同時指定は config error で fail-fast |
| ② | U1 初期文書の供給 | (a) `startServer` 内部の `restoreFrom`（SnapshotData）を `serve()` に公開 / (b) `initialDocument: () => Promise<SnapshotData>` の関数 | **(b)**。consumer は DB から組み立てるため非同期。操作ログが空のときだけ呼ぶ（ログがあれば snapshot + tail 復旧を優先） |
| ③ | U2 認証の位置 | (a) HTTP upgrade 時（Cookie・ヘッダが読める） / (b) join メッセージ内のトークン | **(a)**。consumer の JWT は httpOnly Cookie で、同一ホストなら upgrade 要求に自動で載る。`authenticate(req) → { actorId, displayName } \| null`、null は upgrade 拒否（401）。受理後の envelope `actorId` と presence の `displayName` はフックの結果で**上書き**（クライアント申告は無視。`clientId` は再接続の同一性のため申告を維持） |
| ④ | U3 サーバー起点操作の経路 | (a) `ServerInstance.submit(op, { actorId })` が sequencer の通常受理経路（revision 付与・配信・永続化）を通る / (b) 永続化を迂回して配信だけ | **(a)**。迂回すると再起動で消える。`clientId` はサーバー固定値、`baseRevision` は現 revision。利用者の Undo 対象にならない（Undo は自クライアントの操作のみ = 既存挙動で成立するはず。テストで固定） |
| ⑤ | 子 DD の切り方 | 3 分割（26-1 ストア注入と初期文書 / 26-2 認証フック / 26-3 サーバー起点操作）+ 親で統合の証拠 | **3 分割**。公開 API がそれぞれ独立で、Codex 密度も異なる（26-3 のみ xhigh） |
| ⑥ | 無限ループ防止（U3） | consumer がサーバー起点操作の受理をまた投影→再評価する経路 | SDK 側は関知しない（consumer の責務）が、envelope に `actorId` が残るので consumer は `'system'` を見て再評価を抑止できる。quick-start に注意書き |

## 決定事項

論点①〜⑥・要確認④は**推奨案（仮説列）で確定**（ユーザー指示「迷ったら推奨案」2026-09-03）。公開契約・fail-fast 条件・内部設計・テストシナリオは `DD-026/contract.md`（§1〜§5）が正。実装者判断で加えた点:

- **初期文書は document@0**（revision 0・oplog に載せない）。ストア指定時は snapshot@0 を保存してから listen。これに伴い **非空 document@0 への fresh join は bootstrap@0 を送る**（server/collab の対称変更・空文書は従来どおり）
- **persisted snapshot format v2**（checksum を深いキー順ソートで正準化）。理由: consumer の `sheet_snapshots.data jsonb` はキー順を保持せず、v1 では再起動時に必ず checksum 不一致になる。v1 は読込互換
- **`clientId: 'server'` は予約語**（join を 1008 で拒否）。`submit` の引数エラーも Promise reject（同期 throw しない）
- 公開型は `serve-types.ts` に内部 package 非参照で定義（R7）。公開→内部の変換は brand ファクトリで組み直す（ダブルキャスト不使用）
- U3 は `setCells` のみ受け付ける（要件の範囲。`insertRows`/`deleteRows` は必要時に additive で拡張）

## 受け入れ基準

| # | 基準 | 検証方法 |
|---|------|---------|
| 1 | `serve({ oplog, snapshotStore })` で任意実装を渡せ、`append` 解決 = durable の契約のまま動く。メモリ実装で再起動相当（stop → serve）後に snapshot + tail から復旧する | `serve.stores.test.ts` S1/S2/S3 |
| 2 | 操作ログが空のとき `initialDocument()` の結果から開始し、以後は呼ばれない | 同 S4/S4b/S5・`room.test.ts`/`bootstrap.test.ts`（bootstrap@0） |
| 3 | `authenticate` が null を返す upgrade は 401 で拒否。返した `actorId` が受理 envelope に入り、クライアント申告の `actorId` は無視される | `serve.auth.test.ts` A1〜A4（実 WS） |
| 4 | `ServerInstance.submit(setCells)` が revision を得て全接続へ配信され、永続化される。送信元クライアントは存在しない（pending 0） | `serve.submit.test.ts` B1/B3/B5 |
| 5 | サーバー起点操作が利用者の Undo スタックに入らない | `session-sync.test.ts` own-echo（unit・構造保証）＋B1 の `clientId: 'server'`（E2E から unit へ変更・26-3 ログ） |
| 6 | consumer（松下）で 2 ブラウザ・2 ユーザーが同一セルを編集し 1 秒以内に収束、Postgres の業務表が同じ値。JWT なし接続は拒否。サーバー再起動後に続きを編集できる | Manual Gate（consumer DD-012-2 の E2E）— **未実施（Phase 5）** |
| 7 | KPI-1: 統合期間中の SDK 変更に consumer 専用分岐が無い（`npm run lint:boundary` green・consumer 側 fork なし） | kpi-ledger §3.1 — boundary green 済み・consumer 側は Phase 5 |
| 8 | 公開型スナップショット（DD-028）に U1〜U3 の型が載り、CHANGELOG・quick-start・`features.json` が更新されている | 完了前チェック — 済（snapshot 追加のみ・CHANGELOG [Unreleased]・quick-start §3b・features `integration-adapters`） |

## タスク一覧

### Phase 1: 公開契約の設計（Human Spec Gate）
- [x] `DD-026/contract.md`: U1〜U3 の型（ServeOptions 追加項目・`ServerInstance.submit`・`authenticate` の入出力）と fail-fast 条件を提示
- [x] 👀 ユーザー確認: 論点①〜⑥・要確認④（KPI-4 の扱い）・consumer 変更のロードマップ記録 → 代行確定（「迷ったら推奨案」指示）
- [x] `doc/plan/phase2-dd-roadmap.md` §0/§1/§2/§6/§7 に順序入替（consumer ① = 松下・共同編集採用）を記録。`doc/decisions.md` D-007
- [x] 子 DD 26-1〜26-3 を起票
- [x] 🔬 機械検証: `bash scripts/dd-health.sh --dd DD-026` → ⚠️ なし

### Phase 2: 26-1 ストア注入と初期文書（リスク: 永続化）
- [x] `packages/server-hono/src/index.ts`・`server.ts`・`serve-types.ts`・`serve-adapters.ts`: `oplog` / `snapshotStore` / `initialDocument` オプション。`persistenceDir`・`seedRows` との排他
- [x] `packages/server/src/snapshot-store.ts`（format v2）・`room.ts`・`packages/collab/src/session.ts`（bootstrap@0）。公開型は Facade 自身で定義（boundary lint 準拠・内部型の再エクスポートなし）
- [x] 🔬 機械検証: `npx vitest run packages/server packages/server-hono packages/collab` → green / `npm run lint:boundary` green

### Phase 3: 26-2 認証フック（リスク: 認証・protocol）
- [x] `server.ts` の upgrade ハンドラに `authenticate` を挿入。RoomBridge で connection → identity を保持し、envelope の `actorId` と presence の `userId`/`displayName` を上書き
- [x] 🔬 機械検証: WS テスト（401 拒否・actorId 上書き・500・回帰）green

### Phase 4: 26-3 サーバー起点操作（リスク: sequencer 経路。Codex xhigh）
- [x] `ServerInstance.submit(operation, { actorId })`。PersistentRoom の通常経路で受理・配信・永続化（擬似接続 'server'）
- [x] Undo 非対象・pending 0 のテスト
- [x] 🔬 機械検証: `npm test` の該当 green（全 1018）

### Phase 5: consumer 統合の証拠と DX
- [ ] consumer 側 DD-012-2 の Manual Gate 結果を `DD-026/evidence.md` へ転記（基準 6）— **ユーザー実施**（松下側で SDK tarball 更新→DD-012-2 Phase 2〜4）
- [ ] 📊 KPI-1・KPI-5 を `doc/plan/kpi-ledger.md` へ記録（consumer 側統合完了時）／[x] KPI-4 は採取不能を記録済み（§3.1）
- [x] `doc/quick-start.md` §3b「独自永続化・認証・サーバー起点操作」、`CHANGELOG.md`、`apps/showcase/src/features.json`（`integration-adapters`）、公開型スナップショット更新
- [x] 🔬 機械検証: `npm test`（features smoke・API 型スナップショット・migration dry-run 含む）→ 1018 green

### 完了前チェック
- [x] 受け入れ基準を 1 項目ずつ照合（1〜5・8 充足。6・7 は Phase 5＝consumer 側）
- [x] 製品化 6 観点（下記ログ 2026-09-03）
- [x] 😈 セルフレビュー 1 巡（投影失敗時の ACK・再接続中のサーバー起点操作・actorId 上書きと reconcile の整合を重点に → 子 DD ログ）
- [x] 🔬 全回帰 1 回: `npm run lint`（boundary 含む）・`npm run typecheck`・`npm test` 1018 green・`npm run test:e2e`（playground）→ 下記ログ

## ログ

### 2026-09-03
- 起票。consumer を松下 生産納期へ変更（ユーザー決定。松下側で共同編集が最重要要件・Postgres 保存・JWT Cookie 認証・構成は SDK 優先と確定）。要件メモは consumer から持ち込み（`DD-026/consumer-requirements-matsushita.md`）
- SDK 実測: `serve()` はファイル永続化固定・認証フックなし・サーバー起点操作なし・共同編集モードで `cell-commit` 非発火 → U1〜U3 を公開 API として追加する方針
- Phase 1: 論点①〜⑥・要確認④を推奨案で確定（ユーザー指示「迷ったら推奨案」）。`contract.md` に契約・fail-fast・内部設計・テストシナリオを固定。子 DD 26-1〜3 起票。ロードマップ §0/§1/§2/§6/§7・D-007・kpi-ledger §3.1（KPI-4 採取不能）を記録
- Phase 2〜4: DD-026-1〜3 実装完了（詳細・セルフレビュー所見は各子 DD ログ）。新規テスト 21 件（stores 7・auth 4・submit 5・grid 1・room 1・bootstrap 1・snapshot-store 3）。全回帰 `npm test` 1018 green（ベースライン 997）・typecheck/lint/boundary green・公開 .d.ts snapshot 更新（追加のみ・破壊的変更なし）
- 実装前に発見した consumer 側の落とし穴: (1) `jsonb` はキー順を保持しないため v1 checksum が再起動時に必ず不一致 → format v2 で先回り (2) 初期文書を revision 0 で持つと既存 protocol では fresh join に bootstrap が送られず空文書になる → bootstrap@0 を server/collab 対称で追加（空文書の挙動は不変）
- 製品化 6 観点: ①公開 API＝`ServeOptions` 4 項目・`ServerInstance.submit`・`Serve*` 型 20 件を追加（Experimental・additive）②境界＝公開型は Facade 自身で定義し内部型を漏らさない（R7 test・boundary lint green）③再利用性＝Postgres 固有物を SDK に入れず interface のみ（consumer 側で DB 実装）④拡張性＝案件要件 U1〜U3 は全て Adapter/Options で実現（コア変更 0）⑤DX＝quick-start §3b・CHANGELOG・features.json・診断コード 2 件 ⑥互換性＝破壊的変更なし・snapshot v1 読込互換・migration guide 不要
- 境界（既知の制限・見送り）: ブラウザー WebSocket は 401 を判別できない（close 1006→grid `connect-failed`）／`clientId` は申告維持ゆえ同一ユーザー内の再接続同一性は保つが別ユーザーの clientId 乗っ取りは防がない（trusted internal）／U3 は setCells のみ／複数文書（U4）は範囲外
- 次: Codex レビュー（xhigh・全差分）→ 反映 → 子 DD 完了・アーカイブ → Phase 5 は松下側 DD-012-2（SDK tarball 更新後）で実施
