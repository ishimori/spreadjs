#!/usr/bin/env bash
# DD-017 Phase 1: Alpha 配布成果物の再現 build（要確認A=(a) pack tarball 運用の正式化）。
#
# 配布経路は「private registry publish」ではなく **pack closure 方式（DD-016-2 実証）を正式化** したもの
#   （決定事項 A・ADR-0015 の S1-6 再解釈）。本スクリプトは:
#     1) 再現 build ゲート: typecheck / lint / test を前置し、いずれか red なら成果物を作らない
#     2) 配布 closure（内部 9 package = grid/server-hono/core/types/collab/render/selection/ime/server）を
#        `npm pack` して tarball を生成する（formula/apps は Alpha 配布 closure 外）
#     3) manifest（channel=alpha・版数・sha256・bytes・生成コミット SHA・dirty フラグ）を出力する
#   を行い、「consumer が成果物のみで統合できる・再現可能・チャネル明示」という S1-6 の実質を満たす。
#
# 使い方:
#   bash scripts/release/build-release.sh                 # 既定: 検証あり・release/ へ出力
#   bash scripts/release/build-release.sh --skip-verify   # typecheck/lint/test を省略（検証済み前提の再 pack）
#   bash scripts/release/build-release.sh --out <dir>     # 出力先を変更（既定 release/）
#
# registry への昇格（Stage 2/子DD）は package.json に publishConfig を足し `npm publish --tag alpha` へ
#   切り替えるだけで済む（版採番・closure・チャネル表記は本スクリプトで確立済み）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHANNEL="alpha"
OUT_DIR="$REPO_ROOT/release"
SKIP_VERIFY=0
# （かつての EVID＝DD-017 evidence への複製先は廃止。理由は末尾「5. 証跡について」を参照）

# 配布 closure（consumer-app.sh / consumer-harness.sh と一致させること）。
CLOSURE_PKGS=(grid server-hono core types collab render selection ime server)

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-verify) SKIP_VERIFY=1; shift ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    *) echo "[release] 不明な引数: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[release] $*"; }
fail() { echo "[release] NG: $*" >&2; exit 1; }

log "=== DD-017 Alpha 配布成果物 build（channel=$CHANNEL）$(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# ---- 0. git 状態（再現性の記録・DA #1: 成果物と working tree の乖離検出） ----
GIT_COMMIT="$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null || echo 'unknown')"
if [ -n "$(cd "$REPO_ROOT" && git status --porcelain 2>/dev/null)" ]; then
  GIT_DIRTY="true"
  log "WARN: working tree が dirty です。成果物は未コミットの変更を含みます（manifest に gitDirty=true を記録）。"
else
  GIT_DIRTY="false"
fi
log "生成コミット: $GIT_COMMIT (dirty=$GIT_DIRTY)"

# ---- 1. 再現 build ゲート（closure 宣言健全性 → typecheck / lint / test） ----
# closure 宣言健全性（check-closure.mjs）は typecheck/lint/test が hoisting で通過してしまう「実行時 inter-dep の
# devDependencies 漏れ」を検出する（P2-1）。gate に含めないと宣言漏れの tarball を「一発生成」しうる。
if [ "$SKIP_VERIFY" -eq 0 ]; then
  log "1. 再現 build ゲート: closure 宣言健全性 → typecheck / lint / test"
  ( cd "$REPO_ROOT" && node scripts/consumer/check-closure.mjs ) || fail "closure 宣言健全性 NG（宣言漏れ tarball を生成しない）"
  ( cd "$REPO_ROOT" && npm run typecheck ) || fail "typecheck red（成果物を生成しない）"
  ( cd "$REPO_ROOT" && npm run lint ) || fail "lint red（成果物を生成しない）"
  ( cd "$REPO_ROOT" && npm run test ) || fail "test red（成果物を生成しない）"
  log "  ok: closure 健全性・typecheck / lint / test 全て green"
