// DD-070-2: selection-change の発火条件と selection() の中身（読むだけの部品の単体）。
import { describe, expect, it } from 'vitest';

import { EMPTY_MERGE_INDEX } from '@nanairo-sheet/selection';
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
  /** 選択の版（selection-controller）と行 Axis の再構築の回数・保留中の構造変更の flush の回数。 */
  revision: number;
  rebuilds: number;
  flushes: number;
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
    revision: 0,
    rebuilds: 0,
    flushes: 0,
    ...overrides,
  };
  const view = {
    get structuralRebuildCount() {
      return h.rebuilds;
    },
    rowIdAt: (i: number) => h.rows[i] as RowId | undefined,
    columnIdAt: (i: number) => h.columns[i] as ColumnId | undefined,
  };
  const deps: SelectionNotifyDeps = {
    selectionCtrl: {
      revision: () => h.revision,
      getDragRange: () => h.drag,
      selectedRange: (active) =>
        h.range ?? { rowStart: active.row, rowEnd: active.row + 1, colStart: active.col, colEnd: active.col + 1 },
    },
    backend: () => (h.hasBackend ? ({ view } as never) : undefined),
    editor: () => ({ session: { getActiveCell: () => h.active } }) as never,
    merges: () => EMPTY_MERGE_INDEX,
    flushPendingStructure: () => {
      h.flushes += 1;
    },
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
    h.rebuilds += 1;
    h.active = { row: 2, col: 0 };
    notify.check();
    expect(changes(h.events)).toHaveLength(1);
    // 番号はそのままで指す行が変わった（r1 が消えた）→ 出す。
    h.rows = ['rNew', 'r0', 'r2', 'r3'];
    h.rebuilds += 1;
    notify.check();
    expect(changes(h.events)).toHaveLength(2);
    expect(h.events[1]).toMatchObject({ activeCell: { rowId: 'r2' } });
  });

  it('行が無くなれば両方 null で出し、selection() も両方 null', () => {
    const { h, notify } = setup();
    notify.check();
    h.rows = [];
    h.rebuilds += 1;
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

  it('Codex P2: 組み立ての元（番号・選択の版・行 Axis の再構築・結合）が同じフレームでは範囲を組み立て直さない。版が変われば組み立て直す', () => {
    const { h, notify } = setup();
    let built = 0;
    const counting = createSelectionNotify({
      selectionCtrl: {
        revision: () => h.revision,
        getDragRange: () => h.drag,
        selectedRange: (active) => {
          built += 1;
          return h.range ?? { rowStart: active.row, rowEnd: active.row + 1, colStart: active.col, colEnd: active.col + 1 };
        },
      },
      backend: () => ({ view: { structuralRebuildCount: h.rebuilds, rowIdAt: (i: number) => h.rows[i], columnIdAt: (i: number) => h.columns[i] } }) as never,
      editor: () => ({ session: { getActiveCell: () => h.active } }) as never,
      merges: () => EMPTY_MERGE_INDEX,
      flushPendingStructure: () => {},
      isFirstDataDrawn: () => true,
      isDestroyed: () => false,
      emit: (event) => h.events.push(event),
    });
    counting.check();
    counting.check();
    counting.check();
    expect(built).toBe(1);
    h.range = { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 };
    h.revision += 1;
    counting.check();
    expect(built).toBe(2);
    expect(changes(h.events)).toHaveLength(2);
    expect(h.events.at(-1)).toMatchObject({ range: { endRowId: 'r1', endColumnId: 'b' } });
    void notify;
  });

  it('Codex P3: 区切りの文字を含む ID でも、別のセルへ移れば出す（ID を個別に比べる）', () => {
    const { h, notify } = setup({ rows: ['a\u0000b', 'a'], columns: ['c', 'b\u0000c'] });
    notify.check();
    h.active = { row: 1, col: 1 };
    notify.check();
    expect(changes(h.events)).toHaveLength(2);
  });

  it('Codex P2: selection() は保留中の構造変更を反映してから読む（setData の直後に同じ処理の中で読んでも新しい行）', () => {
    const { h, notify } = setup();
    notify.current();
    expect(h.flushes).toBe(1);
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
