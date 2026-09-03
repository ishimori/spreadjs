// DD-005 Phase 4 統合 E2E の共有ヘルパー（テスト本体は *.spec.ts のみ・本ファイルは testMatch 外）。
//
// ⚠️ synthetic composition について（§11.8 / §20.5）:
//   Playwright/Chromium は OS の実 IME（Microsoft IME / Google 日本語入力）を通せない。ここで dispatch する
//   CompositionEvent 列は「状態遷移・追従・#9 レイアウトの配線が実ブラウザーで成立する」ことの回帰確認であり、
//   **実 IME の成立（候補ウィンドウ・確定 Enter 実発火順 A/B・ブラウザー差）ではない**。実 IME の判定は Phase 5
//   実機ゲート（doc/DD/DD-005/manual-integration-test-guide.md）で行う。
//
// 統合ページの値は Canvas に描かれ DOM から読めないため、ClientSession（唯一の正本）の状態は
//   window.__integrationTestApi（main.ts が公開する **読み取り専用の観測 ＋ AC4 構造Op投入** フック）で検証する。
//   観測系は挙動を変えず、submitInsertRowsAfter/submitDeleteRow は本番 ClientSession.submitLocalOperation を
//   呼ぶだけ（PoC UI に行挿入/削除ボタンが無いための最小アフォーダンス・結果は本番コードが生成）。
//
// 【重要】page.evaluate のコールバックはブラウザーへ転送されるため、Node 側の関数を参照できない。
//   API 呼び出しは「メソッド名＋引数（＝シリアライズ可能なデータ）」を callApi へ渡して間接呼び出しする。

import { fileURLToPath } from 'node:url';

import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** 統合 E2E 用 WS サーバー origin（playwright.config.ts の WS_PORT と一致させること）。 */
export const WS_ORIGIN = 'http://127.0.0.1:8799';

export interface CellAddress {
  rowId: string;
  columnId: string;
}
export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SelectionRange {
  startRowId: string;
  startColumnId: string;
  endRowId: string;
  endColumnId: string;
}
export interface IntegrationPresenceView {
  displayName: string;
  activeCell: CellAddress | null;
  editingCell: CellAddress | null;
  selectionRanges: SelectionRange[];
}

/** 0 引数の観測値をまとめて 1 往復で取得する（expect.poll から呼ぶ）。 */
export interface Snapshot {
  ready: boolean;
  online: boolean;
  rowCount: number;
  committedRevision: number;
  committedHash: string;
  pendingCount: number;
  conflictCount: number;
  divertedCount: number;
  knownPresenceCount: number;
  isConflicting: boolean;
  isTargetLost: boolean;
  isComposing: boolean;
  draft: string;
  activeCell: { row: number; col: number };
  editingTarget: CellAddress | null;
  presences: IntegrationPresenceView[];
}

/** window.__integrationTestApi.<method>(...args) をブラウザー内で呼ぶ（method/args はデータとして転送）。 */
async function callApi<R>(page: Page, method: string, args: unknown[] = []): Promise<R> {
  return page.evaluate(
    (payload: { method: string; args: unknown[] }) => {
      const api = (window as unknown as {
        __integrationTestApi?: Record<string, (...a: unknown[]) => unknown>;
      }).__integrationTestApi;
      if (api === undefined) {
        throw new Error('window.__integrationTestApi 未初期化（boot 未完了）');
      }
      const fn = api[payload.method];
      if (typeof fn !== 'function') {
        throw new Error(`window.__integrationTestApi.${payload.method} が無い`);
      }
      return fn.apply(api, payload.args);
    },
    { method, args },
  ) as Promise<R>;
}

export async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const api = (window as unknown as { __integrationTestApi?: Record<string, () => unknown> })
      .__integrationTestApi;
    if (api === undefined) {
      throw new Error('window.__integrationTestApi 未初期化（boot 未完了）');
    }
    const call = <T>(name: string): T => (api[name] as () => T)();
    return {
      ready: call<boolean>('ready'),
      online: call<boolean>('online'),
      rowCount: call<number>('rowCount'),
      committedRevision: call<number>('committedRevision'),
      committedHash: call<string>('committedHash'),
      pendingCount: call<number>('pendingCount'),
      conflictCount: call<number>('conflictCount'),
      divertedCount: call<number>('divertedCount'),
      knownPresenceCount: call<number>('knownPresenceCount'),
      isConflicting: call<boolean>('isConflicting'),
      isTargetLost: call<boolean>('isTargetLost'),
      isComposing: call<boolean>('isComposing'),
      draft: call<string>('draft'),
      activeCell: call<{ row: number; col: number }>('activeCell'),
      editingTarget: call<CellAddress | null>('editingTarget'),
      presences: call<IntegrationPresenceView[]>('presences'),
    };
  });
}

