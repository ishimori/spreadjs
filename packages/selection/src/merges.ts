// 結合範囲（DD-064）の索引と、結合を 1 つのセルとして扱う選択・移動の純関数（DOM 非依存・render と grid が共有する）。
//
// 範囲は表示 index の半開区間（CellRange）。**重ならないこと**を前提にする（重なりの除去・固定行列の境界の判定は、
// 呼び出し側〔grid の結合の解決〕が済ませてから渡す）。1×1 の範囲は渡さない（結合ではない）。

import type { CellPos, CellRange } from './selection';

/** 結合を 1 つのセルとして動く方向（ime の NavigationDirection と同じ値。依存を増やさないため自前で持つ）。 */
export type MergeMoveDirection = 'up' | 'down' | 'left' | 'right';

/** 移動・拡張のクランプ境界（表示 Axis の行数・列数）。 */
export interface MergeBounds {
  readonly rowCount: number;
  readonly colCount: number;
}

/** 結合範囲の索引。 */
export interface MergeIndex {
  /** 結合の数。 */
  readonly size: number;
  /** (row, col) を含む結合（無ければ undefined）。 */
  at(row: number, col: number): CellRange | undefined;
  /** range と交わる結合（行の昇順・同じ行は列の昇順）。 */
  intersecting(range: CellRange): readonly CellRange[];
  /** すべての結合（行の昇順・同じ行は列の昇順）。 */
  all(): readonly CellRange[];
}

const NO_RANGES: readonly CellRange[] = [];

/** 結合の無い索引（共有の不変値）。 */
export const EMPTY_MERGE_INDEX: MergeIndex = {
  size: 0,
  at: () => undefined,
  intersecting: () => NO_RANGES,
  all: () => NO_RANGES,
};

function intersects(a: CellRange, b: CellRange): boolean {
  return a.rowStart < b.rowEnd && b.rowStart < a.rowEnd && a.colStart < b.colEnd && b.colStart < a.colEnd;
}

/**
 * 結合範囲の索引を作る。`at` は行ごとの表（覆う行の数だけの要素）で O(その行の結合数)、`intersecting` は
 * 上端の昇順の配列と「そこまでの下端の最大値」で、交わりうる所だけを走査する（大きな範囲の選択でも全件を見ない）。
 */
export function createMergeIndex(ranges: readonly CellRange[]): MergeIndex {
  if (ranges.length === 0) {
    return EMPTY_MERGE_INDEX;
  }
  const sorted = [...ranges].sort((a, b) => a.rowStart - b.rowStart || a.colStart - b.colStart);
  // prefixMaxRowEnd[i] = sorted[0..i] の rowEnd の最大値。後ろから走査して、この値が query の上端以下になったら打ち切る。
  const prefixMaxRowEnd: number[] = [];
  let maxRowEnd = Number.NEGATIVE_INFINITY;
  for (const range of sorted) {
    maxRowEnd = Math.max(maxRowEnd, range.rowEnd);
    prefixMaxRowEnd.push(maxRowEnd);
  }
  const byRow = new Map<number, CellRange[]>();
  for (const range of sorted) {
    for (let row = range.rowStart; row < range.rowEnd; row += 1) {
      const list = byRow.get(row);
      if (list === undefined) {
        byRow.set(row, [range]);
      } else {
        list.push(range);
      }
    }
  }
  /** rowStart < limit を満たす最後の要素の位置（無ければ -1）。 */
  const lastStartingBefore = (limit: number): number => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]!.rowStart < limit) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo - 1;
  };
  return {
    size: sorted.length,
    at(row, col) {
      const list = byRow.get(row);
      if (list === undefined) {
        return undefined;
      }
      for (const range of list) {
        if (col >= range.colStart && col < range.colEnd) {
          return range;
        }
      }
      return undefined;
    },
    intersecting(range) {
      if (range.rowEnd <= range.rowStart || range.colEnd <= range.colStart) {
        return NO_RANGES;
      }
      const found: CellRange[] = [];
      for (let i = lastStartingBefore(range.rowEnd); i >= 0; i -= 1) {
        if (prefixMaxRowEnd[i]! <= range.rowStart) {
          break; // これより前の結合はどれも query の上端より上で終わっている
        }
        const candidate = sorted[i]!;
        if (intersects(candidate, range)) {
          found.push(candidate);
        }
      }
      return found.reverse();
    },
    all: () => sorted,
  };
}

