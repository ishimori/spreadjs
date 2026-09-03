// DD-027-2 E2E: ハイパーリンク列（クリック→link-open・リンク装飾・navigate 不発）。
//
// リンク列は URL パラメータ `?link=col-4`（?select= と同方式・main.ts）で宣言する。値は Canvas に描かれるため、
// link-open イベントは main.ts が記録する window.__gridEvents（onEvent 全記録）で観測し、view 状態（committedCell 等）は
// expect.poll でゲートする（DD-021 教訓）。候補追跡の裁定細目は unit（link-column.test.ts）が担保し、ここでは
// 「実ブラウザーでクリック→イベント契約が成立し、既存の選択/ドラッグ/編集を壊さない」ことに集中する。
// window.open は defaultOpen の検証のため patchWindowOpen で記録に差し替える（実ポップアップを開かない）。

import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  colIdAt,
  committedCell,
  composeOpen,
  composeFinalizeAndCommit,
  dispatchSyntheticPaste,
  dragSelect,
  openClient,
  rowIdAt,
  selectCell,
  selectOpen,
  selectionRange,
  snapshot,
  cellRectAt,
} from './integration-helpers';
import type { CellRect } from './integration-helpers';
import * as sa from './standalone-helpers';

test.describe.configure({ mode: 'serial' });

interface LinkOpenEvent {
  type: string;
  rowId: string;
  columnId: string;
  value: string;
}

async function openLinkClient(
  browser: Browser,
  name: string,
  linkQuery = 'col-4',
): Promise<{ context: BrowserContext; page: Page }> {
  const client = await openClient(browser, name, { link: linkQuery });
  await patchWindowOpen(client.page);
  return client;
}

/** window.open を記録用に差し替える（実ポップアップを開かない・navigate 不発の検証）。grid は呼び出し時に参照する。 */
async function patchWindowOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __opened: unknown[][]; open: (...a: unknown[]) => unknown };
    w.__opened = [];
    w.open = (...args: unknown[]) => {
      w.__opened.push(args);
      return null;
    };
  });
}

async function openedArgs(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => (window as unknown as { __opened?: unknown[][] }).__opened ?? []);
}

async function linkOpenEvents(page: Page): Promise<LinkOpenEvent[]> {
  return page.evaluate(
    () =>
      ((window as unknown as { __gridEvents?: LinkOpenEvent[] }).__gridEvents ?? []).filter(
        (e) => e.type === 'link-open',
      ) as LinkOpenEvent[],
  );
}

async function linkOpenCount(page: Page): Promise<number> {
  return (await linkOpenEvents(page)).length;
}

/** リンク列セル（row,col）へ値を注入する（空セルへ selectCell→paste。paste は editor validator を通らず素通し）。 */
async function seedCell(page: Page, row: number, col: number, value: string): Promise<{ rowId: string; columnId: string }> {
  const rowId = (await rowIdAt(page, row))!;
  const columnId = (await colIdAt(page, col))!;
  await selectCell(page, row, col); // 空セルなら link-open 発火なし（値注入前）
  const consumed = await dispatchSyntheticPaste(page, value);
  expect(consumed).toBe(true);
  await expect.poll(async () => committedCell(page, rowId, columnId), { message: '値注入' }).toBe(value);
  return { rowId, columnId };
}

test('AC1: リンク列の非空セルをクリック → link-open{rowId,columnId,value} 発火・activeCell 移動・navigate しない', async ({
  browser,
}) => {
  const { context, page } = await openLinkClient(browser, 'link-クリック');
  try {
    const url = 'https://example.com/detail/1';
    const { rowId, columnId } = await seedCell(page, 8, 4, url);

    const before = await linkOpenCount(page);
    // 別セルへ退避してから対象セルをクリック（クリックで activeCell が (8,4) へ移動することも確認する）。
    await selectCell(page, 5, 1);
    await selectCell(page, 8, 4);

    await expect.poll(async () => linkOpenCount(page), { message: 'link-open が発火' }).toBe(before + 1);
    const ev = (await linkOpenEvents(page)).at(-1)!;
    expect(ev.rowId).toBe(rowId);
    expect(ev.columnId).toBe(columnId);
    expect(ev.value).toBe(url);
    // activeCell が (8,4) へ移動している（選択を奪わない＝クリックの本来挙動は維持）。
    await expect.poll(async () => (await snapshot(page)).activeCell).toEqual({ row: 8, col: 4 });
    // SDK は navigate しない（defaultOpen 未指定＝window.open 不呼出）。
    expect(await openedArgs(page)).toEqual([]);
  } finally {
    await context.close();
  }
});

