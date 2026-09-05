import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import * as sa from './standalone-helpers';
import * as collab from './integration-helpers';

const evidence = (name: string): string => fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-047/${name}`, import.meta.url));
const colId = (i: number): string => i < 4 ? `col-${'abcd'[i]}` : `col-x${i - 4}`;
const evidence48 = (name: string): string => fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-048/${name}`, import.meta.url));

/** 実Canvasでon/offの両方を検査する。長軸はdevice原点から固定周期。 */
async function patternPixels(page: Page, horizontal: boolean, position: number, from: number, style: 'dotted' | 'dashed', width = 1) {
  return page.evaluate(({ horizontal, position, from, style, width }) => {
    const canvas = document.querySelector('.nsheet-stage canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const d = devicePixelRatio;
    const w = Math.max(1, Math.round(width * d));
    const on = w * (style === 'dotted' ? 1 : 4);
    const period = on + 2 * w;
    const origin = Math.round((horizontal ? 52 : 24) * d);
    const first = origin + Math.ceil((from * d - origin) / period) * period;
    return Array.from({ length: 3 }, (_, n) => [0, on].map((offset) => {
      const long = first + n * period + offset;
      return Array.from(ctx.getImageData(horizontal ? long : Math.round(position * d), horizontal ? Math.round(position * d) : long, 1, 1).data).join(',');
    }));
  }, { horizontal, position, from, style, width });
}

for (const dpr of [1, 1.25, 2]) {
  for (const frozen of [0, 2]) {
    test(`DD-048 S1/S2 patternと背景・固定境界・scroll・resize DPR=${dpr} frozen=${frozen}`, async ({ browser }) => {
      const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      try {
        const params = new URLSearchParams({ extracols: '20', seedrows: '60', frozencols: String(frozen), frozenrows: String(frozen),
          defaultrowborder: '1:ff0000:dotted', colborder: 'col-b:right:1:0000ff:dashed;col-x18:right:1:0000ff:dashed',
          colbg: 'col-c:ffe8e8', rowbg: 'r5:e5e7eb', format: 'col-b:HIT=bg#00ff00',
          rowborder: 'r9:bottom:1:00aa00:solid;r10:top:1:990099:dashed',
        });
        await ready(page, params.toString());
        await page.evaluate(() => window.__standalone?.reinject({ rows: Array.from({ length: 60 }, (_, i) => ({ rowId: `r${i}`, cells: i === 5 ? { 'col-b': 'HIT' } : {} })) }));
        const editor = page.locator('textarea.int-cell-editor');
        await editor.evaluate((e) => { e.dataset.dd048 = 'original'; });
        const hash = await page.evaluate(() => window.__integrationTestApi?.committedHash());
        const r = (await sa.cellRectAt(page, 5, 1))!;
        await expect.poll(() => patternPixels(page, true, r.y, r.x + 10, 'dotted')).toEqual(Array(3).fill(['255,0,0,255', '0,255,0,255']));
        await expect.poll(() => patternPixels(page, true, r.y, 70, 'dotted')).toEqual(Array(3).fill(['255,0,0,255', '229,231,235,255']));
        const empty = (await sa.cellRectAt(page, 2, 2))!;
        await expect.poll(() => patternPixels(page, true, empty.y, empty.x + 10, 'dotted')).toEqual(Array(3).fill(['255,0,0,255', '255,232,232,255']));
        // 縦破線のoffは列背景。横線との交点を避けたon/offペア。
        const seam = r.x + r.width;
        await expect.poll(async () => (await patternPixels(page, false, seam, 76, 'dashed'))[0]).toEqual(['0,0,255,255', '255,232,232,255']);
        const explicit = (await sa.cellRectAt(page, 10, 2))!;
        await expect.poll(async () => (await patternPixels(page, true, explicit.y, explicit.x + 10, 'dashed'))[0]?.[0]).toBe('153,0,153,255');
        expect(await pixel(page, seam, 10)).not.toBe('0,0,255,255');
        expect(await pixel(page, 20, r.y)).not.toBe('255,0,0,255');
        await page.screenshot({ path: evidence48(`pattern-before-dpr-${dpr}-frozen-${frozen}.png`) });
        // 実ドラッグで幅/高さを変更。patternも追従する。
        const box = (await page.locator('.nsheet-scroller').boundingBox())!;
        await page.mouse.move(box.x + seam - 2, box.y + 12);
        await page.mouse.down(); await page.mouse.move(box.x + seam + 38, box.y + 12, { steps: 4 }); await page.mouse.up();
        await expect.poll(async () => (await sa.cellRectAt(page, 5, 1))!.width).toBeGreaterThan(r.width + 20);
        const resized = (await sa.cellRectAt(page, 5, 1))!;
        await expect.poll(async () => (await patternPixels(page, false, resized.x + resized.width, 76, 'dashed'))[0]?.[0]).toBe('0,0,255,255');
        await page.mouse.move(box.x + 26, box.y + r.y + r.height - 2);
        await page.mouse.down(); await page.mouse.move(box.x + 26, box.y + r.y + r.height + 28, { steps: 4 }); await page.mouse.up();
        await expect.poll(async () => (await sa.cellRectAt(page, 5, 1))!.height).toBeGreaterThan(r.height + 15);
        await editor.blur();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.evaluate(() => { const s = document.querySelector('.nsheet-scroller') as HTMLElement; s.scrollLeft = 700; s.scrollTop = 500; });
        await expect.poll(() => page.evaluate(() => document.querySelector('.nsheet-scroller')?.scrollLeft)).toBe(700);
        const far = (await sa.cellRectAt(page, 30, 22))!;
        await expect.poll(async () => (await patternPixels(page, true, far.y, 400, 'dotted'))[0]?.[0]).toBe('255,0,0,255');
        const before = await patternPixels(page, true, far.y, 400, 'dotted');
        await page.setViewportSize({ width: 1270, height: 800 });
        await expect.poll(() => patternPixels(page, true, far.y, 400, 'dotted')).toEqual(before);
        await expect(editor).toHaveAttribute('data-dd048', 'original');
        expect(await page.evaluate(() => window.__integrationTestApi?.committedHash())).toBe(hash);
        expect((await sa.events(page)).filter((e) => e.type === 'cell-commit')).toHaveLength(0);
        await page.screenshot({ path: evidence48(`pattern-after-dpr-${dpr}-frozen-${frozen}.png`) });
      } finally { await context.close(); }
    });
  }
}

test('DD-048 S2/S3 0/1行・最終行・setData・insert/delete・Undo/Redoとcopy/edit', async ({ page }) => {
  await ready(page, 'defaultrowborder=1:ff0000:dotted&frozenrows=0&frozencols=0');
  const editor = page.locator('textarea.int-cell-editor');
  await editor.evaluate((e) => { e.dataset.dd048 = 'original'; });
  for (const rows of [[], [{ rowId: 'non-contiguous', cells: { 'col-b': 'raw' } }]]) {
    await page.evaluate((rows) => window.__standalone?.reinject({ rows }), rows);
    await expect.poll(() => sa.rowCount(page)).toBe(rows.length);
    if (rows.length === 0) await expect.poll(() => pixel(page, 55, 45)).not.toBe('255,0,0,255');
    else await expect.poll(() => patternPixels(page, true, 45, 70, 'dotted')).toEqual(Array(3).fill(['255,0,0,255', '255,255,255,255']));
  }
  await page.evaluate(() => window.__gridInstance?.insertRows({ afterRowId: 'non-contiguous', count: 2 }));
  await expect.poll(() => sa.rowCount(page)).toBe(3);
  await expect.poll(async () => (await patternPixels(page, true, 68, 70, 'dotted'))[0]?.[0]).toBe('255,0,0,255');
  const inserted = await sa.rowIdAt(page, 1);
  await page.evaluate((id) => window.__gridInstance?.deleteRows([id!]), inserted);
  await expect.poll(() => sa.rowCount(page)).toBe(2);
  await expect.poll(async () => (await patternPixels(page, true, 67, 70, 'dotted'))[0]?.[0]).toBe('255,0,0,255');
  await sa.selectCell(page, 0, 1);
  const copy = await page.evaluate(() => { const clipboardData = new DataTransfer(); document.querySelector('textarea')?.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true })); return clipboardData.getData('text/plain'); });
  expect(copy).toBe('raw');
  await sa.composeCommitAtCell(page, 0, 1, '編集');
  expect((await sa.events(page)).filter((e) => e.type === 'cell-commit').at(-1)?.changes).toEqual([{ rowId: 'non-contiguous', columnId: 'col-b', value: '編集', previousValue: 'raw' }]);
  await page.keyboard.press('Control+z');
  await expect.poll(() => sa.displayCell(page, 'non-contiguous', 'col-b')).toBe('raw');
  await page.keyboard.press('Control+y');
  await expect.poll(() => sa.displayCell(page, 'non-contiguous', 'col-b')).toBe('編集');
  await expect.poll(async () => (await patternPixels(page, true, 67, 70, 'dotted'))[0]?.[0]).toBe('255,0,0,255');
  await expect(editor).toHaveAttribute('data-dd048', 'original');
});

