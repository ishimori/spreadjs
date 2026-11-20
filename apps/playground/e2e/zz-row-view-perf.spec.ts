// DD-070-8 AC6: 5 万行で setRowView（並べ替え・絞り込みの反映）が setData（作り直し）より十分速いことを測って記録する。
// 結果は test-results/dd-evidence/DD-070-8/row-view-perf.json。再現: npx playwright test --config apps/playground/playwright.config.ts zz-row-view-perf

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import * as sa from './standalone-helpers';

const ROWS = 50_000;

test('AC6: 5 万行・40 列で setRowView は setData より十分速い（並べ替え・絞り込み）', async ({ browser }) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto('/standalone.html?extracols=36&frozenrows=0');
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);
    const result = await page.evaluate(async (rows: number) => {
      type G = { setData(d: unknown): void; setRowView(ids: string[] | null): void; visibleRowIds(): string[] };
      const g = (window as Window & { __gridInstance?: G }).__gridInstance!;
      const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const columns = ['col-a', 'col-b', 'col-c', 'col-d', ...Array.from({ length: 36 }, (_v, i) => `col-x${i}`)];
      const data = {
        rows: Array.from({ length: rows }, (_v, r) => ({
          rowId: `r${r}`,
          cells: Object.fromEntries(columns.map((c, i) => [c, i % 2 === 0 ? `v${(r * 7 + i) % 1000}` : String((r * 13 + i) % 997)])),
        })),
      };
      let t0 = performance.now();
      g.setData(data);
      g.visibleRowIds(); // 同期で反映させる
      await nextFrame();
      const setDataMs = performance.now() - t0;
      const sorted = data.rows.map((row) => row.rowId).reverse();
      t0 = performance.now();
      g.setRowView(sorted);
      const visibleSorted = g.visibleRowIds();
      await nextFrame();
      const sortMs = performance.now() - t0;
      const filtered = sorted.filter((_id, i) => i % 3 === 0);
      t0 = performance.now();
      g.setRowView(filtered);
      const visibleFiltered = g.visibleRowIds();
      await nextFrame();
      const filterMs = performance.now() - t0;
      return { setDataMs, sortMs, filterMs, sortedFirst: visibleSorted[0], filteredCount: visibleFiltered.length };
    }, ROWS);
    const out = fileURLToPath(new URL('../../../test-results/dd-evidence/DD-070-8/row-view-perf.json', import.meta.url));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), rows: ROWS, columns: 40, ...result }, null, 2), 'utf8');
    console.log('[DD-070-8] row-view-perf', JSON.stringify(result));
    expect(result.sortedFirst).toBe(`r${ROWS - 1}`);
    expect(result.filteredCount).toBe(Math.ceil(ROWS / 3));
    expect(result.sortMs).toBeLessThan(result.setDataMs / 2);
    expect(result.filterMs).toBeLessThan(result.setDataMs / 2);
  } finally {
    await context.close();
  }
});
