// DD-038 E2E: 貼り付け後の選択レンジのうち、**Axis の端と readOnly** に関わる境界（AC6 はみ出し・AC7・AC8・AC9）。
//
// 共同編集ハーネス（clipboard.spec.ts CL-8〜CL-12）は 50,000 行 × 多数列のため、端のセルを選ぶだけで
// スクロールと ensureActiveCellVisible が競合して不安定になる。本 spec は **4 列 × 15 行**の単独モードを使い、
// 端の到達にスクロールを要さない状態で境界だけを決定的に検証する。
// 貼り付けは合成 ClipboardEvent（実クリップボード権限に依存しない）。値は Canvas ゆえ debug API で観測する。

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import * as sa from './standalone-helpers';
import { dispatchSyntheticPaste } from './integration-helpers';

test.describe.configure({ mode: 'serial' });

/** readOnly 列 col-c・readOnly 行 r5 を持つ 4 列 × 15 行の単独グリッド（最下行まで 800px 内に収める）。 */
const QUERY = '?readonlycols=col-c&readonlyrows=r5&seedrows=15';

interface CellRange {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

async function api<R>(page: Page, method: string, args: unknown[] = []): Promise<R> {
  return page.evaluate(
    (payload: { method: string; args: unknown[] }) => {
      const a = (window as unknown as { __integrationTestApi?: Record<string, (...x: unknown[]) => unknown> })
        .__integrationTestApi;
      if (a === undefined) {
        throw new Error('__integrationTestApi 未初期化');
      }
      const fn = a[payload.method];
      if (typeof fn !== 'function') {
        throw new Error(`__integrationTestApi.${payload.method} が無い`);
      }
      return fn.apply(a, payload.args);
    },
    { method, args },
  ) as Promise<R>;
}

const selectionRange = (page: Page): Promise<CellRange | null> => api<CellRange | null>(page, 'selectionRange');
const committedRevision = (page: Page): Promise<number> => api<number>(page, 'committedRevision');

/** (from)→(to) をドラッグして範囲選択する（activeCell は from になる）。 */
async function dragSelect(
  page: Page,
  from: { row: number; col: number },
  to: { row: number; col: number },
): Promise<void> {
  // cellRectAt は**スクローラー要素の内部座標**を返すため、page.mouse（ビューポート絶対）へ渡すには
  // スクローラーの boundingBox を足す（integration-helpers の cellCenter と同じ換算）。
  const box = await page.locator('.nsheet-scroller').boundingBox();
  const a = await sa.cellRectAt(page, from.row, from.col);
  const b = await sa.cellRectAt(page, to.row, to.col);
  if (box === null || a === null || b === null) {
    throw new Error(`セル矩形が取れない from=${JSON.stringify(from)} to=${JSON.stringify(to)}`);
  }
  await page.mouse.move(box.x + a.x + a.width / 2, box.y + a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + b.x + b.width / 2, box.y + b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
}

async function openGrid(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/standalone.html${QUERY}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
  // 既知値を全列へ注入する（seed は col-a のみ）。
  await page.evaluate(() => {
    const rows = Array.from({ length: 15 }, (_v, i) => ({
      rowId: `r${i}`,
      cells: { 'col-a': `A${i}`, 'col-b': `B${i}`, 'col-c': `C${i}`, 'col-d': `D${i}` },
    }));
    (window as unknown as { __standalone?: { reinject(o: unknown): void } }).__standalone?.reinject({ rows });
  });
  await expect.poll(async () => sa.displayCell(page, 'r1', 'col-b')).toBe('B1');
  return { context, page };
}

test('PS-1: はみ出し拒否（右端列・下端行）では選択も activeCell も変わらない（AC6）', async ({ browser }) => {
  const { context, page } = await openGrid(browser);
  try {
    // ① 右端列 col-d（index 3）から 1×2 を貼る → 右端を越えるので全体拒否。
    await sa.selectCell(page, 2, 3);
    expect(await selectionRange(page), '明示レンジ無し').toBeNull();
    const before = { active: await sa.activeCell(page), rev: await committedRevision(page) };
    expect(before.active).toEqual({ row: 2, col: 3 });

    expect(await dispatchSyntheticPaste(page, 'x\ty'), 'はみ出してもグリッドが消費する').toBe(true);
    expect(await committedRevision(page), '右端はみ出しは submit しない').toBe(before.rev);
    expect(await selectionRange(page), '拒否で明示レンジは作られない').toBeNull();
    expect(await sa.activeCell(page), '拒否で activeCell は不変').toEqual(before.active);
    expect(await sa.displayCell(page, 'r2', 'col-d'), '値も無変更').toBe('D2');

    // ② 下端行 r14（index 14）から 2×1 を貼る → 下端を越えるので全体拒否。明示レンジがある状態で検証する。
    await dragSelect(page, { row: 14, col: 0 }, { row: 14, col: 1 });
    const range0 = await selectionRange(page);
    expect(range0, '下端行に明示レンジを作る').toEqual({ rowStart: 14, rowEnd: 15, colStart: 0, colEnd: 2 });
    const beforeBottom = { active: await sa.activeCell(page), rev: await committedRevision(page) };

    expect(await dispatchSyntheticPaste(page, 'p\nq'), '下端はみ出しも消費する').toBe(true);
    expect(await committedRevision(page), '下端はみ出しは submit しない').toBe(beforeBottom.rev);
    expect(await selectionRange(page), '拒否で選択は不変').toEqual(range0);
    expect(await sa.activeCell(page), '拒否で activeCell は不変').toEqual(beforeBottom.active);
  } finally {
    await context.close();
  }
});

test('PS-2: readOnly 列・行を含む範囲へ貼ると、選択は貼付矩形どおりで値だけがスキップされる（AC7）', async ({
  browser,
}) => {
  const { context, page } = await openGrid(browser);
  try {
    // (4,0) を起点に 3行×3列（col-a/col-b/col-c × r4/r5/r6）を貼る。
    // col-c は readOnly 列・r5 は readOnly 行なので、その交差部分は書かれない。
    await sa.selectCell(page, 4, 0);
    expect(await dispatchSyntheticPaste(page, 'n1\tn2\tn3\nn4\tn5\tn6\nn7\tn8\tn9')).toBe(true);

    // 書き込み: readOnly でない (r4,col-a)(r4,col-b)(r6,col-a)(r6,col-b) のみ更新される。
    await expect.poll(async () => sa.displayCell(page, 'r4', 'col-a'), { message: '可編集セルは更新' }).toBe('n1');
    expect(await sa.displayCell(page, 'r4', 'col-b')).toBe('n2');
    expect(await sa.displayCell(page, 'r6', 'col-a')).toBe('n7');
    expect(await sa.displayCell(page, 'r6', 'col-b')).toBe('n8');
    // readOnly 列 col-c はスキップ（3 行とも元値）。
    expect(await sa.displayCell(page, 'r4', 'col-c'), 'readOnly 列はスキップ').toBe('C4');
    expect(await sa.displayCell(page, 'r6', 'col-c')).toBe('C6');
    // readOnly 行 r5 はスキップ（3 列とも元値）。
    expect(await sa.displayCell(page, 'r5', 'col-a'), 'readOnly 行はスキップ').toBe('A5');
    expect(await sa.displayCell(page, 'r5', 'col-b')).toBe('B5');
    expect(await sa.displayCell(page, 'r5', 'col-c')).toBe('C5');

    // 選択は**貼付矩形どおり**（スキップされた行・列も含む 3×3）＝決定②。
    expect(await selectionRange(page), '選択は貼付矩形どおり（歯抜けにしない）').toEqual({
      rowStart: 4, rowEnd: 7, colStart: 0, colEnd: 3,
    });
    expect(await sa.activeCell(page), 'activeCell は矩形の左上').toEqual({ row: 4, col: 0 });
  } finally {
    await context.close();
  }
});

test('PS-3: readOnly で全件スキップ（文書無変更）なら選択も activeCell も変わらない（AC8）', async ({ browser }) => {
  const { context, page } = await openGrid(browser);
  try {
    // readOnly 行 r5 の readOnly 列 col-c を単一選択 → 1×1 を貼る（全件スキップ）。
    await sa.selectCell(page, 5, 2);
    const before = { active: await sa.activeCell(page), rev: await committedRevision(page) };
    expect(before.active).toEqual({ row: 5, col: 2 });
    expect(await selectionRange(page)).toBeNull();

    expect(await dispatchSyntheticPaste(page, 'zzz'), '全件スキップでも消費する').toBe(true);
    expect(await committedRevision(page), '文書は無変更').toBe(before.rev);
    expect(await sa.displayCell(page, 'r5', 'col-c'), '値も無変更').toBe('C5');
    expect(await selectionRange(page), '選択は変わらない（貼れた誤認を作らない）').toBeNull();
    expect(await sa.activeCell(page), 'activeCell も変わらない').toEqual(before.active);

    // readOnly 行 r5 の 1 行だけを覆う 1×2 貼り付けも全件スキップ＝同じ扱い。
    await sa.selectCell(page, 5, 0);
    const before2 = { active: await sa.activeCell(page), rev: await committedRevision(page) };
    expect(await dispatchSyntheticPaste(page, 'y1\ty2')).toBe(true);
    expect(await committedRevision(page), '文書は無変更').toBe(before2.rev);
    expect(await sa.displayCell(page, 'r5', 'col-a')).toBe('A5');
    expect(await selectionRange(page), '選択は変わらない').toBeNull();
    expect(await sa.activeCell(page), 'activeCell も変わらない').toEqual(before2.active);
  } finally {
    await context.close();
  }
});

test('PS-4: jagged TSV は bounding box（最大列数）が選択され、欠けセルは上書きされない（AC9）', async ({
  browser,
}) => {
  const { context, page } = await openGrid(browser);
  try {
    // 1 行目 2 列・2 行目 1 列 → bounding box は 2×2。(8,0) 起点。
    await sa.selectCell(page, 8, 0);
    expect(await dispatchSyntheticPaste(page, 'j1\tj2\nj3')).toBe(true);

    await expect.poll(async () => sa.displayCell(page, 'r8', 'col-a'), { message: '1 行目 1 列目' }).toBe('j1');
    expect(await sa.displayCell(page, 'r8', 'col-b')).toBe('j2');
    expect(await sa.displayCell(page, 'r9', 'col-a')).toBe('j3');
    // 欠けセル（2 行目 2 列目）は上書きしない＝元値のまま（決定(d)・DD-020-2）。
    expect(await sa.displayCell(page, 'r9', 'col-b'), '欠けセルは上書きしない').toBe('B9');

    // 選択は bounding box（欠けセルも矩形に含む）＝決定③。
    expect(await selectionRange(page), '選択は bounding box').toEqual({
      rowStart: 8, rowEnd: 10, colStart: 0, colEnd: 2,
    });
    expect(await sa.activeCell(page), 'activeCell は矩形の左上').toEqual({ row: 8, col: 0 });
  } finally {
    await context.close();
  }
});

test('PS-5: 貼付アンカー自身が readOnly 行でも、書けたセルがあれば選択は矩形どおり（activeCell は readOnly セルへ乗る）', async ({
  browser,
}) => {
  const { context, page } = await openGrid(browser);
  try {
    // readOnly 行 r5 を起点に 2 行貼る → r5 はスキップ・r6 だけ書ける（op は非 null＝文書は変わる）。
    await sa.selectCell(page, 5, 0);
    expect(await dispatchSyntheticPaste(page, 'k1\nk2')).toBe(true);

    await expect.poll(async () => sa.displayCell(page, 'r6', 'col-a'), { message: '可編集行は更新' }).toBe('k2');
    expect(await sa.displayCell(page, 'r5', 'col-a'), 'readOnly 行はスキップ').toBe('A5');

    // 文書が変わった以上、選択は貼付矩形どおりに動く（決定②: スキップ行も矩形に含む）。
    expect(await selectionRange(page), '選択は readOnly 行を含む 2×1').toEqual({
      rowStart: 5, rowEnd: 7, colStart: 0, colEnd: 1,
    });
    // activeCell は矩形の左上＝readOnly 行のセル。readOnly セルをクリックしたのと同じ状態で、
    // 選択の不変条件（anchor === activeCell）は保たれる。
    expect(await sa.activeCell(page), 'activeCell は矩形の左上（readOnly 行）').toEqual({ row: 5, col: 0 });
  } finally {
    await context.close();
  }
});

test('PS-6: cell-commit リスナーから setActiveCell を呼ぶと、貼り付け後の選択より consumer の指定が勝つ（Codex P2）', async ({
  browser,
}) => {
  // 単独モードは submitLocalOperation の内側から cell-commit を同期発火する。その購読者が公開 API を
  // 呼んだとき、SDK が後から選択を上書きしてはいけない（選択遷移を submit の前に完了させている根拠）。
  const { context, page } = await openGrid(browser);
  try {
    // 最初の cell-commit で 1 度だけ (r0, col-d) へアクティブセルを移す consumer を仕込む。
    await page.evaluate(() => {
      const w = window as unknown as {
        __gridInstance?: {
          subscribe(l: (e: unknown) => void): () => void;
          setActiveCell(rowId: string, columnId: string): void;
        };
        __consumerMoved?: boolean;
      };
      w.__consumerMoved = false;
      w.__gridInstance?.subscribe((e) => {
        const ev = e as { type: string };
        if (ev.type === 'cell-commit' && w.__consumerMoved === false) {
          w.__consumerMoved = true;
          w.__gridInstance?.setActiveCell('r0', 'col-d');
        }
      });
    });

    await sa.selectCell(page, 8, 0);
    expect(await dispatchSyntheticPaste(page, 'c1\nc2')).toBe(true);

    // 値は通常どおり書かれる。
    await expect.poll(async () => sa.displayCell(page, 'r8', 'col-a'), { message: '貼り付けは成立' }).toBe('c1');
    expect(await sa.displayCell(page, 'r9', 'col-a')).toBe('c2');
    expect(
      await page.evaluate(() => (window as unknown as { __consumerMoved?: boolean }).__consumerMoved),
      'consumer の cell-commit リスナーが実行された',
    ).toBe(true);

    // consumer の setActiveCell が勝つ（SDK が貼付矩形で上書きしない）。setActiveCell は明示レンジも解除する。
    expect(await sa.activeCell(page), 'consumer の指定した activeCell が残る').toEqual({ row: 0, col: 3 });
    expect(await selectionRange(page), 'setActiveCell の仕様どおり明示レンジは解除されている').toBeNull();
  } finally {
    await context.close();
  }
});
