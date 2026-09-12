// DD-024 単独グリッドモード backend の unit（DOM 非依存）。
//
// 検証: 初期注入の反映（AC2）・setData 再注入（AC2 決定③）・SetCells 確定で cell-commit 発火（AC3）・
// 構造Op は cell-commit 非対象・session 面 trivial 値（AC6 の off 時挙動の下支え）。

import { describe, expect, it, vi } from 'vitest';

import { createRowId, createColumnId } from '@nanairo-sheet/types';
import type { SetCellsOperation, InsertRowsOperation } from '@nanairo-sheet/core';

import { createStandaloneSession } from './standalone-session';
import type { GridCellCommitChange } from './index';

const COLUMNS = ['col-a', 'col-b'];

function setCells(cells: Array<{ rowId: string; columnId: string; value: string }>): SetCellsOperation {
  return {
    type: 'setCells',
    conflictPolicy: 'reject-overlap',
    changes: cells.map((c) => ({
      rowId: createRowId(c.rowId),
      columnId: createColumnId(c.columnId),
      value: { kind: 'string', value: c.value },
    })),
  };
}

describe('createStandaloneSession: 初期注入（決定③）', () => {
  it('initialData の行・セル値が view/committed に反映される', () => {
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      initialData: {
        rows: [
          { rowId: 'r1', cells: { 'col-a': 'hello', 'col-b': '123' } },
          { rowId: 'r2', cells: { 'col-a': 'world' } },
        ],
      },
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: () => {},
    });
    session.start();
    expect(session.view.rowAxis.count()).toBe(2);
    expect(session.view.cellDisplay(createRowId('r1'), createColumnId('col-a'))).toBe('hello');
    // 数値文字列は parseCellInput で number へ解釈され、表示は '123'（round-trip）。
    expect(session.view.cellDisplay(createRowId('r1'), createColumnId('col-b'))).toBe('123');
    expect(session.view.cellDisplay(createRowId('r2'), createColumnId('col-a'))).toBe('world');
  });

  it('RC12（DD-052-2）: stringColumns 指定列は数値/日付に見えても string のまま保持する', () => {
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      stringColumns: ['col-b'],
      initialData: {
        rows: [{ rowId: 'r1', cells: { 'col-a': '123', 'col-b': '09012345678' } }],
      },
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: () => {},
    });
    session.start();
    // stringColumns 対象外（col-a）は従来どおり number へ round-trip する。
    expect(session.view.cellDisplay(createRowId('r1'), createColumnId('col-a'))).toBe('123');
    // stringColumns 対象（col-b）は先頭ゼロを含め文字列のまま。
    expect(session.view.cellDisplay(createRowId('r1'), createColumnId('col-b'))).toBe('09012345678');
  });

  it('columnOrder 外の列は静かにスキップする（ApplyError で全体を落とさない）', () => {
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      initialData: { rows: [{ rowId: 'r1', cells: { 'col-a': 'ok', 'col-zzz': 'ignored' } }] },
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: () => {},
    });
    session.start();
    expect(session.view.cellDisplay(createRowId('r1'), createColumnId('col-a'))).toBe('ok');
  });

  it('rowId 重複は先着で dedupe する', () => {
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      initialData: {
        rows: [
          { rowId: 'r1', cells: { 'col-a': 'first' } },
          { rowId: 'r1', cells: { 'col-a': 'dup' } },
        ],
      },
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: () => {},
    });
    session.start();
    expect(session.view.rowAxis.count()).toBe(1);
    expect(session.view.cellDisplay(createRowId('r1'), createColumnId('col-a'))).toBe('first');
  });
});

describe('createStandaloneSession: RC3（DD-052-3）行データ指定のセル単位 readOnly', () => {
  it('行の readOnlyColumns に含まれるセルだけ isCellReadOnly=true・hasAnyCellReadOnly=true', () => {
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      initialData: {
        rows: [
          { rowId: 'r1', cells: { 'col-a': 'x' }, readOnlyColumns: ['col-a'] },
          { rowId: 'r2', cells: { 'col-a': 'y' } },
        ],
      },
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: () => {},
    });
    session.start();
    expect(session.hasAnyCellReadOnly()).toBe(true);
    expect(session.isCellReadOnly('r1', 'col-a')).toBe(true);
    expect(session.isCellReadOnly('r1', 'col-b')).toBe(false); // 同じ行でも対象外の列は false
    expect(session.isCellReadOnly('r2', 'col-a')).toBe(false); // 他の行は対象外
  });

  it('未指定・空配列なら hasAnyCellReadOnly=false（現行挙動）', () => {
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      initialData: { rows: [{ rowId: 'r1', cells: { 'col-a': 'x' }, readOnlyColumns: [] }] },
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: () => {},
    });
    session.start();
    expect(session.hasAnyCellReadOnly()).toBe(false);
    expect(session.isCellReadOnly('r1', 'col-a')).toBe(false);
  });

  it('未知列は静かにスキップする（cells と同じ扱い）', () => {
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      initialData: { rows: [{ rowId: 'r1', readOnlyColumns: ['col-zzz'] }] },
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: () => {},
    });
    session.start();
    expect(session.hasAnyCellReadOnly()).toBe(false);
  });

  it('setData で丸ごと再構築される（旧行の指定を引きずらない・決定③と同じ扱い）', () => {
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      initialData: { rows: [{ rowId: 'r1', cells: { 'col-a': 'x' }, readOnlyColumns: ['col-a'] }] },
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: () => {},
    });
    session.start();
    expect(session.isCellReadOnly('r1', 'col-a')).toBe(true);
    session.setData({ rows: [{ rowId: 'r1', cells: { 'col-a': 'y' } }] }); // readOnlyColumns 無指定で再注入
    expect(session.isCellReadOnly('r1', 'col-a')).toBe(false);
    expect(session.hasAnyCellReadOnly()).toBe(false);
  });
});

