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
export * from './background-bands';
export * from './overlay-layer';
export * from './metrics';
export * from './render-scheduler';
