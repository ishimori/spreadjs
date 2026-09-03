// DD-035 R4 unit: 列単位 readOnly（readOnlyColumns）の registry 検証と SetCells フィルタ（純関数・DOM 非依存）。
//   - createColumnTypeRegistry の readOnlyColumns 検証（未知列・重複は fail-fast＝column-types-invalid 経路）と参照系
//   - partitionReadOnlyColumnChanges（貼り付け・範囲クリア・cut が共有するスキップ）／touchesReadOnlyColumn（chokepoint）
//   - date 列タイプ（DD-035 R2）の registry 検証（openOn の 2 値・参照系）も同居させる（column-types.test.ts は無修正）

import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId } from '@nanairo-sheet/types';
import type { SetCellsChange } from '@nanairo-sheet/core';

import { ColumnTypeConfigError, createColumnTypeRegistry } from './column-types';
import { partitionReadOnlyColumnChanges, touchesReadOnlyColumn } from './readonly-policy';

const ORDER = ['a', 'b', 'c'];

function change(columnId: string, rowId = 'r1'): SetCellsChange {
  return {
    rowId: createRowId(rowId),
    columnId: createColumnId(columnId),
    beforeRevision: 0,
    value: { kind: 'string', value: 'x' },
  };
}

describe('readOnlyColumns の registry 検証（AC3/AC9）', () => {
  it('指定列だけ isReadOnlyColumn=true・hasAnyReadOnlyColumn=true（列タイプと直交＝select 列にも付く）', () => {
    const registry = createColumnTypeRegistry({ b: { type: 'select', options: ['x'] } }, ORDER, undefined, ['b', 'c']);
    expect(registry.isReadOnlyColumn('a')).toBe(false);
    expect(registry.isReadOnlyColumn('b')).toBe(true);
    expect(registry.isReadOnlyColumn('c')).toBe(true);
    expect(registry.hasAnyReadOnlyColumn()).toBe(true);
    expect(registry.isSelectColumn('b')).toBe(true); // 型は保持される
  });

  it('未指定/空なら hasAnyReadOnlyColumn=false（現行挙動）', () => {
    expect(createColumnTypeRegistry(undefined, ORDER).hasAnyReadOnlyColumn()).toBe(false);
    expect(createColumnTypeRegistry(undefined, ORDER, undefined, []).hasAnyReadOnlyColumn()).toBe(false);
  });

  it('未知列・重複は ColumnTypeConfigError（fail-fast）', () => {
    expect(() => createColumnTypeRegistry(undefined, ORDER, undefined, ['zz'])).toThrow(ColumnTypeConfigError);
    try {
      createColumnTypeRegistry(undefined, ORDER, undefined, ['zz']);
    } catch (error) {
      expect((error as ColumnTypeConfigError).reason).toBe('readonly-unknown-column');
      expect((error as ColumnTypeConfigError).columnId).toBe('zz');
    }
    expect(() => createColumnTypeRegistry(undefined, ORDER, undefined, ['a', 'a'])).toThrow(/重複/);
  });
});

describe('date 列タイプの registry 検証（AC1/AC9）', () => {
  it('date 列は isDateColumn/getDateType/hasAnyDateColumn で参照でき、openOn 未指定は undefined（既定 dblclick は呼び出し側）', () => {
    const registry = createColumnTypeRegistry({ a: { type: 'date' }, b: { type: 'date', openOn: 'icon' } }, ORDER);
    expect(registry.isDateColumn('a')).toBe(true);
    expect(registry.isDateColumn('c')).toBe(false);
    expect(registry.getDateType('a')).toEqual({ type: 'date' });
    expect(registry.getDateType('b')?.openOn).toBe('icon');
    expect(registry.hasAnyDateColumn()).toBe(true);
    expect(registry.isSelectColumn('a')).toBe(false);
    expect(registry.isLinkColumn('a')).toBe(false);
    // 日付列は入力規則ではない: editor 経路の validator は常に許可（非日付文字列の手入力も拒否しない）。
    expect(registry.validateEditorCommit('a', 'abc').allowed).toBe(true);
  });

  it('openOn の不正値は fail-fast（date-open-on-invalid）／wrap 列との併用は許可', () => {
    expect(() =>
      createColumnTypeRegistry({ a: { type: 'date', openOn: 'hover' as unknown as 'icon' } }, ORDER),
    ).toThrow(ColumnTypeConfigError);
    expect(() => createColumnTypeRegistry({ a: { type: 'date' } }, ORDER, ['a'])).not.toThrow();
    expect(createColumnTypeRegistry(undefined, ORDER).hasAnyDateColumn()).toBe(false);
  });
});

describe('partitionReadOnlyColumnChanges / touchesReadOnlyColumn（AC4）', () => {
  const isRO = (columnId: string): boolean => columnId === 'b';

  it('readOnly 列の変更だけ除き、順序を維持して件数を返す', () => {
    const changes = [change('a'), change('b'), change('c'), change('b', 'r2'), change('a', 'r2')];
    const result = partitionReadOnlyColumnChanges(changes, isRO);
    expect(result.kept.map((c) => `${String(c.rowId)}/${String(c.columnId)}`)).toEqual(['r1/a', 'r1/c', 'r2/a']);
    expect(result.skipped).toBe(2);
  });

  it('全セルが readOnly 列なら kept 空・skipped=全件（呼び出し側は no-op）／readOnly 無しなら無変更', () => {
    const all = partitionReadOnlyColumnChanges([change('b'), change('b', 'r2')], isRO);
    expect(all.kept).toEqual([]);
    expect(all.skipped).toBe(2);
    const none = partitionReadOnlyColumnChanges([change('a'), change('c')], isRO);
    expect(none.kept).toHaveLength(2);
    expect(none.skipped).toBe(0);
  });

  it('touchesReadOnlyColumn は 1 件でも含めば true', () => {
    expect(touchesReadOnlyColumn([change('a'), change('b')], isRO)).toBe(true);
    expect(touchesReadOnlyColumn([change('a'), change('c')], isRO)).toBe(false);
    expect(touchesReadOnlyColumn([], isRO)).toBe(false);
  });
});
