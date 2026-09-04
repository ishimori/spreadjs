// DD-043 E2E: 複数文書 serve（1 プロセス・N 枚固定・ADR-0025）を実ブラウザーで確認する。
//
// 専用 WS サーバー（packages/server-hono の `dev:multi-document`・doc-a / doc-b を 1 プロセスで serve）へ、
// playground 統合ページを `?doc=<documentId>` で繋いで:
//   ① 文書ごとに違う列構成が /config?documentId= 経由で解決される（AC4 の /config 側）
//   ② 一方の文書の編集が他方へ漏れない（AC1・操作の独立）
//   ③ serve していない documentId は接続できず config error になる（AC4 の拒否側）
// を検証する。サーバー内部の収束・検疫・presence 分離はユニット（serve.documents.test.ts）が担保し、
// ここは「consumer が文書を名乗って正しい board に繋がる」配線の成立に集中する。

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import * as ih from './integration-helpers';

test.describe.configure({ mode: 'serial' });

/** 複数文書 E2E 用サーバー origin（playwright.config.ts の MULTI_DOC_WS_PORT と一致させること）。 */
const WS_ORIGIN_MULTI = 'http://127.0.0.1:8801';

/** 統合ページを `?doc=<documentId>` で開き、boot（常駐 textarea＋ready）まで待つ。 */
async function openDocument(
  browser: Browser,
  name: string,
  documentId: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(
    `/poc-integration.html?name=${encodeURIComponent(name)}&server=${encodeURIComponent(WS_ORIGIN_MULTI)}&doc=${encodeURIComponent(documentId)}`,
  );
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await expect
    .poll(async () => (await ih.snapshot(page)).ready, { timeout: 30_000, message: `${name} が ready にならない` })
    .toBe(true);
  return { context, page };
}

test.describe('DD-043 複数文書 serve（1 プロセス・年度別 board）', () => {
  test('文書ごとの列構成で繋がり、片方の編集が他方へ漏れない', async ({ browser }) => {
    const a = await openDocument(browser, 'Alice', 'doc-a');
    const b = await openDocument(browser, 'Bob', 'doc-b');
    try {
      // ① /config?documentId= が文書ごとの列順を返している（列 ID が board ごとに違う）。
      expect(await ih.colIdAt(a.page, 0)).toBe('col-a');
      expect(await ih.colIdAt(b.page, 0)).toBe('2026-04-01');

      const beforeA = await ih.snapshot(a.page);
      const beforeB = await ih.snapshot(b.page);
      expect(beforeA.online).toBe(true);
      expect(beforeB.online).toBe(true);

      // ② doc-a だけを編集する。
      const rowId = await ih.rowIdAt(a.page, 0);
      expect(rowId).toBeDefined();
      await ih.selectCell(a.page, 0, 0);
      await ih.plainTypeAndCommit(a.page, 'A面');
      await expect
        .poll(async () => ih.committedCell(a.page, rowId!, 'col-a'), { timeout: 10_000 })
        .toBe('A面');

      // doc-b は revision も内容も動かない（文書間の漏れゼロ）。
      // 「最初のサンプルで一致したら終わり」の poll では遅れて届くフレームを見逃すため、
      // 一定時間サンプリングし続けて**その間ずっと不変**であることを確認する。
      const bRowId = await ih.rowIdAt(b.page, 0);
      expect(bRowId).toBeDefined();
      for (let i = 0; i < 6; i += 1) {
        await b.page.waitForTimeout(250);
        const s = await ih.snapshot(b.page);
        expect(s.committedRevision, `doc-b の revision が動いた（${i}）`).toBe(beforeB.committedRevision);
        expect(s.committedHash, `doc-b の hash が動いた（${i}）`).toBe(beforeB.committedHash);
        expect(await ih.committedCell(b.page, bRowId!, '2026-04-01')).toBe('');
      }

      // ③ doc-b 側の編集は doc-a へ漏れない（逆方向も確認）。
      const aHashAfterEdit = (await ih.snapshot(a.page)).committedHash;
      await ih.selectCell(b.page, 0, 0);
      await ih.plainTypeAndCommit(b.page, 'B面');
      await expect
        .poll(async () => ih.committedCell(b.page, bRowId!, '2026-04-01'), { timeout: 10_000 })
        .toBe('B面');
      for (let i = 0; i < 6; i += 1) {
        await a.page.waitForTimeout(250);
        expect((await ih.snapshot(a.page)).committedHash, `doc-a の hash が動いた（${i}）`).toBe(aHashAfterEdit);
      }
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test('serve していない documentId は config error で止まる（未知 ID の拒否）', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      await page.goto(
        `/poc-integration.html?name=Zoe&server=${encodeURIComponent(WS_ORIGIN_MULTI)}&doc=doc-does-not-exist`,
      );
      // /config?documentId=doc-does-not-exist が 404 → boot は config phase のエラーで止まる（WS も張らない）。
      await expect(page.locator('#int-status')).toContainText('起動/接続エラー[config]', { timeout: 15_000 });
      const events = await page.evaluate(() =>
        (window as unknown as { __gridEvents?: Array<{ type: string; phase?: string; code?: string }> }).__gridEvents ??
        [],
      );
      const configError = events.find((e) => e.type === 'error' && e.phase === 'config');
      expect(configError?.code).toBe('config-unavailable');
    } finally {
      await context.close();
    }
  });
});
