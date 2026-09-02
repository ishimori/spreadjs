# 意思決定記録（ADR-light）

> 長寿命のアーキテクチャ・運用決定だけをここに昇格させる。DDの「決定事項」は
> 変更単位でアーカイブに沈むため、「なぜこうなっているのか？」の逆引きを
> ここで一手で引けるようにする。1決定 = 10行程度。詳細な検討経緯は元DDが正本。

## 昇格の基準

- 半年後に「なぜこうなってる？」と聞かれうる決定（技術選定・データの正典・認証方式・命名規約 等）
- 覆すとコストが大きい決定（後から知らずに逆行する事故を防ぎたいもの）
- 昇格しない: 個別機能の実装方針（DD本体で十分）

## 書き方

新しい決定は末尾に追記。決定を覆した場合は古い項を消さず「→ D-NNN で変更」と上書きの行き先を書く。

---

## D-001: 初期対象はデスクトップブラウザー（Windows 11 Chrome/Edge 最優先）

- **日付**: 2026-07-11
- **背景**: 計画書 §1.2 の暫定仮定 A-01/A-02 と §24 D-01（対応OS/ブラウザー）は確定期限が「Phase 0開始前」。基盤構築（DD-001）の前提として対応範囲を確定する必要があった。
- **決定**: 初期対象はデスクトップブラウザーのみ（モバイル・タッチ編集は対象外）。Windows 11 の Chrome / Edge を最優先し、Firefox・macOS（Chrome/Safari）を次順位とする。
- **帰結**: PoC・実装・エビデンスは Win11 Chrome/Edge を基準に行う。モバイル/タッチ対応は現行スコープ外（必要になれば別途 DD で判断）。
- **元DD**: DD-001

## D-002: monorepo は npm workspaces、Node.js 22 を基準とする

- **日付**: 2026-07-11
- **背景**: 計画書 §17・§26-1 は monorepo と package boundary の作成を最初の作業と定めるが、パッケージマネージャと Node 対象バージョンが未確定だった。
- **決定**: monorepo は npm workspaces（`packages/*` + `apps/*`）で構成する。Node.js は 22 以上を基準とし、ルート `package.json` に `engines.node: ">=22"` を明記する（実行環境 v22.20.0 / npm 10.9.3 で確認）。
- **帰結**: 追加のパッケージマネージャ（pnpm 等）やタスクランナー（turborepo/nx）は導入しない。`packages/*` はランタイム依存ゼロを維持し、dev 依存はルートに集約する。パッケージが増えた段階で package boundary lint 等を別 DD で再検討する。
- **元DD**: DD-001

## D-003: npm パッケージスコープは `@nanairo-sheet/*`

- **日付**: 2026-07-11
- **背景**: DD-001 では npm スコープを `@spreadjs/*` で暫定採用していたが、商用スプレッドシート製品「SpreadJS」（GrapeCity/MESCIUS）と名称が衝突し、依存・検索・公開時に混同を招くリスクがあった。
- **決定**: 全ワークスペースの npm スコープを `@nanairo-sheet/*` に統一する（`@nanairo-sheet/sheet-types`・`@nanairo-sheet/playground`、以降 `@nanairo-sheet/sheet-core` 等も同様）。
- **帰結**: 新規パッケージは `@nanairo-sheet/*` で作成する。リポジトリ名 `spreadjs` とプロジェクト通称は現状据え置き（必要になれば別途判断 → **D-005 で `nanairo-sheet` へ変更決定**）。DD-001（`@spreadjs/*`）は覆され、本決定が正。
  - **DD-011-1（2026-07-13）による更新**: 上記の例示名（`@nanairo-sheet/sheet-types`・`@nanairo-sheet/sheet-core` 等）は DD-011-1 で DD-009 論理名（`@nanairo-sheet/{types,core,collab,server,formula}`）へ rename 済み（冗長な `sheet-` プレフィックス除去＋ディレクトリ名 `packages/{types,core,…}` も統一）。**スコープ `@nanairo-sheet/*` に統一するという D-003 の決定自体は有効**（suffix のみ変更）。
- **元DD**: DD-001（暫定採用）→ ユーザー指摘により D-003 で変更（2026-07-11）／DD-011-1 で suffix を論理名へ rename（2026-07-13）

## D-004: 文書体系は3層（製品憲章＝製品戦略の最上位正典）

- **日付**: 2026-07-12
- **背景**: 開発計画書は「正典」、DDロードマップは「最上位」を自称しており、新規配置された製品憲章との階層関係が未定義だった。「最上位」の多重定義を放置すると文書間矛盾の解決先が曖昧になる。
- **決定**: 文書体系を3層に分離する。①製品戦略層＝`doc/product/nanairo_sheet_product_charter_v1.md`（製品の目的・利用者・提供形態・非目標の正。矛盾時の最終解決先）／②技術層＝`doc/plan/nanairo_realtime_spreadsheet_development_plan_v1.md`＋ADR・仕様書（技術方式の正典）／③作業管理層＝`doc/plan/phase0-dd-roadmap.md`＋DD-INDEX（DD作業管理上の最上位）。
- **帰結**: 製品戦略に関わる判断は憲章を正とする（ステータス Accepted。ただし正式製品名・一般公開・商用化等は未決のまま）。分析・レビュー資料は `doc/reviews/`（非正典）へ置き、正典と混同させない。公開クラス名は仮称 `NanairoSheet`（正式名は未決定・別途判断 → **D-005 で Nanairo Sheet 正式確定**）。
- **元DD**: DD-008

