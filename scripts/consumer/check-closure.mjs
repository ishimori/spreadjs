// pack closure の宣言健全性を静的検査する（DD-016-2 Phase 3・DA #4 ハードニング）。
//
// 目的: 「pack closure が flat install の hoisting 頼みで、内部 package 相互の実行時依存の
//   宣言漏れ（devDependencies のまま）を隠していないか」を機械検出する。
//   npm install <closure 全 tarball> は全 package を top-level へ hoist するため、依存を devDependencies に
//   置いていても module 解決は"たまたま"通ってしまう（＝宣言漏れが install 成功で隠れる）。
//   本検査は install 成否に依存せず、各内部 package の**非テスト（実行時）ソース**が import する
//   `@nanairo-sheet/*` が、その package の `dependencies` に宣言されていることを直接検証する。
//
// 合格条件: 実行時 import された内部 package specifier が全て dependencies に宣言済み（devDependencies
//   のみは NG）。テストファイル（*.test.ts / *.spec.ts / test-support.ts）の import は対象外
//   （テスト専用依存は devDependencies で正当）。
//
// 使い方: node scripts/consumer/check-closure.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

/** テスト（実行時でない）とみなすファイル。これらの import は dependencies 宣言を要求しない。 */
function isTestFile(name) {
  return /\.test\.ts$/.test(name) || /\.spec\.ts$/.test(name) || name === 'test-support.ts';
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      out.push(...walk(p));
    } else if (entry.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** ソースから `@nanairo-sheet/<pkg>`（サブパスは head のみ）を抽出する。 */
function internalImports(src) {
  const found = new Set();
  const re = /@nanairo-sheet\/([a-z-]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    found.add(m[1]);
  }
  return found;
}

const failures = [];
const pkgNames = readdirSync(PACKAGES_DIR).filter((n) => statSync(join(PACKAGES_DIR, n)).isDirectory());

for (const pkg of pkgNames) {
  const pkgDir = join(PACKAGES_DIR, pkg);
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const selfName = manifest.name; // @nanairo-sheet/<pkg>
  const declaredDeps = new Set(Object.keys(manifest.dependencies ?? {}));
  const declaredDev = new Set(Object.keys(manifest.devDependencies ?? {}));

  const srcDir = join(pkgDir, 'src');
  let files;
  try {
    files = walk(srcDir);
  } catch {
    continue; // src なし
  }

  const runtimeNeeds = new Set(); // このpackが実行時に必要とする @nanairo-sheet/* 名
  for (const file of files) {
    if (isTestFile(basename(file))) {
      continue;
    }
    for (const shortName of internalImports(readFileSync(file, 'utf8'))) {
      const full = `@nanairo-sheet/${shortName}`;
      if (full === selfName) {
        continue; // 自己参照（サブパス相対名の誤検出防止）
      }
      runtimeNeeds.add(full);
    }
  }

  for (const need of runtimeNeeds) {
    if (declaredDeps.has(need)) {
      continue;
    }
    if (declaredDev.has(need)) {
      failures.push(
        `${selfName}: 実行時 import する ${need} が devDependencies に置かれている（pack install の hoisting で隠れる宣言漏れ）。dependencies へ移すこと。`,
      );
    } else {
      failures.push(`${selfName}: 実行時 import する ${need} が dependencies にも devDependencies にも未宣言。`);
    }
  }
}

if (failures.length > 0) {
  console.error('[closure] NG: 内部 package 相互依存の宣言漏れを検出');
  for (const f of failures) {
    console.error('  - ' + f);
  }
  process.exit(1);
}

console.log('[closure] OK: 全内部 package の実行時 inter-dep が dependencies に宣言済み（hoisting 非依存で closure が honest）');
