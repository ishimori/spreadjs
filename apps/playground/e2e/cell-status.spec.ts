// DD-060 E2E: セルの状態表示（GridStandaloneRow.cellStatus）を単独グリッド（standalone.html・OFIC と同じモード）で確かめる。
//
//   ① setRows で付けた error/warning が枠＋薄い背景で描かれる（空のセルにも付く）。base canvas のピクセル走査（AC1）
//   ② cells だけの setRows では残り、{} で消える。状態だけの変更は Undo・cell-commit に触れない（AC2）
//   ③ コピー TSV・セルの値は変わらない（AC4）
//   ④ ホバーすると cell-hover に status が載り、ホバー中のセルの状態が変わると出し直す（AC3）
//   ⑤ 不正な level は診断 cell-status-invalid（AC7）
// 描画の細目（描く順・値の書式の背景との優先・固定 pane・DPR の丸め）は unit（base-layer.dd060.test.ts）が担保する。

import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { grantClipboard, readClipboard } from './integration-helpers';
import * as sa from './standalone-helpers';

/** base-layer の CELL_STATUS_COLORS と同じ。 */
const ERROR_FRAME: [number, number, number] = [0xd9, 0x30, 0x25];
const ERROR_BG: [number, number, number] = [0xfc, 0xe8, 0xe6];
const WARNING_FRAME: [number, number, number] = [0xe3, 0x74, 0x00];
const WARNING_BG: [number, number, number] = [0xfe, 0xf7, 0xe0];

interface StatusRow {
  rowId: string;
  cells?: Record<string, string>;
  cellStatus?: Record<string, { level: string; message?: string }>;
}