describe('createStandaloneSession: cell-commit 通知（決定②）', () => {
  it('SetCells 確定で value/previousValue 付き cell-commit が発火する', () => {
    const commits: GridCellCommitChange[][] = [];
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      initialData: { rows: [{ rowId: 'r1', cells: { 'col-a': 'old' } }] },
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: (changes) => commits.push([...changes]),
    });
    session.start();
    session.session.submitLocalOperation(setCells([{ rowId: 'r1', columnId: 'col-a', value: 'new' }]));
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual([{ rowId: 'r1', columnId: 'col-a', value: 'new', previousValue: 'old' }]);
    expect(session.view.cellDisplay(createRowId('r1'), createColumnId('col-a'))).toBe('new');
  });

  it('未書込セルへの確定は previousValue が空文字', () => {
    const commits: GridCellCommitChange[][] = [];
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      initialData: { rows: [{ rowId: 'r1' }] },
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: (changes) => commits.push([...changes]),
    });
    session.start();
    session.session.submitLocalOperation(setCells([{ rowId: 'r1', columnId: 'col-b', value: 'x' }]));
    expect(commits[0]).toEqual([{ rowId: 'r1', columnId: 'col-b', value: 'x', previousValue: '' }]);
  });

  it('構造Op（insertRows）は cell-commit を発火しない', () => {
    const onCellCommit = vi.fn();
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      initialData: { rows: [{ rowId: 'r1' }] },
      rowHeight: 22,
      colWidth: 80,
      onCellCommit,
    });
    session.start();
    const insert: InsertRowsOperation = {
      type: 'insertRows',
      afterRowId: createRowId('r1'),
      rows: [{ rowId: createRowId('r2') }],
    };
    session.session.submitLocalOperation(insert);
    session.view.flush(); // 構造 dirty を消費して rowAxis を再構築する
    expect(onCellCommit).not.toHaveBeenCalled();
    expect(session.view.rowAxis.count()).toBe(2);
  });
});

describe('createStandaloneSession: setData 再注入（決定③）', () => {
  it('文書を丸ごと差し替え、行数・値が新データになる', () => {
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      initialData: { rows: [{ rowId: 'r1', cells: { 'col-a': 'v1' } }] },
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: () => {},
    });
    session.start();
    session.setData({ rows: [{ rowId: 'x1', cells: { 'col-a': 'A' } }, { rowId: 'x2', cells: { 'col-b': 'B' } }] });
    // flush して Render State を新文書へ整合させる（markFullRebuild を消費）。
    session.view.flush();
    expect(session.view.rowAxis.count()).toBe(2);
    expect(session.view.cellDisplay(createRowId('x1'), createColumnId('col-a'))).toBe('A');
    expect(session.view.cellDisplay(createRowId('x2'), createColumnId('col-b'))).toBe('B');
    // 旧行は消えている。
    expect(session.view.rowIndexOf(createRowId('r1'))).toBe(-1);
  });

  it('RC12（DD-052-2）: setData 再注入でも stringColumns 指定列は型変換されない', () => {
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      stringColumns: ['col-a'],
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: () => {},
    });
    session.start();
    session.setData({ rows: [{ rowId: 'r1', cells: { 'col-a': '09012345678' } }] });
    session.view.flush();
    expect(session.view.cellDisplay(createRowId('r1'), createColumnId('col-a'))).toBe('09012345678');
  });

  it('revision は空注入でも後退しない（Codex[P2]・単調増加不変）', () => {
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      initialData: { rows: [{ rowId: 'r1', cells: { 'col-a': 'v1' } }] },
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: () => {},
    });
    session.start();
    session.session.submitLocalOperation(setCells([{ rowId: 'r1', columnId: 'col-a', value: 'v2' }]));
    const beforeEmpty = session.session.committedDocument.revision;
    expect(beforeEmpty).toBeGreaterThan(0);
    session.setData({ rows: [] }); // 空注入
    expect(session.session.committedDocument.revision).toBeGreaterThan(beforeEmpty);
  });
});

describe('createStandaloneSession: session 面 trivial 値（AC6 下支え）', () => {
  it('offline・pending 0・presence 空・bootstrap 0 を返す', () => {
    const session = createStandaloneSession({
      columnOrder: COLUMNS,
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: () => {},
    });
    expect(session.session.isOnline).toBe(false);
    expect(session.session.isStopped).toBe(false);
    expect(session.session.pendingCount).toBe(0);
    expect(session.session.conflictQueue).toHaveLength(0);
    expect(session.session.knownPresences()).toHaveLength(0);
    expect(session.session.bootstrapRevision).toBe(0);
    expect(session.session.appliedServerOpCount).toBe(0);
    // no-op 群が例外を投げない。
    expect(() => {
      session.session.tick();
      session.session.sendHeartbeat();
      session.session.sendPresence({ activeCell: undefined, selectionRanges: [] });
    }).not.toThrow();
  });
});
