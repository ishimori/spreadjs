// DD-027-3 セル書式モデルの headed 描画性能計測（before=書式なし / after=書式あり）。
//
// 目的: 可視非空セル×毎フレームの getCellStyle lookup ＋ 背景 inset fillRect ＋ バッジチップ描画を足しても、
//   50k 行スクロールの frame p95 ≤16.7ms・stopped redraw ≤12ms（perf-budget.json）を守ることを before/after で示す。
// worst case: 統合シードの日本語ステータス語（承認済み/保留中/対応中/完了/未着手・全体の約25%）へ書式を当て、
//   可視列（col-0..col-20）全てにルールを敷く（getCellStyle が可視非空セルごとに呼ばれ、約25%が背景/バッジ描画になる）。
//
// 使い方（dev サーバー起動中・50k シード）:
//   bash scripts/dev-start.sh --integration
//   node scripts/cg-perf/run-format-perf.mjs http://localhost:5885 http://127.0.0.1:9499 [durationMs]
// レポート出力: doc/DD/DD-027-3/perf-{before,after}-*.json

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(REPO, 'doc', 'DD', 'DD-027-3');

const viteBase = process.argv[2] ?? 'http://localhost:5885';
const serverUrl = process.argv[3] ?? 'http://127.0.0.1:9499';
const durationMs = Number(process.argv[4] ?? 45000);

// 可視列（col-0..col-20）へ日本語ステータス語の書式（背景色＋バッジ）を敷く。
const STATUS_RULES =
  '承認済み=badge+bc#34a853+fg#ffffff;保留中=bg#fde293;対応中=bg#d2e3fc;完了=badge+bc#1a73e8+fg#ffffff;未着手=bg#fce8e6';
const formatSpec = Array.from({ length: 21 }, (_, i) => `col-${i}:${STATUS_RULES}`).join(',');

function urlFor(withFormat) {
  const base = `${viteBase}/poc-integration.html?server=${encodeURIComponent(serverUrl)}&perf=1&name=CG6-fmt`;
  return withFormat ? `${base}&format=${encodeURIComponent(formatSpec)}` : base;
}

async function measure(page, url, label, outPath) {
  console.log(`[fmt-perf] navigate (${label}): ${url}`);
  await page.goto(url);
  /* eslint-disable no-undef */
  await page.waitForFunction(() => window.__integrationTestApi?.ready() === true, null, { timeout: 20000 });
  const rowCount = await page.evaluate(() => window.__integrationTestApi.rowCount());
  await page.waitForFunction(() => typeof window.__cg6Run === 'function', null, { timeout: 10000 });
  console.log(`[fmt-perf] ${label}: ready rowCount=${rowCount} — measuring ~${Math.round(durationMs / 1000)}s ...`);
  const report = await page.evaluate((ms) => window.__cg6Run(ms), durationMs);
  /* eslint-enable no-undef */
  fs.writeFileSync(outPath, JSON.stringify({ label, url, ...report }, null, 2));
  const sr = report.stoppedRedrawMs;
  const srMean = Array.isArray(sr) && sr.length ? sr.reduce((a, b) => a + b, 0) / sr.length : sr;
  console.log(
    `[fmt-perf] ${label} saved: ${outPath}\n` +
      `   frame.count=${report.frame.count} p50=${report.frame.p50} p95=${report.frame.p95} ` +
      `stoppedRedrawMean=${typeof srMean === 'number' ? srMean.toFixed(2) : srMean} visibleCellCount=${report.visibleCellCount}`,
  );
  return report;
}

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}
const browser = await chromium.launch({ headless: false, args: ['--enable-precise-memory-info'] });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const beforePath = path.join(OUT_DIR, 'perf-before-no-format.json');
  const afterPath = path.join(OUT_DIR, 'perf-after-with-format.json');
  const before = await measure(page, urlFor(false), 'before(書式なし)', beforePath);
  const after = await measure(page, urlFor(true), 'after(書式あり)', afterPath);

  console.log('\n[fmt-perf] === judge (budget=scripts/cg-perf/perf-budget.json) ===');
  for (const [label, out] of [['before', beforePath], ['after', afterPath]]) {
    console.log(`--- judge ${label} ---`);
    try {
      console.log(execFileSync('node', [path.join(HERE, 'judge-perf-report.mjs'), out], { encoding: 'utf8' }));
    } catch (e) {
      if (e.stdout) console.log(e.stdout);
      console.log(`[fmt-perf] judge ${label} exit 1 (over budget or fail)`);
    }
  }
  console.log(
    `\n[fmt-perf] SUMMARY frame.p95: before=${before.frame.p95}ms after=${after.frame.p95}ms | ` +
      `visibleCellCount before=${before.visibleCellCount} after=${after.visibleCellCount}`,
  );
} finally {
  await browser.close();
}
