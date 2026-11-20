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

describe('DD-070-6 header-marks（Codex の指摘）', () => {
  it('P2: 列の並びが分かる前に受けた指定は、recheck で未知の列・まとまりを捨てて warn する（分かった後の指定はその場で検査）', () => {
    const diagnostics: GridDiagnostic[] = [];
    const known: { columns?: ReadonlySet<string>; groups?: ReadonlySet<string> } = {};
    const store = createHeaderMarkStore(createDiagnosticSink((d) => diagnostics.push(d)), () => known.columns, () => known.groups);
    store.setColumnMarks({ a: { sort: 'asc' }, typo: { sort: 'desc' } }, 'columnHeaderMarks');
    store.setGroupMarks({ sup: { collapsed: true }, typo: { collapsed: false } }, 'columnGroupMarks');
    expect(store.columnMark('typo')).toEqual({ sort: 'desc' }); // まだ分からないので保つ
    known.columns = new Set(['a']);
    known.groups = new Set(['sup']);
    store.recheck();
    expect(store.columnMark('a')).toEqual({ sort: 'asc' });
    expect(store.columnMark('typo')).toBeUndefined();
    expect(store.groupMark('sup')).toEqual({ collapsed: true });
    expect(store.groupMark('typo')).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toEqual(['column-header-mark-invalid', 'column-header-mark-invalid']);
    store.recheck(); // 二度目は何もしない
    expect(diagnostics).toHaveLength(2);
    store.setGroupMarks({ other: { collapsed: true } }, 'setColumnGroupMarks');
    expect(store.groupMark('other')).toBeUndefined();
    expect(diagnostics).toHaveLength(3);
  });
});
