import { describe, expect, it } from 'vitest';

import {
  GRID_CONFLICT_CODES,
  GRID_ERROR_CODES,
  GridBootError,
  toCompensationConflictCode,
  toGridConflictCode,
} from './error-codes';
import type { GridConflictCode } from './error-codes';

describe('error-codes: 公開エラー語彙', () => {
  it('error コード語彙が phase 対応で固定されている（罫線1種＋共同編集4種＋単独モード2種＋列タイプ1種＋表示書式1種）', () => {
    expect([...GRID_ERROR_CODES]).toEqual([
      'border-config-invalid',
      'config-unavailable',
      'config-invalid',
      'connect-failed',
      'runtime-fault',
      'standalone-options-conflict',
      'standalone-options-invalid',
      'column-types-invalid',
      'column-display-invalid',
    ]);
  });

  it('GridBootError は公開 error code を保持する', () => {
    const err = new GridBootError('config-invalid', '/config の形式が不正');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('config-invalid');
    expect(err.message).toBe('/config の形式が不正');
    expect(err.name).toBe('GridBootError');
  });
});

describe('toGridConflictCode: 内部 RejectCode/ConflictReason → 公開語彙', () => {
  it('reason=rejected の server RejectCode を公開語彙へ写像する', () => {
    const cases: Array<[string, GridConflictCode]> = [
      ['stale-cell-revision', 'cell-conflict'],
      ['target-row-deleted', 'row-unavailable'],
      ['unknown-row', 'row-unavailable'],
      ['unknown-anchor', 'row-unavailable'],
      ['unknown-column', 'column-unavailable'],
      ['invalid-base-revision', 'revision-stale'],
      ['client-sequence-violation', 'sequence-violation'],
      ['duplicate-row', 'duplicate-row'],
      ['permission-denied', 'permission-denied'], // DD-056 H11（サーバーの認可段の拒否）
    ];
    for (const [raw, expected] of cases) {
      expect(toGridConflictCode('rejected', raw)).toBe(expected);
    }
  });

  it('reason 自体が競合種別のものはそのまま公開語彙になる', () => {
    expect(toGridConflictCode('revalidation-failed', undefined)).toBe('revalidation-failed');
    expect(toGridConflictCode('dependency', undefined)).toBe('dependency');
  });

  it('未知/未写像の RejectCode は unknown（前方互換フォールバック・内部コード追加で consumer を壊さない）', () => {
    expect(toGridConflictCode('rejected', undefined)).toBe('unknown');
    expect(toGridConflictCode('rejected', 'some-future-reject-code')).toBe('unknown');
  });

  it('写像結果は必ず公開語彙集合に含まれる', () => {
    const produced = new Set<GridConflictCode>([
      toGridConflictCode('rejected', 'stale-cell-revision'),
      toGridConflictCode('rejected', 'unknown-column'),
      toGridConflictCode('revalidation-failed', undefined),
      toGridConflictCode('dependency', undefined),
      toGridConflictCode('rejected', 'x'),
    ]);
    for (const code of produced) {
      expect(GRID_CONFLICT_CODES).toContain(code);
    }
  });
});

describe('toCompensationConflictCode: Undo/Redo の補償 reject（DD-056 H11・Codex 設計レビュー P2-3）', () => {
  it('認可段の拒否（permission-denied）は undo-blocked/redo-blocked より優先する', () => {
    expect(toCompensationConflictCode('undo-blocked', 'permission-denied')).toBe('permission-denied');
    expect(toCompensationConflictCode('redo-blocked', 'permission-denied')).toBe('permission-denied');
  });

  it('それ以外（OCC の stale・コードなし）は従来どおり undo-blocked/redo-blocked', () => {
    expect(toCompensationConflictCode('undo-blocked', 'stale-cell-revision')).toBe('undo-blocked');
    expect(toCompensationConflictCode('redo-blocked', 'stale-cell-revision')).toBe('redo-blocked');
    expect(toCompensationConflictCode('undo-blocked', undefined)).toBe('undo-blocked');
  });

  it('結果は公開語彙集合に含まれる', () => {
    for (const code of [toCompensationConflictCode('undo-blocked', 'permission-denied'), toCompensationConflictCode('redo-blocked', undefined)]) {
      expect(GRID_CONFLICT_CODES).toContain(code);
    }
  });
});
