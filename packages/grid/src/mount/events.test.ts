// DD-065: 購読と通知の部品（mount/events.ts）を、grid を mount せずに確かめる。
import { describe, expect, it } from 'vitest';
import type { ClientSession } from '@nanairo-sheet/collab';

import type { GridEvent, GridRemoteChange } from '../index';
import { createEvents } from './events';

function change(revision: number): GridRemoteChange {
  return { revision, userId: 'other', cells: [] } as unknown as GridRemoteChange;
}

function setup(options: { session?: Partial<ClientSession> } = {}) {
  let destroyed = false;
  const received: GridEvent[] = [];
  const events = createEvents({
    clientId: 'me',
    displayName: 'Me',
    onEvent: (event) => received.push(event),
    isDestroyed: () => destroyed,
    collabSession: () => options.session as ClientSession | undefined,
  });
  return {
    events,
    received,
    destroy: () => {
      destroyed = true;
    },
  };
}

describe('mount/events: 配信と購読', () => {
  it('mount の onEvent と subscribe した購読者へ、登録順に配る。解除した購読者には配らない', () => {
    const { events, received } = setup();
    const later: string[] = [];
    const unsubscribe = events.subscribe((event) => later.push(event.type));
    events.emit({ type: 'pending', pendingCount: 1 });
    unsubscribe();
    events.emit({ type: 'pending', pendingCount: 0 });
    expect(received.map((e) => e.type)).toEqual(['pending', 'pending']);
    expect(later).toEqual(['pending']);
    expect(events.hasListeners()).toBe(true);
    events.clearListeners();
    expect(events.hasListeners()).toBe(false);
  });

  it('remote-change は積んだ順に配り、配っている途中で destroy されたら残りを配らない', () => {
    const { events, received, destroy } = setup();
    events.subscribe((event) => {
      if (event.type === 'remote-change' && event.change.revision === 2) {
        destroy();
      }
    });
    events.queueRemoteChange(change(1));
    events.queueRemoteChange(change(2));
    events.queueRemoteChange(change(3));
    events.flushRemoteChanges();
    expect(received.map((e) => (e.type === 'remote-change' ? e.change.revision : -1))).toEqual([1, 2]);
  });

  it('捨てた remote-change は配らない', () => {
    const { events, received } = setup();
    events.queueRemoteChange(change(1));
    events.discardQueuedRemoteChanges();
    events.flushRemoteChanges();
    expect(received).toEqual([]);
  });
});

describe('mount/events: 参加者一覧', () => {
  it('共同編集の接続が無いあいだは空の一覧を返す', () => {
    const { events } = setup();
    expect(events.currentPresenceUsers()).toEqual([]);
  });

  it('再計算はマイクロタスクで 1 回にまとめ、一覧が変わったときだけ presence を配る', async () => {
    const session = { connectionId: 'c1', knownPresences: () => [] } as unknown as Partial<ClientSession>;
    const { events, received } = setup({ session });
    events.noteSelfActiveCell(undefined);
    events.schedulePresenceRefresh();
    events.schedulePresenceRefresh();
    expect(received).toEqual([]); // 同期では配らない
    await Promise.resolve();
    expect(received.filter((e) => e.type === 'presence')).toHaveLength(1);
    events.schedulePresenceRefresh();
    await Promise.resolve();
    expect(received.filter((e) => e.type === 'presence')).toHaveLength(1); // 一覧が同じなら配らない
  });

  it('destroy の後は予約した再計算を配らない', async () => {
    const session = { connectionId: 'c1', knownPresences: () => [] } as unknown as Partial<ClientSession>;
    const { events, received, destroy } = setup({ session });
    events.schedulePresenceRefresh();
    destroy();
    await Promise.resolve();
    expect(received).toEqual([]);
  });
});
