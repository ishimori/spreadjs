import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser } from '@playwright/test';
import * as sa from './standalone-helpers';

async function measure(browser: Browser, rows: number, cols: number, borders: boolean | 'pattern') {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    const params = new URLSearchParams({ extracols: String(cols - 4), frozencols: '5', frozenrows: '1' });
    if (borders) {
      params.set('colborder', Array.from({ length: Math.floor((cols - 4) / 2) }, (_, i) => `col-x${i * 2 + 1}:right:2:64748b${borders === 'pattern' ? ':dashed' : ''}`).join(';'));
      params.set('rowborder', 'r10:top:2:64748b;r20:top:2:64748b;r30:top:2:64748b');
      if (borders === 'pattern') params.set('defaultrowborder', '1:cbd5e1:dotted');
    }
    await page.goto(`/standalone.html?${params}`);
    await sa.waitReady(page);
    const result = await page.evaluate(async ({ rows, cols }) => {
      const api = window.__integrationTestApi!;
      const ids = Array.from({ length: cols }, (_, i) => api.colIdAt(i)!);
      window.__standalone!.reinject({ rows: Array.from({ length: rows }, (_, r) => ({
        rowId: `r${r}`,
        cells: Object.fromEntries((rows > 1000 ? ids.slice(0, 8) : ids).map((id, c) => [id, `${r}-${c}`])),
      })) });
      await new Promise<void>((resolve) => {
        function poll() { if (api.rowCount() === rows) requestAnimationFrame(() => requestAnimationFrame(() => resolve())); else requestAnimationFrame(poll); }
        requestAnimationFrame(poll);
      });
      const scroller = document.querySelector('.nsheet-scroller') as HTMLElement;
      const maxLeft = scroller.scrollWidth - scroller.clientWidth;
      const times: number[] = [];
      await new Promise<void>((resolve) => {
        let last = performance.now();
        const start = last;
        let dir = 1;
        const step = (now: number) => {
          times.push(now - last); last = now;
          const next = scroller.scrollLeft + dir * 80;
          if (next >= maxLeft || next <= 0) dir *= -1;
          scroller.scrollLeft = Math.max(0, Math.min(maxLeft, next));
          if (now - start >= 1500) resolve(); else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      const sorted = times.slice(3).sort((a, b) => a - b);
      return { rows, cols, frameCount: sorted.length, frameP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0, worstMs: sorted.at(-1) ?? 0, samplesMs: times.slice(3), userAgent: navigator.userAgent };
    }, { rows, cols });
    if (borders && rows <= 70) await page.screenshot({ path: fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-047/matrix-${rows}x${cols}.png`, import.meta.url)) });
    return result;
  } finally { await context.close(); }
}

test('DD-048 共通点線+縦破線 50,000x200 frameP95<33ms / 増分<=3ms', async ({ browser }) => {
  const baseline = await measure(browser, 50000, 200, false);
  const patterns = await measure(browser, 50000, 200, 'pattern');
  const result = { measuredAt: new Date().toISOString(), viewport: '1280x800', dpr: 1, nonEmptyCells: 400000, baseline, patterns, deltaMs: patterns.frameP95Ms - baseline.frameP95Ms };
  const out = fileURLToPath(new URL('../../../test-results/dd-evidence/DD-048/perf-50000x200.json', import.meta.url));
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log('[DD-048 perf]', JSON.stringify({ baseline: baseline.frameP95Ms, patterns: patterns.frameP95Ms, delta: result.deltaMs }));
  expect(patterns.frameCount).toBeGreaterThan(30);
  expect(patterns.frameP95Ms).toBeLessThan(33);
  expect(result.deltaMs).toBeLessThanOrEqual(3);
});

for (const [rows, cols] of [[60, 200], [70, 382], [50000, 200]] as const) {
  test(`DD-047 frameP95 ${rows}x${cols} <33ms / 増分<=3ms`, async ({ browser }) => {
    const baseline = await measure(browser, rows, cols, false);
    const borders = await measure(browser, rows, cols, true);
    const result = { measuredAt: new Date().toISOString(), browser: 'Chromium / Windows / DPR 1', baseline, borders, deltaMs: borders.frameP95Ms - baseline.frameP95Ms };
    const out = fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-047/perf-${rows}x${cols}.json`, import.meta.url));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
    console.log('[DD-047 perf]', JSON.stringify(result));
    expect(borders.frameCount).toBeGreaterThan(30);
    expect(borders.frameP95Ms).toBeLessThan(33);
    expect(result.deltaMs).toBeLessThanOrEqual(3);
  });
}
