# DD-043: 複数文書 serve（N 枚固定・resolver 契約）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-04 | 2026-09-04 | 検討中 | consumer 駆動（松下 納入計画③の共同編集化 = 松下 DD-014-3〔年度単位の board 切替〕）。要件正本は松下リポ `doc/DD/DD-014/sdk-requirements.md` **§D**（DD-012 要件票 §A の U4 を置き換え）。将来制約の正本は **ADR-0025**（Proposed・同時起票）。**未着手（起票のみ・松下側セッションが起票代行）** |

> アプローチ: 標準（公開 API と protocol の設計判断が主。実装フェーズの分解と検証形は Phase 1 で確定）
> リスク: あり（公開 API・protocol・起動/復旧系 — 全 Phase）

```text
Risk Class: A（公開 API〔ServeOptions〕・protocol〔接続の文書指定〕・起動/復旧系に触れる）
Risk Triggers: 公開 API 変更 / protocol 変更 / 復旧経路の変更（起動時の検疫）
Human Spec Gate: required（resolver の形・接続の文書指定方法・検疫の通知形式が仕様判断）
Codex: high（実装完了後にユーザー指示で）
Manual Gate: 未定（Phase 1 で判定）
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

**まだ実装していない。上記は起票時の当たりであり、Phase 1 の実読と Human Spec Gate で確定する。**

## 受け入れ基準（起票時の当たり — Spec Gate で確定）

| # | 基準 | 検証方法 |
|---|------|---------|
| 1 | 2 文書を 1 プロセスで serve し、それぞれ独立に収束する（文書間の操作・presence の漏れゼロ） | unit + E2E |
| 2 | 既存の単一文書構成が無変更で動く（後方互換・全回帰 green） | 全回帰 |
| 3 | 一方の文書の復旧失敗が他方の起動を妨げない（起動時の検疫 + 警告） | unit |
| 4 | `/config`・WS 接続が documentId 指定で正しい文書に繋がり、未知 ID は拒否される | unit + E2E |
| 5 | ADR-0025 を Accepted 判定（Human Spec Gate + レビュー） | Phase 1/3 |

## タスク一覧

### Phase 1: 実読と仕様確定（Spec Gate）
- [ ] `server.ts` / `index.ts` / `serve-types.ts` を実読し、論点①〜④と受け入れ基準を確定
- [ ] ADR-0025 の内容を確定（Proposed のまま実装へ・Accepted 判定は完了時）

### Phase 2: 実装
- [ ] （Phase 1 で分解する）

### 完了前チェック
- [ ] 受け入れ基準を 1 項目ずつ照合
- [ ] 😈 セルフレビュー 1 巡
- [ ] 🔬 全回帰 1 回: `npm test` / `npm run typecheck` / `npm run lint` / `npm run test:e2e` → 全 green

## ログ

### 2026-09-04
- 起票（松下側セッションが代行。DD-026 / DD-035 / DD-036 / DD-039 と同じ運用。以後は spreadjs 側のセッションで進める）。要件出所: 松下 `doc/DD/DD-014/sdk-requirements.md` §D。番号は DD-042 の次で採番
- スコープの決め（consumer との壁打ち 2026-09-04）: v1 は N 枚固定 + 起動時の検疫。動的な部屋の作成・後片付け・実行時隔離は**使う consumer が現れるまで作らない**（③は 1〜2 枚・②は 3 シートで、いずれも起動時に既知）。ただし契約だけは無限 Book に整合させる → ADR-0025 を Proposed で同時起票
- 検証（松下 DD-014-3 側で実施予定）: 2 ブラウザ収束・同一トランザクション投影・在庫/月計のサーバー起点算出
