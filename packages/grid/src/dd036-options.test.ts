// DD-036 unit: 静的列背景のプリコンパイル（C2）と行単位 readOnly の SetCells フィルタ（C3）。
//
// どちらも DOM 非依存の純関数（配線は E2E が担保する）。列版（DD-035 R4 = readonly-columns.test.ts）と
// 同じ形の契約を行版でも固定する。

import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId } from '@nanairo-sheet/types';
import type { SetCellsChange } from '@nanairo-sheet/core';

import { FormatRuleConfigError, compileColumnBackgrounds } from './format-rules';
import { partitionReadOnlyRowChanges, touchesReadOnlyRow } from './readonly-policy';

const COLUMN_ORDER = ['col-a', 'col-b', 'col-c'];

function change(rowId: string, columnId: string, value: string): SetCellsChange {
  return {
    rowId: createRowId(rowId),
    columnId: createColumnId(columnId),
    beforeRevision: 0,
    value: { kind: 'string', value },
  };
}

describe('DD-036 C2: compileColumnBackgrounds', () => {
  it('未指定なら hasAny()=false・全列 undefined（現行描画と完全一致）', () => {
    const compiled = compileColumnBackgrounds(undefined, COLUMN_ORDER);
    expect(compiled.hasAny()).toBe(false);
    expect(compiled.getBackground('col-a')).toBeUndefined();
  });

  it('空オブジェクトも hasAny()=false（束縛しない＝描画コスト増ゼロ）', () => {
    expect(compileColumnBackgrounds({}, COLUMN_ORDER).hasAny()).toBe(false);
  });

  it('指定列は色を返し、未指定列は undefined を返す', () => {
    const compiled = compileColumnBackgrounds({ 'col-b': '#eef3ff' }, COLUMN_ORDER);
    expect(compiled.hasAny()).toBe(true);
    expect(compiled.getBackground('col-b')).toBe('#eef3ff');
    expect(compiled.getBackground('col-a')).toBeUndefined();
    expect(compiled.getBackground('col-unknown')).toBeUndefined();
  });

  it('未知列は fail-fast（columnFormats と同じ FormatRuleConfigError → 公開 column-types-invalid）', () => {
    expect(() => compileColumnBackgrounds({ 'col-zzz': '#fff' }, COLUMN_ORDER)).toThrow(FormatRuleConfigError);
    try {
      compileColumnBackgrounds({ 'col-zzz': '#fff' }, COLUMN_ORDER);
    } catch (error) {
      expect(error).toBeInstanceOf(FormatRuleConfigError);
      expect((error as FormatRuleConfigError).reason).toBe('unknown-column');
      expect((error as FormatRuleConfigError).columnId).toBe('col-zzz');
    }
  });

  it('空・空白のみの色は fail-fast（死に設定を黙って無効化しない）', () => {
    expect(() => compileColumnBackgrounds({ 'col-b': '' }, COLUMN_ORDER)).toThrow(FormatRuleConfigError);
    expect(() => compileColumnBackgrounds({ 'col-b': '   ' }, COLUMN_ORDER)).toThrow(FormatRuleConfigError);
    try {
      compileColumnBackgrounds({ 'col-b': '' }, COLUMN_ORDER);
    } catch (error) {
      expect((error as FormatRuleConfigError).reason).toBe('empty-color');
    }
  });

  it('色文字列そのものの妥当性は検査しない（Canvas は不正値を無視＝安全・columnFormats と同方針）', () => {
    const compiled = compileColumnBackgrounds({ 'col-b': 'not-a-color' }, COLUMN_ORDER);
    expect(compiled.getBackground('col-b')).toBe('not-a-color');
  });
});

describe('DD-036 C3: partitionReadOnlyRowChanges / touchesReadOnlyRow', () => {
  const changes = [
    change('r0', 'col-a', 'A'),
    change('r1', 'col-a', 'B'),
    change('r1', 'col-b', 'C'),
    change('r2', 'col-a', 'D'),
  ];
  const isReadOnlyRow = (rowId: string): boolean => rowId === 'r1';

  it('readOnly 行のセルだけスキップし、他行は順序を保って残る', () => {
    const { kept, skipped } = partitionReadOnlyRowChanges(changes, isReadOnlyRow);
    expect(skipped).toBe(2);
    expect(kept.map((c) => `${String(c.rowId)}/${String(c.columnId)}`)).toEqual(['r0/col-a', 'r2/col-a']);
  });

  it('全セルが readOnly 行なら kept が空（呼び出し側は no-op）', () => {
    const { kept, skipped } = partitionReadOnlyRowChanges([change('r1', 'col-a', 'B')], isReadOnlyRow);
    expect(skipped).toBe(1);
    expect(kept).toHaveLength(0);
  });

  it('readOnly 行が無ければ全件そのまま（現行経路と一致）', () => {
    const { kept, skipped } = partitionReadOnlyRowChanges(changes, () => false);
    expect(skipped).toBe(0);
    expect(kept).toHaveLength(changes.length);
  });

  it('touchesReadOnlyRow は 1 件でも含めば true（chokepoint の保証層）', () => {
    expect(touchesReadOnlyRow(changes, isReadOnlyRow)).toBe(true);
    expect(touchesReadOnlyRow([change('r0', 'col-a', 'A')], isReadOnlyRow)).toBe(false);
    expect(touchesReadOnlyRow([], isReadOnlyRow)).toBe(false);
  });
});
