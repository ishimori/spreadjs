// undo-stack のユニットテスト（DD-020-3 Phase 1）。
// 記録/逆値・原子補償・深さ100・redo 破棄・pending/ACK ゲート・reject 除去・OCC 生成物・連続同一セル追従・
// in-flight 直列化・キーバインド裁定を DOM/backend なしで機械検証する。シナリオ正本: doc/DD/DD-020-3/scenarios.md。

import { describe, expect, it } from 'vitest';

import { applyOperation, createDocument, validateOperation } from '@nanairo-sheet/core';
import type { CellScalar, DocumentOperation, SheetDocument } from '@nanairo-sheet/core';
import { createColumnId, createOperationId, createRowId } from '@nanairo-sheet/types';

import {
  UNDO_STACK_MAX_DEPTH,
  createUndoController,
  decideUndoRedoKey,
  type UndoPatch,
} from './undo-stack';

const COLS = ['c0', 'c1', 'c2', 'c3'].map((c) => createColumnId(c));
const ROWS = ['r0', 'r1', 'r2'].map((r) => createRowId(r));

const blank: CellScalar = { kind: 'blank' };
const str = (value: string): CellScalar => ({ kind: 'string', value });
const num = (value: number): CellScalar => ({ kind: 'number', value });

function patch(row: number, col: number, before: CellScalar, after: CellScalar): UndoPatch {
  return { rowId: ROWS[row]!, columnId: COLS[col]!, before, after };
}

// ---- U-1/U-2 記録・逆値/順値・原子補償 --------------------------------------------------------

describe('undo-stack: 記録と補償生成（AC1/AC2）', () => {
  it('U-1: 単一セル commit → beginUndo=before・beginRedo=after（型往復・standalone 即時 ACK）', () => {
    const ctrl = createUndoController();
    ctrl.recordUserOp(null, [patch(0, 0, blank, num(42))], 5); // 即時確定 revision=5
    expect(ctrl.canUndo(0)).toBe(true);

    const undo = ctrl.beginUndo(0);
    expect(undo).not.toBeNull();
    expect(undo!.operation).toEqual({
      type: 'setCells',
      conflictPolicy: 'reject-overlap',
      changes: [{ rowId: ROWS[0], columnId: COLS[0], beforeRevision: 5, value: blank }],
    });

    ctrl.resolveCompensationCommitted(6); // 補償確定@6 → redo へ
    expect(ctrl.undoDepth()).toBe(0);
    expect(ctrl.redoDepth()).toBe(1);

    const redo = ctrl.beginRedo(0);
    expect(redo!.operation.changes).toEqual([
      { rowId: ROWS[0], columnId: COLS[0], beforeRevision: 6, value: num(42) },
    ]);
  });

  it('U-2: 範囲（3 セル）→ beginUndo は 1 SetCells に 3 changes（原子・全成功/全失敗）', () => {
    const ctrl = createUndoController();
    ctrl.recordUserOp(
      null,
      [patch(0, 0, str('old'), str('P')), patch(0, 1, blank, str('Q')), patch(1, 0, blank, str('R'))],
      2,
    );
    const undo = ctrl.beginUndo(0);
    expect(undo!.operation.changes).toEqual([
      { rowId: ROWS[0], columnId: COLS[0], beforeRevision: 2, value: str('old') },
      { rowId: ROWS[0], columnId: COLS[1], beforeRevision: 2, value: blank },
      { rowId: ROWS[1], columnId: COLS[0], beforeRevision: 2, value: blank },
    ]);
  });

  it('U-3: 変化なし（before===after のみ）の op はスタックに積まない（noop 補償ハング防止）', () => {
    const ctrl = createUndoController();
    ctrl.recordUserOp(null, [patch(0, 0, str('same'), str('same'))], 1);
    expect(ctrl.undoDepth()).toBe(0);
    expect(ctrl.canUndo(0)).toBe(false);
  });
});

// ---- U-4 深さ・U-5 redo 破棄 -------------------------------------------------------------------

