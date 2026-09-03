// DD-027-3 E2E: セル書式モデル（背景色・バッジ・非該当セル不変・選択式併用）。
//
// 書式は URL パラメータ `?format=`（?select=/?link= と同方式・main.ts）で宣言する。値と装飾は Canvas に描かれるため、
// base canvas のピクセルを走査して背景色/バッジ色の有無を確認し、view 状態（committedCell 等）は expect.poll で
// ゲートする（DD-021 教訓）。書式コンパイルの裁定細目は unit（format-rules.test.ts）が担保し、ここでは
// 「実ブラウザーで書式が描画され、非該当セルは現行描画のまま」を確認する。
//
// 書式構文（main.ts の parseColumnFormats）:
//   ?format=<列>:<ルール>;<ルール>,<列>:...  ／ ルール=<match|match>=<style+style>
//   style トークン: bg#RRGGBB（背景）・fg#RRGGBB（文字色）・badge（フラグ）・bc#RRGGBB（バッジ色）。

import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  cellRectAt,
  colIdAt,
  committedCell,
  dispatchSyntheticPaste,
  openClient,
  rowIdAt,
  selectCell,
  selectOpen,
  snapshot,
  WS_ORIGIN,
} from './integration-helpers';
import type { CellRect } from './integration-helpers';

test.describe.configure({ mode: 'serial' });

/** 対象セルへ値を注入する（空セルへ selectCell→paste。paste は editor validator を通らず素通し）。 */
async function seedCell(page: Page, row: number, col: number, value: string): Promise<{ rowId: string; columnId: string }> {
  const rowId = (await rowIdAt(page, row))!;
  const columnId = (await colIdAt(page, col))!;
  await selectCell(page, row, col);
  const consumed = await dispatchSyntheticPaste(page, value);
  expect(consumed).toBe(true);
  await expect.poll(async () => committedCell(page, rowId, columnId), { message: `値注入 ${value}` }).toBe(value);
  return { rowId, columnId };
}

async function clearCell(page: Page, row: number, col: number): Promise<void> {
  const rowId = (await rowIdAt(page, row))!;
  const columnId = (await colIdAt(page, col))!;
  await selectCell(page, row, col);
  await page.keyboard.press('Delete');
  await expect.poll(async () => committedCell(page, rowId, columnId)).toBe('');
}

/** base canvas の指定矩形（CSS px）に target 色（±tol）のピクセルが 1px でもあるか。 */
async function hasColor(page: Page, rect: CellRect, target: [number, number, number], tol = 40): Promise<boolean> {
  return page.evaluate(
    ({ r, t, tol }: { r: CellRect; t: [number, number, number]; tol: number }) => {
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
        if (
          data[i + 3] > 0 &&
          Math.abs(data[i] - t[0]) <= tol &&
          Math.abs(data[i + 1] - t[1]) <= tol &&
          Math.abs(data[i + 2] - t[2]) <= tol
        ) {
          return true;
        }
      }
      return false;
    },
    { r: rect, t: target, tol },
  );
}

async function openFormatClient(
  browser: Browser,
  name: string,
  format: string,
  extra: Record<string, string> = {},
): Promise<{ context: BrowserContext; page: Page }> {
  return openClient(browser, name, { format, ...extra });
}

test('AC1: 一致値のセルに背景色が描画される。非該当の隣接セルには塗られない（書式は値ベース・列内スコープ）', async ({
  browser,
}) => {
  // col-4 の値「MARK」に赤背景。row=8 は MARK（一致）、row=9 は別値（非一致）にする。
  const { context, page } = await openFormatClient(browser, 'format-bg', 'col-4:MARK=bg#ff0000');
  try {
    await seedCell(page, 8, 4, 'MARK');
    await seedCell(page, 9, 4, 'OTHER'); // 非一致値（背景なし＝AC3 の一部）
    await selectCell(page, 2, 1); // 選択枠を対象から外す

    const markRect = (await cellRectAt(page, 8, 4))!;
    const otherRect = (await cellRectAt(page, 9, 4))!;
    await expect
      .poll(async () => hasColor(page, markRect, [255, 0, 0]), { message: '一致セルに赤背景' })
      .toBe(true);
    // 非一致値のセルには赤背景が塗られない（値ベース＝完全一致のみ・AC3）。
    expect(await hasColor(page, otherRect, [255, 0, 0])).toBe(false);
    await page.screenshot({ path: evidencePath('format-background.png') });
  } finally {
    // 共有 collab 文書を汚さないため seed したセルを消す（DD-021 教訓#3・親 Phase 4 で発覚: 残留すると後続の
    // column-types-link AC1 の (8,4) クリックがフォーカス時に link-open を誘発し 400ms 二度押しガードで計測クリックが抑止される）。
    await clearCell(page, 8, 4).catch(() => {});
    await clearCell(page, 9, 4).catch(() => {});
    await context.close();
  }
});

