// DD-070-6 E2E: 見出しの印（並べ替えの三角・絞り込みのボタン・まとまりの開閉）と、見出しのクリックの位置（rect・target）・
// 2 段の見出しの上の段のクリック（column-group-click）。

import { expect, test, type Page } from '@playwright/test';

import * as sa from './standalone-helpers';

type GridWindow = Window & {
  __gridInstance?: {
    setColumnHeaderMarks(m: Record<string, { sort?: string; filter?: string }>): void;
    setColumnGroupMarks(m: Record<string, { collapsed: boolean }>): void;
  };
};

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/standalone.html${query === '' ? '' : `?${query}`}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
}

async function pixelAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(
    ({ px, py }) => {
      const canvas = document.querySelector('.nsheet-stage canvas');
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('base canvas が見つからない');
      const ctx = canvas.getContext('2d')!;
      const dpr = canvas.width / canvas.clientWidth;
      const data = ctx.getImageData(Math.floor(px * dpr), Math.floor(py * dpr), 1, 1).data;
      return `${data[0]},${data[1]},${data[2]}`;
    },
    { px: x, py: y },
  );
}

async function clickAt(page: Page, x: number, y: number): Promise<void> {
  await page.locator('.nsheet-scroller').click({ position: { x, y } });
}

test('AC1・AC2: 絞り込みのボタン（active は塗り）が見出しの右端に描かれ、ボタンの上のクリックは target=filter、それ以外は caption。{} で消える', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, `caption=${encodeURIComponent('col-b:比率')}`);
    const header = (await sa.columnHeaderRectAt(page, 1))!;
    // ボタン（14px）の左端の内側（中の白い ▼ を避ける）。
    const buttonLeft = header.x + header.width - 5 - 14;
    const probe = { x: buttonLeft + 2, y: header.y + header.height / 2 };
    const before = await pixelAt(page, probe.x, probe.y);
    await page.evaluate(() => (window as GridWindow).__gridInstance!.setColumnHeaderMarks({ 'col-b': { sort: 'desc', filter: 'active' } }));
    await expect.poll(() => pixelAt(page, probe.x, probe.y)).toBe('26,115,232');

    await clickAt(page, buttonLeft + 7, header.y + header.height / 2);
    await clickAt(page, header.x + 10, header.y + header.height / 2);
    const clicks = (await sa.events(page)).filter((e) => e.type === 'header-click') as unknown as Array<{
      columnId: string;
      target: string;
      rect: { x: number; y: number; width: number; height: number };
    }>;
    expect(clicks.map((c) => [c.columnId, c.target])).toEqual([
      ['col-b', 'filter'],
      ['col-b', 'caption'],
    ]);
    expect(clicks[0]!.rect).toEqual({ x: header.x, y: header.y, width: header.width, height: header.height });

    await page.evaluate(() => (window as GridWindow).__gridInstance!.setColumnHeaderMarks({}));
    await expect.poll(() => pixelAt(page, probe.x, probe.y)).toBe(before);
  } finally {
    await context.close();
  }
});

test('AC3: 2 段の見出しの上の段のクリックで column-group-click（groupId・columnIds・rect）が届き、印で ▸ が描かれる', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    const groups = encodeURIComponent(JSON.stringify([{ caption: 'Supplier', columnIds: ['col-c', 'col-d'], id: 'sup' }]));
    await open(page, `colgroups=${groups}`);
    const c = (await sa.columnHeaderRectAt(page, 2))!;
    const d = (await sa.columnHeaderRectAt(page, 3))!;
    // 上の段（見出しの上半分）の、まとまりの左端寄り（開閉の印の位置）。
    const bandY = c.y + 4;
    const togglePoint = { x: c.x + 5 + 4, y: bandY + 6 };
    const before = await pixelAt(page, togglePoint.x, togglePoint.y);
    await clickAt(page, c.x + c.width, bandY + 4);
    const groupClicks = (await sa.events(page)).filter((e) => e.type === 'column-group-click') as unknown as Array<{
      groupId: string;
      caption: string;
      columnIds: string[];
      rect: { x: number; width: number };
    }>;
    expect(groupClicks).toHaveLength(1);
    expect(groupClicks[0]).toMatchObject({ groupId: 'sup', caption: 'Supplier', columnIds: ['col-c', 'col-d'] });
    expect(groupClicks[0]!.rect.x).toBe(c.x);
    expect(groupClicks[0]!.rect.width).toBe(d.x + d.width - c.x);
    // 上の段のクリックは列の header-click を出さない（DD-064 K4 のまま）。
    expect((await sa.events(page)).some((e) => e.type === 'header-click')).toBe(false);

    await page.evaluate(() => (window as GridWindow).__gridInstance!.setColumnGroupMarks({ sup: { collapsed: true } }));
    await expect.poll(() => pixelAt(page, togglePoint.x, togglePoint.y)).not.toBe(before);
  } finally {
    await context.close();
  }
});

test('Codex P1・P2: mount の初期値の印で描かれ（例外にならない）、打ち間違いの列・まとまりは結線の時に捨てて warn する', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    const marks = encodeURIComponent(JSON.stringify({ 'col-b': { filter: 'active' }, typo: { sort: 'asc' } }));
    const groupMarks = encodeURIComponent(JSON.stringify({ nope: { collapsed: true } }));
    await page.goto(`/standalone.html?headermarks=${marks}&groupmarks=${groupMarks}`);
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);
    expect(errors).toEqual([]);
    const header = (await sa.columnHeaderRectAt(page, 1))!;
    const probe = { x: header.x + header.width - 5 - 14 + 2, y: header.y + header.height / 2 };
    await expect.poll(() => pixelAt(page, probe.x, probe.y)).toBe('26,115,232');
    const warnings = await page.evaluate(
      () => (window as Window & { __standalone?: { diagnostics?: Array<{ code: string; message: string }> } }).__standalone?.diagnostics ?? null,
    );
    if (warnings !== null) {
      expect(warnings.filter((d) => d.code === 'column-header-mark-invalid').length).toBeGreaterThanOrEqual(2);
    }
  } finally {
    await context.close();
  }
});

test('Codex P2: 最終列より右の余白のクリックは header-click・column-group-click を出さない', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    const groups = encodeURIComponent(JSON.stringify([{ caption: 'Last', columnIds: ['col-c', 'col-d'] }]));
    await open(page, `colgroups=${groups}`);
    const last = (await sa.columnHeaderRectAt(page, 3))!;
    const box = (await page.locator('.nsheet-scroller').boundingBox())!;
    const x = last.x + last.width + 40;
    expect(x).toBeLessThan(box.width - 20); // 既定の 4 列は表示域を埋めない
    await clickAt(page, x, last.y + 4); // 上の段の右の余白
    await clickAt(page, x, last.y + last.height - 4); // 下の段の右の余白
    await page.waitForTimeout(100);
    expect((await sa.events(page)).filter((e) => e.type === 'header-click' || e.type === 'column-group-click')).toEqual([]);
  } finally {
    await context.close();
  }
});
