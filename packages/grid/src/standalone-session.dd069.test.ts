// DD-069 unit: 単独モードの行データで付けるセルごとの背景色（cellBackgrounds）の保持と付け外し（DOM 非依存）。
//
// 検証: initialData/setData で作り直す・setRows は渡した行だけ置き換え、省略は保持・{} で消す・背景だけの変更は値・Undo に
// 触れず再描画だけ要求する・未知列は静かにスキップ、空・空白だけ・文字列でない色は無視して通知（例外にしない）・
// 置き場を setCellBackgrounds と共有する。

import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId } from '@nanairo-sheet/types';

import { cellBackgroundInvalidMessage, createCellBackgroundStore } from './cell-background';
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
    onCellBackgroundInvalid: (message) => invalid.push(message),
  });
  s.start();
  s.view.flush();
  return s;
}

function colorsOf(s: ReturnType<typeof session>, rowId: string): Record<string, string> | undefined {
  const row = s.cellBackgrounds.row(rowId);
  return row === undefined ? undefined : Object.fromEntries(row);
}

const asBackgrounds = (value: unknown) => value as Record<string, string>;

describe('DD-069: cellBackgrounds の初期注入と setData', () => {
  it('initialData の cellBackgrounds が行ごとに引ける（空のセルにも付く。未指定の行は undefined）', () => {
    const s = session({
      rows: [
        { rowId: 'r1', cells: { 'col-a': '1' }, cellBackgrounds: { 'col-a': '#fff', 'col-b': '#e5e7eb' } },
        { rowId: 'r2', cells: { 'col-a': '2' } },
      ],
    });
    expect(s.cellBackgrounds.hasAny()).toBe(true);
    expect(colorsOf(s, 'r1')).toEqual({ 'col-a': '#fff', 'col-b': '#e5e7eb' });
    expect(s.cellBackgrounds.row('r2')).toBeUndefined();
  });

  it('未指定・空オブジェクトなら hasAny=false', () => {
    const s = session({ rows: [{ rowId: 'r1', cellBackgrounds: {} }, { rowId: 'r2' }] });
    expect(s.cellBackgrounds.hasAny()).toBe(false);
    expect(s.cellBackgrounds.row('r1')).toBeUndefined();
  });

  it('setData で丸ごと作り直す（省略した再注入では前の色を引きずらない）', () => {
    const s = session({ rows: [{ rowId: 'r1', cellBackgrounds: { 'col-a': '#eee' } }] });
    s.setData({ rows: [{ rowId: 'r1', cells: { 'col-a': 'y' } }] });
    expect(s.cellBackgrounds.hasAny()).toBe(false);
    s.setData({ rows: [{ rowId: 'r1', cellBackgrounds: { 'col-b': 'red' } }] });
    expect(colorsOf(s, 'r1')).toEqual({ 'col-b': 'red' });
  });
});

describe('DD-069: setRows での付け外し', () => {
  it('渡した行だけ丸ごと置き換え、省略した setRows では保ち、{} で消す', () => {
    const s = session({ rows: [{ rowId: 'r1' }, { rowId: 'r2', cellBackgrounds: { 'col-a': '#ddd' } }] });
    s.setRows([{ rowId: 'r1', cellBackgrounds: { 'col-a': '#eee', 'col-b': '#fff' } }]);
    expect(colorsOf(s, 'r1')).toEqual({ 'col-a': '#eee', 'col-b': '#fff' });
    expect(colorsOf(s, 'r2')).toEqual({ 'col-a': '#ddd' });
    s.setRows([{ rowId: 'r1', cellBackgrounds: { 'col-b': '#000' } }]);
    expect(colorsOf(s, 'r1')).toEqual({ 'col-b': '#000' }); // col-a は消える（丸ごと置き換え）
    s.setRows([{ rowId: 'r1', cells: { 'col-a': 'x' } }]);
    expect(colorsOf(s, 'r1')).toEqual({ 'col-b': '#000' }); // 省略は保つ
    s.setRows([{ rowId: 'r1', cellBackgrounds: {} }]);
    expect(s.cellBackgrounds.row('r1')).toBeUndefined();
  });

  it('背景だけの変更は値・Undo 対象（changes）・cell-commit に触れず、再描画だけを要求する', () => {
    const commits: GridCellCommitChange[][] = [];
    const s = session({ rows: [{ rowId: 'r1', cells: { 'col-a': '123' } }] }, [], commits);
    expect(s.view.isDirty()).toBe(false);
    const result = s.setRows([{ rowId: 'r1', cellBackgrounds: { 'col-a': '#eee' } }]);
    expect(result.changes).toEqual([]);
    expect(result.insertedRowCount).toBe(0);
    expect(s.view.isDirty()).toBe(true);
    expect(s.view.hasStructuralDirty()).toBe(false); // 行 Axis は作り直さない（可視セルの再描画だけ）
    expect(s.view.cellDisplay(createRowId('r1'), createColumnId('col-a'))).toBe('123');
    expect(commits).toEqual([]);
  });

  it('新規行（未知の RowId）にも付けられる', () => {
    const s = session({ rows: [{ rowId: 'r1' }] });
    s.setRows([{ rowId: 'r9', cells: { 'col-a': 'new' }, cellBackgrounds: { 'col-a': '#eee' } }]);
    expect(colorsOf(s, 'r9')).toEqual({ 'col-a': '#eee' });
  });

  it('削除済みの RowId への指定は無視する（値・cellStatus と同じ扱い）', () => {
    const s = session({ rows: [{ rowId: 'r1' }, { rowId: 'r2' }] });
    s.session.submitLocalOperation({ type: 'deleteRows', rowIds: [createRowId('r2')] });
    s.setRows([{ rowId: 'r2', cellBackgrounds: { 'col-a': '#eee' } }]);
    expect(s.cellBackgrounds.row('r2')).toBeUndefined();
  });
});