test('AC2: badge:true 一致値のセルは丸角チップ（badgeColor）で描画され、右隣へオーバーフローしない', async ({
  browser,
}) => {
  // col-4 の値「進行中…（長文）」に緑バッジ。右隣 col-5 を空にしてオーバーフロー非流入を確認する。
  const { context, page } = await openFormatClient(
    browser,
    'format-badge',
    'col-4:進行中進行中進行中進行中=badge+bc#34a853+fg#ffffff',
  );
  try {
    await clearCell(page, 14, 5); // 右隣を空に
    await seedCell(page, 14, 4, '進行中進行中進行中進行中');
    await selectCell(page, 2, 1);

    const badgeRect = (await cellRectAt(page, 14, 4))!;
    const rightRect = (await cellRectAt(page, 14, 5))!;
    await expect
      .poll(async () => hasColor(page, badgeRect, [52, 168, 83]), { message: 'バッジ色（緑）がセルに描画される' })
      .toBe(true);
    // 右隣セルの右半分にバッジ色が無い＝チップが自セル内でクリップされオーバーフローしていない（AC2）。
    const rightHalf: CellRect = {
      x: rightRect.x + rightRect.width / 2,
      y: rightRect.y,
      width: rightRect.width / 2,
      height: rightRect.height,
    };
    expect(await hasColor(page, rightHalf, [52, 168, 83])).toBe(false);
    await page.screenshot({ path: evidencePath('format-badge.png') });
  } finally {
    await clearCell(page, 14, 4).catch(() => {}); // 共有文書を元に戻す（DD-021 教訓#3）
    await context.close();
  }
});

test('AC3: 空セル・非一致値・未指定列は書式なし（背景色が一切描かれない）', async ({ browser }) => {
  const { context, page } = await openFormatClient(browser, 'format-none', 'col-4:MARK=bg#ff0000');
  try {
    // 空セル（col-4・row=20）: 背景なし。
    await clearCell(page, 20, 4);
    // 未指定列 col-2 に MARK を入れても書式は付かない（列違い）。
    await seedCell(page, 21, 2, 'MARK');
    await selectCell(page, 2, 1);

    const emptyRect = (await cellRectAt(page, 20, 4))!;
    const otherColRect = (await cellRectAt(page, 21, 2))!;
    // poll で描画反映を待ってから否定を確認する（描画 flush 後）。
    await expect.poll(async () => (await snapshot(page)).ready).toBe(true);
    expect(await hasColor(page, emptyRect, [255, 0, 0])).toBe(false); // 空セルは書式なし
    expect(await hasColor(page, otherColRect, [255, 0, 0])).toBe(false); // 未指定列は書式なし
  } finally {
    await clearCell(page, 21, 2).catch(() => {}); // 共有文書を元に戻す（DD-021 教訓#3）
    await context.close();
  }
});

test('AC4: 選択式列の値にバッジ書式を併用 → ドロップダウン確定で即バッジ描画（ReadyCrew ユース）', async ({
  browser,
}) => {
  // col-3 を選択式（進行中|受注|失注）にし、同列の「進行中」へバッジ書式を併用する。
  const { context, page } = await openFormatClient(
    browser,
    'format-select-badge',
    'col-3:進行中=badge+bc#1a73e8+fg#ffffff',
    { select: 'col-3:進行中|受注|失注' },
  );
  try {
    const rowId = (await rowIdAt(page, 10))!;
    const columnId = (await colIdAt(page, 3))!;
    // セルを空にしてから開くと、初期ハイライトは先頭候補「進行中」（open は currentValue の index or 0）。
    await clearCell(page, 10, 3);
    await selectCell(page, 10, 3);
    await page.keyboard.press('F2');
    await expect.poll(async () => selectOpen(page), { message: 'ドロップダウンが開く' }).toBe(true);
    // 追加の ArrowDown なしで Enter → 先頭候補「進行中」を確定（候補順依存を排除）。
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => committedCell(page, rowId, columnId), { message: '選択確定で「進行中」が commit' })
      .toBe('進行中');

    await selectCell(page, 2, 1); // カーソル/▼ を対象から外す
    const rect = (await cellRectAt(page, 10, 3))!;
    await expect
      .poll(async () => hasColor(page, rect, [26, 115, 232]), { message: '確定値にバッジ（青）が即描画される' })
      .toBe(true);
    await page.screenshot({ path: evidencePath('format-select-badge.png') });
  } finally {
    await clearCell(page, 10, 3).catch(() => {}); // 共有文書を元に戻す（DD-021 教訓#3）
    await context.close();
  }
});

test('fail-fast: 不正 columnFormats（空ルール配列）→ config error（column-types-invalid）', async ({ browser }) => {
  // 空ルール配列は URL 構文では表現しにくいため、未知列を使う（parseColumnFormats は未知列を除去しないので mount で fail-fast）。
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    // col-zzz は columnOrder に存在しない → FormatRuleConfigError(unknown-column) → column-types-invalid。
    // config error では attachBackendRendering に到達しない＝常駐 textarea も作られない（未配線）ため待たない。
    await page.goto(
      `/poc-integration.html?server=${encodeURIComponent(WS_ORIGIN)}&format=${encodeURIComponent('col-zzz:X=bg#ff0000')}`,
    );
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

/** DD-027-3 証跡（スクショ）の保存先（active な doc/DD を汚さず test-results 配下）。 */
function evidencePath(fileName: string): string {
  return fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-027-3/${fileName}`, import.meta.url));
}