/**
 * 新しいクライアント（別ブラウザーコンテキスト＝別ユーザー）を開き、50,000行の初期ロード完了まで待つ。
 * extraQuery で追加のクエリ（例 DD-012-5 の `wrap=col-2`）を渡せる。
 */
export async function openClient(
  browser: Browser,
  name: string,
  extraQuery?: Record<string, string>,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const extra = Object.entries(extraQuery ?? {})
    .map(([k, v]) => `&${k}=${encodeURIComponent(v)}`)
    .join('');
  const url = `/poc-integration.html?name=${encodeURIComponent(name)}&server=${encodeURIComponent(WS_ORIGIN)}${extra}`;
  await page.goto(url);
  // 常駐 textarea（boot 完了の目印）＋初期 replay（50,000行）完了を待つ。初期ロードは 18MB replay ではなく
  // E2E 用の縮小シード（SEED_NONEMPTY=3000・行数 50,000 維持）なので数百 ms で ready になる。
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached({ timeout: 30_000 });
  await expect
    .poll(async () => (await snapshot(page)).ready, { timeout: 30_000, message: `${name} が ready にならない` })
    .toBe(true);
  const s = await snapshot(page);
  expect(s.online, `${name} online`).toBe(true);
  expect(s.rowCount, `${name} 50,000行`).toBeGreaterThanOrEqual(50_000);
  return { context, page };
}

/** 表示 (row, col) のセルをクリックして選択する（本番 transform の矩形中心を click）。 */
export async function selectCell(page: Page, row: number, col: number): Promise<void> {
  const rect = await callApi<CellRect | null>(page, 'cellRectAt', [row, col]);
  if (rect === null) {
    throw new Error(`セル (${row},${col}) が可視範囲にない`);
  }
  await page
    .locator('.nsheet-scroller')
    .click({ position: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } });
}

/** 表示 index の矩形範囲（半開区間・DD-020-1）。 */
export interface CellRangeView {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

/** DD-020-1: 明示的な矩形選択レンジ（null=単一セル選択のみ）。 */
export async function selectionRange(page: Page): Promise<CellRangeView | null> {
  return callApi<CellRangeView | null>(page, 'selectionRange', []);
}

/** DD-020-1: ドラッグ中のライブ矩形（null=非ドラッグ）。 */
export async function dragRange(page: Page): Promise<CellRangeView | null> {
  return callApi<CellRangeView | null>(page, 'dragRange', []);
}

// ---- DD-027-1 選択式入力列 E2E ヘルパー ----------------------------------------------------
/** 選択式ドロップダウンが開いているか。 */
export async function selectOpen(page: Page): Promise<boolean> {
  return callApi<boolean>(page, 'selectOpen', []);
}
/** 選択式ドロップダウンの候補一覧。 */
export async function selectOptions(page: Page): Promise<string[]> {
  return callApi<string[]>(page, 'selectOptions', []);
}
/** 選択式ドロップダウンのハイライト index（未 open は -1）。 */
export async function selectHighlightedIndex(page: Page): Promise<number> {
  return callApi<number>(page, 'selectHighlightedIndex', []);
}
/** 選択式ドロップダウンのハイライト値（未 open は null）。 */
export async function selectHighlightedValue(page: Page): Promise<string | null> {
  return callApi<string | null>(page, 'selectHighlightedValue', []);
}
/** #int-status のテキスト（rejected 通知 code=value-not-allowed の観測に使う）。 */
export async function statusText(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('int-status')?.textContent ?? '');
}

/** DD-020-3: Undo スタック深さ。 */
export async function undoDepth(page: Page): Promise<number> {
  return callApi<number>(page, 'undoDepth', []);
}
/** DD-020-3: Redo スタック深さ。 */
export async function redoDepth(page: Page): Promise<number> {
  return callApi<number>(page, 'redoDepth', []);
}
/** DD-020-3: 現在 Undo 可能か。 */
export async function canUndo(page: Page): Promise<boolean> {
  return callApi<boolean>(page, 'canUndo', []);
}

/** 表示 (row,col) セル中心の page 座標（scroller boundingBox + 本番 transform 矩形から算出）。 */
export async function cellCenter(page: Page, row: number, col: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('.nsheet-scroller').boundingBox();
  const rect = await callApi<CellRect | null>(page, 'cellRectAt', [row, col]);
  if (box === null || rect === null) {
    throw new Error(`セル (${row},${col}) が可視範囲にない`);
  }
  return { x: box.x + rect.x + rect.width / 2, y: box.y + rect.y + rect.height / 2 };
}

