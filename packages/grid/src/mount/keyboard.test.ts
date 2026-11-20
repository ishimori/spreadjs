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
  /** DD-069: 通知を受けた購読者がその場で行う操作（例: setReadOnly(false)）。 */
  onBlocked?: (env: Env) => void;
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
  const blocked: string[] = [];
  const deferred: string[] = []; // 打鍵の処理の後に出す通知（素通しする印字キー）
  const flushes = { count: 0 }; // 控えの通知を出した回数（キーの処理の始め）
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
    editBlocked: {
      atActive: (input) => {
        blocked.push(input);
        env.onBlocked?.(env);
      },
      atActiveAfterKeystroke: (input) => {
        blocked.push(input);
        deferred.push(input);
        env.onBlocked?.(env); // 本物は打鍵の後に出すが、その場で出しても二度目が無いことを確かめる
      },
      flushPending: () => {
        flushes.count += 1;
      },
    },
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
    performFill: (direction) => calls.push(`fill(${direction})`),
    ensureCellVisible: () => calls.push('ensureCellVisible'),
  });
  return { keyboard, env, calls, blocked, deferred, flushes, codes: () => diagnostics.map((d) => d.code) };
}

function key(k: string, mods: Partial<KeydownInterceptInput> = {}): KeydownInterceptInput {
  return { key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...mods };
}

