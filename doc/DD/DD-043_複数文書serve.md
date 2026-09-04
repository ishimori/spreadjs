# DD-043: 複数文書 serve（N 枚固定・resolver 契約）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-04 | 2026-09-04 | 完了 | consumer 駆動（松下 納入計画③の共同編集化 = 松下 DD-014-3〔年度単位の board 切替〕）。要件正本は松下リポ `doc/DD/DD-014/sdk-requirements.md` **§D**（DD-012 要件票 §A の U4 を置き換え）。将来制約の正本は **ADR-0025**（**Accepted**・実装で確定した細目を追記）。**実装・全回帰 green。実機検証は松下 DD-014-3 側** |

> アプローチ: 標準（公開 API と protocol の設計判断が主。実装フェーズの分解と検証形は Phase 1 で確定）
> リスク: あり（公開 API・protocol・起動/復旧系 — 全 Phase）

```text
Risk Class: A（公開 API〔ServeOptions〕・protocol〔接続の文書指定〕・起動/復旧系に触れる）
Risk Triggers: 公開 API 変更 / protocol 変更 / 復旧経路の変更（起動時の検疫）
Human Spec Gate: required（resolver の形・接続の文書指定方法・検疫の通知形式が仕様判断）
Codex: high（実装完了後にユーザー指示で）
Manual Gate: 不要（本DDのクローズはブロックしない。SDK 側の成立は自動E2E〔2 board を実ブラウザーで独立編集〕で担保し、実機は松下 DD-014-3 の年度切替で確認する）
External Review: 候補（protocol 変更を含むため。要否はユーザー判断）
Evidence Level: standard
```

## 目的

1 プロセスで複数の文書（Book / board）を serve できるようにする。v1 は起動時に決めた N 枚固定。契約は「無限 Book」へ実装の入れ替えだけで到達できる resolver 形式にする（ADR-0025）。

## 背景・課題

- 松下③（納入計画）は年度単位の board 切替で共同編集化する（松下 D-008）。③の列は年度の日付そのもので、文書の列構成は起動時に固定されるため、年度ごとに別文書になる
- consumer の将来要望（2026-09-04・明示）: 複数の Excel Book を無限に同時編集できる仕組みへ育てたい。一方、見えている実需は「起動時に分かっている少数の文書」（③の 1〜2 年度・②の 3 シート）
- 現状 `serve()` は 1 documentId・1 columnOrder・単一 oplog/snapshotStore を起動時に固定。`/ws` は文書を指定できず、`/config` は唯一の文書を返す
- **起票時の実読メモ（松下側セッション）**: per-document 部品（`Room` / `Sequencer` / `PersistentRoom` / `RoomBridge`）は既に分離されており、`startServer` 内の一箇所で構築されている。consumer 側ストアと DB（松下 `sheet_oplog` / `sheet_snapshots`）は document_id で仕分け済み。`ServerInstance` に文書・列を後から変える口は無い

## 要件（§D の要旨 — 正本は松下リポ）

- **D1 複数文書 serve**: resolver 契約（documentId → columnOrder / oplog / snapshotStore / initialDocument）。v1 は固定リスト・未知 ID 拒否。既存の単一文書指定は後方互換
- **D2 接続時の文書指定**: WS と `/config` が documentId を受ける。無指定は単一文書構成の既定。将来の複数サーバー振り分けの routing キーを兼ねる
- **D3 起動時の検疫**: 復旧に失敗した文書だけ外して diagnostic で警告し、残りで立ち上がる。crash-only は維持。実行時の文書単位隔離は v1 スコープ外

## 検討内容（論点 — Phase 1 で確定）

| # | 論点 | 選択肢 | 起票時の当たり |
|---|------|--------|--------------|
| ① | resolver の API 形 | (a) `resolveDocument(id) => config \| null` の関数を受ける / (b) 固定配列を受け、関数形は将来追加 | (a)。無限 Book 化が実装差し替えで済む契約はこちら。固定リストは (a) の上の糖衣でよい（ADR-0025 決定1） |
| ② | 接続の文書指定の運び方 | (a) `/ws?documentId=...`（query） / (b) handshake frame | Phase 1 で実読して確定。authenticate hook との評価順序に注意 |
| ③ | 検疫の通知 | diagnostic（error）に加えて `/health` 等で外形可視化するか | Phase 1 で確定 |
| ④ | `onPermanentFailure` の意味 | 現状 = プロセス fail-stop 前提（consumer は crash-only 再起動） | v1 はプロセス単位を維持（ADR-0025 決定3）。文書単位の実行時隔離は将来の改訂 |

### Phase 1 の確定（実読 + Human Spec Gate 代行・2026-09-04）

