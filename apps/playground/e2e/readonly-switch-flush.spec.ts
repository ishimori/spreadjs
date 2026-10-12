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
//   ⑦〜⑪ Codex 実装レビュー（2 回目）の指摘の回帰: 変換の終わり待ちで送るのは切り替え時の編集 1 件だけ（⑦）・候補欄を閉じて
//   入力を失わない（⑧）・flush は呼んだ時点の編集だけを確定する（⑨）・既定の cut を止める（⑩）・接続の終端後は確定しない（⑪）。
//   いずれも判定の macrotask より先に同じタスクで synthetic イベントを流す（実際の打鍵より速い順序で関所の穴を突く）。
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

async function openClient(browser: Browser, name: string, extraQuery = ''): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/poc-integration.html?name=${encodeURIComponent(name)}&server=${encodeURIComponent(WS_ORIGIN)}${extraQuery}`);
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

  test('⑦ 変換中の setReadOnly(true) の後、判定より先に確定して次のセルへ入力しても、送るのは切り替え時の編集だけ', async ({ browser }) => {
    const alice = await openClient(browser, 'Alice');
    try {
      const page = alice.page;
      const first = await cellId(page, 0, 0);
      const next = await cellId(page, 1, 0);
      const nextBefore = await ih.committedCell(page, next.rowId, next.columnId);
      await ih.selectCell(page, 0, 0);
      const text = `春季${Date.now() % 1000}`;
      const intruder = `after-lock-${Date.now()}`;
      await composeOpen(page, text);
      // 同じタスクで: 切り替え → 変換確定（順序A）→ Enter で確定して下へ → 次のセルへ入力 → Enter。
      await page.evaluate(
        ({ data, typed }: { data: string; typed: string }) => {
          const ta = document.querySelector('textarea.int-cell-editor') as HTMLTextAreaElement;
          (window as unknown as { __gridInstance: { setReadOnly(v: boolean): void } }).__gridInstance.setReadOnly(true);
          ta.dispatchEvent(new CompositionEvent('compositionend', { data, bubbles: true }));
          ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data, isComposing: false, bubbles: true }));
          ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
          ta.value = typed;
          ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: typed, isComposing: false, bubbles: true }));
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        },
        { data: text, typed: intruder },
      );
      await expect.poll(() => ih.committedCell(page, first.rowId, first.columnId), { timeout: 10_000 }).toBe(text);
      await expect.poll(() => textareaReadOnly(page)).toBe(true);
      await page.waitForTimeout(300);
      expect(await ih.committedCell(page, next.rowId, next.columnId)).toBe(nextBefore); // 次のセルの入力は確定されない
      expect((await ih.snapshot(page)).editingTarget).toBeNull(); // 新しい編集も始まっていない
    } finally {
      await setReadOnly(alice.page, false).catch(() => {});
      await alice.context.close();
    }
  });

  test('⑧ 変換中の setReadOnly(true) は候補欄を閉じ、変換の後に候補をクリックしても編集中の値を失わない', async ({ browser }) => {
    const stamp = Date.now() % 1000;
    const text = `冬季${stamp}`; // 候補の前方一致で候補欄が出る（自由入力併存列なので候補外の値もそのまま確定できる）
    // 選択式にする列の ID を先に読む（未知の列を指定すると config error で mount しない）。
    const probe = await openClient(browser, 'Probe');
    const columnId = await ih.colIdAt(probe.page, 2);
    await probe.context.close();
    if (columnId === undefined) {
      throw new Error('列 2 が無い');
    }
    const select = encodeURIComponent(`${columnId}:${text}A|${text}B!free`);
    const alice = await openClient(browser, 'Alice', `&select=${select}`);
    try {
      const page = alice.page;
      const target = await cellId(page, 1, 2);
      await ih.selectCell(page, 1, 2);
      await composeOpen(page, text);
      await expect.poll(() => ih.selectOpen(page), { message: '変換中に候補欄が出る' }).toBe(true);
      // 同じタスクで: 切り替え → 変換確定（順序B）→ 候補の pointerdown（判定の macrotask より先）。
      await page.evaluate(
        ({ data, option }: { data: string; option: string }) => {
          const ta = document.querySelector('textarea.int-cell-editor') as HTMLTextAreaElement;
          (window as unknown as { __gridInstance: { setReadOnly(v: boolean): void } }).__gridInstance.setReadOnly(true);
          ta.dispatchEvent(new CompositionEvent('compositionend', { data, bubbles: true }));
          ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
          document
            .querySelector(`.ns-select-option[data-value="${option}"]`)
            ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        },
        { data: text, option: `${text}A` },
      );
      await expect.poll(() => ih.committedCell(page, target.rowId, target.columnId), { timeout: 10_000 }).toBe(text);
      await expect.poll(() => textareaReadOnly(page)).toBe(true);
      expect(await ih.selectOpen(page)).toBe(false);
    } finally {
      await setReadOnly(alice.page, false).catch(() => {});
      await alice.context.close();
    }
  });

  test('⑨ 変換中に呼んだ flush() は同じ編集を確定するが、その編集を取り消した後に始めた別のセルの編集は確定しない', async ({ browser }) => {
    const alice = await openClient(browser, 'Alice');
    try {
      const page = alice.page;
      // 対照: 変換中に flush() → 変換を確定 → 同じ編集が確定されて flushed。
      const kept = await cellId(page, 2, 0);
      await ih.selectCell(page, 2, 0);
      const keptText = `梅${Date.now() % 1000}`;
      await composeOpen(page, keptText);
      await page.evaluate(() => {
        const w = window as unknown as { __gridInstance: { flush(o?: { timeoutMs?: number }): Promise<unknown> }; __dd056Flush?: Promise<unknown> };
        w.__dd056Flush = w.__gridInstance.flush({ timeoutMs: 10_000 });
      });
      await composeEndOrderB(page, keptText);
      expect(await page.evaluate(() => (window as unknown as { __dd056Flush: Promise<unknown> }).__dd056Flush)).toEqual({ status: 'flushed' });
      expect(await ih.committedCell(page, kept.rowId, kept.columnId)).toBe(keptText);

      // 本題: 変換中に flush() → 同じタスクで変換確定 → Escape で取り消し → 下のセルで新しい編集を始める。
      const cancelled = await cellId(page, 3, 1);
      const other = await cellId(page, 4, 1);
      const cancelledBefore = await ih.committedCell(page, cancelled.rowId, cancelled.columnId);
      const otherBefore = await ih.committedCell(page, other.rowId, other.columnId);
      await ih.selectCell(page, 3, 1);
      const text = `桜${Date.now() % 1000}`;
      const typed = `other-${Date.now()}`;
      await composeOpen(page, text);
      await page.evaluate(
        ({ data, value }: { data: string; value: string }) => {
          const w = window as unknown as { __gridInstance: { flush(o?: { timeoutMs?: number }): Promise<unknown> }; __dd056Flush?: Promise<unknown> };
          const ta = document.querySelector('textarea.int-cell-editor') as HTMLTextAreaElement;
          w.__dd056Flush = w.__gridInstance.flush({ timeoutMs: 10_000 });
          ta.dispatchEvent(new CompositionEvent('compositionend', { data, bubbles: true }));
          ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data, isComposing: false, bubbles: true }));
          ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true }));
          ta.value = value;
          ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: value, isComposing: false, bubbles: true }));
        },
        { data: text, value: typed },
      );
      expect(await page.evaluate(() => (window as unknown as { __dd056Flush: Promise<unknown> }).__dd056Flush)).toEqual({ status: 'flushed' });
      const s = await ih.snapshot(page);
      expect(s.editingTarget).toEqual(other); // 後から始めた編集は確定されず、編集中のまま
      expect(s.draft).toBe(typed);
      await page.waitForTimeout(300);
      expect(await ih.committedCell(page, other.rowId, other.columnId)).toBe(otherBefore);
      expect(await ih.committedCell(page, cancelled.rowId, cancelled.columnId)).toBe(cancelledBefore); // 取り消した編集も送られない
      await page.keyboard.press('Escape'); // 後片付け
    } finally {
      await alice.context.close();
    }
  });

  test('⑩ 変換の終わり待ちの間は textarea の既定の cut も止め、変換の後に確定して読み取り専用になる', async ({ browser }) => {
    const alice = await openClient(browser, 'Alice');
    try {
      const page = alice.page;
      const target = await cellId(page, 4, 0);
      await ih.selectCell(page, 4, 0);
      const text = `蓮${Date.now() % 1000}`;
      await composeOpen(page, text);
      await setReadOnly(page, true);
      const prevented = await page.evaluate(() => {
        const ta = document.querySelector('textarea.int-cell-editor') as HTMLTextAreaElement;
        const event = new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
        ta.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(prevented, '終わり待ちの cut は既定動作を止める（readOnly 属性の代わり）').toBe(true);
      expect(await textareaReadOnly(page)).toBe(false); // 変換中の textarea の属性は触らない（I-3）
      await composeEndOrderB(page, text);
      await expect.poll(() => ih.committedCell(page, target.rowId, target.columnId), { timeout: 10_000 }).toBe(text);
      await expect.poll(() => textareaReadOnly(page)).toBe(true);
    } finally {
      await setReadOnly(alice.page, false).catch(() => {});
      await alice.context.close();
    }
  });

  test('⑪ 接続の終端（stopped）の後の flush()・setReadOnly(true) は編集を確定せず、reject も未捕捉の例外も出さない', async ({ browser }) => {
    const alice = await openClient(browser, 'Alice');
    const pageErrors: string[] = [];
    alice.page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });
    try {
      const page = alice.page;
      await ih.simulateDrop(page);
      await expect.poll(async () => (await ih.snapshot(page)).online).toBe(false);
      // 切断中の未送信の上限（100 件）を超えさせて stopped にする（行の挿入は 1 回で 1 操作。サーバーへは届かない）。
      // 末尾の行の後ろへ足す（先頭へ足すと表示中の行がずれてスクロール位置が動く）。
      const lastRowId = await ih.rowIdAt(page, 4);
      await page.evaluate((afterRowId) => {
        const inst = (window as unknown as { __gridInstance: { insertRows(o: { afterRowId: string | null }): void } }).__gridInstance;
        for (let i = 0; i < 101; i += 1) {
          inst.insertRows({ afterRowId: afterRowId ?? null });
        }
      }, lastRowId);
      await expect.poll(() => ih.connectionState(page)).toBe('stopped');

      // flush(): 編集中のセルを確定しようとせず（確定先が throw する）、stopped を返す。編集は残す。
      await ih.selectCell(page, 0, 1);
      await page.keyboard.type('stopped-edit');
      const result = await flush(page, 2_000);
      expect(result.status).toBe('stopped');
      expect(result.pendingCount).toBeGreaterThanOrEqual(101);
      expect((await ih.snapshot(page)).editingTarget).not.toBeNull();

      // setReadOnly(true)（変換していない編集）: 確定せずに読み取り専用へ切り替わる（throw しない）。
      await setReadOnly(page, true);
      expect(await textareaReadOnly(page)).toBe(true);
      await setReadOnly(page, false);
      await page.keyboard.press('Escape');

      // 変換中の setReadOnly(true): 変換の後の判定（macrotask）でも確定せず、未捕捉の例外を出さない。
      await ih.selectCell(page, 1, 1);
      const text = `霧${Date.now() % 1000}`;
      await composeOpen(page, text);
      await setReadOnly(page, true);
      await composeEndOrderB(page, text);
      await expect.poll(() => textareaReadOnly(page)).toBe(true);
      await page.waitForTimeout(200);
      expect(pageErrors).toEqual([]);
    } finally {
      await alice.context.close();
    }
  });
});
