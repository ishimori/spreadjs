// DD-020-2 E2E: clipboard copy/cut/paste（共同編集モード）。
//
// 2 系統で検証する（親 Manual Gate の synthetic 自動化方針）:
//   ① 実 Ctrl+C/V/X＋実 Clipboard API（grantPermissions(['clipboard-read','clipboard-write'])）で round-trip
//      （CL-1 値/型保持・CL-2 敷き詰め・CL-4 cut・CL-6 OCC 2 クライアント）
//   ② 合成 ClipboardEvent（DataTransfer）で Excel 方言 fixture を byte 精密に注入（CL-5 引用内改行）・
//      composition 非干渉（CL-7）。
// 選択・値は Canvas に描かれ DOM から読めないため debug API（committedCell/committedCellKind/selectionRange）で観測する。

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  colIdAt,
  committedCell,
  committedCellKind,
  composeFinalizeAndCommit,
  composeOpen,
  connectionState,
  dispatchSyntheticPaste,
  dragSelect,
  grantClipboard,
  openClient,
  plainTypeAndCommit,
  readClipboard,
  rowIdAt,
  scrollTo,
  selectCell,
  selectionRange,
  simulateDrop,
  simulateReconnect,
  snapshot,
  writeClipboard,
} from './integration-helpers';

test.describe.configure({ mode: 'serial' });

/** (row,col) を選択して値を入力・確定し committed に反映されるまで待つ。 */
async function commitValue(page: Page, row: number, col: number, value: string): Promise<void> {
  const rowId = await rowIdAt(page, row);
  const columnId = await colIdAt(page, col);
  await selectCell(page, row, col);
  await plainTypeAndCommit(page, value);
  await expect
    .poll(async () => committedCell(page, rowId!, columnId!), { message: `(${row},${col})=${value} committed` })
    .toBe(value);
}

test('CL-1: グリッド内 copy→paste round-trip（実 Ctrl+C/V）→ 値と型（number/date/string）が保持される（AC3）', async ({
  browser,
}) => {
  const { context, page } = await openClient(browser, 'clip-roundtrip');
  await grantClipboard(context);
  try {
    // ソース 2×2 に型が分かれる値を committed 済みにする（number/date/string/number）。
    await commitValue(page, 5, 1, '123');
    await commitValue(page, 5, 2, '2026-07-16');
    await commitValue(page, 6, 1, 'hello');
    await commitValue(page, 6, 2, '42');

    // 範囲 (5,1)〜(6,2) をドラッグ選択して実 Ctrl+C。
    await dragSelect(page, { row: 5, col: 1 }, { row: 6, col: 2 });
    expect(await selectionRange(page)).toEqual({ rowStart: 5, rowEnd: 7, colStart: 1, colEnd: 3 });
    await page.keyboard.press('Control+c');

    // 実クリップボードに TSV が入る（EOL は正規化して比較）。
    await expect
      .poll(async () => (await readClipboard(page)).replace(/\r\n/g, '\n'), { message: 'copy TSV が clipboard へ' })
      .toBe('123\t2026-07-16\nhello\t42');

    // 貼り付け先 (10,1) を単一選択して実 Ctrl+V（左上アンカーから 2×2）。
    await selectCell(page, 10, 1);
    await page.keyboard.press('Control+v');

    const t = [
      [10, 1, '123', 'number'],
      [10, 2, '2026-07-16', 'date'],
      [11, 1, 'hello', 'string'],
      [11, 2, '42', 'number'],
    ] as const;
    for (const [row, col, value, kind] of t) {
      const rowId = await rowIdAt(page, row);
      const columnId = await colIdAt(page, col);
      await expect
        .poll(async () => committedCell(page, rowId!, columnId!), { message: `paste (${row},${col})=${value}` })
        .toBe(value);
      expect(await committedCellKind(page, rowId!, columnId!), `型 (${row},${col})`).toBe(kind);
    }
  } finally {
    await context.close();
  }
});