test('DD-048 S3 2クライアントのinsert/delete/Undo/RedoとPresence・文書一致', async ({ browser }) => {
  const query = { defaultrowborder: '1:ff0000:dotted' };
  const a = await collab.openClient(browser, 'dotted-A', query);
  const b = await collab.openClient(browser, 'dotted-B', query);
  try {
    const count = (await collab.snapshot(a.page)).rowCount;
    const hash = (await collab.snapshot(a.page)).committedHash;
    expect((await collab.snapshot(b.page)).committedHash).toBe(hash);
    const editor = a.page.locator('textarea.int-cell-editor');
    await editor.evaluate((e) => { e.dataset.dd048 = 'original'; });
    const anchor = await collab.rowIdAt(a.page, 3);
    await a.page.evaluate((id) => window.__gridInstance?.insertRows({ afterRowId: id, count: 1 }), anchor);
    for (const page of [a.page, b.page]) {
      await expect.poll(async () => (await collab.snapshot(page)).rowCount).toBe(count + 1);
      const r = (await sa.cellRectAt(page, 4, 2))!;
      await expect.poll(async () => (await patternPixels(page, true, r.y + r.height, 250, 'dotted'))[0]?.[0]).toBe('255,0,0,255');
    }
    const inserted = await collab.rowIdAt(a.page, 4);
    await a.page.evaluate((id) => window.__gridInstance?.deleteRows([id!]), inserted);
    await expect.poll(async () => (await collab.snapshot(b.page)).rowCount).toBe(count);
    // Undo/Redoの既存公開契約はSetCells。新規行の編集を取り消しても罫線は残る。
    await a.page.evaluate((id) => window.__gridInstance?.insertRows({ afterRowId: id }), anchor);
    await expect.poll(async () => (await collab.snapshot(b.page)).rowCount).toBe(count + 1);
    const editId = await collab.rowIdAt(a.page, 4);
    const editCol = await a.page.evaluate(() => window.__integrationTestApi?.colIdAt(2));
    await collab.selectCell(a.page, 4, 2);
    await collab.composeOpen(a.page, ['点線を保つ']);
    await collab.composeFinalizeAndCommit(a.page, '点線を保つ');
    await expect.poll(() => collab.committedCell(b.page, editId!, editCol!)).toBe('点線を保つ');
    await a.page.keyboard.press('Control+z');
    await expect.poll(() => collab.committedCell(b.page, editId!, editCol!)).toBe('');
    await a.page.keyboard.press('Control+y');
    await expect.poll(() => collab.committedCell(b.page, editId!, editCol!)).toBe('点線を保つ');
    const newRow = (await sa.cellRectAt(b.page, 4, 2))!;
    await expect.poll(async () => (await patternPixels(b.page, true, newRow.y + newRow.height, 250, 'dotted'))[0]?.[0]).toBe('255,0,0,255');
    await collab.selectCell(a.page, 5, 2);
    await expect.poll(async () => (await collab.snapshot(b.page)).presences.some((p) => p.displayName === 'dotted-A')).toBe(true);
    await expect.poll(async () => (await collab.snapshot(b.page)).committedHash).toBe((await collab.snapshot(a.page)).committedHash);
    await expect(editor).toHaveAttribute('data-dd048', 'original');
    await b.page.screenshot({ path: evidence48('collaboration.png') });
    // 同じ文書を使う後続回帰の行位置を維持する。
    await a.page.evaluate((id) => window.__gridInstance?.deleteRows([id!]), editId);
    await expect.poll(async () => (await collab.snapshot(b.page)).rowCount).toBe(count);
  } finally { await a.context.close(); await b.context.close(); }
});