/** DD-020-1: セル (fromRow,fromCol) から (toRow,toCol) まで実マウスでドラッグ選択する。 */
export async function dragSelect(
  page: Page,
  from: { row: number; col: number },
  to: { row: number; col: number },
): Promise<void> {
  const start = await cellCenter(page, from.row, from.col);
  const end = await cellCenter(page, to.row, to.col);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
}

/** DD-020-1: Shift を押しながらセルをクリックする（レンジ拡張）。 */
export async function shiftClickCell(page: Page, row: number, col: number): Promise<void> {
  const center = await cellCenter(page, row, col);
  await page.keyboard.down('Shift');
  await page.mouse.click(center.x, center.y);
  await page.keyboard.up('Shift');
}

/**
 * synthetic composition を開始し変換中のまま留める（isComposing:true）。steps は変換途中→確定候補文字列。
 * ブラウザーが変換中に textarea.value を更新する挙動を再現する（状態機械は I-3 で value を触らない）。
 */
export async function composeOpen(page: Page, steps: string[]): Promise<void> {
  await page.evaluate((seq: string[]) => {
    const ta = document.querySelector('textarea.int-cell-editor');
    if (!(ta instanceof HTMLTextAreaElement)) {
      throw new Error('int-cell-editor が見つからない');
    }
    ta.focus();
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    for (const s of seq) {
      ta.value = s;
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: s, bubbles: true }));
    }
  }, steps);
}

/** 変換を続行する（同一 draft の compositionupdate を 1 回）。#9 競合視覚（赤枠＋badge）を再評価させるのに使う。 */
export async function composeContinue(page: Page, data: string): Promise<void> {
  await page.evaluate((d: string) => {
    const ta = document.querySelector('textarea.int-cell-editor');
    if (!(ta instanceof HTMLTextAreaElement)) {
      throw new Error('int-cell-editor が見つからない');
    }
    ta.value = d;
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: d, bubbles: true }));
  }, data);
}

/**
 * 変換を確定し（compositionend→input→keyup で抑止窓を解除）、確定 Enter で Commit する。
 * サーバーが受理するか reject するかは beforeRevision 次第（AC1=受理 / AC2=stale で reject）。
 */
export async function composeFinalizeAndCommit(page: Page, finalData: string): Promise<void> {
  await page.evaluate((data: string) => {
    const ta = document.querySelector('textarea.int-cell-editor');
    if (!(ta instanceof HTMLTextAreaElement)) {
      throw new Error('int-cell-editor が見つからない');
    }
    ta.dispatchEvent(new CompositionEvent('compositionend', { data, bubbles: true }));
    ta.value = data;
    ta.dispatchEvent(
      new InputEvent('input', { inputType: 'insertCompositionText', data, isComposing: false, bubbles: true }),
    );
    // compositionend が立てた suppressCommitUntilKeyup（順序B の抑止窓）を keyup で解除する。
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', isComposing: false, bubbles: true }));
  }, finalData);
  // 確定 Enter（本物のキー）。状態機械が consume→preventDefault するため改行は入らない。
  await page.keyboard.press('Enter');
}

