import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId } from '@nanairo-sheet/types';
import type { ColumnId, RowId } from '@nanairo-sheet/types';

import { createAxis } from '@nanairo-sheet/render';
import { createViewportTransform } from '@nanairo-sheet/render';

import {
  computeEditorPlacement,
  computeWrapEditorHeight,
  MAX_WRAP_EDITOR_HEIGHT,
  type PlacementConfig,
} from './editor-placement';

const HEADER_W = 52;
const HEADER_H = 24;
const ROW_H = 22;
const COL_W = 80;
const VIEW_W = 400;
const VIEW_H = 300;

function rowIds(n: number): RowId[] {
  return Array.from({ length: n }, (_v, i) => createRowId(`r${i}`));
}
function colIds(n: number): ColumnId[] {
  return Array.from({ length: n }, (_v, i) => createColumnId(`c${i}`));
}

function transformAt(scrollTop: number, scrollLeft: number) {
  return createViewportTransform({
    rowAxis: createAxis({ ids: rowIds(1000), defaultSize: ROW_H }),
    colAxis: createAxis({ ids: colIds(50), defaultSize: COL_W }),
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    frozenRowCount: 1,
    frozenColCount: 1,
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    scrollLeft,
    scrollTop,
    overscanX: COL_W,
    overscanY: VIEW_H,
  });
}

const CFG: PlacementConfig = {
  headerWidth: HEADER_W,
  headerHeight: HEADER_H,
  viewportWidth: VIEW_W,
  viewportHeight: VIEW_H,
  frozenRowCount: 1,
  frozenColCount: 1,
};

describe('computeEditorPlacement（§13.5 pane 区別・AC3 追従）', () => {
  it('index<0（RowId/ColumnId が Axis に無い）は非可視', () => {
    const t = transformAt(0, 0);
    expect(computeEditorPlacement(t, -1, 3, CFG).visible).toBe(false);
    expect(computeEditorPlacement(t, 3, -1, CFG).visible).toBe(false);
  });

  it('可視領域内のスクロールセルは visible＝true・rect は cellRect と一致', () => {
    const t = transformAt(0, 0);
    const p = computeEditorPlacement(t, 3, 3, CFG);
    expect(p.visible).toBe(true);
    expect(p.rect).toEqual(t.cellRect(3, 3));
  });

  it('スクロールで下方向へ大きく動くと同一 index のセルは画面外＝非可視', () => {
    // row index 3 は上方。scrollTop を十分大きくすると frozen 下端より上へ抜けて隠れる。
    const t = transformAt(5000, 0);
    expect(computeEditorPlacement(t, 3, 3, CFG).visible).toBe(false);
  });

  it('スクロールしても遠い下方の可視行は追従して可視（AC3: 同一 index が画面内に来ると可視）', () => {
    const t = transformAt(5000, 0);
    // scrollTop=5000 付近の行は body に入る。indexAt で可視行を選ぶ。
    const near = t.hitTest(HEADER_W + 100, HEADER_H + (t.frozenHeight() + 50)).rowIndex;
    expect(computeEditorPlacement(t, near, 3, CFG).visible).toBe(true);
  });

  it('固定行（index<frozenRowCount）はスクロールしても常に可視（pane 区別）', () => {
    const scrolled = transformAt(5000, 3000);
    expect(computeEditorPlacement(scrolled, 0, 0, CFG).visible).toBe(true); // corner（固定行×固定列）
  });

  it('スクロールセルが固定バンドの真下へ隠れると非可視（minY=header+frozenHeight）', () => {
    // 固定行のすぐ下（body 先頭）の行が、少しスクロールしただけで固定バンド下へ潜る境界。
    const t = transformAt(ROW_H * 4, 0); // body 先頭付近を 4 行分スクロール
    // body 先頭 index=1 はスクロールで frozen バンド下へ隠れているはず。
    expect(computeEditorPlacement(t, 1, 3, CFG).visible).toBe(false);
  });
});

