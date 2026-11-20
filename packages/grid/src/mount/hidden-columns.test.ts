// DD-070-7: 見せる列の切り替えの部品（検査・結線前の保留・選択中のセルの寄せ）。grid を mount せずに確かめる。
import { describe, expect, it } from 'vitest';

import type { ColumnId } from '@nanairo-sheet/types';

import { createDiagnosticSink } from '../diagnostics';
import type { GridDiagnostic } from '../diagnostics';
import { createHiddenColumns } from './hidden-columns';

function setup(options: { attached?: boolean; phase?: string; composing?: boolean } = {}) {
  const columns = ['a', 'b', 'c', 'd', 'e'];
  const hidden = new Set<string>();
  let active = { row: 0, col: 0 };
  const moves: number[] = [];
  const diagnostics: GridDiagnostic[] = [];
  const view = {
    setHiddenColumns: (ids: Iterable<ColumnId>) => {
      const next = new Set([...ids].map(String));
      const changed = next.size !== hidden.size || [...next].some((id) => !hidden.has(id));
      hidden.clear();
      for (const id of next) hidden.add(id);
      return changed;
    },
    hasHiddenColumns: () => hidden.size > 0,
    isColumnHidden: (id: ColumnId) => hidden.has(String(id)),
    columnIdAt: (i: number) => columns[i] as ColumnId | undefined,
    colAxis: { count: () => columns.length },
  };
  let attached = options.attached ?? true;
  const backend = { view, session: { committedDocument: { columnOrder: columns } } };
  const editor = {
    session: {
      getActiveCell: () => active,
      isComposing: () => options.composing === true,
      getPhase: () => options.phase ?? 'Navigation',
    },
    pointerdownCell: (cell: { row: number; col: number }) => {
      moves.push(cell.col);
      active = cell;
    },
  };
  const hc = createHiddenColumns({
    diag: createDiagnosticSink((d) => diagnostics.push(d)),
    backend: () => (attached ? (backend as never) : undefined),
    editor: () => editor as never,
  });
  return {
    hc,
    hidden,
    moves,
    codes: () => diagnostics.map((d) => d.code),
    setActive: (col: number) => {
      active = { row: 0, col };
    },
    attach: () => {
      attached = true;
      hc.attach(backend as never);
    },
  };
}

describe('DD-070-7 hidden-columns', () => {
  it('隠す列を反映し、未知の列は捨てて warn。配列でなければ何も変えない', () => {
    const t = setup();
    expect(t.hc.set(['b', 'zz'], 'test')).toBe(true);
    expect([...t.hidden]).toEqual(['b']);
    expect(t.codes()).toEqual(['hidden-columns-invalid']);
    expect(t.hc.set('b' as never, 'test')).toBe(false);
    expect([...t.hidden]).toEqual(['b']);
  });

  it('結線の前に受けた指定は覚えておき、結線の時に検査して反映する', () => {
    const t = setup({ attached: false });
    expect(t.hc.set(['c', 'zz'], 'hiddenColumns')).toBe(false);
    expect(t.hidden.size).toBe(0);
    t.attach();
    expect([...t.hidden]).toEqual(['c']);
    expect(t.codes()).toEqual(['hidden-columns-invalid']); // 結線の時の検査で未知の zz
  });

  it('選択中のセルの列を隠すと、右の見えている列へ寄せる（右に無ければ左）', () => {
    const t = setup();
    t.setActive(1);
    t.hc.set(['b', 'c'], 'test');
    expect(t.moves).toEqual([3]);
    t.setActive(4);
    t.hc.set(['e'], 'test');
    expect(t.moves.at(-1)).toBe(3);
  });

  it('動いてきた向きを保って寄せる（左へ動いて隠した列に入ったら、さらに左へ）', () => {
    const t = setup();
    t.hc.set(['c'], 'test');
    t.setActive(3);
    t.hc.normalizeActiveCell(); // 直前の列を 3 として覚える
    t.setActive(2); // 左へ 1 つ（隠した c）
    expect(t.hc.normalizeActiveCell()).toBe(true);
    expect(t.moves.at(-1)).toBe(1);
  });

  it('編集中・変換中は寄せない。全部の列を隠したら寄せない', () => {
    const editing = setup({ phase: 'EditingReplace' });
    editing.setActive(1);
    editing.hc.set(['b'], 'test');
    expect(editing.moves).toEqual([]);
    const all = setup();
    all.hc.set(['a', 'b', 'c', 'd', 'e'], 'test');
    expect(all.moves).toEqual([]);
  });
});
