// DD-056-2 E2E: React Facade の readOnly prop は、値が変わっても開き直さずに grid の setReadOnly へ写る（AC7）。
//
// 対象は react-standalone.html（<NanairoSheetView mode="standalone"> を StrictMode 下で mount）。GridInstance は Facade が隠蔽するため
// 公開契約で確かめる: 開き直していないことは常駐 textarea の DOM ノードが同じであること（目印の属性が残る）、編集中の値の確定は
// onCellCommit、読み取り専用は textarea の readOnly 属性と「印字して Enter しても確定されない」こと。ref handle の pendingCount・flush も
// 単独モードの値（0・flushed）で直結を確かめる（共同編集の未送信の保持は readonly-switch-flush.spec.ts が見る）。

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { R0_COL_A, commitCount, lastCommit, openReactStandalone } from './react-facade-helpers';

async function textareaState(page: Page): Promise<{ readOnly: boolean; marked: boolean; count: number }> {
  return page.evaluate(() => {
    const all = document.querySelectorAll('#react-root textarea.int-cell-editor');
    const ta = all[0];
    return {
      readOnly: ta instanceof HTMLTextAreaElement ? ta.readOnly : false,
      marked: ta?.getAttribute('data-dd056-marker') === 'same-node',
      count: all.length,
    };
  });
}

test('readOnly prop を変えても開き直さず、編集中の値を確定してから読み取り専用になる。false で戻る', async ({ browser }) => {
  const { context, page } = await openReactStandalone(browser);
  try {
    await page.locator('#react-root textarea.int-cell-editor').evaluate((el) => {
      el.setAttribute('data-dd056-marker', 'same-node'); // 開き直したら消える目印
    });
    const scroller = page.locator('#react-root .nsheet-scroller');
    await scroller.click({ position: { x: R0_COL_A.x, y: R0_COL_A.y } });
    const before = await commitCount(page);
    await page.keyboard.type('draft'); // Enter せず編集中のまま

    await page.evaluate(() => window.__reactStandalone?.setReadOnlyProp(true));
    await expect.poll(() => commitCount(page)).toBe(before + 1); // 編集中の値が確定された
    expect((await lastCommit(page))?.[0]).toMatchObject({ columnId: 'col-a', value: 'draft' });
    await expect.poll(async () => (await textareaState(page)).readOnly).toBe(true);
    expect(await textareaState(page)).toMatchObject({ marked: true, count: 1 }); // 同じ textarea＝開き直していない

    // 読み取り専用の間は印字・Enter で確定されない。
    await scroller.click({ position: { x: R0_COL_A.x, y: R0_COL_A.y + 22 } });
    await page.keyboard.type('blocked');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    expect(await commitCount(page)).toBe(before + 1);

    // handle の pendingCount・flush は grid へ直結（単独モードは 0・flushed）。
    expect(await page.evaluate(() => window.__reactStandalone?.pendingCount())).toBe(0);
    expect(await page.evaluate(() => window.__reactStandalone?.flush())).toEqual({ status: 'flushed' });

    // false で戻る（開き直さない）。
    await page.evaluate(() => window.__reactStandalone?.setReadOnlyProp(false));
    await expect.poll(async () => (await textareaState(page)).readOnly).toBe(false);
    expect((await textareaState(page)).marked).toBe(true);
    await scroller.click({ position: { x: R0_COL_A.x, y: R0_COL_A.y + 22 } });
    await page.keyboard.type('again');
    await page.keyboard.press('Enter');
    await expect.poll(() => commitCount(page)).toBe(before + 2);
    expect((await lastCommit(page))?.[0]).toMatchObject({ value: 'again' });
  } finally {
    await context.close();
  }
});
