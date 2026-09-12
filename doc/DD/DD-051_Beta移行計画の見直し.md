# DD-051: Beta 移行計画の見直し

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-12 | 2026-09-12 | 検討中 | 論点1（Tier 1 IME を Microsoft IME のみ）はユーザー決定済み。論点2〜10 は Human Spec Gate 待ち |

```text
Risk Class: A
Risk Triggers: Stage 2 移行条件（S2 ゲート）と対応環境（Tier 1）の受け入れ条件を変更する計画判断（自動試験で判定不能）
Human Spec Gate: required（論点 2〜10。論点 1 は 2026-09-12 ユーザー決定済み）
Codex: high（文書のみ。完了後にユーザー指示で実行）
Manual Gate: あり・クローズ非ブロック（M1 = Google 日本語入力の現状確認・Tier 2 の任意確認）
External Review: 対象（Stage 移行条件の変更。ChatGPT レビューは手動運用ポリシーに従いユーザー判断）
Evidence Level: standard
```

> アプローチ: 標準（コード変更を伴わない計画・正典文書の改定のため）
> リスク: なし（認可・DBスキーマ・外部I/F・機密情報に触れない）
> 採番注記: Stage 2 の予約番号（DD-029-2〜4・DD-030〜032）の扱い自体を見直すため、横断の見直しとして新規トップレベル DD-051 で起票（DD-033 の先例）。

## 目的

Stage 2（社内 SDK Beta）のゲートを、策定時（DD-023）の想定体制ではなく現在の体制と consumer の実態に合わせて再較正し、Alpha から Beta へ進むために残る作業を確定する。決定済みの Tier 1 IME の縮小を正典文書へ反映する。

## 背景・課題

- ゲートは製品憲章 §15/§16.1/§23 をもとに、別チームの人間の開発者が組み込む体制を想定して決めた。現在は SDK と consumer を同じ 1 人＋AI エージェントが開発し、consumer 2 件は商談用デモ。前提の差と各ゲートの充足状況は [beta-gap-analysis.md](DD-051/beta-gap-analysis.md)
- 2 件目の consumer に予定した ReadyCrew（DD-030）は SDK を使っておらず、着手前に P-07 判断ゲートがある。一方、広島空港が 2026-09-12 に共同編集で SDK を統合した
- 未着手の Beta 条件のうち、構造化診断ログ・docs site・時間系 KPI は現体制で受益者がいない。Testkit は、実在する consumer（広島）が非公開の test-support に依存している矛盾を抱える
- Tier 1 IME の Google 日本語入力は憲章の「初期候補」由来で、実機確認は PoC の 1 回のみ。Beta リリースゲート T2 のブロッカーになっていた
- 経緯: 2026-09-12 のセッションで「Beta を早めるには」「判断不要な作業は本当に必要か、元の決定は正しかったか」「Google 日本語入力は必須か」をユーザーと検討した結果を本DDに記録する

## 検討内容（Human Spec Gate）

