import { describe, expect, it } from 'vitest';

import { applyOperation, createDocument } from '@nanairo-sheet/core';
import type { DocumentOperation, SheetDocument } from '@nanairo-sheet/core';
import { col, insertRows, num, row, setCells, str } from '@nanairo-sheet/collab/test-support';
import { createTextMetricsCache } from '@nanairo-sheet/render';

import {
  DocumentView,
  cellScalarToDisplay,
  operationDirtyKind,
} from './document-view';

const COLS = [col('col-0'), col('col-1'), col('col-2')];

/** ClientSession の committed を模した文書ホルダー（Operation を順に適用して view を進める）。 */
function createDocHolder(): {
  view: DocumentView;
  apply: (op: DocumentOperation) => void;
  doc: () => SheetDocument;
} {
  let doc = createDocument(COLS);
  let revision = 0;
  const apply = (op: DocumentOperation): void => {
    revision += 1;
    doc = applyOperation(doc, op, { revision }).document;
  };
  const view = new DocumentView({ getDocument: () => doc, rowHeight: 20, colWidth: 60 });
  return { view, apply, doc: () => doc };
}

/** queryRange の結果を (row,col,value) 配列で収集する。 */
function collect(view: DocumentView, r0: number, r1: number, c0: number, c1: number): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  view.store.queryRange(r0, r1, c0, c1, (r, c, v) => {
    out.push([r, c, v]);
  });
  return out;
}

describe('cellScalarToDisplay / operationDirtyKind（純粋関数）', () => {
  it('CellScalar を描画文字列へ', () => {
    expect(cellScalarToDisplay({ kind: 'blank' })).toBe('');
    expect(cellScalarToDisplay(str('あ'))).toBe('あ');
    expect(cellScalarToDisplay(num(42.5))).toBe('42.5');
  });

  it('Operation を dirty 種別へ分類', () => {
    expect(operationDirtyKind(setCells([]))).toBe('cell');
    expect(operationDirtyKind(insertRows(null, ['r0']))).toBe('row-structure');
    expect(operationDirtyKind({ type: 'deleteRows', rowIds: [row('r0')] })).toBe('row-structure');
  });
});

