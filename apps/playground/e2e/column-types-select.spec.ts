// DD-027-1 E2E: 選択式入力列（ドロップダウン制約）。
//
// 選択式列は URL パラメータ `?select=col-3:進行中|受注|失注`（?wrap= と同方式・main.ts）で宣言する。値は Canvas に
// 描かれ DOM から読めないため、ドロップダウン状態は debug API（selectOpen/selectOptions/... test-support 経由）で
// 観測し、view 状態（committedCell 等）は expect.poll でゲートする（DD-021 教訓）。共有文書への大量変更はしない。
// ドロップダウン開閉/確定/取消の細目はユニット（column-types.test.ts・select-editor.test.ts）が担保し、ここでは
// 「実ブラウザーで入力配線が成立する」ことに集中する。

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  colIdAt,
  committedCell,
  composeFinalizeAndCommit,
  composeOpen,
  dispatchSyntheticPaste,
  openClient,
  plainTypeAndCommit,
  rowIdAt,
  selectCell,
  selectHighlightedIndex,
  selectOpen,
  selectOptions,
  snapshot,
  statusText,
  WS_ORIGIN,
} from './integration-helpers';
import * as sa from './standalone-helpers';

test.describe.configure({ mode: 'serial' });

const SELECT_QUERY = 'col-3:進行中|受注|失注,col-5:X|Y|Z!free';
const SELECT_OPTIONS = ['進行中', '受注', '失注'];

async function openSelectClient(browser: Browser, name: string): Promise<{ context: BrowserContext; page: Page }> {
  return openClient(browser, name, { select: SELECT_QUERY });
}

async function activeElementClass(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.className ?? '');
}

test('AC1: 選択式列で F2 / 印字文字 / dblclick → ドロップダウン（候補一覧・現値ハイライト）が開く', async ({ browser }) => {
  const { context, page } = await openSelectClient(browser, '選択-開閉');
  try {
    // F2 で開く。
    await selectCell(page, 10, 3);
    await page.keyboard.press('F2');
    await expect.poll(async () => selectOpen(page), { message: 'F2 でドロップダウンが開く' }).toBe(true);
    expect(await selectOptions(page)).toEqual(SELECT_OPTIONS);
    expect(await selectHighlightedIndex(page)).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Escape');
    await expect.poll(async () => selectOpen(page)).toBe(false);

    // 印字文字でも開く。
    await selectCell(page, 11, 3);
    await page.keyboard.press('a');
    await expect.poll(async () => selectOpen(page), { message: '印字文字でドロップダウンが開く' }).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(async () => selectOpen(page)).toBe(false);

    // dblclick でも開く（textarea 編集ではなくドロップダウン）。
    await page.locator('.nsheet-scroller').dblclick({ position: await positionInScroller(page, 12, 3) });
    await expect.poll(async () => selectOpen(page), { message: 'dblclick でドロップダウンが開く' }).toBe(true);
    // dblclick は textarea 編集を開始していない（isComposing/draft の副作用なし）。
    expect((await snapshot(page)).draft).toBe('');
  } finally {
    await context.close();
  }
});

test('AC7: 非選択式列は dblclick で従来どおり textarea 編集（ドロップダウンは開かない）', async ({ browser }) => {
  const { context, page } = await openSelectClient(browser, '選択-非対象列');
  try {
    await page.locator('.nsheet-scroller').dblclick({ position: await positionInScroller(page, 10, 2) });
    // col-2 は選択式でない → ドロップダウンは開かず、常駐 textarea が編集モード（display:block）になる。
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const ta = document.querySelector('textarea.int-cell-editor');
          return ta instanceof HTMLTextAreaElement ? ta.style.display : 'none';
        }),
      )
      .toBe('block');
    expect(await selectOpen(page)).toBe(false);
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});

