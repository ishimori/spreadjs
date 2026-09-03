# Stage 2 社内SDK Beta DDロードマップ（Delivery Phase B）＝**正式版**

> **本ファイルは正式版**（2026-07-16・DD-023 で策定。Codex high レビュー P1×6/P2×4 全反映＋ユーザー承認で草案から昇格。ChatGPT 外部レビューはユーザー判断で省略）。
>
> **位置づけ**: Stage 1 SDK Alpha 達成（DD-018・2026-07-15・全CG終端）を受け、製品成熟 **Stage 2「社内SDK Beta」**（憲章 §15・Goal 1→2 の中間）到達までのデリバリー単位（**Delivery Phase B**）を DD へ写像する。`phase1-dd-roadmap.md`（Delivery Phase A）の後継。
>
> **入力**: `stage2-backlog.md`（Stage 1 送り項目・DD-018 確定）＋ 製品憲章 §15/§16.1/§26.3（Beta 要求）＋ consumer 戦略（DD-023 Phase 1 でユーザー確定・2026-07-16）。
>
> **番号**: Stage 1 予約分 DD-019〜022 は維持。Stage 2 の新規トップレベルは **DD-023〜032 で確定**（DD-023=本策定）。想定外DDは子DD `DD-NNN-M` で起票（letter 枝番禁止・Stage 1 §0 の運用を継承）。
>
> 正典との関係: 技術方式は開発計画書、製品目的・成熟段階は製品憲章、DD の現在状態は DD-INDEX。CG-1〜6 は全終端（`cg-ledger.md`）＝Stage 2 に持ち越す未解除 CG は無い。

## 0. Stage 2 移行条件ハードゲート（S2-1〜6）

> 憲章 §15「Stage 2：社内SDK Beta 移行条件」の全6条件を、DD-018 の先例（S1-1〜6）と同じくハードゲート化する。**DD-032（Stage 2 移行判定DD）はスコープ決定の場ではなく、下表を証拠で判定する場**。

| # | Stage 2 移行条件（憲章 §15） | 担保先（DD） | 判定証拠 |
|---|---|---|---|
| S2-1 | **2つ以上の異なる社内アプリで利用** | DD-026（**松下 生産納期**・当初の housing-e-kintai-next 売上入力から 2026-09-03 に変更＝§2）＋DD-030（ReadyCrew 案件DB） | 各アプリの統合実証（pack/registry 経由 install・直接内部 import なし・実画面で稼働） |
| S2-2 | 内部パッケージの直接 import がない | boundary lint 常設（既設 R1〜R7）＋DD-026/030 の consumer 側検証 | `npm run lint:boundary` green＋consumer 側 import 検査 |
| S2-3 | API 差分監視と移行ガイドがある | DD-028 | API 型スナップショット差分検出の常設（CI 実行履歴）＋migration guide の**存在と dry-run 検証**（破壊的変更の発生実績は要求しない＝憲章は存在を要求。発生した場合はその運用記録も添付） |
| S2-4 | 主要ブラウザー/IME 回帰が継続実行される | DD-028 | CI 常設の**成功履歴**（test・invariants・E2E）＋**変更トリガー時および Beta リリースゲートでの Tier 1 実機 IME 実行記録**（synthetic と実IMEを混同しない＝Stage 1 §2.3 継承） |
| S2-5 | Testkit・診断ログ・サンプルが整備される | DD-029 系＋各機能DDの DX 成果物 | Testkit 初版・診断 API/error code の拡充・**構造化診断ログ（機密セル値の非出力・trace export＝憲章 §17.1 対応）**・consumer 別サンプル |
| S2-6 | 主要 Plugin/Adapter 境界が実案件で検証される | DD-026（保存 Adapter・認証境界）＋DD-027/030（Cell type 相当＝列タイプ） | 実案件での Adapter/Plugin 配線証拠＋**fork 発生の記録と分析**（fork ゼロ判定は Stage 3 条件＝§4 R2 へ。Stage 2 の合格条件にしない） |

