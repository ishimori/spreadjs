// DD-052-2 E2E（RC12: 文字列として保つ列）: stringColumns 指定列は先頭ゼロ付き数字がそのまま保持され、
// 未指定列は従来どおり型変換されることを実ブラウザーで確認する。

import { expect, test } from '@playwright/test';

import { colIdAt, committedCell, committedCellKind, openClient, plainTypeAndCommit, rowIdAt, selectCell } from './integration-helpers';
import * as sa from './standalone-helpers';

async function api<R>(page: import('@playwright/test').Page, method: string, args: unknown[] = []): Promise<R> {
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

test('stringColumns 指定列は先頭ゼロが失われず、未指定列は従来どおり数値化される（RC12）', async ({ browser }) => {
  const { context, page } = await openClient(browser, 'RC12文字列列', { stringCol: 'col-0' });
  try {
    const row = 6;
    const stringCol = 0; // col-0（stringColumns 指定）
    const plainCol = 1; // col-1（対象外・従来どおり）
    const stringColumnId = (await colIdAt(page, stringCol))!;
    const plainColumnId = (await colIdAt(page, plainCol))!;
    const rowId = (await rowIdAt(page, row))!;

    await selectCell(page, row, stringCol);
    await plainTypeAndCommit(page, '09012345678');
    await expect
      .poll(async () => committedCell(page, rowId, stringColumnId), { message: 'stringColumns 列は先頭ゼロを保つ' })
      .toBe('09012345678');

    await selectCell(page, row, plainCol);
    await plainTypeAndCommit(page, '09012345678');
    await expect
      .poll(async () => committedCell(page, rowId, plainColumnId), { message: '対象外の列は従来どおり数値化される' })
      .toBe('9012345678');
  } finally {
    await context.close();
  }
});

test('Codex[P2]回帰: stringColumns 指定の選択式列は候補確定でも型変換されない（confirmSelect）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    // 候補自体を数字文字列にする（'001' 等は選択式では前方一致の都合上使いにくいため '123' で代表させる）。
    // stringColumns 指定なしなら number 化される値を候補にし、指定ありだと string のまま保たれることを見る。
    await page.goto('/standalone.html?select=col-b:123|456&stringCol=col-b');
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);

    const rowId = (await sa.rowIdAt(page, 0))!;
    const columnId = (await sa.colIdAt(page, 1))!; // col-b
    await sa.selectCell(page, 0, 1);
    await page.keyboard.press('F2');
    await expect.poll(async () => api<boolean>(page, 'selectOpen')).toBe(true);
    await page.locator('.ns-select-option', { hasText: '123' }).click(); // 候補 '123' を明示的にクリック確定
    await expect.poll(async () => api<boolean>(page, 'selectOpen')).toBe(false);

    await expect.poll(async () => sa.displayCell(page, rowId, columnId)).toBe('123');
    expect(await committedCellKind(page, rowId, columnId)).toBe('string'); // number にならない（Codex[P2] 修正前は 'number'）
  } finally {
    await context.close();
  }
});

test('Codex[P2]回帰: stringColumns 指定の日付列は日クリック確定でも型変換されない（confirmDate）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto('/standalone.html?date=col-b&stringCol=col-b');
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);
    await page.evaluate(() => {
      window.__standalone?.reinject({ rows: [{ rowId: 'r0', cells: { 'col-a': 'A0', 'col-b': '2026-07-31' } }] });
    });
    await expect.poll(async () => sa.displayCell(page, 'r0', 'col-b')).toBe('2026-07-31');

    await sa.selectCell(page, 0, 1);
    await page.keyboard.press('F2');
    await expect.poll(async () => api<boolean>(page, 'dateOpen')).toBe(true);
    await expect(page.locator('.ns-date-day[data-date="2026-07-15"]')).toBeVisible();
    await page.locator('.ns-date-day[data-date="2026-07-15"]').click();
    await expect.poll(async () => api<boolean>(page, 'dateOpen')).toBe(false);

    await expect.poll(async () => sa.displayCell(page, 'r0', 'col-b')).toBe('2026-07-15');
    expect(await committedCellKind(page, 'r0', 'col-b')).toBe('string'); // date にならない（Codex[P2] 修正前は 'date'）
  } finally {
    await context.close();
  }
});
