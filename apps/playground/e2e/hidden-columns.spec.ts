// DD-070-7 E2E: 見せる列の切り替え（setHiddenColumns・hiddenColumns）。隠した列は幅 0 で残り、作り直さない。

import { expect, test, type Page } from '@playwright/test';

import * as sa from './standalone-helpers';

type GridWindow = Window & { __gridInstance?: { setHiddenColumns(ids: string[]): void; selection(): { activeCell: { columnId: string } | null } } };

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/standalone.html${query === '' ? '' : `?${query}`}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
}

async function hide(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((list) => (window as GridWindow).__gridInstance!.setHiddenColumns(list), ids);
}

test('AC1: 隠すと列が詰まって描かれ、[] で元の幅で戻る。作り直さない（入れた値・Undo・選択が残る）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page);
    await sa.composeCommitAtCell(page, 2, 3, 'keep');
    const beforeD = (await sa.columnHeaderRectAt(page, 3))!;
    const b = (await sa.columnHeaderRectAt(page, 1))!;
    await hide(page, ['col-b']);
    await expect.poll(async () => (await sa.columnHeaderRectAt(page, 3))!.x).toBe(beforeD.x - b.width);
    expect((await sa.columnHeaderRectAt(page, 1))!.width).toBe(0);
    expect(await sa.displayCell(page, 'r2', 'col-d')).toBe('keep');
    expect(await sa.canUndo(page)).toBe(true);
    await hide(page, []);
    await expect.poll(async () => (await sa.columnHeaderRectAt(page, 1))!.width).toBe(b.width);
    expect((await sa.columnHeaderRectAt(page, 3))!.x).toBe(beforeD.x);
  } finally {
    await context.close();
  }
});

test('AC2・AC3: 隠した列はクリックで選ばれず、矢印・Tab で飛ばして動く。選択中の列を隠すと隣の見えている列へ寄る', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, 'hidden=col-c');
    await sa.selectCell(page, 1, 1); // col-b
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await sa.activeCell(page)).col).toBe(3); // col-c を飛ばして col-d
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await sa.activeCell(page)).col).toBe(1); // 戻りも col-c を飛ばす
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await sa.activeCell(page)).col).toBe(3);
    // col-b と col-d の境目（col-c は幅 0）をクリックしても col-c は選ばれない。
    const d = (await sa.cellRectAt(page, 4, 3))!;
    await page.locator('.nsheet-scroller').click({ position: { x: d.x + 1, y: d.y + d.height / 2 } });
    await expect.poll(async () => (await sa.activeCell(page)).col).toBe(3);
    // 選択中の列（col-d）を隠すと右の見えている列（無ければ左）へ寄る。
    await hide(page, ['col-c', 'col-d']);
    await expect.poll(async () => (await sa.activeCell(page)).col).not.toBe(3);
    const col = (await sa.activeCell(page)).col;
    expect([0, 1]).toContain(col);
  } finally {
    await context.close();
  }
});

test('AC4: 2 段の見出しのまとまりの中の一部を隠すと、上の段が見えている列だけの幅になる', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    const groups = encodeURIComponent(JSON.stringify([{ caption: 'Supplier', columnIds: ['col-b', 'col-c', 'col-d'], id: 'sup' }]));
    await open(page, `colgroups=${groups}`);
    const c = (await sa.columnHeaderRectAt(page, 2))!;
    await hide(page, ['col-c', 'col-d']);
    // 上の段のクリックの rect がまとまりの見えている幅（col-b だけ）になる。
    const b = (await sa.columnHeaderRectAt(page, 1))!;
    await page.locator('.nsheet-scroller').click({ position: { x: b.x + b.width / 2, y: b.y + 4 } });
    const click = (await sa.events(page)).filter((e) => e.type === 'column-group-click').at(-1) as unknown as { rect: { x: number; width: number } };
    expect(click.rect.x).toBe(b.x);
    expect(click.rect.width).toBe(b.width);
    expect(c.width).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});