describe('mount/keyboard: 優先順位', () => {
  it('段の順番は 1 か所の配列で決まる（読み取り専用 → 読み取り専用のセル → 日付 → 候補欄 → Undo/Redo → Ctrl+D・Ctrl+R → 行操作 → 結合の移動 → 範囲の操作）', () => {
    expect(KEY_HANDLER_ORDER).toEqual([
      'readOnly',
      'readOnlyCells',
      'datePicker',
      'selectDropdown',
      'undoRedo',
      'fill',
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

  it('DD-070-3: Ctrl+D・Ctrl+R は fill の段が消費して写す。編集中は写さずに消費だけ（ブラウザーの既定を止める）。変換中・Shift つきは裁かない', () => {
    const nav = setup();
    expect(nav.keyboard.dispatch(key('d', { ctrlKey: true }))).toEqual({ handler: 'fill', outcome: 'consume' });
    expect(nav.keyboard.dispatch(key('R', { ctrlKey: true }))).toEqual({ handler: 'fill', outcome: 'consume' });
    expect(nav.calls).toEqual(['fill(down)', 'fill(right)']);
    const editing = setup({ phase: 'Editing' });
    expect(editing.keyboard.dispatch(key('d', { ctrlKey: true }))).toEqual({ handler: 'fill', outcome: 'consume' });
    expect(editing.calls).toEqual([]);
    const composing = setup({ composing: true, phase: 'Composing' });
    expect(composing.keyboard.dispatch(key('d', { ctrlKey: true, isComposing: true }))).toEqual({ handler: null, outcome: 'continue' });
    const shifted = setup();
    expect(shifted.keyboard.dispatch(key('D', { ctrlKey: true, shiftKey: true })).handler).not.toBe('fill');
    expect(shifted.calls).toEqual([]);
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

describe('DD-069: 読むだけのセルで止めた編集キーの通知（edit-blocked）', () => {
  it('表全体が読み取り専用: F2・Delete・Backspace は消費して知らせ、印字キーと日本語入力の打鍵は素通しして知らせる', () => {
    const { keyboard, blocked } = setup({ readOnly: true });
    expect(keyboard.dispatch(key('F2'))).toEqual({ handler: 'readOnly', outcome: 'consume' });
    expect(keyboard.dispatch(key('Delete', { ctrlKey: true }))).toEqual({ handler: 'readOnly', outcome: 'consume' });
    expect(keyboard.dispatch(key('Backspace')).outcome).toBe('consume');
    expect(keyboard.dispatch(key('5')).outcome).not.toBe('consume'); // textarea の readOnly で止まる
    expect(keyboard.dispatch(key('Process')).outcome).not.toBe('consume');
    expect(blocked).toEqual(['f2', 'delete', 'delete', 'key', 'key']);
  });

  it('表全体が読み取り専用: 移動・コピー・修飾つきの文字・変換中・編集中は知らせない', () => {
    const { keyboard, blocked, env } = setup({ readOnly: true });
    keyboard.dispatch(key('ArrowDown'));
    keyboard.dispatch(key('Enter'));
    keyboard.dispatch(key('c', { ctrlKey: true }));
    keyboard.dispatch(key('a', { isComposing: true }));
    env.composing = true;
    keyboard.dispatch(key('5'));
    env.composing = false;
    env.phase = 'Editing';
    keyboard.dispatch(key('5'));
    expect(blocked).toEqual([]);
  });

  it('読み取り専用のセル: F2 は消費して知らせ、印字キーは素通しして知らせる（1 回の打鍵で 1 回）', () => {
    const { keyboard, blocked } = setup({ activeReadOnly: true });
    expect(keyboard.dispatch(key('F2'))).toEqual({ handler: 'readOnlyCells', outcome: 'consume' });
    expect(keyboard.dispatch(key('5')).outcome).not.toBe('consume');
    expect(keyboard.dispatch(key(' ')).outcome).not.toBe('consume');
    expect(blocked).toEqual(['f2', 'key', 'key']);
  });

  it('素通しする印字キーだけを打鍵の処理の後に出す経路へ回す（消費するキーはその場で出す）', () => {
    const grid = setup({ readOnly: true });
    grid.keyboard.dispatch(key('F2'));
    grid.keyboard.dispatch(key('z'));
    grid.keyboard.dispatch(key('Delete'));
    grid.keyboard.dispatch(key('Process'));
    expect(grid.deferred).toEqual(['key', 'key']);
    const cell = setup({ activeReadOnly: true });
    cell.keyboard.dispatch(key('F2'));
    cell.keyboard.dispatch(key('5'));
    expect(cell.deferred).toEqual(['key']);
  });

  it('購読者がその場で表全体の読み取り専用を解いても、同じ打鍵では二度知らせない（Codex P2）', () => {
    const onBlocked = (env: Env) => {
      env.readOnly = false;
    };
    const printable = setup({ readOnly: true, activeReadOnly: true, onBlocked });
    printable.keyboard.dispatch(key('z'));
    expect(printable.blocked).toEqual(['key']);
    const f2 = setup({ readOnly: true, activeReadOnly: true, onBlocked });
    expect(f2.keyboard.dispatch(key('F2')).outcome).toBe('consume');
    expect(f2.blocked).toEqual(['f2']);
    // 次の打鍵は改めて判断する（表全体は解けたので、読むだけのセルの段が知らせる）。
    printable.keyboard.dispatch(key('x'));
    expect(printable.blocked).toEqual(['key', 'key']);
  });

  it('キーの処理の始めに控えの通知を出す（前の打鍵の通知を、この打鍵の判断より先に届ける）。変換中は出さない', () => {
    const { keyboard, flushes, env } = setup();
    keyboard.dispatch(key('ArrowDown'));
    keyboard.dispatch(key('a'));
    expect(flushes.count).toBe(2);
    keyboard.dispatch(key('a', { isComposing: true }));
    env.composing = true;
    keyboard.dispatch(key('b'));
    expect(flushes.count).toBe(2);
  });

  it('表全体も選択中のセルも読み取り専用なら、表全体の段だけが 1 回知らせる', () => {
    const { keyboard, blocked } = setup({ readOnly: true, activeReadOnly: true });
    keyboard.dispatch(key('5'));
    keyboard.dispatch(key('F2'));
    expect(blocked).toEqual(['key', 'f2']);
  });

  it('範囲を選んだ Delete は範囲の消去へ流す（飛ばしたセルは cells-skipped で別に知らせる）。入力できるセルでは知らせない', () => {
    const ranged = setup({ activeReadOnly: true, range: { rowStart: 1, rowEnd: 3, colStart: 1, colEnd: 2 } });
    ranged.keyboard.dispatch(key('Delete'));
    expect(ranged.blocked).toEqual([]);
    expect(ranged.calls).toContain('rangeClear');
    const editable = setup();
    editable.keyboard.dispatch(key('5'));
    editable.keyboard.dispatch(key('F2'));
    expect(editable.blocked).toEqual([]);
  });
});
