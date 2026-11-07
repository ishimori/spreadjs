// DD-065: 結合の部品（mount/merges.ts）を、grid を mount せずに確かめる。
import { describe, expect, it } from 'vitest';

import { createDiagnosticSink } from '../diagnostics';
import type { GridDiagnostic } from '../diagnostics';
import { MergedCellsConfigError } from '../merged-cell-spec';
import { createMerges } from './merges';

function setup() {
  const diagnostics: GridDiagnostic[] = [];
  const merges = createMerges({
    diag: createDiagnosticSink((entry) => diagnostics.push(entry)),
    backend: () => undefined,
    editor: () => undefined,
    frozenRowCount: () => 1,
    frozenColCount: () => 1,
  });
  const codes = () => diagnostics.map((d) => d.code);
  return { merges, codes };
}

const COLUMNS = ['a', 'b', 'c'];

describe('mount/merges: 命令の保留と mount オプション', () => {
  it('列の並びが決まる前の setMergedCells は保留し、mount オプションを置いた後に最後の 1 回だけ適用する', () => {
    const { merges, codes } = setup();
    merges.setFromCommand([]);
    merges.setFromCommand('配列でない'); // 最後の 1 回（形の誤り）
    expect(codes()).toEqual([]); // まだ適用しない
    merges.applyMountOption(undefined, COLUMNS);
    expect(codes()).toEqual(['merged-cells-invalid']); // 保留した最後の 1 回だけが適用された
  });

  it('列の並びが決まった後の setMergedCells はすぐに適用する', () => {
    const { merges, codes } = setup();
    merges.applyMountOption(undefined, COLUMNS);
    merges.setFromCommand('配列でない');
    expect(codes()).toEqual(['merged-cells-invalid']);
  });

  it('mount オプションの形の誤りは MergedCellsConfigError を投げる（fail-fast）', () => {
    const { merges } = setup();
    expect(() => merges.applyMountOption('配列でない', COLUMNS)).toThrow(MergedCellsConfigError);
    expect(() => merges.applyMountOption([{ rowId: 'r1', columnId: 'zz', rowSpan: 2 }], COLUMNS)).toThrow(MergedCellsConfigError);
  });
});

describe('mount/merges: backend・editor が無いあいだ', () => {
  it('張り直し・判定・アクティブセルの寄せは何もしない', () => {
    const { merges } = setup();
    expect(merges.resolve()).toBe(false);
    expect(merges.any()).toBe(false);
    expect(merges.isMergedCellIndex(0, 0)).toBe(false);
    expect(merges.normalizeActiveCell()).toBe(false);
  });
});
