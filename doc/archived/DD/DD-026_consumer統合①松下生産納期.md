# DD-026: consumer 統合①: 松下 生産納期（保存 Adapter・認証境界・サーバー起点操作）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-03 | 2026-09-03 | 完了 | consumer を松下 生産納期へ変更（D-007）。U1〜U3 を server-hono 公開 API として提供（DD-026-1〜3）。新規テスト 25 件・全回帰 green・Codex xhigh P1×3/P2×2 全反映・公開型 snapshot 追加のみ。consumer 実機（2 ブラウザ収束・JWT 拒否・再起動復旧）と KPI-1/5 は未実施＝既知の未保証境界（松下 DD-012-2 で実施） |

```text
Risk Class: A
Risk Triggers: 永続化境界を変更（OpLogStore/SnapshotStore の外部注入・初期文書の外部供給）／protocol・sequencer 経路を変更（actorId のサーバー上書き・サーバー起点 SetCells）／Stable 前の公開 API（server-hono ServeOptions・ServerInstance）を拡張／consumer の認証（JWT Cookie）を信頼境界に組み込む
Human Spec Gate: required → 代行確定（ユーザー指示「迷ったら推奨案で決めて」2026-09-03・論点①〜⑥と要確認④を推奨案で確定＝contract.md §1）
Codex: xhigh 1 回（全差分まとめて。子 26-3 の sequencer 経路を含むため）→ 実施済み・P1×3/P2×2 全反映
Manual Gate: あり（consumer 実機。下記「Manual Gate」。DD クローズはブロックしない＝dd-risk-class-header.md「Manual Gate の扱い」2026-09-03）
External Review: なし（Phase 境界・API 確定は Codex＋ユーザーゲート）
Evidence Level: standard
```

> アプローチ: TDD（公開契約と sequencer／永続化の振る舞いが中心。統合の証拠は consumer 側の実機 Manual Gate）
> リスク: あり（永続化 — 26-1 / 認証・protocol — 26-2・26-3 / 公開 API 拡張 — 全子）

## 目的

共同編集モードを **consumer の Postgres と認証につないで実案件で稼働させる**（憲章 §11.4・S2-1・S2-6）。SDK 側に無い 3 つの口を公開 API として追加し、consumer（松下 生産納期）が「受理した操作を同一トランザクションで業務表へ投影」「JWT Cookie で接続を認証」「サーバーから補完・算出列を書く」を SDK を fork せずに実現できることを実証する。

- **U1** 永続化ストアの差し替え口（`OpLogStore` / `SnapshotStore` の注入と初期文書の外部供給）
- **U2** 認証フック（WebSocket upgrade 時に検証し、envelope の `actorId` をサーバーが上書き）
- **U3** サーバー起点の操作（`ServerInstance.submit(setCells, { actorId })` が通常の受理経路を通る）
- U4 複数文書は本 DD の範囲外（管理表②③の編集化で別 DD）

## 背景・課題

- ロードマップ（`phase2-dd-roadmap.md` §1・§2）: DD-026 = consumer 統合①。当初の consumer は housing-e-kintai-next（FastAPI・単独グリッド先行）。**松下案件で共同編集が最重要要件となり、consumer を松下へ変更**（D-007・ロードマップ §0/§1/§2/§6/§7 へ記録済み）
- consumer の現状（2026-09-03 実測）: DD-009 で単独グリッドモードを統合済み（React 19 + Vite 8 / Hono + Prisma + PostgreSQL / JWT httpOnly Cookie）。共同編集化は consumer 側 DD-012-2（SDK 非依存部分＝スキーマ・投影・Pg ストア・再生検証は先行実装済み）。正本は consumer の Postgres で、操作ログもそこへ置く
- SDK の現状（着手前）: `serve()` は `persistenceDir`（ファイル固定）。`OpLogStore`/`SnapshotStore` は内部 interface で公開されていない。upgrade に検証口が無く `actorId`/`clientId`/`displayName` はクライアント申告。サーバーから文書へ操作を差し込む口が無い
- KPI 台帳: **KPI-4 は採取不能**（consumer は DD-009 で導入済み＝初回導入でない）→ §3.1 へ記録済み・統合②で採取。KPI-1/5 は松下側の統合実装完了時に記録

