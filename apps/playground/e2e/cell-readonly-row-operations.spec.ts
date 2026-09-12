// DD-052-3 E2E（RC3: セル単位読み取り専用・RC14: 行操作の無効化）。
// RC3: GridStandaloneRow.readOnlyColumns で指定した行×列の組み合わせだけ編集を抑止し、他のセルは従来どおり
// 編集できることを確認する（裁定/フィルタの細目はユニット＝readonly-columns.test.ts・standalone-session.test.ts が担保）。
// RC14: rowOperations:false で Ctrl+Shift+'+'／Ctrl+'-' が行を増減しなくなり、他の編集は従来どおりできることを確認する。

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import * as sa from './standalone-helpers';

test.describe.configure({ mode: 'serial' });

async function openStandaloneWithQuery(browser: Browser, query: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/standalone.html${query}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
  return { context, page };
}

async function textareaReadOnly(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ta = document.querySelector('textarea.int-cell-editor');
    return ta instanceof HTMLTextAreaElement ? ta.readOnly : false;
  });
}

test('RC3: 行データの readOnlyColumns で指定したセルだけ編集できない。他のセル・setData での解除は従来どおり', async ({
  browser,
}) => {
  const { context, page } = await openStandaloneWithQuery(browser, '');
  try {
    await page.evaluate(() => {
      window.__standalone?.reinject({
        rows: [
          { rowId: 'rc3-r1', cells: { 'col-a': 'A1', 'col-b': 'B1' }, readOnlyColumns: ['col-a'] },
          { rowId: 'rc3-r2', cells: { 'col-a': 'A2', 'col-b': 'B2' } },
        ],
      });
    });
    await expect.poll(async () => sa.displayCell(page, 'rc3-r1', 'col-a')).toBe('A1');
    const r1 = 0; // reinject 直後は rc3-r1 が先頭行（index 0）

    // rc3-r1 の col-a（readOnly指定）→ textarea が readOnly になり編集できない。
    await sa.selectCell(page, r1, 0);
    await expect.poll(async () => textareaReadOnly(page), { message: 'RC3 対象セルで textarea.readOnly' }).toBe(true);
    await page.keyboard.type('zz');
    await page.keyboard.press('Enter');
    await expect.poll(async () => sa.displayCell(page, 'rc3-r1', 'col-a')).toBe('A1'); // 変わらない

    // 同じ行の col-b（対象外）は編集できる。
    await sa.selectCell(page, r1, 1);
    await expect.poll(async () => textareaReadOnly(page)).toBe(false);
    await page.keyboard.type('edited');
    await page.keyboard.press('Enter');
    await expect.poll(async () => sa.displayCell(page, 'rc3-r1', 'col-b')).toBe('edited');

    // 別の行（rc3-r2）の col-a は対象外なので編集できる（行×列の組み合わせで判定されている証跡）。
    await sa.selectCell(page, 1, 0);
    await expect.poll(async () => textareaReadOnly(page)).toBe(false);
    await page.keyboard.type('edited2');
    await page.keyboard.press('Enter');
    await expect.poll(async () => sa.displayCell(page, 'rc3-r2', 'col-a')).toBe('edited2');

    // setData で readOnlyColumns を外して再注入 → 同じセルが編集できるようになる（remount 不要）。
    await page.evaluate(() => {
      window.__standalone?.reinject({ rows: [{ rowId: 'rc3-r1', cells: { 'col-a': 'A1' } }] });
    });
    await sa.selectCell(page, 0, 0);
    await expect.poll(async () => textareaReadOnly(page), { message: 'setData 後は readOnly が解除される' }).toBe(false);
  } finally {
    await context.close();
  }
});

test('RC14: rowOperations:false で行の追加・削除ショートカットが効かない。他の編集・列操作は従来どおり', async ({
  browser,
}) => {
  const { context, page } = await openStandaloneWithQuery(browser, '?rowops=0');
  try {
    const before = await sa.rowCount(page);
    await sa.selectCell(page, 2, 0);
    await page.keyboard.press('Control+Shift+Equal'); // Ctrl+Shift+'+' = 挿入（無効化されているので何も起きない）
    await page.waitForTimeout(150);
    expect(await sa.rowCount(page)).toBe(before);

    await page.keyboard.press('Control+Minus'); // Ctrl+'-' = 削除（無効化されているので何も起きない）
    await page.waitForTimeout(150);
    expect(await sa.rowCount(page)).toBe(before);

    // 通常の編集は従来どおりできる（rowOperations は行操作ショートカットだけを無効化する）。
    await page.keyboard.type('still-editable');
    await page.keyboard.press('Enter');
    const rowId = await sa.rowIdAt(page, 2);
    const colId = await sa.colIdAt(page, 0);
    await expect.poll(async () => sa.displayCell(page, rowId!, colId!)).toBe('still-editable');

    // 公開 API insertRows/deleteRows は対象外（consumer の明示呼び出しは妨げない）。
    await page.evaluate(() => window.__gridInstance?.insertRows({ afterRowId: null, count: 1 }));
    await expect.poll(async () => sa.rowCount(page)).toBe(before + 1);
  } finally {
    await context.close();
  }
});

test('RC14: rowOperations 未指定（既定）は従来どおり行の追加・削除ショートカットが効く', async ({ browser }) => {
  const { context, page } = await sa.openStandalone(browser);
  try {
    const before = await sa.rowCount(page);
    await sa.selectCell(page, 2, 0);
    await page.keyboard.press('Control+Shift+Equal');
    await expect.poll(async () => sa.rowCount(page)).toBe(before + 1);
  } finally {
    await context.close();
  }
});