describe('DocumentView（ClientSession 文書の読み取りアダプター・#2）', () => {
  it('初期構築で colAxis=列順・rowAxis=displayRowOrder', () => {
    const { view, apply } = createDocHolder();
    expect(view.colAxis.count()).toBe(3);
    expect(view.rowAxis.count()).toBe(0);
    apply(insertRows(null, ['r0', 'r1', 'r2']));
    view.markStructureDirty();
    view.flush();
    expect(view.rowAxis.count()).toBe(3);
    expect(view.rowIndexOf(row('r0'))).toBe(0);
    expect(view.rowIndexOf(row('r2'))).toBe(2);
  });

  it('queryRange は ClientSession 文書の可視セルを読む（blank は描画しない）', () => {
    const { view, apply } = createDocHolder();
    apply(insertRows(null, ['r0', 'r1']));
    apply(setCells([{ rowId: row('r1'), columnId: col('col-1'), value: str('hello') }]));
    view.markStructureDirty();
    view.markCellDirty();
    view.flush();
    expect(collect(view, 0, 2, 0, 3)).toEqual([[1, 1, 'hello']]);
  });

  it('store への書き込みは禁止（第二 CellStore を作らない・#2）', () => {
    const { view } = createDocHolder();
    expect(() => view.store.set(0, 0, 'x')).toThrow(/読み取り専用/);
    expect(() => view.store.bulkLoad([])).toThrow(/読み取り専用/);
  });

  it('SetCells は rowAxis を再構築しない（#5 全再構築の否定・同一 Axis 参照）', () => {
    const { view, apply } = createDocHolder();
    apply(insertRows(null, ['r0', 'r1', 'r2']));
    view.markStructureDirty();
    view.flush();
    const axisAfterBuild = view.rowAxis;
    const rebuildsAfterBuild = view.structuralRebuildCount;

    // セル更新 → cell dirty のみ。
    apply(setCells([{ rowId: row('r1'), columnId: col('col-0'), value: num(7) }]));
    view.noteOperation(setCells([{ rowId: row('r1'), columnId: col('col-0'), value: num(7) }]));
    const result = view.flush();

    expect(result.dirty.cell).toBe(true);
    expect(result.dirty['row-structure']).toBe(false);
    expect(result.structuralRebuilt).toBe(false);
    expect(view.structuralRebuildCount).toBe(rebuildsAfterBuild); // Axis 再構築回数が増えない
    expect(view.rowAxis).toBe(axisAfterBuild); // 同一 Axis 参照のまま
    expect(collect(view, 1, 2, 0, 1)).toEqual([[1, 0, '7']]); // 新しい値が読める
  });

  it('InsertRows（編集行の上）で RowId 追従（AC4 前提・#4）', () => {
    const { view, apply } = createDocHolder();
    apply(insertRows(null, ['r0', 'r1', 'r2']));
    apply(setCells([{ rowId: row('r2'), columnId: col('col-0'), value: str('X') }]));
    view.markFullRebuild();
    view.flush();
    expect(view.rowIndexOf(row('r2'))).toBe(2);
    expect(collect(view, 2, 3, 0, 1)).toEqual([[2, 0, 'X']]);

    const axisBefore = view.rowAxis;
    const rebuildsBefore = view.structuralRebuildCount;
    // 先頭へ 1 行挿入 → r2 は index 3 へずれるが RowId は不変。
    apply(insertRows(null, ['rNew']));
    view.noteOperation(insertRows(null, ['rNew']));
    const result = view.flush();

    expect(result.structuralRebuilt).toBe(true);
    expect(view.structuralRebuildCount).toBe(rebuildsBefore + 1);
    expect(view.rowAxis).not.toBe(axisBefore); // 構造Op では Axis を作り直す
    expect(view.rowIndexOf(row('r2'))).toBe(3); // 同一 RowId が新 index へ解決
    expect(collect(view, 3, 4, 0, 1)).toEqual([[3, 0, 'X']]); // 値も追従
  });

  it('DeleteRows で編集行の消失を検知（#4・削除判定は tombstone/displayRowOrder 消失）', () => {
    const { view, apply } = createDocHolder();
    apply(insertRows(null, ['r0', 'r1', 'r2']));
    view.markStructureDirty();
    view.flush();
    expect(view.hasRow(row('r1'))).toBe(true);

    apply({ type: 'deleteRows', rowIds: [row('r1')] });
    view.markStructureDirty();
    view.flush();
    expect(view.hasRow(row('r1'))).toBe(false); // tombstone 化＝index 範囲でなく存在で判定
    expect(view.rowIndexOf(row('r1'))).toBe(-1);
    expect(view.rowIndexOf(row('r2'))).toBe(1); // 詰められた表示位置
  });

  it('viewport dirty は再描画するが Axis 不変', () => {
    const { view, apply } = createDocHolder();
    apply(insertRows(null, ['r0']));
    view.markFullRebuild();
    view.flush();
    const axis = view.rowAxis;
    view.markViewportDirty();
    const result = view.flush();
    expect(result.needsRedraw).toBe(true);
    expect(result.dirty.viewport).toBe(true);
    expect(result.structuralRebuilt).toBe(false);
    expect(view.rowAxis).toBe(axis);
  });

  it('dirty が無ければ needsRedraw=false（アイドルフレームは描画しない）', () => {
    const { view } = createDocHolder();
    expect(view.flush().needsRedraw).toBe(false);
  });
});

