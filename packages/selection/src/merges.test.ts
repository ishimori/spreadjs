// DD-064 unit: 結合範囲の索引と、結合を 1 つのセルとして扱う選択・移動の純関数。

import { describe, expect, it } from 'vitest';

import {
  EMPTY_MERGE_INDEX,
  createMergeIndex,
  expandRangeToMerges,
  isSingleMergeRange,
  mergeAnchorOf,
  moveAcrossMerges,
  stepAcrossMerges,
} from './merges';
import type { CellRange } from './selection';

const range = (rowStart: number, rowEnd: number, colStart: number, colEnd: number): CellRange => ({
  rowStart,
  rowEnd,
  colStart,
  colEnd,
});

// 明細ごとの 3 行（予算・実績＋見通し・差異）で、属性の列 0・1 を縦に結合した形（consumer の入力シート）。
const DETAIL_MERGES = [range(0, 3, 0, 1), range(0, 3, 1, 2), range(3, 6, 0, 1), range(3, 6, 1, 2)];
const BOUNDS = { rowCount: 9, colCount: 5 };

describe('createMergeIndex', () => {
  it('セルを含む結合を返す（結合の外は undefined）', () => {
    const index = createMergeIndex(DETAIL_MERGES);
    expect(index.size).toBe(4);
    expect(index.at(1, 0)).toEqual(range(0, 3, 0, 1));
    expect(index.at(5, 1)).toEqual(range(3, 6, 1, 2));
    expect(index.at(1, 2)).toBeUndefined();
    expect(index.at(6, 0)).toBeUndefined();
  });

  it('矩形に交わる結合を行・列の昇順で返す', () => {
    const index = createMergeIndex([...DETAIL_MERGES].reverse());
    expect(index.intersecting(range(2, 4, 0, 5))).toEqual(DETAIL_MERGES);
    expect(index.intersecting(range(2, 4, 1, 2))).toEqual([range(0, 3, 1, 2), range(3, 6, 1, 2)]);
    expect(index.intersecting(range(6, 9, 0, 5))).toEqual([]);
    expect(index.intersecting(range(0, 9, 2, 5))).toEqual([]);
  });

  it('長い結合が前にあっても、上端より上で終わる結合で打ち切らずに見つける', () => {
    // 先頭の長い結合（行 0〜99）の後に短い結合が並ぶ。query（行 50）は先頭の長い結合と交わる。
    const index = createMergeIndex([range(0, 100, 0, 1), range(10, 12, 1, 2), range(60, 62, 1, 2)]);
    expect(index.intersecting(range(50, 51, 0, 2))).toEqual([range(0, 100, 0, 1)]);
    expect(index.intersecting(range(61, 62, 0, 2))).toEqual([range(0, 100, 0, 1), range(60, 62, 1, 2)]);
  });

  it('結合が無ければ共有の空の索引', () => {
    expect(createMergeIndex([])).toBe(EMPTY_MERGE_INDEX);
    expect(EMPTY_MERGE_INDEX.at(0, 0)).toBeUndefined();
    expect(EMPTY_MERGE_INDEX.intersecting(range(0, 9, 0, 9))).toEqual([]);
  });
});