test('AC2: ↑↓/候補クリックで確定 → SetCells が chokepoint 経由で確定・他クライアント反映・Undo で戻る', async ({
  browser,
}) => {
  const a = await openSelectClient(browser, '選択-確定A');
  const b = await openClient(browser, '選択-確定B'); // 別クライアント（select 設定なし＝値は string で共有される）
  try {
    const row = 14;
    const rowId = (await rowIdAt(a.page, row))!;
    const columnId = (await colIdAt(a.page, 3))!;
    const before = await committedCell(a.page, rowId, columnId);
    const target = SELECT_OPTIONS.find((o) => o !== before)!; // 現値と異なる候補を選ぶ

    await selectCell(a.page, row, 3);
    await a.page.keyboard.press('F2');
    await expect.poll(async () => selectOpen(a.page)).toBe(true);
    // 候補クリックで確定（pointerdown・focus は textarea のまま＝preventDefault）。
    await a.page.locator('.ns-select-option', { hasText: target }).click();
    await expect.poll(async () => selectOpen(a.page)).toBe(false);

    // chokepoint 経由で確定 → committed に反映（A）。
    await expect
      .poll(async () => committedCell(a.page, rowId, columnId), { message: 'A で確定値が committed に反映' })
      .toBe(target);
    // 他クライアント B へ反映（共同編集）。
    await expect
      .poll(async () => committedCell(b.page, rowId, columnId), { message: 'B へも確定値が伝播' })
      .toBe(target);

    // Undo で戻る（pending 解消後）。
    await expect.poll(async () => (await snapshot(a.page)).pendingCount).toBe(0);
    await a.page.locator('textarea.int-cell-editor').focus();
    await a.page.keyboard.press('Control+z');
    await expect
      .poll(async () => committedCell(a.page, rowId, columnId), { message: 'Undo で確定前の値へ戻る' })
      .toBe(before);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('AC3: Esc / 外クリック → 取消（文書無変更・focus は textarea のまま）', async ({ browser }) => {
  const { context, page } = await openSelectClient(browser, '選択-取消');
  try {
    const row = 16;
    const rowId = (await rowIdAt(page, row))!;
    const columnId = (await colIdAt(page, 3))!;
    const before = await committedCell(page, rowId, columnId);

    // Esc 取消。
    await selectCell(page, row, 3);
    await page.keyboard.press('F2');
    await expect.poll(async () => selectOpen(page)).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(async () => selectOpen(page)).toBe(false);
    expect(await committedCell(page, rowId, columnId)).toBe(before); // 文書無変更
    expect(await activeElementClass(page)).toBe('int-cell-editor'); // focus は textarea のまま（I-5）

    // 外クリック取消（別セルクリックで閉じる・文書無変更）。listbox は開いたセルの直下に出るため、
    // それに覆われない上方・別列のセル (row-3, col-1) をクリックする（overlay obscure で click が空振りしない）。
    await page.keyboard.press('F2');
    await expect.poll(async () => selectOpen(page)).toBe(true);
    await selectCell(page, row - 3, 1); // listbox に覆われない別セル
    await expect.poll(async () => selectOpen(page)).toBe(false);
    expect(await committedCell(page, rowId, columnId)).toBe(before);
  } finally {
    await context.close();
  }
});

test('AC4: allowFreeText:false 列へ IME 経由の非候補値 commit → 未 submit・value-not-allowed 通知・文書無変更', async ({
  browser,
}) => {
  const { context, page } = await openSelectClient(browser, '選択-非候補拒否');
  try {
    const row = 18;
    const rowId = (await rowIdAt(page, row))!;
    const columnId = (await colIdAt(page, 3))!;
    const before = await committedCell(page, rowId, columnId);

    await selectCell(page, row, 3);
    // IME composition（前段で横取りしない経路）で非候補値を確定する。
    await composeOpen(page, ['ひこうほ', '非候補値']);
    await composeFinalizeAndCommit(page, '非候補値');

    // 公開 rejected（code=value-not-allowed）が #int-status へ表示される（サイレント失敗なし・AC4）。
    await expect
      .poll(async () => statusText(page), { message: 'value-not-allowed が通知される' })
      .toContain('value-not-allowed');
    // 文書は無変更（未 submit）。
    expect(await committedCell(page, rowId, columnId)).toBe(before);
  } finally {
    await context.close();
  }
});

test('AC5: allowFreeText:true 列 → 自由入力が従来どおり確定（候補外も可）', async ({ browser }) => {
  const { context, page } = await openSelectClient(browser, '選択-自由入力');
  try {
    const row = 13;
    const rowId = (await rowIdAt(page, row))!;
    const columnId = (await colIdAt(page, 5))!; // col-5 は allowFreeText:true
    const freeValue = `自由${Date.now() % 1000}`;

    await selectCell(page, row, 5);
    // 印字文字は前段で横取りされない（allowFreeText:true＝isSelectCell 対象外）→ 従来どおり textarea 編集。
    await plainTypeAndCommit(page, freeValue);
    await expect
      .poll(async () => committedCell(page, rowId, columnId), { message: '候補外の自由入力が確定' })
      .toBe(freeValue);
    expect(await selectOpen(page)).toBe(false); // ドロップダウンは開いていない
  } finally {
    await context.close();
  }
});

test('AC6: paste 由来の非候補値 → 拒否されず保持・表示される', async ({ browser }) => {
  const { context, page } = await openSelectClient(browser, '選択-paste保持');
  try {
    const row = 15;
    const rowId = (await rowIdAt(page, row))!;
    const columnId = (await colIdAt(page, 3))!; // allowFreeText:false の選択式列
    const pastedValue = `非候補ペースト${Date.now() % 1000}`;

    await selectCell(page, row, 3);
    // paste は editor 経路 validator を通らない（chokepoint 直行）→ 非候補でも保持される（決定②・AC6）。
    const consumed = await dispatchSyntheticPaste(page, pastedValue);
    expect(consumed).toBe(true);
    await expect
      .poll(async () => committedCell(page, rowId, columnId), { message: 'paste の非候補値は保持される' })
      .toBe(pastedValue);
  } finally {
    await context.close();
  }
});

test('AC8: 不正 columnTypes（未知列）→ config error（column-types-invalid）で fail-fast（配線しない）', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    // col-999 は columnOrder（col-0..col-199）に無い → registry 生成で fail-fast。/config は WS から解決する。
    // config error では attachBackendRendering に到達しない＝常駐 textarea も作られない（未配線）ため待たない。
    await page.goto(`/poc-integration.html?server=${encodeURIComponent(WS_ORIGIN)}&select=${encodeURIComponent('col-999:a|b')}`);
    // boot は config error（phase=config・code=column-types-invalid）で早期 return し ready にならない。
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const events = (window as unknown as { __gridEvents?: Array<{ type: string; code?: string }> }).__gridEvents ?? [];
            return events.find((ev) => ev.type === 'error')?.code ?? null;
          }),
        { message: 'column-types-invalid が config error として通知される' },
      )
      .toBe('column-types-invalid');
    expect((await snapshot(page)).ready).toBe(false); // 未配線（session を作らない）
  } finally {
    await context.close();
  }
});

