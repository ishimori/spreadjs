// DD-017 P2-2: 配布ディレクトリの manifest.json と実 tarball の同一性を検査する。
//
// build-release.sh が刻んだ manifest（package 名・版・ファイル名・sha256・bytes）と、実ディレクトリの tarball を
// 突き合わせ、stale／改変された tarball の誤用（DA #3 tarball 運用の腐敗）を機械検出する。
// 使い方: node scripts/release/verify-manifest.mjs <配布ディレクトリ>

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (dir === undefined) {
  console.error('[verify-manifest] NG: 配布ディレクトリを引数で指定してください');
  process.exit(2);
}

const manifestPath = join(dir, 'manifest.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`[verify-manifest] NG: manifest.json を読めない: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const failures = [];
const listed = new Set();

for (const pkg of manifest.packages ?? []) {
  listed.add(pkg.tarball);
  const file = join(dir, pkg.tarball);
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    failures.push(`${pkg.name}: tarball ${pkg.tarball} が存在しない`);
    continue;
  }
  if (pkg.version !== manifest.version) {
    failures.push(`${pkg.name}: version ${pkg.version} が manifest.version ${manifest.version} と不一致`);
  }
  const expectedName = `nanairo-sheet-${pkg.name.replace('@nanairo-sheet/', '')}-${pkg.version}.tgz`;
  if (pkg.tarball !== expectedName) {
    failures.push(`${pkg.name}: ファイル名 ${pkg.tarball} が期待 ${expectedName} と不一致`);
  }
  const bytes = statSync(file).size;
  if (typeof pkg.bytes === 'number' && bytes !== pkg.bytes) {
    failures.push(`${pkg.name}: bytes ${bytes} が manifest ${pkg.bytes} と不一致`);
  }
  const sha256 = createHash('sha256').update(buf).digest('hex');
  if (sha256 !== pkg.sha256) {
    failures.push(`${pkg.name}: sha256 不一致（実 ${sha256} / manifest ${pkg.sha256}）＝stale/改変の疑い`);
  }
}

// manifest に無い余分な tarball（stray）が混ざっていないか。
for (const f of readdirSync(dir).filter((n) => n.endsWith('.tgz'))) {
  if (!listed.has(f)) {
    failures.push(`manifest に無い tarball が存在する（stray）: ${f}`);
  }
}

if (failures.length > 0) {
  console.error('[verify-manifest] NG: manifest と配布 tarball の同一性検査に失敗');
  for (const f of failures) {
    console.error('  - ' + f);
  }
  process.exit(1);
}

console.log(
  `[verify-manifest] OK: ${manifest.packages.length} tarball が manifest（version ${manifest.version} / channel ${manifest.channel}）と一致（sha256 検証済）`,
);

// DD-040: 再現性の注意喚起。**同一性検査とは別物なので失敗にはしない**（tarball と manifest は一致しており、
// 問題は「その manifest が指すコミットから再生成できない」こと）。配布ディレクトリは repo の外にも置かれる
// ため再計算はできず、manifest に記録された値をそのまま伝える。古い manifest はフィールドを持たない＝
// undefined になるので、その場合は何も言わない（後方互換）。
if (manifest.closureDirty === true) {
  const paths = Array.isArray(manifest.closureDirtyPaths) ? manifest.closureDirtyPaths : [];
  console.warn(
    `[verify-manifest] WARN: closureDirty=true — この成果物は gitCommit ${manifest.gitCommit ?? '(不明)'} から再現できません（配布に影響するパスに未コミット変更があった状態で生成された）。配布判断の証拠には使わないでください。`,
  );
  for (const p of paths) {
    console.warn('  - ' + p);
  }
} else if (manifest.closureDirty === false && manifest.gitDirty === true) {
  console.log(
    '[verify-manifest] note: gitDirty=true ですが配布 closure の外の変更のみ（成果物は gitCommit から再現可能）。',
  );
}