## D-005: 製品名は Nanairo Sheet で正式確定・リポジトリ名は nanairo-sheet へ変更

- **日付**: 2026-07-16
- **背景**: P-01（正式製品名）・P-14（リポジトリ名）は憲章 §27 で「Stage 1 リリース前」期限のまま超過していた。phase2-dd-roadmap §2 は Codex レビュー指摘（命名を DD-031 まで遅らせると consumer 2件の import 再移行が発生）を受け、DD-025（React Facade）起票前の「命名ゲート」として前倒しした。
- **決定**: 仮称 Nanairo Sheet を**正式製品名として確定**（P-01）。npm スコープ `@nanairo-sheet/*`（D-003）・公開クラス名 `NanairoSheet` は変更なし。リポジトリ名は `spreadjs` から **`nanairo-sheet` へ変更する**（P-14）。ユーザー決定（2026-07-16・命名ゲート通過）。
- **帰結**: DD-025 以降の公開パッケージ名・サンプル・ドキュメントは Nanairo Sheet 正式名称で作成してよい（後からの改名リスク消滅）。リポジトリの**リネーム実施は DD-031（配布昇格）**で行う（ローカルパス・スクリプト・並行セッションへの波及があるため配布整備と同時に一括反映）。D-003 の「リポジトリ名は据え置き」・D-004 の「正式名は未決定」は本決定で解消。
- **元DD**: DD-023（phase2-dd-roadmap §2 命名ゲート）／反映先=DD-031

## D-006: deprecation policy は成熟度3層（P-10 確定）

- **日付**: 2026-07-16
- **背景**: 憲章 §18.3 は「具体的な非推奨期間は Stage 2 までに決定する」とし、P-10（非推奨期間）の期限は Stage 2 前だった。API 型スナップショット差分検出・migration guide 運用（S2-3）と同じ仕組みの上で運用するため、DD-028（継続回帰CI・API差分監視）がセットで確定した。
- **決定**: 成熟度3層で運用する。①**Experimental 0.x（現行）**=破壊的変更可。ただし CHANGELOG 必記＋型スナップショット更新同伴＋migration guide 要否判定。非推奨を経る場合は `@deprecated` JSDoc＋代替手段明示＋最低1 minor 共存。②**Beta（Stage 2 宣言後）**=公開 Facade API の削除・非互換変更は「非推奨マーク→最低1 minor リリース かつ 30日 かつ 統合済み全 consumer の移行確認」の全充足後。緊急（データ整合・安全性）は即時変更可・CHANGELOG＋consumer 直接通知必須。③**Stable 1.0 以降（予告）**=削除は major のみ・非推奨期間最低90日（正式確定は Stage 4 前）。
- **帰結**: 規定の正本は `doc/product/deprecation-policy.md`。変更の検出は `tests/contract`（公開宣言 closure snapshot）＋CI（DD-028）、移行手順の正本は `doc/migration/`（dry-run 検証義務）。憲章 §27 P-10 は決定済み。
- **元DD**: DD-028

## D-007: consumer 統合①は松下 生産納期（共同編集採用）・SDK は保存先と認証を利用側へ委ねる口を持つ

- **日付**: 2026-09-03
- **背景**: 統合①の consumer は DD-023 で housing-e-kintai-next（売上入力・単独グリッド先行）としていたが、松下 生産納期（`C:/repo/matsushita-production-management` DD-012）で共同編集が最重要要件となり、Postgres 保存・JWT Cookie 認証・SDK 優先の構成が松下側で確定した。SDK には保存先の差し替え口・認証フック・サーバー起点操作が無かった。
- **決定**: 統合①の consumer を **松下 生産納期**へ変更する（ユーザー決定）。SDK は共同編集サーバーに (1) `serve({ oplog, snapshotStore, initialDocument })`＝永続化ストアの差し替えと初期文書の外部供給、(2) `serve({ authenticate })`＝upgrade 時の認証フック（受理後の身元はサーバーが確定）、(3) `ServerInstance.submit()`＝サーバー起点操作、を **公開 API として提供**し、DB スキーマ・投影・JWT 検証は利用側の責務に置く（SDK 内蔵の Postgres ストアは作らない）。
- **帰結**: roadmap §0 S2-1・§1 DD-026・§2・§6 を更新（共同編集は Stage 2 で採用される。Presence=DD-019 のトリガー成立＝着手判断はユーザー）。persisted snapshot format は v2（checksum キー順非依存・v1 読込互換）。KPI-4 は採取不能（統合②で採取）。憲章 §11.4 の `createNanairoSheetRoutes({ authenticate, operationStore, snapshotStore })` は意図の例示と解釈し、`serve()` オプションで同じ責務分離を実現する（DD-024 の先例と同じ扱い）。
- **元DD**: DD-026（DD-026-1〜3）

<!-- 以降、D-008, D-009... と追記していく -->
