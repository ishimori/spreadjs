// DD-070-4 E2E: 数値の列（columnTypes の type: 'number'）。数値にならない入力は確定させず cell-invalid で知らせる。

import { expect, test, type Page } from '@playwright/test';

import * as ih from './integration-helpers';
import * as sa from './standalone-helpers';

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/standalone.html?${query}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
}

async function invalidEvents(page: Page): Promise<Array<{ source: string; cells: NonNullable<sa.StandaloneEvent['cells']> }>> {
  return (await sa.events(page))
    .filter((e) => e.type === 'cell-invalid')
    .map((e) => ({ source: e.source ?? '', cells: e.cells ?? [] }));
}

test('AC1: 数値の列は 12.5・全角・桁区切りの負数を数値で入れ、ND・<0.1・12.5%・日付の形は入れずに cell-invalid を出す', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, 'number=col-b');
    const accepted: Array<[string, string]> = [
      ['12.5', '12.5'],
      ['１２３', '123'],
      ['-1,234', '-1234'],
    ];
    for (const [i, [input, shown]] of accepted.entries()) {
      await sa.composeCommitAtCell(page, i + 1, 1, input);
      await expect.poll(() => sa.displayCell(page, `r${i + 1}`, 'col-b')).toBe(shown);
    }
    const rejected = ['ND', '<0.1', '12.5%', '2026-01-02'];
    for (const [i, input] of rejected.entries()) {
      await sa.composeCommitAtCell(page, i + 5, 1, input);
    }
    await expect.poll(async () => (await invalidEvents(page)).length).toBe(rejected.length);
    const events = await invalidEvents(page);
    expect(events.map((e) => [e.source, e.cells[0]!.message])).toEqual(rejected.map(() => ['edit', '数値を入力してください']));
    for (const i of rejected.keys()) {
      expect(await sa.displayCell(page, `r${i + 5}`, 'col-b')).toBe('');
    }
    // 数値の列でない列は従来どおり何でも入る。
    await sa.composeCommitAtCell(page, 2, 2, 'ND');
    await expect.poll(() => sa.displayCell(page, 'r2', 'col-c')).toBe('ND');
  } finally {
    await context.close();
  }
});

test('AC2（Codex P3）: 貼り付けは不正なセルが 1 つでもあれば、検証を通るセルも含めて全体を書かず、不正なセルを全部載せる', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await open(page, 'number=col-b,col-c');
    await sa.selectCell(page, 1, 1);
    // r1: col-b=1（通る）・col-c=ND（不正）／r2: col-b=2（通る）・col-c=x（不正）
    await ih.dispatchSyntheticPaste(page, '1\tND\n2\tx');
    await expect.poll(async () => (await invalidEvents(page)).length).toBe(1);
    const [event] = await invalidEvents(page);
    expect(event!.source).toBe('paste');
    expect(event!.cells.map((c) => `${c.rowId}:${c.columnId}:${c.value}`)).toEqual(['r1:col-c:ND', 'r2:col-c:x']);
    for (const [rowId, columnId] of [['r1', 'col-b'], ['r1', 'col-c'], ['r2', 'col-b'], ['r2', 'col-c']] as const) {
      expect(await sa.displayCell(page, rowId, columnId)).toBe('');
    }
  } finally {
    await context.close();
  }
});

test('AC2: Ctrl+D で写す値が数値でなければ全体を書かず、invalidMessage の指定が message に入る', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    // col-a（既定データの「行N」）を数値の列 col-b へ Ctrl+R で写す → 数値でないので拒否。
    await open(page, `number=col-b!msg=${encodeURIComponent('wt% は数値で入力')}`);
    await sa.selectCell(page, 3, 0);
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+r');
    await expect.poll(async () => (await invalidEvents(page)).map((e) => [e.source, e.cells.map((c) => c.message)])).toEqual([
      ['fill', ['wt% は数値で入力']],
    ]);
    expect(await sa.displayCell(page, 'r3', 'col-b')).toBe('');
  } finally {
    await context.close();
  }
});