## 検討内容

| # | 論点 | 選択肢 | 仮説（→ 推奨案で確定） |
|---|------|--------|------|
| ① | U1 ストア注入の形 | (a) `serve({ oplog?, snapshotStore? })` に実装を渡す / (b) `createServer()` を新設 | **(a)**。既存 consumer を壊さず追加 2 オプション。`persistenceDir` との同時指定は fail-fast |
| ② | U1 初期文書の供給 | (a) 内部 `restoreFrom`（SnapshotData）を公開 / (b) `initialDocument: () => Promise<...>` | **(b)**。consumer は DB から非同期に組み立てる。snapshot も操作ログも無いときだけ呼ぶ |
| ③ | U2 認証の位置 | (a) HTTP upgrade 時（Cookie が読める） / (b) join メッセージ内のトークン | **(a)**。null は 401。受理後の envelope `actorId`・presence はフック結果で上書き。`clientId` は申告維持 |
| ④ | U3 の経路 | (a) 通常受理経路（revision 付与・配信・永続化） / (b) 永続化を迂回して配信だけ | **(a)**。迂回すると再起動で消える。`clientId` はサーバー固定値。Undo 非対象 |
| ⑤ | 子 DD の切り方 | 3 分割 + 親で統合の証拠 | **3 分割**（26-1/26-2/26-3） |
| ⑥ | 無限ループ防止（U3） | consumer が受理を投影→再評価する経路 | SDK は関知しない。envelope の `actorId`/`clientId='server'` で consumer が抑止。quick-start に注意書き |

## 決定事項

論点①〜⑥・要確認④は推奨案で確定。公開契約・fail-fast・内部設計・テストシナリオは `DD-026/contract.md` が正。実装者判断・レビュー反映で加えた点:

- **初期文書は document@0**（oplog に載せない）。ストア指定時は snapshot@0 を保存してから listen。**非空 document@0 への fresh join は bootstrap@0 を送り**、クライアントは committed 0 かつ「この接続で未 bootstrap」のとき受理（接続ごとに受け直す＝Codex P1）
- **persisted snapshot format v2**（checksum を深いキー順ソートで正準化・jsonb 可・v1 読込互換）
- **注入ストアへの `append` は SDK が直列化＋fail-stop**（並行 commit の欠番を防ぐ・Codex P1）。entries は複製して渡す
- **セル値の実行時検証**（number 有限数・date 正準 LocalDate。Codex P1）／**`clientId: 'server'` は予約語**（join 拒否）／`submit` のエラーは常に Promise reject
- 認証: hook の throw は診断に種別のみ（Codex P2）／認証待ち socket は `stop()` で破棄（Codex P2）
- 公開型は `serve-types.ts` に内部 package 非参照で定義（R7）。U3 は `setCells` のみ（必要時に additive 拡張）

## 受け入れ基準

