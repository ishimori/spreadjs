// DD-070-2: selection-change の発火条件と selection() の中身（読むだけの部品の単体）。
import { describe, expect, it } from 'vitest';

import type { CellPos, CellRange } from '@nanairo-sheet/selection';
import type { ColumnId, RowId } from '@nanairo-sheet/types';

import type { GridEvent } from '../index';
import { createSelectionNotify, type SelectionNotifyDeps } from './selection-notify';

interface Harness {
  rows: string[];
  columns: string[];
  active: CellPos;
  range: CellRange | null;
  drag: CellRange | null;
  firstDrawn: boolean;
  destroyed: boolean;
  hasBackend: boolean;
  events: GridEvent[];
}

function setup(overrides: Partial<Harness> = {}): { h: Harness; notify: ReturnType<typeof createSelectionNotify> } {
  const h: Harness = {
    rows: ['r0', 'r1', 'r2', 'r3'],
    columns: ['a', 'b', 'c'],
    active: { row: 0, col: 0 },
    range: null,
    drag: null,
    firstDrawn: true,
    destroyed: false,
    hasBackend: true,
    events: [],
    ...overrides,
  };
  const view = {
    rowIdAt: (i: number) => h.rows[i] as RowId | undefined,
    columnIdAt: (i: number) => h.columns[i] as ColumnId | undefined,
  };
  const deps: SelectionNotifyDeps = {
    selectionCtrl: {
      getDragRange: () => h.drag,
      selectedRange: (active) =>
        h.range ?? { rowStart: active.row, rowEnd: active.row + 1, colStart: active.col, colEnd: active.col + 1 },
    },
    backend: () => (h.hasBackend ? ({ view } as never) : undefined),
    editor: () => ({ session: { getActiveCell: () => h.active } }) as never,
    isFirstDataDrawn: () => h.firstDrawn,
    isDestroyed: () => h.destroyed,
    emit: (event) => h.events.push(event),
  };
  return { h, notify: createSelectionNotify(deps) };
}

const changes = (events: readonly GridEvent[]) => events.filter((e) => e.type === 'selection-change');

describe('DD-070-2 selection-notify', () => {
  it('初回のデータの描画の前は出さず、描画の後の最初の check で今の選択を 1 回出す', () => {
    const { h, notify } = setup({ firstDrawn: false });
    notify.check();
    expect(h.events).toEqual([]);
    h.firstDrawn = true;
    notify.check();
    expect(h.events).toEqual([
      {
        type: 'selection-change',
        activeCell: { rowId: 'r0', columnId: 'a' },
        range: { startRowId: 'r0', startColumnId: 'a', endRowId: 'r0', endColumnId: 'a' },
      },
    ]);
  });

  it('選択が変わらなければ何度 check しても出さない', () => {
    const { h, notify } = setup();
    notify.check();
    notify.check();
    notify.check();
    expect(changes(h.events)).toHaveLength(1);
  });

  it('アクティブセルが動くと出す（同じフレームの中で何度動いても check 1 回につき 1 回）', () => {
    const { h, notify } = setup();
    notify.check();
    h.active = { row: 1, col: 0 };
    h.active = { row: 2, col: 1 };
    notify.check();
    expect(changes(h.events)).toHaveLength(2);
    expect(h.events[1]).toMatchObject({ activeCell: { rowId: 'r2', columnId: 'b' } });
  });

  it('明示の範囲は左上と右下の ID で出す', () => {
    const { h, notify } = setup();
    h.range = { rowStart: 1, rowEnd: 3, colStart: 0, colEnd: 2 };
    h.active = { row: 1, col: 0 };
    notify.check();
    expect(h.events[0]).toMatchObject({
      activeCell: { rowId: 'r1', columnId: 'a' },
      range: { startRowId: 'r1', startColumnId: 'a', endRowId: 'r2', endColumnId: 'b' },
    });
  });

  it('ドラッグ中はドラッグの範囲を出す（確定した範囲より先）', () => {
    const { h, notify } = setup();
    h.range = { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 };
    h.drag = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 3 };
    notify.check();
    expect(h.events[0]).toMatchObject({ range: { endRowId: 'r3', endColumnId: 'c' } });
  });

  it('行の並びが変わって番号だけが変わったときは出さない。同じ番号で指す行が変わったら出す', () => {
    const { h, notify } = setup({ active: { row: 1, col: 0 } });
    notify.check();
    // 上に行が入って r1 が 2 番目へ（選択の再ベースで active も 2 へ）→ ID は同じ。
    h.rows = ['rNew', 'r0', 'r1', 'r2', 'r3'];
    h.active = { row: 2, col: 0 };
    notify.check();
    expect(changes(h.events)).toHaveLength(1);
    // 番号はそのままで指す行が変わった（r1 が消えた）→ 出す。
    h.rows = ['rNew', 'r0', 'r2', 'r3'];
    notify.check();
    expect(changes(h.events)).toHaveLength(2);
    expect(h.events[1]).toMatchObject({ activeCell: { rowId: 'r2' } });
  });

  it('行が無くなれば両方 null で出し、selection() も両方 null', () => {
    const { h, notify } = setup();
    notify.check();
    h.rows = [];
    notify.check();
    expect(h.events[1]).toEqual({ type: 'selection-change', activeCell: null, range: null });
    expect(notify.current()).toEqual({ activeCell: null, range: null });
  });

  it('selection() は check を待たずに今の選択を返す', () => {
    const { h, notify } = setup();
    h.active = { row: 3, col: 2 };
    expect(notify.current()).toEqual({
      activeCell: { rowId: 'r3', columnId: 'c' },
      range: { startRowId: 'r3', startColumnId: 'c', endRowId: 'r3', endColumnId: 'c' },
    });
  });

  it('boot 前（backend 無し）・destroy 後は両方 null で、出さない', () => {
    const boot = setup({ hasBackend: false });
    expect(boot.notify.current()).toEqual({ activeCell: null, range: null });
    const { h, notify } = setup();
    notify.check();
    h.destroyed = true;
    h.active = { row: 2, col: 2 };
    notify.check();
    expect(changes(h.events)).toHaveLength(1);
    expect(notify.current()).toEqual({ activeCell: null, range: null });
  });
});
