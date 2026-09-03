// readonly-policy のユニットテスト（DD-033-1 Phase 1・AC7）。
// readOnly 時の keydown 前段裁定（純関数・DOM 非依存）が「編集系入力のみ suppress し、閲覧系を pass する」ことを検証する。
// F2/Delete/Backspace（編集開始・セルクリアの入口）だけを消費し、矢印・Shift+矢印・Ctrl+C・Escape・PageUp/Down は素通しする。

import { describe, expect, it } from 'vitest';

import { shouldSuppressReadonlyKey, type ReadonlyPolicyInput } from './readonly-policy';

/** Navigation 位相・非 composing・修飾なしの既定入力（各テストで上書きする）。 */
function nav(overrides: Partial<ReadonlyPolicyInput>): ReadonlyPolicyInput {
  return {
    key: 'a',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    eventComposing: false,
    sessionComposing: false,
    phase: 'Navigation',
    ...overrides,
  };
}

describe('readonly-policy: 編集系入力の抑止（AC7）', () => {
  it('F2 / Delete / Backspace は suppress する（編集開始・セルクリアの入口）', () => {
    expect(shouldSuppressReadonlyKey(nav({ key: 'F2' }))).toBe(true);
    expect(shouldSuppressReadonlyKey(nav({ key: 'Delete' }))).toBe(true);
    expect(shouldSuppressReadonlyKey(nav({ key: 'Backspace' }))).toBe(true);
  });
});

describe('readonly-policy: 閲覧系入力の pass（AC7）', () => {
  it('矢印・Shift+矢印は pass する（範囲選択＝閲覧系）', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(shouldSuppressReadonlyKey(nav({ key })), `${key}`).toBe(false);
      expect(shouldSuppressReadonlyKey(nav({ key, shiftKey: true })), `Shift+${key}`).toBe(false);
    }
  });

  it('Ctrl+C（コピー）は pass する', () => {
    expect(shouldSuppressReadonlyKey(nav({ key: 'c', ctrlKey: true }))).toBe(false);
    expect(shouldSuppressReadonlyKey(nav({ key: 'c', metaKey: true }))).toBe(false);
  });

  it('Escape・PageUp・PageDown・Home・End・Enter・Tab は pass する（移動/選択解除＝閲覧系）', () => {
    for (const key of ['Escape', 'PageUp', 'PageDown', 'Home', 'End', 'Enter', 'Tab']) {
      expect(shouldSuppressReadonlyKey(nav({ key })), key).toBe(false);
    }
  });

  it('印字文字は pass する（編集開始は input 経路＝integration-editor 側で抑止する）', () => {
    for (const key of ['a', 'あ', '1', ' ']) {
      expect(shouldSuppressReadonlyKey(nav({ key })), key).toBe(false);
    }
  });

  it('修飾キー付きの F2/Delete/Backspace も suppress する（状態機械は修飾を見ないため Ctrl+Backspace 等が素の編集開始として届く・統合レビュー P2-1）', () => {
    expect(shouldSuppressReadonlyKey(nav({ key: 'Delete', ctrlKey: true }))).toBe(true);
    expect(shouldSuppressReadonlyKey(nav({ key: 'Backspace', altKey: true }))).toBe(true);
    expect(shouldSuppressReadonlyKey(nav({ key: 'Backspace', metaKey: true }))).toBe(true);
    expect(shouldSuppressReadonlyKey(nav({ key: 'F2', ctrlKey: true }))).toBe(true);
    expect(shouldSuppressReadonlyKey(nav({ key: 'Backspace', shiftKey: true }))).toBe(true);
  });
});

describe('readonly-policy: IME/編集中は常に pass（IME 経路無改変・I-3）', () => {
  it('composition 中（DOM/内部いずれか）は F2/Delete/Backspace でも pass する', () => {
    expect(shouldSuppressReadonlyKey(nav({ key: 'F2', eventComposing: true }))).toBe(false);
    expect(shouldSuppressReadonlyKey(nav({ key: 'Delete', sessionComposing: true }))).toBe(false);
  });

  it('非 Navigation 位相は F2/Delete/Backspace でも pass する', () => {
    expect(shouldSuppressReadonlyKey(nav({ key: 'F2', phase: 'EditingReplace' }))).toBe(false);
    expect(shouldSuppressReadonlyKey(nav({ key: 'Delete', phase: 'Composing' }))).toBe(false);
    expect(shouldSuppressReadonlyKey(nav({ key: 'Backspace', phase: 'EditingExisting' }))).toBe(false);
  });
});