| # | 基準 | 検証方法 | 結果 |
|---|------|---------|------|
| 1 | `serve({ oplog, snapshotStore })` で任意実装を渡せ、`append` 解決 = durable の契約のまま動く。stop → serve で snapshot + tail から復旧 | `serve.stores.test.ts` S1/S2/S3/S9 | ✅ |
| 2 | 操作ログが空のとき `initialDocument()` の結果から開始し、以後は呼ばれない | 同 S4/S4b/S5/S10・`room.test.ts`/`bootstrap.test.ts` | ✅ |
| 3 | `authenticate` が null の upgrade は 401。返した `actorId` が受理 envelope に入り、申告 `actorId` は無視 | `serve.auth.test.ts` A1〜A5（実 WS） | ✅ |
| 4 | `ServerInstance.submit(setCells)` が revision を得て全接続へ配信・永続化。送信元クライアントは無い（pending 0） | `serve.submit.test.ts` B1/B3/B5 | ✅ |
| 5 | サーバー起点操作が利用者の Undo スタックに入らない | `session-sync.test.ts` own-echo（unit・構造保証）＋B1 の `clientId: 'server'`（E2E から unit へ変更・26-3 ログ） | ✅ |
| 6 | consumer（松下）で 2 ブラウザ・2 ユーザーの同一セル編集が 1 秒以内に収束・Postgres の業務表が同じ値。JWT なし接続は拒否。再起動後に続きを編集できる | Manual Gate（consumer DD-012-2 の E2E） | ⏳ 未実施 → 既知の未保証境界 |
| 7 | KPI-1: 統合期間中の SDK 変更に consumer 専用分岐が無い | `npm run lint:boundary` green＝SDK 側 pass。consumer 側 fork なしの確認と台帳記入は松下 DD-012-2 完了時 | ◐ SDK 側 pass |
| 8 | 公開型スナップショットに U1〜U3 の型が載り、CHANGELOG・quick-start・`features.json` が更新されている | snapshot 追加のみ・CHANGELOG [Unreleased]・quick-start §3b・features `integration-adapters` | ✅ |

## Manual Gate（consumer 実機・正味約 15 分・松下 DD-012-2 Phase 3〜4 で実施）

1. SDK tarball を再生成（`bash scripts/release/build-release.sh`）→ 松下側 `vendor/nanairo-sheet/*.tgz` 差し替え・`npm install`（engineering-patterns #3）
2. 2 ブラウザ・2 ユーザーでログイン → 同一セルを編集 → 双方が 1 秒以内に同じ値・`raw_production_orders` も同じ値（5 分）
3. 未ログインのブラウザーで接続 → 接続失敗（grid `connect-failed`）・同期サーバー診断 `auth-rejected`（2 分）
4. 同期サーバー再起動 → 両ブラウザーが再接続し続きを編集できる（5 分）
5. 品番確定 → サーバー起点操作で品名・単重・単価が両ブラウザーに現れる（3 分）

## 既知の未保証境界

- **consumer 実機は未確認**（上記 Manual Gate 1〜5）。SDK 側は同等経路を実 WS＋メモリ/ファイルストアの自動テストで固定した。問題が出たら別 DD を起票する（features.json/CHANGELOG は実機未確認を言い切っていない）
- **KPI-1（consumer 側 fork なし）・KPI-5** は松下 DD-012-2 の統合完了時に `kpi-ledger.md` §3.1 へ記録（DD-032 が consumer 単位で欠落を検査）
- ブラウザー WebSocket は 401 を判別できない（close 1006）／`clientId` は申告維持（trusted internal）／U3 は setCells のみ／複数文書（U4）は範囲外／注入ストアは直列 append（スループットは 1 トランザクションずつ）

## タスク一覧

### Phase 1: 公開契約の設計（Human Spec Gate）
- [x] `DD-026/contract.md`（型・fail-fast・内部設計・テストシナリオ）
- [x] 👀 ユーザー確認 → 代行確定（「迷ったら推奨案」指示）。ロードマップ §0/§1/§2/§6/§7・D-007・kpi-ledger §3.1（KPI-4 採取不能）
- [x] 子 DD 26-1〜26-3 起票
- [x] 🔬 機械検証: `bash scripts/dd-health.sh --dd DD-026` → ⚠️ なし

### Phase 2〜4: 実装（子 DD）
- [x] DD-026-1 ストア注入と初期文書（永続化）／DD-026-2 認証フック／DD-026-3 サーバー起点操作 — 全て完了（各子 DD の AC・ログ参照）
- [x] 🔬 機械検証: `npx vitest run packages/server packages/server-hono packages/collab` → green・`npm run lint:boundary` green

### Phase 5: consumer 統合の証拠と DX
- [ ] consumer 側 Manual Gate（上記）→ 既知の未保証境界へ移送（新運用・クローズをブロックしない）
- [x] 📊 KPI-4 採取不能を記録。KPI-1/5 は松下 DD-012-2 完了時（既知の未保証境界）
- [x] `doc/quick-start.md` §3b・`CHANGELOG.md`・`apps/showcase/src/features.json`・公開型スナップショット・`doc/engineering-patterns.md` #7/#8
- [x] 🔬 機械検証: `npm test`（features smoke・API 型スナップショット・migration dry-run 含む）→ green

