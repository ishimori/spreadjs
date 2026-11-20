// @nanairo-sheet/render — Canvas 仮想スクロール描画基盤（内部 package）。
// consumer は直接 import せず Facade（grid）経由で使う（R1）。grid が Canvas 要素・ループを配線する。

export * from './axis';
export * from './viewport';
export * from './scroll-anchor';
export * from './dpi';
export * from './text-cache';
export * from './text-overflow';
export * from './chunk-store';
export * from './data-gen';
export * from './prng';
export * from './presence-sim';
export * from './base-layer';
// DD-070-6: 見出しの印の型と配置（grid の当たり判定が描画と同じ関数を使う）。列記号は base-layer から再 export 済み。
export {
  columnGroupMarkLayout,
  columnHeaderMarkLayout,
  columnHeaderMarkWidth,
  createHeaderLayer,
  type ColumnGroupMark,
  type ColumnHeaderMark,
  type ColumnHeaderMarkLayout,
  type HeaderLayerDeps,
} from './header-layer';
export * from './background-bands';
export * from './overlay-layer';
export * from './metrics';
export * from './render-scheduler';
