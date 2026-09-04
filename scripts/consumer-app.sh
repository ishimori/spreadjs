#!/usr/bin/env bash
# 独立 consumer-app 実証（DD-016-2 Phase 3・AC1/AC2）。
#
# consumer-app/（npm workspaces 非登録＝boundary 検査対象外）を pack 済み tarball closure だけで統合し、
#   1) closure 宣言健全性（DA #4）  2) S1-3 不合格条件の機械検査（内部 import / test-support import / source path / workspace link / 未公開依存）
#   3) 公開面の型解決（tsc）  4) server-hono ServerInstance lifecycle（Node）  5) 実挙動 E2E（serve→mount→日本語入力→共同編集反映→destroy／再mount leak なし）
# を機械検証する。証跡は test-results/dd-evidence/DD-016-2/ へ格納する（gitignore 対象・再生成可能）。
#
# dev ツール（vite/tsx/playwright/tsc）はリポジトリルートの node_modules から実行し、consumer-app/node_modules には SDK tarball のみを置く。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$REPO_ROOT/consumer-app"
VENDOR="$APP/.vendor"
# 証跡は再生成可能なので test-results/ 配下（gitignore 対象）へ出す。
# かつては doc/DD/DD-016-2/ へ書いていたが、DD-016-2 は完了・アーカイブ済みで
# このアクティブ側パスは存在しない。実行のたびに閉じた DD の孤児フォルダが復活し、
# その未追跡ファイルが git status を汚していた（build-release.sh の同じ不具合は
# DD-040 で是正済み＝2a07b0d。本スクリプトはその時に見落とされていた）。
# アーカイブ側 doc/archived/DD/DD-016-2/ へ向け直す案は採らない。同フォルダの証跡は
# DD-016-2 クローズ時点の記録で、実行のたびに上書きすると当時の証拠が壊れるため。
EVID="$REPO_ROOT/test-results/dd-evidence/DD-016-2"
CHECK_SRC=("$APP/src" "$APP/server" "$APP/e2e")

CLOSURE_PKGS=(grid react server-hono core types collab render selection ime server)

mkdir -p "$EVID"
LOG="$EVID/consumer-app-run.log"
: > "$LOG"
log() { echo "$@" | tee -a "$LOG"; }
fail() { echo "[consumer-app] NG: $*" | tee -a "$LOG" >&2; exit 1; }

log "[consumer-app] === DD-016-2 Phase 3 独立 consumer 実証 $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# ---- 0. closure 宣言健全性（hoisting 非依存・DA #4） ----
log "[consumer-app] 0. pack closure 宣言健全性（check-closure.mjs）"
node "$REPO_ROOT/scripts/consumer/check-closure.mjs" | tee -a "$LOG"

# ---- 1. consumer-app が workspaces 非登録であること ----
log "[consumer-app] 1. workspaces 非登録の確認"
if ( cd "$REPO_ROOT" && node -e "const w=require('./package.json').workspaces||[]; process.exit(w.some(p=>String(p).includes('consumer-app'))?1:0)" ); then
  log "  ok: ルート package.json workspaces に consumer-app なし（boundary 検査対象外）"
else
  fail "consumer-app が npm workspaces に登録されている（独立性・boundary 対象外の前提が崩れる）"
fi
# consumer-app 自身が @nanairo-sheet / file: / workspace: 依存を宣言していない（未公開依存 0）。
if ( cd "$APP" && node -e "const p=require('./package.json'); const d={...(p.dependencies||{}),...(p.devDependencies||{})}; const bad=Object.entries(d).filter(([k,v])=>k.startsWith('@nanairo-sheet/')||String(v).startsWith('file:')||String(v).startsWith('workspace:')); if(bad.length){console.error(bad);process.exit(1)}" ); then
  log "  ok: consumer-app/package.json に SDK/file:/workspace: 依存の宣言なし（tarball のみ・未公開依存 0）"
else
  fail "consumer-app/package.json が SDK/file:/workspace: 依存を宣言している（未公開依存）"
fi

# ---- 2. S1-3 不合格条件の静的検査（install 前） ----
# import 文脈（from '...' / import '...' / import('...')）に限定して静的検査する（コメント中の言及を誤検出しない）。
log "[consumer-app] 2. S1-3 不合格条件の静的検査（内部 import / test-support / source path）"
IMPORT_CTX="(from|import)[[:space:]]*\(?[[:space:]]*['\"]"
if grep -rnE "${IMPORT_CTX}@nanairo-sheet/(core|types|collab|server|formula|selection|render|ime)['\"/]" "${CHECK_SRC[@]}"; then
  fail "内部パッケージを直接 import している（R1・S1-3 不合格）"
fi
if grep -rnE "${IMPORT_CTX}@nanairo-sheet/[a-z-]+/test-support" "${CHECK_SRC[@]}"; then
  fail "@nanairo-sheet/*/test-support（非公開契約）を import している（S1-3 不合格）"
fi
if grep -rnE "(from|import)[[:space:]]*\(?[[:space:]]*['\"]\.\.?/\.\.?/" "${CHECK_SRC[@]}"; then
  fail "リポジトリ内 source を相対パスで直接 import している（S1-3 不合格）"
fi
if grep -rnE "['\"][^'\"]*(packages|apps)/(core|types|collab|render|selection|ime|server|grid|formula)" "${CHECK_SRC[@]}"; then
  fail "source path（リポジトリ内 packages/apps）を参照している（S1-3 不合格）"
