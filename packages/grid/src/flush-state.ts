// flush-state（DD-056 H12）: GridInstance.flush の完了判定（純関数・DOM 非依存）。
//
// flush は「呼んだ時点の編集中のセルを確定し、自分の未確定の操作が 0 になるまで待つ」（contract.md §4.4）。mount-controller が
// 状態の変化（pending・接続・編集）を受けて macrotask で本関数を呼び、結果が出た待ち合わせから解決する。

import type { GridFlushResult } from './index';

/** flush を待つ間に毎回判定へ渡す状態。 */
export interface FlushState {
  /** grid が destroy された。 */
  readonly destroyed: boolean;
  /** 接続が終端した（切断の上限超過・divergence。共同編集の session.isStopped）。 */
  readonly stopped: boolean;
  /** 自分の未確定の操作の数（共同編集の session.pendingCount。単独モードは 0）。 */
  readonly pendingCount: number;
  /** flush を呼んだ時点の編集中のセルがまだ確定できていない（IME 変換中など）。 */
  readonly editPending: boolean;
}

/** 既定の待つ上限（ミリ秒）。 */
export const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;

/** `GridFlushOptions.timeoutMs` を正規化する（正の有限数以外は既定値）。 */
export function resolveFlushTimeout(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FLUSH_TIMEOUT_MS;
}

/**
 * 待ち合わせを解決できるなら結果を、まだ待つなら undefined を返す。
 * - 送り切った（編集中セルの確定済み・pending 0）なら、接続が終端していても `flushed`（送るものは残っていない）。
 * - 送り切れていないまま接続が終端した・destroy されたなら `stopped`（以後は送られない）。
 * - それ以外は待つ（timeout は呼び出し側のタイマーが `timeoutResult` で解決する）。
 */
export function decideFlush(state: FlushState): GridFlushResult | undefined {
  if (!state.editPending && state.pendingCount === 0) {
    return { status: 'flushed' };
  }
  if (state.destroyed || state.stopped) {
    return { status: 'stopped', pendingCount: state.pendingCount };
  }
  return undefined;
}

/** 上限を過ぎたときの結果。 */
export function timeoutResult(state: Pick<FlushState, 'pendingCount' | 'editPending'>): GridFlushResult {
  return { status: 'timeout', pendingCount: state.pendingCount, editing: state.editPending };
}
