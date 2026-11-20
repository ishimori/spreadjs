// DD-070-7: 見せる列の切り替えの部品（検査・結線前の保留・選択中のセルの寄せ）。grid を mount せずに確かめる。
import { describe, expect, it } from 'vitest';

import type { ColumnId } from '@nanairo-sheet/types';

import { createDiagnosticSink } from '../diagnostics';
import type { GridDiagnostic } from '../diagnostics';
import { createHiddenColumns } from './hidden-columns';

function setup(
  options: { attached?: boolean; phase?: string; composing?: boolean; merge?: { colStart: number; colEnd: number } } = {},
) {
  let commits = 0;
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
  const backend = { view: { ...view, isWrapColumn: () => false, recomputeAllAutoRowHeights: () => {} }, session: { committedDocument: { columnOrder: columns }, isStopped: false } };
  const editor = {
    session: {
      getActiveCell: () => active,
      isComposing: () => options.composing === true,
      isStopped: false,
      getPhase: () => options.phase ?? 'Navigation',
    },
    pointerdownCell: (cell: { row: number; col: number }) => {
      moves.push(cell.col);
      active = cell;
    },
    commitEdit: () => {
      commits += 1;
      return options.composing === true ? 'composing' : 'committed';
    },
  };
  let range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number } | null = null;
  const extended: string[] = [];
  const hc = createHiddenColumns({
    diag: createDiagnosticSink((d) => diagnostics.push(d)),
    selectionCtrl: {
      getRange: () => range,
      extendTo: (a, f) => extended.push(`${a.col}->${f.col}`),
    },
    mergeAt: (_row: number, col: number) =>
      options.merge !== undefined && col >= options.merge.colStart && col < options.merge.colEnd
        ? { rowStart: 0, rowEnd: 1, colStart: options.merge.colStart, colEnd: options.merge.colEnd }
        : undefined,
    onColumnsChanged: () => {},
    backend: () => (attached ? (backend as never) : undefined),
    editor: () => editor as never,
  });
  return {
    hc,
    hidden,
    moves,
    extended,
    setRange: (r: typeof range) => {
      range = r;
    },
    codes: () => diagnostics.map((d) => d.code),
    commits: () => commits,
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

describe('DD-070-7 hidden-columns（Codex の指摘）', () => {
  it('P1: 見えている列のある結合の中なら寄せない（結合の左上への寄せと往復しない）', () => {
    const t = setup({ merge: { colStart: 0, colEnd: 2 } });
    t.setActive(0);
    t.hc.set(['a'], 'test'); // 結合 a:b の左上 a を隠す。b が見えているので寄せない
    expect(t.moves).toEqual([]);
    expect(t.hc.normalizeActiveCell()).toBe(false);
  });

  it('P2: 範囲の起点を隠したら、隣の列へ寄せたうえで範囲の他方の端を保つ', () => {
    const t = setup();
    t.setActive(1);
    t.setRange({ rowStart: 0, rowEnd: 1, colStart: 1, colEnd: 4 }); // b:d・起点 b
    t.hc.set(['b'], 'test');
    expect(t.moves).toEqual([2]);
    expect(t.extended).toEqual(['2->3']);
  });

  it('P1: 編集中のセルの列を隠すときは先に確定する。変換中は確定できないので変換の終わりまで待つ', () => {
    const editing = setup({ phase: 'EditingReplace' });
    editing.setActive(1);
    editing.hc.set(['b'], 'test');
    expect(editing.commits()).toBe(1);
    expect([...editing.hidden]).toEqual(['b']);
    const composing = setup({ phase: 'Composing', composing: true });
    composing.setActive(1);
    composing.hc.set(['b'], 'test');
    expect(composing.hidden.size).toBe(0); // 待っている
    expect(composing.codes()).toContain('hidden-columns-deferred');
    // 編集中のセルの列でなければ待たずに隠す。
    const other = setup({ phase: 'Composing', composing: true });
    other.setActive(0);
    other.hc.set(['c'], 'test');
    expect([...other.hidden]).toEqual(['c']);
  });

  it('P2: 隠したときは最後に横へ動いた向きへ寄せる（左へ動いた後に隠したら左へ）', () => {
    const t = setup();
    t.setActive(2);
    t.hc.normalizeActiveCell();
    t.setActive(1); // c → b（左へ）
    t.hc.normalizeActiveCell();
    t.hc.set(['b'], 'test');
    expect(t.moves.at(-1)).toBe(0);
  });
});