/** (row, col) を含む結合の左上（結合の外ならそのまま）。 */
export function mergeAnchorOf(index: MergeIndex, pos: CellPos): CellPos {
  const range = index.size === 0 ? undefined : index.at(pos.row, pos.col);
  return range === undefined ? pos : { row: range.rowStart, col: range.colStart };
}

/** range を、交わる結合を全部含むまで広げる（Excel と同じ。結合が無ければそのまま）。 */
export function expandRangeToMerges(index: MergeIndex, range: CellRange): CellRange {
  if (index.size === 0) {
    return range;
  }
  let current = range;
  for (;;) {
    let next = current;
    for (const merge of index.intersecting(current)) {
      if (
        merge.rowStart < next.rowStart ||
        merge.rowEnd > next.rowEnd ||
        merge.colStart < next.colStart ||
        merge.colEnd > next.colEnd
      ) {
        next = {
          rowStart: Math.min(next.rowStart, merge.rowStart),
          rowEnd: Math.max(next.rowEnd, merge.rowEnd),
          colStart: Math.min(next.colStart, merge.colStart),
          colEnd: Math.max(next.colEnd, merge.colEnd),
        };
      }
    }
    if (next === current) {
      return current; // 広がらなくなった（範囲は毎回厳密に大きくなるので必ず止まる）
    }
    current = next;
  }
}

/** range が 1 つの結合そのものか（結合を 1 セルとして選んでいる状態＝単一選択として扱う）。 */
export function isSingleMergeRange(index: MergeIndex, range: CellRange): boolean {
  if (index.size === 0) {
    return false;
  }
  const merge = index.at(range.rowStart, range.colStart);
  return (
    merge !== undefined &&
    merge.rowStart === range.rowStart &&
    merge.rowEnd === range.rowEnd &&
    merge.colStart === range.colStart &&
    merge.colEnd === range.colEnd
  );
}

function clampPos(pos: CellPos, bounds: MergeBounds): CellPos {
  return {
    row: Math.min(Math.max(pos.row, 0), Math.max(bounds.rowCount - 1, 0)),
    col: Math.min(Math.max(pos.col, 0), Math.max(bounds.colCount - 1, 0)),
  };
}

/**
 * from から direction へ 1 セル動いた先（境界でクランプ）。from が結合の中なら、その結合の端から 1 つ外へ出る
 * （下＝結合の次の行・右＝結合の次の列・上と左は結合の手前）。動いた先が別の結合の中でも正規化しない
 * （範囲の焦点の移動に使う。アクティブセルの移動は moveAcrossMerges）。
 */
export function stepAcrossMerges(
  index: MergeIndex,
  from: CellPos,
  direction: MergeMoveDirection,
  bounds: MergeBounds,
): CellPos {
  const merge = index.size === 0 ? undefined : index.at(from.row, from.col);
  let row = from.row;
  let col = from.col;
  switch (direction) {
    case 'up':
      row = (merge?.rowStart ?? from.row) - 1;
      break;
    case 'down':
      row = merge === undefined ? from.row + 1 : merge.rowEnd;
      break;
    case 'left':
      col = (merge?.colStart ?? from.col) - 1;
      break;
    case 'right':
      col = merge === undefined ? from.col + 1 : merge.colEnd;
      break;
  }
  return clampPos({ row, col }, bounds);
}

/**
 * アクティブセルの移動（矢印キー・Tab・Enter）。結合を 1 つのセルとして動き、動いた先が結合の中なら左上へ寄せる。
 * グリッドの端で結合の外へ出られないときは、from の結合の左上に留まる。
 */
export function moveAcrossMerges(
  index: MergeIndex,
  from: CellPos,
  direction: MergeMoveDirection,
  bounds: MergeBounds,
): CellPos {
  return mergeAnchorOf(index, stepAcrossMerges(index, from, direction, bounds));
}
