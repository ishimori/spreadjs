import { describe, expect, it } from 'vitest';

import { ClientSession, createCounterIdGenerator } from '@nanairo-sheet/collab';
import type { PresenceUpdate, SessionConfig } from '@nanairo-sheet/collab';
import {
  RecordingTransport,
  col,
  createManualClock,
  insertRows,
  num,
  operationsMessage,
  row,
  serverEnvelope,
  setCells,
  str,
} from '@nanairo-sheet/collab/test-support';
import { applyOperation, createDocument, displayRowOrder, getCell } from '@nanairo-sheet/core';
import type { DocumentOperation, ServerMessage, SetCellsOperation } from '@nanairo-sheet/core';
import { createColumnId, createDocumentId } from '@nanairo-sheet/types';

import type { GridLayout } from '@nanairo-sheet/ime';

import { cellScalarToDisplay } from './document-view';
import {
  createImeEditingSession,
  type EditingDocumentPort,
  type TextareaPort,
} from './ime-editing-session';

const COLS = [col('col-0'), col('col-1'), col('col-2')];

const LAYOUT: GridLayout = {
  rowCount: 100,
  columnCount: 3,
  rowHeaderWidth: 40,
  columnHeaderHeight: 20,
  cellWidth: 80,
  cellHeight: 22,
};

// ---- fake TextareaPort（value/selection/配置/見た目の呼び出しを記録） ----
function createFakePort() {
  let value = '';
  let selStart = 0;
  let selEnd = 0;
  let lastRect: unknown = undefined;
  let editingVisual = false;
  let conflict = false;
  const calls = { setValue: 0, setSelectionRange: 0, place: 0, focus: 0 };
  const port: TextareaPort = {
    getValue: () => value,
    setValue: (v) => {
      value = v;
      calls.setValue += 1;
    },
    setSelectionRange: (s, e) => {
      selStart = s;
      selEnd = e;
      calls.setSelectionRange += 1;
    },
    focus: () => {
      calls.focus += 1;
    },
    place: (r) => {
      lastRect = r;
      calls.place += 1;
    },
    setEditingVisual: (e) => {
      editingVisual = e;
    },
    setConflict: (c) => {
      conflict = c;
    },
    insertNewlineAtCaret: () => {
      // テスト用の簡略実装: 常に末尾へ改行を追加する（caret 追跡はしない）。
      value = `${value}\n`;
      return value;
    },
  };
  return {
    port,
    calls,
    /** browser が composition 中に textarea.value を設定する動作の模擬。 */
    browserSetValue: (v: string) => {
      value = v;
    },
    snap: () => ({ value, selStart, selEnd, place: lastRect, editingVisual, conflict }),
  };
}

// ---- 可変 committed 文書に対する EditingDocumentPort（DocumentView 相当の解決） ----
function createDocState(ops: DocumentOperation[]) {
  let doc = createDocument(COLS);
  let revision = 0;
  const apply = (op: DocumentOperation): void => {
    revision += 1;
    doc = applyOperation(doc, op, { revision }).document;
  };
  for (const op of ops) {
    apply(op);
  }
  const port: EditingDocumentPort = {
    getCommittedDocument: () => doc,
    displayText: (rowId, columnId) => cellScalarToDisplay(getCell(doc, rowId, columnId)?.value ?? { kind: 'blank' }),
    rowIdAt: (i) => displayRowOrder(doc)[i],
    colIdAt: (i) => doc.columnOrder[i],
    rowIndexOf: (rowId) => displayRowOrder(doc).indexOf(rowId),
    colIndexOf: (columnId) => doc.columnOrder.indexOf(columnId),
  };
  return { port, apply, doc: () => doc };
}

