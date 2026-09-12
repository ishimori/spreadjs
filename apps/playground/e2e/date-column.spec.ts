// DD-035 R2 E2E: 日付列（カレンダー・ポップオーバー）。
//
// 単独モード（standalone.html?date=col-b,col-c!icon&readonlycols=col-d ...）で、日付列のカレンダーが dblclick/F2/Alt+↓/📅 で
// 開き、日クリック/Enter で `YYYY-MM-DD` が既存 chokepoint 経由で確定（cell-commit・Undo）されること、Esc/外クリックは文書無変更で
// focus が textarea のままであること、印字文字は従来どおり手入力（正準化）であること、openOn='icon' 列は dblclick/F2 で textarea
// 編集になることを検証する（AC1/AC2）。カレンダー状態は debug API（dateOpen/dateHighlightedValue/dateViewMonth）と DOM
// （.ns-date-popover/.ns-date-day）で観測する。純関数の細目はユニット（date-editor.test.ts）が担保する。

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  emulateScrollbars,
  evidencePathDD055,
  expectOverlayInsideVisible,
  highlightCell,
  highlightSelector,
  lastFullyVisibleRow,
  overlayGeometry,
  saveEvidenceJsonDD055,
  scrollTo,
} from './integration-helpers';
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

// ---- DD-055（ReadyCrew RC16）: カレンダーを可視域の中に開く ---------------------------------------------
// 証跡（スクショ・数値 JSON）は失敗しうる検証より前に保存する（修正前の状態を同じ手順で残すため）。

/** カレンダーの下端とセルの上端のずれ（px・整数に丸める）。どちらかが見えなければ null。 */
async function popoverBottomToCellTop(page: Page, row: number, col: number): Promise<number | null> {
  const cell = await sa.cellRectAt(page, row, col);
  const { rect } = await overlayGeometry(page, '.ns-date-popover');
  return cell === null || rect === null ? null : Math.round(rect.y + rect.height - cell.y);
}

test('DD-055 AC2: 可視域の下端近くの日付セル → 4 通りの開き方すべてでカレンダーがセルの上に開き可視域に収まり、開いたままスクロールしても上向きのまま追従する', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    // 列・行を増やして縦横にスクロールさせ、スクロールバー相当の 16px を空ける（可視域の下端＝横スクロールバーの手前。
    // ReadyCrew の画面と同じ条件。headless はスクロールバーを隠すため模擬する）。
    await page.goto('/standalone.html?date=col-b&extracols=12&seedrows=80');
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);
    await emulateScrollbars(page);
    const col = 1;
    const row = await lastFullyVisibleRow(page, col);
    const cell = (await sa.cellRectAt(page, row, col))!;
    const area = await overlayGeometry(page, '.ns-date-popover');
    expect(area.visibleHeight, '前提: 横スクロールバーの分だけ可視域が stage より低い').toBeLessThan(area.stageHeight);
    const openers: ReadonlyArray<readonly [string, () => Promise<void>]> = [
      [
        'F2',
        async () => {
          await sa.selectCell(page, row, col);
          await page.keyboard.press('F2');
        },
      ],
      [
        'Alt+ArrowDown',
        async () => {
          await sa.selectCell(page, row, col);
          await page.keyboard.press('Alt+ArrowDown');
        },
      ],
      [
        'dblclick',
        async () => {
          await page.locator('.nsheet-scroller').dblclick({ position: await cellCenter(page, row, col) });
        },
      ],
      [
        '📅',
        async () => {
          await sa.selectCell(page, row, col);
          await page.locator('.ns-date-indicator').click();
        },
      ],
    ];
    for (const [label, open] of openers) {
      await open();
      await expect.poll(async () => dateOpen(page), { message: `${label} で開く` }).toBe(true);
      const geometry = await overlayGeometry(page, '.ns-date-popover');
      if (label === 'F2') {
        await highlightCell(page, row, col);
        await highlightSelector(page, '.ns-date-popover');
        await page.screenshot({ path: evidencePathDD055('bug1-date-bottom.png') });
        saveEvidenceJsonDD055('bug1-date-bottom.json', { row, col, cell, popover: geometry });
      }
      expectOverlayInsideVisible(geometry, label);
      expect(
        Math.abs(geometry.rect!.y + geometry.rect!.height - cell.y),
        `${label}: カレンダーの下端がセルの上端に揃う（セルの上に開く）`,
      ).toBeLessThanOrEqual(1);
      await page.keyboard.press('Escape');
      await expect.poll(async () => dateOpen(page)).toBe(false);
    }

    // 開いたままスクロール → 向きは変わらず、下端がセルの上端に揃ったまま追従する（AC5 の日付側）。
    await sa.selectCell(page, row, col);
    await page.keyboard.press('F2');
    await expect.poll(async () => dateOpen(page)).toBe(true);
    await scrollTo(page, 5 * 22, 0);
    await expect
      .poll(async () => popoverBottomToCellTop(page, row, col), { message: '5 行スクロール: 上向きのまま追従' })
      .toBe(0);
    expectOverlayInsideVisible(await overlayGeometry(page, '.ns-date-popover'), '5 行スクロール');
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});

