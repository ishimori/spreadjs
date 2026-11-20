import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId } from '@nanairo-sheet/types';
import type { ColumnId, RowId } from '@nanairo-sheet/types';

import {
  cloneDocument,
  createDocument,
  displayRowOrder,
  getCell,
  isTombstoned,
  resolveAnchorIndex,
  setCell,
  writableRowOrder,
} from './document';
import type { RowMeta, SheetDocument } from './document';
import { createCellStore } from './cell-store';
import type { CellScalar } from './operations';

const col = (value: string): ColumnId => createColumnId(value);
const row = (value: string): RowId => createRowId(value);
const str = (value: string): CellScalar => ({ kind: 'string', value });

// tombstone 行を含む非自明な文書を Map から手で組む（apply に依存せず document.ts 単体を検証する）。
function buildDoc(): SheetDocument {
  const r1 = row('row-1');
  const r2 = row('row-2');
  const ca = col('col-a');
  const cb = col('col-b');
  const rowMeta = new Map<RowId, RowMeta>([
    [r1, { id: r1, slot: 0, tombstone: false, lastChangedRevision: 1 }],
    [r2, { id: r2, slot: 1, tombstone: true, lastChangedRevision: 2 }],
  ]);
  const doc: SheetDocument = {
    revision: 2,
    rowOrder: [r1, r2],
    rowMeta,
    columnOrder: [ca, cb],
    cells: createCellStore(),
    maxSlot: 1, // 既存 slot の最大（r2=1）
  };
  setCell(doc, r1, ca, { value: str('x'), lastChangedRevision: 1 });
  return doc;
}

describe('document.ts — 最小文書モデル（phase1-design §2）', () => {
  it('createDocument は空文書を返す（revision=0・行なし・列固定）', () => {
    const doc = createDocument([col('col-a'), col('col-b')]);
    expect(doc.revision).toBe(0);
    expect(doc.rowOrder).toEqual([]);
    expect(doc.rowMeta.size).toBe(0);
    expect(doc.cells.nonEmptyCount()).toBe(0);
    expect(doc.columnOrder).toEqual([col('col-a'), col('col-b')]);
  });

  it('createDocument は渡した列配列をコピーする（外部配列の後続変更に影響されない）', () => {
    const cols = [col('col-a')];
    const doc = createDocument(cols);
    cols.push(col('col-b'));
    expect(doc.columnOrder).toEqual([col('col-a')]);
  });

  it('getCell は存在するセルを返し、無ければ undefined', () => {
    const doc = buildDoc();
    expect(getCell(doc, row('row-1'), col('col-a'))?.value).toEqual(str('x'));
    expect(getCell(doc, row('row-1'), col('col-b'))).toBeUndefined();
    expect(getCell(doc, row('row-unknown'), col('col-a'))).toBeUndefined();
  });

  it('displayRowOrder は tombstone 行を除外する', () => {
    const doc = buildDoc();
    expect(doc.rowOrder).toEqual([row('row-1'), row('row-2')]);
    expect(displayRowOrder(doc)).toEqual([row('row-1')]);
  });

  it('resolveAnchorIndex: null=先頭(-1)・既知行=index（tombstone 行も参照点として有効）・未知=undefined', () => {
    const doc = buildDoc();
    expect(resolveAnchorIndex(doc, null)).toBe(-1);
    expect(resolveAnchorIndex(doc, row('row-1'))).toBe(0);
    expect(resolveAnchorIndex(doc, row('row-2'))).toBe(1); // tombstone でも順序参照点（S-D2）
    expect(resolveAnchorIndex(doc, row('row-unknown'))).toBeUndefined();
  });

  it('isTombstoned: tombstone 行=true・生存行=false・未知行=false', () => {
    const doc = buildDoc();
    expect(isTombstoned(doc, row('row-1'))).toBe(false);
    expect(isTombstoned(doc, row('row-2'))).toBe(true);
    expect(isTombstoned(doc, row('row-unknown'))).toBe(false);
  });

  it('cloneDocument は完全な深いコピー（clone のどこを変更しても原本は不変）— DA: 部分ミューテーション経路の遮断', () => {
    const orig = buildDoc();
    const clone = cloneDocument(orig);

    // トップレベルとネストの参照がすべて別であること
    expect(clone).not.toBe(orig);
    expect(clone.rowOrder).not.toBe(orig.rowOrder);
    expect(clone.rowMeta).not.toBe(orig.rowMeta);
    expect(clone.columnOrder).not.toBe(orig.columnOrder);
    expect(clone.cells).not.toBe(orig.cells);
    expect(clone.rowMeta.get(row('row-1'))).not.toBe(orig.rowMeta.get(row('row-1')));
    const origRec = getCell(orig, row('row-1'), col('col-a'))!;
    const cloneRec = getCell(clone, row('row-1'), col('col-a'))!;
    expect(cloneRec).not.toBe(origRec); // CellRecord も別参照（store.clone が深く複製）
    expect(cloneRec.value).not.toBe(origRec.value); // CellScalar も別参照

    // clone を隅々まで破壊的に変更する（型は読み取り専用〔DD-070-10〕だが、深い複製はその場の書き換えからも原本を守る）
    clone.revision = 999;
    writableRowOrder(clone).push(row('row-99'));
    clone.columnOrder.push(col('col-z'));
    Object.assign(clone.rowMeta.get(row('row-1'))!, { tombstone: true, lastChangedRevision: 999, slot: 999 });
    Object.assign(cloneRec, { lastChangedRevision: 999, value: str('MUTATED') });
    setCell(clone, row('row-1'), col('col-b'), { value: str('new'), lastChangedRevision: 999 });
    // row-2（tombstone・セルなし）へセルを追加してみる（原本 row-2 は空のまま）
    setCell(clone, row('row-2'), col('col-a'), { value: str('z2'), lastChangedRevision: 999 });

    // 原本は完全に不変
    expect(orig.revision).toBe(2);
    expect(orig.rowOrder).toEqual([row('row-1'), row('row-2')]);
    expect(orig.columnOrder).toEqual([col('col-a'), col('col-b')]);
    expect(orig.rowMeta.get(row('row-1'))).toEqual({
      id: row('row-1'),
      slot: 0,
      tombstone: false,
      lastChangedRevision: 1,
    });
    expect(origRec).toEqual({ value: str('x'), lastChangedRevision: 1 });
    expect(getCell(orig, row('row-1'), col('col-b'))).toBeUndefined();
    expect(getCell(orig, row('row-2'), col('col-a'))).toBeUndefined();
    // clone 側は変更が反映されている（隔離の対称確認）
    expect(getCell(clone, row('row-1'), col('col-b'))).toEqual({ value: str('new'), lastChangedRevision: 999 });
    expect(getCell(clone, row('row-2'), col('col-a'))).toEqual({ value: str('z2'), lastChangedRevision: 999 });
  });
});
