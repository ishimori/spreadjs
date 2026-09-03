// DD-036 C5（AC9）: 年グリッド規模（382 列 × 80 行・非空 約 3 万セル）の性能実測。
//
// ③納入計画は「列＝日付」のマトリクスで、DD-004 の実測域（50,000 行 × 200 列）に対し**列数が約 1.9 倍**になる。
// 列数依存の経路（列 Axis の prefix sum・列ヘッダー描画・pane ごとの列走査・静的列背景の列バンド）が
// 予算内かを、単独モード（standalone.html?extracols=378&frozencols=5）で計測する。
//
// 計測項目（計画書 §21 / DD-004 §18.2 の該当分）:
//   ① 初回描画: setData 再注入 → 全行が描かれた最初のフレームまで（Axis 構築＋初回 draw を含む）
//   ② 横スクロール: rAF ごとに scrollLeft を進めながらのフレーム間隔 p50/p95/worst（目標 p95 < 33ms）
//   ③ 入力確定: 常駐 textarea への確定 dispatch（同期の submit 経路）の所要（目標 < 50ms）
// 結果は test-results/dd-evidence/DD-036/wide-grid-perf.json へ保存する（DD 添付の計測記録へ転記）。
//
// 再現コマンド:
//   npx playwright test --config apps/playground/playwright.config.ts wide-grid-perf --headed
// ⚠️ ファイル名の zz- は実行順制御（workers:1・ファイル名昇順）＝他 spec の後に実行する（大量データ注入のため）。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import * as sa from './standalone-helpers';

const EXTRA_COLS = 378; // 既定 4 列 ＋ 378 = 382 列（ラベル 5 ＋ 日付 365 ＋ 月計 12 相当）
const ROWS = 80;
const FROZEN_COLS = 5;
const SCROLL_MS = 2000;
const SCROLL_STEP_PX = 40;
/** 目標値（計画書 §21・DD-004 §18.2）。 */
const P95_BUDGET_MS = 33;
const COMMIT_BUDGET_MS = 50;

interface PerfResult {
  columns: number;
  rows: number;
  nonEmptyCells: number;
  initialDrawMs: number;
  frameP50Ms: number;
  frameP95Ms: number;
  frameWorstMs: number;
  frameCount: number;
  commitMs: number;
}

function evidenceJsonPath(): string {
  return fileURLToPath(new URL('../../../test-results/dd-evidence/DD-036/wide-grid-perf.json', import.meta.url));
}

test('AC9: 382 列 × 80 行（非空 約 3 万セル）で初回描画・横スクロール・入力確定が予算内', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto(`/standalone.html?extracols=${EXTRA_COLS}&frozencols=${FROZEN_COLS}&frozenrows=1`);
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);

    const result = await page.evaluate(
      async ({ rows, scrollMs, stepPx }: { rows: number; scrollMs: number; stepPx: number }) => {
        const api = (window as unknown as { __integrationTestApi: { rowCount(): number; colIdAt(i: number): string | undefined } })
          .__integrationTestApi;
        const columnIds: string[] = [];
        for (let i = 0; ; i += 1) {
          const id = api.colIdAt(i);
          if (id === undefined) {
            break;
          }
          columnIds.push(id);
        }
        // ① 初回描画: 全セル（rows × columns）を注入し、行数が反映された最初のフレームまでを測る。
        const data = {
          rows: Array.from({ length: rows }, (_v, r) => {
            const cells: Record<string, string> = {};
            for (let c = 0; c < columnIds.length; c += 1) {
              cells[columnIds[c]!] = c < 5 ? `L${r}-${c}` : String(((r * 31 + c * 7) % 900) + 100);
            }
            return { rowId: `r${r}`, cells };
          }),
        };
        const nonEmptyCells = rows * columnIds.length;
        const t0 = performance.now();
        window.__standalone!.reinject(data);
        const initialDrawMs = await new Promise<number>((resolve) => {
          const tick = (): void => {
            if (api.rowCount() === rows) {
              // 行 Axis 反映後、実際に描かれるフレームを 1 つ待ってから確定する。
              requestAnimationFrame(() => resolve(performance.now() - t0));
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });

        // ② 横スクロール: rAF ごとに scrollLeft を進めながらフレーム間隔を記録する。
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
            let next = scroller.scrollLeft + stepPx * dir;
            if (next >= maxLeft) {
              next = maxLeft;
              dir = -1;
            } else if (next <= 0) {
              next = 0;
              dir = 1;
            }
            scroller.scrollLeft = next;
            if (now - start >= scrollMs) {
              resolve();
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        // 先頭 2 フレーム（計測開始直後の外れ値）を捨てて分位を取る。
        const sorted = intervals.slice(2).sort((a, b) => a - b);
        const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;

        // ③ 入力確定: 常駐 textarea へ確定シーケンスを dispatch した同期処理時間（submit 経路）。
        scroller.scrollLeft = 0;
        const ta = document.querySelector('textarea.int-cell-editor') as HTMLTextAreaElement;
        ta.focus();
        ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        ta.value = '9999';
        ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: '9999', bubbles: true }));
        ta.dispatchEvent(new CompositionEvent('compositionend', { data: '9999', bubbles: true }));
        ta.dispatchEvent(
          new InputEvent('input', { inputType: 'insertCompositionText', data: '9999', isComposing: false, bubbles: true }),
        );
        const c0 = performance.now();
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const commitMs = performance.now() - c0;

        return {
          columns: columnIds.length,
          rows,
          nonEmptyCells,
          initialDrawMs,
          frameP50Ms: at(0.5),
          frameP95Ms: at(0.95),
          frameWorstMs: sorted[sorted.length - 1] ?? 0,
          frameCount: sorted.length,
          commitMs,
        } satisfies PerfResult;
      },
      { rows: ROWS, scrollMs: SCROLL_MS, stepPx: SCROLL_STEP_PX },
    );

    const jsonPath = evidenceJsonPath();
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(
      jsonPath,
      JSON.stringify({ measuredAt: new Date().toISOString(), ...result }, null, 2),
      'utf8',
    );
    // eslint-disable-next-line no-console -- 計測値は再現コマンドの出力として読む（レポート転記用）
    console.log('[DD-036 AC9] wide-grid-perf', JSON.stringify(result));

    expect(result.columns).toBe(EXTRA_COLS + 4);
    expect(result.nonEmptyCells).toBeGreaterThanOrEqual(30_000);
    expect(result.frameCount).toBeGreaterThan(20);
    expect(result.frameP95Ms).toBeLessThan(P95_BUDGET_MS);
    expect(result.commitMs).toBeLessThan(COMMIT_BUDGET_MS);
    // 初回描画（382 列 × 80 行の Axis 構築＋初回 draw）は 1 秒以内（§21 の初回表示予算に対し十分な余裕）。
    expect(result.initialDrawMs).toBeLessThan(1000);
    await page.screenshot({ path: sa.evidencePath('../DD-036/e2e-wide-grid-382cols.png') });
  } finally {
    await context.close();
  }
});