| # | 論点 | 選択肢 | 推奨と理由 |
|---|------|--------|-----------|
| 1 | Tier 1 IME | (a) Microsoft IME＋Google 日本語入力（現行） / (b) Microsoft IME のみ・Google 日本語入力は Tier 2 / (c) Microsoft IME のみ・Google 日本語入力は対象外 | **(b)・決定済み**。Google 必須は憲章の初期候補の引き継ぎで技術根拠がない。DD-028 Codex P2-2 は宣言と検証の不整合の指摘で、宣言を狭めても解消する。エディターは IME の種類に依存しない設計。Tier 2（主要機能を検証するが同日修正は保証しない）は対象外より正直 |
| 2 | Beta を宣言する目的 | (a) 近く他チーム・顧客へ安定性を示す必要がある → Beta を目指す / (b) 当面その必要はない → alpha を継続し、必要が生じた時点で本計画を再開 | **ユーザー判断**。Beta 以降は公開 API の非互換変更に「1 minor 共存・30 日・全 consumer 移行確認」が課され開発速度に効く。consumer が全て同一開発者のリポジトリの間は受益者がいない。(b) でも論点 1・5 と M1 は価値がある |
| 3 | 統合②（S2-1/S2-6）の consumer | (a) ReadyCrew 維持（DD-030） / (b) 広島空港へ差し替え（D-007 と同じくロードマップ更新） | **(b)**。S2-1 の判定証拠は「tarball 経由 install・内部 import なし・実画面で稼働」で本番利用を求めない（松下も商談デモで扱いが揃う）。ReadyCrew は本番稼働アプリのため Stage 3 候補（roadmap §4 R5）へ移す |
| 4 | P-07 Plugin API v1 範囲 | (a) Beta では登録 API を公開せず宣言的 mount オプションを継続 / (b) Beta 前に v1 API を設計 | **(a)**。憲章 §13.2「複数実案件の共通要求を確認するまで確定しない」と整合し、DD-027 の判断材料メモで閉じられる |
| 5 | Testkit（S2-5・DD-029-2） | (a) Testkit 初版を新規作成 / (b) grid の test-support を Experimental 公開面として宣言する（型 snapshot に載せる・React handle から到達できるようにする・consumer 検証の不合格条件から外す） | **(b)**。需要は広島 E2E で実在し、今は非公開契約への依存のため内部変更が予告なく consumer を壊す。新製品は不要 |
| 6 | 構造化診断ログ・trace export（S2-5・DD-029-3・P-12） | (a) Beta 前に実装 / (b) 既存の診断フック＋エラーコード一覧で S2-5 を充足とし、診断メッセージへの機密セル値混入の点検だけ行う。本体は Stage 3 | **(b)**。consumer の診断要望は具体的な口で、機能DDの単位で扱えた。汎用ログは本番の障害対応（Stage 3 条件）で価値が出る |
| 7 | docs site（憲章 §26.3・DD-029-4） | (a) 作る / (b) 紹介サイト（`apps/showcase`）＋quick-start で代替 | **(b)**。現在の読者は AI エージェントで、Markdown とソースで伝達が成立している。他チームの人間が読む段階で再検討 |
| 8 | KPI（S2-5・kpi-ledger） | (a) 現契約維持 / (b) 時間系（KPI-4/5）は記録のみへ格下げし、KPI-1（コア無変更導入）と fork 記録を正式に残す。consumer フィードバックは要件メモを参照 | **(b)**。AI が組み込む体制では時間系 KPI はエージェントの速さを測り判断材料にならない。台帳の実データは「採取不能」の 1 行のみ |
| 9 | 配布昇格（DD-031）の範囲 | (a) 現行（registry 昇格・dist 切替・versioning・bundle size budget・リポジトリ名変更） / (b) versioning 正式化（P-06）＋bundle size budget のみ。registry・dist 切替・リポジトリ名変更は Stage 3 以降 | **(b)**。registry とアクセス管理は憲章上 Stage 4 の条件で、社内 Beta 要件（§26.3）にない。リネームは並行セッションとローカルパスへ波及する不可逆作業 |
| 10 | consumer 駆動の機能DDとゲート作業の優先 | (a) 従来どおり consumer 要望を即時優先 / (b) alpha 配布は続けつつ、Beta を目指す間はゲート作業を優先 | **論点 2 が (a) の場合のみ (b)**。DD-045〜050 は consumer に役立ったが S2 ゲートを進めていない |

## 決定事項

- 論点 1: (b) を採用（2026-09-12・ユーザー決定）。Phase 2 で正典文書へ反映する
- 論点 2〜10: Human Spec Gate 後に本節へ記録する（推奨と異なる判断は理由を 1 行添える）

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | 論点 2〜10 の結論が決定事項に記録され、推奨と異なる判断には理由がある | Phase 1 目視 |
| 2 | 憲章 §20.2 の Tier 1 IME が Microsoft IME のみで、Google 日本語入力は Tier 2 候補にある。計画書 §11.8・§20.5 に「Tier 区分は憲章 §20.2 が正」と注記されている | Phase 2 grep |
| 3 | IME 実機台帳の §1 T2 行と §2 が Microsoft IME のみを必須とし、Google 日本語入力は Tier 2 の任意確認になっている | Phase 2 grep |
| 4 | `doc/decisions.md` に Tier 1 IME 縮小の決定（背景・決定・帰結・再検討条件）が追加されている | Phase 2 目視 |
| 5 | quick-start の対応環境の行が Microsoft IME を明記している | Phase 2 grep |
| 6 | `doc/plan/phase2-dd-roadmap.md` の S2 ゲート表・§1・§2・§5・更新記録が論点 2〜10 の決定を反映し、各 S2 条件に担保先 DD または充足済みの証拠がある | Phase 2 目視＋doc-check |
| 7 | 決定で扱いが変わる `kpi-ledger.md`・`stage3-outlook.md`・`stage2-backlog.md` の箇所が同期している（該当なしならログに明記） | Phase 2 目視 |
| 8 | 文書の整合チェックが通る | `bash scripts/doc-check.sh` → OK |