/** 非 IME の直接入力で置換編集し Enter で確定する（別クライアントの通常更新の再現）。 */
export async function plainTypeAndCommit(page: Page, text: string): Promise<void> {
  await page.locator('textarea.int-cell-editor').focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/** #int-scroller を絶対座標へスクロールし scroll イベントを発火する（rAF 反映は呼び出し側が poll）。 */
export async function scrollTo(page: Page, top: number, left: number): Promise<void> {
  await page.evaluate(
    (pos: { top: number; left: number }) => {
      const sc = document.querySelector('.nsheet-scroller');
      if (sc === null) {
        throw new Error('.nsheet-scroller が見つからない');
      }
      sc.scrollTop = pos.top;
      sc.scrollLeft = pos.left;
      sc.dispatchEvent(new Event('scroll'));
    },
    { top, left },
  );
}

/** 常駐 textarea の現在位置・値・選択・表示状態を読む（AC3 の追従・不変検証用）。 */
export async function editorProbe(page: Page): Promise<{
  left: string;
  top: string;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  display: string;
}> {
  return page.locator('textarea.int-cell-editor').evaluate((el) => {
    const ta = el as HTMLTextAreaElement;
    return {
      left: ta.style.left,
      top: ta.style.top,
      value: ta.value,
      selectionStart: ta.selectionStart,
      selectionEnd: ta.selectionEnd,
      display: ta.style.display,
    };
  });
}

/** 表示 (row,col) セルの viewport 矩形（可視外は null）。DD-012-4 リサイズ後の幅・高の検証に使う。 */
export async function cellRectAt(page: Page, row: number, col: number): Promise<CellRect | null> {
  return callApi<CellRect | null>(page, 'cellRectAt', [row, col]);
}
/** DD-012-4: 列記号ヘッダーの矩形（境界ドラッグ開始点の算出・幅検証）。 */
export async function columnHeaderRectAt(page: Page, col: number): Promise<CellRect | null> {
  return callApi<CellRect | null>(page, 'columnHeaderRectAt', [col]);
}
/** DD-012-4: 行番号ヘッダーの矩形（境界ドラッグ開始点の算出・高検証）。 */
export async function rowHeaderRectAt(page: Page, row: number): Promise<CellRect | null> {
  return callApi<CellRect | null>(page, 'rowHeaderRectAt', [row]);
}
/** DD-012-4: 列幅 override のスナップショット（layout の override-only 内容の検証）。 */
export async function columnWidthOverrides(page: Page): Promise<Record<string, number>> {
  return callApi<Record<string, number>>(page, 'columnWidthOverrides', []);
}
/** DD-012-4: 行高 override のスナップショット。 */
export async function rowHeightOverrides(page: Page): Promise<Record<string, number>> {
  return callApi<Record<string, number>>(page, 'rowHeightOverrides', []);
}

/** 表示 index → RowId/ColumnId 文字列（クライアント間で同一）。 */
export async function rowIdAt(page: Page, index: number): Promise<string | undefined> {
  return callApi<string | undefined>(page, 'rowIdAt', [index]);
}
export async function colIdAt(page: Page, index: number): Promise<string | undefined> {
  return callApi<string | undefined>(page, 'colIdAt', [index]);
}
export async function committedCell(page: Page, rowId: string, columnId: string): Promise<string> {
  return callApi<string>(page, 'committedCell', [rowId, columnId]);
}
/** DD-020-2: committed セルの CellScalar kind（paste の型保持検証用）。 */
export async function committedCellKind(page: Page, rowId: string, columnId: string): Promise<string> {
  return callApi<string>(page, 'committedCellKind', [rowId, columnId]);
}
/** view.cellDisplay（raw 表示文字列＝契約面）。表示書式を通さない生の表示値。 */
export async function displayCell(page: Page, rowId: string, columnId: string): Promise<string> {
  return callApi<string>(page, 'displayCell', [rowId, columnId]);
}
/** DD-033-2: base-layer が描く display テキスト（表示書式適用後）。canvas 文字を読めないための観測用。 */
export async function cellRenderText(page: Page, rowId: string, columnId: string): Promise<string> {
  return callApi<string>(page, 'cellRenderText', [rowId, columnId]);
}
/** DD-033-2: 列ヘッダーに描く見出し（キャプション or 列記号）。 */
export async function columnHeaderText(page: Page, col: number): Promise<string> {
  return callApi<string>(page, 'columnHeaderText', [col]);
}

// ---- DD-020-2 clipboard E2E ヘルパー ----------------------------------------------------------

/** 実 Clipboard API を read/write 可能にする（context 単位・grantPermissions）。 */
export async function grantClipboard(context: BrowserContext): Promise<void> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
}

/** 実クリップボードへ text/plain を書く（Excel 方言の実ペイロード注入・実 Ctrl+V の前段）。 */
export async function writeClipboard(page: Page, text: string): Promise<void> {
  await page.evaluate((t: string) => navigator.clipboard.writeText(t), text);
}

/** 実クリップボードの text/plain を読む（copy/cut の書き出し検証）。 */
export async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/**
 * 常駐 textarea へ合成 ClipboardEvent（paste）を dispatch する（Excel 方言 fixture を byte 精密に注入する系統）。
 * DataTransfer で text/plain を運ぶ（実クリップボードの EOL 正規化を受けない）。戻り値=既定が抑止されたか
 * （グリッドが消費＝preventDefault したか）。
 */
