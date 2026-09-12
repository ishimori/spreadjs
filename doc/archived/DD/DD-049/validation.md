# DD-049 配布検証結果（2026-09-12・alpha.6）

実装時の受け入れ基準 1〜9 の照合は DD 本文ログ（2026-09-12「受け入れ基準の照合」）に記録済み。本書は source commit 後の配布成果物（`0.1.0-alpha.6`）の生成・検証を記録する。

## 実コマンドと結果

Windows の Bash は `C:/Program Files/Git/bin/bash.exe`。Node v22 / npm 10。

| コマンド | 結果 |
|---|---|
| `bash scripts/release/build-release.sh --out release/0.1.0-alpha.6` | 生成コミット `863fa74`（closureDirty=false）。closure 宣言・全 workspace typecheck・lint（boundary）・unit 128 files / 1,315 tests PASS。10 tarball 生成・manifest 生成・pack 内容検査 PASS |
| `node scripts/release/verify-manifest.mjs release/0.1.0-alpha.6` | 10 tarball の名前/版/bytes/SHA-256 が manifest と一致 |
| `node scripts/release/check-pack-contents.mjs release/0.1.0-alpha.6` | 10 tarball / 111 files。tsconfig・test/spec なし、全 entrypoint あり |
| `RELEASE_VENDOR_DIR=/c/repo/spreadjs/release/0.1.0-alpha.6 bash scripts/consumer-app.sh` | 最終配布 10 tarball のみで install 実体（symlink 0・closure 完備）・tsc 型解決・server-hono lifecycle・vite production build・Playwright E2E 10/10 PASS |
| ZIP 化（`Compress-Archive`）＋ ZIP 内 entry 列挙 | `release/nanairo-sheet-0.1.0-alpha.6.zip`: 350,250 bytes / 12 entries（10 tarball＋manifest.json＋README.md） |

## 出自と並行作業の扱い

- 配布ソースは `863fa74`（DD-049 実装 `0f8cfe9` ＋ 10 package を alpha.6 へ更新）。全配布パスを commit 後に正式 pack し `closureDirty=false`。[凍結 manifest](release-manifest.json) と配布ディレクトリの manifest は同一。
- manifest の `gitDirty=true` は配布 closure 外の汚れ（本DD・DD-049-1 の文書更新と、並行セッション DD-050 の未追跡ファイル）による。
- 並行セッション（DD-050）が `packages/*/src` を 15:22:08 以降に編集したが、最後の tarball（collab）の pack は 15:21:37、manifest 生成は 15:21:45 で、いずれも編集より前。tarball は `src/*.ts` を直接同梱するため、成果物に DD-050 の未コミット変更は含まれない。
- npm registry への公開・広島リポへの適用は未実施（広島側 DD-005-3 の作業）。

## 未実施（既知の未保証境界へ移送済み）

- Manual Gate M1（実機 2 ブラウザでの目視）。Playwright の 2 コンテキストで自動検証済み（証跡 2 枚は DD 本文「エビデンス」）。