test('AC2: 空セルのクリック → link-open 発火なし（選択のみ）', async ({ browser }) => {
  const { context, page } = await openLinkClient(browser, 'link-空セル');
  try {
    const rowId = (await rowIdAt(page, 9))!;
    const columnId = (await colIdAt(page, 4))!;
    // 対象セルを空にする（seed が非空でも Delete でクリア）。
    await selectCell(page, 9, 4);
    await page.keyboard.press('Delete');
    await expect.poll(async () => committedCell(page, rowId, columnId)).toBe('');

    const before = await linkOpenCount(page);
    await selectCell(page, 6, 1); // 別セルへ退避
    await selectCell(page, 9, 4); // 空セルをクリック
    await page.waitForTimeout(150);
    expect(await linkOpenCount(page)).toBe(before); // 発火なし
    await expect.poll(async () => (await snapshot(page)).activeCell).toEqual({ row: 9, col: 4 }); // 選択はされる
  } finally {
    await context.close();
  }
});

test('AC3: セルをまたぐドラッグ → link-open 発火なし・レンジ選択が従来どおり成立', async ({ browser }) => {
  const { context, page } = await openLinkClient(browser, 'link-ドラッグ');
  try {
    await seedCell(page, 7, 4, 'https://example.com/x');
    const before = await linkOpenCount(page);
    // (7,4) から (10,4) までドラッグ（開始セルがリンク非空だが focus が離れるため候補破棄・AC3）。
    await dragSelect(page, { row: 7, col: 4 }, { row: 10, col: 4 });
    await page.waitForTimeout(150);
    expect(await linkOpenCount(page)).toBe(before); // 発火なし
    const range = await selectionRange(page);
    expect(range).not.toBeNull();
    expect(range!.rowStart).toBe(7);
    expect(range!.rowEnd).toBe(11); // 半開区間 [7,11)＝4 行
  } finally {
    await context.close();
  }
});

test('AC4: ダブルクリック → 既存値編集が開始（link-open は 1 打目で 1 回のみ）', async ({ browser }) => {
  const { context, page } = await openLinkClient(browser, 'link-dblclick');
  try {
    await seedCell(page, 12, 4, 'https://example.com/dbl');
    const before = await linkOpenCount(page);
    await selectCell(page, 5, 1); // 退避
    const rect = await cellRectAt(page, 12, 4);
    await page
      .locator('.nsheet-scroller')
      .dblclick({ position: { x: rect!.x + rect!.width / 2, y: rect!.y + rect!.height / 2 } });

    // 1 打目（detail=1）で link-open が 1 回だけ発火する（2 打目 detail=2 では発火しない・📐 確定）。
    await expect.poll(async () => linkOpenCount(page), { message: '1 打目で 1 回発火' }).toBe(before + 1);
    // リンク列は選択式ではない → dblclick で常駐 textarea 編集が開始する（display:block）。
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const ta = document.querySelector('textarea.int-cell-editor');
          return ta instanceof HTMLTextAreaElement ? ta.style.display : 'none';
        }),
      )
      .toBe('block');
    await page.keyboard.press('Escape');
    // 追加発火がないこと（2 打目では発火しない）。
    expect(await linkOpenCount(page)).toBe(before + 1);
  } finally {
    await context.close();
  }
});

test('AC6: defaultOpen:true → https は window.open(noopener)・javascript: は open されず（link-open は発火）', async ({
  browser,
}) => {
  const { context, page } = await openLinkClient(browser, 'link-defaultOpen', 'col-4!open');
  try {
    // (a) 絶対 https → window.open が呼ばれる（noopener,noreferrer）。
    await seedCell(page, 6, 4, 'https://example.com/ok');
    let before = await linkOpenCount(page);
    await selectCell(page, 5, 1);
    await selectCell(page, 6, 4);
    await expect.poll(async () => linkOpenCount(page)).toBe(before + 1);
    await expect.poll(async () => (await openedArgs(page)).length, { message: 'https で window.open' }).toBe(1);
    const opened = await openedArgs(page);
    expect(opened[0][0]).toBe('https://example.com/ok');
    expect(opened[0][1]).toBe('_blank');
    expect(opened[0][2]).toBe('noopener,noreferrer');

    // (b) javascript: スキーム → open されない（link-open は発火する）。
    await seedCell(page, 10, 4, 'javascript:alert(1)');
    before = await linkOpenCount(page);
    await selectCell(page, 5, 1);
    await selectCell(page, 10, 4);
    await expect.poll(async () => linkOpenCount(page), { message: 'javascript: でも link-open は発火' }).toBe(before + 1);
    await page.waitForTimeout(150);
    expect((await openedArgs(page)).length).toBe(1); // (a) の 1 回のまま（javascript: では増えない）
  } finally {
    await context.close();
  }
});