test('DD-048 solid省略の画像互換・patternのwrapとReact draft保持', async ({ page }) => {
  const images: string[] = [];
  for (const suffix of ['', ':solid']) {
    await ready(page, `rowborder=r5:top:2:ff0000${suffix}&colborder=col-b:right:2:0000ff${suffix}`);
    await expect.poll(() => pixel(page, 80, 134)).toBe('255,0,0,255');
    images.push(await page.locator('.nsheet-stage canvas').first().evaluate((c) => (c as HTMLCanvasElement).toDataURL()));
  }
  expect(images[0]).toBe(images[1]);
  await ready(page, 'wrap=col-b&defaultrowborder=1:ff0000:dotted');
  await page.evaluate(() => window.__standalone?.reinject({ rows: [{ rowId: 'r0', cells: {} }, { rowId: 'r9', cells: { 'col-b': '折返しの長い文章で可変行高の点線位置を確認する' } }, { rowId: 'r10', cells: {} }] }));
  await expect.poll(async () => (await sa.cellRectAt(page, 1, 1))!.height).toBeGreaterThan(22);
  const wrap = (await sa.cellRectAt(page, 1, 1))!;
  await expect.poll(async () => (await patternPixels(page, true, wrap.y + wrap.height, 150, 'dotted'))[0]?.[0]).toBe('255,0,0,255');
  await page.screenshot({ path: evidence48('wrap.png') });
  await page.goto('/react-standalone.html?defaultrowborder=1:ff0000:dotted&rowborder=r5:top:2:0000ff');
  const editor = page.locator('textarea.int-cell-editor');
  await expect(editor).toBeAttached();
  await page.evaluate(() => window.__reactStandalone?.setActiveCell('r5', 'col-b'));
  await editor.focus(); await page.keyboard.press('F2'); await page.keyboard.type('kept-draft');
  const draft = await editor.inputValue();
  await editor.evaluate((e) => { e.dataset.dd048 = 'original'; });
  await page.evaluate(() => { history.replaceState(null, '', '?defaultrowborder=1:ff0000:dotted&rowborder=r5:top:2:0000ff:solid'); window.__reactStandalone?.rerender(); });
  await expect(editor).toHaveAttribute('data-dd048', 'original'); await expect(editor).toHaveValue(draft);
});

