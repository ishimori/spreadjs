// React Facade（DD-025）の playground consumer / E2E ハーネス。
//
// @nanairo-sheet/react の <NanairoSheetView mode="standalone"> を **StrictMode 下**で mount する。
// grid Facade（@nanairo-sheet/grid）と同様、内部パッケージは一切 import しない（R1・Facade 経由）。
// cell-commit を「利用側 API のモック」＝localStorage へ保存し、責務境界（roadmap §6）を実演する。
// E2E は本ページ（react-standalone.html）を対象に、公開契約のみで検証する（GridInstance は Facade が隠蔽）:
//   - 表示/初期注入・ref.setData 再注入 → onCellCommit.previousValue の round-trip で確認
//   - synthetic IME → onCellCommit
//   - StrictMode 二重 mount 正常 ・ mount/unmount 反復リークなし（DOM/rAF/WS を外部観測）
// JSX 構文糖は使わず createElement で記述する（Vite の JSX 変換設定に依存しない）。

import { createElement, createRef, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  NanairoSheetView,
  REACT_API_VERSION,
  type NanairoSheetViewHandle,
} from '@nanairo-sheet/react';
import type { GridCellCommitChange, GridEvent, GridStandaloneData } from '@nanairo-sheet/grid';

const rootEl = document.getElementById('react-root');
const statusEl = document.getElementById('rx-status');
if (!(rootEl instanceof HTMLElement)) {
  throw new Error('#react-root が見つかりません');
}

// DD-036 C4: handle.scrollToColumn の検証には横スクロールが要るため `?extracols=N` で列を増やせる
// （既定は従来の 4 列＝未指定なら既存 E2E と完全一致）。
const EXTRA_COLUMN_COUNT = (() => {
  const raw = new URLSearchParams(location.search).get('extracols');
  const n = raw === null ? 0 : Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 400 ? n : 0;
})();
const COLUMN_ORDER = [
  'col-a',
  'col-b',
  'col-c',
  'col-d',
  ...Array.from({ length: EXTRA_COLUMN_COUNT }, (_, i) => `col-x${i}`),
];
const SEED_ROW_COUNT = 20;

// 利用側の保存モック（localStorage）。cell-commit を rowId|columnId→value で蓄積し、次回 initialData に混ぜる。
const SAVE_KEY = 'nsheet:react-standalone:cells';
type SavedCells = Record<string, Record<string, string>>;

function loadSaved(): SavedCells {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw === null ? {} : (JSON.parse(raw) as SavedCells);
  } catch {
    return {};
  }
}
function persist(saved: SavedCells): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(saved));
  } catch {
    // 保存不可（プライベートモード等）でも致命ではない。
  }
}

/** シード行（r0..r19・col-a に行ラベル）＋保存済み値をマージした初期データ。r0/col-a は既知値 '行0'。 */
function buildInitialData(): GridStandaloneData {
  const saved = loadSaved();
  const rows: GridStandaloneData['rows'] = Array.from({ length: SEED_ROW_COUNT }, (_, i) => {
    const rowId = `r${i}`;
    const cells: Record<string, string> = { 'col-a': `行${i}` };
    Object.assign(cells, saved[rowId] ?? {});
    return { rowId, cells };
  });
  return { rows };
}

const events: GridEvent[] = [];
let commitCount = 0;
let lastCommit: readonly GridCellCommitChange[] | null = null;

function renderBar(state: string): void {
  if (statusEl !== null) {
    statusEl.textContent = `React SDK ${REACT_API_VERSION} ｜ standalone(StrictMode) ｜ 接続: ${state} ｜ cell-commit: ${commitCount} 件`;
  }
}

function onEvent(event: GridEvent): void {
  events.push(event);
  if (event.type === 'error') {
    renderBar(`error[${event.phase}]: ${event.message}`);
  }
}

