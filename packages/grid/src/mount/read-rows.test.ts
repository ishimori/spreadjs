// DD-070-5: 表のデータを読む（readRows）の単体。文書の並び・空のセルは載せない・絞り込み・削除した行は含めない。
import { describe, expect, it } from 'vitest';

import { applyOperation, createDocument } from '@nanairo-sheet/core';
import type { CellScalar, SheetDocument } from '@nanairo-sheet/core';
import { createColumnId, createRowId } from '@nanairo-sheet/types';

import { readRows } from './read-rows';

function docWith(rows: Array<{ id: string; cells: Record<string, CellScalar> }>): SheetDocument {
  let doc = createDocument(['a', 'b', 'c'].map((c) => createColumnId(c)));
  doc = applyOperation(
    doc,
    { type: 'insertRows', afterRowId: null, rows: rows.map((r) => ({ rowId: createRowId(r.id) })) },
    { revision: 1 },
  ).document;
  const changes = rows.flatMap((r) =>
    Object.entries(r.cells).map(([col, value]) => ({ rowId: createRowId(r.id), columnId: createColumnId(col), beforeRevision: 0, value })),
  );
  if (changes.length > 0) {
    doc = applyOperation(doc, { type: 'setCells', conflictPolicy: 'reject-overlap', changes }, { revision: 2 }).document;
  }
  return doc;
}

describe('DD-070-5 readRows', () => {
  const doc = docWith([
    { id: 'r1', cells: { a: { kind: 'string', value: '品名' }, b: { kind: 'number', value: 1234.5 } } },
    { id: 'r2', cells: {} },
    { id: 'r3', cells: { c: { kind: 'date', value: '2026-01-02' } } },
  ]);

  it('文書の並びで全部の行を返し、空のセルは載せない（数値は桁区切りなし・日付は YYYY-MM-DD）', () => {
    expect(readRows(doc)).toEqual([
      { rowId: 'r1', cells: { a: '品名', b: '1234.5' } },
      { rowId: 'r2', cells: {} },
      { rowId: 'r3', cells: { c: '2026-01-02' } },
    ]);
  });

  it('columnIds・rowIds で絞れる（未知は無視・並びは文書の並び）', () => {
    expect(readRows(doc, { columnIds: ['b', 'zz'] })).toEqual([
      { rowId: 'r1', cells: { b: '1234.5' } },
      { rowId: 'r2', cells: {} },
      { rowId: 'r3', cells: {} },
    ]);
    expect(readRows(doc, { rowIds: ['r3', 'r1', 'nope'] }).map((r) => r.rowId)).toEqual(['r1', 'r3']);
  });

  it('削除した行は含めない', () => {
    const deleted = applyOperation(doc, { type: 'deleteRows', rowIds: [createRowId('r2')] }, { revision: 3 }).document;
    expect(readRows(deleted).map((r) => r.rowId)).toEqual(['r1', 'r3']);
  });

  it('JS の不正な options（配列でない）は空として扱い、例外にしない', () => {
    expect(readRows(doc, { columnIds: 'a' as never })).toEqual([
      { rowId: 'r1', cells: {} },
      { rowId: 'r2', cells: {} },
      { rowId: 'r3', cells: {} },
    ]);
    expect(readRows(doc, { rowIds: 3 as never })).toEqual([]);
  });
});