for (const setting of ['defaultrowborder=1:ff0000:double', 'defaultrowborder=0:ff0000:dotted', 'defaultrowborder=1:invalid:dashed', 'rowborder=r5:top:1:ff0000:double', 'colborder=col-b:right:1:ff0000:double']) {
  test(`DD-048 不正style/defaultはconfigエラー ${setting}`, async ({ page }) => {
    await page.goto(`/standalone.html?${setting}`);
    await expect.poll(() => page.evaluate(() => window.__standalone?.events.some((e) => e.type === 'error' && e.code === 'border-config-invalid'))).toBe(true);
    await expect(page.locator('textarea.int-cell-editor')).toHaveCount(0);
  });
}

async function pixel(page: Page, x: number, y: number, layer = 0): Promise<string> {
  return page.evaluate(({ x, y, layer }) => {
    const canvas = document.querySelectorAll('.nsheet-stage canvas')[layer];
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas missing');
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('context missing');
    const d = window.devicePixelRatio;
    return Array.from(ctx.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data).join(',');
  }, { x, y, layer });
}

async function ready(page: Page, query: string): Promise<void> {
  await page.goto(`/standalone.html?${query}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached();
  await sa.waitReady(page);
}

for (const dpr of [1, 1.25, 2]) {
  for (const frozen of [0, 1, 5]) {
    test(`境界・背景・スクロール・resize DPR=${dpr} 固定列=${frozen}`, async ({ browser }) => {
      const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      try {
        const seamCol = frozen > 0 ? frozen - 1 : 1;
        const params = new URLSearchParams({
          extracols: '196', seedrows: '60', frozencols: String(frozen), frozenrows: '1',
          rowbg: 'r5:e5e7eb', colbg: 'col-b:ffe8e8', format: 'col-b:HIT=bg#00ff00',
          rowborder: 'r0:bottom:2:00aa00;r5:top:2:00aa00;r5:bottom:3:990099;r30:top:2:00aa00',
          colborder: `${colId(seamCol)}:right:2:ff0000;${colId(24)}:right:2:ff0000`,
        });
        await ready(page, params.toString());
        await page.evaluate(() => window.__standalone?.reinject({ rows: Array.from({ length: 60 }, (_, i) => ({ rowId: `r${i}`, cells: i === 5 ? { 'col-b': 'HIT' } : {} })) }));
        const hash = await page.evaluate(() => window.__integrationTestApi?.committedHash());
        const rect = (await sa.cellRectAt(page, 5, seamCol))!;
        const x = rect.x + rect.width;
        await expect.poll(() => pixel(page, x, rect.y + 10)).toBe('255,0,0,255');
        // 同幅交点は横線が勝つ。横線は空の未来月にも連続。
        expect(await pixel(page, x, rect.y)).toBe('0,170,0,255');
        expect(await pixel(page, 850, rect.y + rect.height)).toBe('153,0,153,255');
        expect(await pixel(page, x, 10)).not.toBe('255,0,0,255'); // headerへ延長しない

        // 実ドラッグで列幅と行高を変更して境界が追従する。
        const box = (await page.locator('.nsheet-scroller').boundingBox())!;
        await page.mouse.move(box.x + x - 2, box.y + 12);
        await page.mouse.down();
        await page.mouse.move(box.x + x + 38, box.y + 12, { steps: 4 });
        await page.mouse.up();
        await expect.poll(async () => (await sa.cellRectAt(page, 5, seamCol))!.width).toBeGreaterThan(rect.width + 20);
        const resized = (await sa.cellRectAt(page, 5, seamCol))!;
        await expect.poll(() => pixel(page, resized.x + resized.width, resized.y + 10)).toBe('255,0,0,255');
        await page.mouse.move(box.x + 26, box.y + rect.y + rect.height - 2);
        await page.mouse.down();
        await page.mouse.move(box.x + 26, box.y + rect.y + rect.height + 28, { steps: 4 });
        await page.mouse.up();
        await expect.poll(async () => (await sa.cellRectAt(page, 5, 0))!.height).toBeGreaterThan(rect.height + 15);
        const high = (await sa.cellRectAt(page, 5, 0))!;
        await expect.poll(() => pixel(page, 700, high.y + high.height)).toBe('153,0,153,255');
        // 非編集中のスクロールを測る。既存editorの画面外blur→scroll-followを計測へ混ぜない。
        await page.locator('textarea.int-cell-editor').blur();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.evaluate(() => { const s = document.querySelector('.nsheet-scroller'); if (s instanceof HTMLElement) { s.scrollLeft = 1500; s.scrollTop = 500; } });
        await expect.poll(() => page.evaluate(() => document.querySelector('.nsheet-scroller')?.scrollLeft)).toBe(1500);
        const far = (await sa.cellRectAt(page, 30, 24))!;
        await expect.poll(async () => {
          const r = (await sa.cellRectAt(page, 30, 24))!;
          return pixel(page, r.x + r.width, r.y + 10);
        }).toBe('255,0,0,255');
        const current = (await sa.cellRectAt(page, 30, 24))!;
        expect(await pixel(page, 850, current.y)).toBe('0,170,0,255');
        if (frozen > 0) {
          const seam = (await sa.cellRectAt(page, 30, seamCol))!;
          // seamは両側を合わせたdevice幅を保つ。
          expect(await pixel(page, seam.x + seam.width - 1 / dpr, current.y + 10)).toBe('255,0,0,255');
          expect(await pixel(page, seam.x + seam.width, current.y + 10)).toBe('255,0,0,255');
        }
        expect(far).not.toBeNull();
        expect(await page.evaluate(() => window.__integrationTestApi?.committedHash())).toBe(hash);
        expect((await sa.events(page)).filter((e) => e.type === 'cell-commit')).toHaveLength(0);
        if (frozen === 5) await page.screenshot({ path: evidence(`ledger-dpr-${dpr}.png`) });
      } finally { await context.close(); }
    });
  }
}

test('太い線と同幅後側の競合、未指定/空の互換、キー順不変', async ({ page }) => {
  const images: string[] = [];
  for (const query of ['', 'rowborder=&colborder=']) {
    await ready(page, query);
    images.push(await page.locator('.nsheet-stage canvas').first().evaluate((c) => (c as HTMLCanvasElement).toDataURL()));
  }
  expect(images[0]).toBe(images[1]);
  for (const colborder of ['col-b:right:3:ff0000;col-c:left:3:0000ff', 'col-c:left:3:0000ff;col-b:right:3:ff0000']) {
    await ready(page, new URLSearchParams({ colborder, rowborder: 'r5:top:2:00aa00' }).toString());
    const r = (await sa.cellRectAt(page, 5, 2))!;
    await expect.poll(() => pixel(page, r.x, r.y)).toBe('0,0,255,255');
  }
});

test('RowId追従・削除・後着warnとコピー/commit値の不変', async ({ page }) => {
  await ready(page, 'rowborder=r5:top:2:ff0000;r999:top:2:0000ff');
  await expect.poll(() => page.evaluate(() => window.__standalone?.diagnostics.filter((d) => d.code === 'row-border-unknown').length)).toBe(1);
  await page.evaluate(() => window.__gridInstance?.insertRows({ afterRowId: 'r3', count: 2 }));
  await expect.poll(() => page.evaluate(() => window.__integrationTestApi?.rowIndexOf('r5'))).toBe(7);
  const r = (await sa.cellRectAt(page, 7, 0))!;
  await expect.poll(() => pixel(page, 80, r.y)).toBe('255,0,0,255');
  await page.evaluate(() => window.__gridInstance?.deleteRows(['r5']));
  await expect.poll(() => pixel(page, 80, r.y)).not.toBe('255,0,0,255');
  await page.evaluate(() => window.__standalone?.reinject({ rows: [{ rowId: 'r0', cells: {} }, { rowId: 'r999', cells: { 'col-b': 'raw-value' } }] }));
  await expect.poll(() => pixel(page, 80, 46)).toBe('0,0,255,255');
  await sa.selectCell(page, 1, 1);
  const copy = await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    document.querySelector('textarea')?.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
    return clipboardData.getData('text/plain');
  });
  expect(copy).toBe('raw-value');
  await sa.composeCommitAtCell(page, 1, 1, '編集結果');
  expect((await sa.events(page)).filter((e) => e.type === 'cell-commit').at(-1)?.changes).toEqual([{ rowId: 'r999', columnId: 'col-b', value: '編集結果', previousValue: 'raw-value' }]);
  expect(await page.evaluate(() => window.__standalone?.diagnostics.filter((d) => d.code === 'row-border-unknown').length)).toBe(1);
});

for (const value of ['col-b:right:0:ff0000', 'col-b:right:9:ff0000', 'col-b:right:NaN:ff0000', 'col-b:right:2:not-a-color', 'col-b:right:2:', 'missing:right:2:ff0000']) {
  test(`不正設定はfail-fast: ${value}`, async ({ page }) => {
    await page.goto(`/standalone.html?${new URLSearchParams({ colborder: value })}`);
    await expect.poll(() => page.evaluate(() => window.__standalone?.events.some((e) => e.type === 'error' && e.code === 'border-config-invalid'))).toBe(true);
    await expect(page.locator('textarea.int-cell-editor')).toHaveCount(0);
  });
}

test('Reactの同値再renderで編集中draft・selection・DOMを保持', async ({ page }) => {
  await page.goto('/react-standalone.html?rowborder=r5:top:2:ff0000&colborder=col-b:right:2:0000ff');
  const editor = page.locator('textarea.int-cell-editor');
  await expect(editor).toBeAttached();
  await expect.poll(() => pixel(page, 212, 100)).toBe('0,0,255,255');
  await page.evaluate(() => window.__reactStandalone?.setActiveCell('r5', 'col-b'));
  await editor.focus();
  await page.keyboard.press('F2');
  await page.keyboard.type('draft-preserved');
  const before = await editor.inputValue();
  await editor.evaluate((el) => { el.dataset.dd047 = 'original'; });
  await page.evaluate(() => window.__reactStandalone?.rerender());
  await expect(editor).toHaveAttribute('data-dd047', 'original');
  await expect(editor).toHaveValue(before);
  expect(before).toContain('draft-preserved');
});

test('文字overflowは縦境界を越えず、左外からの流入も止まる', async ({ page }) => {
  await ready(page, 'extracols=20&frozencols=0&colborder=col-b:right:2:ff0000');
  await page.evaluate(() => window.__standalone?.reinject({ rows: Array.from({ length: 10 }, (_, i) => ({ rowId: `r${i}`, cells: i === 5 ? { 'col-b': 'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM' } : {} })) }));
  await expect.poll(() => pixel(page, 212, 145)).toBe('255,0,0,255');
  const countText = (): Promise<number> => page.evaluate(() => {
    const canvas = document.querySelector('.nsheet-stage canvas') as HTMLCanvasElement;
    const data = canvas.getContext('2d')!.getImageData(215, 138, 200, 14).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i]! < 100 && data[i + 1]! < 100 && data[i + 2]! < 100) count += 1;
    return count;
  });
  expect(await countText()).toBe(0);
  await page.evaluate(() => { const s = document.querySelector('.nsheet-scroller'); if (s instanceof HTMLElement) s.scrollLeft = 200; });
  await expect.poll(async () => (await sa.cellRectAt(page, 5, 2))!.x).toBe(12);
  expect(await countText()).toBe(0);
  await page.screenshot({ path: evidence('overflow.png') });
});

test('wrapの自動行高と背景・罫線・選択を合成', async ({ page }) => {
  await ready(page, 'wrap=col-b&rowbg=r5:e5e7eb&rowborder=r5:top:2:00aa00;r5:bottom:2:00aa00&colborder=col-b:right:2:ff0000');
  await page.evaluate(() => window.__standalone?.reinject({ rows: Array.from({ length: 10 }, (_, i) => ({ rowId: `r${i}`, cells: i === 5 ? { 'col-b': '折返しの長い文を複数行で表示して上下罫線の位置を確認する' } : {} })) }));
  await expect.poll(async () => (await sa.cellRectAt(page, 5, 1))!.height).toBeGreaterThan(22);
  const r = (await sa.cellRectAt(page, 5, 1))!;
  await expect.poll(() => pixel(page, 100, r.y + r.height)).toBe('0,170,0,255');
  await sa.selectCell(page, 5, 1);
  await expect.poll(() => pixel(page, r.x, r.y, 1)).not.toBe('0,0,0,0');
  await page.screenshot({ path: evidence('wrap-selection.png') });
});

test('共同編集の同一設定でhash不変・Presenceと選択は罫線の上', async ({ browser }) => {
  const query = { colborder: 'col-1:right:2:ff0000', rowborder: 'row-6:top:2:00aa00' };
  const a = await collab.openClient(browser, 'border-A', query);
  const b = await collab.openClient(browser, 'border-B', query);
  try {
    const hash = (await collab.snapshot(a.page)).committedHash;
    await collab.selectCell(a.page, 5, 1);
    await expect.poll(async () => (await collab.snapshot(b.page)).presences.some((p) => p.displayName === 'border-A')).toBe(true);
    const r = (await sa.cellRectAt(a.page, 5, 1))!;
    for (const page of [a.page, b.page]) {
      await expect.poll(() => pixel(page, r.x + r.width, r.y + 10)).toBe('255,0,0,255');
      await expect.poll(() => pixel(page, 300, r.y)).toBe('0,170,0,255');
      expect((await collab.snapshot(page)).committedHash).toBe(hash);
    }
    await expect.poll(() => pixel(b.page, r.x + r.width, r.y + 10, 1)).not.toBe('0,0,0,0');
    await b.page.screenshot({ path: evidence('collaboration-presence.png') });
  } finally { await a.context.close(); await b.context.close(); }
});
