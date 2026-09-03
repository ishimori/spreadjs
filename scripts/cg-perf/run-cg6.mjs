// CG-6 精密メモリ計測ランナー（DD-016-2 Phase 4）。
//
// 実 Chrome を **--enable-precise-memory-info** 付きで Playwright 起動し（MCP 既定起動では flag 不可）、
// Facade 統合経路（poc-integration.html?perf=1）で clean run（並行負荷なし）→ perf-capture ハーネスの
// window.__cg6Run() を実行 → report を doc/DD/DD-016-2/cg6-report.json へ保存 → judge-perf-report で判定する。
//
// 前提: dev サーバー起動中（vite :5885 / server-hono :8787 相当。既定は run 引数で上書き可）。
//   使い方: node scripts/cg-perf/run-cg6.mjs [viteBase] [serverUrl] [durationMs] [extraQuery] [outPath]
//   例:     node scripts/cg-perf/run-cg6.mjs http://localhost:5885 http://127.0.0.1:9499 96000
//   extraQuery: poc-integration.html へ追加する URL クエリ（URL エンコード済みで渡す。DD-027-3/DD-033 の
//               「オプション有効時」before/after 計測用。例: 'readonly=1&format=col-2:...'）
//   outPath:    レポート JSON の保存先（リポジトリ相対。既定=doc/DD/DD-016-2/cg6-report.json）

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const viteBase = process.argv[2] ?? 'http://localhost:5885';
const serverUrl = process.argv[3] ?? 'http://127.0.0.1:9499';
const durationMs = Number(process.argv[4] ?? 96000);
const extraQuery = process.argv[5] ?? '';
const OUT =
  process.argv[6] !== undefined
    ? path.resolve(REPO, process.argv[6])
    : path.join(REPO, 'doc', 'DD', 'DD-016-2', 'cg6-report.json');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const url = `${viteBase}/poc-integration.html?server=${encodeURIComponent(serverUrl)}&perf=1&name=CG6${extraQuery !== '' ? `&${extraQuery}` : ''}`;

const browser = await chromium.launch({
  headless: false, // 実 Chrome の描画経路で計測（headed）
  args: ['--enable-precise-memory-info'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  console.log(`[cg6] navigate: ${url}`);
  await page.goto(url);

  // ready（boot＋初回描画）待ち。以下のコールバックは Playwright がブラウザーページ内で評価する
  // （node ではなくブラウザーの `window` を参照する。eslint の no-undef は node env で誤検知するため無効化）。
  console.log('[cg6] waiting for grid ready...');
  /* eslint-disable no-undef */
  await page.waitForFunction(() => window.__integrationTestApi?.ready() === true, null, { timeout: 20000 });
  const online = await page.evaluate(() => window.__integrationTestApi.online());
  const rowCount = await page.evaluate(() => window.__integrationTestApi.rowCount());
  console.log(`[cg6] ready. online=${online} rowCount=${rowCount}`);

  // ハーネス登録待ち（dynamic import）。
  await page.waitForFunction(() => typeof window.__cg6Run === 'function', null, { timeout: 10000 });

  console.log(`[cg6] running clean-run measurement for ~${Math.round(durationMs / 1000)}s ...`);
  const report = await page.evaluate((ms) => window.__cg6Run(ms), durationMs);
  /* eslint-enable no-undef */

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`[cg6] report saved: ${OUT}`);
  console.log(
    `[cg6] memory samples=${report.memory.sampleCount} peakMB=${(Math.max(...report.memory.samples.map((s) => s.usedBytes)) / 1048576).toFixed(1)} ` +
      `slopeB/s=${report.memory.trend.slopeBytesPerSec} growth=${report.memory.trend.growthRatio} | frame.count=${report.frame.count} p95=${report.frame.p95} | visibleCellCount=${report.visibleCellCount}`,
  );
} finally {
  await browser.close();
}

// judge を実行（exit code はそのまま伝播せず、結果 JSON を stdout に出す）。
console.log('[cg6] --- judge ---');
try {
  const out = execFileSync('node', [path.join(HERE, 'judge-perf-report.mjs'), OUT], { encoding: 'utf8' });
  console.log(out);
  console.log('[cg6] judge exit: 0 (overallPass=true)');
} catch (e) {
  // over-budget/fail は exit 1（判定結果は stdout に出ている）。
  if (e.stdout) console.log(e.stdout);
  console.log(`[cg6] judge exit: ${e.status} (overallPass=false — memory/perf の内訳は上記 verdict 参照)`);
}
