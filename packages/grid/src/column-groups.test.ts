// DD-064 K4 unit: 2段の見出し（columnGroups）の形の検査と列 index への解決。

import { describe, expect, it } from 'vitest';

import { compileColumnGroups } from './column-groups';
import { DisplayConfigError } from './display-format';

const COLUMNS = ['no', 'item', 'm04', 'm05', 'm06', 'm10', 'm11', 'total'];

function errorOf(raw: unknown, frozen = 0): DisplayConfigError {
  try {
    compileColumnGroups(raw, COLUMNS, frozen);
  } catch (error) {
    expect(error).toBeInstanceOf(DisplayConfigError);
    return error as DisplayConfigError;
  }
  throw new Error('fail-fast しなかった');
}

describe('compileColumnGroups', () => {
  it('隣り合う列を半開区間へ解決する（並べる順は問わない）', () => {
    expect(
      compileColumnGroups(
        [
          { caption: '上期', columnIds: ['m06', 'm04', 'm05'] },
          { caption: '下期', columnIds: ['m10', 'm11'] },
        ],
        COLUMNS,
        2,
      ),
    ).toEqual([
      { colStart: 2, colEnd: 5, caption: '上期' },
      { colStart: 5, colEnd: 7, caption: '下期' },
    ]);
  });

  it('未指定・空の配列は 1 段のまま', () => {
    expect(compileColumnGroups(undefined, COLUMNS, 0)).toEqual([]);
    expect(compileColumnGroups([], COLUMNS, 0)).toEqual([]);
  });

  it('形の誤りは fail-fast（column-display-invalid の経路）', () => {
    expect(errorOf({}).message).toContain('配列が必要');
    expect(errorOf([null]).message).toContain('オブジェクトではない');
    expect(errorOf([{ caption: ' ', columnIds: ['m04'] }]).message).toContain('caption が空');
    expect(errorOf([{ caption: '上期', columnIds: [] }]).message).toContain('1 列以上');
    expect(errorOf([{ caption: '上期', columnIds: ['m04', 'x'] }]).message).toContain('未知の列 x');
    expect(errorOf([{ caption: '上期', columnIds: ['m04', 'm04'] }]).message).toContain('重複');
    expect(errorOf([{ caption: '上期', columnIds: ['m04', 'm06'] }]).message).toContain('隣り合っていない');
    expect(errorOf([{ caption: '属性', columnIds: ['item', 'm04'] }], 2).message).toContain('境界をまたぐ');
    expect(
      errorOf([
        { caption: '上期', columnIds: ['m04', 'm05'] },
        { caption: '重なり', columnIds: ['m05', 'm06'] },
      ]).message,
    ).toContain('同じ列 m05');
  });
});