describe('DD-069: 不正な指定（例外にせず、その指定だけ捨てて通知する）', () => {
  it('未知列は静かにスキップする（通知しない）', () => {
    const invalid: string[] = [];
    const s = session({ rows: [{ rowId: 'r1', cellBackgrounds: { 'col-zzz': '#eee' } }] }, invalid);
    expect(s.cellBackgrounds.hasAny()).toBe(false);
    expect(invalid).toEqual([]);
  });

  it('空・空白だけ・文字列でない色のセルは無視し、注入 1 回につき 1 回だけ通知する（mount 時の initialData も同じ）', () => {
    const invalid: string[] = [];
    const s = session(
      {
        rows: [
          { rowId: 'r1', cellBackgrounds: asBackgrounds({ 'col-a': '', 'col-b': '#eee' }) },
          { rowId: 'r2', cellBackgrounds: asBackgrounds({ 'col-a': '   ', 'col-b': 0 }) },
        ],
      },
      invalid,
    );
    expect(colorsOf(s, 'r1')).toEqual({ 'col-b': '#eee' });
    expect(s.cellBackgrounds.row('r2')).toBeUndefined();
    expect(invalid).toEqual([cellBackgroundInvalidMessage(['r1/col-a', 'r2/col-a', 'r2/col-b'])]);

    s.setRows([{ rowId: 'r1', cellBackgrounds: asBackgrounds({ 'col-a': null }) }]);
    expect(invalid).toHaveLength(2);
    expect(invalid[1]).toContain('r1/col-a');
    expect(s.cellBackgrounds.row('r1')).toBeUndefined(); // 丸ごと置き換え（有効な色が 0 件）
  });

  it('cellBackgrounds 自体がオブジェクトでない行は例外にせず、その行の色を保って通知する', () => {
    const invalid: string[] = [];
    const s = session({ rows: [{ rowId: 'r1', cells: { 'col-a': '1' }, cellBackgrounds: { 'col-a': '#eee' } }] }, invalid);
    const result = s.setRows([
      { rowId: 'r1', cellBackgrounds: asBackgrounds(null) },
      { rowId: 'r9', cells: { 'col-a': 'new' }, cellBackgrounds: asBackgrounds('#eee') },
    ]);
    expect(result.insertedRowCount).toBe(1); // 値と行の追加は通常どおり
    expect(colorsOf(s, 'r1')).toEqual({ 'col-a': '#eee' }); // 前の色を保つ
    expect(s.cellBackgrounds.row('r9')).toBeUndefined();
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain('r1');
    expect(invalid[0]).toContain('r9');
    expect(() => s.setData({ rows: [{ rowId: 'r1', cellBackgrounds: asBackgrounds(['#eee']) }] })).not.toThrow();
    expect(s.cellBackgrounds.hasAny()).toBe(false);
    expect(invalid).toHaveLength(2);
  });

  it('CSS の色としての妥当性は検査しない（描画側で pane の背景になる）', () => {
    const invalid: string[] = [];
    const s = session({ rows: [{ rowId: 'r1', cellBackgrounds: { 'col-a': 'not-a-color' } }] }, invalid);
    expect(colorsOf(s, 'r1')).toEqual({ 'col-a': 'not-a-color' });
    expect(invalid).toEqual([]);
  });

  it('渡したオブジェクトを後から書き換えても保持している色は変わらない', () => {
    const backgrounds: Record<string, string> = { 'col-a': '#eee' };
    const s = session({ rows: [{ rowId: 'r1', cellBackgrounds: backgrounds }] });
    backgrounds['col-a'] = '#000';
    backgrounds['col-b'] = '#111';
    expect(colorsOf(s, 'r1')).toEqual({ 'col-a': '#eee' });
  });
});

describe('DD-069: setCellBackgrounds と置き場を共有する', () => {
  it('外から書いた色（setCellBackgrounds）と setRows の cellBackgrounds が同じ行を置き換え合い、setData で作り直される', () => {
    const store = createCellBackgroundStore((c) => COLUMNS.includes(c));
    const s = createStandaloneSession({
      columnOrder: COLUMNS,
      initialData: { rows: [{ rowId: 'r1', cells: { 'col-a': '1' } }] },
      rowHeight: 22,
      colWidth: 80,
      onCellCommit: () => {},
      cellBackgroundStore: store,
    });
    s.start();
    store.replaceRow('r1', { 'col-a': '#eee' }, []); // setCellBackgrounds 相当
    expect(Object.fromEntries(s.cellBackgrounds.row('r1') ?? [])).toEqual({ 'col-a': '#eee' });
    s.setRows([{ rowId: 'r1', cellBackgrounds: { 'col-b': '#fff' } }]);
    expect(Object.fromEntries(store.row('r1') ?? [])).toEqual({ 'col-b': '#fff' });
    s.setData({ rows: [{ rowId: 'r1' }] });
    expect(store.hasAny()).toBe(false);
  });

  it('列を確かめない置き場（共同編集モード）は未知の列もそのまま持つ（描画側で解決できない列を描かない）', () => {
    const store = createCellBackgroundStore(undefined);
    expect(store.replaceRow('r1', { 'col-zzz': '#eee' }, [])).toBe(true);
    expect(Object.fromEntries(store.row('r1') ?? [])).toEqual({ 'col-zzz': '#eee' });
  });
});
