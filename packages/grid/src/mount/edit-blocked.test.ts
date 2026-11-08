// DD-069 unit: 読むだけのセルへの編集を止めたときの通知（mount/edit-blocked.ts）の組み立て（DOM 非依存）。
//
// 検証: キーから通知の操作への写し方・止めた理由の優先順位・結合範囲は左上のセルとして知らせる・読むだけでないセルや
// 行・列の ID が引けないときは出さない・cells-skipped は 0 件なら出さず、渡した配列を写して出す。

import { describe, expect, it, vi } from 'vitest';
import { createMergeIndex, EMPTY_MERGE_INDEX } from '@nanairo-sheet/selection';
import type { MergeIndex } from '@nanairo-sheet/selection';

import type { GridBackend } from '../grid-backend';
import type { GridCellRef, GridEvent } from '../index';
import type { IntegrationEditor } from '../integration-editor';
import { blockedKeyInput, createEditBlocked } from './edit-blocked';

interface Fixture {
  readOnly?: boolean;
  columns?: readonly number[];
  rows?: readonly number[];
  cells?: readonly string[]; // `${row},${col}`
  merges?: MergeIndex;
  active?: { row: number; col: number };
  backend?: boolean;
  editor?: boolean;
  deferred?: Array<() => void>;
  composing?: boolean;
  phase?: string;
}

function setup(fixture: Fixture = {}) {
  const events: GridEvent[] = [];
  const merges = fixture.merges ?? EMPTY_MERGE_INDEX;
  const backend = {
    view: {
      rowIdAt: (row: number) => (row < 50 ? `r${row}` : undefined),
      columnIdAt: (col: number) => (col < 10 ? `c${col}` : undefined),
    },
  } as unknown as GridBackend;
  const editor = {
    session: {
      getActiveCell: () => fixture.active ?? { row: 1, col: 1 },
      isComposing: () => fixture.composing === true,
      getPhase: () => fixture.phase ?? 'Navigation',
    },
  } as unknown as IntegrationEditor;
  const blocked = createEditBlocked({
    emit: (event) => events.push(event),
    backend: () => (fixture.backend === false ? undefined : backend),
    editor: () => (fixture.editor === false ? undefined : editor),
    cellLock: {
      isReadOnlyColumnIndex: (col) => (fixture.columns ?? []).includes(col),
      isReadOnlyRowIndex: (row) => (fixture.rows ?? []).includes(row),
      isReadOnlyCellIndex: (row, col) => (fixture.cells ?? []).includes(`${row},${col}`),
    },
    merges: {
      isMergedCellIndex: (row, col) => merges.at(row, col) !== undefined,
      current: () => merges,
    },
    isReadOnly: () => fixture.readOnly === true,
    ...(fixture.deferred !== undefined ? { defer: (run: () => void) => fixture.deferred!.push(run) } : {}),
  });
  return { blocked, events };
}

