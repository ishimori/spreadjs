// DD-070-8: 見せる行と並びの部品（検査・結線前の保留・編集中の確定・変換中の待ち）。grid を mount せずに確かめる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RowId } from '@nanairo-sheet/types';

import { createDiagnosticSink } from '../diagnostics';
import type { GridDiagnostic } from '../diagnostics';
import { createRowViewSwitch } from './row-view-switch';

function setup(
  options: {
    attached?: boolean;
    phase?: string;
    composing?: boolean;
    unknown?: number;
    standaloneBoot?: boolean;
    waitingInitialState?: boolean;
  } = {},
) {
  const initialWaiters: Array<() => void> = [];
  const diagnostics: GridDiagnostic[] = [];
  const applied: Array<readonly string[] | null> = [];
  const knowns: Array<string[] | null> = [];
  let commits = 0;
  let closes = 0;
  const queued: Array<() => void> = [];
  let docRows = ['r0', 'r1', 'r2'];
  let composing = options.composing === true;
  let phase = options.phase ?? 'Navigation';
  let attached = options.attached ?? true;
  let destroyed = false;
  const axisIds = ['r2', 'r0'];
  const backend = {
    view: {
      createRowViewSpec: (order: readonly RowId[]) => ({
        spec: { order: [...order], known: new Set(docRows) },
        unknown: options.unknown ?? 0,
      }),
      setRowView: (spec: { order: readonly RowId[]; known: ReadonlySet<string> } | null) => {
        applied.push(spec === null ? null : spec.order.map(String));
        knowns.push(spec === null ? null : [...spec.known]);
      },
      pendingRowOrder: () => axisIds,
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
    deferUntilInitialState: (run: () => void) => {
      if (options.waitingInitialState !== true) return false;
      initialWaiters.push(run);
      return true;
    },
    deferUntilStandaloneBoot: (run: () => void) => {
      if (options.standaloneBoot !== true) return false;
      queued.push(run);
      return true;
    },
  });
  return {
    sw,
    backend,
    applied,
    codes: () => diagnostics.map((d) => d.code),
    commits: () => commits,
    closes: () => closes,
    knowns,
    queued,
    initialWaiters,
    setDocRows: (rows: string[]) => {
      docRows = rows;
    },
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

  it('配列でも null でもない・文字列でない要素を含むなら何も変えずに warn（Codex P2）。null は戻す', () => {
    const t = setup();
    t.sw.set('r0');
    expect(t.applied).toEqual([]);
    expect(t.codes()).toEqual(['row-view-invalid']);
    t.sw.set(['r0', 1, 'r1']);
    t.sw.set([null]);
    expect(t.applied).toEqual([]);
    expect(t.codes()).toEqual(['row-view-invalid', 'row-view-invalid', 'row-view-invalid']);
    t.sw.set(['r0', 'r1']);
    t.sw.set(null);
    expect(t.applied).toEqual([['r0', 'r1'], null]);
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
    t.setDocRows(['r0', 'r1', 'r2', 'n']); // 変換を待つ間に行ができた（Codex P2: 呼んだ時点の行は呼んだ時に決める）
    t.endComposition();
    t.sw.scheduleCheck();
    vi.runAllTimers();
    expect(t.applied).toEqual([['r0']]);
    expect(t.knowns.at(-1)).toEqual(['r0', 'r1', 'r2']); // n は「後からできた行」
  });

  it('単独モードの boot 前は setData と同じ queue に積む（Codex P2: 保留した setData の後に呼んだ時点の行を決める）', () => {
    const t = setup({ attached: false, standaloneBoot: true });
    t.sw.set(['r1']);
    expect(t.queued).toHaveLength(1);
    t.attach();
    t.sw.attach(t.backend as never); // 結線では反映しない（queue の再生で反映する）
    expect(t.applied).toEqual([]);
    t.setDocRows(['r0', 'r1']); // 保留した setData が先に再生された
    t.queued[0]!();
    expect(t.applied).toEqual([['r1']]);
    expect(t.knowns.at(-1)).toEqual(['r0', 'r1']);
  });

  it('destroy の後は何もしない。visibleRowIds は保留中の構造を反映した並びを返す', () => {
    const t = setup();
    expect(t.sw.visibleRowIds()).toEqual(['r2', 'r0']);
    t.destroy();
    t.sw.set(['r0']);
    expect(t.applied).toEqual([]);
    expect(t.sw.visibleRowIds()).toEqual([]);
  });
});

describe('DD-070-9 row-view-switch（共同編集モードの初回の状態の前）', () => {
  it('初回の状態を受け取る前の指定は、受け取った後に今の文書で組み立てて反映する', () => {
    const t = setup({ waitingInitialState: true });
    t.sw.set(['r1', 'r0']);
    expect(t.applied).toEqual([]);
    expect(t.initialWaiters).toHaveLength(1);
    t.setDocRows(['r0', 'r1', 'r2']); // 初回の状態が届いた
    t.initialWaiters[0]!();
    expect(t.applied).toEqual([['r1', 'r0']]);
    expect(t.knowns.at(-1)).toEqual(['r0', 'r1', 'r2']);
  });

  it('結線の前に受けた指定も、初回の状態を受け取るまで待つ', () => {
    const t = setup({ attached: false, waitingInitialState: true });
    t.sw.set(['r2']);
    t.attach();
    t.sw.attach(t.backend as never);
    expect(t.applied).toEqual([]);
    t.initialWaiters[0]!();
    expect(t.applied).toEqual([['r2']]);
  });
});
