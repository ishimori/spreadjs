// DD-070-1: 180 列 × 想定行数（RM Database の一覧）の性能実測。
//
// 計画書 §21 の目標は「50,000 行・200 列・空でないセル 50 万（基準）〜200 万（ストレッチ）・メモリ 300MB 未満・
// スクロールの 95% のフレームが 33ms 未満」。180 列が埋まると約 1 万 1 千行で 200 万セルに届くため、目標の中
// （5,000 行・11,000 行）は判定し、目標の外（50,000 行の半分埋め・全部埋め）は値を記録するだけにする。
//
// 計測項目:
//   ① 読み込み: setData 再注入 → 行数が反映された後の最初のフレームまで（文書の構築＋Axis＋初回 draw）
//   ② 縦・横スクロール: rAF ごとに scrollTop / scrollLeft を進めたときのフレーム間隔 p50 / p95 / 最悪
//   ③ 入力確定: 常駐 textarea への確定 dispatch（同期の submit 経路）の所要
//   ④ JS ヒープ: GC（CDP HeapProfiler.collectGarbage）の後の JSHeapUsedSize（CDP Performance.getMetrics）。
//      注入前の値との差も残す（入力データのオブジェクトは evaluate の終了で手放してから測る）
// 結果は test-results/dd-evidence/DD-070-1/rm-database-perf.json へ保存する（DD の「計測結果」へ転記）。
//
// 再現コマンド:
//   npx playwright test --config apps/playground/playwright.config.ts zz-rm-database-perf
// ⚠️ ファイル名の zz- は実行順制御（workers:1・ファイル名昇順）＝他 spec の後に実行する（大量データ注入のため）。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GridDebugApi } from '@nanairo-sheet/grid/test-support';
import { expect, test, type Browser } from '@playwright/test';

import * as sa from './standalone-helpers';

const EXTRA_COLS = 176; // 既定 4 列 ＋ 176 = 180 列
const SCROLL_MS = 1500;
const P95_BUDGET_MS = 33;
const COMMIT_BUDGET_MS = 50;
const HEAP_BUDGET_MB = 300;
/** 行数の反映を待つ上限（テストの期限より短くして、届かなければ計測のエラーとして記録する）。 */
const LOAD_DEADLINE_MS = 120_000;

type DebugWindow = Window & { __integrationTestApi?: GridDebugApi };
/** 1 回の実行の印。worker は runner の子なので、worker が作り直されても同じ値になる。 */
const RUN_ID = String(process.ppid);
/**
 * 入力確定は 1 回の確定ごとに文書を丸ごと複製していた（core の applyOperation）ため、セルの数に比例して遅かった（DD-070-1）。
 * DD-070-10 で構造共有の複製に変えて判定に戻した。再び比例して遅くなったら、直すまでの間だけ true にして値を記録する。
 */
const COMMIT_KNOWN_SLOW = false;

interface PerfCase {
  readonly name: string;
  readonly rows: number;
  /** 空でないセルの割合（0〜1）。 */
  readonly density: number;
  /** 計画書 §21 の目標の中（判定する）か。 */
  readonly judged: boolean;
}

const CASES: readonly PerfCase[] = [
  { name: '5k-full', rows: 5_000, density: 1, judged: true },
  { name: '11k-full', rows: 11_000, density: 1, judged: true },
  { name: '50k-half', rows: 50_000, density: 0.5, judged: false },
  { name: '50k-full', rows: 50_000, density: 1, judged: false },
];

interface PerfResult {
  readonly name: string;
  readonly columns: number;
  readonly rows: number;
  readonly nonEmptyCells: number;
  readonly loadMs: number;
  readonly verticalP50Ms: number;
  readonly verticalP95Ms: number;
  readonly verticalWorstMs: number;
  readonly horizontalP50Ms: number;
  readonly horizontalP95Ms: number;
  readonly horizontalWorstMs: number;
  readonly commitMs: number;
  readonly heapBeforeMb: number;
  readonly heapAfterMb: number;
}

function evidenceJsonPath(): string {
  return fileURLToPath(new URL('../../../test-results/dd-evidence/DD-070-1/rm-database-perf.json', import.meta.url));
}

function saveResult(result: PerfResult | { readonly name: string; readonly error: string }): void {
  const path = evidenceJsonPath();
  mkdirSync(dirname(path), { recursive: true });
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    all = {};
  }
  all['runId'] = RUN_ID;
  all[result.name] = { measuredAt: new Date().toISOString(), ...result };
  writeFileSync(path, JSON.stringify(all, null, 2), 'utf8');
}