describe('mergeAnchorOf・expandRangeToMerges・isSingleMergeRange', () => {
  const index = createMergeIndex([...DETAIL_MERGES, range(6, 8, 2, 4)]);

  it('結合の中のセルは左上へ寄せる（外はそのまま）', () => {
    expect(mergeAnchorOf(index, { row: 2, col: 1 })).toEqual({ row: 0, col: 1 });
    expect(mergeAnchorOf(index, { row: 7, col: 3 })).toEqual({ row: 6, col: 2 });
    expect(mergeAnchorOf(index, { row: 2, col: 2 })).toEqual({ row: 2, col: 2 });
  });

  it('範囲にかかった結合を全部含むまで広げる（連鎖して広がる場合も含む）', () => {
    // 行 2〜3 の列 0 だけを選んでも、上の結合（0〜2）と下の結合（3〜5）を含むまで広がる。
    expect(expandRangeToMerges(index, range(2, 4, 0, 1))).toEqual(range(0, 6, 0, 1));
    // 列 1〜2 の行 5〜6 → 列 1 の結合（3〜5）と、列 2〜3 の結合（6〜7）を含む。
    expect(expandRangeToMerges(index, range(5, 7, 1, 3))).toEqual(range(3, 8, 1, 4));
    // 結合に触れない範囲はそのまま（同じ参照）。
    const untouched = range(0, 2, 2, 4);
    expect(expandRangeToMerges(index, untouched)).toBe(untouched);
  });

  it('1 つの結合そのものの範囲を見分ける', () => {
    expect(isSingleMergeRange(index, range(0, 3, 0, 1))).toBe(true);
    expect(isSingleMergeRange(index, range(0, 3, 0, 2))).toBe(false);
    expect(isSingleMergeRange(index, range(0, 1, 0, 1))).toBe(false);
    expect(isSingleMergeRange(EMPTY_MERGE_INDEX, range(0, 3, 0, 1))).toBe(false);
  });
});

describe('moveAcrossMerges（矢印キー・Tab・Enter）', () => {
  const index = createMergeIndex([...DETAIL_MERGES, range(6, 9, 0, 1)]);

  it('結合の左上から下・右へ動くと範囲の外へ出る', () => {
    expect(moveAcrossMerges(index, { row: 0, col: 0 }, 'down', BOUNDS)).toEqual({ row: 3, col: 0 });
    expect(moveAcrossMerges(index, { row: 0, col: 1 }, 'right', BOUNDS)).toEqual({ row: 0, col: 2 });
    expect(moveAcrossMerges(index, { row: 3, col: 1 }, 'up', BOUNDS)).toEqual({ row: 0, col: 1 });
    expect(moveAcrossMerges(index, { row: 3, col: 1 }, 'left', BOUNDS)).toEqual({ row: 3, col: 0 });
  });

  it('結合の中へ入ったら左上になる', () => {
    expect(moveAcrossMerges(index, { row: 4, col: 2 }, 'left', BOUNDS)).toEqual({ row: 3, col: 1 });
    expect(moveAcrossMerges(index, { row: 2, col: 2 }, 'left', BOUNDS)).toEqual({ row: 0, col: 1 });
  });

  it('グリッドの端で外へ出られなければ結合の左上に留まる', () => {
    // 行 6〜8 の結合はグリッドの最下行まで届いている。
    expect(moveAcrossMerges(index, { row: 6, col: 0 }, 'down', BOUNDS)).toEqual({ row: 6, col: 0 });
    expect(moveAcrossMerges(index, { row: 0, col: 0 }, 'left', BOUNDS)).toEqual({ row: 0, col: 0 });
    expect(moveAcrossMerges(index, { row: 0, col: 0 }, 'up', BOUNDS)).toEqual({ row: 0, col: 0 });
  });

  it('結合が無ければ 1 セル動いて端でクランプする（現行の動きと同じ）', () => {
    expect(moveAcrossMerges(EMPTY_MERGE_INDEX, { row: 0, col: 0 }, 'down', BOUNDS)).toEqual({ row: 1, col: 0 });
    expect(moveAcrossMerges(EMPTY_MERGE_INDEX, { row: 8, col: 4 }, 'right', BOUNDS)).toEqual({ row: 8, col: 4 });
  });
});

describe('stepAcrossMerges（Shift＋矢印の焦点）', () => {
  const index = createMergeIndex(DETAIL_MERGES);

  it('焦点が結合の中なら、その結合の端から 1 つ外へ動く（動いた先は正規化しない）', () => {
    expect(stepAcrossMerges(index, { row: 1, col: 0 }, 'down', BOUNDS)).toEqual({ row: 3, col: 0 });
    expect(stepAcrossMerges(index, { row: 5, col: 0 }, 'up', BOUNDS)).toEqual({ row: 2, col: 0 });
    expect(stepAcrossMerges(index, { row: 2, col: 0 }, 'right', BOUNDS)).toEqual({ row: 2, col: 1 });
  });
});
