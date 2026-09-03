// DD-033-1 E2E: 表示専用モード（readOnly）。
//
// 単独モード（standalone.html?readonly=1）で、文書変更系（編集開始・paste/cut・行操作・Undo/Redo）が全て抑止され
// 文書無変更のまま（cell-commit 0・committedHash 不変・rowCount 不変）であること、閲覧系（範囲選択・コピー・
// スクロール・列幅リサイズ・link-open）が従来どおり動くこと、setData で表示データが差し替わることを検証する（AC1〜4）。
// 共同編集モードでの受信専用（AC5）は Phase 2 で追加する。値は Canvas 描画ゆえ window.__integrationTestApi で観測する。
// 入口裁定の細目はユニット（readonly-policy.test.ts）が担保し、ここは「実ブラウザーで抑止/維持の配線が成立する」ことに集中する。

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import * as sa from './standalone-helpers';
import * as ih from './integration-helpers';

test.describe.configure({ mode: 'serial' });

interface DiagEntry {
  level: string;
  code: string;
  message: string;
}

/** standalone.html を readOnly で開き、初回描画（ready）まで待つ（?readonly=1・追加クエリ可）。 */
async function openReadonly(browser: Browser, extraQuery = ''): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/standalone.html?readonly=1${extraQuery}`);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await sa.waitReady(page);
  return { context, page };
}

async function debugCall<R>(page: Page, method: string, args: unknown[] = []): Promise<R> {
  return page.evaluate(
    (payload: { method: string; args: unknown[] }) => {
      const api = (window as unknown as { __integrationTestApi?: Record<string, (...a: unknown[]) => unknown> })
        .__integrationTestApi;
      if (api === undefined) {
        throw new Error('window.__integrationTestApi 未初期化');
      }
      return (api[payload.method] as (...a: unknown[]) => unknown)(...payload.args);
    },
    { method, args },
  ) as Promise<R>;
}

async function committedHash(page: Page): Promise<string> {
  return debugCall<string>(page, 'committedHash');
}
async function selectOpen(page: Page): Promise<boolean> {
  return debugCall<boolean>(page, 'selectOpen');
}
async function selectionRange(page: Page): Promise<unknown> {
  return debugCall<unknown>(page, 'selectionRange');
}
async function columnWidthOverrides(page: Page): Promise<Record<string, number>> {
  return debugCall<Record<string, number>>(page, 'columnWidthOverrides');
}
async function columnHeaderRectAt(page: Page, col: number): Promise<sa.CellRect | null> {
  return debugCall<sa.CellRect | null>(page, 'columnHeaderRectAt', [col]);
}
async function diagnostics(page: Page): Promise<DiagEntry[]> {
  return page.evaluate(
    () => ((window as unknown as { __standalone?: { diagnostics: DiagEntry[] } }).__standalone?.diagnostics ?? []) as DiagEntry[],
  );
}
async function cellCommitCount(page: Page): Promise<number> {
  return (await sa.events(page)).filter((e) => e.type === 'cell-commit').length;
}
async function editingTarget(page: Page): Promise<unknown> {
  return debugCall<unknown>(page, 'editingTarget');
}
/** 編集 UI が「白地化」しているか（Navigation は transparent・編集中は #ffffff）。＝編集 UI が開いた指標。 */
async function isEditingVisual(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ta = document.querySelector('textarea.int-cell-editor');
    if (!(ta instanceof HTMLTextAreaElement)) {
      return false;
    }
    const bg = ta.style.background;
    return bg !== '' && bg !== 'transparent';
  });
}
function hasBlocked(diags: DiagEntry[], fragment: string): boolean {
  return diags.some((d) => d.code === 'readonly-blocked' && d.message.includes(fragment));
}

test('AC1: 編集開始キー・dblclick・synthetic IME で編集 UI が開かない（cell-commit 0・committedHash 不変）', async ({
  browser,
}) => {
  const { context, page } = await openReadonly(browser);
  try {
    // mount 時に readonly-mode info が1件出る（決定事項）。
    expect((await diagnostics(page)).some((d) => d.code === 'readonly-mode')).toBe(true);

    const hash0 = await committedHash(page);
    await sa.selectCell(page, 1, 1);

    // 印字キー・F2・Backspace・Delete（修飾キー付き含む＝統合レビュー P2-1: 状態機械は修飾を見ないため
    // Ctrl+Backspace 等が素の編集開始として届く）のいずれでも編集 UI（textarea 白地化＝editingTarget）が開かない。
    for (const key of ['a', 'F2', 'Backspace', 'Delete', 'Control+Backspace', 'Control+Delete', 'Control+F2']) {
      await page.keyboard.press(key);
      expect(await editingTarget(page), `${key} で編集 UI が開かない`).toBeNull();
      expect(await isEditingVisual(page), `${key} で textarea が白地化しない`).toBe(false);
      expect(await sa.draft(page), `${key} で draft は空`).toBe('');
    }
    // 修飾キー経路でも undo 記録が汚染されない（統合レビュー P2-2: chokepoint 破棄後の recordUndoEntry 防止）。
    expect(await sa.canUndo(page), '修飾キー経路後も canUndo=false').toBe(false);

    // ダブルクリックでも編集 UI が開かない。
    const rect = (await debugCall<sa.CellRect | null>(page, 'cellRectAt', [2, 1]))!;
    await page.locator('.nsheet-scroller').dblclick({
      position: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    });
    expect(await editingTarget(page)).toBeNull();
    expect(await isEditingVisual(page)).toBe(false);

    // synthetic IME composition でも BeginEdit が起きない（dispatch 抑止＝draft 空・非 composing）。
    await sa.composeOpen(page, 'あいう');
    expect(await sa.isComposing(page)).toBe(false);
    expect(await sa.draft(page)).toBe('');
    expect(await editingTarget(page)).toBeNull();

    // 文書は一切変わっていない。
    expect(await cellCommitCount(page)).toBe(0);
    expect(await committedHash(page)).toBe(hash0);

    // 抑止経路（F2/Delete/Backspace/dblclick）で readonly-blocked notice が出ている。
    const diags = await diagnostics(page);
    expect(hasBlocked(diags, 'F2')).toBe(true);
    expect(hasBlocked(diags, 'ダブルクリック')).toBe(true);
  } finally {
    await context.close();
  }
});

test('AC2: paste/cut/行挿入削除(公開API)/Undo/Redo が文書無変更＋readonly-blocked notice', async ({ browser }) => {
  const { context, page } = await openReadonly(browser);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  try {
    const rowCount0 = await sa.rowCount(page);
    const hash0 = await committedHash(page);
    const rowId0 = (await sa.rowIdAt(page, 0))!;

    await sa.selectCell(page, 1, 1);

    // paste（synthetic）→ 抑止。
    await page.evaluate(() => {
      const ta = document.querySelector('textarea.int-cell-editor');
      if (ta instanceof HTMLTextAreaElement) {
        const dt = new DataTransfer();
        dt.setData('text/plain', 'PASTED');
        ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }
    });
    // cut（実キー）→ 抑止。
    await page.keyboard.press('Control+x');

    // 行挿入・削除（公開 API）→ 抑止（rowCount 不変）。
    await page.evaluate((rid: string) => {
      const inst = (window as unknown as { __gridInstance?: { insertRows: (o: unknown) => void; deleteRows: (r: string[]) => void } })
        .__gridInstance;
      inst?.insertRows({ afterRowId: null, count: 1 });
      inst?.deleteRows([rid]);
    }, rowId0);

    // Undo/Redo（実キー）→ 抑止。
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+y');

    // 文書無変更・Undo 不可。
    await page.waitForTimeout(100);
    expect(await sa.rowCount(page)).toBe(rowCount0);
    expect(await committedHash(page)).toBe(hash0);
    expect(await cellCommitCount(page)).toBe(0);
    expect(await sa.canUndo(page)).toBe(false);

    // 各抑止経路の readonly-blocked notice。
    const diags = await diagnostics(page);
    expect(hasBlocked(diags, 'paste')).toBe(true);
    expect(hasBlocked(diags, 'cut')).toBe(true);
    expect(hasBlocked(diags, 'insertRows')).toBe(true);
    expect(hasBlocked(diags, 'deleteRows')).toBe(true);
    expect(hasBlocked(diags, 'Undo')).toBe(true);
  } finally {
    await context.close();
  }
});

test('AC3: 範囲選択・コピー・スクロール・列幅リサイズ・link-open は維持・選択式ドロップダウンは開かない', async ({
  browser,
}) => {
  const { context, page } = await openReadonly(browser, '&select=col-b:X|Y|Z');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  try {
    // 縦スクロール検証のため十分な行数を注入する（readOnly でも setData は許可・AC4）。
    await page.evaluate(() => {
      window.__standalone?.reinject({
        rows: Array.from({ length: 300 }, (_, i) => ({ rowId: `k${i}`, cells: { 'col-a': `A${i}`, 'col-b': `B${i}` } })),
      });
    });
    await expect.poll(async () => sa.rowCount(page), { message: 'setData で 300 行になる' }).toBe(300);

    // 範囲選択（Shift+矢印）が成立する。
    await sa.selectCell(page, 2, 0);
    await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(async () => selectionRange(page), { message: 'Shift+矢印でレンジが成立' }).not.toBeNull();

    // コピー: 選択セルの TSV がクリップボードへ書き出される（従来と同一の表示値）。
    await sa.selectCell(page, 1, 0);
    const rowId1 = (await sa.rowIdAt(page, 1))!;
    const expected = await sa.displayCell(page, rowId1, 'col-a');
    await page.keyboard.press('Control+c');
    await expect
      .poll(async () => page.evaluate(() => navigator.clipboard.readText()), { message: 'コピーで TSV が書き出される' })
      .toBe(expected);

    // スクロール: scroller が縦スクロールできる（閲覧系・view-local）。
    // setData 直後はコンテンツ高さ反映前で scrollTop 設定がクランプされうるため、poll 内で毎回設定し直す。
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const sc = document.querySelector('.nsheet-scroller');
            if (!(sc instanceof HTMLElement)) return 0;
            sc.scrollTop = 600;
            return sc.scrollTop;
          }),
        { message: '縦スクロールが成立する（コンテンツ高さ反映後）' },
      )
      .toBeGreaterThan(0);

    // 列幅リサイズ（列境界 dblclick の auto-fit・要確認4 維持）→ columnWidthOverrides が付く。
    const before = (await columnHeaderRectAt(page, 1))!;
    await page.locator('.nsheet-scroller').dblclick({
      position: { x: before.x + before.width - 2, y: before.y + before.height / 2 },
    });
    await expect
      .poll(async () => Object.keys(await columnWidthOverrides(page)).length, { message: 'auto-fit で列幅 override が付く' })
      .toBeGreaterThan(0);

    // 選択式列の dblclick でドロップダウンは開かない（readOnly 抑止）。
    const selRect = (await debugCall<sa.CellRect | null>(page, 'cellRectAt', [3, 1]))!;
    await page.locator('.nsheet-scroller').dblclick({
      position: { x: selRect.x + selRect.width / 2, y: selRect.y + selRect.height / 2 },
    });
    await page.waitForTimeout(50);
    expect(await selectOpen(page)).toBe(false);
  } finally {
    await context.close();
  }
});

test('AC3(link): readOnly でもリンク列クリックで link-open が発火する（閲覧系維持）', async ({ browser }) => {
  const { context, page } = await openReadonly(browser, '&link=col-a');
  try {
    const before = (await sa.events(page)).filter((e) => e.type === 'link-open').length;
    await sa.selectCell(page, 2, 1); // 退避
    await sa.selectCell(page, 3, 0); // リンクセル（col-a・値「行3」）をクリック
    await expect
      .poll(async () => (await sa.events(page)).filter((e) => e.type === 'link-open').length, {
        message: 'readOnly でも link-open が発火',
      })
      .toBe(before + 1);
  } finally {
    await context.close();
  }
});

test('AC4: readOnly でも setData で表示データが差し替わる', async ({ browser }) => {
  const { context, page } = await openReadonly(browser);
  try {
    await page.evaluate(() => {
      window.__standalone?.reinject({
        rows: [
          { rowId: 'z1', cells: { 'col-a': 'ZZZ', 'col-b': 'YYY' } },
          { rowId: 'z2', cells: { 'col-a': 'WWW' } },
        ],
      });
    });
    await expect.poll(async () => sa.rowCount(page), { message: 'setData で行数が 2 になる' }).toBe(2);
    expect(await sa.displayCell(page, 'z1', 'col-a')).toBe('ZZZ');
    expect(await sa.displayCell(page, 'z1', 'col-b')).toBe('YYY');
    expect(await sa.displayCell(page, 'z2', 'col-a')).toBe('WWW');
  } finally {
    await context.close();
  }
});

test('AC5: 共同編集モードの readOnly は受信専用（remote 反映・pendingCount 恒常0・committedRevision 不変）', async ({
  browser,
}) => {
  // A=readOnly 閲覧者・B=通常編集者。同一ドキュメントに接続する（?readonly=1 は main.ts が受ける）。
  const a = await ih.openClient(browser, 'A-readonly', { readonly: '1' });
  const b = await ih.openClient(browser, 'B-editor');
  try {
    const rowId = (await ih.rowIdAt(a.page, 10))!;
    const colId = (await ih.colIdAt(a.page, 1))!;
    const rev0 = (await ih.snapshot(a.page)).committedRevision;
    expect((await ih.snapshot(a.page)).pendingCount).toBe(0);

    // A が編集を試みる（印字・paste・行挿入 API・Undo）→ 全て抑止＝文書 Operation 送信ゼロ。
    await ih.selectCell(a.page, 10, 1);
    await a.page.keyboard.press('a');
    await ih.dispatchSyntheticPaste(a.page, 'X');
    await a.page.evaluate(() => {
      (window as unknown as { __gridInstance?: { insertRows: (o: unknown) => void } }).__gridInstance?.insertRows({
        afterRowId: null,
        count: 1,
      });
    });
    await a.page.keyboard.press('Control+z');
    await a.page.waitForTimeout(200);

    const snapA = await ih.snapshot(a.page);
    expect(snapA.pendingCount, 'A の pending は恒常 0（送信ゼロ）').toBe(0);
    expect(snapA.committedRevision, 'A 自身の操作では committedRevision 不変').toBe(rev0);

    // B が同セルへ commit → A へ受信反映される（受信専用＝閲覧は生きている）。
    await ih.selectCell(b.page, 10, 1);
    await ih.plainTypeAndCommit(b.page, 'fromB');
    await expect
      .poll(async () => ih.committedCell(a.page, rowId, colId), { message: 'remote 更新が A の画面へ反映' })
      .toBe('fromB');

    // 受信後も A は送信していない（pending 0 のまま）。
    expect((await ih.snapshot(a.page)).pendingCount).toBe(0);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
