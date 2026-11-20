// DD-070-3: Ctrl+D・Ctrl+R の写す元と先の決定・SetCells の生成・キーの判定（純粋関数）。
import { describe, expect, it } from 'vitest';

import { SETCELLS_MAX_CELLS, createDocument } from '@nanairo-sheet/core';
import { createColumnId, createRowId } from '@nanairo-sheet/types';
import type { ColumnId, RowId } from '@nanairo-sheet/types';

import { buildFill, decideFillKey, fillRanges } from './fill-ops';
import type { FillKeyInput } from './fill-ops';
import type { RangeDocumentPort } from './range-ops';

/** rows × cols の表示文字列の表（rowIds は r0..、columnIds は c0..）を読むポート。 */
function portOf(grid: string[][]): RangeDocumentPort {
  const committed = createDocument(grid[0]!.map((_v, c) => createColumnId(`c${c}`)));
  return {
    getCommittedDocument: () => committed,
    displayText: (rowId: RowId, columnId: ColumnId) => grid[Number(String(rowId).slice(1))]?.[Number(String(columnId).slice(1))] ?? '',
    rowIdAt: (i) => (i >= 0 && i < grid.length ? createRowId(`r${i}`) : undefined),
    colIdAt: (i) => (i >= 0 && i < grid[0]!.length ? createColumnId(`c${i}`) : undefined),
  };
}

const range = (rowStart: number, rowEnd: number, colStart: number, colEnd: number) => ({ rowStart, rowEnd, colStart, colEnd });

describe('DD-070-3 fillRanges', () => {
  it('down: 2 行以上は一番上の行を残りの行へ。1 行は上の行から範囲へ。先頭の行の 1 行は写す元が無い', () => {
    expect(fillRanges(range(2, 5, 1, 3), 'down')).toEqual({ source: range(2, 3, 1, 3), target: range(3, 5, 1, 3) });
    expect(fillRanges(range(2, 3, 1, 3), 'down')).toEqual({ source: range(1, 2, 1, 3), target: range(2, 3, 1, 3) });
    expect(fillRanges(range(0, 1, 0, 1), 'down')).toBeNull();
  });

  it('right: 2 列以上は一番左の列を残りの列へ。1 列は左の列から範囲へ。先頭の列の 1 列は写す元が無い', () => {
    expect(fillRanges(range(1, 3, 2, 4), 'right')).toEqual({ source: range(1, 3, 2, 3), target: range(1, 3, 3, 4) });
    expect(fillRanges(range(1, 2, 2, 3), 'right')).toEqual({ source: range(1, 2, 1, 2), target: range(1, 2, 2, 3) });
    expect(fillRanges(range(1, 2, 0, 1), 'right')).toBeNull();
  });

  it('空の範囲は null', () => {
    expect(fillRanges(range(2, 2, 0, 1), 'down')).toBeNull();
  });
});

describe('DD-070-3 buildFill', () => {
  const grid = [
    ['A', '1', ''],
    ['B', '', 'x'],
    ['', '1', 'y'],
  ];

  it('down（範囲）: 列ごとに一番上の値を写し、同じ値のセルは書かない。空を写すと空にする', () => {
    const outcome = buildFill(portOf(grid), range(0, 3, 0, 3), 'down');
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    const changes = outcome.operation.changes.map((c) => [String(c.rowId), String(c.columnId), c.value]);
    expect(changes).toEqual([
      ['r1', 'c0', { kind: 'string', value: 'A' }],
      ['r1', 'c1', { kind: 'number', value: 1 }],
      ['r1', 'c2', { kind: 'blank' }],
      ['r2', 'c0', { kind: 'string', value: 'A' }],
      // r2 c1 は既に '1'（同じ値は書かない）
      ['r2', 'c2', { kind: 'blank' }],
    ]);
    expect(outcome.cellCount).toBe(6);
  });

  it('down（1 セル）: 上のセルの値を写す', () => {
    const outcome = buildFill(portOf(grid), range(1, 2, 1, 2), 'down');
    expect(outcome).toMatchObject({ kind: 'submit', operation: { changes: [{ value: { kind: 'number', value: 1 } }] } });
  });

  it('right（1 セル）: 左のセルの値を写す。文字列として保つ列は型変換しない', () => {
    const outcome = buildFill(portOf(grid), range(0, 1, 2, 3), 'right', (columnId) => columnId === 'c2');
    expect(outcome).toMatchObject({ kind: 'submit', operation: { changes: [{ columnId: 'c2', value: { kind: 'string', value: '1' } }] } });
  });

  it('変わるセルが無い・写す元が無いなら noop', () => {
    expect(buildFill(portOf([['1'], ['1']]), range(0, 2, 0, 1), 'down')).toEqual({ kind: 'noop' });
    expect(buildFill(portOf(grid), range(0, 1, 0, 1), 'down')).toEqual({ kind: 'noop' });
  });

  it('写す先のセル数が上限を超えたら走査せずに拒否する', () => {
    const huge = range(0, SETCELLS_MAX_CELLS + 2, 0, 1);
    expect(buildFill(portOf(grid), huge, 'down')).toEqual({ kind: 'too-large', cellCount: SETCELLS_MAX_CELLS + 1, limit: SETCELLS_MAX_CELLS });
  });
});

describe('DD-070-3 decideFillKey', () => {
  const base: FillKeyInput = {
    key: 'd',
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    eventComposing: false,
    sessionComposing: false,
    phase: 'Navigation',
  };

  it('Navigation の Ctrl+D は down、Ctrl+R は right（大文字・Cmd も同じ）', () => {
    expect(decideFillKey(base)).toBe('down');
    expect(decideFillKey({ ...base, key: 'R' })).toBe('right');
    expect(decideFillKey({ ...base, ctrlKey: false, metaKey: true })).toBe('down');
  });

  it('編集中は block（写さないがブラウザーの既定を止める）', () => {
    expect(decideFillKey({ ...base, phase: 'EditingReplace' })).toBe('block');
  });

  it('変換中・修飾なし・Shift・Alt・別のキーは none', () => {
    expect(decideFillKey({ ...base, eventComposing: true })).toBe('none');
    expect(decideFillKey({ ...base, sessionComposing: true, phase: 'Composing' })).toBe('none');
    expect(decideFillKey({ ...base, ctrlKey: false })).toBe('none');
    expect(decideFillKey({ ...base, shiftKey: true })).toBe('none');
    expect(decideFillKey({ ...base, altKey: true })).toBe('none');
    expect(decideFillKey({ ...base, key: 'c' })).toBe('none');
  });
});