async function openStatus(page: Page, query = ''): Promise<void> {
  await page.goto(`/standalone.html${query === '' ? '' : `?${query}`}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
}

async function setRows(page: Page, rows: StatusRow[]): Promise<void> {
  await page.evaluate((r: StatusRow[]) => {
    (window as unknown as { __gridInstance?: { setRows(rows: StatusRow[]): void } }).__gridInstance?.setRows(r);
  }, rows);
}

/** base canvas の矩形（CSS px）の中で target 色（±tol）の画素数。 */
async function countColor(page: Page, rect: sa.CellRect, target: [number, number, number], tol = 6): Promise<number> {
  return page.evaluate(
    ({ r, t, tol }: { r: sa.CellRect; t: [number, number, number]; tol: number }) => {
      const canvas = document.querySelectorAll('.nsheet-stage canvas')[0];
      if (!(canvas instanceof HTMLCanvasElement)) {
        return 0;
      }
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        return 0;
      }
      const d = window.devicePixelRatio;
      const data = ctx.getImageData(
        Math.floor(r.x * d),
        Math.floor(r.y * d),
        Math.max(1, Math.floor(r.width * d)),
        Math.max(1, Math.floor(r.height * d)),
      ).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          data[i + 3]! > 0 &&
          Math.abs(data[i]! - t[0]) <= tol &&
          Math.abs(data[i + 1]! - t[1]) <= tol &&
          Math.abs(data[i + 2]! - t[2]) <= tol
        ) {
          count += 1;
        }
      }
      return count;
    },
    { r: rect, t: target, tol },
  );
}

async function lastHover(page: Page): Promise<Record<string, unknown> | undefined> {
  return (await sa.events(page)).filter((e) => e.type === 'cell-hover').at(-1) as Record<string, unknown> | undefined;
}

async function diagnosticCodes(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ((window as unknown as { __standalone?: { diagnostics: Array<{ code: string }> } }).__standalone?.diagnostics ?? []).map(
      (d) => d.code,
    ),
  );
}

test('setRows の cellStatus が枠＋薄い背景で描かれ、cells だけの更新では残り {} で消える。値・Undo・コピーは変わらない（AC1・AC2・AC4）', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await grantClipboard(context);
  const page = await context.newPage();
  try {
    await openStatus(page);
    const colB = (await sa.colIdAt(page, 1))!;
    const colC = (await sa.colIdAt(page, 2))!;
    await setRows(page, [{ rowId: 'r2', cells: { [colB]: '123456789' } }]);
    await sa.selectCell(page, 10, 0); // 選択枠を検査対象のセルから外す
    const undoBefore = await sa.undoDepth(page);
    const commitsBefore = (await sa.events(page)).filter((e) => e.type === 'cell-commit').length;

    await setRows(page, [
      { rowId: 'r2', cellStatus: { [colB]: { level: 'error', message: '8桁を超えています' } } },
      { rowId: 'r3', cellStatus: { [colC]: { level: 'warning', message: '空欄です' } } }, // 空のセル
    ]);
    const errorCell = (await sa.cellRectAt(page, 2, 1))!;
    const warningCell = (await sa.cellRectAt(page, 3, 2))!;
    const plainCell = (await sa.cellRectAt(page, 2, 2))!;

    // ① 枠＋背景（AC1）。枠は 2px なので周長ぶんの画素、背景はそれより広い面積。
    await expect.poll(async () => countColor(page, errorCell, ERROR_FRAME), { message: 'error の赤枠' }).toBeGreaterThan(100);
    expect(await countColor(page, errorCell, ERROR_BG), 'error の薄赤の背景').toBeGreaterThan(500);
    expect(await countColor(page, warningCell, WARNING_FRAME), '空のセルにも warning の橙枠').toBeGreaterThan(100);
    expect(await countColor(page, warningCell, WARNING_BG), 'warning の薄黄の背景').toBeGreaterThan(500);
    expect(await countColor(page, plainCell, ERROR_FRAME), '状態のないセルは塗らない').toBe(0);
    expect(await countColor(page, plainCell, WARNING_FRAME)).toBe(0);
    await page.screenshot({ path: evidencePath('cell-status.png') });

    // ② 状態だけの変更は Undo・cell-commit に触れない（AC2・AC4）。
    expect(await sa.undoDepth(page)).toBe(undoBefore);
    expect((await sa.events(page)).filter((e) => e.type === 'cell-commit')).toHaveLength(commitsBefore);
    expect(await sa.displayCell(page, 'r2', colB)).toBe('123456789');

    // ③ コピー TSV は値だけ（AC4）。
    await sa.selectCell(page, 2, 1);
    await page.keyboard.press('Control+c');
    await expect.poll(async () => readClipboard(page), { message: 'コピー TSV は値のまま' }).toBe('123456789');
    await sa.selectCell(page, 10, 0);

    // cells だけの setRows（OFIC の小計の差し替えと同じ形）では残る（AC2）。
    await setRows(page, [{ rowId: 'r2', cells: { 'col-a': '小計' } }]);
    await expect.poll(async () => sa.displayCell(page, 'r2', 'col-a')).toBe('小計');
    expect(await countColor(page, errorCell, ERROR_FRAME), 'cells だけの更新では状態が残る').toBeGreaterThan(100);

    // {} で消える（AC2）。
    await setRows(page, [{ rowId: 'r2', cellStatus: {} }]);
    await expect.poll(async () => countColor(page, errorCell, ERROR_FRAME), { message: '{} で消える' }).toBe(0);
    expect(await countColor(page, errorCell, ERROR_BG)).toBe(0);
    expect(await countColor(page, warningCell, WARNING_FRAME), '他の行の状態は残る').toBeGreaterThan(100);
  } finally {
    await context.close();
  }
});

test('ホバーすると cell-hover に status が載り、ホバー中のセルの状態が変わると出し直す（AC3）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await openStatus(page);
    const colB = (await sa.colIdAt(page, 1))!;
    const colC = (await sa.colIdAt(page, 2))!;
    await setRows(page, [{ rowId: 'r2', cellStatus: { [colB]: { level: 'error', message: '8桁を超えています' } } }]);
    const scrollerBox = (await page.locator('.nsheet-scroller').boundingBox())!;
    const centerOf = (rect: sa.CellRect) => ({ x: scrollerBox.x + rect.x + rect.width / 2, y: scrollerBox.y + rect.y + rect.height / 2 });

    const errorCenter = centerOf((await sa.cellRectAt(page, 2, 1))!);
    await page.mouse.move(errorCenter.x, errorCenter.y);
    await expect
      .poll(async () => lastHover(page))
      .toMatchObject({ rowId: 'r2', columnId: colB, status: { level: 'error', message: '8桁を超えています' } });

    // 状態のないセルでは status キー自体が無い。
    const plainCenter = centerOf((await sa.cellRectAt(page, 2, 2))!);
    await page.mouse.move(plainCenter.x, plainCenter.y);
    await expect.poll(async () => (await lastHover(page))?.columnId).toBe(colC);
    expect(await lastHover(page)).not.toHaveProperty('status');

    // ポインタを動かさずに、ホバー中のセルへ状態を付ける → 同じセルのまま出し直す。
    const hoversBefore = (await sa.events(page)).filter((e) => e.type === 'cell-hover').length;
    await setRows(page, [{ rowId: 'r2', cellStatus: { [colB]: { level: 'error', message: '8桁を超えています' }, [colC]: { level: 'warning', message: '確認してください' } } }]);
    await expect
      .poll(async () => lastHover(page))
      .toMatchObject({ rowId: 'r2', columnId: colC, status: { level: 'warning', message: '確認してください' } });
    expect((await sa.events(page)).filter((e) => e.type === 'cell-hover')).toHaveLength(hoversBefore + 1);

    // 同じ状態での setRows では出し直さない。
    await setRows(page, [{ rowId: 'r2', cellStatus: { [colB]: { level: 'error', message: '8桁を超えています' }, [colC]: { level: 'warning', message: '確認してください' } } }]);
    await page.waitForTimeout(100);
    expect((await sa.events(page)).filter((e) => e.type === 'cell-hover')).toHaveLength(hoversBefore + 1);

    // 消すと status の無い cell-hover を出し直す。
    await setRows(page, [{ rowId: 'r2', cellStatus: {} }]);
    await expect.poll(async () => (await sa.events(page)).filter((e) => e.type === 'cell-hover').length).toBe(hoversBefore + 2);
    expect(await lastHover(page)).toMatchObject({ rowId: 'r2', columnId: colC });
    expect(await lastHover(page)).not.toHaveProperty('status');
  } finally {
    await context.close();
  }
});

test('太い指定罫線（8px）に囲まれたセルでも、枠が罫線の内側に見える（Codex P2）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await openStatus(
      page,
      new URLSearchParams({
        rowborder: 'r2:top:8:000000;r2:bottom:8:000000',
        colborder: 'col-b:left:8:000000;col-b:right:8:000000',
      }).toString(),
    );
    const colB = (await sa.colIdAt(page, 1))!;
    await sa.selectCell(page, 10, 0);
    await setRows(page, [{ rowId: 'r2', cellStatus: { [colB]: { level: 'error' } } }]);
    const cell = (await sa.cellRectAt(page, 2, 1))!;
    await expect.poll(async () => countColor(page, cell, ERROR_FRAME), { message: '罫線に上書きされず赤枠が残る' }).toBeGreaterThan(100);
    expect(await countColor(page, cell, ERROR_BG)).toBeGreaterThan(100);
  } finally {
    await context.close();
  }
});

test('level が不正なセルは無視され、診断 cell-status-invalid が出る（AC7）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await openStatus(page);
    const colB = (await sa.colIdAt(page, 1))!;
    await sa.selectCell(page, 10, 0);
    await setRows(page, [{ rowId: 'r2', cellStatus: { [colB]: { level: 'info' }, 'col-unknown': { level: 'error' } } }]);
    await expect.poll(async () => diagnosticCodes(page)).toContain('cell-status-invalid');
    const cell = (await sa.cellRectAt(page, 2, 1))!;
    expect(await countColor(page, cell, ERROR_FRAME)).toBe(0);
    expect(await countColor(page, cell, WARNING_FRAME)).toBe(0);
  } finally {
    await context.close();
  }
});

/** 証跡（スクショ）の保存先絶対パス（test-results/dd-evidence/DD-060/ 直下）。 */
function evidencePath(fileName: string): string {
  return fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-060/${fileName}`, import.meta.url));
}
