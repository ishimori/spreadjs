// DD-070-3 E2E: Ctrl+D（上のセルを下へ）・Ctrl+R（左のセルを右へ）。単独モード（standalone.html の既定データ: col-a に「行N」）。

import { expect, test, type Page } from '@playwright/test';

import * as sa from './standalone-helpers';

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/standalone.html${query === '' ? '' : `?${query}`}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
}

async function selectionRange(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as Window & { __integrationTestApi?: { selectionRange(): unknown } }).__integrationTestApi!.selectionRange());
}

async function commits(page: Page): Promise<sa.StandaloneEvent[]> {
  return (await sa.events(page)).filter((e) => e.type === 'cell-commit');
}

test('AC1・AC2: 範囲の Ctrl+D は一番上の値を下の行へ写し（1 回の確定）、Ctrl+Z の 1 回で戻る', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page);
    await sa.selectCell(page, 1, 0);
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Control+d');
    await expect.poll(() => sa.displayCell(page, 'r3', 'col-a')).toBe('行1');
    expect(await sa.displayCell(page, 'r2', 'col-a')).toBe('行1');
    expect(await sa.displayCell(page, 'r1', 'col-a')).toBe('行1');
    const c = await commits(page);
    expect(c).toHaveLength(1);
    expect(c[0]!.changes!.map((x) => `${x.rowId}:${x.value}`)).toEqual(['r2:行1', 'r3:行1']);
    // 選択は動かない（範囲のまま・矩形も同じ）。
    expect(await sa.activeCell(page)).toEqual({ row: 1, col: 0 });
    expect(await selectionRange(page)).toEqual({ rowStart: 1, rowEnd: 4, colStart: 0, colEnd: 1 });

    await page.keyboard.press('Control+z');
    await expect.poll(() => sa.displayCell(page, 'r3', 'col-a')).toBe('行3');
    expect(await sa.displayCell(page, 'r2', 'col-a')).toBe('行2');
  } finally {
    await context.close();
  }
});

test('AC1: 1 セルの Ctrl+D は上のセルから、Ctrl+R は左のセルから写す', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page);
    await sa.selectCell(page, 5, 0);
    await page.keyboard.press('Control+d');
    await expect.poll(() => sa.displayCell(page, 'r5', 'col-a')).toBe('行4');
    await sa.selectCell(page, 2, 1);
    await page.keyboard.press('Control+r');
    await expect.poll(() => sa.displayCell(page, 'r2', 'col-b')).toBe('行2');
    // 先頭の行で Ctrl+D は何もしない。
    const before = (await commits(page)).length;
    await sa.selectCell(page, 0, 2);
    await page.keyboard.press('Control+d');
    await page.waitForTimeout(100);
    expect((await commits(page)).length).toBe(before);
  } finally {
    await context.close();
  }
});

test('AC2: 読むだけの列は飛ばして cells-skipped（fill）を出し、ほかの列へは写す', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, 'readonlycols=col-b');
    await sa.selectCell(page, 1, 0);
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+r');
    await expect.poll(() => sa.displayCell(page, 'r1', 'col-c')).toBe('行1');
    expect(await sa.displayCell(page, 'r1', 'col-b')).toBe('');
    const skipped = (await sa.events(page)).filter((e) => e.type === 'cells-skipped') as unknown as Array<{
      operation: string;
      cells: Array<{ rowId: string; columnId: string }>;
    }>;
    expect(skipped).toEqual([{ type: 'cells-skipped', operation: 'fill', cells: [{ rowId: 'r1', columnId: 'col-b' }] }]);
  } finally {
    await context.close();
  }
});

test('AC2: validateCell が 1 件でも拒否したら全体を書かずに cell-invalid（fill）を出す', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, 'validate=col-c:ng');
    await sa.composeCommitAtCell(page, 1, 1, 'NG');
    await expect.poll(() => sa.displayCell(page, 'r1', 'col-b')).toBe('NG');
    const before = (await commits(page)).length;
    // col-b〜col-d を選ぶ: col-c は拒否、col-d は検証を通る。1 件でも拒否なら col-d も書かない（部分適用しない）。
    await sa.selectCell(page, 1, 1);
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+r');
    await expect
      .poll(async () => (await sa.events(page)).filter((e) => e.type === 'cell-invalid').map((e) => (e as unknown as { source: string }).source))
      .toEqual(['fill']);
    expect(await sa.displayCell(page, 'r1', 'col-c')).toBe('');
    expect(await sa.displayCell(page, 'r1', 'col-d')).toBe('');
    expect((await commits(page)).length).toBe(before);
  } finally {
    await context.close();
  }
});