test('AC8(単独): 不正 columnTypes（未知列）→ config error（column-types-invalid）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    // col-z は standalone の columnOrder（col-a..col-d）に無い → fail-fast。
    await page.goto(`/standalone.html?select=${encodeURIComponent('col-z:a|b')}`);
    await expect.poll(async () =>
      page.evaluate(() => {
        const e = (window.__standalone?.events ?? []).find(
          (ev: { type: string }) => ev.type === 'error',
        ) as { code?: string } | undefined;
        return e?.code ?? null;
      }),
    ).toBe('column-types-invalid');
  } finally {
    await context.close();
  }
});

test('行削除中の安全性: ドロップダウン表示中に対象行が削除 → 閉じる（confirm で無効行へ書かない）', async ({
  browser,
}) => {
  const { context, page } = await openSelectClient(browser, '選択-行削除');
  try {
    const row = 17;
    const rowId = (await rowIdAt(page, row))!;
    await selectCell(page, row, 3);
    await page.keyboard.press('F2');
    await expect.poll(async () => selectOpen(page)).toBe(true);

    // 公開 API で対象行を削除する（performDeleteRows→構造Op→次フレームで rowIndexOf=-1 → 閉じる・📐）。
    await page.evaluate((id: string) => {
      const instance = (window as unknown as { __gridInstance?: { deleteRows(ids: string[]): void } }).__gridInstance;
      instance?.deleteRows([id]);
    }, rowId);
    await expect
      .poll(async () => selectOpen(page), { message: '対象行削除でドロップダウンが閉じる' })
      .toBe(false);

    // 共有 collab 文書を汚さないため、削除した 1 行を挿入し直して net-zero に戻す（DD-021 教訓#3・親 Phase 4 で発覚）。
    // 復元しないと rowCount が 50,000→49,999 のまま残留し、reuse される WS サーバー上で後続 spec の openClient
    // 行数ゲート（>=50,000）を巻き込んで落とす（本テストは 1 行削除の唯一のリークだった）。
    await page.evaluate(() => {
      const instance = (window as unknown as { __gridInstance?: { insertRows(o: { afterRowId: string | null }): void } })
        .__gridInstance;
      instance?.insertRows({ afterRowId: null });
    });
    await expect
      .poll(async () => (await snapshot(page)).rowCount, { message: '削除した行を復元（net-zero・共有文書を汚さない）' })
      .toBeGreaterThanOrEqual(50_000);
  } finally {
    await context.close();
  }
});