const key = (k: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({
  key: k,
  ctrlKey: mods.ctrlKey === true,
  metaKey: mods.metaKey === true,
  altKey: mods.altKey === true,
});

describe('DD-069: blockedKeyInput（キー → 通知の操作）', () => {
  it('F2 は f2、Delete・Backspace は修飾の有無によらず delete（readonly-policy の抑止と同じ）', () => {
    expect(blockedKeyInput(key('F2'))).toBe('f2');
    expect(blockedKeyInput(key('Delete'))).toBe('delete');
    expect(blockedKeyInput(key('Backspace', { ctrlKey: true }))).toBe('delete');
  });

  it('修飾なしの 1 文字と、日本語入力オンの打鍵（Process）は key', () => {
    expect(blockedKeyInput(key('a'))).toBe('key');
    expect(blockedKeyInput(key('5'))).toBe('key');
    expect(blockedKeyInput(key(' '))).toBe('key');
    expect(blockedKeyInput(key('あ'))).toBe('key');
    expect(blockedKeyInput(key('Process'))).toBe('key');
  });

  it('移動・確定のキーと、修飾つきの文字（Ctrl+C など）は編集を始めないので undefined', () => {
    for (const k of ['ArrowDown', 'Enter', 'Tab', 'Escape', 'Home', 'PageDown', 'Shift', 'F5']) {
      expect(blockedKeyInput(key(k))).toBeUndefined();
    }
    expect(blockedKeyInput(key('c', { ctrlKey: true }))).toBeUndefined();
    expect(blockedKeyInput(key('v', { metaKey: true }))).toBeUndefined();
    expect(blockedKeyInput(key('x', { altKey: true }))).toBeUndefined();
  });
});

describe('DD-069: edit-blocked の理由と位置', () => {
  it('選択中のセルの行・列の ID・操作・理由を 1 回出す', () => {
    const { blocked, events } = setup({ columns: [2], active: { row: 3, col: 2 } });
    blocked.atActive('key');
    expect(events).toEqual([{ type: 'edit-blocked', rowId: 'r3', columnId: 'c2', input: 'key', reason: 'readonly-column' }]);
  });

  it('理由が重なるときは 表全体 → 結合範囲 → 行 → 列 → 行データのセル の順で先のものを選ぶ', () => {
    const merges = createMergeIndex([{ rowStart: 4, rowEnd: 6, colStart: 1, colEnd: 3 }]);
    const all = { columns: [1, 2], rows: [4, 5], cells: ['4,1', '5,2'], merges };
    const reasonAt = (fixture: Fixture, row: number, col: number) => {
      const { blocked, events } = setup(fixture);
      blocked.atCell(row, col, 'dblclick');
      return events.map((e) => (e.type === 'edit-blocked' ? e.reason : e.type));
    };
    expect(reasonAt({ ...all, readOnly: true }, 4, 1)).toEqual(['grid-readonly']);
    expect(reasonAt(all, 4, 1)).toEqual(['merged']);
    expect(reasonAt({ columns: [1], rows: [4], cells: ['4,1'] }, 4, 1)).toEqual(['readonly-row']);
    expect(reasonAt({ columns: [1], cells: ['4,1'] }, 4, 1)).toEqual(['readonly-column']);
    expect(reasonAt({ cells: ['4,1'] }, 4, 1)).toEqual(['readonly-cell']);
  });

  it('表全体が読み取り専用なら、どのセルでも grid-readonly で出す', () => {
    const { blocked, events } = setup({ readOnly: true, active: { row: 0, col: 0 } });
    blocked.atActive('paste');
    expect(events).toEqual([{ type: 'edit-blocked', rowId: 'r0', columnId: 'c0', input: 'paste', reason: 'grid-readonly' }]);
  });

  it('結合範囲の中のセルは、左上のセルとして知らせる', () => {
    const merges = createMergeIndex([{ rowStart: 4, rowEnd: 6, colStart: 1, colEnd: 3 }]);
    const { blocked, events } = setup({ merges });
    blocked.atCell(5, 2, 'dblclick');
    expect(events).toEqual([{ type: 'edit-blocked', rowId: 'r4', columnId: 'c1', input: 'dblclick', reason: 'merged' }]);
  });

  it('読むだけでないセル・行や列の ID が引けないセル・起動前（backend・editor が無い）では出さない', () => {
    const editable = setup({ columns: [5] });
    editable.blocked.atActive('key');
    editable.blocked.atCell(2, 2, 'dblclick');
    expect(editable.events).toEqual([]);

    const outside = setup({ rows: [60] });
    outside.blocked.atCell(60, 1, 'dblclick'); // rowIdAt が undefined
    expect(outside.events).toEqual([]);

    const beforeBoot = setup({ readOnly: true, backend: false });
    beforeBoot.blocked.atActive('key');
    beforeBoot.blocked.atCell(1, 1, 'dblclick');
    expect(beforeBoot.events).toEqual([]);

    const noEditor = setup({ readOnly: true, editor: false });
    noEditor.blocked.atActive('key');
    expect(noEditor.events).toEqual([]);
  });

  it('選択中のセルへの通知は、変換中・Navigation でない位相では出さない（変換中の setReadOnly(true) の後の貼り付け・Codex P2）', () => {
    for (const fixture of [{ composing: true }, { phase: 'Composing' }, { phase: 'Editing' }]) {
      const deferred: Array<() => void> = [];
      const { blocked, events } = setup({ readOnly: true, deferred, ...fixture });
      blocked.atActive('paste');
      blocked.atActive('cut');
      blocked.atActiveAfterKeystroke('key');
      expect(deferred).toEqual([]);
      expect(events).toEqual([]);
    }
  });
});

describe('DD-069: 素通しする印字キーの通知（打鍵の処理の後に出す）', () => {
  it('位置と理由は呼んだ時点で決め、出すのは後で回したとき（その間に選択が動いても元のセル）', () => {
    const deferred: Array<() => void> = [];
    const fixture: Fixture = { columns: [2], active: { row: 3, col: 2 }, deferred };
    const { blocked, events } = setup(fixture);
    blocked.atActiveAfterKeystroke('key');
    expect(events).toEqual([]);
    fixture.active = { row: 3, col: 0 }; // 購読者が setActiveCell で入力できるセルへ動かした
    expect(deferred).toHaveLength(1);
    deferred[0]!();
    expect(events).toEqual([{ type: 'edit-blocked', rowId: 'r3', columnId: 'c2', input: 'key', reason: 'readonly-column' }]);
  });

  it('読むだけでないセルでは後で回す処理も積まない。既定は setTimeout 0 で出す', () => {
    const deferred: Array<() => void> = [];
    setup({ deferred }).blocked.atActiveAfterKeystroke('key');
    expect(deferred).toEqual([]);
    vi.useFakeTimers();
    try {
      const { blocked, events } = setup({ readOnly: true });
      blocked.atActiveAfterKeystroke('key');
      expect(events).toEqual([]);
      vi.runAllTimers();
      expect(events).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DD-069: 控えの通知の順', () => {
  const kinds = (events: GridEvent[]) => events.map((e) => (e.type === 'edit-blocked' ? e.input : e.type));

  it('控えは、その場で出す通知の前と flushPending で届いた順に出し、二度は出さない', () => {
    const deferred: Array<() => void> = [];
    const { blocked, events } = setup({ readOnly: true, deferred });
    blocked.atActiveAfterKeystroke('key');
    blocked.atActiveAfterKeystroke('key');
    expect(deferred).toHaveLength(1); // 控えが空から積み始めたときだけタイマーを積む
    blocked.atActive('f2');
    expect(kinds(events)).toEqual(['key', 'key', 'f2']);
    deferred[0]!(); // 遅れて来たタイマーは何も出さない
    expect(kinds(events)).toEqual(['key', 'key', 'f2']);
    blocked.atActiveAfterKeystroke('key');
    blocked.flushPending();
    blocked.atCell(1, 1, 'dblclick');
    blocked.atActiveAfterKeystroke('key');
    blocked.skipped('paste', [{ rowId: 'r1', columnId: 'c1' }]);
    expect(kinds(events)).toEqual(['key', 'key', 'f2', 'key', 'dblclick', 'key', 'cells-skipped']);
  });
});

describe('DD-069: cells-skipped', () => {
  it('飛ばしたセルを操作つきで出し、渡した配列は写す（呼び出し側が後で書き換えても変わらない）', () => {
    const { blocked, events } = setup();
    const cells: GridCellRef[] = [
      { rowId: 'r1', columnId: 'c2' },
      { rowId: 'r2', columnId: 'c2' },
    ];
    blocked.skipped('paste', cells);
    cells.push({ rowId: 'r9', columnId: 'c9' });
    expect(events).toEqual([
      {
        type: 'cells-skipped',
        operation: 'paste',
        cells: [
          { rowId: 'r1', columnId: 'c2' },
          { rowId: 'r2', columnId: 'c2' },
        ],
      },
    ]);
  });

  it('0 件なら出さない', () => {
    const { blocked, events } = setup();
    blocked.skipped('clear', []);
    blocked.skipped('cut', []);
    expect(events).toEqual([]);
  });
});