**あわせて Beta までに処理する憲章要求**: KPI 正式化（§16.1→DD-029）・deprecation policy（§18.3/P-10→DD-028）・bundle size budget（§26.3→DD-031）・docs site（§26.3→DD-029・既存 apps/showcase を基盤に）。

## 1. 縦切りDD一覧（Stage 2）

> 順序原則（DD-023 要確認④・ユーザー確定）: **consumer 要件起点**。統合①（DD-026）の要件調査が機能DD群の順序を確定する**変化点**。

| DD | 縦切り（利用者成果） | 支配的リスク | Risk Class | Stage 2区分 | S2ゲート |
|---|---|---|---|---|---|
| **DD-023** | **Stage 2 ロードマップ策定**（本DD） | 計画判断 | A | 必須（先頭） | — |
| **DD-024** | **単独グリッドモードDD**（collaboration: false の成立・保存＝利用側 API 接続契約・lifecycle 検証。憲章 §11.1 の実証） | 未実証経路・公開 Options/Capabilities | A | **必須**（統合①の前提） | S2-6 |
| **DD-025** | **React Facade DD**（`@nanairo-sheet/react`・React 19 対応・lifecycle/props-event 変換・グリッド内部状態を React state へ複製しない〔憲章 §11.2〕） | 公開 API 新設・再 mount リーク | A | **必須**（roadmap §7 昇格条件成立: 最初の consumer が React） | S2-1 |
| **DD-026** | **consumer 統合①: 松下 生産納期**（保存 Adapter＝ストア注入・初期文書／認証境界＝認証フック／サーバー起点操作。**共同編集モードを採用**。当初の housing-e-kintai-next 売上入力から 2026-09-03 に変更＝§2） | 実案件統合・Adapter 境界 | A | **必須** | S2-1・S2-2・S2-6 |
| **DD-020** | Clipboard DD（範囲選択・parser・型変換・原子 SetCells・OCC・Undo）〔Stage 1 予約番号〕 | Clipboard 原子性・競合 | A | **必須見込み**（大量明細入力の中核。DD-026 要件調査で確定） | — |
| **DD-021** | 行操作DD（RowId・Insert/Delete・tombstone・座標・収束。K3/K4/P2-1 回収。起票時 DD-021-1〜3 に3分割）〔Stage 1 予約番号〕 | 行操作×収束×参照 | A | **必須**（K3/K4/P2-1 の Stage 2 回収は DD-018 で確定済み＝consumer 要件と独立。要件調査で変わるのは**着手順序のみ**） | — |
| **DD-027** | **列タイプ体系DD**（アンブレラ。子: 27-1 選択式入力列・27-2 ハイパーリンク列・27-3 セル書式モデル〔背景色/バッジ・列/セル書式・backlog §3.5 統合〕。Human Spec Gate 必須） | 新アーキテクチャ概念（列タイプ・書式モデル）・Plugin API v1 の実質プロトタイプ | A | **必須**（ReadyCrew 要件・P-07 判断材料） | S2-6 |
| **DD-028** | **継続回帰CI・API差分監視DD**（CI 常設・API 型スナップショット差分・migration guide 運用・deprecation policy=P-10） | 回帰検出の継続性 | B | **必須**（早期並行開始可） | S2-3・S2-4 |
| **DD-029** | **DX・診断・KPI DD**（アンブレラ・**子DD構成を本ロードマップで確定**〔過積載防止・DD-005/009 の教訓〕: **29-1 KPI 計測契約**〔計測項目・開始終了条件・記録先＝§16.1。**DD-026 開始前に確定**〕・**29-2 Testkit 初版**・**29-3 診断/テレメトリ**〔構造化診断ログ・P-12〕・**29-4 docs site**〔showcase 拡張〕） | DX・計測 | B（子DDごとに再判定） | **必須** | S2-5 |
| **DD-030** | **consumer 統合②: ReadyCrew 案件DB**（商談進捗パイプライン・列タイプ実案件検証。**開始前提=P-07 判断ゲート通過**〔§2〕） | 2案件目・Plugin 境界 | A | **必須**（S2-1 成立条件） | S2-1・S2-6 |
| **DD-031** | **配布昇格DD**（private registry 昇格・dist ビルド配布切替・チャネル運用・bundle size budget・versioning 正式化=P-06・**命名ゲート決定〔P-01/P-14・§2〕の反映作業**） | 配布の不可逆決定 | A | **必須**（Beta 宣言前） | — |
| **DD-032** | **Stage 2 移行判定DD**（S2-1〜6 の合否判定のみ・**Stage 3 バックログ確定**〔DD-018 先例〕） | マイルストーン判定 | A | **必須（最後）** | 全S2 |
| DD-019 | Presence DD（activeCell/selection/editingCell・overlay・TTL）〔Stage 1 予約番号〕 | Presence | B | **条件付き**（共同編集採用案件の確定がトリガー。現 consumer 2件は単独グリッド/未定のため着手保留） | — |
| DD-022 | 数式DD（四則・参照・SUM・依存グラフ・replay 決定性）〔Stage 1 予約番号〕 | 数式評価・決定性 | A | **要件判定**（売上入力/ReadyCrew 要件に無ければ Stage 3 バックログへ送る判断を DD-026 要件調査後に行う） | — |

