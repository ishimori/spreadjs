#!/usr/bin/env bash
# Codexレビュー実行ラッパー（任意機能・ユーザー指示時のみ実行）
# サブスク認証のCodex CLI（デスクトップアプリ同梱）をヘッドレスで呼び、
# レビュー依頼書を渡して結果をMarkdownに保存する。API課金は発生しない。
# 別モデル（Codex）視点で、実装者（Claude等）の差分をレビューさせるのが目的。
# v7以降、DDタスクには組み込まない — 完了報告を見た人間がレビューを指示した時に使う。
# 使い方:
#   bash scripts/codex-review.sh --check     # 利用可否のみ判定（トークン消費なし。exit 0=可 / 非0=不可）
#   bash scripts/codex-review.sh --smoke     # 認証込み疎通確認（実実行。少量トークン）
#   bash scripts/codex-review.sh --request <依頼書> --out <結果md> \
#                                [--uncommitted | --base main | --commit <sha>] \
#                                [--effort low|medium|high|xhigh]
# effort既定: レビュー=high / --smoke=low（xhighはユーザーの明示指示時のみ）
#
# どのディレクトリから実行してもよい（CWD非依存）。相対パス引数（--request/--out）は
# プロジェクトルート基準で解釈される。
set -euo pipefail

# --- プロジェクトルート解決と .dd-config 読み込み（CWD非依存） ---
# スクリプト自身の位置からルートを求める（想定配置: {ルート}/scripts/）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
if [ ! -f "$PROJECT_ROOT/.dd-config" ]; then
    # scripts/ がルート直下にない配置向けフォールバック: 上方に .dd-config を探索
    _p="$SCRIPT_DIR"
    while [ -n "$_p" ] && [ "$_p" != "/" ] && [ "$_p" != "." ]; do
        if [ -f "$_p/.dd-config" ]; then PROJECT_ROOT="$_p"; break; fi
        _p="$(dirname "$_p")"
    done
fi
cd "$PROJECT_ROOT"
# 注: このスクリプトは .dd-config の値を使用しない（PROJECT_ROOT 解決に存在だけ利用）。
#     以前は . ./.dd-config していたが、設定ファイルの source は任意コード実行の
#     リスクがあるため廃止した。値が必要な他スクリプトは dd_config_get で厳格抽出する。

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

REQUEST=""
OUT=""
SMOKE=0
CHECK=0
EFFORT=""
TARGET_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --request) REQUEST="${2:?--request にファイルパスが必要}"; shift 2 ;;
    --out)     OUT="${2:?--out に出力パスが必要}"; shift 2 ;;
    --uncommitted) TARGET_ARGS=(--uncommitted); shift ;;
    --base)    TARGET_ARGS=(--base "${2:?--base にブランチ名が必要}"); shift 2 ;;
    --commit)  TARGET_ARGS=(--commit "${2:?--commit にSHAが必要}"); shift 2 ;;
    --effort)  EFFORT="${2:?--effort に low|medium|high|xhigh が必要}"; shift 2 ;;
    --smoke)   SMOKE=1; shift ;;
    --check)   CHECK=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

if [[ -n "$EFFORT" ]] && [[ "$EFFORT" != "low" && "$EFFORT" != "medium" && "$EFFORT" != "high" && "$EFFORT" != "xhigh" ]]; then
  echo "ERROR: --effort は low|medium|high|xhigh のいずれか: $EFFORT" >&2
  usage
fi

# codex実行パスの解決: PATH → バージョン別binの最新 → アプリ同梱のsandbox-bin
# バージョン別bin（Windows: OpenAI\Codex\bin\<hash>\）を優先する。シェル実行用
# サンドボックスヘルパーが同じフォルダにあり、Codexがレビュー中に git diff 等を
# 直接実行できるため。.sandbox-bin はヘルパー欠如でシェル実行が落ちることがある。
resolve_codex() {
  if command -v codex >/dev/null 2>&1; then
    command -v codex
    return
  fi
  # Windows: Codexデスクトップアプリの同梱CLI
  if [[ -n "${LOCALAPPDATA:-}" ]]; then
    # LOCALAPPDATAはWindows形式（C:\Users\...）のことがあり、そのままでは
    # bashのglob展開に失敗する環境がある → Unix形式へ変換
    local base="$LOCALAPPDATA"
    if command -v cygpath >/dev/null 2>&1; then
      base="$(cygpath -u "$base")"
    fi
    local newest
    newest="$(ls -t "$base"/OpenAI/Codex/bin/*/codex.exe 2>/dev/null | head -1 || true)"
    if [[ -n "$newest" ]]; then
      echo "$newest"
      return
    fi
  fi
  local sandbox_bin="${USERPROFILE:-$HOME}/.codex/.sandbox-bin/codex.exe"
  if [[ -x "$sandbox_bin" ]]; then
    echo "$sandbox_bin"
    return
  fi
  echo "ERROR: codex CLI が見つからない（PATH / OpenAI\\Codex\\bin / ~/.codex/.sandbox-bin を確認）" >&2
  exit 1
}

