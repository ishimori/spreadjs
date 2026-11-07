// サイズのガード（DD-065）— CLI。`npm run lint:size`（`npm run lint` からも呼ばれる）。
//
//   node scripts/size-guard/check.mjs                    # 判定する
//   node scripts/size-guard/check.mjs --update-baseline  # 減った値を baseline へ固定する（増やす・足すことはしない）
//
// 対象: packages/*/src のテスト以外の .ts/.tsx（*.test.* と *.d.ts を除く）。閾値と規則は measure.mjs・evaluate.mjs。
// 比較元: 環境変数 SIZE_GUARD_BASE_REF（CI は push 前のコミット・PR のベース）。未設定ならローカルの HEAD。
// 失敗したときの対応は AGENTS.md「サイズのガード」。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { THRESHOLDS, measureSource } from './measure.mjs';
import { evaluate, tightenBaseline } from './evaluate.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_REL = 'scripts/size-guard/baseline.json';
const BASELINE_PATH = path.join(REPO_ROOT, BASELINE_REL);
const DD_DIRS = ['doc/DD', 'doc/archived/DD']; // .dd-config の DD_DIR・ARCHIVE_DIR と同じ
const UPDATE = process.argv.includes('--update-baseline');

function toRel(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

function collectFiles() {
  const out = [];
  const packagesDir = path.join(REPO_ROOT, 'packages');
  for (const name of fs.readdirSync(packagesDir)) {
    const src = path.join(packagesDir, name, 'src');
    if (!fs.existsSync(src)) continue;
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name) && !ent.name.endsWith('.d.ts')) out.push(full);
      }
    };
    walk(src);
  }
  return out.sort();
}

function readBaseBaseline(ref) {
  if (ref === '' || /^0+$/.test(ref)) return null;
  try {
    const text = execFileSync('git', ['show', `${ref}:${BASELINE_REL}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function ddExists(dd) {
  return DD_DIRS.some((dir) => {
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) return false;
    return fs.readdirSync(abs).some((name) => name === dd || name.startsWith(`${dd}_`));
  });
}

const metrics = collectFiles().map((abs) => measureSource(toRel(abs), fs.readFileSync(abs, 'utf8')));
const hasBaseline = fs.existsSync(BASELINE_PATH);
const baseline = hasBaseline ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) : null;

if (UPDATE) {
  const { baseline: next, refused } = tightenBaseline({ metrics, baseline, thresholds: THRESHOLDS, initial: !hasBaseline });
  if (refused.length > 0) {
    console.error('[size] baseline を更新しません（増やす・足すことは --update-baseline ではできません）:');
    for (const r of refused) console.error(`  - ${r.id}: ${r.reason}`);
    process.exit(1);
  }
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`[size] baseline を更新しました: ファイル ${Object.keys(next.files).length} 件・関数 ${Object.keys(next.functions).length} 件 → ${BASELINE_REL}`);
  process.exit(0);
}

if (baseline === null) {
  console.error(`[size] ${BASELINE_REL} がありません。初回だけ npm run lint:size -- --update-baseline で作ってください`);
  process.exit(1);
}

// CI の schedule・手動実行では空文字が渡る → ローカルと同じく HEAD と比べる。全桁 0（新しいブランチの push）は比較元なし。
const baseRef = (process.env.SIZE_GUARD_BASE_REF ?? '').trim() || 'HEAD';
const baseBaseline = readBaseBaseline(baseRef);
const { errors, notices } = evaluate({
  metrics,
  baseline,
  baseBaseline,
  thresholds: THRESHOLDS,
  ddExists,
  baseLabel: `比較元（${baseRef}）`,
});

for (const n of notices) console.log(`[size] ${n.message}`);
const limits = `上限: ファイル ${THRESHOLDS.fileLines.toLocaleString('en-US')} 行・関数の循環的複雑度 ${THRESHOLDS.complexity}`;
if (errors.length > 0) {
  console.error(`\n[size] NG — ${errors.length} 件（${limits}）`);
  for (const e of errors) console.error(`  - ${e.message}`);
  console.error('\n  対応: AGENTS.md「サイズのガード」（baseline を上げるのは最後の手段で、その項目に exception〔dd・reason〕が要る）');
  process.exit(1);
}
console.log(
  `[size] OK — baseline どおり（ファイル ${Object.keys(baseline.files ?? {}).length} 件・関数 ${Object.keys(baseline.functions ?? {}).length} 件を記録。${limits}）`,
);
