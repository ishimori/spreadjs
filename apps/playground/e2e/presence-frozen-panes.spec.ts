// DD-041 E2E: 他ユーザーの Presence（activeCell 枠・名前タグ）が固定ペインへはみ出さない。
//
// 再現条件は「固定列あり」×「相手の activeCell が固定帯の裏へ回った位置」。
// A（Alice）が scrollLeft=0 のまま列 8 を選択し、B（Bob）だけ右へスクロールすると、
// B の座標系では列 8 の viewport X が固定帯の内側へ落ちる。修正前はそこへ枠と名前タグが描かれていた。
//
// 検証は overlay canvas の実ピクセル: **B の固定帯（列 0〜4 の帯）に不透明ピクセルが 1 つも無い**こと。
// B 自身の選択枠は body pane 側のセルへ動かしてあるため、帯に残る色は「はみ出した Presence」だけになる。
// Manual Gate M1（2 タブ・固定列ありでのはみ出し確認）をそのまま自動化したもの。
//
// 修正前の実測は 1,028 ピクセル・修正後は 0（test-results/dd-evidence/DD-041/ の証跡）。

import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

import { evidencePathDD041, openClient, scrollTo, selectCell, snapshot } from './integration-helpers';

test.describe.configure({ mode: 'serial' });

const FROZEN_COLS = 5;
/** A が選ぶ列（固定列より右＝スクロール列。A の scrollLeft=0 で可視な範囲に置く）。 */
const TARGET_COL = 8;
const TARGET_ROW = 3;

/** overlay canvas の指定矩形（CSS 座標）に alpha>0 のピクセルが何個あるか。 */
async function opaquePixelCount(
  page: Page,
  rect: { x: number; y: number; width: number; height: number },
): Promise<number> {
  return page.evaluate((r) => {
    // stage 内の 2 枚目の canvas が overlay（buildScaffold が base → overlay の順に append する）。
    const overlay = document.querySelectorAll('.nsheet-stage canvas')[1];
    if (!(overlay instanceof HTMLCanvasElement)) {
      throw new Error('overlay canvas が見つからない');
    }
    const ctx = overlay.getContext('2d');
    if (ctx === null) {
      throw new Error('2d context が取れない');
    }
    const dpr = overlay.width / overlay.clientWidth;
    const data = ctx.getImageData(
      Math.floor(r.x * dpr),
      Math.floor(r.y * dpr),
      Math.max(1, Math.floor(r.width * dpr)),
      Math.max(1, Math.floor(r.height * dpr)),
    ).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) {
      if ((data[i] ?? 0) > 0) {
        count += 1;
      }
    }
    return count;
  }, rect);
}

/** 表示 (row,col) セルの viewport 矩形（本番 transform 経由）。可視範囲外は例外。 */
async function cellRect(
  page: Page,
  row: number,
  col: number,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await page.evaluate(
    (pos: { row: number; col: number }) => {
      const api = (window as unknown as {
        __integrationTestApi?: { cellRectAt(r: number, c: number): unknown };
      }).__integrationTestApi;
      if (api === undefined) {
        throw new Error('window.__integrationTestApi 未初期化');
      }
      return api.cellRectAt(pos.row, pos.col) as
        | { x: number; y: number; width: number; height: number }
        | null;
    },
    { row, col },
  );
  if (rect === null) {
    throw new Error(`セル (${row},${col}) が可視範囲にない`);
  }
  return rect;
}