describe('DocumentView 列幅・行高 override（DD-012-4）', () => {
  it('初期 columnWidths/rowHeights が Axis のサイズへ反映される（保存済み設定の復元＝AC4）', () => {
    let doc = createDocument(COLS);
    doc = applyOperation(doc, insertRows(null, ['r0', 'r1']), { revision: 1 }).document;
    const view = new DocumentView({
      getDocument: () => doc,
      rowHeight: 20,
      colWidth: 60,
      columnWidths: { 'col-1': 140 },
      rowHeights: { r1: 40 },
    });
    view.markStructureDirty();
    view.flush();
    expect(view.colAxis.size(view.colIndexOf(col('col-1')))).toBe(140);
    expect(view.colAxis.size(view.colIndexOf(col('col-0')))).toBe(60); // 既定
    expect(view.rowAxis.size(view.rowIndexOf(row('r1')))).toBe(40);
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(20); // 既定
  });

  it('setColumnWidth/setRowHeight が Axis へ即時反映し viewport dirty を立てる', () => {
    const { view, apply } = createDocHolder();
    apply(insertRows(null, ['r0', 'r1']));
    view.markFullRebuild();
    view.flush();
    view.setColumnWidth(col('col-2'), 150);
    view.setRowHeight(row('r0'), 33);
    expect(view.colAxis.size(view.colIndexOf(col('col-2')))).toBe(150);
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(33);
    const result = view.flush();
    expect(result.dirty.viewport).toBe(true);
  });

  it('override は構造Op の Axis 再構築後も維持される（DD-012-4 の最重要不変・AC4）', () => {
    const { view, apply } = createDocHolder();
    apply(insertRows(null, ['r0', 'r1', 'r2']));
    view.markFullRebuild();
    view.flush();
    view.setRowHeight(row('r2'), 44);
    view.setColumnWidth(col('col-0'), 111);

    // 先頭に 1 行挿入 → rowAxis を作り直す（構造Op）。
    apply(insertRows(null, ['rNew']));
    view.noteOperation(insertRows(null, ['rNew']));
    const result = view.flush();
    expect(result.structuralRebuilt).toBe(true);

    // r2 は index がずれるが RowId 単位の override は失われない。
    expect(view.rowAxis.size(view.rowIndexOf(row('r2')))).toBe(44);
    // 列 override も維持。
    expect(view.colAxis.size(view.colIndexOf(col('col-0')))).toBe(111);
  });

  it('初期 override は有限数へ絞りクランプされ、既定値は保持しない（Codex[P2]）', () => {
    let doc = createDocument(COLS);
    doc = applyOperation(doc, insertRows(null, ['r0']), { revision: 1 }).document;
    const view = new DocumentView({
      getDocument: () => doc,
      rowHeight: 20,
      colWidth: 60,
      // -5→20 クランプ / 99999→2000 クランプ / 60=既定→除外 / NaN→無視
      columnWidths: { 'col-0': -5, 'col-1': 99999, 'col-2': 60, bogus: Number.NaN },
    });
    expect(view.columnWidthOverrideRecord()).toEqual({ 'col-0': 20, 'col-1': 2000 });
    view.markStructureDirty();
    view.flush();
    expect(view.colAxis.size(view.colIndexOf(col('col-0')))).toBe(20);
    expect(view.colAxis.size(view.colIndexOf(col('col-1')))).toBe(2000);
    expect(view.colAxis.size(view.colIndexOf(col('col-2')))).toBe(60); // 既定
  });

  it('既定値へ戻すと override が解除される（layout の override-only を維持・Codex[P2]）', () => {
    const { view, apply } = createDocHolder();
    apply(insertRows(null, ['r0']));
    view.markFullRebuild();
    view.flush();
    view.setColumnWidth(col('col-1'), 150);
    view.setRowHeight(row('r0'), 40);
    expect(view.columnWidthOverrideRecord()).toEqual({ 'col-1': 150 });
    // 既定サイズ（colWidth=60 / rowHeight=20）へ戻す → override 消滅。
    view.setColumnWidth(col('col-1'), 60);
    view.setRowHeight(row('r0'), 20);
    expect(view.columnWidthOverrideRecord()).toEqual({});
    expect(view.rowHeightOverrideRecord()).toEqual({});
    expect(view.colAxis.size(view.colIndexOf(col('col-1')))).toBe(60);
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(20);
  });

  it('override レコードは既定値の列/行を含まない（layout イベントは override のみ＝AC3）', () => {
    const { view, apply } = createDocHolder();
    apply(insertRows(null, ['r0', 'r1']));
    view.markFullRebuild();
    view.flush();
    expect(view.columnWidthOverrideRecord()).toEqual({});
    expect(view.rowHeightOverrideRecord()).toEqual({});
    view.setColumnWidth(col('col-1'), 90);
    view.setRowHeight(row('r0'), 30);
    expect(view.columnWidthOverrideRecord()).toEqual({ 'col-1': 90 });
    expect(view.rowHeightOverrideRecord()).toEqual({ r0: 30 });
  });
});