## タスク一覧

### Phase 1: 仕様確認（Human Spec Gate）
- [ ] 論点 2 を最初に確定する。(b) の場合、論点 3〜10 は「Beta 再開時の推奨」として記録し、実施は論点 5 と M1 に絞る
- [ ] 論点 3〜10 を確定し、決定事項へ記録
- [ ] 🔬 機械検証: `bash scripts/dd-health.sh --dd DD-051 --new` → ⚠️なし／`bash scripts/doc-check.sh` → OK

### Phase 2: 正典文書への反映
- [ ] 論点 1（決定済み・Phase 1 を待たずに着手可）: `doc/product/nanairo_sheet_product_charter_v1.md` §20.2 の Tier 1 から Google 日本語入力を外して Tier 2 候補へ移す／`doc/plan/ime-manual-gate-ledger.md` §1 T2 行と §2 を Microsoft IME のみ必須へ／`doc/decisions.md` に D-008 を追加／`doc/quick-start.md` 対応環境の行に Microsoft IME を明記／`doc/plan/nanairo_realtime_spreadsheet_development_plan_v1.md` §11.8・§20.5 に注記
- [ ] 論点 2〜10: `doc/plan/phase2-dd-roadmap.md`（§0・§1・§2・§5・§6・更新記録）、`doc/plan/kpi-ledger.md`（論点 8）、`doc/plan/stage3-outlook.md`（Stage 3 へ送る項目）へ反映。実装を伴う論点（5・6 の点検・9）は担保先 DD として記録し、本DDでは実装しない
- [ ] 🔬 機械検証: `grep -n "Google" doc/product/nanairo_sheet_product_charter_v1.md doc/plan/ime-manual-gate-ledger.md doc/quick-start.md` → Tier 1 に Google 日本語入力が残っていない／`bash scripts/doc-check.sh` → OK

### 完了前チェック
- [ ] 受け入れ基準 1〜8 を照合（未達成があれば理由をログへ）
- [ ] 😈 セルフレビュー1巡（重点: 決定が憲章・roadmap・台帳の間で矛盾していないか／担保先の無い S2 条件が残っていないか）
- [ ] 🔬 全回帰1回: 文書のみのため `bash scripts/doc-check.sh`・`bash scripts/dd-health.sh --dd DD-051` → OK（コード変更なしのため npm 系は対象外）

## Manual Gate（クローズ非ブロック・正味）

| # | 項目 | 正味 |
|---|------|------|
| M1 | Google 日本語入力をインストールし（ユーザー）、IME 実機台帳 §2 の S1〜S5 を Chrome で Claude 代行実行（OS SendInput 経由・engineering-patterns #9）。結果を台帳 §3 へ「Tier 2 任意確認」として記録 | 約 15 分 |

未実施でクローズする場合は、「Google 日本語入力での実機確認は PoC の 1 回のみ」を既知の未保証境界へ移送する。

## ログ

### 2026-09-12
- DD作成。同日のセッションでの検討（Beta を早める施策 → 判断不要な作業の必要性 → Google 日本語入力の必須性）を記録。調査結果は [beta-gap-analysis.md](DD-051/beta-gap-analysis.md)
- 論点 1（Tier 1 IME を Microsoft IME のみ・Google 日本語入力は Tier 2）をユーザーが決定
- 画面を伴う実装 Phase なし（Playwright MCP の確認は対象外）
