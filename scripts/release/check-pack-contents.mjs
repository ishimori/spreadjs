// DD-044: npm pack の実成果物が consumer 向けの TS 製品ソースだけを含むか検査する。
// 使い方: node scripts/release/check-pack-contents.mjs <配布ディレクトリ>

import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (dir === undefined) {
  console.error('[pack-contents] NG: 配布ディレクトリを引数で指定してください');
  process.exit(2);
}

const manifestPath = join(dir, 'manifest.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`[pack-contents] NG: manifest.json を読めない: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function tarEntries(tarballPath) {
  const tar = gunzipSync(readFileSync(tarballPath));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const readText = (start, length) =>
      header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '').trim();
    const name = readText(0, 100);
    const prefix = readText(345, 155);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const sizeText = readText(124, 12);
    const size = Number.parseInt(sizeText === '' ? '0' : sizeText, 8);
    if (!Number.isFinite(size)) throw new Error(`invalid tar entry size: ${path}`);

    const type = String.fromCharCode(header[156] ?? 0);
    const bodyStart = offset + 512;
    if (type === '\0' || type === '0') {
      entries.set(path, tar.subarray(bodyStart, bodyStart + size));
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function exportTargets(value, targets = []) {
  if (typeof value === 'string') {
    if (value.startsWith('./')) targets.push(value);
    return targets;
  }
  if (Array.isArray(value)) {
    for (const item of value) exportTargets(item, targets);
    return targets;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) exportTargets(item, targets);
  }
  return targets;
}

const failures = [];
let checkedFiles = 0;
for (const pkg of manifest.packages ?? []) {
  let entries;
  try {
    entries = tarEntries(join(dir, pkg.tarball));
  } catch (error) {
    failures.push(`${pkg.name}: tarball を読めない: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  const paths = [...entries.keys()];
  checkedFiles += paths.length;
  for (const path of paths) {
    if (/(^|\/)tsconfig(?:\.[^/]*)?\.json$/i.test(path)) {
      failures.push(`${pkg.name}: monorepo 専用設定を同梱している: ${path}`);
    }
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)) {
      failures.push(`${pkg.name}: テストコードを同梱している: ${path}`);
    }
  }

  const packageJsonBytes = entries.get('package/package.json');
  if (packageJsonBytes === undefined) {
    failures.push(`${pkg.name}: package/package.json がない`);
    continue;
  }

  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonBytes.toString('utf8'));
  } catch (error) {
    failures.push(`${pkg.name}: package.json が不正: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  const requiredTargets = new Set(
    [packageJson.main, packageJson.types, ...exportTargets(packageJson.exports)].filter(
      (target) => typeof target === 'string' && target.startsWith('./'),
    ),
  );
  for (const target of requiredTargets) {
    const packedPath = `package/${target.slice(2)}`;
    if (!entries.has(packedPath)) {
      failures.push(`${pkg.name}: package.json が指す entrypoint を同梱していない: ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[pack-contents] NG: tarball 同梱物の健全性検査に失敗');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `[pack-contents] OK: ${manifest.packages.length} tarball / ${checkedFiles} files（tsconfig・test/spec なし、全 entrypoint あり）`,
);