> 実読: `packages/server-hono/src/{server.ts,index.ts,serve-types.ts}`／`packages/server/src/room.ts`／
> `packages/grid/src/mount-controller.ts`。ユーザー指示「迷ったら推奨案を選択」により下表で確定した。

| # | 確定 | 根拠 |
|---|------|------|
| ① | **(a) resolver 関数**。ただし v1 は D3（起動時の検疫）のため serve する集合を列挙できる必要があり、公開面は `documents = { documentIds, resolve, defaultDocumentId? }` の 1 オプションに束ねた | ADR-0025 決定1。無限 Book 化は `documentIds` を任意化して `resolve` を遅延呼び出しにする**追加**で到達でき、resolve の契約・protocol・既存 consumer は不変 |
| ② | **(a) `?documentId=`（query）**。`/ws` と `/config` の両方。無指定は `defaultDocumentId`（既定 `documentIds[0]`） | handshake frame 方式は upgrade 完了まで宛先 Room が決まらず「どの Room にも属さない接続」の TTL/後始末という新状態を作る。query なら upgrade 時点で確定し、前段プロキシの routing キーにもそのまま使える |
| ②' | **authenticate → 文書解決**の順（未知 ID でも認証が先） | 未認証の相手へ文書集合の存在を漏らさない。文書単位の認可は hook が `request.url` から行える |
| ②'' | join の申告 documentId 不一致は、**複数文書構成 or `?documentId=` 明示の接続でのみ 1008 切断**。従来の単一文書・無指定接続は受理し警告診断のみ（`document-mismatch`） | 不一致 join は他文書の envelope を oplog へ混ぜる汚染源。ただし後方互換（AC2）を優先し legacy 経路は落とさない |
| ③ | 診断 `document-quarantined`（error）＋ `ServerInstance.documentIds` / `quarantined`。**`/health` は `ok` のまま変えない** | `/health` の応答形式変更はプローブ側の破壊的変更。外形観測は「検疫文書への `/config`・`/ws` が 404」で足り、運用通知は consumer のログ基盤へ届く診断 hook が正道 |
| ④ | **v1 はプロセス単位の fail-stop を維持**（実行時の恒久失敗は現行どおり） | ADR-0025 決定3・4 |

**実読で追加確定した点**

- **検疫は複数文書構成だけ**。単一文書構成（`documents` 未指定）の復旧失敗は**従来どおり起動失敗（throw）**。1 枚しか無い構成で 0 文書 listen を始めると consumer が起動成功と誤認する（後方互換 AC2 も兼ねる）
- **全文書が検疫されても listen は続ける**（複数文書構成）。全接続 404 ＋診断 error。deterministic poison の再起動ループを防ぐという D3 の目的は「立ち上がること」自体にあるため
- **`ServerInstance.documentId`** は既定文書 ID（無指定接続の宛先）を返す。serve 中の集合は `documentIds`
- **クライアント（grid Facade）も文書を名乗る**: `mount({ documentId })` 指定時に `/config?documentId=`・`/ws?documentId=` を送る。これが無いと consumer は年度別 board へ接続できない
- **per-document 構成は現行の単一文書オプションと同義**（`columnOrder` / `seedRows` / `persistenceDir` / `oplog` / `snapshotStore` / `initialDocument`）。排他規則も文書ごとに同じ検証を通す（メッセージに `[documentId=x]` を挿入）
- **`restoreFrom` / `integrationDataset`（デモ・検査専用）は複数文書構成では提供しない**（公開 API ではないため consumer 影響なし）

## 受け入れ基準（起票時の当たり — Spec Gate で確定）

| # | 基準 | 検証方法 | 結果 |
|---|------|---------|------|
| 1 | 2 文書を 1 プロセスで serve し、それぞれ独立に収束する（文書間の操作・presence の漏れゼロ） | unit + E2E | ✅ `serve.documents.test.ts` M1（操作・revision・presence の分離）／E2E `multi-document.spec.ts`（2 board を実ブラウザーで交互編集し hash 不変を確認） |
| 2 | 既存の単一文書構成が無変更で動く（後方互換・全回帰 green） | 全回帰 | ✅ `npm test` 1,229 / `npm run test:e2e` 157 とも green（単一文書系スイートは無改変で通過） |
| 3 | 一方の文書の復旧失敗が他方の起動を妨げない（起動時の検疫 + 警告） | unit | ✅ M4（doc-b の oplog を毒し doc-a だけで起動・診断 error・検疫文書は 404）／M4b（全文書検疫でも listen 継続） |
| 4 | `/config`・WS 接続が documentId 指定で正しい文書に繋がり、未知 ID は拒否される | unit + E2E | ✅ M2（/config・/snapshot の 404）／M3（upgrade 404）／E2E（未知 ID は config error で停止・列構成が board ごとに解決される） |
| 5 | ADR-0025 を Accepted 判定（Human Spec Gate + レビュー） | Phase 1/3 | ✅ Accepted（実装で確定した細目を ADR へ追記） |