async function measure(browser: Browser, perfCase: PerfCase): Promise<PerfResult> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto(`/standalone.html?extracols=${EXTRA_COLS}&frozencols=2&frozenrows=0`);
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const heapMb = async (): Promise<number> => {
      await cdp.send('HeapProfiler.collectGarbage');
      const { metrics } = await cdp.send('Performance.getMetrics');
      const used = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value;
      if (used === undefined || !Number.isFinite(used) || used <= 0) {
        throw new Error('JSHeapUsedSize を取得できない');
      }
      return used / (1024 * 1024);
    };
    const heapBeforeMb = await heapMb();

    // ① 読み込み: 入力データはページの中で作る（CDP 越しに巨大な値を運ばない）。evaluate の終了で手放す。
    const load = await page.evaluate(
      async ({ rows, density, expectedColumns, deadlineMs }: { rows: number; density: number; expectedColumns: number; deadlineMs: number }) => {
        const api = (window as DebugWindow).__integrationTestApi;
        if (api === undefined) {
          throw new Error('__integrationTestApi が未初期化');
        }
        const columnIds: string[] = [];
        for (let i = 0; ; i += 1) {
          const id = api.colIdAt(i);
          if (id === undefined) {
            break;
          }
          columnIds.push(id);
        }
        if (columnIds.length !== expectedColumns) {
          throw new Error(`列数が ${columnIds.length}（期待 ${expectedColumns}）`);
        }
        const threshold = Math.round(density * 100);
        let nonEmptyCells = 0;
        const data = {
          rows: Array.from({ length: rows }, (_v, r) => {
            const cells: Record<string, string> = {};
            for (let c = 0; c < columnIds.length; c += 1) {
              if ((r * 131 + c * 17) % 100 >= threshold) {
                continue;
              }
              // 文字の列（品名・供給元など）と数値の列（wt%・ppb・単価など）を混ぜる。
              cells[columnIds[c]!] = c % 3 === 0 ? `品名${r}-${c}` : String(((r * 31 + c * 7) % 9000) / 100);
              nonEmptyCells += 1;
            }
            return { rowId: `r${r}`, cells };
          }),
        };
        const t0 = performance.now();
        window.__standalone!.reinject(data);
        const loadMs = await new Promise<number>((resolve, reject) => {
          const tick = (): void => {
            if (api.rowCount() === rows) {
              requestAnimationFrame(() => resolve(performance.now() - t0));
              return;
            }
            if (performance.now() - t0 > deadlineMs) {
              reject(new Error(`${deadlineMs}ms 待っても行数が ${api.rowCount()}（期待 ${rows}）`));
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        return { columns: columnIds.length, nonEmptyCells, loadMs };
      },
      { rows: perfCase.rows, density: perfCase.density, expectedColumns: EXTRA_COLS + 4, deadlineMs: LOAD_DEADLINE_MS },
    );
    const heapAfterMb = await heapMb();

    // ②③ スクロールと入力確定。
    const timing = await page.evaluate(async ({ scrollMs }: { scrollMs: number }) => {
      const scroller = document.querySelector('.nsheet-scroller');
      if (!(scroller instanceof HTMLElement)) {
        throw new Error('.nsheet-scroller が無い');
      }
      // 先頭 2 フレームを捨ててから scrollMs の間を測る。動かせない・動かなかった・標本が少ない軸は計測不能にする。
      const run = (axis: 'top' | 'left', stepPx: number): Promise<number[]> =>
        new Promise((resolve, reject) => {
          const max = axis === 'top' ? scroller.scrollHeight - scroller.clientHeight : scroller.scrollWidth - scroller.clientWidth;
          if (!(max > 0)) {
            reject(new Error(`${axis} にスクロールできない（可動範囲 ${max}）`));
            return;
          }
          const intervals: number[] = [];
          const positions = new Set<number>();
          let frame = 0;
          let last = 0;
          let start = 0;
          let dir = 1;
          const step = (now: number): void => {
            frame += 1;
            if (frame === 3) {
              start = now;
            } else if (frame > 3) {
              intervals.push(now - last);
            }
            last = now;
            const current = axis === 'top' ? scroller.scrollTop : scroller.scrollLeft;
            positions.add(current);
            let next = current + stepPx * dir;
            if (next >= max) {
              next = max;
              dir = -1;
            } else if (next <= 0) {
              next = 0;
              dir = 1;
            }
            if (axis === 'top') {
              scroller.scrollTop = next;
            } else {
              scroller.scrollLeft = next;
            }
            if (frame > 3 && now - start >= scrollMs) {
              if (intervals.length < 10 || positions.size < 3) {
                reject(new Error(`${axis} の標本が足りない（間隔 ${intervals.length}・位置 ${positions.size}）`));
                return;
              }
              resolve(intervals);
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
      const stats = (intervals: number[]): [number, number, number] => {
        const sorted = [...intervals].sort((x, y) => x - y);
        const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
        return [at(0.5), at(0.95), sorted[sorted.length - 1]!];
      };
      const vertical = stats(await run('top', 400));
      scroller.scrollTop = 0;
      const horizontal = stats(await run('left', 80));
      scroller.scrollLeft = 0;

      // 入力確定: 変換の確定（compositionend）の直後は確定の Enter が keyup まで抑止されるので、Enter の keyup を先に送る
      // （standalone-helpers の composeCommitAtCell と同じ）。計時するのは確定の Enter の keydown の同期処理。
      const ta = document.querySelector('textarea.int-cell-editor');
      if (!(ta instanceof HTMLTextAreaElement)) {
        throw new Error('int-cell-editor が無い');
      }
      const events = window.__standalone!.events;
      const before = events.length;
      ta.focus();
      ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      ta.value = '12.5';
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: '12.5', bubbles: true }));
      ta.dispatchEvent(new CompositionEvent('compositionend', { data: '12.5', bubbles: true }));
      ta.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: '12.5', isComposing: false, bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', isComposing: false, bubbles: true }));
      const c0 = performance.now();
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const commitMs = performance.now() - c0;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const commits = events
        .slice(before)
        .filter((e) => e.type === 'cell-commit' && (e.changes ?? []).some((c) => c.value === '12.5'));
      if (commits.length !== 1) {
        throw new Error(`入力確定の cell-commit が ${commits.length} 件（期待 1 件）`);
      }
      return { vertical, horizontal, commitMs };
    }, { scrollMs: SCROLL_MS });

    return {
      name: perfCase.name,
      columns: load.columns,
      rows: perfCase.rows,
      nonEmptyCells: load.nonEmptyCells,
      loadMs: load.loadMs,
      verticalP50Ms: timing.vertical[0],
      verticalP95Ms: timing.vertical[1],
      verticalWorstMs: timing.vertical[2],
      horizontalP50Ms: timing.horizontal[0],
      horizontalP95Ms: timing.horizontal[1],
      horizontalWorstMs: timing.horizontal[2],
      commitMs: timing.commitMs,
      heapBeforeMb,
      heapAfterMb,
    };
  } finally {
    await context.close();
  }
}

test.describe('DD-070-1: 180 列 × 想定行数', () => {
  test.describe.configure({ timeout: 600_000 });
  // 証跡は実行ごとに空から作る（前の実行の値が残って今回の結果と混ざらないようにする）。失敗で worker が作り直されても
  // 同じ実行の結果を消さないよう、実行の印（runner のプロセス ID）が違うときだけ消す。
  test.beforeAll(() => {
    try {
      const saved = JSON.parse(readFileSync(evidenceJsonPath(), 'utf8')) as { runId?: string };
      if (saved.runId === RUN_ID) {
        return;
      }
    } catch {
      // 無い・壊れている → 消して作り直す
    }
    rmSync(evidenceJsonPath(), { force: true });
  });

  for (const perfCase of CASES) {
    test(`${perfCase.name}（${perfCase.rows} 行・埋まり ${perfCase.density * 100}%）`, async ({ browser }) => {
      let result: PerfResult;
      try {
        result = await measure(browser, perfCase);
      } catch (error) {
        // 目標の外のケースは、落ちたこと自体を記録して終える（タブのメモリ不足などを結果として残す）。
        saveResult({ name: perfCase.name, error: String(error) });
        if (perfCase.judged) {
          throw error;
        }
        console.log(`[DD-070-1] ${perfCase.name} 計測できず: ${String(error)}`);
        return;
      }
      saveResult(result);
      console.log('[DD-070-1] rm-database-perf', JSON.stringify(result));
      if (!perfCase.judged) {
        return;
      }
      expect(result.verticalP95Ms).toBeLessThan(P95_BUDGET_MS);
      expect(result.horizontalP95Ms).toBeLessThan(P95_BUDGET_MS);
      if (COMMIT_KNOWN_SLOW) {
        test.info().annotations.push({ type: 'known-slow', description: `入力確定 ${result.commitMs.toFixed(1)}ms（目標 ${COMMIT_BUDGET_MS}ms）` });
      } else {
        expect(result.commitMs).toBeLessThan(COMMIT_BUDGET_MS);
      }
      expect(result.heapAfterMb).toBeLessThan(HEAP_BUDGET_MB);
    });
  }
});