test('DD-041: 他者の activeCell 枠・名前タグが固定ペインの上へはみ出さない', async ({
  browser,
}: {
  browser: Browser;
}) => {
  const frozen = { frozencols: String(FROZEN_COLS), frozenrows: '1' };
  const a = await openClient(browser, 'Alice', frozen);
  const b = await openClient(browser, 'Bob', frozen);
  const alice = a.page;
  const bob = b.page;
  try {
    // 固定帯の実寸を本番 transform から採る（列 0 の左端 〜 最終固定列の右端）。
    const firstFrozen = await cellRect(bob, TARGET_ROW, 0);
    const lastFrozen = await cellRect(bob, TARGET_ROW, FROZEN_COLS - 1);
    const bandX = firstFrozen.x;
    const bandRight = lastFrozen.x + lastFrozen.width;
    const colWidth = firstFrozen.width;

    // B だけ右へスクロールし、A の列 8 が B の固定帯の内側へ落ちる位置にする。
    const scrollLeft = (TARGET_COL - 2) * colWidth;
    await scrollTo(bob, 0, scrollLeft);
    await expect
      .poll(async () =>
        bob.evaluate(() => document.querySelector('.nsheet-scroller')?.scrollLeft ?? -1),
      )
      .toBe(scrollLeft);

    // B 自身の選択枠を body pane（固定帯の外）へ移す。以降、帯に色が乗ったら Presence のはみ出しだけが原因。
    // B はスクロール済みなので「固定帯の裏へ回っていない列」を実測で選ぶ（列 index だけで選ぶと帯の裏を掴む）。
    const bobOwnCol = TARGET_COL + 8;
    const bobOwnRect = await cellRect(bob, TARGET_ROW + 2, bobOwnCol);
    expect(bobOwnRect.x, 'B 自身の選択は固定帯の外').toBeGreaterThanOrEqual(bandRight);
    await selectCell(bob, TARGET_ROW + 2, bobOwnCol);

    // 前提: この配置では A の activeCell の viewport X が B の固定帯の内側へ落ちる（＝修正前なら重なる）。
    const aliceCellOnBob = await cellRect(bob, TARGET_ROW, TARGET_COL);
    expect(aliceCellOnBob.x, 'A の activeCell が B の固定帯の内側へ落ちる配置').toBeGreaterThanOrEqual(
      bandX,
    );
    expect(aliceCellOnBob.x, 'A の activeCell が B の固定帯の内側へ落ちる配置').toBeLessThan(bandRight);

    // A が対象セルを選択 → B へ Presence が届く。
    await selectCell(alice, TARGET_ROW, TARGET_COL);
    await expect
      .poll(
        async () => (await snapshot(bob)).presences.filter((p) => p.displayName === 'Alice').length,
        { message: 'B が A の Presence を受信' },
      )
      .toBe(1);

    // Codex[P2]: 固定 sleep で待つと、rAF がスロットルされた環境では「まだ Presence を描いていない
    // 空の固定帯」を測ることになり、**不在アサートが素通りする**（バグがあっても green になる）。
    // B 自身の選択を別セルへ動かし、その枠が overlay に現れるまで待って
    // 「Presence 受信後に完了した描画パス」を実測で捉える。overlay の draw は
    // clear → 選択 → ドラッグ → Presence を 1 パスで描くため、新しい選択枠が見えた時点で
    // 同じフレームの Presence も描き終わっている。
    const flushRow = TARGET_ROW + 5;
    const flushRect = await cellRect(bob, flushRow, bobOwnCol);
    await selectCell(bob, flushRow, bobOwnCol);
    await expect
      .poll(async () => opaquePixelCount(bob, flushRect), {
        message: 'B の overlay が Presence 受信後に再描画されたことを、自分の選択枠の出現で確認',
      })
      .toBeGreaterThan(0);

    // 本題: B の固定帯（列記号ヘッダーの直下から下端まで）に不透明ピクセルが 1 つも無い。
    // 名前タグはセルの真上に出るのでヘッダー直下から測り、タグの漏れも同時に見る。
    const stageHeight = await bob.evaluate(
      () => document.querySelector('.nsheet-stage')?.getBoundingClientRect().height ?? 0,
    );
    // scrollTop=0・行 0 は固定行なので cellRect(0,0).y が列記号ヘッダーの下端＝固定行帯の上端。
    const bandTop = (await cellRect(bob, 0, 0)).y;
    const leakedPixels = await opaquePixelCount(bob, {
      x: bandX,
      y: bandTop,
      width: bandRight - bandX,
      height: stageHeight - bandTop,
    });
    await bob.screenshot({ path: evidencePathDD041('dd041-presence-frozen-band.png') });
    expect(leakedPixels, 'B の固定帯に描かれた overlay ピクセル（0 が期待値）').toBe(0);
  } finally {
    // Codex[P2]: 直列実行の共有 WS サーバーへ接続を残さない（後続 spec の rAF/Presence を汚さない）。
    await b.context.close();
    await a.context.close();
  }
});
