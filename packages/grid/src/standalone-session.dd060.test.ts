// DD-060 unit: 単独モードの行データで付けるセルの状態表示（cellStatus）の保持と付け外し（DOM 非依存）。
//
// 検証: initialData/setData で作り直す（AC5）・setRows は渡した行だけ置き換え、省略は保持・{} で消す（AC2）・
// 状態だけの変更は値・Undo に触れず再描画だけ要求する（AC2/AC4）・未知列は静かにスキップ、不正な level は無視して通知（AC7）。

import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId } from '@nanairo-sheet/types';

import { createStandaloneSession } from './standalone-session';
import type { GridCellCommitChange, GridStandaloneData } from './index';

const COLUMNS = ['col-a', 'col-b'];

function session(initialData?: GridStandaloneData, invalid: string[] = [], commits: GridCellCommitChange[][] = []) {
  const s = createStandaloneSession({
    columnOrder: COLUMNS,
    ...(initialData !== undefined ? { initialData } : {}),
    rowHeight: 22,
    colWidth: 80,
    onCellCommit: (changes) => commits.push([...changes]),
    onCellStatusInvalid: (message) => invalid.push(message),
  });
  s.start();
  s.view.flush();
  return s;
}

describe('DD-060: cellStatus の初期注入と setData（AC5）', () => {
  it('initialData の cellStatus がセル単位で引ける（未指定のセル・行は undefined）', () => {
    const s = session({
      rows: [
        { rowId: 'r1', cells: { 'col-a': '123456789' }, cellStatus: { 'col-a': { level: 'error', message: '8桁を超えています' } } },
        { rowId: 'r2', cellStatus: { 'col-b': { level: 'warning' } } },
        { rowId: 'r3', cells: { 'col-a': 'x' } },
      ],
    });
    expect(s.hasAnyCellStatus()).toBe(true);
    expect(s.cellStatusOf('r1', 'col-a')).toEqual({ level: 'error', message: '8桁を超えています' });
    expect(s.cellStatusOf('r1', 'col-b')).toBeUndefined();
    // 空のセルにも付けられる（値の有無によらない）。message は省略できる。
    expect(s.cellStatusOf('r2', 'col-b')).toEqual({ level: 'warning' });
    expect(s.cellStatusOf('r3', 'col-a')).toBeUndefined();
    expect([...(s.cellStatusRow('r1') ?? new Map()).keys()]).toEqual(['col-a']);
    expect(s.cellStatusRow('r3')).toBeUndefined();
  });

  it('未指定・空オブジェクトなら hasAnyCellStatus=false', () => {
    const s = session({ rows: [{ rowId: 'r1', cells: { 'col-a': 'x' }, cellStatus: {} }, { rowId: 'r2' }] });
    expect(s.hasAnyCellStatus()).toBe(false);
    expect(s.cellStatusRow('r1')).toBeUndefined();
  });

  it('setData で丸ごと作り直す（cellStatus を省略した再注入では旧状態を引きずらない）', () => {
    const s = session({ rows: [{ rowId: 'r1', cells: { 'col-a': 'x' }, cellStatus: { 'col-a': { level: 'error' } } }] });
    s.setData({ rows: [{ rowId: 'r1', cells: { 'col-a': 'y' } }] });
    expect(s.cellStatusOf('r1', 'col-a')).toBeUndefined();
    expect(s.hasAnyCellStatus()).toBe(false);
    s.setData({ rows: [{ rowId: 'r1', cellStatus: { 'col-b': { level: 'warning', message: 'w' } } }] });
    expect(s.cellStatusOf('r1', 'col-b')).toEqual({ level: 'warning', message: 'w' });
  });
});