function onCellCommit(changes: readonly GridCellCommitChange[]): void {
  commitCount += 1;
  lastCommit = changes;
  // 利用側 API（モック）へ保存する（grid は書き戻さない・利用側が保存＝責務境界）。
  const saved = loadSaved();
  for (const change of changes) {
    const row = saved[change.rowId] ?? (saved[change.rowId] = {});
    row[change.columnId] = change.value;
  }
  persist(saved);
  renderBar('standalone');
}

/** E2E 駆動用のハンドル（公開契約のみ・GridInstance は出さない）。 */
interface ReactStandaloneHandle {
  readonly events: GridEvent[];
  readonly apiVersion: string;
  commitCount(): number;
  lastCommit(): readonly GridCellCommitChange[] | null;
  mount(): void;
  unmount(): void;
  reinject(data: GridStandaloneData): void;
  connectionState(): string;
  clearSaved(): void;
  resetCommits(): void;
  // DD-035 R7/R6: ref handle の命令 API を公開契約のまま E2E へ橋渡しする（GridInstance は出さない）。
  insertRows(options: { readonly afterRowId: string | null; readonly count?: number }): void;
  deleteRows(rowIds: readonly string[]): void;
  scrollToRow(rowId: string): void;
  /** DD-036 C4: 指定列を可視域へ（縦は動かさない）。 */
  scrollToColumn(columnId: string): void;
  setActiveCell(rowId: string, columnId: string): void;
  /** 直近の row-structure-change（insert の新 RowId を E2E が拾うため）。 */
  lastRowStructureChange(): unknown;
}

let root: Root | null = null;
let viewRef: { current: NanairoSheetViewHandle | null } | null = null;

function tree(): ReactNode {
  const ref = createRef<NanairoSheetViewHandle>();
  viewRef = ref;
  return createElement(
    StrictMode,
    null,
    createElement(NanairoSheetView, {
      ref,
      mode: 'standalone',
      columnOrder: COLUMN_ORDER,
      initialData: buildInitialData(),
      onEvent,
      onCellCommit,
      style: { position: 'absolute', inset: '0', width: '100%', height: '100%' },
    }),
  );
}

const handle: ReactStandaloneHandle = {
  events,
  apiVersion: REACT_API_VERSION,
  commitCount(): number {
    return commitCount;
  },
  lastCommit(): readonly GridCellCommitChange[] | null {
    return lastCommit;
  },
  mount(): void {
    if (root !== null) {
      return;
    }
    root = createRoot(rootEl);
    root.render(tree());
    renderBar('standalone');
  },
  unmount(): void {
    root?.unmount();
    root = null;
    viewRef = null;
    renderBar('未マウント');
  },
  reinject(data: GridStandaloneData): void {
    viewRef?.current?.setData(data);
  },
  connectionState(): string {
    return viewRef?.current?.connectionState() ?? 'none';
  },
  clearSaved(): void {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      // no-op
    }
  },
  resetCommits(): void {
    commitCount = 0;
    lastCommit = null;
    events.length = 0;
  },
  // DD-035 R7/R6: ref handle 直結（未 mount 時は Facade が warn して無視する契約）。
  insertRows(options): void {
    viewRef?.current?.insertRows(options);
  },
  deleteRows(rowIds): void {
    viewRef?.current?.deleteRows(rowIds);
  },
  scrollToRow(rowId): void {
    viewRef?.current?.scrollToRow(rowId);
  },
  scrollToColumn(columnId): void {
    viewRef?.current?.scrollToColumn(columnId);
  },
  setActiveCell(rowId, columnId): void {
    viewRef?.current?.setActiveCell(rowId, columnId);
  },
  lastRowStructureChange(): unknown {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]!;
      if (e.type === 'row-structure-change') {
        return e.change;
      }
    }
    return null;
  },
};

declare global {
  interface Window {
    __reactStandalone?: ReactStandaloneHandle;
  }
}

window.__reactStandalone = handle;
renderBar('初期化');
handle.mount();
