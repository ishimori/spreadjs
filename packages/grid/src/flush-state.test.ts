import { describe, expect, it } from 'vitest';

import { DEFAULT_FLUSH_TIMEOUT_MS, decideFlush, resolveFlushTimeout, timeoutResult } from './flush-state';

describe('flush-state（DD-056 H12・contract.md §4.4）', () => {
  const base = { destroyed: false, stopped: false, pendingCount: 0, editPending: false };

  it('編集中セルの確定済み・pending 0 なら flushed', () => {
    expect(decideFlush(base)).toEqual({ status: 'flushed' });
  });

  it('送り切っていれば接続が終端していても flushed（送るものは残っていない）', () => {
    expect(decideFlush({ ...base, stopped: true })).toEqual({ status: 'flushed' });
    expect(decideFlush({ ...base, destroyed: true })).toEqual({ status: 'flushed' });
  });

  it('pending が残る・編集中セルが未確定なら待つ（undefined）', () => {
    expect(decideFlush({ ...base, pendingCount: 2 })).toBeUndefined();
    expect(decideFlush({ ...base, editPending: true })).toBeUndefined();
  });

  it('送り切れないまま接続が終端・destroy されたら stopped（pendingCount 付き）', () => {
    expect(decideFlush({ ...base, pendingCount: 3, stopped: true })).toEqual({ status: 'stopped', pendingCount: 3 });
    expect(decideFlush({ ...base, editPending: true, destroyed: true })).toEqual({ status: 'stopped', pendingCount: 0 });
  });

  it('timeout は pendingCount と editing（確定できていない編集中セルの有無）を返す', () => {
    expect(timeoutResult({ pendingCount: 1, editPending: true })).toEqual({ status: 'timeout', pendingCount: 1, editing: true });
  });

  it('timeoutMs は正の有限数だけを採り、それ以外は既定 10,000ms', () => {
    expect(resolveFlushTimeout(2_500)).toBe(2_500);
    for (const raw of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
      expect(resolveFlushTimeout(raw)).toBe(DEFAULT_FLUSH_TIMEOUT_MS);
    }
  });
});
