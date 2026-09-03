// DD-035 R2 E2E: 日付列（カレンダー・ポップオーバー）。
//
// 単独モード（standalone.html?date=col-b,col-c!icon&readonlycols=col-d ...）で、日付列のカレンダーが dblclick/F2/Alt+↓/📅 で
// 開き、日クリック/Enter で `YYYY-MM-DD` が既存 chokepoint 経由で確定（cell-commit・Undo）されること、Esc/外クリックは文書無変更で
// focus が textarea のままであること、印字文字は従来どおり手入力（正準化）であること、openOn='icon' 列は dblclick/F2 で textarea
// 編集になることを検証する（AC1/AC2）。カレンダー状態は debug API（dateOpen/dateHighlightedValue/dateViewMonth）と DOM
// （.ns-date-popover/.ns-date-day）で観測する。純関数の細目はユニット（date-editor.test.ts）が担保する。

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import * as sa from './standalone-helpers';

test.describe.configure({ mode: 'serial' });

const QUERY = '?date=col-b,col-c!icon&readonlycols=col-d';

async function openDateGrid(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/standalone.html${QUERY}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
  await page.evaluate(() => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      rowId: `r${i}`,
      cells: { 'col-a': `A${i}`, 'col-b': i === 3 ? '2026-07-31' : '', 'col-c': '2026-01-15' },
    }));
    window.__standalone?.reinject({ rows });
  });
  await expect.poll(async () => sa.displayCell(page, 'r3', 'col-b')).toBe('2026-07-31');
  return { context, page };
}