test('AC2(単独モード): 選択式確定 → cell-commit 発火（decision②「通知のみ」）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    // standalone.html は select 列を URL で受ける（standalone-main.ts・col-b を選択式にする）。
    await page.goto('/standalone.html?select=col-b:進行中|受注|失注');
    await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
    await sa.waitReady(page);
    await page.evaluate(() => window.__standalone?.clearSaved());

    const row = 3;
    const rowId = (await sa.rowIdAt(page, row))!;
    const columnId = (await sa.colIdAt(page, 1))!; // col-b（index 1・選択式）

    await sa.selectCell(page, row, 1);
    await page.keyboard.press('F2');
    await expect.poll(async () => selectOpen(page)).toBe(true);
    expect(await selectOptions(page)).toEqual(['進行中', '受注', '失注']);
    // ↓ で 2 番目（受注）へ移動して Enter 確定（キーボード経路）。
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect.poll(async () => selectOpen(page)).toBe(false);

    // 単独モードは cell-commit で「通知のみ」（決定②）。表示値も反映される。
    await expect.poll(async () => sa.displayCell(page, rowId, columnId)).toBe('受注');
    const commitEvents = (await sa.events(page)).filter((e) => e.type === 'cell-commit');
    expect(commitEvents.length).toBeGreaterThanOrEqual(1);
    const changed = commitEvents.flatMap((e) => e.changes ?? []).find((c) => c.columnId === columnId);
    expect(changed?.value).toBe('受注');
  } finally {
    await context.close();
  }
});

/** 表示 (row,col) セル中心の scroller 相対座標（locator.dblclick の position 用）。 */
async function positionInScroller(page: Page, row: number, col: number): Promise<{ x: number; y: number }> {
  const rect = await page.evaluate(
    (payload: { row: number; col: number }) => {
      const api = (window as unknown as { __integrationTestApi?: { cellRectAt(r: number, c: number): { x: number; y: number; width: number; height: number } | null } }).__integrationTestApi;
      return api?.cellRectAt(payload.row, payload.col) ?? null;
    },
    { row, col },
  );
  if (rect === null) {
    throw new Error(`セル (${row},${col}) が可視範囲にない`);
  }
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