test('DD-055 AC3: 上下どちらの余白もカレンダーより狭い → 広い側に開いて余白に収まる高さで内部スクロールし、キーで動かしたハイライトの日が見える', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 420 } });
  const page = await context.newPage();
  try {
    await page.goto('/standalone.html?date=col-b&seedrows=60');
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);
    await emulateScrollbars(page);
    const col = 1;
    const area = await overlayGeometry(page, '.ns-date-popover');
    // 可視域の中央付近の行（列見出し 24px・行 22px）に、6 週表示の月（2026 年 8 月）の 2 週目の日付を入れる。
    const row = Math.round((area.visibleHeight / 2 - 24 - 11) / 22);
    await page.evaluate((target: number) => {
      const rows = Array.from({ length: 60 }, (_, i) => ({
        rowId: `r${i}`,
        cells: { 'col-a': `行${i}`, 'col-b': i === target ? '2026-08-02' : '' },
      }));
      window.__standalone?.reinject({ rows });
    }, row);
    await expect.poll(async () => sa.displayCell(page, `r${row}`, 'col-b')).toBe('2026-08-02');
    const cell = (await sa.cellRectAt(page, row, col))!;
    const spaceAbove = cell.y;
    const spaceBelow = area.visibleHeight - (cell.y + cell.height);

    await sa.selectCell(page, row, col);
    await page.keyboard.press('F2');
    await expect.poll(async () => dateOpen(page)).toBe(true);
    const geometry = await overlayGeometry(page, '.ns-date-popover');
    expectOverlayInsideVisible(geometry, '上下とも狭い');
    expect(geometry.scrollable, '前提: 上下どちらの余白もカレンダーより狭く、はみ出す分は内部スクロール').toBe(true);
    if (spaceAbove > spaceBelow) {
      expect(Math.abs(geometry.rect!.y + geometry.rect!.height - cell.y), '上の余白が広い → セルの上に開く').toBeLessThanOrEqual(1);
    } else {
      expect(Math.abs(geometry.rect!.y - (cell.y + cell.height)), '下の余白が広い（同じ）→ セルの下に開く').toBeLessThanOrEqual(1);
    }

    // ↓ で 4 週送る（8/2 → 8/30＝6 週目の行。表示月は 8 月のまま）→ ハイライトの日がカレンダーの表示範囲に入る。
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('ArrowDown');
    }
    await expect.poll(async () => dateHighlighted(page)).toBe('2026-08-30');
    const popover = (await overlayGeometry(page, '.ns-date-popover')).rect!;
    const day = (await overlayGeometry(page, '.ns-date-day[data-date="2026-08-30"]')).rect!;
    expect(day.y, 'ハイライトの日の上端がカレンダーの中').toBeGreaterThanOrEqual(popover.y - 1);
    expect(day.y + day.height, 'ハイライトの日の下端がカレンダーの中').toBeLessThanOrEqual(popover.y + popover.height + 1);
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});

test('DD-055 AC4: 可視域の右端近くの日付列でカレンダーを開く → 右端を越えず左へずれる', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto('/standalone.html?date=col-x9&extracols=12&seedrows=80');
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);
    await emulateScrollbars(page);
    const row = 2;
    const col = 13; // col-a〜col-d の後ろの 10 列目＝col-x9
    expect(await sa.colIdAt(page, col)).toBe('col-x9');
    const cell = (await sa.cellRectAt(page, row, col))!;
    const area = await overlayGeometry(page, '.ns-date-popover');
    expect(cell.x + cell.width, '前提: 列全体が可視域に入っている').toBeLessThanOrEqual(area.visibleWidth);
    expect(cell.x + 224, '前提: セルの左端から置くと右端を越える（カレンダーの幅 224px）').toBeGreaterThan(area.visibleWidth);

    await sa.selectCell(page, row, col);
    await page.keyboard.press('F2');
    await expect.poll(async () => dateOpen(page)).toBe(true);
    const geometry = await overlayGeometry(page, '.ns-date-popover');
    await highlightSelector(page, '.ns-date-popover');
    await page.screenshot({ path: evidencePathDD055('bug1-date-right.png') });
    saveEvidenceJsonDD055('bug1-date-right.json', { row, col, cell, popover: geometry });
    expectOverlayInsideVisible(geometry, '右端の日付列');
    expect(
      Math.abs(geometry.rect!.x + geometry.rect!.width - area.visibleWidth),
      '右端を可視域の右端に揃えて左へずらす',
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.rect!.y - (cell.y + cell.height)), '縦は従来どおりセルの下に開く').toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});