describe('DD-060: setRows での付け外し（AC2）', () => {
  it('cellStatus を渡した行だけ丸ごと置き換え、省略した setRows では保持し、{} で消す', () => {
    const s = session({ rows: [{ rowId: 'r1', cells: { 'col-a': '1' } }, { rowId: 'r2', cells: { 'col-a': '2' } }] });
    s.setRows([{ rowId: 'r1', cellStatus: { 'col-a': { level: 'error', message: 'e' }, 'col-b': { level: 'warning' } } }]);
    expect(s.cellStatusOf('r1', 'col-a')).toEqual({ level: 'error', message: 'e' });
    expect(s.cellStatusOf('r1', 'col-b')).toEqual({ level: 'warning' });

    // 丸ごと置き換え（col-b は消え、col-a は新しい状態）。
    s.setRows([{ rowId: 'r1', cellStatus: { 'col-a': { level: 'warning', message: 'w' } } }]);
    expect(s.cellStatusOf('r1', 'col-a')).toEqual({ level: 'warning', message: 'w' });
    expect(s.cellStatusOf('r1', 'col-b')).toBeUndefined();

    // cells だけの setRows（OFIC の小計の差し替えと同じ形）では保持する。
    s.setRows([{ rowId: 'r1', cells: { 'col-b': '99' } }, { rowId: 'r2', cells: { 'col-a': '3' } }]);
    expect(s.cellStatusOf('r1', 'col-a')).toEqual({ level: 'warning', message: 'w' });

    // {} で消す。
    s.setRows([{ rowId: 'r1', cellStatus: {} }]);
    expect(s.cellStatusOf('r1', 'col-a')).toBeUndefined();
    expect(s.hasAnyCellStatus()).toBe(false);
  });

  it('状態だけの変更は値・Undo 対象（changes）・cell-commit に触れず、再描画だけを要求する', () => {
    const commits: GridCellCommitChange[][] = [];
    const s = session({ rows: [{ rowId: 'r1', cells: { 'col-a': '123' } }] }, [], commits);
    expect(s.view.isDirty()).toBe(false);
    const result = s.setRows([{ rowId: 'r1', cellStatus: { 'col-a': { level: 'error' } } }]);
    expect(result.changes).toEqual([]);
    expect(result.insertedRowCount).toBe(0);
    expect(result.cellStatusUpdated).toBe(true);
    expect(s.view.isDirty()).toBe(true);
    expect(s.view.hasStructuralDirty()).toBe(false); // 行 Axis は作り直さない（可視セルの再描画だけ）
    expect(s.view.cellDisplay(createRowId('r1'), createColumnId('col-a'))).toBe('123');
    expect(commits).toEqual([]);
  });

  it('cellStatus を渡さない setRows は cellStatusUpdated=false', () => {
    const s = session({ rows: [{ rowId: 'r1', cells: { 'col-a': '1' } }] });
    expect(s.setRows([{ rowId: 'r1', cells: { 'col-a': '2' } }]).cellStatusUpdated).toBe(false);
  });

  it('新規行（未知の RowId）にも付けられる', () => {
    const s = session({ rows: [{ rowId: 'r1' }] });
    s.setRows([{ rowId: 'r9', cells: { 'col-a': 'new' }, cellStatus: { 'col-a': { level: 'error' } } }]);
    expect(s.cellStatusOf('r9', 'col-a')).toEqual({ level: 'error' });
  });

  it('削除済みの RowId への指定は無視する（値と同じ扱い）', () => {
    const s = session({ rows: [{ rowId: 'r1' }, { rowId: 'r2' }] });
    s.session.submitLocalOperation({ type: 'deleteRows', rowIds: [createRowId('r2')] });
    const result = s.setRows([{ rowId: 'r2', cellStatus: { 'col-a': { level: 'error' } } }]);
    expect(result.cellStatusUpdated).toBe(false);
    expect(s.cellStatusOf('r2', 'col-a')).toBeUndefined();
  });

  it('利用者の確定（SetCells）では状態は消えない（consumer が検証し直して付け外しする）', () => {
    const s = session({ rows: [{ rowId: 'r1', cells: { 'col-a': '123456789' }, cellStatus: { 'col-a': { level: 'error' } } }] });
    s.session.submitLocalOperation({
      type: 'setCells',
      conflictPolicy: 'reject-overlap',
      changes: [{ rowId: createRowId('r1'), columnId: createColumnId('col-a'), value: { kind: 'number', value: 1 } }],
    });
    expect(s.cellStatusOf('r1', 'col-a')).toEqual({ level: 'error' });
  });
});

