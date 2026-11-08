// DD-065: 送信の関所（mount/edit-submit.ts）を、grid を mount せずに確かめる。
import { describe, expect, it } from 'vitest';
import { applyOperation, createDocument } from '@nanairo-sheet/core';
import type { DocumentOperation, SetCellsOperation, SheetDocument } from '@nanairo-sheet/core';
import { createColumnId, createOperationId, createRowId } from '@nanairo-sheet/types';

import { createDiagnosticSink } from '../diagnostics';
import type { GridDiagnostic } from '../diagnostics';
import type { GridBackend } from '../grid-backend';
import type { GridEvent } from '../index';
import { createSelectionController } from '../selection-controller';
import { createUndoController } from '../undo-stack';
import { createEditSubmit } from './edit-submit';

function setup(options: { standalone?: boolean; readOnly?: boolean; validateCell?: (cell: { value: string }) => string | undefined } = {}) {
  let doc: SheetDocument = applyOperation(
    createDocument([createColumnId('a'), createColumnId('b')]),
    { type: 'insertRows', afterRowId: null, rows: [{ rowId: createRowId('r1') }] },
    { revision: 1 },
  ).document;
  const submitted: DocumentOperation[] = [];
  const pending: string[] = [];
  const backend = {
    session: {
      get viewDocument() {
        return doc;
      },
      get committedDocument() {
        return doc;
      },
      isStopped: false,
      pendingCount: 0,
      pendingOperationIds: () => pending.map((id) => createOperationId(id)),
      submitLocalOperation: (op: DocumentOperation) => {
        submitted.push(op);
        const id = `op-${submitted.length}`;
        pending.push(id);
        return createOperationId(id);
      },
    },
    view: { recomputeAutoRowHeightsForRows: () => {}, noteOperation: () => {} },
  } as unknown as GridBackend;
  const events: GridEvent[] = [];
  const diagnostics: GridDiagnostic[] = [];
  const undoCtrl = createUndoController();
  const editSubmit = createEditSubmit({
    diag: createDiagnosticSink((entry) => diagnostics.push(entry)),
    isStandalone: options.standalone === true,
    wrapEnabled: false,
    validateCell: options.validateCell as never,
    undoCtrl,
    selectionCtrl: createSelectionController(),
    readonlySwitch: { isReadOnly: () => options.readOnly === true, isDeferredEditorCommit: () => false },
    cellLock: {
      hasReadOnlyRows: () => false,
      isReadOnlyRowId: () => false,
      hasReadOnlyColumns: () => false,
      isReadOnlyColumnId: () => false,
      hasReadOnlyCellRows: () => false,
      isReadOnlyCellId: () => false,
    },
    emit: (event) => events.push(event),
    isDestroyed: () => false,
    backend: () => backend,
    editor: () => undefined,
    isFirstDataDrawn: () => true,
  });
  return {
    editSubmit,
    submitted,
    events,
    undoCtrl,
    codes: () => diagnostics.map((d) => d.code),
    setDoc: (next: SheetDocument) => {
      doc = next;
    },
  };
}

function setA(value: string): SetCellsOperation {
  return {
    type: 'setCells',
    conflictPolicy: 'reject-overlap',
    changes: [{ rowId: createRowId('r1'), columnId: createColumnId('a'), beforeRevision: 0, value: { kind: 'string', value } }],
  };
}

describe('mount/edit-submit: 送信の関所', () => {
  it('読み取り専用では Undo を捕捉する前に破棄し、送らない', () => {
    const { editSubmit, submitted, undoCtrl, codes } = setup({ readOnly: true });
    expect(editSubmit.submitSetCells(setA('x'), 'edit')).toBeUndefined();
    expect(submitted).toEqual([]);
    expect(undoCtrl.undoDepth()).toBe(0);
    expect(codes()).toEqual(['readonly-blocked']);
  });

  it('共同編集モードで送った操作は、pending に残っていれば Undo へ積む', () => {
    const { editSubmit, submitted, undoCtrl } = setup();
    editSubmit.submitSetCells(setA('x'), 'edit');
    expect(submitted).toHaveLength(1);
    expect(undoCtrl.undoDepth()).toBe(1);
  });

  it('validateCell が拒否したら送らず、cell-invalid は確定処理の後（マイクロタスク）で出す', async () => {
    const { editSubmit, submitted, events } = setup({ validateCell: (cell) => (cell.value === 'NG' ? '使えない値' : undefined) });
    editSubmit.submitSetCells(setA('NG'), 'edit');
    expect(submitted).toEqual([]);
    expect(events).toEqual([]); // 同期では出さない（購読者の setActiveCell が後続の移動に上書きされないように）
    await Promise.resolve();
    expect(events).toEqual([
      { type: 'cell-invalid', source: 'edit', cells: [{ rowId: 'r1', columnId: 'a', value: 'NG', message: '使えない値' }] },
    ]);
  });

  it('空にする変更は validateCell で検証しない', () => {
    const { editSubmit, submitted } = setup({ validateCell: () => '常に拒否' });
    const clear: SetCellsOperation = {
      ...setA(''),
      changes: [{ rowId: createRowId('r1'), columnId: createColumnId('a'), beforeRevision: 0, value: { kind: 'blank' } }],
    };
    editSubmit.submitSetCells(clear, 'edit');
    expect(submitted).toHaveLength(1);
  });
});

describe('mount/edit-submit: 行操作の実行前拒否', () => {
  it('行数が正の整数でなければ送らず、共同編集モードは rejected（row-count-invalid）を出す', () => {
    const { editSubmit, submitted, events } = setup();
    editSubmit.performInsertRows(null, 0);
    expect(submitted).toEqual([]);
    expect(events).toEqual([
      { type: 'rejected', pendingCount: 0, conflict: { operationId: '', reason: 'rejected', code: 'row-count-invalid' } },
    ]);
  });

  it('単独モードは同じ拒否を診断だけにする（rejected を出さない）', () => {
    const { editSubmit, events, codes } = setup({ standalone: true });
    editSubmit.performDeleteRows(['存在しない行']);
    expect(events).toEqual([]);
    expect(codes()).toEqual(['delete-empty']);
  });

  it('行を挿入すると送ったうえで row-structure-change を出す', () => {
    const { editSubmit, submitted, events } = setup();
    editSubmit.performInsertRows('r1', 2);
    expect(submitted).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'row-structure-change', change: { kind: 'insert', afterRowId: 'r1' } });
  });
});
