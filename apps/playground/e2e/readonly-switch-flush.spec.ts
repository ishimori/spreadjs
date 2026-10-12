// DD-056-2 E2E: 読み取り専用の実行時切替（setReadOnly）と送り切り（flush）、変換確定の直後の確定漏れの修正（広島空港 H12・contract.md §4）。
//
// 共同編集の統合ページ（poc-integration.html）を、認可フック E2E 用サーバー（dev:authorize・5 行。禁止の制御口は使わない）へ繋ぎ、
// 公開 API（window.__gridInstance の setReadOnly / flush / pendingCount）と synthetic composition で次を確かめる:
//   ① setReadOnly(true) で編集中の値が確定・送信され、開き直さない（同じ textarea）。以後は入力・Delete・行操作が効かない。false で戻る（AC1）
//   ② オフラインで入力 → setReadOnly(true) → 再接続で未送信の操作が届く（AC2）
//   ③ 順序B（compositionend の後に非変換の input が来ない＝Tier 1 の実機の順序）の直後に flush()／setReadOnly(true) → 確定値が送られる（AC3）
//   ④ 変換中に setReadOnly(true) → 変換が終わるまで textarea は触られず、終わった後に確定して読み取り専用になる（AC4）
//   ⑤ flush(): 送り切ると flushed、オフラインで上限を過ぎると timeout（AC5）
//   ⑥ 既存不具合の修正: 順序B の確定直後に別セルをクリック → 元のセルへ確定して移る／グリッド外のクリック → 確定（AC6）
// ⚠️ synthetic composition は実 IME ではない（順序と状態遷移の配線の確認）。実 IME は Manual Gate（T1・推奨）。

import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import * as ih from './integration-helpers';

test.describe.configure({ mode: 'serial' });

/** 認可フック E2E 用サーバー（playwright.config.ts の AUTHORIZE_WS_PORT と一致させること）。本 spec は禁止の制御口を使わない。 */
const WS_ORIGIN = 'http://127.0.0.1:8803';

