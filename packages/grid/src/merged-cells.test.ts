// DD-064 unit: 結合の指定の形の検査と、描画の時に行へ張る解決（固定 ID・保留・壊れたら捨てる・重なり・固定行の境界）。

import { describe, expect, it } from 'vitest';

import { createAxis } from '@nanairo-sheet/render';
import { createRowId, type RowId } from '@nanairo-sheet/types';

import { createMergeRegistry, describeMergeIssues, validateMergedCells, type MergeSpec } from './merged-cells';

const COLUMNS = ['no', 'item', 'kind', 'm04', 'm05'];

function axisOf(ids: readonly string[]) {
  return createAxis<RowId>({ ids: ids.map((id) => createRowId(id)), defaultSize: 22 });
}

function specsOf(raw: unknown, frozenColCount = 0): readonly MergeSpec[] {
  const result = validateMergedCells(raw, COLUMNS, frozenColCount);
  expect(result.issues).toEqual([]);
  return result.specs;
}

function setup() {
  const diagnostics: Array<{ code: string; message: string }> = [];
  const registry = createMergeRegistry((code, message) => diagnostics.push({ code, message }));
  return { registry, diagnostics };
}

describe('validateMergedCells（形の検査）', () => {
  it('列を index に解決し、省略した span を 1 にする', () => {
    expect(specsOf([{ rowId: 'd1:budget', columnId: 'item', rowSpan: 3 }])).toEqual([
      { rowId: 'd1:budget', columnId: 'item', rowSpan: 3, columnSpan: 1, colStart: 1 },
    ]);
  });

  it('形の誤りを指定ごとに挙げ、正しい指定は残す', () => {
    const result = validateMergedCells(
      [
        { rowId: 'a', columnId: 'no', rowSpan: 2 },
        null,
        { rowId: '', columnId: 'no', rowSpan: 2 },
        { rowId: 'b', columnId: 'unknown', rowSpan: 2 },
        { rowId: 'c', columnId: 'no' },
        { rowId: 'd', columnId: 'm05', columnSpan: 2 },
        { rowId: 'e', columnId: 'no', rowSpan: 1.5 },
        { rowId: 'f', columnId: 'item', columnSpan: 0 },
        { rowId: 'a', columnId: 'no', rowSpan: 3 },
      ],
      COLUMNS,
      0,
    );
    expect(result.specs.map((s) => s.rowId)).toEqual(['a']);
    expect(result.issues.map((i) => i.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(describeMergeIssues(result.issues)).toContain('mergedCells[3]: 未知の列 unknown');
    expect(describeMergeIssues(result.issues)).toContain('mergedCells[4]: 1×1');
    expect(describeMergeIssues(result.issues)).toContain('mergedCells[8]: 同じ左上');
  });

  it('固定列の境界をまたぐ範囲は誤り（固定列の中・スクロール側の中は可）', () => {
    const result = validateMergedCells(
      [
        { rowId: 'a', columnId: 'item', columnSpan: 2 }, // 列 1〜2: 固定 2 列の境界をまたぐ
        { rowId: 'b', columnId: 'no', columnSpan: 2 }, // 列 0〜1: 固定列の中
        { rowId: 'c', columnId: 'kind', columnSpan: 2 }, // 列 2〜3: スクロール側の中
      ],
      COLUMNS,
      2,
    );
    expect(result.issues.map((i) => i.position)).toEqual([0]);
    expect(result.specs.map((s) => s.rowId)).toEqual(['b', 'c']);
  });

  it('配列でなければ notArray（省略は空）', () => {
    expect(validateMergedCells({}, COLUMNS, 0).notArray).toBe(true);
    expect(validateMergedCells(undefined, COLUMNS, 0)).toEqual({ notArray: false, specs: [], issues: [] });
  });
});

describe('createMergeRegistry（描画の時の解決）', () => {
  const DETAILS = ['d1:budget', 'd1:actual', 'd1:diff', 'd2:budget', 'd2:actual', 'd2:diff'];

  it('左上の行から rowSpan 行を張り、行の上下への挿入では行と一緒に動く', () => {
    const { registry, diagnostics } = setup();
    registry.replace(specsOf([{ rowId: 'd2:budget', columnId: 'no', rowSpan: 3 }]));
    expect(registry.resolve(axisOf(DETAILS), 0)).toBe(true);
    expect(registry.index().all()).toEqual([{ rowStart: 3, rowEnd: 6, colStart: 0, colEnd: 1 }]);
    // 上に 2 行入る → 範囲は 2 行下へ動く（壊れない）。
    expect(registry.resolve(axisOf(['x', 'y', ...DETAILS]), 0)).toBe(true);
    expect(registry.index().all()).toEqual([{ rowStart: 5, rowEnd: 8, colStart: 0, colEnd: 1 }]);
    // 下に 1 行入る → 変わらない。
    expect(registry.resolve(axisOf(['x', 'y', ...DETAILS, 'z']), 0)).toBe(false);
    expect(diagnostics).toEqual([]);
  });

  it('範囲の間に行が入った・範囲の行が消えた → 壊れたとして捨てる（warn は 1 回）', () => {
    const { registry, diagnostics } = setup();
    registry.replace(specsOf([
      { rowId: 'd1:budget', columnId: 'no', rowSpan: 3 },
      { rowId: 'd2:budget', columnId: 'no', rowSpan: 3 },
    ]));
    registry.resolve(axisOf(DETAILS), 0);
    // d1 の間に行が入り、d2 は最後の行が消える。
    expect(registry.resolve(axisOf(['d1:budget', 'new', 'd1:actual', 'd1:diff', 'd2:budget', 'd2:actual']), 0)).toBe(true);
    expect(registry.index().size).toBe(0);
    expect(diagnostics.map((d) => d.code)).toEqual(['merged-cell-broken', 'merged-cell-broken']);
    // 元の並びに戻しても、捨てた結合は戻らない（指定し直すまで）。
    registry.resolve(axisOf(DETAILS), 0);
    expect(registry.index().size).toBe(0);
    expect(diagnostics).toHaveLength(2);
  });

  it('指定し直すと今の行の並びで張り直す（同じ内容でも・壊れた結合も戻る）', () => {
    const { registry } = setup();
    const specs = specsOf([{ rowId: 'd1:budget', columnId: 'no', rowSpan: 2 }]);
    registry.replace(specs);
    registry.resolve(axisOf(DETAILS), 0);
    registry.resolve(axisOf(['d1:budget', 'other', 'd1:actual']), 0);
    expect(registry.index().size).toBe(0);
    registry.replace(specs);
    expect(registry.resolve(axisOf(['d1:budget', 'other', 'd1:actual']), 0)).toBe(true);
    expect(registry.index().all()).toEqual([{ rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 }]);
  });

  it('左上の行が無い・行が足りない間は保留して warn を 1 回、行が届いたら張る（行が 0 件の間は判定しない）', () => {
    const { registry, diagnostics } = setup();
    registry.replace(specsOf([{ rowId: 'd2:budget', columnId: 'item', rowSpan: 3 }]));
    expect(registry.resolve(axisOf([]), 0)).toBe(false); // 共同編集モードの snapshot 前＝warn も出さない
    expect(diagnostics).toEqual([]);
    expect(registry.resolve(axisOf(['d1:budget', 'd2:budget']), 0)).toBe(false); // 下に行が足りない
    expect(diagnostics.map((d) => d.code)).toEqual(['merged-cell-unresolved']);
    expect(registry.resolve(axisOf(DETAILS), 0)).toBe(true);
    expect(registry.index().all()).toEqual([{ rowStart: 3, rowEnd: 6, colStart: 1, colEnd: 2 }]);
    expect(diagnostics).toHaveLength(1);
  });

  it('固定行の境界をまたぐ・先の指定と重なる結合は描かない（warn は理由ごとに 1 回・条件が解ければ描く）', () => {
    const { registry, diagnostics } = setup();
    registry.replace(specsOf([
      { rowId: 'd1:budget', columnId: 'no', rowSpan: 3 },
      { rowId: 'd1:actual', columnId: 'no', rowSpan: 2 },
      { rowId: 'd2:budget', columnId: 'no', rowSpan: 2, columnSpan: 2 },
    ]));
    // 固定 1 行: 1 つ目は境界をまたぐので描かない。2 つ目は 1 つ目が描かれないので重ならず描く。
    registry.resolve(axisOf(DETAILS), 1);
    expect(registry.index().all()).toEqual([
      { rowStart: 1, rowEnd: 3, colStart: 0, colEnd: 1 },
      { rowStart: 3, rowEnd: 5, colStart: 0, colEnd: 2 },
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual(['merged-cell-conflict']);
    // 固定なし: 1 つ目が描かれ、2 つ目は重なるので描かない。
    registry.resolve(axisOf(DETAILS), 0);
    expect(registry.index().all()).toEqual([
      { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 1 },
      { rowStart: 3, rowEnd: 5, colStart: 0, colEnd: 2 },
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual(['merged-cell-conflict', 'merged-cell-conflict']);
  });

  it('同じ指定を渡し直しても、張れない理由の warn は出し直さない', () => {
    const { registry, diagnostics } = setup();
    const specs = specsOf([{ rowId: 'missing', columnId: 'no', rowSpan: 2 }]);
    for (let i = 0; i < 3; i += 1) {
      registry.replace(specs);
      registry.resolve(axisOf(DETAILS), 0);
    }
    expect(diagnostics.map((d) => d.code)).toEqual(['merged-cell-unresolved']);
    // 内容が変われば数え直す。
    registry.replace(specsOf([{ rowId: 'missing', columnId: 'no', rowSpan: 3 }]));
    registry.resolve(axisOf(DETAILS), 0);
    expect(diagnostics).toHaveLength(2);
  });

  it('指定が前回と同じで行 Axis も同じなら解決し直さない', () => {
    const { registry } = setup();
    registry.replace(specsOf([{ rowId: 'd1:budget', columnId: 'no', rowSpan: 2 }]));
    const axis = axisOf(DETAILS);
    expect(registry.resolve(axis, 0)).toBe(true);
    const index = registry.index();
    expect(registry.resolve(axis, 0)).toBe(false);
    expect(registry.index()).toBe(index);
    expect(registry.hasSpecs()).toBe(true);
    registry.replace([]);
    expect(registry.resolve(axis, 0)).toBe(true);
    expect(registry.index().size).toBe(0);
    expect(registry.hasSpecs()).toBe(false);
  });
});