## タスク一覧

### Phase 1: 実読と仕様確定（Spec Gate）
- [x] `server.ts` / `index.ts` / `serve-types.ts` を実読し、論点①〜④と受け入れ基準を確定
- [x] ADR-0025 の内容を確定（実装後に Accepted・確定細目を追記）

### Phase 2: 実装
- [x] 公開型を追加（`ServeDocumentConfig` / `ServeDocumentResolver` / `ServeDocuments` / `ServeQuarantinedDocument`・`ServeSubmitOptions.documentId`）
- [x] `startServer` を「文書レジストリ＋文書ランタイム（Sequencer/Room/PersistentRoom/RoomBridge）」へ分解（単一文書構成は N=1 の同じ経路）
- [x] `/config`・`/snapshot`・`/ws` の `?documentId=` 対応（未知は 404）と upgrade の評価順序（authenticate →文書解決）
- [x] 起動時の検疫（複数文書構成のみ）＋診断 `document-quarantined` / `document-unknown` / `document-mismatch`
- [x] `RoomBridge` に文書 ID 検証（厳格接続は不一致 join を 1008 切断）・接続メタの一本化
- [x] Facade（`serve`/`ServerInstance`）に `documents` / `documentIds` / `quarantined` / 文書別 `connectionCount` / 宛先付き `submit`
- [x] grid Facade: `mount({ documentId })` 指定時に `/config?documentId=`・`/ws?documentId=` を送る
- [x] 検証資材: `serve.documents.test.ts`（M1〜M7）・`dev-multi-document.ts`＋`dev:multi-document`・playground `?doc=`・E2E `multi-document.spec.ts`（playwright webServer 追加・:8801）
- [x] ドキュメント: CHANGELOG / quick-start §3c / features.json（`multi-document`）/ ADR-0025 Accepted / DOC-MAP

### 完了前チェック
- [x] 受け入れ基準を 1 項目ずつ照合（上表）
- [x] 😈 セルフレビュー 1 巡
- [x] 🔬 全回帰 1 回: `npm test`（1,229 passed）/ `npm run typecheck` / `npm run lint`（boundary 新規違反 0）/ `npm run test:e2e`（157 passed）→ 全 green

## 既知の未保証境界

- **実機（consumer 実データ）での年度切替は未実施**。SDK 側は自動 E2E（2 board の独立編集）まで。松下 DD-014-3 の実機検証（2 ブラウザ収束・同一トランザクション投影・在庫/月計のサーバー起点算出）で確認する
- **文書数のスケール**: 検証したのは 2 文書。N 枚（数十以上）での起動時間・メモリは未計測（v1 の実需は 1〜3 枚）
- **実行時の文書単位隔離は未提供**: 1 文書の durable 恒久失敗は従来どおりプロセス単位 fail-stop（ADR-0025 決定3・改訂事項）
- **単一文書・`?documentId=` 無指定の接続では join の documentId 不一致を切断しない**（警告診断のみ）。後方互換を優先した意図的な緩和で、複数文書構成では切断する

## ログ

### 2026-09-04
- 起票（松下側セッションが代行。DD-026 / DD-035 / DD-036 / DD-039 と同じ運用。以後は spreadjs 側のセッションで進める）。要件出所: 松下 `doc/DD/DD-014/sdk-requirements.md` §D。番号は DD-042 の次で採番
- スコープの決め（consumer との壁打ち 2026-09-04）: v1 は N 枚固定 + 起動時の検疫。動的な部屋の作成・後片付け・実行時隔離は**使う consumer が現れるまで作らない**（③は 1〜2 枚・②は 3 シートで、いずれも起動時に既知）。ただし契約だけは無限 Book に整合させる → ADR-0025 を Proposed で同時起票
- 検証（松下 DD-014-3 側で実施予定）: 2 ブラウザ収束・同一トランザクション投影・在庫/月計のサーバー起点算出
- 実装・検証（spreadjs 側セッション・Opus）: Phase 1 の確定 → 実装 → 全回帰 green（`npm test` 1,229 / E2E 157）。ADR-0025 を Accepted 化し、実装で確定した細目（resolver と列挙の対・query 方式の根拠・評価順序・検疫の適用範囲・`/health` 不変）を ADR へ追記
- 公開 API 影響: `ServeOptions.documents` ほか型の**追加のみ**（既存シグネチャの破壊的変更なし）。`.d.ts` snapshot は更新（`npx vitest run tests/contract -u`）・CHANGELOG 記載済み