describe('createImeEditingSession — #7 Commit（生存確認→beforeRevision→SetCells→submit）', () => {
  it('直接入力→Enter で SetCells を submit（cell-level beforeRevision）', () => {
    const state = createDocState([insertRows(null, ['r0', 'r1'])]);
    const submitted: SetCellsOperation[] = [];
    const fake = createFakePort();
    const session = createImeEditingSession({
      document: state.port,
      port: fake.port,
      submit: (op) => {
        submitted.push(op);
      },
      layout: LAYOUT,
    });

    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    session.handleEvent({ type: 'input', value: '42', isComposing: false });
    expect(session.getEditingTarget()).toEqual({ rowId: row('r1'), columnId: col('col-0'), startRevision: 0 });

    session.handleEvent({ type: 'keydown', key: 'Enter', isComposing: false });

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toEqual({
      type: 'setCells',
      conflictPolicy: 'reject-overlap',
      changes: [{ rowId: row('r1'), columnId: col('col-0'), beforeRevision: 0, value: num(42) }],
    });
    expect(session.getEditingTarget()).toBeNull();
  });

  it('既存値編集（doubleClick）は startRevision に対象セルの lastChangedRevision を凍結', () => {
    const state = createDocState([
      insertRows(null, ['r0', 'r1']),
      setCells([{ rowId: row('r1'), columnId: col('col-0'), value: str('既存') }]), // rev2
    ]);
    const fake = createFakePort();
    const session = createImeEditingSession({ document: state.port, port: fake.port, submit: () => {}, layout: LAYOUT });

    session.handleEvent({ type: 'doubleClick', cell: { row: 1, col: 0 } });
    expect(session.getEditingTarget()).toEqual({ rowId: row('r1'), columnId: col('col-0'), startRevision: 2 });
    expect(fake.snap().value).toBe('既存'); // 既存値を textarea へ（mode='existing'）
  });
});

describe('createImeEditingSession — RC1（DD-052-1）: isWrapColumn 設定の解決', () => {
  it('isWrapColumn(columnId) が true を返す列では Alt+Enter で commit しない（col=0 を wrap 列として解決）', () => {
    const state = createDocState([insertRows(null, ['r0', 'r1'])]);
    const submitted: SetCellsOperation[] = [];
    const fake = createFakePort();
    const session = createImeEditingSession({
      document: state.port,
      port: fake.port,
      submit: (op) => {
        submitted.push(op);
      },
      layout: LAYOUT,
      isWrapColumn: (columnId) => columnId === col('col-0'),
    });

    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    session.handleEvent({ type: 'input', value: 'ab', isComposing: false });
    fake.browserSetValue('ab'); // 実ブラウザーは input 前に textarea.value を更新済み（insertNewlineAtCaret の前提）
    const consumed = session.handleEvent({ type: 'keydown', key: 'Enter', isComposing: false, altKey: true });

    expect(consumed).toBe(true); // InsertNewline を消費（preventDefault してよい）
    expect(submitted).toHaveLength(0);
    expect(session.getEditingTarget()).not.toBeNull(); // 編集継続（commit していない）
    expect(session.getDraft()).toBe('ab\n'); // port.insertNewlineAtCaret() の結果が draft へ反映される
    expect(fake.snap().value).toBe('ab\n');
  });

  it('isWrapColumn(columnId) が false を返す列では Alt+Enter が通常の Enter と同じ commit になる', () => {
    const state = createDocState([insertRows(null, ['r0', 'r1'])]);
    const submitted: SetCellsOperation[] = [];
    const fake = createFakePort();
    const session = createImeEditingSession({
      document: state.port,
      port: fake.port,
      submit: (op) => {
        submitted.push(op);
      },
      layout: LAYOUT,
      isWrapColumn: (columnId) => columnId === col('col-1'), // 編集対象は col-0 なので対象外
    });

    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    session.handleEvent({ type: 'input', value: 'ab', isComposing: false });
    session.handleEvent({ type: 'keydown', key: 'Enter', isComposing: false, altKey: true });

    expect(submitted).toHaveLength(1);
    expect(session.getEditingTarget()).toBeNull();
  });

  it('isWrapColumn 未指定なら Alt+Enter も通常の Enter と同じ commit（既存挙動を保つ）', () => {
    const state = createDocState([insertRows(null, ['r0', 'r1'])]);
    const submitted: SetCellsOperation[] = [];
    const fake = createFakePort();
    const session = createImeEditingSession({
      document: state.port,
      port: fake.port,
      submit: (op) => {
        submitted.push(op);
      },
      layout: LAYOUT,
    });

    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    session.handleEvent({ type: 'input', value: 'ab', isComposing: false });
    session.handleEvent({ type: 'keydown', key: 'Enter', isComposing: false, altKey: true });

    expect(submitted).toHaveLength(1);
  });
});