# --check: 利用可否のみ判定（バイナリ解決 + --version。codex exec を呼ばないため
# トークン消費なし）。スキルが「Codexが使えるか」を安全に確かめるための入口。
# 注意: 認証の有効性までは見ない（バイナリ有無のみ）。認証切れはレビュー実行時に
# CLIエラーで顕在化し、guides.mdの「CLI失敗時は手動レビューへ切替」で吸収する。
if [[ "$CHECK" -eq 1 ]]; then
  # if条件内の代入は set -e の対象外。resolve失敗時やversion取得失敗時は else へ。
  # --version まで && 連鎖で検証する: 単に echo の中で $(... --version) を展開
  # すると、versionが非0終了でもechoが成功して exit 0 になり、起動できない壊れた
  # codexを「利用可」と誤判定してしまう。version取得を独立した検証ステップにし、
  # 非0/空出力なら利用不可とする。
  if CODEX="$(resolve_codex 2>/dev/null)" && [[ -n "$CODEX" ]] \
     && CODEX_VER="$("$CODEX" --version < /dev/null 2>/dev/null)" && [[ -n "$CODEX_VER" ]]; then
    echo "codex: 利用可能 — $CODEX ($CODEX_VER)"
    exit 0
  else
    echo "codex: 利用不可（起動できる codex CLI が無い。PATH / OpenAI\\Codex\\bin / ~/.codex/.sandbox-bin を確認）" >&2
    exit 1
  fi
fi

CODEX="$(resolve_codex)"
echo "codex: $CODEX ($("$CODEX" --version < /dev/null))" >&2

if [[ "$SMOKE" -eq 1 ]]; then
  # 認証・ヘッドレス実行の疎通確認のみ（最小トークン。既定low）
  "$CODEX" exec --skip-git-repo-check -s read-only \
    -c "model_reasoning_effort=\"${EFFORT:-low}\"" \
    "接続テストです。「OK」とだけ返答してください。" < /dev/null
  exit $?
fi

[[ -n "$REQUEST" ]] || { echo "ERROR: --request が必要（--smoke 以外）" >&2; usage; }
[[ -f "$REQUEST" ]] || { echo "ERROR: 依頼書が存在しない: $REQUEST" >&2; exit 1; }
[[ -s "$REQUEST" ]] || { echo "ERROR: 依頼書が空: $REQUEST" >&2; exit 1; }
[[ -n "$OUT" ]] || { echo "ERROR: --out が必要" >&2; usage; }
[[ ${#TARGET_ARGS[@]} -gt 0 ]] || TARGET_ARGS=(--uncommitted)

mkdir -p "$(dirname "$OUT")"

# CLI制約: `codex exec review` は差分指定フラグ（--uncommitted等）とカスタム指示
# （PROMPT）を併用できない。依頼書モードでは差分範囲を指示文の先頭行に変換して
# 渡し、Codex自身にgitで差分を取得させる（read-onlyサンドボックス内で実行される）。
case "${TARGET_ARGS[0]}" in
  --uncommitted) SCOPE="レビュー対象差分: 未コミット変更すべて（staged/unstaged/untracked）。\`git status\` と \`git diff HEAD\`・untrackedファイルの内容で取得すること。" ;;
  --base)        SCOPE="レビュー対象差分: ブランチ ${TARGET_ARGS[1]} との差分。\`git diff ${TARGET_ARGS[1]}...HEAD\` で取得すること。" ;;
  --commit)      SCOPE="レビュー対象差分: コミット ${TARGET_ARGS[1]} の変更。\`git show ${TARGET_ARGS[1]}\` で取得すること。" ;;
esac

# 依頼書はstdin経由で渡す（"-"指定。引数渡しのコマンドライン長制限を回避）。
# stdinは依頼書EOFで閉じるため入力待ちハングは起きない。
# sandboxはread-onlyに固定（reviewの既定はworkspace-write。レビュー専用で
# リポジトリを変更させず、実装者側の編集との衝突を防ぐ）。
# effortはconfig.tomlのxhighを上書きし既定high（サブスク枠の消費を抑える）。
{ echo "$SCOPE"; echo; cat "$REQUEST"; } | \
  "$CODEX" exec review \
    -c 'sandbox_mode="read-only"' \
    -c "model_reasoning_effort=\"${EFFORT:-high}\"" \
    -o "$OUT" -

[[ -s "$OUT" ]] || { echo "ERROR: レビュー結果が空: $OUT" >&2; exit 1; }
echo "review saved: $OUT" >&2