describe('DD-036 C1: 固定列数が n>1 でも pane 区別（可視判定）が固定バンド境界で正しい', () => {
  const FROZEN_COLS = 3;
  const FROZEN_ROWS = 2;
  const cfg: PlacementConfig = {
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    frozenRowCount: FROZEN_ROWS,
    frozenColCount: FROZEN_COLS,
  };
  const transform = createViewportTransform({
    rowAxis: createAxis({ ids: rowIds(1000), defaultSize: ROW_H }),
    colAxis: createAxis({ ids: colIds(50), defaultSize: COL_W }),
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    frozenRowCount: FROZEN_ROWS,
    frozenColCount: FROZEN_COLS,
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    scrollLeft: 10 * COL_W,
    scrollTop: 10 * ROW_H,
    overscanX: COL_W,
    overscanY: VIEW_H,
  });

  it('固定列のセルは横スクロール後も可視（header 直後に留まる）', () => {
    const p = computeEditorPlacement(transform, 0, FROZEN_COLS - 1, cfg);
    expect(p.visible).toBe(true);
    expect(p.rect.x).toBe(HEADER_W + (FROZEN_COLS - 1) * COL_W);
  });

  it('固定バンドの下へ流れたスクロール列のセルは非可視（固定/本体境界で隠れる）', () => {
    // 列 index 11 は scrollLeft=10 列ぶん → x = HEADER_W + 80。固定バンド右端（HEADER_W + 240）より左＝隠れる。
    const hidden = computeEditorPlacement(transform, 12, 11, cfg);
    expect(hidden.visible).toBe(false);
    // 固定バンドの右隣に出る列（index 14）は可視。
    const shown = computeEditorPlacement(transform, 12, 14, cfg);
    expect(shown.visible).toBe(true);
  });
});

describe('computeWrapEditorHeight（DD-055 RC17: wrap 列の編集欄の高さ）', () => {
  const ONE_LINE = 20; // 1 行分（行の高さ 16px＋上下の枠 4px）
  const roomy = { cellTop: 100, visibleBottom: 700, minHeight: ONE_LINE };

  it('1 行の高さのセルは内容に合わせて下へ伸びる（DD-052-1 の従来値）', () => {
    expect(computeWrapEditorHeight({ ...roomy, cellHeight: 22, contentHeight: 64 })).toEqual({ height: 64, scroll: false });
  });

  it('内容がセルより低ければセルの高さのまま', () => {
    expect(computeWrapEditorHeight({ ...roomy, cellHeight: 22, contentHeight: 16 })).toEqual({ height: 22, scroll: false });
  });

  it('1 行の高さのセルは 128px（8 行相当）で止まり内部スクロールになる（DD-052-1 AC4 の従来値）', () => {
    expect(MAX_WRAP_EDITOR_HEIGHT).toBe(128);
    expect(computeWrapEditorHeight({ ...roomy, cellHeight: 22, contentHeight: 300 })).toEqual({
      height: 128,
      scroll: true,
    });
  });

  it('128px より高いセルはセルの高さで覆う（上限に切り詰めない）', () => {
    expect(computeWrapEditorHeight({ ...roomy, cellHeight: 250, contentHeight: 240 })).toEqual({
      height: 250,
      scroll: false,
    });
  });

  it('高いセルで内容がセルより長ければ、セルの高さのまま内部スクロールになる', () => {
    expect(computeWrapEditorHeight({ ...roomy, cellHeight: 250, contentHeight: 400 })).toEqual({
      height: 250,
      scroll: true,
    });
  });

  it('伸びた編集欄が可視域の下端を越えるなら、下端までに縮めて内部スクロールにする', () => {
    expect(
      computeWrapEditorHeight({ cellTop: 650, visibleBottom: 700, minHeight: ONE_LINE, cellHeight: 22, contentHeight: 96 }),
    ).toEqual({ height: 50, scroll: true });
  });

  it('高いセルが可視域の下端にかかっても、下端までに縮める', () => {
    expect(
      computeWrapEditorHeight({ cellTop: 500, visibleBottom: 700, minHeight: ONE_LINE, cellHeight: 250, contentHeight: 240 }),
    ).toEqual({ height: 200, scroll: true });
  });

  it('可視域の下端で縮めても 1 行分の高さは下回らない', () => {
    expect(
      computeWrapEditorHeight({ cellTop: 690, visibleBottom: 700, minHeight: ONE_LINE, cellHeight: 22, contentHeight: 96 }),
    ).toEqual({ height: ONE_LINE, scroll: true });
  });

  it('もともと 1 行分より低い編集欄は、下端で縮める場面でもその高さのまま（1 行分まで伸ばさない）', () => {
    expect(
      computeWrapEditorHeight({ cellTop: 695, visibleBottom: 700, minHeight: ONE_LINE, cellHeight: 14, contentHeight: 12 }),
    ).toEqual({ height: 14, scroll: false });
  });
});