describe('createImeEditingSession — #4 RowId 再解決（AC4 行挿入で編集継続）', () => {
  it('編集中に上へ行挿入されると refreshPlacement が新 index で解決（同一 RowId 追従）', () => {
    const state = createDocState([insertRows(null, ['r0', 'r1'])]);
    const fake = createFakePort();
    const session = createImeEditingSession({ document: state.port, port: fake.port, submit: () => {}, layout: LAYOUT });
    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    session.handleEvent({ type: 'compositionstart' });
    session.handleEvent({ type: 'input', value: 'あ', isComposing: true });

    let resolved: [number, number] | undefined;
    const probe = (rowIndex: number, colIndex: number) => {
      resolved = [rowIndex, colIndex];
      return { x: 0, y: 0, width: 10, height: 10 };
    };
    session.refreshPlacement(probe);
    expect(resolved).toEqual([1, 0]); // r1 は index 1

    // B が先頭へ 1 行挿入 → r1 は index 2 へずれるが編集対象 RowId は不変。
    state.apply(insertRows(null, ['rNew']));
    session.noteServerUpdate(); // 行は生存 → IME 不変（退避しない）
    expect(session.getEditingTarget()).toEqual({ rowId: row('r1'), columnId: col('col-0'), startRevision: 0 });
    session.refreshPlacement(probe);
    expect(resolved).toEqual([2, 0]); // 新 index=2 へ追従（#4）
  });
});

describe('createImeEditingSession — Navigation Delete（空クリア・Codex P2 修正）', () => {
  it('Navigation で Delete を押すと BeginEdit 無しでも対象セルへ空値 SetCells を submit（no-op にしない）', () => {
    const state = createDocState([
      insertRows(null, ['r0', 'r1']),
      setCells([{ rowId: row('r1'), columnId: col('col-0'), value: str('消す') }]), // rev2
    ]);
    const submitted: SetCellsOperation[] = [];
    const fake = createFakePort();
    const session = createImeEditingSession({
      document: state.port,
      port: fake.port,
      submit: (op) => {
        submitted.push(op);
      },
      layout: LAYOUT,
    });

    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    expect(session.getEditingTarget()).toBeNull(); // Navigation（BeginEdit を経ていない）
    session.handleEvent({ type: 'keydown', key: 'Delete', isComposing: false });

    // effect.cell から対象を解決し beforeRevision（=対象セルの現行 rev2）を凍結して空値を submit する。
    expect(submitted).toEqual([
      {
        type: 'setCells',
        conflictPolicy: 'reject-overlap',
        changes: [{ rowId: row('r1'), columnId: col('col-0'), beforeRevision: 2, value: { kind: 'blank' } }],
      },
    ]);
  });
});

describe('createImeEditingSession — Presence activeCell は編集中 editingTarget を追う（Codex P1 の presence 部）', () => {
  it('編集中に上へ行挿入されても publish される activeCell/selection は同一 RowId を指す（stale index 由来にしない）', () => {
    const state = createDocState([insertRows(null, ['r0', 'r1'])]);
    const fake = createFakePort();
    const updates: PresenceUpdate[] = [];
    const session = createImeEditingSession({
      document: state.port,
      port: fake.port,
      submit: () => {},
      layout: LAYOUT,
      onPresenceChange: (u) => updates.push(u),
    });
    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    session.handleEvent({ type: 'compositionstart' });
    session.handleEvent({ type: 'input', value: 'あ', isComposing: true }); // editing r1（index 1）

    // B が先頭へ 1 行挿入 → 表示順 [rNew, r0, r1] で r1 は index 1→2 へずれる（index 1 は r0 を指すようになる）。
    state.apply(insertRows(null, ['rNew']));
    session.noteServerUpdate(); // 行は生存 → IME 不変

    // 何らかの編集イベントで presence を再評価させる。
    session.handleEvent({ type: 'compositionupdate', data: 'あ' });

    // 修正前は machine.activeCell(index 1) 由来で r0 を publish していた。修正後は editingTarget(RowId) 由来で r1 安定。
    const wrong = updates.find((u) => u.activeCell?.rowId === row('r0'));
    expect(wrong, 'stale index 由来の誤った activeCell(r0) を publish しない').toBeUndefined();
    const last = updates[updates.length - 1];
    expect(last.activeCell).toEqual({ rowId: row('r1'), columnId: col('col-0') });
    expect(last.editingCell).toEqual({ rowId: row('r1'), columnId: col('col-0') });
    expect(last.selectionRanges).toEqual([
      { startRowId: row('r1'), startColumnId: col('col-0'), endRowId: row('r1'), endColumnId: col('col-0') },
    ]);
  });
});