test('CL-2: 1×1 copy → 複数セル選択 paste → 選択範囲全体へ敷き詰め（AC7・実 Ctrl+C/V）', async ({ browser }) => {
  const { context, page } = await openClient(browser, 'clip-tile');
  await grantClipboard(context);
  try {
    await commitValue(page, 5, 1, 'fill');
    await selectCell(page, 5, 1);
    await page.keyboard.press('Control+c');
    await expect.poll(async () => readClipboard(page), { message: '1×1 TSV' }).toBe('fill');

    // (8,1)〜(9,2) の 4 セルを選択して paste → 全セルへ 'fill'。
    await dragSelect(page, { row: 8, col: 1 }, { row: 9, col: 2 });
    await page.keyboard.press('Control+v');
    for (const [row, col] of [[8, 1], [8, 2], [9, 1], [9, 2]] as const) {
      const rowId = await rowIdAt(page, row);
      const columnId = await colIdAt(page, col);
      await expect
        .poll(async () => committedCell(page, rowId!, columnId!), { message: `敷き詰め (${row},${col})` })
        .toBe('fill');
    }
  } finally {
    await context.close();
  }
});

test('CL-4: cut（実 Ctrl+X）→ clipboard へ TSV・元範囲は原子クリア・貼り付け先で値再現（AC8）', async ({
  browser,
}) => {
  const { context, page } = await openClient(browser, 'clip-cut');
  await grantClipboard(context);
  try {
    await commitValue(page, 5, 1, 'cut1');
    await commitValue(page, 5, 2, 'cut2');
    const srcRow = await rowIdAt(page, 5);
    const col1 = await colIdAt(page, 1);
    const col2 = await colIdAt(page, 2);

    await dragSelect(page, { row: 5, col: 1 }, { row: 5, col: 2 });
    await page.keyboard.press('Control+x');

    // clipboard に TSV・元範囲は空へ（原子クリア）。
    await expect.poll(async () => readClipboard(page), { message: 'cut TSV' }).toBe('cut1\tcut2');
    await expect.poll(async () => committedCell(page, srcRow!, col1!), { message: '元 (5,1) クリア' }).toBe('');
    await expect.poll(async () => committedCell(page, srcRow!, col2!), { message: '元 (5,2) クリア' }).toBe('');

    // 貼り付け先で再現。
    await selectCell(page, 12, 1);
    await page.keyboard.press('Control+v');
    const dstRow = await rowIdAt(page, 12);
    await expect.poll(async () => committedCell(page, dstRow!, col1!), { message: 'paste (12,1)' }).toBe('cut1');
    await expect.poll(async () => committedCell(page, dstRow!, col2!), { message: 'paste (12,2)' }).toBe('cut2');
  } finally {
    await context.close();
  }
});

test('CL-3: 下端はみ出し paste → 実行前拒否（AC6・paste-out-of-bounds・submit なし・通知）', async ({ browser }) => {
  const { context, page } = await openClient(browser, 'clip-oob');
  await grantClipboard(context);
  try {
    // rejected 通知を公開契約（subscribe）で捕捉する。
    await page.evaluate(() => {
      const w = window as unknown as {
        __gridInstance?: { subscribe(l: (e: unknown) => void): () => void };
        __rejectedCodes?: string[];
      };
      w.__rejectedCodes = [];
      w.__gridInstance?.subscribe((e) => {
        const ev = e as { type: string; conflict?: { code: string } };
        if (ev.type === 'rejected' && ev.conflict !== undefined) {
          w.__rejectedCodes?.push(ev.conflict.code);
        }
      });
    });

    // 最下行付近へスクロールして (49999,1) を選択。2 行 TSV を貼ると行末を越える。
    await scrollTo(page, 49_999 * 22, 0);
    await expect
      .poll(async () => selectCell(page, 49_999, 1).then(() => true).catch(() => false), { message: '最下行可視' })
      .toBe(true);
    const before = await snapshot(page);
    await writeClipboard(page, 'x\ny'); // 2 行（parseClipboardText→[['x'],['y']]）
    await page.keyboard.press('Control+v');

    await expect
      .poll(
        async () => page.evaluate(() => (window as unknown as { __rejectedCodes?: string[] }).__rejectedCodes ?? []),
        { message: 'paste-out-of-bounds 通知' },
      )
      .toContain('paste-out-of-bounds');
    // submit されない（committedRevision・pendingCount 不変）。
    const after = await snapshot(page);
    expect(after.committedRevision).toBe(before.committedRevision);
    expect(after.pendingCount).toBe(0);
  } finally {
    await context.close();
  }
});