### 完了前チェック
- [x] 受け入れ基準を 1 項目ずつ照合（上表）
- [x] 製品化 6 観点（ログ 2026-09-03）
- [x] 😈 セルフレビュー 1 巡（子 DD ログ）＋ Codex xhigh 1 回（P1×3/P2×2 全反映）
- [x] 🔬 全回帰: `npm run lint`（boundary 含む）・`npm run typecheck`・`npm test`・`npm run test:e2e`（playground）→ ログ

## ログ

### 2026-09-03
- 起票。consumer を松下 生産納期へ変更（ユーザー決定）。要件メモは consumer から持ち込み（`DD-026/consumer-requirements-matsushita.md`）
- SDK 実測: `serve()` はファイル永続化固定・認証フックなし・サーバー起点操作なし → U1〜U3 を公開 API として追加する方針
- Phase 1: 論点①〜⑥・要確認④を推奨案で確定。`contract.md` に契約を固定。子 DD 26-1〜3 起票。ロードマップ・D-007・kpi-ledger を記録
- Phase 2〜4: DD-026-1〜3 実装完了。新規テスト 21 件・`npm test` 1018 green・typecheck/lint/boundary green・公開 .d.ts snapshot 更新（追加のみ）・playground E2E 67 green
- 実装前に発見した consumer 側の落とし穴: (1) `jsonb` はキー順を保持せず v1 checksum が再起動時に必ず不一致 → format v2（engineering-patterns #7）(2) 初期文書を revision 0 で持つと既存 protocol では fresh join に bootstrap が送られない → bootstrap@0（同 #8）
- 製品化 6 観点: ①公開 API＝`ServeOptions` 4 項目・`ServerInstance.submit`・`Serve*` 型 20 件（Experimental・additive）②境界＝公開型は Facade 自身で定義（R7 test・boundary lint green）③再利用性＝Postgres 固有物を SDK に入れず interface のみ ④拡張性＝U1〜U3 は全て Adapter/Options（コア変更 0）⑤DX＝quick-start §3b・CHANGELOG・features.json・診断コード 2 件 ⑥互換性＝破壊的変更なし・snapshot v1 読込互換・migration guide 不要
- **Codex xhigh レビュー**（`DD-026/codex-review-request.md` → `codex-review-result.md`）: P1×3・P2×2。到達性×実害で仕分け、**全件採用**（いずれも実 transport で再現可・durable 欠番／非収束／stop ハングの実害）。反映内容は各子 DD ログ。追加テスト 3 件（S9・S10・A5）＋既存 2 件を強化（S7 再接続・A3 診断内容）→ 新規計 25 件・全回帰 `npm test` 1022 green・playground E2E 67 green・typecheck/lint/boundary green
- クローズ: 新運用「Manual Gate は完了の必須条件にしない」（`dd-risk-class-header.md`・2026-09-03 ユーザー確定）に従い、consumer 実機・KPI-1/5 を既知の未保証境界へ移送して完了。ロードマップ §2 の中間チェックポイント（統合② ReadyCrew の開始可否）はユーザー判断へ
- 松下側への引き継ぎ: (1) SDK tarball 再生成→差し替え (2) `pg-stores.ts` は公開型 `ServeOpLogStore`/`ServeSnapshotStore`（`readAll` は `{ entries }`・`snapshot` は不透明）へ合わせる (3) 先行実装の「genesis snapshot」（revision 0 を consumer が組み立てて保存）は **`initialDocument` に置き換える**（checksum は SDK が v2 で封入するため consumer は計算不要・`sheet_snapshots.data` は text のままでも jsonb でもよい）(4) 補完・算出は `server.submit(..., { actorId: 'system' })`・投影側は `clientId === 'server'` で再評価を抑止
