// DD-065: 命令 API の保留キュー（mount/commands.ts）を、grid を mount せずに確かめる。
// 分割前は E2E で起こせなかった上限超え（command-queue-overflow）をここで固定する（diagnosis §9）。
import { describe, expect, it } from 'vitest';
import { EMPTY_MERGE_INDEX } from '@nanairo-sheet/selection';

import { createDiagnosticSink } from '../diagnostics';
import type { GridDiagnostic } from '../diagnostics';
import type { GridBackend } from '../grid-backend';
import { PENDING_COMMANDS_MAX } from './constants';
import { createCommands } from './commands';

function setup() {
  const state = { ready: false, structuralDirty: false, destroyed: false, flushes: 0 };
  const diagnostics: GridDiagnostic[] = [];
  const backend = {
    view: {
      hasStructuralDirty: () => state.structuralDirty,
      colAxis: { count: () => 3 },
      rowIndexOf: () => 0,
      colIndexOf: () => 0,
      markViewportDirty: () => {},
    },
  } as unknown as GridBackend;
  const commands = createCommands({
    diag: createDiagnosticSink((entry) => diagnostics.push(entry)),
    selectionCtrl: { clear: () => false },
    isDestroyed: () => state.destroyed,
    backend: () => (state.ready ? backend : undefined),
    editor: () => undefined,
    isFirstDataDrawn: () => state.ready,
    viewportWidth: () => (state.ready ? 800 : 0),
    currentMerges: () => EMPTY_MERGE_INDEX,
    closePopups: () => {},
    flushStructural: () => {
      state.flushes += 1;
      state.structuralDirty = false;
    },
    ensureCellVisible: () => {},
  });
  return { commands, state, codes: () => diagnostics.map((d) => d.code) };
}

describe('mount/commands: 保留と適用', () => {
  it('boot 前・初回描画前は保留し、準備ができた後の drain で呼ばれた順に適用する', () => {
    const { commands, state } = setup();
    const ran: number[] = [];
    commands.runOrDefer(() => ran.push(1));
    commands.runOrDefer(() => ran.push(2));
    expect(ran).toEqual([]);
    expect(commands.hasPending()).toBe(true); // 保留中は editor の入力を論理遮断する条件
    state.ready = true;
    commands.drain();
    expect(ran).toEqual([1, 2]);
    expect(commands.hasPending()).toBe(false);
  });

  it('準備ができていればすぐに適用する。構造 dirty 中なら先に同期で構造 flush してから適用する', () => {
    const { commands, state } = setup();
    state.ready = true;
    state.structuralDirty = true;
    const ran: string[] = [];
    commands.runOrDefer(() => ran.push(`run(dirty=${state.structuralDirty})`));
    expect(state.flushes).toBe(1);
    expect(ran).toEqual(['run(dirty=false)']);
  });

  it(`保留が上限（${PENDING_COMMANDS_MAX}）を超えたら最古の要求を捨て、超えるたびに診断を出す`, () => {
    const { commands, state, codes } = setup();
    const ran: number[] = [];
    for (let i = 0; i < PENDING_COMMANDS_MAX + 2; i += 1) {
      commands.runOrDefer(() => ran.push(i));
    }
    expect(codes()).toEqual(['command-queue-overflow', 'command-queue-overflow']);
    state.ready = true;
    commands.drain();
    expect(ran).toHaveLength(PENDING_COMMANDS_MAX);
    expect(ran[0]).toBe(2); // 最古の 2 件（0・1）が捨てられた
  });

  it('destroy の後の命令は積まず、discard で保留を捨てる', () => {
    const { commands, state } = setup();
    commands.runOrDefer(() => {});
    commands.discard();
    expect(commands.hasPending()).toBe(false);
    state.destroyed = true;
    commands.runOrDefer(() => {});
    expect(commands.hasPending()).toBe(false);
  });

  it('列の命令は初回描画を待たずに、列 Axis と viewport の幅があれば適用できる', () => {
    const { commands, state } = setup();
    commands.scrollToColumn('c1');
    expect(commands.hasPending()).toBe(true); // backend がまだ無い
    state.ready = true;
    commands.drain();
    expect(commands.hasPending()).toBe(false);
  });
});