describe('createImeEditingSession — Presence（editingCell 発行・task 4）', () => {
  it('編集開始で editingCell を発行し、確定で解除する', () => {
    const state = createDocState([insertRows(null, ['r0', 'r1', 'r2'])]);
    const fake = createFakePort();
    const updates: Array<{ active?: unknown; editing?: unknown }> = [];
    const session = createImeEditingSession({
      document: state.port,
      port: fake.port,
      submit: () => {},
      layout: LAYOUT,
      onPresenceChange: (u) => updates.push({ active: u.activeCell, editing: u.editingCell }),
    });
    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    session.handleEvent({ type: 'input', value: 'x', isComposing: false }); // BeginEdit → editingCell 発行

    const editingUpdate = updates.find((u) => u.editing !== undefined);
    expect(editingUpdate?.editing).toEqual({ rowId: row('r1'), columnId: col('col-0') });

    session.handleEvent({ type: 'keydown', key: 'Enter', isComposing: false }); // commit → editingCell 解除
    expect(updates[updates.length - 1].editing).toBeUndefined();
  });
});

describe('createImeEditingSession — #8 IME 不変（サーバー更新は Document State のみ）', () => {
  it('編集中セルへのリモート更新（AC2）で textarea/draft/selection/RowId/composition が不変', () => {
    const state = createDocState([
      insertRows(null, ['r0', 'r1']),
      setCells([{ rowId: row('r1'), columnId: col('col-0'), value: str('old') }]), // rev2
    ]);
    const fake = createFakePort();
    const session = createImeEditingSession({ document: state.port, port: fake.port, submit: () => {}, layout: LAYOUT });

    // (1,0) で日本語変換を開始（startRevision=2 が凍結される）。
    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    session.handleEvent({ type: 'compositionstart' });
    session.handleEvent({ type: 'input', value: 'かん', isComposing: true });
    fake.browserSetValue('かん'); // browser が composition 中に textarea.value を設定
    fake.port.setSelectionRange(2, 2);

    const before = {
      target: session.getEditingTarget(),
      draft: session.getDraft(),
      composing: session.isComposing(),
      phase: session.getPhase(),
      active: session.getActiveCell(),
      snap: fake.snap(),
      setValueCalls: fake.calls.setValue,
      setSelCalls: fake.calls.setSelectionRange,
    };
    expect(before.composing).toBe(true);
    expect(before.phase).toBe('Composing');
    expect(before.draft).toBe('かん');

    // B が同一セルを確定（committed rev3）。Document State は進むが IME は不変であるべき。
    state.apply(setCells([{ rowId: row('r1'), columnId: col('col-0'), value: str('B-wins') }])); // rev3
    session.noteServerUpdate();

    expect(session.getEditingTarget()).toEqual(before.target); // editing RowId/ColumnId/startRevision 不変
    expect(session.getDraft()).toBe('かん'); // draft 不変
    expect(session.isComposing()).toBe(true); // composition state 不変
    expect(session.getPhase()).toBe('Composing');
    expect(session.getActiveCell()).toEqual(before.active);
    expect(fake.snap().value).toBe('かん'); // textarea.value 不変（サーバー値 'B-wins' を入れない・#8）
    expect(fake.snap().selStart).toBe(before.snap.selStart);
    expect(fake.snap().selEnd).toBe(before.snap.selEnd);
    expect(fake.calls.setValue).toBe(before.setValueCalls); // noteServerUpdate は setValue を呼ばない
    expect(fake.calls.setSelectionRange).toBe(before.setSelCalls);

    // #9: 競合検知は committed から算出され true（IME には触れずインジケーターだけ）。
    expect(session.isConflicting()).toBe(true);
  });

  it('リモート更新が別セルなら競合しない（#9・セル単位）', () => {
    const state = createDocState([insertRows(null, ['r0', 'r1'])]);
    const fake = createFakePort();
    const session = createImeEditingSession({ document: state.port, port: fake.port, submit: () => {}, layout: LAYOUT });
    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    session.handleEvent({ type: 'compositionstart' });
    session.handleEvent({ type: 'input', value: 'x', isComposing: true });

    state.apply(setCells([{ rowId: row('r1'), columnId: col('col-1'), value: str('other') }])); // 別セル col-1
    session.noteServerUpdate();
    expect(session.isConflicting()).toBe(false); // 別セル更新は競合にしない
  });
});

