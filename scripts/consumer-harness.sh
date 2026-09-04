#!/usr/bin/env bash
# 独立 consumer harness 検証（DD-011 Phase 4 → DD-016-2 Phase 3 で pack closure 対応へ拡張・AC1/AC5）。
# pack 済み Facade tarball（+ 内部 private package の依存 closure）を独立プロジェクトへ install し、
# 公開面だけで tsc --noEmit green を確認する。
# あわせて S1-3 不合格条件（内部 package 直接 import・source path 参照・workspace link・test-support import）を機械検査する。
#
# 【DD-016-2】
#   - P2-1: consumer-harness/src/index.ts を確定 API（mount sync / serverUrl 必須 / async serve /
#     GRID_API_VERSION / SERVER_HONO_API_VERSION）へ追随済み。
#   - pack closure（要確認A=(a)）: grid/server-hono に加え内部 private package（core/types/collab/render/
#     selection/ime/server）と React Facade も npm pack し、10 tarball を同時 install する（engineering-patterns #4）。
#   - closure 宣言健全性（DA #4）: scripts/consumer/check-closure.mjs で「実行時 inter-dep が devDependencies に
#     隠れていない」ことを install 成否に依存せず静的検査する。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$REPO_ROOT/consumer-harness"
VENDOR="$HARNESS/.vendor"

# pack closure 対象（公開 Facade 3 ＋ 内部7＝10。formula/apps は現行 Facade の実行時 closure 外）。
CLOSURE_PKGS=(grid react server-hono core types collab render selection ime server)

fail() { echo "[harness] NG: $*" >&2; exit 1; }

# ---- 0a. closure 宣言健全性（hoisting 非依存の静的検査・DA #4） ----
echo "[harness] pack closure 宣言健全性を検査（check-closure.mjs）..."
node "$REPO_ROOT/scripts/consumer/check-closure.mjs"

# ---- 0b. S1-3 不合格条件の静的検査（install 前） ----
# 全 import 形式を対象にする（Codex P1）: `from 'x'`・`import 'x'`（副作用）・`import('x')`（動的）・
# `import('x').Y`（型位置）をまとめて捕捉するため、scope 付き specifier の出現自体を見る
# （内部 package 名の後は '/" いずれか＝`server-hono` の `server` 誤マッチを境界で除外）。
echo "[harness] S1-3 不合格条件（内部 import / source path 参照 / test-support import）を静的検査..."
if grep -rnE "@nanairo-sheet/(core|types|collab|server|formula|selection|render|ime)['\"/]" "$HARNESS/src"; then
  fail "consumer が内部パッケージを直接 import している（R1・§4.3-1 full-error。全 import 形式を検査）"
fi
# test-support（E2E introspection・非公開契約）の import は S1-3 不合格（DD-016-2 §決定事項）。
if grep -rnE "@nanairo-sheet/[a-z-]+/test-support" "$HARNESS/src"; then
  fail "consumer が @nanairo-sheet/*/test-support（非公開契約）を import している（S1-3 不合格）"
fi
# 相対 import（from/副作用/動的いずれも先頭が `.`）とリポジトリ内パス（packages//apps/）を捕捉。
if grep -rnE "(from|import)[[:space:]]*\(?[[:space:]]*['\"]\.\.?/" "$HARNESS/src"; then
  fail "consumer が相対パスで source を直接 import している"
fi
if grep -rnE "['\"][^'\"]*(packages|apps)/" "$HARNESS/src" "$HARNESS/tsconfig.json"; then
  fail "consumer が source path（リポジトリ内パス）を参照している"
fi

# ---- 1. closure 一式を pack（tarball 化） ----
echo "[harness] npm pack（closure: ${CLOSURE_PKGS[*]}）..."
rm -rf "$VENDOR"; mkdir -p "$VENDOR"
for p in "${CLOSURE_PKGS[@]}"; do
  npm pack --workspace "@nanairo-sheet/$p" --pack-destination "$VENDOR" >/dev/null 2>&1
done

# ---- 2. tarball を harness へ install（workspace link を使わない独立 install） ----
echo "[harness] tarball（${#CLOSURE_PKGS[@]}本）を install..."
rm -rf "$HARNESS/node_modules" "$HARNESS/package-lock.json"
(
  cd "$HARNESS"
  # shellcheck disable=SC2046
  npm install --no-save --install-links --no-audit --no-fund $(printf "%s\n" "$VENDOR"/*.tgz) >/dev/null
)

# ---- 3. 不合格条件: workspace link（symlink）でなく tarball 展開実体であること（closure 全 package） ----
for p in "${CLOSURE_PKGS[@]}"; do
  dir="$HARNESS/node_modules/@nanairo-sheet/$p"
  [ -e "$dir" ] || fail "$p が install されていない（closure 欠落）"
  [ -L "$dir" ] && fail "$p が symlink（workspace link）＝独立性を満たさない"
  [ -f "$dir/src/index.ts" ] || fail "$p が tarball から展開されていない（src/index.ts なし）"
done

# ---- 4. 公開面だけで tsc --noEmit（型解決は harness/node_modules から） ----
echo "[harness] tsc --noEmit..."
(
  cd "$HARNESS"
  node "$REPO_ROOT/node_modules/typescript/bin/tsc" -p tsconfig.json
)

echo "[harness] OK: closure pack→install→tsc --noEmit green（内部 import なし・test-support なし・source path 参照なし・workspace link なし・宣言 honest）"
