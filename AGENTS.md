# AGENTS.md

> 全エージェント共通の正本（Codex は直接、Claude Code は CLAUDE.md の `@AGENTS.md` インポート経由で読む）

## プロジェクト概要

spreadjs — 業務Webアプリへ組み込む TypeScript製リアルタイム共同編集スプレッドシート型入力基盤。日本語IME・数万行Canvas描画・サーバー主導の共同編集を優先する。詳細は `doc/plan/`。

- **ステータス**: Phase 0 進行中（開発基盤 monorepo を DD-001 で構築済み。以降は PoC-A〜D を実装）
- **技術スタック**: React（業務UI外周） / TypeScript製グリッドコア（Canvas 2D・依存ゼロ） / Hono + `@hono/node-server` + `ws`（API・WebSocket） / PostgreSQL
- **正典**: `doc/plan/nanairo_realtime_spreadsheet_development_plan_v1.md`（アーキテクチャ・ADR・プロトコル・IME・数式・性能・リスク）
- **ドキュメント一覧**: `doc/DOC-MAP.md`（全ドキュメントの場所と目的。迷ったらまずここ）
- **概要**: `README.md`

## コマンド

> monorepo（npm workspaces）は DD-001 で構築済み。**Node.js 22 以上**が前提（`engines.node: ">=22"`）。
> ルートで一度 `npm install` した後、以下のコマンドが使える（ビルド／テスト系はルートに集約）。

| コマンド | 用途 |
|---------|------|
| `npm install` | 依存を導入（`packages/*` はランタイム依存ゼロ。dev 依存はルート集約） |
| `npm run dev` | playground（Vite）を起動（`apps/playground`。枠線付きの空 Canvas 土台。PoC-A/B の実装先） |
| `npm run build` | playground を本番ビルド |
| `npm run test` | 全 workspace の Vitest を一括実行 |
| `npm run typecheck` | 全 workspace の `tsc --noEmit`（`types` パッケージは DOM lib なしで型検査） |
| `npm run lint` | ESLint（flat config・typescript-eslint recommended）を一括実行 |
| `bash scripts/dev-start.sh` | playground(Vite :5885)＋collaboration-server(:9499) を同時起動（ポートは標準+712で他プロジェクトと非衝突。`--integration` で統合PoCシード付き） |
| `bash scripts/dev-start.sh --showcase` | SDK紹介サイト・機能カタログ＋動作デモ(:5886)＋server(:9499・50k行シード＋永続化) を起動（DD-017-2。台本: `apps/showcase/README.md`。`--server-only` で server のみ） |
| `bash scripts/dev-kill.sh` | 上記ポート(5885/5886/9499)で LISTEN 中のプロセスを全て kill（`--server` で 9499 のみ） |
| `bash scripts/doc-check.sh` | ドキュメント整合性チェック（DOC-MAP孤児・リンク切れ） |
| `bash scripts/dd-index-gen.sh` | DD-INDEX.md 再生成（直接編集しない） |

## DD設定

- **DDフォルダ**: `doc/DD/` / **アーカイブ**: `doc/archived/DD/` / **テンプレート**: `doc/templates/dd_template.md`
- **パス設定**: ルート直下の `.dd-config`（スクリプト・フックはここを読む。上の実パスと常に一致させる）
- **ステータス**: 固定6種（検討中/進行中/確認待ち/保留/見送り/完了）+ 補足列。語彙ルール: `doc/templates/guides.md` §3
- **スキル**: `/dd new|list|log|archive|search|rebuild-index|health`（Claude Code: `.claude/skills/` / Codex: `.agents/skills/` — 同一内容のミラー）
- **開発フロー**: DD作成 → 仕様確認 → 実装 → 検証 → 完了（いきなりコードを書かない）
- **レビュー**: DDタスクに組み込まない。1モデル（Opus / Codex）でDDを完走し、完了報告を見たユーザーがもう一方のモデルへ都度指示する（`doc/templates/guides.md` §10。v7で `/dd-auto` の自動振り分けは廃止）
- **外部レビュー記録**: ChatGPT等の外部レビューを実施したら、指摘・採否・反映先を **`doc/DD/DD-{番号}/chatgpt-review-YYYYMMDD.md`**（添付フォルダ・複数回は日付で区別）に記録し、DD本文のログへ参照を1行残す。反映自体は通常どおりDD本文（決定事項・AC・タスク）へ。アーカイブ時は添付フォルダごと移動されるため記録はDDと一緒に残る（初出: DD-006/007）
- **DA 深掘り手法（参考文書）**: `doc/da-method.md` / **コミット**: `DD-{番号}: 概要` 形式

## コーディング規約

- 基準書: `doc/templates/coding-standards.md`（コードレビューはこの基準で評価する）
- フロントエンド実装時は Modern Web Guidance で最新Webプラットフォーム知識を取得:
  `npx modern-web-guidance@latest search "<課題>"` → `retrieve <ガイドID>`

## ドキュメント更新義務

- `doc/` にドキュメントを追加・移動したら `doc/DOC-MAP.md` も更新する
- 画面・API・DBを変更したら、対応する仕様書も同じ変更で更新する
- 機能の追加・提供開始・スコープ変更を伴うDDを完了したら、SDK紹介サイトの機能カタログ `apps/showcase/src/features.json` の該当エントリ（status/summary/demo）も更新する（単一データ源・DD-017-2。整合性は `npm test` の features smoke が検証）

## エージェント別の注意

- 編集ガード等の hooks は Claude Code 固有。Codex 等ではガードが効かないがルールは同じ: DD-INDEX.md は直接編集せず `bash scripts/dd-index-gen.sh` で再生成する