## 2. 順序・依存（consumer 要件起点）

```text
DD-023 ロードマップ策定（本DD）
  → 【命名ゲート】P-01 製品名・P-14 repo 名のユーザー決定（**DD-025 起票前**。公開パッケージ名/npm scope/import 文に波及するため consumer 統合前に確定＝後回しにすると consumer 2件の再移行が発生。反映作業は DD-031）
     **→ 通過済み（2026-07-16）**: P-01=Nanairo Sheet 正式確定・P-14=`nanairo-sheet` へ変更決定（`doc/decisions.md` D-005・リネーム実施=DD-031）
  → DD-024 単独グリッドモードDD（統合方式の成立）
  → DD-025 React Facade DD
  → DD-029-1 KPI 計測契約（計測項目・開始終了条件・記録先のみ先行確定＝統合①の初回データ〔統合工数・初回表示時間〕は一度しか採れない）
  → DD-026 consumer 統合①開始（売上入力の要件調査 ＝ 機能DD順序の変化点。KPI 採取開始〔契約=kpi-ledger.md・DD-029-1〕）
      → 機能DD群（要件起点で**順序**確定。想定順: DD-020 Clipboard → DD-021 行操作〔3分割・Stage 2 必須は固定〕 → DD-027 列タイプ体系）
      → DD-022 数式は要否判定（無ければ Stage 3 送り）
  ∥ 並行: DD-028 CI・API差分監視（DD-024 と同時に開始可・早いほど回帰防御が効く）
  → 【P-07 判断ゲート】ReadyCrew 事前要件調査＋DD-027 実績を材料に Plugin API v1 範囲を判断（**DD-030 起票前の独立ゲート**＝DD-030 の中で判断しない。憲章 §13.2「複数実案件の共通要求を確認するまで確定しない」と整合）
  → DD-030 consumer 統合② ReadyCrew
  → DD-029-2〜4 Testkit・診断/テレメトリ・docs site（統合②と並行可）
  → DD-031 配布昇格（registry/dist/versioning・命名ゲート決定の反映作業）
  → DD-032 Stage 2 移行判定（S2-1〜6 合否・Stage 3 バックログ確定）
```

