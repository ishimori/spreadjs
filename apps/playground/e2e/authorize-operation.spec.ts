// DD-056-1 E2E: 操作ごとの書込の認可（server-hono authorizeOperation・広島空港 H11）を実ブラウザー 2 つで確認する。
//
// 専用 WS サーバー（packages/server-hono の `dev:authorize`。consumer の「書込禁止中の文書」集合を authorizeOperation で引き、
// 別ポートの制御口 POST /lock・/unlock で切り替える）へ playground 統合ページを 2 つ繋ぎ:
//   ① 禁止中に Alice が入力 → Alice の画面だけが元に戻り、rejected（code: permission-denied）が届く。Bob の画面は変わらない（AC1）
//   ② 禁止を解くと Alice・Bob とも入力でき、互いに見える（拒否で消費した clientSequence の次の操作も受理される・AC3）
// を検証する。処理順（冪等・clientSequence・baseRevision との前後）・fail-closed・再入の禁止はユニット
// （packages/server/src/sequencer.test.ts・packages/server-hono/src/serve.authorize.test.ts）が担保する。

import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

import * as ih from './integration-helpers';

test.describe.configure({ mode: 'serial' });

/** 認可フック E2E 用サーバー origin と制御口（playwright.config.ts の AUTHORIZE_WS_PORT・AUTHORIZE_CONTROL_PORT と一致させること）。 */
const WS_ORIGIN_AUTHORIZE = 'http://127.0.0.1:8803';
const CONTROL_ORIGIN = 'http://127.0.0.1:8804';

function evidencePath(fileName: string): string {
  return fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-056/${fileName}`, import.meta.url));
}

/** 統合ページを認可フック E2E 用サーバーへ繋ぎ、boot（常駐 textarea＋ready）まで待つ。 */
async function openAuthorizeClient(browser: Browser, name: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/poc-integration.html?name=${encodeURIComponent(name)}&server=${encodeURIComponent(WS_ORIGIN_AUTHORIZE)}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await expect
    .poll(async () => (await ih.snapshot(page)).ready, { timeout: 30_000, message: `${name} が ready にならない` })
    .toBe(true);
  expect((await ih.snapshot(page)).online, `${name} online`).toBe(true);
  return { context, page };
}

async function setLocked(request: APIRequestContext, locked: boolean): Promise<void> {
  const response = await request.post(`${CONTROL_ORIGIN}/${locked ? 'lock' : 'unlock'}`);
  expect(response.ok(), `control ${locked ? 'lock' : 'unlock'}`).toBe(true);
}

/** 統合ページが記録した GridEvent のうち rejected の公開コード（window.__gridEvents・main.ts）。 */
async function rejectedCodes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const events = (window as unknown as { __gridEvents?: Array<{ type: string; conflict?: { code: string } }> }).__gridEvents ?? [];
    return events.filter((event) => event.type === 'rejected').map((event) => event.conflict?.code ?? '');
  });
}

test.describe('DD-056 H11 操作ごとの書込の認可（authorizeOperation）', () => {
  test('禁止中の入力は送った側だけ元に戻り permission-denied が届く。禁止を解くと両者とも入力できる', async ({ browser, request }) => {
    await setLocked(request, false);
    const alice = await openAuthorizeClient(browser, 'Alice');
    const bob = await openAuthorizeClient(browser, 'Bob');
    try {
      const rowId = await ih.rowIdAt(alice.page, 0);
      const nextRowId = await ih.rowIdAt(alice.page, 1);
      const columnId = await ih.colIdAt(alice.page, 0);
      expect(rowId).toBeDefined();
      expect(nextRowId).toBeDefined();
      expect(columnId).toBeDefined();
      // サーバーは spec をまたいで同じ文書を保つ（reuseExistingServer）ため、値は実行ごとに一意にし、比較は「直前の値」との差で見る。
      const before = await ih.committedCell(alice.page, rowId!, columnId!);
      const revisionBefore = (await ih.snapshot(bob.page)).committedRevision;

      // ① 禁止中に Alice が入力する。
      await setLocked(request, true);
      const denied = `denied-${Date.now()}`;
      await ih.selectCell(alice.page, 0, 0);
      await ih.plainTypeAndCommit(alice.page, denied);
      await expect.poll(() => rejectedCodes(alice.page), { timeout: 10_000 }).toContain('permission-denied');
      await expect.poll(() => ih.displayCell(alice.page, rowId!, columnId!), { timeout: 10_000 }).toBe(before); // 巻き戻し
      expect(await ih.committedCell(alice.page, rowId!, columnId!)).toBe(before);
      expect((await ih.snapshot(alice.page)).pendingCount).toBe(0);
      expect(await ih.committedCell(bob.page, rowId!, columnId!)).toBe(before); // Bob には届かない
      expect((await ih.snapshot(bob.page)).committedRevision).toBe(revisionBefore);
      await alice.page.screenshot({ path: evidencePath('dd056-1-alice-denied.png') });

      // ② 禁止を解くと、Alice の次の操作（拒否で消費した clientSequence の次）が受理され、Bob にも見える。
      await setLocked(request, false);
      const allowed = `allowed-${Date.now()}`;
      await ih.selectCell(alice.page, 0, 0);
      await ih.plainTypeAndCommit(alice.page, allowed);
      await expect.poll(() => ih.committedCell(bob.page, rowId!, columnId!), { timeout: 10_000 }).toBe(allowed);
      const fromBob = `bob-${Date.now()}`;
      await ih.selectCell(bob.page, 1, 0);
      await ih.plainTypeAndCommit(bob.page, fromBob);
      await expect.poll(() => ih.committedCell(alice.page, nextRowId!, columnId!), { timeout: 10_000 }).toBe(fromBob);
      expect(await rejectedCodes(alice.page)).toEqual(['permission-denied']); // 拒否は禁止中の 1 回だけ（ループなし）
    } finally {
      await setLocked(request, false);
      await alice.context.close();
      await bob.context.close();
    }
  });
});