else
  log "1. 再現 build ゲート: --skip-verify 指定によりスキップ（closure 健全性は下の pack でも間接検証）"
fi

# ---- 2. 版数の一貫性検査（配布 closure が全て同一 alpha 版か） ----
log "2. 版数の一貫性検査（配布 closure が単一 alpha 版か）"
EXPECTED_VERSION=""
for p in "${CLOSURE_PKGS[@]}"; do
  # パスは argv で渡す（MSYS が Windows パスへ変換する。-e 内の '/c/..' リテラルは変換されないため）。
  v="$(node -e "process.stdout.write(require(process.argv[1]).version)" "$REPO_ROOT/packages/$p/package.json")"
  if [ -z "$EXPECTED_VERSION" ]; then EXPECTED_VERSION="$v"; fi
  [ "$v" = "$EXPECTED_VERSION" ] || fail "$p の版 $v が closure 版 $EXPECTED_VERSION と不一致（配布 closure は単一版で運用する）"
  case "$v" in
    *-alpha.*) : ;;
    *) fail "$p の版 $v が alpha チャネル表記（*-alpha.*）でない" ;;
  esac
done
log "  ok: 配布 closure 9 package 全て $EXPECTED_VERSION（channel=$CHANNEL）"

# ---- 3. pack（9 tarball を OUT_DIR へ生成） ----
log "3. npm pack（配布 closure 9 tarball → $OUT_DIR）"
# 任意 --out での破壊を避けるため rm -rf は使わず、既知の成果物（*.tgz・manifest.json）だけを掃除する（P1-3）。
# OUT_DIR が REPO_ROOT やその主要サブディレクトリを指す誤指定を拒否する保護も置く。
OUT_ABS="$(cd "$REPO_ROOT" && mkdir -p "$OUT_DIR" && cd "$OUT_DIR" && pwd)"
case "$OUT_ABS" in
  "$REPO_ROOT") fail "--out がリポジトリルートを指しています（成果物領域を分離してください）" ;;
  "$REPO_ROOT/packages"|"$REPO_ROOT/scripts"|"$REPO_ROOT/doc"|"$REPO_ROOT/apps"|"$REPO_ROOT/tests"|"$REPO_ROOT/node_modules")
    fail "--out が主要ソースディレクトリ（$OUT_ABS）を指しています" ;;