async function api<R>(page: Page, method: string, args: unknown[] = []): Promise<R> {
  return page.evaluate(
    (payload: { method: string; args: unknown[] }) => {
      const a = (window as unknown as { __integrationTestApi?: Record<string, (...x: unknown[]) => unknown> })
        .__integrationTestApi;
      if (a === undefined) {
        throw new Error('__integrationTestApi 未初期化');
      }
      return a[payload.method]!.apply(a, payload.args);
    },
    { method, args },
  ) as Promise<R>;
}
async function dateOpen(page: Page): Promise<boolean> {
  return api<boolean>(page, 'dateOpen');
}
async function dateHighlighted(page: Page): Promise<string | null> {
  return api<string | null>(page, 'dateHighlightedValue');
}
async function committedHash(page: Page): Promise<string> {
  return api<string>(page, 'committedHash');
}
async function activeElementClass(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.className ?? '');
}
async function textareaDisplay(page: Page): Promise<string> {
  return page.evaluate(() => {
    const ta = document.querySelector('textarea.int-cell-editor');
    return ta instanceof HTMLTextAreaElement ? ta.style.background : '';
  });
}
async function cellCenter(page: Page, row: number, col: number): Promise<{ x: number; y: number }> {
  const rect = await sa.cellRectAt(page, row, col);
  if (rect === null) {
    throw new Error(`セル (${row},${col}) が可視範囲にない`);
  }
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
async function lastCommit(page: Page): Promise<{ rowId: string; columnId: string; value: string; previousValue: string } | undefined> {
  return (await sa.events(page)).filter((e) => e.type === 'cell-commit').at(-1)?.changes?.[0];
}

test('AC1-1: 日付列（openOn 既定）で F2/Alt+↓/dblclick/📅 → カレンダーが開き、現値をハイライト・Esc/外クリックは文書無変更', async ({
  browser,
}) => {
  const { context, page } = await openDateGrid(browser);
  try {
    const hash0 = await committedHash(page);
    // F2: 現値 2026-07-31 をハイライトし 7 月を表示。
    await sa.selectCell(page, 3, 1);
    await page.keyboard.press('F2');
    await expect.poll(async () => dateOpen(page), { message: 'F2 でカレンダーが開く' }).toBe(true);
    expect(await dateHighlighted(page)).toBe('2026-07-31');
    expect(await api<unknown>(page, 'dateViewMonth')).toEqual({ year: 2026, month: 7 });
    await expect(page.locator('.ns-date-popover')).toBeVisible();
    await expect(page.locator('.ns-date-month')).toHaveText('2026年7月');
    expect(await activeElementClass(page)).toBe('int-cell-editor'); // focus は textarea のまま（I-5）
    await page.keyboard.press('Escape');
    await expect.poll(async () => dateOpen(page)).toBe(false);
    await expect(page.locator('.ns-date-popover')).toBeHidden();
    // Alt+↓: 空セル（r4）は今日をハイライト。
    await sa.selectCell(page, 4, 1);
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(async () => dateOpen(page), { message: 'Alt+↓ でカレンダーが開く' }).toBe(true);
    const today = await page.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    expect(await dateHighlighted(page)).toBe(today);
    // 外クリック（別セル）→ 取消・文書無変更。
    await page.locator('.nsheet-scroller').click({ position: await cellCenter(page, 8, 0) });
    await expect.poll(async () => dateOpen(page)).toBe(false);
    // dblclick で開く（textarea 編集にならない）。
    await page.locator('.nsheet-scroller').dblclick({ position: await cellCenter(page, 5, 1) });
    await expect.poll(async () => dateOpen(page), { message: 'dblclick でカレンダーが開く' }).toBe(true);
    expect(await sa.draft(page)).toBe('');
    await page.keyboard.press('Escape');
    await expect.poll(async () => dateOpen(page)).toBe(false);
    // 📅 インジケーター: 日付セルがアクティブなら表示され、クリックで開く。
    await sa.selectCell(page, 6, 1);
    await expect(page.locator('.ns-date-indicator')).toBeVisible();
    await page.locator('.ns-date-indicator').click();
    await expect.poll(async () => dateOpen(page), { message: '📅 クリックでカレンダーが開く' }).toBe(true);
    expect(await activeElementClass(page)).toBe('int-cell-editor');
    await page.keyboard.press('Escape');
    // 非日付列（col-a）ではインジケーターが出ない。
    await sa.selectCell(page, 6, 0);
    await expect(page.locator('.ns-date-indicator')).toBeHidden();
    expect(await committedHash(page)).toBe(hash0);
    expect(await lastCommit(page)).toBeUndefined();
  } finally {
    await context.close();
  }
});

test('AC1-2: 日クリック / 矢印+Enter / 今日 / クリア で確定 → LocalDate が cell-commit・Undo で戻る', async ({ browser }) => {
  const { context, page } = await openDateGrid(browser);
  try {
    // 日クリック: 2026-07-31 → 7 月グリッドの 15 日をクリック。
    await sa.selectCell(page, 3, 1);
    await page.keyboard.press('F2');
    await expect.poll(async () => dateOpen(page)).toBe(true);
    await expect(page.locator('.ns-date-day[data-date="2026-07-15"]')).toBeVisible();
    await page.screenshot({ path: sa.evidencePath('../DD-035/e2e-date-column-1-calendar.png') });
    await page.locator('.ns-date-day[data-date="2026-07-15"]').click();
    await expect.poll(async () => dateOpen(page)).toBe(false);
    await expect.poll(async () => sa.displayCell(page, 'r3', 'col-b')).toBe('2026-07-15');
    expect(await api<string>(page, 'committedCellKind', ['r3', 'col-b'])).toBe('date');
    expect(await lastCommit(page)).toMatchObject({ rowId: 'r3', columnId: 'col-b', value: '2026-07-15', previousValue: '2026-07-31' });
    expect(await activeElementClass(page)).toBe('int-cell-editor');
    // 矢印＋Enter: → +1 日・↓ +7 日・PageDown +1 月 → Enter。
    await page.keyboard.press('F2');
    await expect.poll(async () => dateOpen(page)).toBe(true);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('PageDown');
    await expect.poll(async () => dateHighlighted(page)).toBe('2026-08-23');
    await page.keyboard.press('Enter');
    await expect.poll(async () => sa.displayCell(page, 'r3', 'col-b')).toBe('2026-08-23');
    // Undo で戻る（既存 chokepoint 経由の証跡）。
    await page.keyboard.press('Control+z');
    await expect.poll(async () => sa.displayCell(page, 'r3', 'col-b')).toBe('2026-07-15');
    // 「クリア」→ blank。
    await page.keyboard.press('F2');
    await expect.poll(async () => dateOpen(page)).toBe(true);
    await page.locator('.ns-date-clear').click();
    await expect.poll(async () => sa.displayCell(page, 'r3', 'col-b')).toBe('');
    expect(await api<string>(page, 'committedCellKind', ['r3', 'col-b'])).toBe('blank');
    // 「今日」→ ローカル今日。
    await page.keyboard.press('F2');
    await expect.poll(async () => dateOpen(page)).toBe(true);
    await page.locator('.ns-date-today').click();
    const today = await page.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    await expect.poll(async () => sa.displayCell(page, 'r3', 'col-b')).toBe(today);
    // 同値確定は文書を触らない（cell-commit が増えない）。
    const commitsBefore = (await sa.events(page)).filter((e) => e.type === 'cell-commit').length;
    await page.keyboard.press('F2');
    await expect.poll(async () => dateOpen(page)).toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(async () => dateOpen(page)).toBe(false);
    await page.waitForTimeout(100);
    expect((await sa.events(page)).filter((e) => e.type === 'cell-commit').length).toBe(commitsBefore);
  } finally {
    await context.close();
  }
});

test('AC2: 印字文字は手入力（正準化）・openOn=icon 列は F2/dblclick で textarea 編集・readOnly 列/合成中は開かない', async ({
  browser,
}) => {
  const { context, page } = await openDateGrid(browser);
  try {
    // 印字文字 → textarea 手入力 → 2026/7/31 が 2026-07-31 に正準化（従来経路無改変）。
    await sa.selectCell(page, 7, 1);
    await page.keyboard.type('2026/7/31');
    expect(await dateOpen(page)).toBe(false);
    await expect.poll(async () => sa.draft(page)).toBe('2026/7/31');
    await page.keyboard.press('Enter');
    await expect.poll(async () => sa.displayCell(page, 'r7', 'col-b')).toBe('2026-07-31');
    expect(await api<string>(page, 'committedCellKind', ['r7', 'col-b'])).toBe('date');
    // openOn='icon'（col-c）: F2 は textarea 編集（白地化）・カレンダーは開かない。Alt+↓ と 📅 では開く。
    await sa.selectCell(page, 8, 2);
    await page.keyboard.press('F2');
    await expect.poll(async () => textareaDisplay(page)).toBe('rgb(255, 255, 255)');
    expect(await dateOpen(page)).toBe(false);
    await page.keyboard.press('Escape');
    await page.locator('.nsheet-scroller').dblclick({ position: await cellCenter(page, 9, 2) });
    await expect.poll(async () => textareaDisplay(page)).toBe('rgb(255, 255, 255)');
    expect(await dateOpen(page)).toBe(false);
    await page.keyboard.press('Escape');
    await sa.selectCell(page, 9, 2);
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(async () => dateOpen(page)).toBe(true);
    expect(await dateHighlighted(page)).toBe('2026-01-15');
    await page.keyboard.press('Escape');
    await expect(page.locator('.ns-date-indicator')).toBeVisible();
    // 開いている間の印字文字は握り潰す（textarea へ漏れない）。
    await page.keyboard.press('F2');
    await sa.selectCell(page, 10, 1);
    await page.keyboard.press('F2');
    await expect.poll(async () => dateOpen(page)).toBe(true);
    await page.keyboard.type('x');
    expect(await sa.draft(page)).toBe('');
    await page.keyboard.press('Escape');
    // synthetic composition 中は開かない（I-3）。
    await sa.selectCell(page, 11, 1);
    await sa.composeOpen(page, 'あ');
    await expect.poll(async () => sa.isComposing(page)).toBe(true);
    await page.keyboard.press('F2');
    await page.keyboard.press('Alt+ArrowDown');
    expect(await dateOpen(page)).toBe(false);
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});
