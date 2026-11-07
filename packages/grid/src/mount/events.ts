// 購読と通知（GridEvent の配信・remote-change のキュー・参加者一覧）。DD-065 で mount-controller.ts から分けた。

import type { ClientSession, SessionEvent } from '@nanairo-sheet/collab';
import type { CellAddressById } from '@nanairo-sheet/core';

import { toGridConflictCode } from '../error-codes';
import type { GridEvent, GridPresenceUser, GridRemoteChange } from '../index';
import { buildPresenceUsers, samePresenceUsers } from '../presence-list';
import { NO_PRESENCE_USERS } from './constants';

export interface EventsDeps {
  readonly clientId: string;
  readonly displayName: string;
  readonly onEvent: ((event: GridEvent) => void) | undefined;
  isDestroyed(): boolean;
  /** DD-049 H4/H5: 共同編集モードの ClientSession（単独モード・boot 前は undefined）。 */
  collabSession(): ClientSession | undefined;
}

export interface GridEvents {
  emit(event: GridEvent): void;
  subscribe(listener: (event: GridEvent) => void): () => void;
  hasListeners(): boolean;
  /** DD-049 H4: committed へ入った受理済み SetCells の公開形を積む（配るのは flushRemoteChanges）。 */
  queueRemoteChange(change: GridRemoteChange): void;
  flushRemoteChanges(): void;
  discardQueuedRemoteChanges(): void;
  clearListeners(): void;
  currentPresenceUsers(): readonly GridPresenceUser[];
  refreshPresence(): void;
  /** DD-049 H5: 自分が直近に送った presence の activeCell（参加者一覧の自分のエントリに映す）。 */
  noteSelfActiveCell(cell: CellAddressById | undefined): void;
  schedulePresenceRefresh(): void;
}

/** SessionEvent を公開の GridEvent へ写す（内部 RejectCode は公開語彙へ写像する）。 */
export function toGridEvent(event: SessionEvent): GridEvent {
  switch (event.type) {
    case 'connection':
      return { type: 'connection', state: event.state, pendingCount: event.pendingCount };
    case 'pending':
      return { type: 'pending', pendingCount: event.pendingCount };
    case 'rejected':
      return {
        type: 'rejected',
        pendingCount: event.pendingCount,
        conflict: {
          operationId: String(event.entry.operationId),
          reason: event.entry.reason,
          // 内部 RejectCode を素通しせず公開語彙へ写像する（R7・未知は 'unknown'）。
          code: toGridConflictCode(event.entry.reason, event.entry.code),
        },
      };
    case 'divergence':
      return {
        type: 'divergence',
        serverRevision: event.serverRevision,
        committedRevision: event.committedRevision,
      };
  }
}

export function createEvents(deps: EventsDeps): GridEvents {
  const listeners = new Set<(event: GridEvent) => void>();
  if (deps.onEvent !== undefined) {
    listeners.add(deps.onEvent);
  }
  // DD-049 H4: committed へ入った受理済み SetCells の公開形。1 サーバーメッセージの処理が終わってから（settle で）配る。
  let remoteChangeQueue: GridRemoteChange[] = [];
  // DD-049 H5: 自分が直近に送った presence の activeCell と、直前に配った参加者一覧（変化時だけ presence を発火する）。
  let selfActiveCell: CellAddressById | undefined;
  let lastPresenceUsers: readonly GridPresenceUser[] = NO_PRESENCE_USERS;
  let presenceRefreshScheduled = false;

  function emit(event: GridEvent): void {
    for (const listener of [...listeners]) {
      listener(event);
    }
  }

  /** DD-049 H4: settle 時にキューの remote-change を到着順（revision 昇順）で配る。listener が destroy したら打ち切る。 */
  function flushRemoteChanges(): void {
    if (remoteChangeQueue.length === 0) {
      return;
    }
    const queued = remoteChangeQueue;
    remoteChangeQueue = [];
    for (const change of queued) {
      if (deps.isDestroyed()) {
        return;
      }
      emit({ type: 'remote-change', change });
    }
  }

  /** DD-049 H5: 現在の参加者一覧（共同編集モードで初回 join 後のみ。先頭に自分・続いて他者をサーバーから届いた順）。 */
  function currentPresenceUsers(): readonly GridPresenceUser[] {
    const session = deps.collabSession();
    if (deps.isDestroyed() || session === undefined || session.connectionId === undefined) {
      return NO_PRESENCE_USERS;
    }
    return buildPresenceUsers(
      { userId: deps.clientId, displayName: deps.displayName, activeCell: selfActiveCell },
      session.knownPresences(),
    );
  }

  /** DD-049 H5: 参加者一覧が直前に配った一覧と変わっていれば presence を発火する（変化時のみ）。 */
  function refreshPresence(): void {
    const users = currentPresenceUsers();
    if (samePresenceUsers(users, lastPresenceUsers)) {
      return;
    }
    lastPresenceUsers = users;
    emit({ type: 'presence', users });
  }

  /**
   * DD-049 H5: 自分のアクティブセル移動に伴う再計算はマイクロタスクへ遅らせて 1 回にまとめる。editor の presence 通知は
   * IME 状態機械のイベント処理（DOM ハンドラ）やサーバー更新の反映の途中から呼ばれるため、そこで利用側の listener を同期で
   * 呼ぶと、listener からの命令 API（setActiveCell 等）が処理途中の editor 状態と競合しうる（DD-038 の cell-commit 再入と同じ懸念）。
   */
  function schedulePresenceRefresh(): void {
    if (presenceRefreshScheduled) {
      return;
    }
    presenceRefreshScheduled = true;
    queueMicrotask(() => {
      presenceRefreshScheduled = false;
      if (!deps.isDestroyed()) {
        refreshPresence();
      }
    });
  }

  return {
    emit,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hasListeners: () => listeners.size > 0,
    queueRemoteChange(change) {
      remoteChangeQueue.push(change);
    },
    flushRemoteChanges,
    discardQueuedRemoteChanges() {
      remoteChangeQueue = [];
    },
    clearListeners() {
      listeners.clear();
    },
    currentPresenceUsers,
    refreshPresence,
    noteSelfActiveCell(cell) {
      selfActiveCell = cell;
    },
    schedulePresenceRefresh,
  };
}
