// DD-065: キー入力の裁定（mount/keyboard.ts）を、grid を mount せずに確かめる（受け入れ基準 6・7）。
// 優先順位（KEY_HANDLER_ORDER）と、各段の結果（消費して止める・処理したうえで流す・該当しない）を固定する。
import { describe, expect, it } from 'vitest';
import { EMPTY_MERGE_INDEX } from '@nanairo-sheet/selection';
import type { CellRange } from '@nanairo-sheet/selection';

import { createDiagnosticSink } from '../diagnostics';
import type { GridDiagnostic } from '../diagnostics';
import type { GridBackend } from '../grid-backend';
import type { IntegrationEditor, KeydownInterceptInput } from '../integration-editor';
import { KEY_HANDLER_ORDER, createKeyboard } from './keyboard';

interface Env {
  readOnly: boolean;
  activeReadOnly: boolean;
  composing: boolean;
  phase: string;
  range: CellRange | null;
  dateAttached: boolean;
  dateOpen: boolean;
  dateColumn: boolean;
  selectAttached: boolean;
  selectOpen: boolean;
  selectColumn: boolean;
}

function setup(overrides: Partial<Env> = {}) {
  const env: Env = {
    readOnly: false,
    activeReadOnly: false,
    composing: false,
    phase: 'Navigation',
    range: null,
    dateAttached: false,
    dateOpen: false,
    dateColumn: false,
    selectAttached: false,
    selectOpen: false,
    selectColumn: false,
    ...overrides,
  };
  const calls: string[] = [];
  const diagnostics: GridDiagnostic[] = [];
  const editor = {
    session: {
      isComposing: () => env.composing,
      getPhase: () => env.phase,
      getActiveCell: () => ({ row: 1, col: 1 }),
    },
    pointerdownCell: (cell: unknown) => calls.push(`pointerdownCell(${JSON.stringify(cell)})`),
  } as unknown as IntegrationEditor;
  const backend = {
    view: {
      rowIdAt: (index: number) => `r${index}`,
      rowAxis: { count: () => 10 },
      colAxis: { count: () => 5 },
      markViewportDirty: () => {},
    },
  } as unknown as GridBackend;
  const keyboard = createKeyboard({
    diag: createDiagnosticSink((entry) => diagnostics.push(entry)),
    rowOperationsEnabled: true,
    selectionCtrl: {
      getRange: () => env.range,
      clear: () => {
        calls.push('selection.clear');
        env.range = null;
        return true;
      },
      selectedRange: () => env.range ?? { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 },
      extendByArrow: (_active, direction) => {
        calls.push(`extend(${direction})`);
        return { row: 2, col: 1 };
      },
    },
    cellLock: {
      hasReadOnlyCells: () => env.activeReadOnly,
      isActiveCellReadOnly: () => env.activeReadOnly,
      isReadOnlyRowIndex: () => false,
    },
    merges: { any: () => false, isMergedCellIndex: () => false, current: () => EMPTY_MERGE_INDEX },
    date: {
      isAttached: () => env.dateAttached,
      openOnOf: () => (env.dateColumn ? 'dblclick' : undefined),
      isOpen: () => env.dateOpen,
      open: () => calls.push('date.open'),
      moveDays: (delta) => calls.push(`date.moveDays(${delta})`),
      moveMonths: (delta) => calls.push(`date.moveMonths(${delta})`),
      highlightedValue: () => '2026-11-08',
      confirm: (value) => calls.push(`date.confirm(${value})`),
      close: () => calls.push('date.close'),
    },
    select: {
      isAttached: () => env.selectAttached,
      isOpen: () => env.selectOpen,
      isSelectColumnIndex: () => env.selectColumn,
      allowsFreeText: () => false,
      open: () => calls.push('select.open'),
      typeCharacter: (c) => calls.push(`select.type(${c})`),
      backspace: () => calls.push('select.backspace'),
      highlightNext: () => calls.push('select.next'),
      highlightPrev: () => calls.push('select.prev'),
      confirm: () => calls.push('select.confirm'),
      close: () => calls.push('select.close'),
    },
    editor: () => editor,
    backend: () => backend,
    isReadOnly: () => env.readOnly,
    performUndo: () => calls.push('undo'),
    performRedo: () => calls.push('redo'),
    performInsertRows: (afterRowId, count) => calls.push(`insertRows(${afterRowId},${count})`),
    performDeleteRows: (rowIds) => calls.push(`deleteRows(${rowIds.join(',')})`),
    performRangeClear: () => calls.push('rangeClear'),
    ensureCellVisible: () => calls.push('ensureCellVisible'),
  });
  return { keyboard, env, calls, codes: () => diagnostics.map((d) => d.code) };
}

function key(k: string, mods: Partial<KeydownInterceptInput> = {}): KeydownInterceptInput {
  return { key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...mods };
}

