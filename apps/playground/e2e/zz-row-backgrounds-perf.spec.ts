// DD-045 AC8: consumer 相当 60行×205列・行帯2本の横スクロール frame p95 をベースラインと比較する。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Browser } from '@playwright/test';

import * as sa from './standalone-helpers';

const ROWS = 60;
const EXTRA_COLS = 201;
const P95_BUDGET_MS = 33;
const REGRESSION_TOLERANCE_MS = 3;

interface Measurement {
  columns: number;
  rows: number;
  frameCount: number;
  frameP50Ms: number;
  frameP95Ms: number;
  frameWorstMs: number;
}

async function measure(browser: Browser, rowBackgrounds: boolean): Promise<Measurement> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    const rowQuery = rowBackgrounds ? '&rowbg=r30:e5e7eb,r45:fef3c7' : '';
    await page.goto(`/standalone.html?extracols=${EXTRA_COLS}&frozencols=5&frozenrows=1${rowQuery}`);
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);
    return await page.evaluate(async ({ rows }) => {
      const api = window.__integrationTestApi!;
      const columnIds: string[] = [];
      for (let i = 0; ; i += 1) {
        const id = api.colIdAt(i);
        if (id === undefined) break;
        columnIds.push(id);
      }
      window.__standalone!.reinject({
        rows: Array.from({ length: rows }, (_v, r) => {
          const cells: Record<string, string> = {};
          for (const [c, id] of columnIds.entries()) cells[id] = `${r}-${c}`;
          return { rowId: `r${r}`, cells };
        }),
      });
      await new Promise<void>((resolve) => {
        const wait = (): void => {
          if (api.rowCount() === rows) requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          else requestAnimationFrame(wait);
        };
        requestAnimationFrame(wait);
      });

      const scroller = document.querySelector('.nsheet-scroller') as HTMLElement;
      const maxLeft = scroller.scrollWidth - scroller.clientWidth;
      const intervals: number[] = [];
      await new Promise<void>((resolve) => {
        let last = performance.now();
        const start = last;
        let dir = 1;
        const step = (now: number): void => {
          intervals.push(now - last);
          last = now;
          let next = scroller.scrollLeft + dir * 80;
          if (next >= maxLeft) {
            next = maxLeft;
            dir = -1;
          } else if (next <= 0) {
            next = 0;
            dir = 1;
          }
          scroller.scrollLeft = next;
          if (now - start >= 1500) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      const sorted = intervals.slice(2).sort((a, b) => a - b);
      const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
      return {
        columns: columnIds.length,
        rows,
        frameCount: sorted.length,
        frameP50Ms: at(0.5),
        frameP95Ms: at(0.95),
        frameWorstMs: sorted[sorted.length - 1] ?? 0,
      };
    }, { rows: ROWS });
  } finally {
    await context.close();
  }
}

test('AC8: 行帯2本の frameP95 は33ms未満かつ背景なし比+3ms以内', async ({ browser }) => {
  const baseline = await measure(browser, false);
  const rowBackgrounds = await measure(browser, true);
  const result = {
    measuredAt: new Date().toISOString(),
    baseline,
    rowBackgrounds,
    p95DeltaMs: rowBackgrounds.frameP95Ms - baseline.frameP95Ms,
  };
  const out = fileURLToPath(new URL('../../../test-results/dd-evidence/DD-045/row-backgrounds-perf.json', import.meta.url));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log('[DD-045 AC8] row-backgrounds-perf', JSON.stringify(result));

  expect(rowBackgrounds.columns).toBe(205);
  expect(rowBackgrounds.rows).toBe(60);
  expect(rowBackgrounds.frameCount).toBeGreaterThan(30);
  expect(rowBackgrounds.frameP95Ms).toBeLessThan(P95_BUDGET_MS);
  expect(rowBackgrounds.frameP95Ms).toBeLessThanOrEqual(baseline.frameP95Ms + REGRESSION_TOLERANCE_MS);
});