test('AC7: リンク列の非空セルはリンク色＋下線・自セル内クリップ（右隣へオーバーフローしない）', async ({
  browser,
}) => {
  const { context, page } = await openLinkClient(browser, 'link-描画');
  try {
    // 右隣（col-5）を空にし、col-4 へ 1 セル幅を超える長い値を入れる（クリップされれば col-5 は空のまま）。
    const rowId5 = (await rowIdAt(page, 14))!;
    const col5 = (await colIdAt(page, 5))!;
    await selectCell(page, 14, 5);
    await page.keyboard.press('Delete');
    await expect.poll(async () => committedCell(page, rowId5, col5)).toBe('');
    await seedCell(page, 14, 4, 'https://example.com/a/very/long/path/that/would/overflow');
    await selectCell(page, 2, 1); // ▼/カーソルを対象から外す

    const linkRect = (await cellRectAt(page, 14, 4))!;
    const rightRect = (await cellRectAt(page, 14, 5))!;
    await expect
      .poll(async () => scanLinkBlue(page, linkRect), { message: 'リンク色がリンクセルに描画される' })
      .toBe(true);
    // 右隣セルの右半分にリンク色が無い＝オーバーフローしていない（自セル内 fitText クリップ）。
    const rightHalf: CellRect = {
      x: rightRect.x + rightRect.width / 2,
      y: rightRect.y,
      width: rightRect.width / 2,
      height: rightRect.height,
    };
    expect(await scanLinkBlue(page, rightHalf)).toBe(false);

    await page.screenshot({ path: evidencePath('link-column-render.png') });
  } finally {
    await context.close();
  }
});

test('AC8: Editing 中のクリック → 従来経路（確定して移動）のまま link-open 発火なし', async ({ browser }) => {
  const { context, page } = await openLinkClient(browser, 'link-編集中');
  try {
    await seedCell(page, 11, 4, 'https://example.com/edit');
    // 別セルで編集を開始（F2）。
    await selectCell(page, 11, 2);
    await page.keyboard.press('F2');
    await page.keyboard.type('編集途中');
    const before = await linkOpenCount(page);
    // 編集中にリンクセルをクリック → pointerdown 時点は EditingExisting → 候補武装せず（AC8）。
    await selectCell(page, 11, 4);
    await page.waitForTimeout(150);
    expect(await linkOpenCount(page)).toBe(before); // 発火なし
  } finally {
    await context.close();
  }
});

test('AC5: リンク列でも F2/直接入力の編集・確定が従来どおり成立（commit 制約なし）', async ({ browser }) => {
  const { context, page } = await openLinkClient(browser, 'link-編集可');
  try {
    const rowId = (await rowIdAt(page, 13))!;
    const columnId = (await colIdAt(page, 4))!;
    const value = `https://example.com/typed/${Date.now() % 1000}`;
    await selectCell(page, 13, 4);
    await page.keyboard.press('F2');
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => committedCell(page, rowId, columnId), { message: 'リンク列も自由編集で確定' })
      .toBe(value);
  } finally {
    await context.close();
  }
});

test('IME 回帰: リンク列で IME 入力・確定が従来どおり成立（editor 経路無改変）', async ({ browser }) => {
  const { context, page } = await openLinkClient(browser, 'link-IME');
  try {
    const rowId = (await rowIdAt(page, 15))!;
    const columnId = (await colIdAt(page, 4))!;
    await selectCell(page, 15, 4);
    await composeOpen(page, ['にほんご', '日本語']);
    await composeFinalizeAndCommit(page, '日本語');
    await expect.poll(async () => committedCell(page, rowId, columnId)).toBe('日本語');
  } finally {
    await context.close();
  }
});

test('AC1(単独モード): リンク列クリック → link-open 発火（両モード共通）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    // standalone.html は link 列を URL で受ける（standalone-main.ts）。col-a はシード値「行N」を持つ。
    await page.goto('/standalone.html?link=col-a');
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);

    const row = 3;
    const rowId = (await sa.rowIdAt(page, row))!;
    const columnId = (await sa.colIdAt(page, 0))!; // col-a（index 0・リンク・値「行3」）

    await sa.selectCell(page, 1, 1); // 退避
    await sa.selectCell(page, row, 0); // リンクセルをクリック

    await expect
      .poll(async () => (await sa.events(page)).filter((e) => e.type === 'link-open').length, {
        message: '単独モードでも link-open が発火',
      })
      .toBeGreaterThanOrEqual(1);
    const ev = (await sa.events(page)).filter((e) => e.type === 'link-open').at(-1)!;
    expect(ev.rowId).toBe(rowId);
    expect(ev.columnId).toBe(columnId);
    expect(ev.value).toBe('行3');
  } finally {
    await context.close();
  }
});

