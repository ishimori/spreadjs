// DD-064 unit: 選択コントローラの結合対応（範囲の拡張・Shift＋矢印の焦点・1 つの結合は単一選択）。

import { describe, expect, it } from 'vitest';

import { createMergeIndex, EMPTY_MERGE_INDEX, type CellRange, type MergeIndex } from '@nanairo-sheet/selection';

import { createSelectionController } from './selection-controller';

const range = (rowStart: number, rowEnd: number, colStart: number, colEnd: number): CellRange => ({
  rowStart,
  rowEnd,
  colStart,
  colEnd,
});
const BOUNDS = { rowCount: 9, colCount: 5 };

// 明細ごとの 3 行で、列 0 を縦に結合（行 0〜2・3〜5）。
const MERGES = createMergeIndex([range(0, 3, 0, 1), range(3, 6, 0, 1)]);

function controller(index: MergeIndex = MERGES) {
  return createSelectionController({ merges: () => index });
}

describe('DD-064: 選択コントローラ', () => {
  it('Shift＋↓ を結合の左上から押すと、結合の下端の次の行まで広がり、次の結合にかかれば全体を含む', () => {
    const ctrl = controller();
    ctrl.extendByArrow({ row: 0, col: 0 }, 'down', BOUNDS);
    expect(ctrl.getRange()).toEqual(range(0, 6, 0, 1)); // 行 3 は次の結合（3〜5）の左上 → 全体を含む
    ctrl.extendByArrow({ row: 0, col: 0 }, 'down', BOUNDS);
    expect(ctrl.getRange()).toEqual(range(0, 7, 0, 1)); // 焦点（行 3）の結合の端から 1 つ外＝行 6
  });

  it('Shift＋↑ で縮めて 1 つの結合そのものになったら単一選択として扱い、続く Shift＋↓ はそこから動く', () => {
    const ctrl = controller();
    ctrl.extendByArrow({ row: 0, col: 0 }, 'down', BOUNDS); // 焦点 行 3 → 範囲 0〜6
    ctrl.extendByArrow({ row: 0, col: 0 }, 'up', BOUNDS); // 焦点（行 3 の結合）の上端の手前＝行 2 → 範囲 0〜3＝結合そのもの
    expect(ctrl.getRange()).toBeNull();
    ctrl.extendByArrow({ row: 0, col: 0 }, 'down', BOUNDS);
    expect(ctrl.getRange()).toEqual(range(0, 6, 0, 1));
  });

  it('Shift＋クリック・ドラッグの範囲も結合を含むまで広げる（同じ結合の中なら単一選択）', () => {
    const ctrl = controller();
    ctrl.extendTo({ row: 1, col: 1 }, { row: 4, col: 0 });
    expect(ctrl.getRange()).toEqual(range(0, 6, 0, 2));
    ctrl.extendTo({ row: 0, col: 0 }, { row: 2, col: 0 });
    expect(ctrl.getRange()).toBeNull();
    ctrl.beginDrag({ row: 7, col: 1 });
    ctrl.updateDrag({ row: 5, col: 0 });
    expect(ctrl.getDragRange()).toEqual(range(3, 8, 0, 2));
    expect(ctrl.endDrag()).toEqual(range(3, 8, 0, 2));
  });

  it('単一選択が結合の左上なら、selectedRange は結合範囲全体（copy・paste の対象）', () => {
    const ctrl = controller();
    expect(ctrl.selectedRange({ row: 3, col: 0 })).toEqual(range(3, 6, 0, 1));
    expect(ctrl.selectedRange({ row: 3, col: 1 })).toEqual(range(3, 4, 1, 2));
  });

  it('結合が無ければ従来どおり（1 セルずつ動き、端でクランプ）', () => {
    const ctrl = controller(EMPTY_MERGE_INDEX);
    ctrl.extendByArrow({ row: 0, col: 0 }, 'down', BOUNDS);
    expect(ctrl.getRange()).toEqual(range(0, 2, 0, 1));
    const plain = createSelectionController();
    expect(plain.extendByArrow({ row: 8, col: 4 }, 'down', BOUNDS)).toEqual({ row: 8, col: 4 });
    expect(plain.getRange()).toBeNull();
  });
});