describe('DocumentView 自動行高（DD-012-5 D5）', () => {
  // 各文字幅 10px の決定論測定。colWidth=60 → wrap 内寸 60-10=50 → 1 行 5 文字。
  const LINE_HEIGHT = 16;
  // 期待行高 58 = 3 行 × LINE_HEIGHT(16) + padding(5)×2（CELL_TEXT_PADDING）。
  const DEFAULT_ROW = 22;
  const DEFAULT_COL = 60;

  function createWrapHolder(): { view: DocumentView; apply: (op: DocumentOperation) => void } {
    let doc = createDocument(COLS);
    let revision = 0;
    const apply = (op: DocumentOperation): void => {
      revision += 1;
      doc = applyOperation(doc, op, { revision }).document;
    };
    const wrapCache = createTextMetricsCache((text) => text.length * 10);
    const view = new DocumentView({
      getDocument: () => doc,
      rowHeight: DEFAULT_ROW,
      colWidth: DEFAULT_COL,
      wrapColumns: ['col-1'],
      wrapCache,
      cellFont: 'f',
      lineHeight: LINE_HEIGHT,
    });
    return { view, apply };
  }

  it('wrap 列の非空セルが複数行になると行高が自動拡張される（AC4/AC5）', () => {
    const { view, apply } = createWrapHolder();
    apply(insertRows(null, ['r0', 'r1']));
    // 12 文字 → 5 文字/行 → 3 行 → 3*16+10=58px。
    apply(setCells([{ rowId: row('r0'), columnId: col('col-1'), value: str('abcdefghijkl') }]));
    view.markFullRebuild();
    view.flush();
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(58);
    expect(view.rowAxis.size(view.rowIndexOf(row('r1')))).toBe(DEFAULT_ROW); // 空行は既定
    expect(view.autoRowHeightRecord()).toEqual({ r0: 58 });
  });

  it('非 wrap 列の長文は行高に影響しない（オーバーフローは描画のみ・D2）', () => {
    const { view, apply } = createWrapHolder();
    apply(insertRows(null, ['r0']));
    apply(setCells([{ rowId: row('r0'), columnId: col('col-0'), value: str('abcdefghijklmnop') }]));
    view.markFullRebuild();
    view.flush();
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(DEFAULT_ROW);
  });

  it('値の短縮・削除で自動行高が縮小する（AC5・トリガー②）', () => {
    const { view, apply } = createWrapHolder();
    apply(insertRows(null, ['r0']));
    apply(setCells([{ rowId: row('r0'), columnId: col('col-1'), value: str('abcdefghijkl') }]));
    view.markFullRebuild();
    view.flush();
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(58);

    // 3 文字へ短縮 → 1 行 → 自動高解除（既定へ縮小）。
    apply(setCells([{ rowId: row('r0'), columnId: col('col-1'), value: str('abc') }]));
    view.recomputeAutoRowHeightsForRows([row('r0')]);
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(DEFAULT_ROW);
    expect(view.autoRowHeightRecord()).toEqual({});
  });

  it('手動リサイズ済みの行は手動値を優先し自動高で上書きしない（AC5・D5 手動優先）', () => {
    const { view, apply } = createWrapHolder();
    apply(insertRows(null, ['r0']));
    view.markFullRebuild();
    view.flush();
    // 手動で 100px に固定。
    view.setRowHeight(row('r0'), 100);
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(100);
    // その後 wrap セルに長文 → 自動高は算出されるが Axis は手動 100 のまま。
    apply(setCells([{ rowId: row('r0'), columnId: col('col-1'), value: str('abcdefghijkl') }]));
    view.recomputeAutoRowHeightsForRows([row('r0')]);
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(100);
    // layout（手動 override）には自動高を含めない（D7）。
    expect(view.rowHeightOverrideRecord()).toEqual({ r0: 100 });
    expect(view.autoRowHeightRecord()).toEqual({ r0: 58 });

    // 手動を既定へ戻すと自動高が復帰する（D5・手動解除で自動 fit）。
    view.setRowHeight(row('r0'), DEFAULT_ROW);
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(58);
    expect(view.rowHeightOverrideRecord()).toEqual({});
  });

  it('自動高は layout の override レコードに含まれない（D7）', () => {
    const { view, apply } = createWrapHolder();
    apply(insertRows(null, ['r0']));
    apply(setCells([{ rowId: row('r0'), columnId: col('col-1'), value: str('abcdefghijkl') }]));
    view.markFullRebuild();
    view.flush();
    expect(view.rowHeightOverrideRecord()).toEqual({}); // 手動 override 無し
    expect(view.autoRowHeightRecord()).toEqual({ r0: 58 }); // 自動高は別レイヤ
  });

  it('構造Op（行挿入）後も自動行高が維持され、行 index がずれても RowId 単位で追従する（AC4/AC6）', () => {
    const { view, apply } = createWrapHolder();
    apply(insertRows(null, ['r0', 'r1']));
    apply(setCells([{ rowId: row('r1'), columnId: col('col-1'), value: str('abcdefghijkl') }]));
    view.markFullRebuild();
    view.flush();
    expect(view.rowAxis.size(view.rowIndexOf(row('r1')))).toBe(58);

    // 先頭に 1 行挿入 → r1 の index はずれるが自動高は維持。
    apply(insertRows(null, ['rNew']));
    view.noteOperation(insertRows(null, ['rNew']));
    view.flush();
    expect(view.rowAxis.size(view.rowIndexOf(row('r1')))).toBe(58);
  });

  it('数値セルは wrap 列でも折り返さない（単一行扱い・行高に影響しない）', () => {
    const { view, apply } = createWrapHolder();
    apply(insertRows(null, ['r0']));
    apply(setCells([{ rowId: row('r0'), columnId: col('col-1'), value: num(123456789012) }]));
    view.markFullRebuild();
    view.flush();
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(DEFAULT_ROW);
  });

  it('リサイズ取消は開始時の手動 override 状態へ戻し、自動高を手動化しない（Codex P2）', () => {
    const { view, apply } = createWrapHolder();
    apply(insertRows(null, ['r0']));
    apply(setCells([{ rowId: row('r0'), columnId: col('col-1'), value: str('abcdefghijkl') }]));
    view.markFullRebuild();
    view.flush();
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(58); // 自動高

    // 取消: 開始時は手動 override 無し（undefined）→ 実効 px でなく「手動なし」状態へ戻す。
    view.restoreRowHeight(row('r0'), undefined);
    expect(view.rowHeightOverrideRecord()).toEqual({}); // 自動高を手動化していない
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(58); // 自動高は維持

    // 値短縮 → 自動縮小が効く（手動化されていたら効かないはず）。
    apply(setCells([{ rowId: row('r0'), columnId: col('col-1'), value: str('abc') }]));
    view.recomputeAutoRowHeightsForRows([row('r0')]);
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(DEFAULT_ROW);
  });

  it('削除行の自動高は一括再計算で掃除される（stale を溜めない・Codex P2）', () => {
    const { view, apply } = createWrapHolder();
    apply(insertRows(null, ['r0', 'r1']));
    apply(setCells([{ rowId: row('r1'), columnId: col('col-1'), value: str('abcdefghijkl') }]));
    view.markFullRebuild();
    view.flush();
    expect(view.autoRowHeightRecord()).toEqual({ r1: 58 });

    // r1 を削除 → 構造再構築 → 一括再計算が軸から消えた r1 の自動高を prune。
    apply({ type: 'deleteRows', rowIds: [row('r1')] });
    view.markStructureDirty();
    view.flush();
    expect(view.autoRowHeightRecord()).toEqual({});
  });

  it('wrap 無効（wrapColumns 未指定）なら自動行高は動かない', () => {
    const { view, apply } = createDocHolder();
    apply(insertRows(null, ['r0']));
    apply(setCells([{ rowId: row('r0'), columnId: col('col-1'), value: str('abcdefghijkl') }]));
    view.markFullRebuild();
    view.flush();
    expect(view.autoRowHeightEnabled).toBe(false);
    expect(view.rowAxis.size(view.rowIndexOf(row('r0')))).toBe(20); // createDocHolder は rowHeight=20
  });
});
