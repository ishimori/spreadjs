// row-operations 純関数の単体テスト（DD-021-1 Phase 1・TDD）。
import { describe, expect, it } from 'vitest';

import { decideRowStructureKey, rebaseRowIndex, resolveDeleteTargets } from './row-operations';
import type { RowStructureKeyInput } from './row-operations';

function key(overrides: Partial<RowStructureKeyInput>): RowStructureKeyInput {
  return {
    key: '+',
    ctrlKey: true,
    metaKey: false,
    shiftKey: true,
    altKey: false,
    eventComposing: false,
    sessionComposing: false,
    phase: 'Navigation',
    ...overrides,
  };
}

describe('decideRowStructureKey', () => {
  it('Ctrl+Shift+"+" は insert（Navigation・非 composing）', () => {
    expect(decideRowStructureKey(key({ key: '+' }))).toBe('insert');
  });

  it('Ctrl+"-" は delete', () => {
    expect(decideRowStructureKey(key({ key: '-', shiftKey: false }))).toBe('delete');
  });

  it('Cmd（meta）でも成立する', () => {
    expect(decideRowStructureKey(key({ key: '+', ctrlKey: false, metaKey: true }))).toBe('insert');
    expect(decideRowStructureKey(key({ key: '-', ctrlKey: false, metaKey: true, shiftKey: false }))).toBe('delete');
  });

  it('修飾なしは none（グリッド裁定しない）', () => {
    expect(decideRowStructureKey(key({ key: '+', ctrlKey: false, metaKey: false }))).toBe('none');
    expect(decideRowStructureKey(key({ key: '-', ctrlKey: false, metaKey: false, shiftKey: false }))).toBe('none');
  });

  it('alt 併用は none', () => {
    expect(decideRowStructureKey(key({ key: '+', altKey: true }))).toBe('none');
  });

  it('RC14（DD-052-3）: rowOperationsEnabled:false は Navigation・非composingでも常に none', () => {
    expect(decideRowStructureKey(key({ key: '+', rowOperationsEnabled: false }))).toBe('none');
    expect(decideRowStructureKey(key({ key: '-', shiftKey: false, rowOperationsEnabled: false }))).toBe('none');
  });

  it('RC14: rowOperationsEnabled:true・未指定は従来どおり（既定 true）', () => {
    expect(decideRowStructureKey(key({ key: '+', rowOperationsEnabled: true }))).toBe('insert');
    expect(decideRowStructureKey(key({ key: '+' }))).toBe('insert'); // 未指定
  });

  it('Editing/Composing 位相・composing 中は必ず none（IME 不変条件・I-3）', () => {
    expect(decideRowStructureKey(key({ phase: 'EditingReplace' }))).toBe('none');
    expect(decideRowStructureKey(key({ phase: 'EditingExisting' }))).toBe('none');
    expect(decideRowStructureKey(key({ phase: 'EditingAwaitFinalInput' }))).toBe('none');
    expect(decideRowStructureKey(key({ phase: 'Composing' }))).toBe('none');
    expect(decideRowStructureKey(key({ eventComposing: true }))).toBe('none');
    expect(decideRowStructureKey(key({ sessionComposing: true }))).toBe('none');
  });

  it('無関係キーは none', () => {
    expect(decideRowStructureKey(key({ key: 'a' }))).toBe('none');
    expect(decideRowStructureKey(key({ key: 'ArrowDown', shiftKey: false }))).toBe('none');
  });
});

describe('resolveDeleteTargets', () => {
  const order = ['r0', 'r1', 'r2', 'r3'];

  it('現存する要求 ID を要求順で返す', () => {
    expect(resolveDeleteTargets(order, ['r2', 'r0'])).toEqual(['r2', 'r0']);
  });

  it('非現存 ID は除外する', () => {
    expect(resolveDeleteTargets(order, ['r2', 'ghost', 'r1'])).toEqual(['r2', 'r1']);
  });

  it('重複は先着で除去する', () => {
    expect(resolveDeleteTargets(order, ['r1', 'r1', 'r2'])).toEqual(['r1', 'r2']);
  });

  it('全て非現存/空なら []（実行前拒否のトリガ）', () => {
    expect(resolveDeleteTargets(order, ['ghost'])).toEqual([]);
    expect(resolveDeleteTargets(order, [])).toEqual([]);
  });
});

describe('rebaseRowIndex（K3 選択再ベース・DD-021-3。DD-021-1 の削除限定縮退を一般化＝旧 reduceActiveRowTarget は削除済み）', () => {
  it('生存かつ順不変 → 同一 index', () => {
    const order = ['r0', 'r1', 'r2', 'r3'];
    expect(rebaseRowIndex(order, order, 2)).toBe(2);
  });

  it('上に挿入 → RowId 追従で新 index（下方シフト）', () => {
    const oldOrder = ['r0', 'r1', 'r2'];
    const newOrder = ['r0', 'n1', 'n2', 'r1', 'r2']; // r0 の下へ 2 行挿入
    expect(rebaseRowIndex(oldOrder, newOrder, 1)).toBe(3); // r1 が index 3 へ
    expect(rebaseRowIndex(oldOrder, newOrder, 2)).toBe(4); // r2 が index 4 へ
    expect(rebaseRowIndex(oldOrder, newOrder, 0)).toBe(0); // r0 は不変
  });

  it('下に挿入 → 自分より下なので index 不変', () => {
    const oldOrder = ['r0', 'r1', 'r2'];
    const newOrder = ['r0', 'r1', 'r2', 'n3'];
    expect(rebaseRowIndex(oldOrder, newOrder, 1)).toBe(1);
  });

  it('自身が削除 → 下優先の生存行の新 index へ', () => {
    const oldOrder = ['r0', 'r1', 'r2', 'r3'];
    const newOrder = ['r0', 'r2', 'r3']; // r1 削除
    expect(rebaseRowIndex(oldOrder, newOrder, 1)).toBe(1); // 旧 r2＝新 index 1
  });

  it('自身と直下が削除 → さらに下の生存行へ', () => {
    const oldOrder = ['r0', 'r1', 'r2', 'r3'];
    const newOrder = ['r0', 'r3']; // r1,r2 削除
    expect(rebaseRowIndex(oldOrder, newOrder, 1)).toBe(1); // 旧 r3＝新 index 1
  });

  it('下に生存無し → 上へフォールバック', () => {
    const oldOrder = ['r0', 'r1', 'r2', 'r3'];
    const newOrder = ['r0', 'r1']; // r2,r3 削除
    expect(rebaseRowIndex(oldOrder, newOrder, 3)).toBe(1); // 旧 r1＝新 index 1
  });

  it('全行消失 → null', () => {
    expect(rebaseRowIndex(['r0', 'r1'], [], 0)).toBeNull();
  });

  it('index 範囲外 → null', () => {
    expect(rebaseRowIndex(['r0'], ['r0'], 5)).toBeNull();
  });

  it('削除＋挿入の複合でも RowId を正しく追う', () => {
    const oldOrder = ['r0', 'r1', 'r2', 'r3'];
    const newOrder = ['nA', 'r0', 'r2', 'r3']; // 先頭に nA 挿入・r1 削除
    expect(rebaseRowIndex(oldOrder, newOrder, 0)).toBe(1); // r0 → index 1
    expect(rebaseRowIndex(oldOrder, newOrder, 1)).toBe(2); // r1 削除 → 下の r2＝index 2
    expect(rebaseRowIndex(oldOrder, newOrder, 3)).toBe(3); // r3 → index 3
  });
});