function evidencePath(fileName: string): string {
  return fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-056/${fileName}`, import.meta.url));
}

async function openClient(browser: Browser, name: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/poc-integration.html?name=${encodeURIComponent(name)}&server=${encodeURIComponent(WS_ORIGIN)}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await expect
    .poll(async () => (await ih.snapshot(page)).ready, { timeout: 30_000, message: `${name} が ready にならない` })
    .toBe(true);
  expect((await ih.snapshot(page)).online, `${name} online`).toBe(true);
  return { context, page };
}

async function setReadOnly(page: Page, readOnly: boolean): Promise<void> {
  await page.evaluate((next: boolean) => {
    (window as unknown as { __gridInstance: { setReadOnly(v: boolean): void } }).__gridInstance.setReadOnly(next);
  }, readOnly);
}

async function flush(page: Page, timeoutMs?: number): Promise<{ status: string; pendingCount?: number; editing?: boolean }> {
  return page.evaluate(
    (ms: number | null) =>
      (window as unknown as {
        __gridInstance: { flush(o?: { timeoutMs?: number }): Promise<{ status: string; pendingCount?: number; editing?: boolean }> };
      }).__gridInstance.flush(ms === null ? undefined : { timeoutMs: ms }),
    timeoutMs ?? null,
  );
}

async function pendingCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __gridInstance: { pendingCount(): number } }).__gridInstance.pendingCount());
}

async function textareaReadOnly(page: Page): Promise<boolean> {
  return page.locator('textarea.int-cell-editor').evaluate((el) => (el as HTMLTextAreaElement).readOnly);
}

/** 変換を始め、変換中のまま留める（compositionstart → compositionupdate → 変換中の input）。 */
async function composeOpen(page: Page, text: string): Promise<void> {
  await page.evaluate((data: string) => {
    const ta = document.querySelector('textarea.int-cell-editor');
    if (!(ta instanceof HTMLTextAreaElement)) {
      throw new Error('int-cell-editor が見つからない');
    }
    ta.focus();
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    ta.value = data;
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data, bubbles: true }));
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data, isComposing: true, bubbles: true }));
  }, text);
}

/** 順序B で変換を確定する: compositionend だけを送り、非変換の input は送らない（Tier 1 の実機の順序・DD-035 trace）。 */
async function composeEndOrderB(page: Page, text: string): Promise<void> {
  await page.evaluate((data: string) => {
    const ta = document.querySelector('textarea.int-cell-editor');
    if (!(ta instanceof HTMLTextAreaElement)) {
      throw new Error('int-cell-editor が見つからない');
    }
    ta.dispatchEvent(new CompositionEvent('compositionend', { data, bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', isComposing: false, bubbles: true }));
  }, text);
}

async function cellId(page: Page, row: number, col: number): Promise<{ rowId: string; columnId: string }> {
  const rowId = await ih.rowIdAt(page, row);
  const columnId = await ih.colIdAt(page, col);
  if (rowId === undefined || columnId === undefined) {
    throw new Error(`セル (${row},${col}) が無い`);
  }
  return { rowId, columnId };
}

test.describe('DD-056 H12 読み取り専用の実行時切替・送り切り', () => {
  test('① setReadOnly(true) は編集中の値を確定して送り、開き直さない。以後の入力・Delete・行操作は効かず、false で戻る', async ({ browser }) => {
    const alice = await openClient(browser, 'Alice');
    const bob = await openClient(browser, 'Bob');
    try {
      const page = alice.page;
      await page.locator('textarea.int-cell-editor').evaluate((el) => {
        el.setAttribute('data-dd056-marker', 'same-node'); // 開き直したら消える目印
      });
      const target = await cellId(page, 0, 1);
      const value = `ro-commit-${Date.now()}`;
      await ih.selectCell(page, 0, 1);
      await page.keyboard.type(value); // 確定（Enter）せず編集中のまま
      expect((await ih.snapshot(page)).editingTarget).not.toBeNull();

      await setReadOnly(page, true);
      await expect.poll(() => ih.committedCell(bob.page, target.rowId, target.columnId), { timeout: 10_000 }).toBe(value);
      expect((await ih.snapshot(page)).editingTarget).toBeNull(); // 確定して移動しない
      expect((await ih.snapshot(page)).activeCell).toEqual({ row: 0, col: 1 });
      expect(await textareaReadOnly(page)).toBe(true);
      expect(await page.locator('textarea.int-cell-editor[data-dd056-marker="same-node"]').count()).toBe(1); // 開き直していない

      // 以後は入力・Delete・行操作が効かない。
      const rowCountBefore = (await ih.snapshot(page)).rowCount;
      const revisionBefore = (await ih.snapshot(bob.page)).committedRevision;
      await ih.selectCell(page, 1, 1);
      await page.keyboard.type('blocked');
      await page.keyboard.press('Enter');
      await ih.selectCell(page, 0, 1);
      await page.keyboard.press('Delete');
      await page.evaluate(() => {
        (window as unknown as { __gridInstance: { insertRows(o: { afterRowId: string | null }): void } }).__gridInstance.insertRows({ afterRowId: null });
      });
      await page.waitForTimeout(300);
      expect((await ih.snapshot(page)).rowCount).toBe(rowCountBefore);
      expect((await ih.snapshot(bob.page)).committedRevision).toBe(revisionBefore);
      expect(await ih.committedCell(page, target.rowId, target.columnId)).toBe(value);
      await page.screenshot({ path: evidencePath('dd056-2-readonly-switched.png') });

      // false で戻る。
      await setReadOnly(page, false);
      expect(await textareaReadOnly(page)).toBe(false);
      const after = `ro-off-${Date.now()}`;
      const second = await cellId(page, 1, 1);
      await ih.selectCell(page, 1, 1);
      await ih.plainTypeAndCommit(page, after);
      await expect.poll(() => ih.committedCell(bob.page, second.rowId, second.columnId), { timeout: 10_000 }).toBe(after);
    } finally {
      await alice.context.close();
      await bob.context.close();
    }
  });

  test('② オフラインで入力した未送信の操作は、setReadOnly(true) の後も保持され、再接続で届く（開き直さない）', async ({ browser }) => {
    const alice = await openClient(browser, 'Alice');
    const bob = await openClient(browser, 'Bob');
    try {
      const page = alice.page;
      const target = await cellId(page, 2, 1);
      const value = `offline-${Date.now()}`;
      await ih.simulateDrop(page);
      await expect.poll(async () => (await ih.snapshot(page)).online).toBe(false);
      await ih.selectCell(page, 2, 1);
      await ih.plainTypeAndCommit(page, value);
      await expect.poll(() => pendingCount(page)).toBeGreaterThanOrEqual(1);

      await setReadOnly(page, true);
      expect(await pendingCount(page)).toBeGreaterThanOrEqual(1); // 捨てられていない

      await ih.simulateReconnect(page);
      await expect.poll(() => ih.committedCell(bob.page, target.rowId, target.columnId), { timeout: 15_000 }).toBe(value);
      await expect.poll(() => pendingCount(page), { timeout: 10_000 }).toBe(0);
    } finally {
      await alice.context.close();
      await bob.context.close();
    }
  });

  test('③ 順序B の変換確定の直後に flush()・setReadOnly(true) → 確定値が送られる（最終 input が来なくても）', async ({ browser }) => {
    const alice = await openClient(browser, 'Alice');
    try {
      const page = alice.page;
      const first = await cellId(page, 3, 0);
      await ih.selectCell(page, 3, 0);
      const flushed = `夏季${Date.now() % 1000}`;
      await composeOpen(page, flushed);
      await composeEndOrderB(page, flushed);
      const s = await ih.snapshot(page);
      expect(s.isComposing).toBe(false);
      expect(s.editingTarget).not.toBeNull(); // 確定待ち（EditingAwaitFinalInput）に留まっている
      expect(await flush(page)).toEqual({ status: 'flushed' });
      expect(await ih.committedCell(page, first.rowId, first.columnId)).toBe(flushed);

      const second = await cellId(page, 4, 0);
      await ih.selectCell(page, 4, 0);
      const locked = `秋季${Date.now() % 1000}`;
      await composeOpen(page, locked);
      await composeEndOrderB(page, locked);
      await setReadOnly(page, true);
      await expect.poll(() => ih.committedCell(page, second.rowId, second.columnId), { timeout: 10_000 }).toBe(locked);
      expect(await textareaReadOnly(page)).toBe(true);
    } finally {
      await setReadOnly(alice.page, false).catch(() => {});
      await alice.context.close();
    }
  });

  test('④ 変換中の setReadOnly(true): 変換が終わるまで textarea に触れず、他の入口は止まり、終わった後に確定して読み取り専用になる', async ({ browser }) => {
    const alice = await openClient(browser, 'Alice');
    try {
      const page = alice.page;
      const target = await cellId(page, 0, 2);
      await ih.selectCell(page, 0, 2);
      const text = `冬季${Date.now() % 1000}`;
      await composeOpen(page, text);
      const rowCountBefore = (await ih.snapshot(page)).rowCount;
      await setReadOnly(page, true);
      expect((await ih.snapshot(page)).isComposing).toBe(true);
      expect(await textareaReadOnly(page)).toBe(false); // 変換中の textarea は触らない（I-3）
      await page.evaluate(() => {
        (window as unknown as { __gridInstance: { insertRows(o: { afterRowId: string | null }): void } }).__gridInstance.insertRows({ afterRowId: null });
      });
      expect((await ih.snapshot(page)).rowCount).toBe(rowCountBefore); // 他の入口はすぐ止まる

      await composeEndOrderB(page, text);
      await expect.poll(() => ih.committedCell(page, target.rowId, target.columnId), { timeout: 10_000 }).toBe(text);
      await expect.poll(() => textareaReadOnly(page)).toBe(true);
      expect((await ih.snapshot(page)).editingTarget).toBeNull();
    } finally {
      await setReadOnly(alice.page, false).catch(() => {});
      await alice.context.close();
    }
  });

  test('⑤ flush(): 送り切ると flushed、オフラインで上限を過ぎると timeout（pendingCount 付き）', async ({ browser }) => {
    const alice = await openClient(browser, 'Alice');
    try {
      const page = alice.page;
      expect(await flush(page)).toEqual({ status: 'flushed' }); // 送るものが無ければすぐ
      await ih.simulateDrop(page);
      await expect.poll(async () => (await ih.snapshot(page)).online).toBe(false);
      await ih.selectCell(page, 1, 2);
      await ih.plainTypeAndCommit(page, `pending-${Date.now()}`);
      const timedOut = await flush(page, 800);
      expect(timedOut.status).toBe('timeout');
      expect(timedOut.pendingCount).toBeGreaterThanOrEqual(1);
      expect(timedOut.editing).toBe(false);
      // 再接続してから flush すると送り切って flushed。
      await ih.simulateReconnect(page);
      expect(await flush(page, 15_000)).toEqual({ status: 'flushed' });
      expect(await pendingCount(page)).toBe(0);
    } finally {
      await alice.context.close();
    }
  });

  test('⑥ 既存不具合の修正: 順序B の確定直後に別セルをクリック → 元のセルへ確定して移る／グリッド外のクリック → 確定', async ({ browser }) => {
    const alice = await openClient(browser, 'Alice');
    try {
      const page = alice.page;
      const first = await cellId(page, 2, 2);
      await ih.selectCell(page, 2, 2);
      const clicked = `柿${Date.now() % 1000}`;
      await composeOpen(page, clicked);
      await composeEndOrderB(page, clicked);
      await ih.selectCell(page, 4, 2); // 別セルをクリック（修正前は確定も移動もしない）
      await expect.poll(() => ih.committedCell(page, first.rowId, first.columnId), { timeout: 10_000 }).toBe(clicked);
      await expect.poll(async () => (await ih.snapshot(page)).activeCell).toEqual({ row: 4, col: 2 });

      const second = await cellId(page, 3, 2);
      await ih.selectCell(page, 3, 2);
      const outside = `桃${Date.now() % 1000}`;
      await composeOpen(page, outside);
      await composeEndOrderB(page, outside);
      await page.locator('#int-status').click(); // グリッドの外（blur）
      await expect.poll(() => ih.committedCell(page, second.rowId, second.columnId), { timeout: 10_000 }).toBe(outside);
      expect((await ih.snapshot(page)).activeCell).toEqual({ row: 3, col: 2 }); // 移動しない
    } finally {
      await alice.context.close();
    }
  });
});