export async function dispatchSyntheticPaste(page: Page, text: string): Promise<boolean> {
  return page.evaluate((t: string) => {
    const ta = document.querySelector('textarea.int-cell-editor');
    if (!(ta instanceof HTMLTextAreaElement)) {
      throw new Error('int-cell-editor が見つからない');
    }
    ta.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(event);
    return event.defaultPrevented;
  }, text);
}
/** DD-014-1 AC8: snapshot bootstrap の確立 revision（>0 なら全 replay 非依存で復元した）。 */
export async function bootstrapRevision(page: Page): Promise<number> {
  return callApi<number>(page, 'bootstrapRevision', []);
}
/** DD-014-1 AC8: 適用したサーバー op 数（bootstrap 後の再読込は tail のみ＝小さい＝全 replay 非依存の実証）。 */
export async function appliedServerOpCount(page: Page): Promise<number> {
  return callApi<number>(page, 'appliedServerOpCount', []);
}
export async function rowIndexOf(page: Page, rowId: string): Promise<number> {
  return callApi<number>(page, 'rowIndexOf', [rowId]);
}

/** AC4: 本番 ClientSession 経由で行挿入（afterRowId の直後に newRowId を 1 行）。 */
export async function submitInsertRowsAfter(page: Page, afterRowId: string | null, newRowId: string): Promise<void> {
  await callApi<void>(page, 'submitInsertRowsAfter', [afterRowId, newRowId]);
}
/** AC4: 本番 ClientSession 経由で行削除。 */
export async function submitDeleteRow(page: Page, rowId: string): Promise<void> {
  await callApi<void>(page, 'submitDeleteRow', [rowId]);
}

/** 表示 (row,col) のセル上に赤枠の証跡マーカーを重ねる（スクショ用・pointer-events:none で操作に影響しない）。 */
export async function highlightCell(page: Page, row: number, col: number): Promise<void> {
  const rect = await callApi<CellRect | null>(page, 'cellRectAt', [row, col]);
  if (rect === null) {
    return;
  }
  await page.evaluate((r: CellRect) => {
    const stage = document.getElementById('int-stage');
    if (stage === null) {
      return;
    }
    const box = document.createElement('div');
    box.className = '__e2e-highlight';
    box.style.cssText = `position:absolute;left:${r.x - 1}px;top:${r.y - 1}px;width:${r.width + 2}px;height:${r.height + 2}px;outline:3px solid red;outline-offset:1px;z-index:60;pointer-events:none;`;
    stage.appendChild(box);
  }, rect);
}

/** DOM 要素を赤枠でハイライトする（badge/textarea 等の証跡強調・スクショ用）。 */
export async function highlightSelector(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel: string) => {
    document.querySelectorAll(sel).forEach((el) => {
      if (el instanceof HTMLElement) {
        el.style.cssText += 'outline:3px solid red;outline-offset:2px;';
      }
    });
  }, selector);
}

/**
 * DD-005 証跡（スクショ等）を保存する絶対パス。DD-005 はアーカイブ済み（正典は doc/archived/DD/DD-005/）
 * ゆえ、テスト再実行の再生成分は git 追跡外の test-results/ 配下へ書く（active な doc/DD/ を汚さない）。
 */
export function evidencePath(fileName: string): string {
  return fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-005/${fileName}`, import.meta.url));
}

/** DD-015 証跡（スクショ等）を保存する絶対パス（DD-005 と同じ理由で test-results/ 配下）。 */
export function evidencePathDD015(fileName: string): string {
  return fileURLToPath(new URL(`../../../test-results/dd-evidence/DD-015/${fileName}`, import.meta.url));
}

/** DD-015: 接続状態（online/offline/stopped）。実ブラウザー断線 headed smoke の可視確認に使う。 */
export async function connectionState(page: Page): Promise<'online' | 'offline' | 'stopped'> {
  return callApi<'online' | 'offline' | 'stopped'>(page, 'connectionState', []);
}

/** DD-015: 直近のイベント通知種別（イベント契約が実ブラウザーで発火したことの確認）。 */
export async function lastEventType(page: Page): Promise<string> {
  return callApi<string>(page, 'lastEventType', []);
}

/** DD-015: 未送信（pending）件数。offline 中の backlog 可視化の確認に使う。 */
export async function pendingCount(page: Page): Promise<number> {
  return callApi<number>(page, 'pendingCount', []);
}

/** DD-015 Manual Gate: 実ブラウザーの WebSocket を切断し offline のまま留める（自動再接続抑止・pending 保持）。 */
export async function simulateDrop(page: Page): Promise<void> {
  await callApi<void>(page, 'simulateDrop', []);
}

/** DD-015 Manual Gate: simulateDrop 後に実再接続を駆動する（同一 clientId で再 join → reconcile → catch-up）。 */
export async function simulateReconnect(page: Page): Promise<void> {
  await callApi<void>(page, 'simulateReconnect', []);
}