- **中間チェックポイント**（DA 指摘 Phase 1-#3）: DD-026 完了時に「統合②（ReadyCrew）の開始可否」を確認する。開始不能なら代替 consumer 候補の探索を DD-030 の先頭タスクへ差し替え、S2-1 未達リスクをユーザーへ提示する。
- **housing 側の移行順序リスク**（DA 指摘 Phase 1-#1）: 売上入力画面は housing 側移行計画書の PoC 候補（歩合計算/勤怠入力）に無い。DD-026 先頭の要件調査で組み込み時期を先方計画と突合し、ズレる場合は機能DD群を先行させる（順序入替は本ロードマップの更新として記録）。
- **順序入替の記録（2026-07-16・ユーザー決定＝上記分岐の発動）**: SDK 機能完成を優先し、**機能DD群（DD-028 → DD-020 → DD-021〔3分割〕→ DD-027〔子3本〕）を DD-026（統合①）より先行**させる。DD-022 数式のみ要件判定待ちを維持（推測で先行しない）。DD-026 は機能DD群完了後に復帰し、KPI 初回データ（KPI-4/5）の採取は DD-026 実施時のまま（kpi-ledger 契約は不変）。
- **consumer ① の変更（2026-09-03・ユーザー決定・D-007）**: 統合①の consumer を housing-e-kintai-next（売上入力・単独グリッド先行）から **松下 生産納期**（`C:/repo/matsushita-production-management` DD-012。React 19 + Hono + Prisma + PostgreSQL・JWT Cookie）へ変更。松下側で **共同編集が最重要要件**となり、SDK 側に無い 3 つの口（U1 永続化ストアの差し替え・初期文書／U2 認証フック／U3 サーバー起点操作）を DD-026-1〜3 で公開 API として追加した。**KPI-4 は採取不能**（松下は DD-009 で単独グリッドを導入済み＝初回導入でない。kpi-ledger §3.1 に理由を記録し統合②で採取）。§6「共同編集は Stage 2 の consumer 2 件で採用しない」は本変更で更新（下記）。DD-027（列タイプ）の要件も松下から持ち込み済み（`doc/DD/DD-026/consumer-requirements-matsushita.md` §B）。

## 3. 密度レジーム（Stage 1 §2 を継承）

- Risk Class A/B/C・Human Spec Gate・B/C→A 昇格ルール・証跡5点圧縮は `phase1-dd-roadmap.md` §2 を**そのまま継承**（運用コピー元: `dd-risk-class-header.md`）。
- Stage 2 固有の追加: **列タイプ体系（DD-027）は Human Spec Gate 必須**（stage2-backlog §3.6 の判定を維持＝設計判断が要る規模）。統合DD（DD-026/030）は実機・実アプリゲートを持つため Manual Gate を必ず記載。
- 全CG終端済みのため「未解除CG例外」は Stage 2 では発動しない。ただし **IME 不変条件・共同編集不変条件・性能予算（§2.3 ガードレール）は常設のまま**＝DD-028 で CI へ載せて継続実行化する。

## 4. Stage 3 準備条件（逆算・Stage 2 の終わりをブレさせないための仕込み）

> 憲章 §15 Stage 3（実案件採用・Goal 2: 3件以上・fork なし・SLO 運用）の移行条件から逆算し、**Stage 2 のうちに仕込まないと Stage 3 で詰む項目**。DD-032 の判定対象ではないが、Stage 3 バックログの種として DD-032 が確定時に棚卸しする。

| # | Stage 3 移行条件（憲章 §15） | Stage 2 中に仕込む物 | 担当 |
|---|---|---|---|
| R1 | 案件固有要件の大半を設定/Command/Event/Adapter/Plugin で実現 | **Plugin API v1 範囲の決定（P-07・期限=2案件目開始前）**。列タイプ体系（DD-027）を Cell type plugin の実質プロトタイプとして設計し、P-07 判断ゲート（§2・DD-030 起票前）で v1 範囲を判断 | DD-027→P-07 判断ゲート |
| R2 | 重大なコア fork がない | consumer 統合①②で fork 発生を計測（憲章 §16.1 KPI）・fork が必要になった時点で拡張点不足として ADR 起票 | DD-026/030・DD-029 |
| R3 | SLO・障害対応・アップグレード手順が運用できる | 運用 runbook 雛形（起動/復旧/バックアップ手順・error code 対応表）・アップグレード手順は migration guide 運用（S2-3）で実績を作る | DD-028/029 |
| R4 | 利用者フィードバックに基づく API 見直し | API 差分監視＋consumer 2件のフィードバック記録を DD-032 で棚卸し→Stage 3 バックログへ | DD-028・DD-032 |
| R5 | 3件以上で本番または限定本番利用 | 3件目の candidate 探索は Stage 2 スコープ外（推測で計画しない）。DD-032 が Stage 3 バックログとして確定 | DD-032 |