describe('undo-stack: 深さ100・redo 破棄（AC6/AC4）', () => {
  it('U-4: 深さ超過は古い順に破棄（残りは最新から undo できる）', () => {
    const ctrl = createUndoController(2);
    ctrl.recordUserOp(null, [patch(0, 0, blank, str('a'))], 1);
    ctrl.recordUserOp(null, [patch(0, 1, blank, str('b'))], 2);
    ctrl.recordUserOp(null, [patch(0, 2, blank, str('c'))], 3); // a を押し出す
    expect(ctrl.undoDepth()).toBe(2);

    expect(ctrl.beginUndo(0)!.operation.changes[0]!.columnId).toBe(COLS[2]); // c
    ctrl.resolveCompensationCommitted(4);
    expect(ctrl.beginUndo(0)!.operation.changes[0]!.columnId).toBe(COLS[1]); // b
    ctrl.resolveCompensationCommitted(5);
    expect(ctrl.beginUndo(0)).toBeNull(); // a は破棄済み
  });

  it('既定深さは 100', () => {
    expect(UNDO_STACK_MAX_DEPTH).toBe(100);
    const ctrl = createUndoController();
    for (let i = 0; i < 101; i += 1) {
      ctrl.recordUserOp(null, [patch(0, 0, blank, num(i))], i + 1);
    }
    expect(ctrl.undoDepth()).toBe(100);
  });

  it('U-5: 新規通常操作で redo スタックを破棄（AC4）', () => {
    const ctrl = createUndoController();
    ctrl.recordUserOp(null, [patch(0, 0, blank, str('a'))], 1);
    ctrl.beginUndo(0);
    ctrl.resolveCompensationCommitted(2);
    expect(ctrl.redoDepth()).toBe(1);

    ctrl.recordUserOp(null, [patch(0, 1, blank, str('b'))], 3); // 新規操作
    expect(ctrl.redoDepth()).toBe(0);
    expect(ctrl.canRedo(0)).toBe(false);
  });
});

// ---- RC4（DD-052-4・Codex P2）recordProgrammaticOp: setRows 由来の記録は無関係な redo を破棄しない -------

describe('undo-stack: recordProgrammaticOp（setRows 用・redo は重複セルだけ破棄）', () => {
  it('無関係な行の redo エントリは破棄しない（recordUserOp と違う点）', () => {
    const ctrl = createUndoController();
    ctrl.recordUserOp(null, [patch(1, 0, blank, str('b'))], 1); // row1 を編集
    ctrl.beginUndo(0);
    ctrl.resolveCompensationCommitted(2);
    expect(ctrl.redoDepth()).toBe(1); // row1 の redo が積まれている

    ctrl.recordProgrammaticOp([patch(0, 0, blank, str('from-setRows'))], 3); // 無関係な row0 を setRows で更新
    expect(ctrl.redoDepth()).toBe(1); // row1 の redo はそのまま残る
    expect(ctrl.canRedo(0)).toBe(true);
    expect(ctrl.undoDepth()).toBe(1); // setRows 分も undo できる
  });

  it('上書きしたセルと重なる redo エントリだけを取り除く（古い値での巻き戻り事故防止）', () => {
    const ctrl = createUndoController();
    ctrl.recordUserOp(null, [patch(0, 0, blank, str('typed'))], 1); // row0/col0 を編集
    ctrl.beginUndo(0);
    ctrl.resolveCompensationCommitted(2);
    expect(ctrl.redoDepth()).toBe(1);

    // setRows が同じ row0/col0 を上書き → その redo エントリ（古い 'typed' への戻し）は無効化されるべき。
    ctrl.recordProgrammaticOp([patch(0, 0, blank, str('from-setRows'))], 3);
    expect(ctrl.redoDepth()).toBe(0);
    expect(ctrl.canRedo(0)).toBe(false);
  });

  it('変化なし（before===after）の patches は記録しない（redo にも触れない）', () => {
    const ctrl = createUndoController();
    ctrl.recordUserOp(null, [patch(1, 0, blank, str('b'))], 1);
    ctrl.beginUndo(0);
    ctrl.resolveCompensationCommitted(2);
    expect(ctrl.redoDepth()).toBe(1);

    ctrl.recordProgrammaticOp([patch(0, 0, str('same'), str('same'))], 3);
    expect(ctrl.undoDepth()).toBe(0); // noop は記録しない
    expect(ctrl.redoDepth()).toBe(1); // 触れない
  });

  it('記録したエントリは通常どおり undo できる', () => {
    const ctrl = createUndoController();
    ctrl.recordProgrammaticOp([patch(0, 0, blank, str('injected'))], 5);
    expect(ctrl.canUndo(0)).toBe(true);
    const undo = ctrl.beginUndo(0);
    expect(undo!.operation.changes).toEqual([{ rowId: ROWS[0], columnId: COLS[0], beforeRevision: 5, value: blank }]);
  });
});

