// DD-070-8: 見せる行と並びの部品（検査・結線前の保留・編集中の確定・変換中の待ち）。grid を mount せずに確かめる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RowId } from '@nanairo-sheet/types';

import { createDiagnosticSink } from '../diagnostics';
import type { GridDiagnostic } from '../diagnostics';
import { createRowViewSwitch } from './row-view-switch';

function setup(options: { attached?: boolean; phase?: string; composing?: boolean; unknown?: number } = {}) {
  const diagnostics: GridDiagnostic[] = [];
  const applied: Array<readonly string[] | null> = [];
  let commits = 0;
  let closes = 0;
  let flushes = 0;
  let composing = options.composing === true;
  let phase = options.phase ?? 'Navigation';
  let attached = options.attached ?? true;
  let destroyed = false;
  const axisIds = ['r2', 'r0'];
  const backend = {
    view: {
      setRowView: (order: readonly RowId[] | null) => {
        applied.push(order === null ? null : order.map(String));
        return options.unknown ?? 0;
      },
      rowAxis: { count: () => axisIds.length, getId: (i: number) => axisIds[i] },
    },
    session: { isStopped: false },
  };
  const editor = {
    session: { isComposing: () => composing, getPhase: () => phase },
    commitEdit: () => {
      commits += 1;
      return composing ? 'composing' : 'committed';
    },
  };
  const sw = createRowViewSwitch({
    diag: createDiagnosticSink((d) => diagnostics.push(d)),
    isDestroyed: () => destroyed,
    backend: () => (attached ? (backend as never) : undefined),
    editor: () => editor as never,
    closePopups: () => {
      closes += 1;
    },
    flushPendingStructure: () => {
      flushes += 1;
    },
  });
  return {
    sw,
    backend,
    applied,
    codes: () => diagnostics.map((d) => d.code),
    commits: () => commits,
    closes: () => closes,
    flushes: () => flushes,
    attach: () => {
      attached = true;
    },
    endComposition: () => {
      composing = false;
      phase = 'Navigation';
    },
    destroy: () => {
      destroyed = true;
    },
  };
}

describe('DD-070-8 row-view-switch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('配列でも null でもなければ何も変えずに warn。文字列でない要素は除いて warn。null は戻す', () => {
    const t = setup();
    t.sw.set('r0');
    expect(t.applied).toEqual([]);
    expect(t.codes()).toEqual(['row-view-invalid']);
    t.sw.set(['r0', 1, 'r1']);
    expect(t.applied).toEqual([['r0', 'r1']]);
    expect(t.codes()).toEqual(['row-view-invalid', 'row-view-invalid']);
    t.sw.set(null);
    expect(t.applied.at(-1)).toBeNull();
    expect(t.closes()).toBe(2); // 反映のたびに候補欄・日付を閉じる
  });

  it('文書に無い行 ID があれば warn する', () => {
    const t = setup({ unknown: 2 });
    t.sw.set(['x', 'y']);
    expect(t.codes()).toEqual(['row-view-invalid']);
  });

  it('結線前に受けた指定は覚えておき、結線の時に反映する（最後の指定だけ）', () => {
    const t = setup({ attached: false });
    t.sw.set(['r0']);
    t.sw.set(['r1']);
    expect(t.applied).toEqual([]);
    expect(t.sw.visibleRowIds()).toEqual([]);
    t.attach();
    t.sw.attach(t.backend as never);
    expect(t.applied).toEqual([['r1']]);
  });

  it('編集中なら確定してから変える。変換中なら変換が終わってから（次のタスクで判定）', () => {
    const editing = setup({ phase: 'EditingReplace' });
    editing.sw.set(['r0']);
    expect(editing.commits()).toBe(1);
    expect(editing.applied).toEqual([['r0']]);

    const t = setup({ phase: 'Composing', composing: true });
    t.sw.set(['r0']);
    expect(t.applied).toEqual([]);
    expect(t.codes()).toContain('row-view-deferred');
    t.sw.scheduleCheck();
    vi.runAllTimers();
    expect(t.applied).toEqual([]); // まだ変換中
    t.endComposition();
    t.sw.scheduleCheck();
    vi.runAllTimers();
    expect(t.applied).toEqual([['r0']]);
  });

  it('destroy の後は何もしない。visibleRowIds は保留中の構造を反映してから Axis の並びを返す', () => {
    const t = setup();
    expect(t.sw.visibleRowIds()).toEqual(['r2', 'r0']);
    expect(t.flushes()).toBe(1);
    t.destroy();
    t.sw.set(['r0']);
    expect(t.applied).toEqual([]);
    expect(t.sw.visibleRowIds()).toEqual([]);
  });
});