describe('mount/keyboard: 優先順位', () => {
  it('段の順番は 1 か所の配列で決まる（読み取り専用 → 読み取り専用のセル → 日付 → 候補欄 → Undo/Redo → 行操作 → 結合の移動 → 範囲の操作）', () => {
    expect(KEY_HANDLER_ORDER).toEqual([
      'readOnly',
      'readOnlyCells',
      'datePicker',
      'selectDropdown',
      'undoRedo',
      'rowStructure',
      'mergeMove',
      'rangeOperations',
    ]);
  });

  it('上の段が先に裁く: 読み取り専用なら、カレンダーが開いていても F2 は読み取り専用の段が止める', () => {
    const { keyboard, calls } = setup({ readOnly: true, dateAttached: true, dateOpen: true, dateColumn: true });
    expect(keyboard.dispatch(key('F2'))).toEqual({ handler: 'readOnly', outcome: 'consume' });
    expect(calls).toEqual([]); // カレンダーの段には届かない
  });

  it('上の段が先に裁く: カレンダーが開いている間の矢印は、範囲の操作より先に日付の段が消費する', () => {
    const { keyboard, calls } = setup({ dateAttached: true, dateOpen: true, dateColumn: true });
    expect(keyboard.dispatch(key('ArrowRight', { shiftKey: true }))).toMatchObject({ handler: 'datePicker', outcome: 'consume' });
    expect(calls).not.toContain('extend(right)');
  });
});

describe('mount/keyboard: 各段の結果', () => {
  it('読み取り専用のセルでは編集キーを止める。範囲があるときの Delete は止めずに範囲の消去へ流す', () => {
    const blocked = setup({ activeReadOnly: true });
    expect(blocked.keyboard.dispatch(key('Delete'))).toEqual({ handler: 'readOnlyCells', outcome: 'consume' });
    expect(blocked.codes()).toEqual(['readonly-column-blocked']);
    const range = { rowStart: 1, rowEnd: 3, colStart: 1, colEnd: 3 };
    const ranged = setup({ activeReadOnly: true, range });
    expect(ranged.keyboard.dispatch(key('Delete'))).toEqual({ handler: 'rangeOperations', outcome: 'consume' });
    expect(ranged.calls).toContain('rangeClear');
  });

  it('閉じている候補欄の列で Enter は候補欄を開く。開いている間の ↓ はハイライトを動かす', () => {
    const closed = setup({ selectAttached: true, selectColumn: true });
    expect(closed.keyboard.dispatch(key('Enter'))).toEqual({ handler: 'selectDropdown', outcome: 'consume' });
    expect(closed.calls).toContain('select.open');
    const open = setup({ selectAttached: true, selectColumn: true, selectOpen: true });
    expect(open.keyboard.dispatch(key('ArrowDown'))).toEqual({ handler: 'selectDropdown', outcome: 'consume' });
    expect(open.calls).toContain('select.next');
  });

  it('Ctrl+Z は Undo の段が消費する。Ctrl+- は選択中の行を消す', () => {
    const undo = setup();
    expect(undo.keyboard.dispatch(key('z', { ctrlKey: true }))).toEqual({ handler: 'undoRedo', outcome: 'consume' });
    expect(undo.calls).toEqual(['undo']);
    const del = setup();
    expect(del.keyboard.dispatch(key('-', { ctrlKey: true }))).toEqual({ handler: 'rowStructure', outcome: 'consume' });
    expect(del.calls).toEqual(['deleteRows(r1)']);
  });

  it('Escape は範囲を解除したうえで状態機械へも流す（処理したうえで流す）', () => {
    const { keyboard, calls } = setup({ range: { rowStart: 1, rowEnd: 3, colStart: 1, colEnd: 3 } });
    expect(keyboard.dispatch(key('Escape'))).toEqual({ handler: 'rangeOperations', outcome: 'pass' });
    expect(keyboard.intercept(key('Escape'))).toBe(false); // 消費しない
    expect(calls).toContain('selection.clear');
  });

  it('Shift+矢印は範囲を広げて消費する', () => {
    const { keyboard, calls } = setup();
    expect(keyboard.dispatch(key('ArrowDown', { shiftKey: true }))).toEqual({ handler: 'rangeOperations', outcome: 'consume' });
    expect(calls).toEqual(['extend(down)', 'ensureCellVisible']);
  });

  it('どの段にも該当しないキー（印字文字）は消費せず状態機械へ流す', () => {
    const { keyboard } = setup();
    expect(keyboard.dispatch(key('a'))).toEqual({ handler: null, outcome: 'continue' });
    expect(keyboard.intercept(key('a'))).toBe(false);
  });

  it('変換中はどの段も該当しない（IME 経路に介入しない）', () => {
    const { keyboard, calls } = setup({ readOnly: true, composing: true, phase: 'Composing', dateAttached: true, dateColumn: true });
    expect(keyboard.dispatch(key('Enter', { isComposing: true }))).toEqual({ handler: null, outcome: 'continue' });
    expect(calls).toEqual([]);
  });
});
