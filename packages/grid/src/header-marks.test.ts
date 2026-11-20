// DD-070-6: 見出しの印の置き場（丸ごと置き換え・不正な項目は捨てて warn・未知の列の検査）。
import { describe, expect, it } from 'vitest';

import { createDiagnosticSink } from './diagnostics';
import type { GridDiagnostic } from './diagnostics';
import { createHeaderMarkStore } from './header-marks';

function setup(known?: readonly string[]) {
  const diagnostics: GridDiagnostic[] = [];
  const store = createHeaderMarkStore(createDiagnosticSink((d) => diagnostics.push(d)), () => (known === undefined ? undefined : new Set(known)));
  return { store, codes: () => diagnostics.map((d) => d.code) };
}

describe('DD-070-6 header-marks', () => {
  it('列の印を丸ごと置き換え、{} で全部消す。sort も filter も無い印は印なし', () => {
    const { store, codes } = setup(['a', 'b']);
    store.setColumnMarks({ a: { sort: 'asc' }, b: { filter: 'active', sort: 'desc' } }, 'test');
    expect(store.columnMark('a')).toEqual({ sort: 'asc' });
    expect(store.columnMark('b')).toEqual({ sort: 'desc', filter: 'active' });
    store.setColumnMarks({ b: {} }, 'test');
    expect(store.columnMark('a')).toBeUndefined();
    expect(store.columnMark('b')).toBeUndefined();
    expect(codes()).toEqual([]);
  });

  it('不正な値・未知の列はその項目だけ捨てて warn（ほかの項目は使う）。列の並びが分からない間は未知の検査をしない', () => {
    const { store, codes } = setup(['a']);
    store.setColumnMarks({ a: { sort: 'up' }, zz: { sort: 'asc' } }, 'test');
    expect(store.columnMark('a')).toBeUndefined();
    expect(store.columnMark('zz')).toBeUndefined();
    expect(codes()).toEqual(['column-header-mark-invalid', 'column-header-mark-invalid']);
    store.setColumnMarks('x' as never, 'test');
    expect(codes()).toHaveLength(3);
    const early = setup(undefined);
    early.store.setColumnMarks({ zz: { filter: 'available' } }, 'test');
    expect(early.store.columnMark('zz')).toEqual({ filter: 'available' });
  });

  it('まとまりの印は { collapsed: boolean } だけを受け、置き換えのたびに版が増える', () => {
    const { store, codes } = setup();
    const before = store.revision();
    store.setGroupMarks({ Supplier: { collapsed: true }, SDS: { collapsed: 'yes' } }, 'test');
    expect(store.groupMark('Supplier')).toEqual({ collapsed: true });
    expect(store.groupMark('SDS')).toBeUndefined();
    expect(codes()).toEqual(['column-header-mark-invalid']);
    expect(store.revision()).toBeGreaterThan(before);
  });
});
