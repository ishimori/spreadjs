// DD-049 H5（contract.md §4・§7 P1）: 参加者一覧の組み立てと変化判定（純関数）。
//   自分が先頭・他者は与えられた順（サーバーから届いた順）・activeCell 無しは null・editingCell は一覧に出さない。
//   変化判定は順序・userId・displayName・activeCell・self の差をすべて検出し、同内容の別インスタンスは同一とみなす。

import { describe, expect, it } from 'vitest';

import type { UserPresence } from '@nanairo-sheet/core';
import { col, row } from '@nanairo-sheet/collab/test-support';

import { buildPresenceUsers, samePresenceUsers } from './presence-list';
import type { SelfPresence } from './presence-list';

function other(options: {
  connectionId: string;
  userId: string;
  displayName: string;
  activeCell?: [string, string];
  editingCell?: [string, string];
}): UserPresence {
  return {
    connectionId: options.connectionId,
    colorKey: 'color-1',
    sequence: 1,
    userId: options.userId,
    displayName: options.displayName,
    activeCell:
      options.activeCell === undefined
        ? undefined
        : { rowId: row(options.activeCell[0]), columnId: col(options.activeCell[1]) },
    selectionRanges: [],
    editingCell:
      options.editingCell === undefined
        ? undefined
        : { rowId: row(options.editingCell[0]), columnId: col(options.editingCell[1]) },
  };
}

const SELF: SelfPresence = { userId: 'client-a', displayName: 'Alice', activeCell: { rowId: row('r1'), columnId: col('c1') } };

describe('buildPresenceUsers（DD-049 H5）', () => {
  it('先頭に自分、続いて他者を与えられた順に並べ、activeCell は文字列の番地・無ければ null にする', () => {
    const users = buildPresenceUsers(SELF, [
      other({ connectionId: 'conn-b', userId: 'user-b', displayName: 'Bob', activeCell: ['r2', 'c2'], editingCell: ['r2', 'c2'] }),
      other({ connectionId: 'conn-c', userId: 'user-c', displayName: 'Carol' }),
    ]);
    expect(users).toEqual([
      { userId: 'client-a', displayName: 'Alice', activeCell: { rowId: 'r1', columnId: 'c1' }, self: true },
      { userId: 'user-b', displayName: 'Bob', activeCell: { rowId: 'r2', columnId: 'c2' }, self: false },
      { userId: 'user-c', displayName: 'Carol', activeCell: null, self: false },
    ]);
  });

  it('自分の presence 未送信（activeCell 無し）は null・他者が居なければ自分だけ', () => {
    expect(buildPresenceUsers({ userId: 'client-a', displayName: 'Alice', activeCell: undefined }, [])).toEqual([
      { userId: 'client-a', displayName: 'Alice', activeCell: null, self: true },
    ]);
  });

  it('返す一覧と要素は freeze されている（利用側の書き換えで直前の一覧が壊れない）', () => {
    const users = buildPresenceUsers(SELF, [other({ connectionId: 'conn-b', userId: 'user-b', displayName: 'Bob', activeCell: ['r2', 'c2'] })]);
    expect(Object.isFrozen(users)).toBe(true);
    for (const user of users) {
      expect(Object.isFrozen(user)).toBe(true);
      if (user.activeCell !== null) {
        expect(Object.isFrozen(user.activeCell)).toBe(true);
      }
    }
  });
});

describe('samePresenceUsers（DD-049 H5 の変化判定）', () => {
  const base = (): ReturnType<typeof buildPresenceUsers> =>
    buildPresenceUsers(SELF, [
      other({ connectionId: 'conn-b', userId: 'user-b', displayName: 'Bob', activeCell: ['r2', 'c2'] }),
      other({ connectionId: 'conn-c', userId: 'user-c', displayName: 'Carol' }),
    ]);

  it('同内容の別インスタンスは同一とみなす', () => {
    expect(samePresenceUsers(base(), base())).toBe(true);
    expect(samePresenceUsers([], [])).toBe(true);
  });

  it('件数・順序・userId・displayName・activeCell（null との差を含む）・self の差を検出する', () => {
    const b = other({ connectionId: 'conn-b', userId: 'user-b', displayName: 'Bob', activeCell: ['r2', 'c2'] });
    const c = other({ connectionId: 'conn-c', userId: 'user-c', displayName: 'Carol' });
    expect(samePresenceUsers(base(), buildPresenceUsers(SELF, [b]))).toBe(false); // 件数（C の切断）
    expect(samePresenceUsers(base(), buildPresenceUsers(SELF, [c, b]))).toBe(false); // 順序
    expect(samePresenceUsers(base(), buildPresenceUsers(SELF, [{ ...b, userId: 'user-x' }, c]))).toBe(false); // userId
    expect(samePresenceUsers(base(), buildPresenceUsers(SELF, [{ ...b, displayName: 'Bobby' }, c]))).toBe(false); // 表示名
    expect(
      samePresenceUsers(base(), buildPresenceUsers(SELF, [{ ...b, activeCell: { rowId: row('r3'), columnId: col('c2') } }, c])),
    ).toBe(false); // 他者のセル移動
    expect(samePresenceUsers(base(), buildPresenceUsers(SELF, [{ ...b, activeCell: undefined }, c]))).toBe(false); // null との差
    expect(
      samePresenceUsers(base(), buildPresenceUsers({ ...SELF, activeCell: { rowId: row('r1'), columnId: col('c9') } }, [b, c])),
    ).toBe(false); // 自分のセル移動
    const selfOnly = buildPresenceUsers(SELF, []);
    const flipped = [{ ...selfOnly[0]!, self: false }];
    expect(samePresenceUsers(selfOnly, flipped)).toBe(false); // self フラグ
  });
});
