// DD-070-8 E2E: 見せる行と並び（setRowView・visibleRowIds）。単独モード（standalone.html の既定データ: r0..r19・col-a に「行N」）。

import { expect, test, type Page } from '@playwright/test';

import * as ih from './integration-helpers';
import * as sa from './standalone-helpers';

type Grid = {
  setRowView(ids: string[] | null): void;
  visibleRowIds(): string[];
  insertRows(o: { afterRowId: string | null; count?: number }): void;
  deleteRows(ids: string[]): void;
  setActiveCell(rowId: string, columnId: string): void;
  selection(): { activeCell: { rowId: string; columnId: string } | null };
};

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/standalone.html${query === '' ? '' : `?${query}`}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
}

async function view(page: Page, ids: string[] | null): Promise<void> {
  await page.evaluate((list) => (window as Window & { __gridInstance?: Grid }).__gridInstance!.setRowView(list), ids);
}

async function visible(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as Window & { __gridInstance?: Grid }).__gridInstance!.visibleRowIds());
}

async function commits(page: Page): Promise<sa.StandaloneEvent[]> {
  return (await sa.events(page)).filter((e) => e.type === 'cell-commit');
}

test('AC1: setRowView で渡した順に並び、渡さなかった行が消え、null で戻る。Undo とスクロールが残る', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page);
    await sa.composeCommitAtCell(page, 1, 1, 'x');
    await view(page, ['r5', 'r3', 'r1']);
    await expect.poll(() => visible(page)).toEqual(['r5', 'r3', 'r1']);
    expect(await sa.rowIdAt(page, 0)).toBe('r5');
    expect(await sa.rowCount(page)).toBe(3);
    expect(await sa.canUndo(page)).toBe(true);
    await view(page, null);
    await expect.poll(async () => sa.rowCount(page)).toBe(20);
    expect(await sa.rowIdAt(page, 0)).toBe('r0');
  } finally {
    await context.close();
  }
});

test('AC2: 並べ替え・絞り込み中の編集・範囲の消去・Ctrl+D・貼り付けは見えている行にだけ効き、コピーは見えている行だけ', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page);
    await view(page, ['r9', 'r2', 'r7']); // r2 と r7 の間の r3〜r6 は隠れている
    await expect.poll(() => visible(page)).toEqual(['r9', 'r2', 'r7']);
    // 編集: 見せる並びの 2 行目（r2）に確定。
    await sa.composeCommitAtCell(page, 1, 1, 'edit');
    await expect.poll(() => sa.displayCell(page, 'r2', 'col-b')).toBe('edit');
    expect((await commits(page)).at(-1)!.changes!.map((c) => c.rowId)).toEqual(['r2']);
    // Ctrl+D: r2 の col-a を r7 へ（隠れた r3〜r6 には書かない）。
    await sa.selectCell(page, 1, 0);
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Control+d');
    await expect.poll(() => sa.displayCell(page, 'r7', 'col-a')).toBe('行2');
    for (const hidden of ['r3', 'r4', 'r5', 'r6']) {
      expect(await sa.displayCell(page, hidden, 'col-a')).toBe(`行${hidden.slice(1)}`);
    }
    // 貼り付け: 見えている行へ続けて書く（r9・r2 の col-c）。
    await sa.selectCell(page, 0, 2);
    await ih.dispatchSyntheticPaste(page, 'p1\np2');
    await expect.poll(() => sa.displayCell(page, 'r2', 'col-c')).toBe('p2');
    expect(await sa.displayCell(page, 'r9', 'col-c')).toBe('p1');
    expect(await sa.displayCell(page, 'r3', 'col-c')).toBe('');
    // コピー: 見えている 3 行の col-a だけ（隠れた r3〜r6 は入らない）。synthetic の copy で書き出しの TSV を読む。
    await sa.selectCell(page, 0, 0);
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    const copied = await page.evaluate(() => {
      const ta = document.querySelector('textarea.int-cell-editor') as HTMLTextAreaElement;
      ta.focus();
      const dt = new DataTransfer();
      ta.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
      return dt.getData('text/plain');
    });
    expect(copied.split(/\r?\n/).filter((l) => l !== '')).toEqual(['行9', '行2', '行2']);
    // 範囲の消去: 見えている 3 行の col-c を消す（隠れた行は元のまま）。
    await sa.selectCell(page, 0, 2);
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Delete');
    await expect.poll(() => sa.displayCell(page, 'r9', 'col-c')).toBe('');
  } finally {
    await context.close();
  }
});

