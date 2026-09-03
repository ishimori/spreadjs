// DD-035 R7/R6 E2E: React Facade の ref handle 命令 API（insertRows / deleteRows / scrollToRow / setActiveCell）。
//
// 対象は react-standalone.html（<NanairoSheetView mode="standalone"> を StrictMode 下で mount）。GridInstance は Facade が
// 隠蔽するため **公開契約のみ**で検証する: 行操作は row-structure-change イベント、activeCell 移動＋focus は
// 「そのまま印字して確定 → onCellCommit の rowId/columnId」で間接検証、scrollToRow は scroller DOM の scrollTop で観測する。

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { commitCount, evidencePath, lastCommit, openReactStandalone } from './react-facade-helpers';

interface RowStructureChange {
  kind: 'insert' | 'delete';
  rowIds: string[];
  afterRowId?: string | null;
}

async function lastRowStructureChange(page: Page): Promise<RowStructureChange | null> {
  return page.evaluate(
    () => (window.__reactStandalone?.lastRowStructureChange() ?? null) as RowStructureChange | null,
  );
}

async function scrollerScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('#react-root .nsheet-scroller')?.scrollTop ?? -1);
}

test('AC7-1: handle.insertRows → setActiveCell（新行）→ 印字確定が新行へ landed／deleteRows で row-structure-change(delete)', async ({
  browser,
}) => {
  const { context, page } = await openReactStandalone(browser);
  try {
    // 先頭へ 1 行挿入し、直後（同一 evaluate 内・Axis 再構築前）に新行の col-b をアクティブ化する。
    const newId = await page.evaluate(() => {
      const h = window.__reactStandalone!;
      h.insertRows({ afterRowId: null, count: 1 });
      const change = h.lastRowStructureChange() as { kind: string; rowIds: string[] } | null;
      const id = change?.rowIds[0] ?? '';
      h.setActiveCell(id, 'col-b');
      return id;
    });
    expect(newId).not.toBe('');
    const inserted = await lastRowStructureChange(page);
    expect(inserted).toMatchObject({ kind: 'insert', afterRowId: null, rowIds: [newId] });

    // setActiveCell は常駐 textarea へ focus する → そのまま印字して Enter で新行 col-b へ確定される。
    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.className ?? ''), { message: 'textarea へ focus' })
      .toBe('int-cell-editor');
    await page.keyboard.type('new');
    await page.keyboard.press('Enter');
    await expect.poll(async () => commitCount(page)).toBe(1);
    expect((await lastCommit(page))?.[0]).toMatchObject({ rowId: newId, columnId: 'col-b', value: 'new', previousValue: '' });

    // deleteRows → row-structure-change(delete)。
    await page.evaluate((id: string) => window.__reactStandalone?.deleteRows([id]), newId);
    await expect.poll(async () => lastRowStructureChange(page)).toMatchObject({ kind: 'delete', rowIds: [newId] });
    await page.screenshot({ path: evidencePath('../DD-035/e2e-react-handle-1-insert-active.png') });
  } finally {
    await context.close();
  }
});

test('AC7-2: handle.setData 再注入直後の handle.scrollToRow → 画面外の行が可視化される', async ({ browser }) => {
  const { context, page } = await openReactStandalone(browser);
  try {
    expect(await scrollerScrollTop(page)).toBe(0);
    await page.evaluate(() => {
      const h = window.__reactStandalone!;
      const rows = Array.from({ length: 200 }, (_, i) => ({ rowId: `r${i}`, cells: { 'col-a': `行${i}` } }));
      h.reinject({ rows });
      h.scrollToRow('r180');
    });
    await expect.poll(async () => scrollerScrollTop(page), { message: 'scrollToRow で scrollTop が進む' }).toBeGreaterThan(
      2000,
    );
  } finally {
    await context.close();
  }
});
