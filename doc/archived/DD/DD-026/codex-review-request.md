# Codex レビュー依頼書 — DD-026（consumer 統合①: 松下 生産納期）U1〜U3

## 背景と目的

`@nanairo-sheet/server-hono`（共同編集サーバーの唯一の公開面・Experimental 0.x）に、consumer（松下 生産納期。React 19 + Hono + Prisma + PostgreSQL・JWT httpOnly Cookie）が SDK を fork せずに統合するための 3 つの口を追加した。

- **U1 永続化ストアの差し替え（DD-026-1）**: `serve({ oplog, snapshotStore })` に consumer 実装（Postgres 等）を渡す。`append` 解決＝durable の契約はファイル永続化と同じ（consumer は業務表への投影を同じトランザクションに入れる）。**`initialDocument`**: snapshot も操作ログも無いときだけ呼ばれ、結果が document@0（revision 0・oplog に載せない）。ストア指定時は snapshot@0 を durable 化してから listen。
  - 付随: persisted snapshot **format v2**（checksum を深いキー順ソートで正準化。jsonb はキー順を保持しないため v1 では再起動時に必ず不一致になる。v1 は旧算法で読込互換）／**非空 document@0 への fresh join は bootstrap@0 を送る**（server `Room.shouldBootstrap` と client `ClientSession.handleBootstrap` の対称変更。空文書@0 は従来どおり送らない）／`recoverSequencerState` の結果が「snapshot あり・op 0 件」でも復旧扱いにする。
- **U2 認証フック（DD-026-2）**: `serve({ authenticate })`。WebSocket upgrade 時に `{ url, headers }` を渡し `{ actorId, displayName } | null` を受ける。null は 401・throw は 500 で拒否（raw socket に応答を書いて destroy）。受理後は RoomBridge が接続ごとの identity を保持し、`submitOperation.envelope.actorId` と `presence.payload.userId/displayName` を上書きしてから Room へ渡す。`clientId` は申告維持（再接続同一性）。
- **U3 サーバー起点操作（DD-026-3）**: `ServerInstance.submit(setCells, { actorId })`。`clientId: 'server'`（予約・join で拒否）・`clientSequence` は Sequencer の表から +1・`baseRevision` は現 revision。擬似接続 'server' として `Room/PersistentRoom.handleMessage` を通す（durable 境界・poisoning・snapshot 生成をそのまま利用）。ACK は擬似接続宛てのため dispatch が捨て、operations は全接続へ配信。結果は Outbound の ack/reject から組む。引数エラー・stop 後・durable 失敗は Promise reject。

設計の正本: `doc/DD/DD-026/contract.md`（型・fail-fast 条件・内部設計の要点・テストシナリオ）。親 DD: `doc/DD/DD-026_consumer統合①松下生産納期.md`、子 DD: `DD-026-1〜3`。

## 対象差分

`--base 3e6da08`（DD-026 着手前のコミット）との差分。主要ファイル:

| ファイル | 内容 |
|---|---|
| `packages/server-hono/src/serve-types.ts`（新規） | 公開型（内部 package 非参照。wire 形式のミラー） |
| `packages/server-hono/src/serve-adapters.ts`（新規） | 公開→内部変換（brand ファクトリ）・ストア adapter・初期文書構築 |
| `packages/server-hono/src/server.ts` | オプション追加・復旧判定・snapshot@0・RoomBridge identity 上書き・upgrade 認証・`submit` |
| `packages/server-hono/src/index.ts` | `ServeOptions`/`ServerInstance` 拡張・型 re-export・排他 fail-fast |
| `packages/server/src/snapshot-store.ts` | format v2（canonicalJson）・v1 読込互換 |
| `packages/server/src/room.ts` | `shouldBootstrap`（非空 document@0） |
| `packages/collab/src/session.ts` | `handleBootstrap`（bootstrap@0 の受理条件） |
| `packages/server-hono/src/test-support.ts` | テスト補助（メモリ公開ストア・ヘッダ付き WS transport・クライアント生成） |
| `packages/server-hono/src/serve.{stores,auth,submit}.test.ts`（新規）ほか | 新規テスト 21 件 |
| `tests/contract/__snapshots__/facade-surface.test.ts.snap` | 公開 .d.ts snapshot（追加のみ） |
| `doc/quick-start.md` §3b・`CHANGELOG.md`・`apps/showcase/src/features.json`・`doc/plan/*`・`doc/decisions.md`・`doc/DD/DD-026*` | DX 成果物・計画・DD 文書 |