// ---- U-6 pending/ACK・U-7 元 op reject（AC5） -------------------------------------------------

describe('undo-stack: pending/ACK・元 op reject（AC5）', () => {
  it('U-6: pending 中は undo 不可・ACK 後に可能（collab）', () => {
    const ctrl = createUndoController();
    const op1 = createOperationId('op1');
    ctrl.recordUserOp(op1, [patch(0, 0, blank, str('x'))], null); // 未 ACK
    expect(ctrl.canUndo(1)).toBe(false); // pendingCount>0 → 不可
    ctrl.onCommitted(op1, 7); // ACK → ownedRevision 設定
    expect(ctrl.canUndo(0)).toBe(true);
    expect(ctrl.beginUndo(0)!.operation.changes[0]!.beforeRevision).toBe(7);
  });

  it('U-7: reject された元 op はスタックから除去（block 通知ではない）', () => {
    const ctrl = createUndoController();
    const op1 = createOperationId('op1');
    ctrl.recordUserOp(op1, [patch(0, 0, blank, str('x'))], null);
    expect(ctrl.undoDepth()).toBe(1);
    expect(ctrl.onRejected(op1)).toBeUndefined();
    expect(ctrl.undoDepth()).toBe(0);
  });
});

// ---- U-8 OCC 生成物（AC3・生成 op がサーバー検証と整合） --------------------------------------

describe('undo-stack: 補償 op の OCC（AC3）', () => {
  const INSERT_ROWS: DocumentOperation = {
    type: 'insertRows',
    afterRowId: null,
    rows: ROWS.map((rowId) => ({ rowId })),
  };
  const setOp = (row: number, col: number, value: string): DocumentOperation => ({
    type: 'setCells',
    conflictPolicy: 'reject-overlap',
    changes: [{ rowId: ROWS[row]!, columnId: COLS[col]!, value: { kind: 'string', value } }],
  });
  function build(ops: DocumentOperation[]): SheetDocument {
    let doc = createDocument(COLS);
    let revision = 0;
    for (const op of ops) {
      revision += 1;
      doc = applyOperation(doc, op, { revision }).document;
    }
    return doc;
  }

  it('U-8: 他者が対象セルを後続変更 → 補償 SetCells は stale-cell-revision（全体 reject）', () => {
    const ctrl = createUndoController();
    const op1 = createOperationId('op1');
    // committed: (0,0)="x" が rev2（我々の op が付与）。
    const doc = build([INSERT_ROWS, setOp(0, 0, 'x')]);
    ctrl.recordUserOp(op1, [patch(0, 0, blank, str('x'))], null);
    ctrl.onCommitted(op1, 2); // ownedRevision[(0,0)]=2

    const undo = ctrl.beginUndo(0)!;
    expect(undo.operation.changes[0]!.beforeRevision).toBe(2);

    // 他者が (0,0) を rev3 へ前進 → 補償の beforeRevision(2) が stale。
    const advanced = applyOperation(doc, setOp(0, 0, '他者'), { revision: 3 }).document;
    expect(validateOperation(advanced, undo.operation)).toEqual([
      {
        code: 'stale-cell-revision',
        rowId: ROWS[0],
        columnId: COLS[0],
        currentValue: { kind: 'string', value: '他者' },
        currentRevision: 3,
      },
    ]);
  });

  it('範囲外セルを他者が変更しても補償は競合しない（セル単位 beforeRevision）', () => {
    const ctrl = createUndoController();
    const op1 = createOperationId('op1');
    const doc = build([INSERT_ROWS, setOp(0, 0, 'x')]);
    ctrl.recordUserOp(op1, [patch(0, 0, blank, str('x'))], null);
    ctrl.onCommitted(op1, 2);
    const undo = ctrl.beginUndo(0)!;
    const advanced = applyOperation(doc, setOp(1, 1, '無関係'), { revision: 3 }).document;
    expect(validateOperation(advanced, undo.operation)).toEqual([]);
  });
});