test('CL-5: Excel 方言 fixture 注入（引用内改行）→ セル内改行として正しく貼り付け（AC1・合成 ClipboardEvent）', async ({
  browser,
}) => {
  const { context, page } = await openClient(browser, 'clip-dialect');
  try {
    await selectCell(page, 14, 1);
    // "line1\nline2"\tplain（引用内改行＝Excel Alt+Enter 相当）。DataTransfer で byte 精密に注入する。
    const prevented = await dispatchSyntheticPaste(page, '"line1\nline2"\tplain');
    expect(prevented, 'グリッドが paste を消費（preventDefault）').toBe(true);

    const rowId = await rowIdAt(page, 14);
    const col1 = await colIdAt(page, 1);
    const col2 = await colIdAt(page, 2);
    await expect
      .poll(async () => committedCell(page, rowId!, col1!), { message: 'セル内改行が保持される' })
      .toBe('line1\nline2');
    await expect.poll(async () => committedCell(page, rowId!, col2!), { message: '隣接セル' }).toBe('plain');
  } finally {
    await context.close();
  }
});

test('CL-6: 2 クライアント OCC — 範囲内セルの先行変更で paste 全体 reject・収束・文書無変更（AC5）', async ({
  browser,
}) => {
  const a = await openClient(browser, 'clip-occ-A');
  const b = await openClient(browser, 'clip-occ-B');
  await grantClipboard(a.context);
  try {
    // A が (25,1)(25,2) を committed 済みにし、コピー元 TSV を実クリップボードへ用意する。
    await commitValue(a.page, 25, 1, 'srcP');
    await commitValue(a.page, 25, 2, 'srcQ');
    const rowId = await rowIdAt(a.page, 25);
    const col1 = await colIdAt(a.page, 1);
    const col2 = await colIdAt(a.page, 2);
    await commitValue(a.page, 26, 1, 'baseR'); // 貼り付け先 (26,1)(26,2) の初期値
    await commitValue(a.page, 26, 2, 'baseS');
    await expect.poll(async () => (await snapshot(a.page)).pendingCount, { message: 'A pending 空' }).toBe(0);
    await expect.poll(async () => committedCell(b.page, rowId!, col1!), { message: 'B が A を受信' }).toBe('srcP');

    // A が (25,*) をコピー → 貼り付け先 (26,1) を選択 → 切断。
    await dragSelect(a.page, { row: 25, col: 1 }, { row: 25, col: 2 });
    await a.page.keyboard.press('Control+c');
    await expect.poll(async () => readClipboard(a.page), { message: 'copy TSV' }).toBe('srcP\tsrcQ');
    await selectCell(a.page, 26, 1);
    await simulateDrop(a.page);
    await expect.poll(() => connectionState(a.page), { message: 'A offline' }).toBe('offline');

    // B が貼り付け範囲内 (26,1) を先に確定（サーバー committed 前進）。
    const dstRow = await rowIdAt(b.page, 26);
    await commitValue(b.page, 26, 1, 'occ-b');

    // A（offline）が paste → ローカル楽観適用（pending=1）。
    await a.page.keyboard.press('Control+v');
    await expect
      .poll(async () => (await snapshot(a.page)).pendingCount, { message: 'A の paste が pending' })
      .toBe(1);

    // 再接続 → catch-up で B の確定を取り込み、A の paste SetCells は stale で全体 reject。
    await simulateReconnect(a.page);
    await expect.poll(() => connectionState(a.page), { timeout: 30_000, message: 'A online' }).toBe('online');
    await expect
      .poll(
        async () =>
          (await committedCell(a.page, dstRow!, col1!)) === 'occ-b' &&
          (await committedCell(a.page, dstRow!, col2!)) === 'baseS' &&
          (await snapshot(a.page)).pendingCount === 0,
        { timeout: 15_000, message: 'A が全体 reject 後も文書無変更で収束（部分適用なし）' },
      )
      .toBe(true);
    // A/B の committed hash 一致（収束）。
    expect((await snapshot(a.page)).committedHash).toBe((await snapshot(b.page)).committedHash);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('CL-7: composition 中の paste はグリッド paste を発火しない（AC10・IME 非干渉・合成）', async ({ browser }) => {
  const { context, page } = await openClient(browser, 'clip-ime');
  try {
    const rowId = await rowIdAt(page, 30);
    const columnId = await colIdAt(page, 1);
    await selectCell(page, 30, 1);
    await composeOpen(page, ['に', 'にほ', 'にほん']);
    await expect.poll(async () => (await snapshot(page)).isComposing, { message: '変換中' }).toBe(true);
    const revBefore = (await snapshot(page)).committedRevision;

    // 変換中に paste イベント → グリッドは消費しない（clipboardActive=false）・draft/composing 不変。
    const prevented = await dispatchSyntheticPaste(page, 'PASTED');
    expect(prevented, 'composition 中はグリッドが消費しない（ブラウザ既定へ委譲）').toBe(false);
    const s = await snapshot(page);
    expect(s.committedRevision, 'paste で committed が動かない').toBe(revBefore);
    expect(s.isComposing).toBe(true);
    expect(s.draft).toBe('にほん');

    // 変換確定 → 通常どおり commit できる（draft が失われていない）。
    await composeFinalizeAndCommit(page, 'にほん');
    await expect
      .poll(async () => committedCell(page, rowId!, columnId!), { message: '確定値が committed へ' })
      .toBe('にほん');
  } finally {
    await context.close();
  }
});

// ---- DD-038: 貼り付け後の選択レンジ（CL-8〜CL-12） --------------------------------------------
//
// 貼り付けた直後に貼付範囲を選択レンジにする（Excel 準拠）。**activeCell が矩形の左上へ移ること**が
// 挙動の中核: selection-controller の不変条件「明示レンジは anchor === activeCell の間だけ存在する」を
// 満たさないと、貼った直後は見えていても次の editor イベントで選択が消えるため（DD-038 決定①）。

/** 他クライアント側から行を挿入する（DD-021-3 の再ベースを起こす。row-rebase.spec.ts と同じ経路）。 */
async function insertRowAfter(page: Page, afterRowId: string): Promise<void> {
  await page.evaluate((id: string) => {
    const inst = (window as unknown as { __gridInstance?: { insertRows(o: unknown): void } }).__gridInstance;
    if (inst === undefined) {
      throw new Error('__gridInstance が無い');
    }
    inst.insertRows({ afterRowId: id });
  }, afterRowId);
}

test('CL-8: 3行×2列 paste → 貼付範囲が選択レンジになり activeCell は左上（AC1）／直後の Delete が貼付範囲だけを消す（AC2）', async ({
  browser,
}) => {
  const { context, page } = await openClient(browser, 'clip-paste-select');
  await grantClipboard(context);
  try {
    // ソース 3×2（(5,1)〜(7,2)）を committed 済みにして copy。
    for (const [row, col, v] of [
      [5, 1, 'p1'], [5, 2, 'q1'],
      [6, 1, 'p2'], [6, 2, 'q2'],
      [7, 1, 'p3'], [7, 2, 'q3'],
    ] as const) {
      await commitValue(page, row, col, v);
    }
    await dragSelect(page, { row: 5, col: 1 }, { row: 7, col: 2 });
    await page.keyboard.press('Control+c');
    await expect
      .poll(async () => (await readClipboard(page)).replace(/\r\n/g, '\n'), { message: 'copy TSV（3行×2列）' })
      .toBe('p1\tq1\np2\tq2\np3\tq3');

    // 貼り付け先 (15,1) を単一選択（明示レンジ無し）→ paste。
    await selectCell(page, 15, 1);
    expect(await selectionRange(page), '貼る前は明示レンジ無し').toBeNull();
    await page.keyboard.press('Control+v');

    const dstRow = await rowIdAt(page, 15);
    const col1 = await colIdAt(page, 1);
    await expect.poll(async () => committedCell(page, dstRow!, col1!), { message: 'paste が反映' }).toBe('p1');

    // AC1: 貼付範囲 3×2 が選択レンジ（半開区間）になり、activeCell は矩形の左上（不変条件 anchor===activeCell）。
    await expect
      .poll(async () => selectionRange(page), { message: '貼付範囲が選択レンジへ' })
      .toEqual({ rowStart: 15, rowEnd: 18, colStart: 1, colEnd: 3 });
    expect((await snapshot(page)).activeCell, 'activeCell は貼付矩形の左上').toEqual({ row: 15, col: 1 });

    // AC2: そのまま Delete → 貼り付けた 6 セルだけが消える（選択が後続操作に効く）。
    await page.keyboard.press('Delete');
    for (const [row, col] of [[15, 1], [15, 2], [16, 1], [16, 2], [17, 1], [17, 2]] as const) {
      const r = await rowIdAt(page, row);
      const c = await colIdAt(page, col);
      await expect
        .poll(async () => committedCell(page, r!, c!), { message: `Delete で (${row},${col}) がクリア` })
        .toBe('');
    }
    // コピー元（範囲外）は無傷＝消えたのは貼付範囲だけ。
    const srcRow = await rowIdAt(page, 5);
    expect(await committedCell(page, srcRow!, col1!), 'コピー元 (5,1) は無傷').toBe('p1');
  } finally {
    await context.close();
  }
});

test('CL-9: 右下→左上へドラッグ選択して敷き詰め paste → 選択は貼付前の範囲のまま・activeCell が左上へ移る（AC4・AC5）', async ({
  browser,
}) => {
  const { context, page } = await openClient(browser, 'clip-paste-anchor');
  await grantClipboard(context);
  try {
    await commitValue(page, 3, 1, 'fill');
    await selectCell(page, 3, 1);
    await page.keyboard.press('Control+c');
    await expect.poll(async () => readClipboard(page), { message: '1×1 TSV' }).toBe('fill');

    // **右下 (12,2) から左上 (10,1) へ**ドラッグ: 選択 anchor = activeCell = 右下、矩形の左上は別セル。
    // これが決定①で (b) が不成立になるケース。貼付アンカーは矩形の左上 (10,1)。
    await dragSelect(page, { row: 12, col: 2 }, { row: 10, col: 1 });
    expect(await selectionRange(page), '貼る前の選択矩形').toEqual({
      rowStart: 10, rowEnd: 13, colStart: 1, colEnd: 3,
    });
    expect((await snapshot(page)).activeCell, '貼る前の activeCell は右下（ドラッグ開始点）').toEqual({
      row: 12, col: 2,
    });

    await page.keyboard.press('Control+v'); // 1×1 → 選択範囲 3×2 へ敷き詰め

    for (const [row, col] of [[10, 1], [10, 2], [11, 1], [11, 2], [12, 1], [12, 2]] as const) {
      const r = await rowIdAt(page, row);
      const c = await colIdAt(page, col);
      await expect
        .poll(async () => committedCell(page, r!, c!), { message: `敷き詰め (${row},${col})` })
        .toBe('fill');
    }
    // AC5: 選択は貼り付け前の範囲のまま（貼付矩形と一致）。
    expect(await selectionRange(page), '選択は貼付前の範囲のまま').toEqual({
      rowStart: 10, rowEnd: 13, colStart: 1, colEnd: 3,
    });
    // AC4: activeCell が矩形の左上へ移っている＝不変条件が成立している（(b) なら右下のまま）。
    expect((await snapshot(page)).activeCell, 'activeCell が貼付矩形の左上へ移る').toEqual({ row: 10, col: 1 });

    // 選択が「生きている」ことの実証: Delete が貼付範囲だけに効く。
    await page.keyboard.press('Delete');
    for (const [row, col] of [[10, 1], [12, 2]] as const) {
      const r = await rowIdAt(page, row);
      const c = await colIdAt(page, col);
      await expect
        .poll(async () => committedCell(page, r!, c!), { message: `Delete で (${row},${col}) がクリア` })
        .toBe('');
    }
  } finally {
    await context.close();
  }
});

test('CL-10: 1×1 を単一セルへ paste → 明示レンジは形成されず activeCell も動かない（AC3）', async ({ browser }) => {
  const { context, page } = await openClient(browser, 'clip-paste-1x1');
  await grantClipboard(context);
  try {
    await commitValue(page, 4, 1, 'solo');
    await selectCell(page, 4, 1);
    await page.keyboard.press('Control+c');
    await expect.poll(async () => readClipboard(page), { message: '1×1 TSV' }).toBe('solo');

    await selectCell(page, 9, 3);
    await page.keyboard.press('Control+v');

    const dstRow = await rowIdAt(page, 9);
    const col3 = await colIdAt(page, 3);
    await expect.poll(async () => committedCell(page, dstRow!, col3!), { message: 'paste 反映' }).toBe('solo');
    // 1×1 は setRange が単一選択へ正規化する＝明示レンジを作らない（見た目の変化なし）。
    expect(await selectionRange(page), '1×1 では明示レンジを作らない').toBeNull();
    expect((await snapshot(page)).activeCell, 'activeCell は貼り付け先のまま').toEqual({ row: 9, col: 3 });
  } finally {
    await context.close();
  }
});

test('CL-11: noop・上限超過・はみ出しの各拒否経路で選択も activeCell も変わらない（AC6）', async ({
  browser,
}) => {
  const { context, page } = await openClient(browser, 'clip-paste-reject');
  try {
    // 拒否経路は合成 ClipboardEvent で投げる（実クリップボード・スクロールに依存させない＝決定的）。
    // 明示レンジを作ってから拒否・noop の paste を投げ、選択が保存されることを見る。
    await dragSelect(page, { row: 5, col: 1 }, { row: 6, col: 2 });
    const range0 = { rowStart: 5, rowEnd: 7, colStart: 1, colEnd: 3 };
    expect(await selectionRange(page)).toEqual(range0);
    const before = await snapshot(page);

    // ① 空 paste → parseClipboardText('')=[] → noop（消費のみ・文書無変更）。
    expect(await dispatchSyntheticPaste(page, ''), '空 paste もグリッドが消費する').toBe(true);
    expect(await selectionRange(page), 'noop で選択は不変').toEqual(range0);
    let after = await snapshot(page);
    expect(after.activeCell, 'noop で activeCell は不変').toEqual(before.activeCell);
    expect(after.committedRevision, 'noop で文書は無変更').toBe(before.committedRevision);
    expect(after.pendingCount, 'noop は submit しない').toBe(0);

    // ② 上限超過（1 行 × 100,001 セル > SETCELLS_MAX_CELLS）→ 実行前拒否。選択・activeCell とも不変。
    const tooLarge = Array.from({ length: 100_001 }, () => 'x').join('\t');
    expect(await dispatchSyntheticPaste(page, tooLarge), '上限超過もグリッドが消費する').toBe(true);
    expect(await selectionRange(page), '上限超過で選択は不変').toEqual(range0);
    after = await snapshot(page);
    expect(after.activeCell, '上限超過で activeCell は不変').toEqual(before.activeCell);
    expect(after.committedRevision, '上限超過で文書は無変更').toBe(before.committedRevision);
    expect(after.pendingCount, '上限超過は submit しない').toBe(0);

    // はみ出し（out-of-bounds）での選択不変は、行数・列数が小さく端の到達にスクロールが要らない
    // standalone ハーネス側（paste-selection.spec.ts）で検証する。ここは巨大 Axis ゆえ端の選択が
    // ensureActiveCellVisible と競合して不安定になるため扱わない（拒否そのものは CL-3 が担保）。
  } finally {
    await context.close();
  }
});

test('CL-12: 他クライアントの paste では自分の選択も activeCell も動かない（AC11）', async ({ browser }) => {
  // 2 コンテキストでは OS フォーカスを持てる方が 1 つだけで navigator.clipboard.readText() が解決しないため、
  // ここは実クリップボードを使わず合成 ClipboardEvent で貼る（検証対象は選択の非干渉であってクリップボード経路ではない）。
  const a = await openClient(browser, 'clip-paste-remote-A');
  const b = await openClient(browser, 'clip-paste-remote-B');
  try {
    await dragSelect(a.page, { row: 5, col: 1 }, { row: 6, col: 2 });
    const aRange = { rowStart: 5, rowEnd: 7, colStart: 1, colEnd: 3 };
    expect(await selectionRange(a.page), 'A が明示レンジを持つ').toEqual(aRange);
    const aActive = (await snapshot(a.page)).activeCell;

    // B が 2×1 を貼り付ける（A の選択範囲とは無関係な位置）。行は初期スクロール位置で可視な範囲から選ぶ
    // （選択は実クリックで行うため、画面外の行を指定するとクリックが別の行へ落ちる）。
    await selectCell(b.page, 25, 1);
    expect(await dispatchSyntheticPaste(b.page, 'bsrc1\nbsrc2'), 'B の paste が成立').toBe(true);
    const bRow = await rowIdAt(b.page, 25);
    const col1 = await colIdAt(b.page, 1);
    await expect
      .poll(async () => selectionRange(b.page), { message: 'B 自身には貼付範囲の選択が付く' })
      .toEqual({ rowStart: 25, rowEnd: 27, colStart: 1, colEnd: 2 });

    // A が B の貼り付けを受信してもなお、A の選択・activeCell は不変（リモート適用は performPaste を通らない）。
    await expect
      .poll(async () => committedCell(a.page, bRow!, col1!), { message: 'A が B の paste を受信' })
      .toBe('bsrc1');
    expect(await selectionRange(a.page), 'B の paste で A の選択は動かない').toEqual(aRange);
    expect((await snapshot(a.page)).activeCell, 'B の paste で A の activeCell は動かない').toEqual(aActive);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('CL-13: 貼り付け後にリモートで行が挿入されると選択レンジが再ベースされる（AC10・DD-021-3 が従来どおり）', async ({
  browser,
}) => {
  const a = await openClient(browser, 'clip-paste-rebase-A');
  const b = await openClient(browser, 'clip-paste-rebase-B');
  try {
    // A が (20,1) へ 2×1 を貼る → 貼付範囲が選択レンジになる。
    await selectCell(a.page, 20, 1);
    expect(await dispatchSyntheticPaste(a.page, 'r1\nr2'), 'A の paste が成立').toBe(true);
    await expect
      .poll(async () => selectionRange(a.page), { message: 'A の貼付範囲が選択レンジへ' })
      .toEqual({ rowStart: 20, rowEnd: 22, colStart: 1, colEnd: 2 });
    expect((await snapshot(a.page)).activeCell, 'activeCell は矩形の左上').toEqual({ row: 20, col: 1 });

    // B が A の貼付範囲より上へ 1 行挿入 → A の表示 index が 1 つ下へずれる。
    const anchorRow = await rowIdAt(b.page, 18);
    await insertRowAfter(b.page, anchorRow!);

    await expect
      .poll(async () => selectionRange(a.page), { timeout: 15_000, message: '選択レンジが 1 行下へ再ベース' })
      .toEqual({ rowStart: 21, rowEnd: 23, colStart: 1, colEnd: 2 });
    expect((await snapshot(a.page)).activeCell, 'activeCell も追随（不変条件 anchor===activeCell を維持）').toEqual({
      row: 21,
      col: 1,
    });
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