test('Fable P1: リンクセルから列ヘッダーへドラッグして離す → link-open 発火なし（格子外離脱で候補破棄）', async ({
  browser,
}) => {
  const { context, page } = await openLinkClient(browser, 'link-ヘッダー離脱');
  try {
    await seedCell(page, 7, 4, 'https://example.com/drag-out');
    const before = await linkOpenCount(page);
    const cell = (await cellRectAt(page, 7, 4))!;
    const box = (await page.locator('.nsheet-scroller').boundingBox())!;
    const startX = box.x + cell.x + cell.width / 2;
    const startY = box.y + cell.y + cell.height / 2;
    // 押下（リンクセル）→ 列ヘッダー帯（scroller 上端≈y<24＝HEADER_HEIGHT）へドラッグ → 離す。
    // 旧実装は cell hit ブロック内でのみ候補破棄していたため、ヘッダー離脱で候補が生存し発火していた（Fable P1）。
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, box.y + 6, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    expect(await linkOpenCount(page)).toBe(before); // 発火なし
  } finally {
    await context.close();
  }
});

test('Fable P2: 同一リンクセルを間隔 >400ms で 2 回クリック → link-open が 2 回発火（time-guard は synthetic 補完のみ）', async ({
  browser,
}) => {
  const { context, page } = await openLinkClient(browser, 'link-連続クリック');
  try {
    await seedCell(page, 9, 4, 'https://example.com/twice');
    const before = await linkOpenCount(page);
    await selectCell(page, 5, 1); // 退避
    await selectCell(page, 9, 4); // 1 回目
    await expect.poll(async () => linkOpenCount(page), { message: '1 回目発火' }).toBe(before + 1);
    await page.waitForTimeout(500); // LINK_DBLCLICK_MS(400) を超える → 2 打目扱いにならない
    await selectCell(page, 9, 4); // 2 回目（同一セル・>400ms）
    await expect.poll(async () => linkOpenCount(page), { message: '>400ms で 2 回目も発火' }).toBe(before + 2);
  } finally {
    await context.close();
  }
});

test('Fable P3: 選択式ドロップダウン表示中にリンクセルをクリック → dropdown は閉じるが link-open は発火しない', async ({
  browser,
}) => {
  const { context, page } = await openClient(browser, 'link-dropdown-dismiss', {
    select: 'col-3:進行中|受注|失注',
    link: 'col-4',
  });
  try {
    await patchWindowOpen(page);
    await seedCell(page, 8, 4, 'https://example.com/dismiss'); // リンクセルへ値注入
    // 選択式列 col-3 のセルで F2 → ドロップダウンを開く。
    await selectCell(page, 8, 3);
    await page.keyboard.press('F2');
    await expect.poll(async () => selectOpen(page), { message: 'ドロップダウンが開く' }).toBe(true);

    const before = await linkOpenCount(page);
    // 開いたまま隣のリンクセルをクリック（＝dismiss クリック）。
    await selectCell(page, 8, 4);
    // ドロップダウンは閉じる。
    await expect.poll(async () => selectOpen(page), { message: 'dismiss で閉じる' }).toBe(false);
    // dismiss クリックはリンクを起動しない（Fable P3: ポップアップ打ち消しとリンク起動を兼ねさせない）。
    await page.waitForTimeout(150);
    expect(await linkOpenCount(page)).toBe(before); // 発火なし
    expect(await openedArgs(page)).toEqual([]);
  } finally {
    await context.close();
  }
});

/** base canvas の指定矩形（CSS px）にリンク色（#1a73e8 系＝高 blue・低 red/green）が 1px でもあるか。 */
async function scanLinkBlue(page: Page, rect: CellRect): Promise<boolean> {
  return page.evaluate((r: CellRect) => {
    const canvas = document.querySelector('#int-stage canvas');
    if (!(canvas instanceof HTMLCanvasElement)) {
      return false;
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      return false;
    }
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const x = Math.max(0, Math.floor(r.x * dpr));
    const y = Math.max(0, Math.floor(r.y * dpr));
    const w = Math.max(1, Math.floor(r.width * dpr));
    const h = Math.max(1, Math.floor(r.height * dpr));
    const data = ctx.getImageData(x, y, w, h).data;
    for (let i = 0; i < data.length; i += 4) {
      const rr = data[i];
      const gg = data[i + 1];
      const bb = data[i + 2];
      const aa = data[i + 3];
      // リンク色 #1a73e8=(26,115,232): 高 blue かつ red/green より十分高い（数値色 #1a4f8a=b:138 や黒文字と区別）。
      if (aa > 0 && bb > 180 && bb - rr > 60 && bb - gg > 40) {
        return true;
      }
    }
    return false;
  }, rect);
}

/** DD-027-2 証跡（スクショ）の保存先（active な doc/DD を汚さず test-results 配下）。 */
function evidencePath(fileName: string): string {
  return fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-027-2/${fileName}`, import.meta.url));
}
