# DD-050 配布検証結果（2026-09-12・alpha.7）

実装時の受け入れ基準 1〜4 の照合は DD 本文（完了前チェック・ログ）に記録済み。本書は source commit 後の配布成果物（`0.1.0-alpha.7`）の生成・検証を記録する。

## 実コマンドと結果

Windows の Bash は `C:/Program Files/Git/bin/bash.exe`。Node v22 / npm 10。

| コマンド | 結果 |
|---|---|
| `bash scripts/release/build-release.sh --out release/0.1.0-alpha.7` | 生成コミット `882a56d`（gitDirty=false・closureDirty=false）。closure 宣言・全 workspace typecheck・lint（boundary）・unit 128 files / 1,315 tests PASS。10 tarball 生成・manifest 生成・pack 内容検査 PASS |
| `node scripts/release/verify-manifest.mjs release/0.1.0-alpha.7` | 10 tarball の名前/版/bytes/SHA-256 が manifest と一致 |
| `node scripts/release/check-pack-contents.mjs release/0.1.0-alpha.7` | 10 tarball / 111 files。tsconfig・test/spec なし、全 entrypoint あり |
| tarball と生成コミットの照合（各 tarball の `src/`・`public/` を `git show 882a56d:packages/<pkg>/<path>` と改行差を無視して比較） | 101 files 一致・不一致 0。DD-050 の変更（react の `omitUndefined`・server の不変条件ガード）を含む |
| `RELEASE_VENDOR_DIR=/c/repo/spreadjs/release/0.1.0-alpha.7 bash scripts/consumer-app.sh` | 最終配布 10 tarball のみで install 実体（symlink 0・stray 0・closure 完備）・tsc 型解決・server-hono lifecycle・vite production build・Playwright E2E 10/10 PASS |
| tarball 実体への厳格設定の型検査: `npx tsc --noEmit --listFiles --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --target ES2022 --lib ES2022,DOM,DOM.Iterable --moduleResolution bundler --module ESNext --verbatimModuleSyntax --isolatedModules --skipLibCheck --types node consumer-app/node_modules/@nanairo-sheet/{grid,react,server-hono}/src/index.ts` | エラー 0 件。SDK のソースは consumer-app に install した tarball の展開物（93 files）から読み、リポジトリの `packages/` は 0 files。受け入れ基準 5（広島側）の代替証拠 |
| ZIP 化（`Compress-Archive`）＋ ZIP 内 entry 列挙 | `release/nanairo-sheet-0.1.0-alpha.7.zip`: 350,358 bytes / 12 entries（10 tarball＋manifest.json＋README.md）。SHA-256 `c1f98424ea05ac5691083bfaa5154c6d7108279d4dedff677b2735a886199500` |

## 出自

- 配布ソースは `882a56d`（DD-050 実装 `d06975a` ＋ 10 package を alpha.7 へ更新）。全配布パスを commit 後に正式 pack し、`gitDirty=false`・`closureDirty=false`。
  [凍結 manifest](release-manifest.json) と配布ディレクトリの manifest は同一（SHA-256 一致）。
- build の検証ゲート実行中に本DD の文書（`doc/engineering-patterns.md`・`doc/DOC-MAP.md`）を編集したが、配布 closure の外。tarball の中身は上の照合で `882a56d` と一致した。
- `build-release.sh` は closureDirty を冒頭で判定し、数分の検証ゲートの後に pack する。判定と pack の間に packages/ が編集されると、中身が混ざっても
  closureDirty=false の manifest ができる。本DD では上の全ファイル照合で混入なしを確認した。スクリプトの改修は本DD の範囲外（DD 本文の既知の未保証境界）。
- npm registry への公開・広島リポへの適用は未実施（広島側 DD-005-3 の作業）。

## 未実施（既知の未保証境界へ移送済み）

- 受け入れ基準 5（広島 `mock/scripts/typecheck.mjs` で「nanairo-sheet 内」0 件）は広島側 DD-005-3 で確認する。spreadjs 側では上の tarball 実体への厳格設定の型検査（0 件）で代替した。