describe('createImeEditingSession — K4 編集対象行のリモート削除（DD-021-2・親④/D7）', () => {
  it('変換中に対象行が削除されても draft/textarea/composition を破壊せず編集継続・行消失インジケーターを出す', () => {
    const state = createDocState([insertRows(null, ['r0', 'r1'])]);
    const submitted: SetCellsOperation[] = [];
    const fake = createFakePort();
    const session = createImeEditingSession({
      document: state.port,
      port: fake.port,
      submit: (op) => {
        submitted.push(op);
      },
      layout: LAYOUT,
    });

    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    session.handleEvent({ type: 'compositionstart' });
    session.handleEvent({ type: 'input', value: 'メモ', isComposing: true });
    fake.browserSetValue('メモ');
    expect(session.getEditingTarget()).not.toBeNull();
    const before = {
      target: session.getEditingTarget(),
      setValueCalls: fake.calls.setValue,
    };

    // B が編集対象行 r1 を削除（リモート DeleteRows が committed へ入る）。
    state.apply({ type: 'deleteRows', rowIds: [row('r1')] });
    session.noteServerUpdate();

    // K4: 編集は継続（editingTarget 保持）・draft/composition/textarea 非破壊・退避はまだ発生しない。
    expect(session.getEditingTarget()).toEqual(before.target);
    expect(session.getDraft()).toBe('メモ');
    expect(session.isComposing()).toBe(true);
    expect(session.getPhase()).toBe('Composing');
    expect(fake.snap().value).toBe('メモ'); // textarea 値はサーバー削除で変えない
    expect(fake.calls.setValue).toBe(before.setValueCalls); // noteServerUpdate は setValue を呼ばない
    expect(session.divertedDrafts()).toHaveLength(0); // commit までは退避しない
    // 行消失インジケーター（K4）が立ち、#9 セル競合とは独立。
    expect(session.isTargetLost()).toBe(true);
    expect(fake.snap().conflict).toBe(true); // 行消失も competing 枠として paint
  });

  it('K4: 行消失後に commit すると target-deleted で退避（ドラフト保持＝reject 通知）・無効 RowId へは submit しない', () => {
    const state = createDocState([insertRows(null, ['r0', 'r1'])]);
    const submitted: SetCellsOperation[] = [];
    const fake = createFakePort();
    const session = createImeEditingSession({
      document: state.port,
      port: fake.port,
      submit: (op) => {
        submitted.push(op);
      },
      layout: LAYOUT,
    });
    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    session.handleEvent({ type: 'compositionstart' });
    session.handleEvent({ type: 'input', value: 'メモ', isComposing: true });

    // リモート削除 → 編集継続。
    state.apply({ type: 'deleteRows', rowIds: [row('r1')] });
    session.noteServerUpdate();
    expect(session.getEditingTarget()).not.toBeNull();

    // 利用者が commit（変換確定 → Enter）。compositionend の Enter と commit の Enter を区別するため keyup を挟む。
    // ここで初めて退避（ドラフト保持）・submit はしない。
    session.handleEvent({ type: 'compositionend', data: 'メモ' });
    session.handleEvent({ type: 'input', value: 'メモ', isComposing: false });
    session.handleEvent({ type: 'keyup', key: 'Enter', isComposing: false });
    session.handleEvent({ type: 'keydown', key: 'Enter', isComposing: false });

    expect(submitted).toHaveLength(0); // 無効 RowId へは submit しない
    expect(session.divertedDrafts().map((d) => d.draft)).toContain('メモ');
    expect(session.divertedDrafts().every((d) => d.reason === 'target-deleted')).toBe(true);
  });

  it('削除後に Enter で Commit しても無効 RowId へは submit せず退避（防御・非 IME）', () => {
    const state = createDocState([insertRows(null, ['r0', 'r1'])]);
    const submitted: SetCellsOperation[] = [];
    const fake = createFakePort();
    const session = createImeEditingSession({
      document: state.port,
      port: fake.port,
      submit: (op) => {
        submitted.push(op);
      },
      layout: LAYOUT,
    });
    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    session.handleEvent({ type: 'input', value: '手動', isComposing: false });
    // noteServerUpdate を呼ぶ前に削除が committed へ入ったまま Enter（Commit）した場合。
    state.apply({ type: 'deleteRows', rowIds: [row('r1')] });
    session.handleEvent({ type: 'keydown', key: 'Enter', isComposing: false });

    expect(submitted).toHaveLength(0);
    expect(session.divertedDrafts().map((d) => d.draft)).toContain('手動');
  });

  it('K4: 退避は onDivert で通知される（Fable P2: サイレント退避の可視化・公開 rejected への写像材料）', () => {
    const state = createDocState([insertRows(null, ['r0', 'r1'])]);
    const fake = createFakePort();
    const diverted: string[] = [];
    const session = createImeEditingSession({
      document: state.port,
      port: fake.port,
      submit: () => {},
      layout: LAYOUT,
      onDivert: (d) => {
        diverted.push(`${String(d.rowId)}:${d.draft}:${d.reason}`);
      },
    });
    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    session.handleEvent({ type: 'input', value: '通知', isComposing: false });
    state.apply({ type: 'deleteRows', rowIds: [row('r1')] });
    session.handleEvent({ type: 'keydown', key: 'Enter', isComposing: false });

    expect(diverted).toEqual(['r1:通知:target-deleted']);
  });

  it('K4: noteServerUpdate の onChange は観測状態（競合/行消失）が変わったときだけ発火する（Fable P3: 毎 op の scroll-follow 引き戻し防止）', () => {
    const state = createDocState([insertRows(null, ['r0', 'r1'])]);
    const fake = createFakePort();
    let onChangeCalls = 0;
    const session = createImeEditingSession({
      document: state.port,
      port: fake.port,
      submit: () => {},
      layout: LAYOUT,
      onChange: () => {
        onChangeCalls += 1;
      },
    });
    session.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    session.handleEvent({ type: 'input', value: 'x', isComposing: false });
    const base = onChangeCalls;

    // 無関係セル（r0）へのリモート SetCells が編集中に連続で届く → 観測状態は不変 → onChange は発火しない。
    state.apply(setCells([{ rowId: row('r0'), columnId: col('col-0'), value: str('a') }]));
    session.noteServerUpdate();
    state.apply(setCells([{ rowId: row('r0'), columnId: col('col-0'), value: str('b') }]));
    session.noteServerUpdate();
    expect(onChangeCalls).toBe(base);

    // 対象行の削除（targetLost false→true）で 1 回だけ発火し、以後の無関係 op では再発火しない。
    state.apply({ type: 'deleteRows', rowIds: [row('r1')] });
    session.noteServerUpdate();
    expect(onChangeCalls).toBe(base + 1);
    state.apply(setCells([{ rowId: row('r0'), columnId: col('col-0'), value: str('c') }]));
    session.noteServerUpdate();
    expect(onChangeCalls).toBe(base + 1);
  });
});

