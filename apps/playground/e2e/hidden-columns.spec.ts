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

async function pixelAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(
    ({ px, py }) => {
      const canvas = document.querySelector('.nsheet-stage canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const dpr = canvas.width / canvas.clientWidth;
      const d = ctx.getImageData(Math.floor(px * dpr), Math.floor(py * dpr), 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    },
    { px: x, py: y },
  );
}

test('Codex P1: 初期値で先頭の列を隠すと、初期の選択は見えている列にある', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, 'hidden=col-a&frozencols=0');
    await expect.poll(async () => (await sa.activeCell(page)).col).toBe(1);
    expect(await page.evaluate(() => (window as GridWindow).__gridInstance!.selection().activeCell?.columnId)).toBe('col-b');
  } finally {
    await context.close();
  }
});

test('Codex P1: 結合の左上の列を隠しても固まらない（結合は見えている列のぶんで 1 つのセル）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    const merged = encodeURIComponent(JSON.stringify([{ rowId: 'r2', columnId: 'col-a', columnSpan: 2 }]));
    await open(page, `frozenrows=0&frozencols=0&merged=${merged}`);
    await page.evaluate(() => (window as Window & { __gridInstance?: { setActiveCell(r: string, c: string): void } }).__gridInstance!.setActiveCell('r2', 'col-a'));
    await hide(page, ['col-a']);
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await sa.activeCell(page)).row).toBe(3); // ページが応答している
  } finally {
    await context.close();
  }
});

test('Codex P1・P2: 隠した列の文字は右の空セルへはみ出さず、見出しの列記号も描かない', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page);
    await sa.composeCommitAtCell(page, 4, 1, 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW'); // col-b の長い文字（col-c は空）
    const c = (await sa.cellRectAt(page, 4, 2))!;
    await expect.poll(async () => pixelAt(page, c.x + 20, c.y + c.height / 2)).not.toBe('255,255,255'); // はみ出している
    await hide(page, ['col-b']);
    // col-b の幅のぶん左へ詰まった col-c（見た目の位置）にも文字が無い（col-c の中央の帯は白）。
    // 描き直しを待って数える（隠した直後の同じフレームではまだ前の絵）。
    await expect
      .poll(async () => {
        const shifted = (await sa.cellRectAt(page, 4, 2))!;
        let painted = 0;
        for (let x = shifted.x + 4; x < shifted.x + shifted.width - 4; x += 4) {
          if ((await pixelAt(page, x, shifted.y + shifted.height / 2)) !== '255,255,255') painted += 1;
        }
        return painted;
      })
      .toBe(0);
  } finally {
    await context.close();
  }
});

test('Codex P2: 外のコントロールのフォーカスを奪わない。見せた直後の scrollToColumn は新しい幅で動く', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, 'extracols=40');
    await sa.selectCell(page, 1, 2);
    const result = await page.evaluate(() => {
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      const g = (window as Window & { __gridInstance?: { setHiddenColumns(ids: string[]): void; scrollToColumn(id: string): void } }).__gridInstance!;
      const all = Array.from({ length: 40 }, (_v, i) => `col-x${i}`);
      g.setHiddenColumns(['col-c', ...all]); // 選択中の列も隠す・横の幅を狭める
      const kept = document.activeElement === input;
      g.setHiddenColumns([]);
      g.scrollToColumn('col-x39'); // 同じ処理の中で末尾の列へ
      return { kept, scrollLeft: (document.querySelector('.nsheet-scroller') as HTMLElement).scrollLeft };
    });
    expect(result.kept).toBe(true);
    expect(result.scrollLeft).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});
