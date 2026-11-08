// DD-066: 結合の Navigation 枠は範囲全体で配置・可視判定し、所属する pane 内でだけ描く。
import { describe, expect, it } from 'vitest';
import { createAxis, createViewportTransform } from '@nanairo-sheet/render';
import { createColumnId, createRowId } from '@nanairo-sheet/types';

import { computeEditorPlacement, computeMergedEditorPlacement } from './editor-placement';

function setup(scrollTop = 0, scrollLeft = 0, frozenRows = 1, frozenCols = 1) {
  const cfg = { headerWidth: 52, headerHeight: 24, viewportWidth: 400, viewportHeight: 300, frozenRowCount: frozenRows, frozenColCount: frozenCols };
  const transform = createViewportTransform({
    rowAxis: createAxis({ ids: Array.from({ length: 30 }, (_, i) => createRowId(`r${i}`)), defaultSize: 22 }),
    colAxis: createAxis({ ids: Array.from({ length: 20 }, (_, i) => createColumnId(`c${i}`)), defaultSize: 80 }),
    ...cfg, scrollTop, scrollLeft, overscanX: 80, overscanY: 300,
  });
  return { cfg, transform };
}

const BODY = { rowStart: 2, rowEnd: 5, colStart: 2, colEnd: 4 };

describe('computeMergedEditorPlacement', () => {
  it('3行×2列を1つの矩形に置き、通常セルの計算は変えない', () => {
    const { transform, cfg } = setup();
    const p = computeMergedEditorPlacement(transform, BODY, cfg);
    expect(p).toEqual({ visible: true, rect: { x: 212, y: 68, width: 160, height: 66 }, clip: { x: 212, y: 68, width: 160, height: 66 } });
    expect(computeEditorPlacement(transform, 2, 2, cfg)).toEqual({ visible: true, rect: { x: 212, y: 68, width: 80, height: 22 } });
  });

  it('上と左が固定帯へ隠れても、実矩形はずらさず所属 pane の内側だけを返す', () => {
    const { transform, cfg } = setup(55, 100);
    expect(computeMergedEditorPlacement(transform, BODY, cfg)).toEqual({
      visible: true, rect: { x: 112, y: 13, width: 160, height: 66 }, clip: { x: 132, y: 46, width: 140, height: 33 },
    });
  });

  it('左上のセルが全部隠れていても、範囲の残りが見えれば可視', () => {
    const { transform, cfg } = setup(50);
    expect(computeEditorPlacement(transform, 2, 2, cfg).visible).toBe(false);
    const p = computeMergedEditorPlacement(transform, BODY, cfg);
    expect(p.visible).toBe(true);
    expect(p.rect).toEqual({ x: 212, y: 18, width: 160, height: 66 });
    expect(p.clip).toEqual({ x: 212, y: 46, width: 160, height: 38 });
  });

  it('範囲全体が固定帯の裏へ隠れたら非可視', () => {
    const { transform, cfg } = setup(100);
    const p = computeMergedEditorPlacement(transform, BODY, cfg);
    expect(p.visible).toBe(false);
    expect(p.clip.height).toBe(0);
  });

  it('右と下も viewport の内側に収め、元の幅と高さを保つ', () => {
    const { transform, cfg } = setup();
    const p = computeMergedEditorPlacement(transform, { rowStart: 10, rowEnd: 13, colStart: 3, colEnd: 5 }, cfg);
    expect(p.rect).toEqual({ x: 292, y: 244, width: 160, height: 66 });
    expect(p.clip).toEqual({ x: 292, y: 244, width: 108, height: 56 });
  });

  it('固定行×固定列の結合は縦横に動かしても原点が動かない', () => {
    const { transform, cfg } = setup(500, 500, 2, 2);
    const p = computeMergedEditorPlacement(transform, { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 }, cfg);
    expect(p).toEqual({ visible: true, rect: { x: 52, y: 24, width: 160, height: 44 }, clip: { x: 52, y: 24, width: 160, height: 44 } });
  });

  it('上の pane は横だけ、左の pane は縦だけ clip する', () => {
    const { transform, cfg } = setup(55, 100, 2, 2);
    const top = computeMergedEditorPlacement(transform, { rowStart: 0, rowEnd: 2, colStart: 2, colEnd: 4 }, cfg);
    expect(top.clip).toEqual({ x: 212, y: 24, width: 60, height: 44 });
    const left = computeMergedEditorPlacement(transform, { rowStart: 2, rowEnd: 5, colStart: 0, colEnd: 2 }, cfg);
    expect(left.clip).toEqual({ x: 52, y: 68, width: 160, height: 11 });
  });

  it('固定帯が viewport より大きくても、枠を viewport の外へ出さない', () => {
    const { transform, cfg } = setup(0, 0, 2, 6);
    const p = computeMergedEditorPlacement(transform, { rowStart: 0, rowEnd: 2, colStart: 3, colEnd: 6 }, cfg);
    expect(p.rect.width).toBe(240);
    expect(p.clip).toEqual({ x: 292, y: 24, width: 108, height: 44 });
  });
});