test('AC3・AC4: 並べ替え中に挿した行はすぐ下に出て、消した行は抜ける。選択は行を追い、選択中の行を隠すと近くの行へ', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page);
    await view(page, ['r4', 'r1', 'r8']);
    await expect.poll(() => visible(page)).toEqual(['r4', 'r1', 'r8']);
    const inserted = await page.evaluate(() => {
      const g = (window as Window & { __gridInstance?: Grid }).__gridInstance!;
      g.insertRows({ afterRowId: 'r1' });
      return g.visibleRowIds();
    });
    expect(inserted).toHaveLength(4);
    expect(inserted.slice(0, 2)).toEqual(['r4', 'r1']);
    expect(inserted[3]).toBe('r8'); // 挿した行は r1 のすぐ下
    await page.evaluate(() => (window as Window & { __gridInstance?: Grid }).__gridInstance!.deleteRows(['r4']));
    await expect.poll(async () => (await visible(page))[0]).toBe('r1');
    // 選択は行を追う: r8 を選んでから並べ替えても r8 のまま。
    await page.evaluate(() => (window as Window & { __gridInstance?: Grid }).__gridInstance!.setActiveCell('r8', 'col-a'));
    await view(page, ['r8', 'r1']);
    await expect.poll(async () => page.evaluate(() => (window as Window & { __gridInstance?: Grid }).__gridInstance!.selection().activeCell?.rowId)).toBe('r8');
    // 選択中の行を隠すと近くの見えている行へ。
    await view(page, ['r1', 'r2']);
    await expect.poll(async () => page.evaluate(() => (window as Window & { __gridInstance?: Grid }).__gridInstance!.selection().activeCell?.rowId)).not.toBe('r8');
  } finally {
    await context.close();
  }
});

test('AC5: 編集中・変換中に呼ぶと、編集中のセルを確定してから並びが変わる（変換は壊れない・synthetic）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page);
    // 変換中に呼ぶ → 並びは変換が終わるまで変えない。
    await sa.selectCell(page, 2, 1);
    await sa.composeOpen(page, 'へんかん');
    await view(page, ['r5', 'r2']);
    expect(await sa.isComposing(page)).toBe(true);
    expect(await visible(page)).not.toEqual(['r5', 'r2']);
    // 変換を確定する → 確定した値が r2 に入ってから並びが変わる。
    await page.evaluate(() => {
      const ta = document.querySelector('textarea.int-cell-editor') as HTMLTextAreaElement;
      ta.dispatchEvent(new CompositionEvent('compositionend', { data: '変換', bubbles: true }));
      ta.value = '変換';
      ta.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: '変換', isComposing: false, bubbles: true }));
    });
    await expect.poll(() => visible(page)).toEqual(['r5', 'r2']);
    await expect.poll(() => sa.displayCell(page, 'r2', 'col-b')).toBe('変換');
  } finally {
    await context.close();
  }
});

test('AC1 補足: 並びを変えても横スクロールは残る。setData で同じ行 ID を入れ直すと並びは残り、新しい行 ID なら全部見える', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, 'extracols=40');
    const scroller = page.locator('.nsheet-scroller');
    await scroller.evaluate((el) => {
      el.scrollLeft = 600;
    });
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBe(600);
    await view(page, ['r5', 'r3', 'r1']);
    await expect.poll(() => visible(page)).toEqual(['r5', 'r3', 'r1']);
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(600);
    const after = await page.evaluate(() => {
      const g = (window as Window & {
        __gridInstance?: { setData(d: unknown): void; visibleRowIds(): string[] };
      }).__gridInstance!;
      const rows = (ids: string[]) => ({ rows: ids.map((rowId) => ({ rowId, cells: { 'col-a': rowId } })) });
      g.setData(rows(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']));
      const same = g.visibleRowIds();
      g.setData(rows(['n0', 'n1']));
      return { same, fresh: g.visibleRowIds() };
    });
    expect(after.same).toEqual(['r5', 'r3', 'r1']);
    expect(after.fresh).toEqual(['n0', 'n1']);
  } finally {
    await context.close();
  }
});