describe('createImeEditingSession — #8 実 ClientSession の rollback/replay 前後で不変', () => {
  function baseConfig(transport: RecordingTransport): SessionConfig {
    return {
      clientId: 'client-a',
      userId: 'user-a',
      displayName: 'A',
      documentId: createDocumentId('demo-doc'),
      columnOrder: [createColumnId('col-0'), createColumnId('col-1'), createColumnId('col-2')],
      transport,
      clock: createManualClock(),
      idGenerator: createCounterIdGenerator('a'),
    };
  }
  const welcome = (currentRevision: number): ServerMessage => ({
    type: 'welcome',
    sessionId: 'conn-1',
    colorKey: '0',
    currentRevision,
    capabilities: { protocolVersion: 1 },
  });

  it('リモート Operation 適用（rollback/replay）中も IME 状態が不変', () => {
    const transport = new RecordingTransport();
    const session = new ClientSession(baseConfig(transport));
    session.start();
    transport.receive(welcome(2));
    transport.receive(
      operationsMessage([
        serverEnvelope({ revision: 1, operationId: 'op-ins', operation: insertRows(null, ['r0', 'r1']) }),
        serverEnvelope({
          revision: 2,
          operationId: 'op-set',
          operation: setCells([{ rowId: row('r1'), columnId: col('col-0'), value: str('old') }]),
        }),
      ]),
    );

    const docPort: EditingDocumentPort = {
      getCommittedDocument: () => session.committedDocument,
      displayText: (rowId, columnId) =>
        cellScalarToDisplay(getCell(session.viewDocument, rowId, columnId)?.value ?? { kind: 'blank' }),
      rowIdAt: (i) => displayRowOrder(session.viewDocument)[i],
      colIdAt: (i) => session.viewDocument.columnOrder[i],
      rowIndexOf: (rowId) => displayRowOrder(session.viewDocument).indexOf(rowId),
      colIndexOf: (columnId) => session.viewDocument.columnOrder.indexOf(columnId),
    };
    const fake = createFakePort();
    const ime = createImeEditingSession({
      document: docPort,
      port: fake.port,
      submit: (op) => session.submitLocalOperation(op),
      layout: LAYOUT,
    });

    // A はローカル pending を1件持つ（別セル col-1）→ rollback/replay を非自明にする。
    ime.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 0, col: 1 } });
    ime.handleEvent({ type: 'input', value: 'pend', isComposing: false });
    ime.handleEvent({ type: 'keydown', key: 'Enter', isComposing: false }); // submit pending on (r0,col-1)
    expect(session.pendingCount).toBe(1);

    // (r1,col-0) で日本語変換中にする。
    ime.handleEvent({ type: 'pointerdown', target: 'cell', cell: { row: 1, col: 0 } });
    ime.handleEvent({ type: 'compositionstart' });
    ime.handleEvent({ type: 'input', value: 'へんかん', isComposing: true });
    fake.browserSetValue('へんかん');
    const before = {
      target: ime.getEditingTarget(),
      draft: ime.getDraft(),
      composing: ime.isComposing(),
      phase: ime.getPhase(),
      value: fake.snap().value,
      setValueCalls: fake.calls.setValue,
    };
    expect(before.target).toEqual({ rowId: row('r1'), columnId: col('col-0'), startRevision: 2 });

    // B が (r1,col-0) を確定（rev3）→ ClientSession が committed 適用＋pending rollback/replay。
    transport.receive(
      operationsMessage([
        serverEnvelope({
          revision: 3,
          operationId: 'op-b',
          clientId: 'client-b',
          operation: setCells([{ rowId: row('r1'), columnId: col('col-0'), value: str('B-wins') }]),
        }),
      ]),
    );
    ime.noteServerUpdate();

    // Document State は B-wins（committed 反映）。
    expect(getCell(session.committedDocument, row('r1'), col('col-0'))?.value).toEqual(str('B-wins'));
    // IME はすべて不変（#8）。
    expect(ime.getEditingTarget()).toEqual(before.target);
    expect(ime.getDraft()).toBe('へんかん');
    expect(ime.isComposing()).toBe(true);
    expect(ime.getPhase()).toBe('Composing');
    expect(fake.snap().value).toBe('へんかん');
    expect(fake.calls.setValue).toBe(before.setValueCalls);
    expect(ime.isConflicting()).toBe(true);
  });
});