describe('DD-060: 不正な指定（AC7）', () => {
  it('未知列は静かにスキップする（通知しない）', () => {
    const invalid: string[] = [];
    const s = session({ rows: [{ rowId: 'r1', cellStatus: { 'col-zzz': { level: 'error' } } }] }, invalid);
    expect(s.hasAnyCellStatus()).toBe(false);
    expect(invalid).toEqual([]);
  });

  it('level が error/warning 以外のセルは無視し、呼び出しごとに1回だけ通知する', () => {
    const invalid: string[] = [];
    const s = session(
      {
        rows: [
          {
            rowId: 'r1',
            cellStatus: {
              'col-a': { level: 'info' as 'error' },
              'col-b': { level: 'error' },
            },
          },
          { rowId: 'r2', cellStatus: { 'col-a': null as unknown as { level: 'error' } } },
        ],
      },
      invalid,
    );
    expect(s.cellStatusOf('r1', 'col-a')).toBeUndefined();
    expect(s.cellStatusOf('r1', 'col-b')).toEqual({ level: 'error' });
    expect(s.cellStatusOf('r2', 'col-a')).toBeUndefined();
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain('r1/col-a');
    expect(invalid[0]).toContain('r2/col-a');

    s.setRows([{ rowId: 'r1', cellStatus: { 'col-a': { level: 'fatal' as 'error' } } }]);
    expect(invalid).toHaveLength(2);
    expect(s.cellStatusOf('r1', 'col-a')).toBeUndefined();
  });

  it('cellStatus 自体がオブジェクトでない行は例外にせず、その行の状態を保って通知する（Codex P2）', () => {
    const invalid: string[] = [];
    const s = session(
      { rows: [{ rowId: 'r1', cells: { 'col-a': '1' }, cellStatus: { 'col-a': { level: 'error' } } }] },
      invalid,
    );
    const asStatus = (value: unknown) => value as Record<string, { level: 'error' }>;
    // 新規行（文書へ挿入される）と既存行の両方に不正値を渡しても、例外にせず値と行の追加は通常どおり適用する。
    const result = s.setRows([
      { rowId: 'r1', cellStatus: asStatus(null) },
      { rowId: 'r9', cells: { 'col-a': 'new' }, cellStatus: asStatus('error') },
    ]);
    expect(result.insertedRowCount).toBe(1);
    expect(result.cellStatusUpdated).toBe(false);
    expect(s.cellStatusOf('r1', 'col-a')).toEqual({ level: 'error' }); // 前の状態を保つ
    expect(s.cellStatusRow('r9')).toBeUndefined();
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain('r1');
    expect(invalid[0]).toContain('r9');
    // 配列も Record ではないので同じ扱い。setData/initialData でも例外にしない。
    expect(() => s.setData({ rows: [{ rowId: 'r1', cellStatus: asStatus([{ level: 'error' }]) }] })).not.toThrow();
    expect(s.hasAnyCellStatus()).toBe(false);
    expect(invalid).toHaveLength(2);
  });

  it('文字列でない message は落とし、level だけを保つ', () => {
    const s = session({ rows: [{ rowId: 'r1', cellStatus: { 'col-a': { level: 'error', message: 42 as unknown as string } } }] });
    expect(s.cellStatusOf('r1', 'col-a')).toEqual({ level: 'error' });
  });

  it('渡したオブジェクトを後から書き換えても保持している状態は変わらない', () => {
    const status = { level: 'error' as 'error' | 'warning', message: 'before' };
    const s = session({ rows: [{ rowId: 'r1', cellStatus: { 'col-a': status } }] });
    status.level = 'warning';
    status.message = 'after';
    expect(s.cellStatusOf('r1', 'col-a')).toEqual({ level: 'error', message: 'before' });
  });
});