// ---- U-9 連続同一セル編集の undo（自傷 reject 回避・ownedRevision 追従） -----------------------

describe('undo-stack: 連続同一セル編集の undo（ownedRevision 追従・U-9）', () => {
  it('op1→op2（同一セル）を 2 回 undo できる（2 回目の beforeRevision は自分の undo で bump した revision）', () => {
    const ctrl = createUndoController();
    const op1 = createOperationId('op1');
    const op2 = createOperationId('op2');
    ctrl.recordUserOp(op1, [patch(0, 0, blank, str('x'))], null);
    ctrl.onCommitted(op1, 1); // ownedRevision[(0,0)]=1
    ctrl.recordUserOp(op2, [patch(0, 0, str('x'), str('y'))], null);
    ctrl.onCommitted(op2, 2); // ownedRevision[(0,0)]=2

    // undo op2（最新）→ beforeRevision=2。
    const u2 = ctrl.beginUndo(0)!;
    expect(u2.operation.changes[0]!.beforeRevision).toBe(2);
    expect(u2.operation.changes[0]!.value).toEqual(str('x'));
    ctrl.setCompensationOperationId(createOperationId('c2'));
    ctrl.onCommitted(createOperationId('c2'), 3); // 補償確定@3 → ownedRevision[(0,0)]=3・redo へ

    // undo op1 → beforeRevision は **3**（1 ではない＝自傷しない）・value=op1 の before(blank)。
    const u1 = ctrl.beginUndo(0)!;
    expect(u1.operation.changes[0]!.beforeRevision).toBe(3);
    expect(u1.operation.changes[0]!.value).toEqual(blank);
  });
});

// ---- U-10 補償 reject → block・U-11 in-flight 直列化 ------------------------------------------

describe('undo-stack: 補償 reject（a）と in-flight 直列化', () => {
  it('U-10: 補償 op reject → block 通知・エントリ除去（redo/undo へ戻さない）', () => {
    const ctrl = createUndoController();
    ctrl.recordUserOp(null, [patch(0, 0, blank, str('x'))], 1);
    ctrl.beginUndo(0);
    ctrl.setCompensationOperationId(createOperationId('c1'));
    expect(ctrl.onRejected(createOperationId('c1'))).toBe('undo-blocked');
    expect(ctrl.undoDepth()).toBe(0);
    expect(ctrl.redoDepth()).toBe(0); // 除去（既定案 a）
    expect(ctrl.isBusy()).toBe(false);
  });

  it('redo 補償 reject → redo-blocked', () => {
    const ctrl = createUndoController();
    ctrl.recordUserOp(null, [patch(0, 0, blank, str('x'))], 1);
    ctrl.beginUndo(0);
    ctrl.resolveCompensationCommitted(2); // undo 成功 → redo に 1
    ctrl.beginRedo(0);
    ctrl.setCompensationOperationId(createOperationId('c2'));
    expect(ctrl.onRejected(createOperationId('c2'))).toBe('redo-blocked');
    expect(ctrl.undoDepth()).toBe(0);
    expect(ctrl.redoDepth()).toBe(0);
  });

  it('U-11: in-flight 中は undo/redo 不可（直列化）→ 解決で解除', () => {
    const ctrl = createUndoController();
    ctrl.recordUserOp(null, [patch(0, 0, blank, str('x'))], 1);
    ctrl.beginUndo(0);
    expect(ctrl.isBusy()).toBe(true);
    expect(ctrl.canUndo(0)).toBe(false);
    expect(ctrl.canRedo(0)).toBe(false);
    expect(ctrl.beginUndo(0)).toBeNull();
    ctrl.resolveCompensationCommitted(2);
    expect(ctrl.isBusy()).toBe(false);
    expect(ctrl.canRedo(0)).toBe(true);
  });

  it('abortInFlightCompensation は in-flight を元スタックへ巻き戻す', () => {
    const ctrl = createUndoController();
    ctrl.recordUserOp(null, [patch(0, 0, blank, str('x'))], 1);
    ctrl.beginUndo(0);
    ctrl.abortInFlightCompensation();
    expect(ctrl.isBusy()).toBe(false);
    expect(ctrl.undoDepth()).toBe(1); // 元へ戻る
  });

  it('blockInFlightCompensation は in-flight を拒否確定し block 種別を返す（除去・pre-check stale 用・Codex P1）', () => {
    const ctrl = createUndoController();
    ctrl.recordUserOp(null, [patch(0, 0, blank, str('x'))], 1);
    ctrl.beginUndo(0);
    expect(ctrl.blockInFlightCompensation()).toBe('undo-blocked');
    expect(ctrl.isBusy()).toBe(false);
    expect(ctrl.undoDepth()).toBe(0); // 除去（元へ戻さない）
    expect(ctrl.redoDepth()).toBe(0);
    expect(ctrl.blockInFlightCompensation()).toBeUndefined(); // in-flight 無しは undefined
  });
});