test('AC3: 編集中の Ctrl+D・Ctrl+R は文書を変えず、ブラウザーの既定（再読み込み）も止める', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page);
    // headless の Chromium は Ctrl+R で再読み込みしないため、既定の動きを止めたことは keydown の defaultPrevented で確かめる
    // （textarea の後に document の bubbling で読む）。
    await page.evaluate(() => {
      const w = window as Window & { __prevented?: string[] };
      w.__prevented = [];
      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && (e.key === 'd' || e.key === 'r')) w.__prevented!.push(`${e.key}:${String(e.defaultPrevented)}`);
      });
    });
    await sa.selectCell(page, 3, 0);
    await page.keyboard.press('F2');
    await expect.poll(() => sa.draft(page)).toBe('行3');
    const before = (await commits(page)).length;
    await page.keyboard.press('Control+d');
    await page.keyboard.press('Control+r');
    await page.waitForTimeout(200);
    // 既定の動き（ブックマーク・再読み込み）を止めた・下書きと文書はそのまま。
    expect(await page.evaluate(() => (window as Window & { __prevented?: string[] }).__prevented)).toEqual(['d:true', 'r:true']);
    expect(await sa.draft(page)).toBe('行3');
    expect((await commits(page)).length).toBe(before);
  } finally {
    await context.close();
  }
});

test('Codex P2: 検索つきの候補欄の検索欄で押した Ctrl+D・Ctrl+R も既定を止め、写さず検索文字も変えない', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, `select=${encodeURIComponent('col-c:受注|失注!search')}`);
    const before = (await commits(page)).length;
    await sa.selectCell(page, 2, 2); // 検索つきの列は 1 回のクリックで開き、検索欄に焦点が移る
    const search = page.locator('input.ns-select-search');
    await expect(search).toBeFocused();
    await search.type('受');
    await page.keyboard.press('Control+d');
    await page.keyboard.press('Control+r');
    await page.waitForTimeout(150);
    expect(await search.inputValue()).toBe('受');
    expect((await commits(page)).length).toBe(before);
    // 検索欄の keydown は伝播を止めるので外から既定の止まり方を見られない。検索欄へ直接送って defaultPrevented を確かめる
    // （headless の Chromium は Ctrl+R で再読み込みしないため、実キーでは確かめられない）。
    const stopped = await search.evaluate((el) =>
      ['d', 'r'].map((key) => {
        const ev = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      }),
    );
    expect(stopped).toEqual([true, true]);
  } finally {
    await context.close();
  }
});

test('Codex P1: 結合範囲の左上以外の値（画面に出ていない値）は写さない（コピーと同じく空として写す）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, 'frozenrows=0&frozencols=0'); // 固定行・固定列の境界をまたぐ結合は張れない
    await sa.composeCommitAtCell(page, 1, 1, 'hidden'); // r1・col-b（あとで結合の左上以外になる）
    await sa.composeCommitAtCell(page, 2, 1, 'z'); // r2・col-b（写す先）
    await expect.poll(() => sa.displayCell(page, 'r2', 'col-b')).toBe('z');
    await page.evaluate(() => {
      const g = (window as Window & { __gridInstance?: { setMergedCells(m: unknown): void } }).__gridInstance!;
      g.setMergedCells([{ rowId: 'r1', columnId: 'col-a', columnSpan: 2 }]);
    });
    await page.waitForTimeout(100);
    // r2 の col-a〜col-b を選んで Ctrl+D（上の行 r1 から写す）。col-b は結合の左上以外なので空を写す。
    await sa.selectCell(page, 2, 0);
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+d');
    await expect.poll(() => sa.displayCell(page, 'r2', 'col-a')).toBe('行1');
    expect(await sa.displayCell(page, 'r2', 'col-b')).toBe('');
  } finally {
    await context.close();
  }
});

test('AC4: 表全体が readOnly なら edit-blocked（fill）を出し、文書は変わらない', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, 'readonly=1');
    await sa.selectCell(page, 2, 0);
    await page.keyboard.press('Control+d');
    await expect
      .poll(async () => (await sa.events(page)).filter((e) => e.type === 'edit-blocked').map((e) => (e as unknown as { input: string }).input))
      .toEqual(['fill']);
    expect(await sa.displayCell(page, 'r2', 'col-a')).toBe('行2');
  } finally {
    await context.close();
  }
});