詳細は `stage3-outlook.md`（薄い展望書・ロードマップ化は Stage 2 移行判定後）。

## 5. 未決定事項の処理（憲章 §27 期限到来分）

| ID | 未決定事項 | 期限（憲章） | 本ロードマップでの処理 |
|---|---|---|---|
| P-01 | 正式製品名 | Stage 1 リリース前（**超過**） | **決定済（2026-07-16・命名ゲート通過）**: Nanairo Sheet を正式製品名として確定（D-005）。scope/クラス名は変更なし |
| P-14 | リポジトリ名称変更（`spreadjs`→） | Stage 1 Alpha 前（**超過**） | **決定済（2026-07-16）**: `nanairo-sheet` へ変更（D-005）。**リネーム実施=DD-031**（ローカルパス・スクリプト・並行セッションへ波及するため配布昇格と同時に一括反映） |
| P-06 | versioning 方式 | Stage 2 前 | 現行 lockstep を暫定継続し、**DD-031 で正式化**（§18.1「Stage 2 では Facade を互換性管理対象へ」を含む） |
| P-10 | 非推奨期間 | Stage 2 前 | **決定済（2026-07-16・DD-028）**: 成熟度3層の deprecation policy を確定（0.x=CHANGELOG 必記＋型 snapshot 同伴／Beta=最低1 minor かつ 30日 かつ全統合 consumer 移行確認／Stable=major のみ・90日予告。正本 `doc/product/deprecation-policy.md`・D-006） |
| P-12 | Telemetry 標準 | Stage 2 前 | **DD-029**（opt-in Adapter 候補の方針決定。汎用テレメトリ基盤=backlog §2 の回収先） |
| P-07 | Plugin API v1 範囲 | 2案件目開始前 | **P-07 判断ゲート（§2・DD-030 起票前の独立ゲート）で判断**（材料=DD-027 実績＋ReadyCrew 事前要件調査。DD-030 の成果物にしない） |

## 6. Beta 製品境界（Stage 1 §6 からの差分）

- **対応環境**: Tier 1（Win Chrome/Edge）継続。Tier 2 拡大（macOS 等）は Stage 2 では**行わない**（consumer 2件の実利用環境が Tier 1 内であることを DD-026/030 で確認。外れる場合のみ再判定）。
- **信頼境界**: trusted internal environment 限定を継続。単独グリッドモード（DD-024）では認証・保存の責務は**全面的に利用側アプリ**（SDK は Command/Event 契約のみ）。
- **共同編集**: ~~Stage 2 の consumer 2件では採用しない（単独グリッド/未定）~~ → **2026-09-03 更新**: 統合①（松下 生産納期）が**共同編集を採用**（§2 consumer ① の変更）。共同編集経路の品質は Stage 1 資産（不変条件・E2E）を CI（DD-028）で回帰維持する。条件付き項目のトリガー「共同編集採用案件の確定」は**成立**: Presence（DD-019）の着手判断はユーザーへ提示（本ロードマップは順序を確定しない）。PostgreSQL は SDK 内蔵の本採用ではなく **consumer 側ストア注入（DD-026 U1）**で実現する形になったため、SDK 内蔵 PG ストアの要否は DD-032 の棚卸しで判断する。
- **信頼境界（共同編集・2026-09-03 追記）**: 認証は利用側（`authenticate` フック）が担い、SDK は受理 envelope の `actorId` と presence の身元を認証結果で確定する。`clientId` は申告維持（再接続同一性）＝trusted internal の境界は継続。
- **数式**: DD-026 要件調査まで未確約（§1 DD-022 行）。