fi
log "  ok: 内部 import 0 / test-support import 0 / source path 参照 0"

# ---- 3. closure 一式を pack ＆ consumer-app へ install（workspace link を使わない） ----
# RELEASE_VENDOR_DIR が指すディレクトリ（scripts/release/build-release.sh の成果物）があれば、その配布 tarball を
# そのまま install して「配布成果物経由で consumer-app が成立するか」を検証する（DD-017 Phase 1・AC2・要確認D）。
# 未指定なら従来どおり fresh に pack する（DD-016-2 経路と共存）。
rm -rf "$VENDOR"; mkdir -p "$VENDOR"
if [ -n "${RELEASE_VENDOR_DIR:-}" ]; then
  log "[consumer-app] 3. 配布成果物経由（RELEASE_VENDOR_DIR=$RELEASE_VENDOR_DIR）→ consumer-app へ install"
  [ -f "$RELEASE_VENDOR_DIR/manifest.json" ] || fail "RELEASE_VENDOR_DIR に manifest.json がない（build-release.sh 未実行）"
  rel_count=$(find "$RELEASE_VENDOR_DIR" -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')
  [ "$rel_count" -eq "${#CLOSURE_PKGS[@]}" ] || fail "配布 tarball 数 $rel_count が closure(${#CLOSURE_PKGS[@]}) と不一致"
  # manifest と実 tarball の同一性検査（package 名・版・ファイル名・sha256）。stale/改変 tarball の誤用を弾く（DA #3・P2-2）。
  node "$REPO_ROOT/scripts/release/verify-manifest.mjs" "$RELEASE_VENDOR_DIR" | tee -a "$LOG" \
    || fail "manifest と配布 tarball の同一性検査に失敗（sha256/版/ファイル名不一致＝stale/改変の疑い）"
  cp "$RELEASE_VENDOR_DIR"/*.tgz "$VENDOR/"
  log "  ok: 配布成果物 $rel_count tarball を fresh pack せず流用（manifest 同一性検証済・配布物そのもので統合）"
else
  log "[consumer-app] 3. pack closure（${#CLOSURE_PKGS[@]} tarball）→ consumer-app へ install"
  for p in "${CLOSURE_PKGS[@]}"; do
    npm pack --workspace "@nanairo-sheet/$p" --pack-destination "$VENDOR" >/dev/null 2>&1
  done
fi
rm -rf "$APP/node_modules" "$APP/package-lock.json"
(
  cd "$APP"
  # shellcheck disable=SC2046
  npm install --no-save --install-links --no-audit --no-fund $(printf "%s\n" "$VENDOR"/*.tgz) >/dev/null 2>&1
)

# ---- 4. workspace link でなく tarball 展開実体・closure 完備・stray なし ----
log "[consumer-app] 4. install 実体検査（symlink でない・closure 完備・未公開の余分な @nanairo-sheet なし）"
for p in "${CLOSURE_PKGS[@]}"; do
  dir="$APP/node_modules/@nanairo-sheet/$p"
  [ -e "$dir" ] || fail "$p が install されていない（closure 欠落）"
  [ -L "$dir" ] && fail "$p が symlink（workspace link）＝独立性を満たさない"
  [ -f "$dir/src/index.ts" ] || fail "$p が tarball から展開されていない"
done
installed_count=$(find "$APP/node_modules/@nanairo-sheet" -maxdepth 1 -mindepth 1 | wc -l | tr -d ' ')
[ "$installed_count" -eq "${#CLOSURE_PKGS[@]}" ] || fail "@nanairo-sheet 配下が closure(${#CLOSURE_PKGS[@]}) と一致しない（$installed_count 個・stray の可能性）"
log "  ok: ${#CLOSURE_PKGS[@]} package 全て tarball 展開実体・symlink 0・stray 0"

# ---- 5. 公開面だけで tsc --noEmit（consumer-app/src の型解決を pack から） ----
log "[consumer-app] 5. tsc --noEmit（consumer 公開面の型解決）"
(
  cd "$APP"
  node "$REPO_ROOT/node_modules/typescript/bin/tsc" -p tsconfig.json
)
log "  ok: consumer-app/src が Facade 公開型のみで型解決 green"

# ---- 6. server-hono ServerInstance lifecycle（Node・独立 consumer から） ----
log "[consumer-app] 6. server-hono ServerInstance lifecycle（Node/tsx）"
(
  cd "$APP"
  node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" server/check-server.ts
) | tee -a "$LOG"

# ---- 7. 本番 build（pack closure を実バンドラで解決＝S1-4 最小サンプル・preview 配信の前提） ----
log "[consumer-app] 7. vite build（pack closure を Rollup で bundle）"
(
  cd "$APP"
  node "$REPO_ROOT/node_modules/vite/bin/vite.js" build
) 2>&1 | tee -a "$LOG"

# ---- 8. 実挙動 E2E（serve→mount→日本語入力→共同編集反映→destroy／再mount leak なし） ----
log "[consumer-app] 8. Playwright 実挙動 E2E（lifecycle leak / scenario・production preview）"
(
  cd "$APP"
  node "$REPO_ROOT/node_modules/@playwright/test/cli.js" test --config "$APP/playwright.config.ts"
) 2>&1 | tee -a "$LOG"

log "[consumer-app] OK: S1-3 不合格条件 0・pack closure 型解決 green・server lifecycle・実挙動 E2E（leak なし）全て green"