検証済み: `npm test` 1018 green（新規 21 含む）・`npm run typecheck`・`npm run lint`（eslint＋boundary R1〜R7）green・playground E2E 67 green。

## 評価基準（この観点で指摘してほしい）

1. **仕様一致**: contract.md §2〜§4 の契約と実装の乖離（fail-fast 条件・durable ACK の順序・bootstrap@0 の対称性・snapshot v2/v1 判定・identity 上書きの範囲・`submit` の結果化）。
2. **sequencer / 永続化経路の正しさ（最重点・26-3）**: 擬似接続 'server' 経由の submit が「revision 付与→append（fsync）→frontier 前進→配信」の既存順序を破っていないか。同一 tick の並行 `submit` と client op の交錯で `clientSequence`/`baseRevision` が壊れる経路。poisoning 後・stop 中の挙動。再起動後の `clientSequence` 継続（`clientSequenceTable` の復元経路: snapshot の表／oplog replay の `updateAuxFromOps`）。
3. **protocol 変更の安全性（26-1）**: bootstrap@0 の追加で既存 reconnect/catch-up/reconcile（DD-015）経路に副作用が無いか。`handleWelcome` が `currentRevision 0` で `awaitingBootstrap=false` にした後に bootstrap@0 が届く順序で、`maybeFinalizeSync`／`requestCatchup`／pending の rebuild が誤動作しないか。in-process reorder（bootstrap 先着・welcome 後着）。
4. **認証境界（26-2）**: upgrade の await 中に socket が閉じた／error した場合のリーク・uncaught。identity 上書きの抜け（presence 以外に身元を運ぶメッセージが無いか）。`authenticate` の戻り値検証。診断に機密値が載らないか。
5. **バリデーション・fail-fast**: `initialDocument` の入力検証（重複・空・未知列）・`liftEnvelope`/`liftOperation` の未知データ・`adaptSnapshotStore.loadLatest` の再 parse（checksum）が黙って壊れる経路を残していないか。
6. **回帰**: 既存のファイル永続化（`persistenceDir`）・`restoreFrom`・seed・空文書の挙動が不変か。`SNAPSHOT_FORMAT_VERSION` 変更による既存 dev 永続化ディレクトリへの影響。
7. **テスト不足**: 上記で「テストが無いのに正しさを主張している」箇所（特に並行 submit・reconnect 中の server submit・bootstrap@0 と pending の組合せ）。

## 対象外（指摘不要）

- 仕様そのものの是非（U1〜U3 の API 形状は Human Spec Gate で確定済み。`createServer()` 案・`insertRows` を `submit` で受ける拡張・複数文書 U4・ブラウザー側で 401 を判別する手段）。
- consumer（松下）側の実装（Prisma スキーマ・投影規則・JWT 検証・無限ループ抑止）。
- ドキュメントの文言・表記・分量。features.json の説明文。
- `clientId` の申告維持（trusted internal の境界として意図的）。
- 既存コードの改善提案で DD-026 の差分に起因しないもの。

## 出力形式

- findings を **P1（データ喪失・非収束・認証すり抜け・起動不能）／P2（誤動作だが自己修復可・限定条件）／P3（改善）** で分類し、各 finding に `ファイル:行`・再現手順（or 反例シナリオ）・修正案を付ける。
- 到達性（実際の transport＝TCP・単一プロセス・`ws`）で起きるかを明記する（到達不能なら P3 か省略）。
- 問題が無い観点は「確認済み・問題なし」と一言で（紙面を仕様論に使わない）。
