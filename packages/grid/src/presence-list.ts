// presence-list（DD-049 H5）: 参加者一覧（公開 GridPresenceUser[]）の組み立てと変化判定（純関数・DOM 非依存）。
//
// 他者は ClientSession.knownPresences()（サーバーから届いた順・1 接続 1 件・自分の接続は session が除外済み）、
// 自分は grid が送った presence から組む。変化判定は直前に配った一覧との構造比較（順序を含む）で、変化時だけ
// presence イベントを発火するために使う。内部の UserPresence・CellAddressById は公開型へ出さない（R7）。
// 返す一覧と要素は freeze する（利用側が書き換えても、変化判定に使う直前の一覧が壊れない）。

import type { CellAddressById, UserPresence } from '@nanairo-sheet/core';

import type { GridCellAddress, GridPresenceUser } from './index';

/** 自分のエントリの材料（userId=grid の clientId・displayName=mount の表示名・activeCell=直近に送った presence）。 */
export interface SelfPresence {
  readonly userId: string;
  readonly displayName: string;
  readonly activeCell: CellAddressById | undefined;
}

/** 先頭に自分、続いて他者を与えられた順に並べた参加者一覧を返す（activeCell 無しは null）。 */
export function buildPresenceUsers(self: SelfPresence, others: readonly UserPresence[]): readonly GridPresenceUser[] {
  const users: GridPresenceUser[] = [presenceUser(self.userId, self.displayName, self.activeCell, true)];
  for (const other of others) {
    users.push(presenceUser(other.userId, other.displayName, other.activeCell, false));
  }
  return Object.freeze(users);
}

/** 2 つの一覧が同じか（順序・userId・displayName・activeCell・self をすべて比較する）。 */
export function samePresenceUsers(a: readonly GridPresenceUser[], b: readonly GridPresenceUser[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((user, index) => {
    const other = b[index];
    return other !== undefined && sameUser(user, other);
  });
}

function presenceUser(
  userId: string,
  displayName: string,
  activeCell: CellAddressById | undefined,
  self: boolean,
): GridPresenceUser {
  return Object.freeze({
    userId,
    displayName,
    activeCell:
      activeCell === undefined
        ? null
        : Object.freeze({ rowId: String(activeCell.rowId), columnId: String(activeCell.columnId) }),
    self,
  });
}

function sameUser(a: GridPresenceUser, b: GridPresenceUser): boolean {
  return (
    a.userId === b.userId &&
    a.displayName === b.displayName &&
    a.self === b.self &&
    sameAddress(a.activeCell, b.activeCell)
  );
}

function sameAddress(a: GridCellAddress | null, b: GridCellAddress | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.rowId === b.rowId && a.columnId === b.columnId;
}