// ---- clear（standalone 文書差し替え・Codex P1） ---------------------------------------------

describe('undo-stack: clear（文書差し替えで履歴無効化）', () => {
  it('clear は undo/redo スタック・ownedRevision・in-flight を全消去する', () => {
    const ctrl = createUndoController();
    ctrl.recordUserOp(null, [patch(0, 0, blank, str('a'))], 1);
    ctrl.beginUndo(0);
    ctrl.resolveCompensationCommitted(2); // redo に 1
    ctrl.recordUserOp(null, [patch(0, 1, blank, str('b'))], 3);
    expect(ctrl.undoDepth()).toBe(1);
    expect(ctrl.redoDepth()).toBe(0); // b 記録で redo 破棄済み
    ctrl.beginUndo(0); // in-flight
    ctrl.clear();
    expect(ctrl.undoDepth()).toBe(0);
    expect(ctrl.redoDepth()).toBe(0);
    expect(ctrl.isBusy()).toBe(false);
    expect(ctrl.canUndo(0)).toBe(false);
  });
});

// ---- U-12 キーバインド裁定（AC8） -------------------------------------------------------------

describe('decideUndoRedoKey: Navigation×非 composing のみ undo/redo（AC8）', () => {
  const base = {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    eventComposing: false,
    sessionComposing: false,
    phase: 'Navigation' as const,
  };

  it('Ctrl+Z=undo・Ctrl+Shift+Z=redo・Ctrl+Y=redo・Cmd+Z=undo・Cmd+Shift+Z=redo', () => {
    expect(decideUndoRedoKey({ ...base, key: 'z', ctrlKey: true })).toBe('undo');
    expect(decideUndoRedoKey({ ...base, key: 'z', ctrlKey: true, shiftKey: true })).toBe('redo');
    expect(decideUndoRedoKey({ ...base, key: 'y', ctrlKey: true })).toBe('redo');
    expect(decideUndoRedoKey({ ...base, key: 'Z', metaKey: true })).toBe('undo'); // 大文字も
    expect(decideUndoRedoKey({ ...base, key: 'z', metaKey: true, shiftKey: true })).toBe('redo');
  });

  it('修飾なし・alt 併用・Cmd+Y は none', () => {
    expect(decideUndoRedoKey({ ...base, key: 'z' })).toBe('none');
    expect(decideUndoRedoKey({ ...base, key: 'z', ctrlKey: true, altKey: true })).toBe('none');
    expect(decideUndoRedoKey({ ...base, key: 'y', metaKey: true })).toBe('none'); // Cmd+Y は redo にしない
  });

  it('Editing/Composing・composing 中は全て none（ブラウザ既定へ委譲・I-3）', () => {
    for (const phase of ['EditingReplace', 'EditingExisting', 'EditingAwaitFinalInput', 'Composing'] as const) {
      expect(decideUndoRedoKey({ ...base, key: 'z', ctrlKey: true, phase }), phase).toBe('none');
    }
    expect(decideUndoRedoKey({ ...base, key: 'z', ctrlKey: true, eventComposing: true })).toBe('none');
    expect(decideUndoRedoKey({ ...base, key: 'z', ctrlKey: true, sessionComposing: true })).toBe('none');
  });
});
