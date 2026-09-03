// DD-036 C1 unit: 固定行列数を 1 以外へ可変化しても 4 象限 pane・セル矩形・ヒットテストが破れないこと。
//
// viewport.test.ts（DD-004）は固定 0/1 だけを検証していた。本DDで公開オプション化（frozenRowCount /
// frozenColumnCount）したため、n>1・0・列数超過（クランプ）を明示的に固定する。

import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId, type ColumnId, type RowId } from '@nanairo-sheet/types';

import { createAxis } from './axis';
import { createViewportTransform, type PaneId, type PaneRange, type ViewportConfig } from './viewport';

function makeRowAxis(count: number): ReturnType<typeof createAxis<RowId>> {
  return createAxis({ ids: Array.from({ length: count }, (_v, i) => createRowId(`r${i}`)), defaultSize: 22 });
}
function makeColAxis(count: number): ReturnType<typeof createAxis<ColumnId>> {
  return createAxis({ ids: Array.from({ length: count }, (_v, i) => createColumnId(`c${i}`)), defaultSize: 56 });
}
function config(overrides: Partial<ViewportConfig> = {}): ViewportConfig {
  return {
    rowAxis: makeRowAxis(100),
    colAxis: makeColAxis(200),
    headerWidth: 44,
    headerHeight: 24,
    frozenRowCount: 1,
    frozenColCount: 1,
    viewportWidth: 800,
    viewportHeight: 600,
    scrollLeft: 0,
    scrollTop: 0,
    overscanX: 0,
    overscanY: 0,
    ...overrides,
  };
}
function paneOf(panes: readonly PaneRange[], id: PaneId): PaneRange {
  const found = panes.find((p) => p.pane === id);
  if (found === undefined) {
    throw new Error(`pane ${id} が見つからない`);
  }
  return found;
}

describe('DD-036 C1: frozenColCount=5（先頭 5 列固定）', () => {
  const vt = createViewportTransform(config({ frozenColCount: 5, frozenRowCount: 2, scrollLeft: 1000, scrollTop: 500 }));
  const panes = vt.panes();

  it('固定幅・固定高は先頭 n 列/行の合計', () => {
    expect(vt.frozenWidth()).toBe(5 * 56);
    expect(vt.frozenHeight()).toBe(2 * 22);
  });

  it('固定列のセルは横スクロールしても画面左（header 直後）に残る', () => {
    expect(vt.cellRect(0, 0).x).toBe(44);
    expect(vt.cellRect(0, 4).x).toBe(44 + 4 * 56);
    // 直後のスクロール列は固定バンドの外側（scrollLeft ぶん左へ流れている）。
    expect(vt.cellRect(0, 5).x).toBe(44 + 5 * 56 - 1000);
  });

  it('corner/left は [0,5) 列・top/body は固定列より右のスクロール列だけを持つ（重複なし）', () => {
    expect(paneOf(panes, 'corner').cols).toEqual({ start: 0, end: 5 });
    expect(paneOf(panes, 'left').cols).toEqual({ start: 0, end: 5 });
    expect(paneOf(panes, 'corner').rows).toEqual({ start: 0, end: 2 });
    const body = paneOf(panes, 'body');
    expect(body.cols.start).toBeGreaterThanOrEqual(5);
    expect(body.rows.start).toBeGreaterThanOrEqual(2);
    expect(paneOf(panes, 'top').cols).toEqual(body.cols);
  });

  it('固定バンド内のヒットテストはスクロール量に依存しない（pane 境界でずれない）', () => {
    // x=44+4*56+28（列 index4 の中央）は固定バンド内 → scrollLeft=1000 でも colIndex=4。
    const hit = vt.hitTest(44 + 4 * 56 + 28, 24 + 2 * 22 + 11);
    expect(hit.area).toBe('cell');
    expect(hit.colIndex).toBe(4);
    expect(hit.columnId).toBe(createColumnId('c4'));
    // 固定バンドのすぐ右（body 先頭）は scrollLeft を加味した列になる。
    const bodyHit = vt.hitTest(44 + 5 * 56 + 1, 24 + 2 * 22 + 11);
    expect(bodyHit.colIndex).toBeGreaterThanOrEqual(5);
  });
});

describe('DD-036 C1: frozen 0（固定なし）と列数超過のクランプ', () => {
  it('frozenColCount=0 では先頭列もスクロールする', () => {
    const vt = createViewportTransform(config({ frozenColCount: 0, frozenRowCount: 0, scrollLeft: 112 }));
    expect(vt.frozenWidth()).toBe(0);
    expect(vt.cellRect(0, 0).x).toBe(44 - 112);
    expect(paneOf(vt.panes(), 'corner').cols).toEqual({ start: 0, end: 0 });
  });

  it('列数を超える固定指定は列数へクランプされ、スクロール pane が空になる', () => {
    const vt = createViewportTransform(config({ colAxis: makeColAxis(3), frozenColCount: 10, scrollLeft: 500 }));
    expect(vt.frozenWidth()).toBe(3 * 56);
    const body = paneOf(vt.panes(), 'body');
    expect(body.cols).toEqual({ start: 3, end: 3 });
    // 全列が固定＝スクロールしても位置が変わらない。
    expect(vt.cellRect(0, 2).x).toBe(44 + 2 * 56);
  });
});