esac
rm -f "$OUT_ABS"/*.tgz "$OUT_ABS"/manifest.json 2>/dev/null || true
OUT_DIR="$OUT_ABS"
for p in "${CLOSURE_PKGS[@]}"; do
  ( cd "$REPO_ROOT" && npm pack --workspace "@nanairo-sheet/$p" --pack-destination "$OUT_DIR" >/dev/null 2>&1 ) \
    || fail "$p の pack に失敗"
done
TARBALL_COUNT="$(find "$OUT_DIR" -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')"
[ "$TARBALL_COUNT" -eq "${#CLOSURE_PKGS[@]}" ] || fail "生成 tarball 数 $TARBALL_COUNT が closure(${#CLOSURE_PKGS[@]}) と不一致"
log "  ok: $TARBALL_COUNT tarball 生成"

# ---- 4. manifest 出力（版数・sha256・bytes・生成コミット・チャネル） ----
log "4. manifest 生成（版数・sha256・生成コミット・channel）"
MANIFEST="$OUT_DIR/manifest.json"
node - "$OUT_DIR" "$CHANNEL" "$EXPECTED_VERSION" "$GIT_COMMIT" "$GIT_DIRTY" "${CLOSURE_PKGS[@]}" <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync, readdirSync, writeFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const [outDir, channel, version, gitCommit, gitDirty, ...pkgs] = process.argv.slice(2);
const tgz = readdirSync(outDir).filter((f) => f.endsWith('.tgz'));
// npm pack のファイル名は nanairo-sheet-<pkg>-<version>.tgz（scope の '/' が '-' に）。
// 前方一致だと 'server' が 'server-hono-...' を誤選択しうる（readdir 順依存）ため版込みで完全一致させる（P1-2）。
function tarballFor(pkg) {
  const expected = `nanairo-sheet-${pkg}-${version}.tgz`;
  const hit = tgz.find((f) => f === expected);
  if (!hit) throw new Error(`tarball not found for ${pkg}: expected ${expected}`);
  return hit;
}
const packages = pkgs.map((pkg) => {
  const file = tarballFor(pkg);
  const buf = readFileSync(join(outDir, file));
  return {
    name: `@nanairo-sheet/${pkg}`,
    version,
    tarball: file,
    bytes: statSync(join(outDir, file)).size,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
});
const manifest = {
  distribution: 'pack-tarball-closure',
  note: 'DD-017 決定事項A: private registry ではなく pack closure 方式を正式化。consumer は本 closure 全 tarball を同時 install する（欠けると module 解決不能）。registry 昇格は Stage 2。',
  channel,
  version,
  apiVersion: '0.1.0-experimental',
  generatedAt: new Date().toISOString(),
  gitCommit,
  gitDirty: gitDirty === 'true',
  // install は tarball が cwd にある前提（./ 明示）。tarball は release/ 内にあるため、consumer は tarball を
  // 自プロジェクトへコピーしてから実行するか、release/ を cwd にして実行する（P1-4・installNote 参照）。
  installNote:
    'tarball は本 manifest と同じ release/ にある。consumer プロジェクトへ tarball をコピー（例 vendor/）してから install を実行するか、release/ を cwd にして実行する。scripts/consumer-app.sh は tarball を .vendor へコピーして検証する。',
  install: 'npm install --no-save --install-links ' + packages.map((p) => './' + p.tarball).join(' '),
  packages,
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`[release]   manifest: ${packages.length} package / version ${version} / channel ${channel}`);
NODE

# ---- 5. 証跡について ----
# **DD フォルダへは複製しない**（かつては DD-017 の evidence へ複製していた）。理由は 3 つ:
#   1. DD-017 は完了・アーカイブ済みで、`doc/archived/DD/DD-017/release-manifest.json` は
#      **CG-4（Tier 1 環境）の gate 証拠**として `doc/plan/cg-ledger.md` と DD-018 の
#      stage1-gate-checklist.md から参照されている。build のたびに上書きすると Stage 1 の
#      gate 証拠が壊れる（アーカイブ先へ向け直す“修正”は特に危険）。
#   2. アクティブ側 `doc/DD/DD-017/` へ書くと、閉じた DD の孤児フォルダが毎回復活し、その未追跡
#      ファイルが次回以降の `git status --porcelain` を汚して **自分で gitDirty=true を誘発**する。
#   3. manifest は成果物と同じ場所にある（`$OUT_DIR/manifest.json`）のが正しい。tarball と対で
#      consumer へ渡り、`scripts/release/verify-manifest.mjs <配布ディレクトリ>` もそこを読む。
#      `release/` は .gitignore 済みだが、manifest が gitCommit を刻むため成果物は再現可能。
# 特定リリースを記録に残したいときは、その判断をした DD の添付フォルダへ**手で**コピーする
# （＝そのDDの証跡として凍結する）。build スクリプトが自動で書き込む先ではない。
log "5. 証跡: $MANIFEST（成果物と同じ場所。DD フォルダへは複製しない）"

log "OK: 配布成果物 $OUT_DIR（9 tarball＋manifest.json）生成完了。"
log "  consumer 統合: tarball を consumer へコピー（例 mkdir vendor && cp $OUT_DIR/*.tgz vendor/）後、vendor/ で manifest.json の install を実行。"
log "  再現検証: RELEASE_VENDOR_DIR=$OUT_DIR bash scripts/consumer-app.sh"