## 7. stage2-backlog.md との対応（全項目の回収先）

| backlog 項目 | 回収先 |
|---|---|
| §1 DD-019 Presence | 条件付き着手（§1・共同編集採用案件確定がトリガー） |
| §1 DD-020 Clipboard | 機能DD群 先頭想定（DD-026 要件調査で確定） |
| §1 DD-021 行操作（3分割） | 機能DD群（同上。K3・K4・P2-1 を回収） |
| §1 DD-022 数式 | 要件判定（無ければ DD-032 で Stage 3 バックログへ） |
| §2 dist ビルド配布切替 | DD-031 |
| §2 private registry 昇格 | DD-031 |
| §2 PostgreSQL 本採用 | 条件付き（共同編集採用案件確定まで保留・成立しなければ Stage 3 バックログへ）→ **2026-09-03: 松下で共同編集採用。SDK は DD-026 U1（ストア注入）で Postgres を consumer 側実装に委ねる形で提供。SDK 内蔵 PG ストアの要否は DD-032 で棚卸し** |
| §2 React 薄ラッパー Facade | **DD-025（必須化確定**・最初の consumer が React 19） |
| §2 複数配布チャネル運用 | DD-031（単一チャネル継続か複数化かを配布昇格時に判定） |
| §2 汎用診断/テレメトリ基盤 | DD-029（P-12） |
| §3 K3・K4・P2-1 | DD-021（行操作） |
| §3.5 列幅・行高・wrap の全ユーザー共有 | DD-027-3 で**設計整合まで実施**＋実装（Operation 化・snapshot 拡張）は**発火条件付き**（共同編集採用案件の確定で実装子DDを採番）。Stage 2 中に不成立なら **DD-032 が Stage 3 バックログへ登録**（宙吊りにしない） |
| §3.5 セル単位の書式モデル | DD-027-3 |
| §3.5 ダブルクリック auto-fit | DD-027 配下の C 級タスク（リサイズ延長） |
| §3.6 選択式入力列 | DD-027-1 |
| §3.6 ハイパーリンク列 | DD-027-2 |
| §3.6 背景色・バッジ表示 | DD-027-3 |
| §4 境界化項目（CG-4/CG-6/K9） | 変更なし（§6 で境界を継続明示） |

## 8. 見積・密度計測

- Stage 1 実績: DD-009〜018（子DD含め約20本）を 2026-07-12〜07-15 で完走（単独＋AIエージェント・密度レジーム §2 運用）。
- Stage 2 は実案件統合（先方都合・実機ゲート・人手確認）が律速のため**固定週数を置かない**。DD-026/030 の Manual Gate 正味人手見積を各DD起票時に明示する（`manual-gate-scope-calibration` の教訓＝水増しせず正味で）。
  - **ただし Manual Gate は DD のクローズをブロックしない**（2026-09-03 決定・`dd-risk-class-header.md`「Manual Gate の扱い」）。未実施でもクローズし、未確認範囲を `## 既知の未保証境界` へ移送して次のDDへ進む。実機ゲート待ちで DD を「確認待ち」に滞留させない（DD-020/021 の6週間滞留が根拠）。
- 密度計測（人間確認時間・Codex 回数・手戻り）は Stage 1 §2.4 の運用を継続。

---

> 次アクション: DD-024（単独グリッドモードDD）から起票。並行して命名ゲート（P-01/P-14・§2）の検討を開始（期限=DD-025 起票前）。各DDは Risk Class ヘッダ（`dd-risk-class-header.md`）・S2 ゲート・§6 Beta 製品境界を満たす。
