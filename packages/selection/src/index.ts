// @nanairo-sheet/selection — 選択範囲（矩形）ユーティリティ（内部 package）。
// consumer は直接 import せず Facade（grid）経由で使う（R1）。render/grid が共有する。

export { rangeFromAnchorFocus, rangeContains, singleCell } from './selection';
export type { CellRange, CellPos } from './selection';
// DD-064: 結合範囲の索引と、結合を 1 つのセルとして扱う選択・移動。
export {
  EMPTY_MERGE_INDEX,
  createMergeIndex,
  expandRangeToMerges,
  isSingleMergeRange,
  mergeAnchorOf,
  moveAcrossMerges,
  stepAcrossMerges,
} from './merges';
export type { MergeBounds, MergeIndex, MergeMoveDirection } from './merges';
