// DD-062 E2E: 共同編集モードのセルの状態表示（GridInstance.setCellStatus）。2 クライアントで、付けたクライアントにだけ
// 描かれ（view-local）、サーバー・他の参加者へは何も送られないこと、ホバーの cell-hover に status が載ることを確かめる。

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { cellRectAt, colIdAt, openClient, rowIdAt, selectCell } from './integration-helpers';
import type { CellRect } from './integration-helpers';

/** base-layer の CELL_STATUS_COLORS.error.frame と同じ。 */
const ERROR_FRAME: [number, number, number] = [0xd9, 0x30, 0x25];

interface GridEventLike {
  type: string;
  rowId?: string | null;
  columnId?: string | null;
  status?: { level: string; message?: string };
}

async function countColor(page: Page, rect: CellRect, target: [number, number, number], tol = 6): Promise<number> {
  return page.evaluate(
    ({ r, t, tol }: { r: CellRect; t: [number, number, number]; tol: number }) => {
      const canvas = document.querySelectorAll('.nsheet-stage canvas')[0];
      if (!(canvas instanceof HTMLCanvasElement)) {
        return 0;
      }
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        return 0;
      }
      const d = window.devicePixelRatio;
      const data = ctx.getImageData(Math.floor(r.x * d), Math.floor(r.y * d), Math.max(1, Math.floor(r.width * d)), Math.max(1, Math.floor(r.height * d))).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3]! > 0 && Math.abs(data[i]! - t[0]) <= tol && Math.abs(data[i + 1]! - t[1]) <= tol && Math.abs(data[i + 2]! - t[2]) <= tol) {
          count += 1;
        }
      }
      return count;
    },
    { r: rect, t: target, tol },
  );
}

async function events(page: Page): Promise<GridEventLike[]> {
  return page.evaluate(() => ((window as unknown as { __gridEvents?: GridEventLike[] }).__gridEvents ?? []).slice());
}

test('DD-062: 共同編集モードの setCellStatus は付けたクライアントにだけ描かれ、サーバーへは送られない。ホバーに status が載る', async ({ browser }) => {
  const a = await openClient(browser, 'A');
  const b = await openClient(browser, 'B');
  try {
    const rowId = (await rowIdAt(a.page, 3))!;
    const colId = (await colIdAt(a.page, 1))!;
    expect(await rowIdAt(b.page, 3)).toBe(rowId);
    await selectCell(a.page, 8, 0);
    await selectCell(b.page, 8, 0);
    const remoteBefore = (await events(b.page)).filter((e) => e.type === 'remote-change').length;
    const pendingBefore = (await events(a.page)).filter((e) => e.type === 'pending').length;

    await a.page.evaluate(
      ({ rowId, colId }) =>
        (window as unknown as { __gridInstance?: { setCellStatus(rows: unknown): void } }).__gridInstance?.setCellStatus([
          { rowId, cellStatus: { [colId]: { level: 'error', message: '共同編集でも付く' } } },
        ]),
      { rowId, colId },
    );
    const rectA = (await cellRectAt(a.page, 3, 1))!;
    await expect.poll(async () => countColor(a.page, rectA, ERROR_FRAME), { message: 'A に赤枠' }).toBeGreaterThan(100);
    await a.page.waitForTimeout(300);
    expect(await countColor(b.page, (await cellRectAt(b.page, 3, 1))!, ERROR_FRAME), 'B には出ない（view-local）').toBe(0);
    expect((await events(b.page)).filter((e) => e.type === 'remote-change'), 'B へ変更が届かない').toHaveLength(remoteBefore);
    expect((await events(a.page)).filter((e) => e.type === 'pending'), 'A は送信しない').toHaveLength(pendingBefore);

    // ホバーで status が載る。
    const box = (await a.page.locator('.nsheet-scroller').boundingBox())!;
    await a.page.mouse.move(box.x + rectA.x + rectA.width / 2, box.y + rectA.y + rectA.height / 2);
    await expect
      .poll(async () => (await events(a.page)).filter((e) => e.type === 'cell-hover').at(-1))
      .toMatchObject({ rowId, columnId: colId, status: { level: 'error', message: '共同編集でも付く' } });
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
