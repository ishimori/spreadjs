# DD-044: Tarball 同梱物の健全化

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-04 | 2026-09-04 | 完了 | alpha.1の10 package配布セットへ更新し、開発用設定・テストの同梱を機械防止 |

> アプローチ: バグ修正・ライトパス（画面影響なし・`npm pack` の同梱一覧で再現と検証が完結するため）
> エビデンス: テスト出力（tarball 内容・manifest・独立 consumer 検証）
> リスク: あり（外部 I/F — consumer へ渡す配布物と closure を変更）

```text
Risk Class: B
Risk Triggers: 外部配布物・package版・標準配布セットの変更
Human Spec Gate: skipped（松下の実エラーと既存TSソース配布契約から修正境界が確定）
Codex: none（本セッションが実装。外部レビューはユーザー指示時のみ）
Manual Gate: 松下VSCodeでのProblems消失確認（クローズはブロックせず既知境界へ移送）
External Review: ユーザー判断
Evidence Level: standard
```

## 概要

| Bug# | 概要 | 重要度 |
|------|------|--------|
| 1 | 配布 tarball にモノレポ専用 `tsconfig.json` が入り、consumer の VSCode が存在しない `../../tsconfig.base.json` を診断する | MEDIUM |
| 2 | React Facade 提供後も release automation が旧 9 package closure のままで、松下が必要とする `@nanairo-sheet/react` を手作業で補っている | MEDIUM |

## 原因分析

- 各 package の `package.json` に公開ファイル境界がなく、`npm pack` の既定選択で package 直下の `tsconfig*.json` と `src/**/*.test.ts` まで入る。
- DD-025 で React Facade を追加した後、DD-017 由来の release closure と consumer 検証が 9 package のまま更新されていない。

## 修正方針

TS ソース配布（`main: ./src/index.ts`）は維持し、配布対象 10 package の `files` を製品ランタイム資産に限定する（`server-hono/public` は実行時必須）。release closure に React Facade を加え、実 tarball に開発用設定・テストが無いことを機械検証する。`formula` は現行 Facade の実行時依存でないため引き続き対象外とする。

## 対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `packages/{grid,server-hono,react,core,types,collab,render,selection,ime,server}/package.json` | 製品ソースと必須runtime assetだけを pack する `files` 境界を追加 |
| `scripts/release/build-release.sh` | closure を 10 package 化し、pack 内容の健全性 gate を追加 |
| `scripts/release/check-pack-contents.mjs` | tarball に必須 entrypoint があり、`tsconfig*`・テスト等が無いことを検査 |
| `scripts/consumer-app.sh` / `scripts/consumer-harness.sh` | React を含む 10 package closure の独立 install を検証 |
| `doc/quick-start.md` / `consumer-app/README.md` / `CHANGELOG.md` | 現行配布 closure と TS ソース配布境界を同期 |

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | release を生成すると全 tarball に `package/tsconfig*.json` と `*.test.*` / `*.spec.*` が含まれない | ✅ 10 tarball / 107 files、禁止物0 |
| 2 | 各 tarball は `package.json` が指す `main` / `types` / `exports` とserveに必要なruntime assetを含み、TS ソース配布を維持する | ✅ 全entrypointあり・consumer lifecycle green |
| 3 | release は React Facade を含む 10 tarball と manifest を生成し、全 sha256 が一致する | ✅ candidate build・manifest照合 green。正式版は完了コミット後に再生成 |
| 4 | 成果物だけを独立 consumer に入れて型検査・build・serve/mount・E2Eが通る | ✅ tsc/build/serve + Playwright 2/2 green |
| 5 | 松下の vendor へ10 tarballを差し替えた後、SDK由来の `tsconfig.base.json` 欠落診断が再現しない | ✅ 原因ファイル0をSDK側で確認。松下VSCode最終確認は既知境界 |
| 6 | 旧 `alpha.0` と識別可能な版で生成され、consumerのlockfile/cacheが更新を認識できる | ✅ 10 packageとlockfileを `0.1.0-alpha.1` へ同期 |

## タスク一覧

### Phase 1: コード修正・対象検証
- [x] 配布対象 10 package の `package.json` に製品ソースと必須runtime assetだけを許可する `files` を追加
- [x] `scripts/release/build-release.sh` と consumer 検証の closure を React 込み 10 package に同期
- [x] `scripts/release/check-pack-contents.mjs` を追加し、必須 entrypoint と禁止ファイルを検査
- [x] `doc/quick-start.md`・`consumer-app/README.md`・`CHANGELOG.md` の配布説明を同期
- [x] 配布対象10 packageを `0.1.0-alpha.1` に採番し `package-lock.json` を同期
- [x] 同根パターンを全 `packages/*` で確認し、非配布 `formula` の扱いを明記
- [x] 🔬 機械検証: focused pack 内容検査・release manifest 検証・関連 lint/typecheck が green

### Phase 2: 配布物再生成・consumer 検証
- [x] `scripts/release/build-release.sh` で 10 tarball + manifest のcandidateを生成（正式版は完了コミット後に再生成）
- [x] `RELEASE_VENDOR_DIR=<candidate> scripts/consumer-app.sh` で成果物のみの独立 consumer 検証
- [x] 松下側へ渡すファイル・取り込み時の再install条件を整理
- [x] 🔬 機械検証: tarball内容・manifest sha256・consumer E2E がすべて green

### 完了前チェック
- [x] 受け入れ基準を1項目ずつ照合（未達成があれば理由をログへ）
- [x] 😈 セルフレビュー1巡
- [x] 🔬 全回帰1回: `npm run typecheck` / `npm run lint` / `npm test`

## 既知の未保証境界

- VSCode Problems の最終消失確認は松下リポジトリへの再取り込み後に行う。SDK側では原因ファイルがtarballに存在しないことまでを保証する。
- dist 配布への切替は行わず、consumer は引き続き TypeScript を透過コンパイルできる環境が必要。

## ログ

### 2026-09-04
- 松下取り込み時の報告を再現。現行 release 9 tarball 全てに `package/tsconfig.json` が入り、各設定はモノレポ専用 `../../tsconfig.base.json` を参照していた。
- 松下側は React Facade を含む10 tarballを使用しているが、spreadjsのrelease automationはDD-025以前の9 package closureのままと判明。consumer側の作業中 workaround（`package.json`、`scripts/strip-vendor-tsconfig.sh`）には触れない。
- 初回focused consumerで `server-hono/public/demo.html` の除外を検出。これはserve時に読む製品runtime assetのため明示同梱へ修正し、consumer lifecycleをpack内容検査の補完gateとして維持する。
- 検証: pack内容 10 tarball / 107 files（tsconfig・test/spec 0、全entrypointあり）、manifest SHA-256一致、consumer harness green、独立consumer tsc/build/serve + Playwright 2/2 green。
- 全回帰: lint（boundary new=0）・typecheck green。`npm test` 初回は同時負荷で既存PoC benchが5秒timeout（単体4/4 green）、全件再実行で118 files / 1,232 tests green。
- 仕様同期: package配布契約を `doc/quick-start.md`・`CHANGELOG.md`・ADR-0015・stage2 backlogへ反映。画面/API/DB仕様の変更はなし。横断知見を `doc/engineering-patterns.md` #21へ昇格。
