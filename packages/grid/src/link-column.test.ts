import { describe, expect, it } from 'vitest';

import { shouldArmLinkCandidate } from './link-column';
import type { LinkCandidateInput } from './link-column';

// 候補武装の基準ケース: 主ボタン・単クリック（1打目）・リンク列・値非空・Navigation・非 composing・非 Shift。
const ARMABLE: LinkCandidateInput = {
  button: 0,
  pointerType: 'mouse',
  isPrimaryClick: true,
  isLinkColumn: true,
  valueNonEmpty: true,
  phase: 'Navigation',
  composing: false,
  shiftKey: false,
};

describe('shouldArmLinkCandidate: クリック裁定表（候補追跡方式・📐）', () => {
  it('基準ケース（左クリック・単クリック・リンク列・値非空・Navigation）→ arm（AC1）', () => {
    expect(shouldArmLinkCandidate(ARMABLE)).toBe(true);
  });

  it('空セル → arm しない（AC2・発火なし）', () => {
    expect(shouldArmLinkCandidate({ ...ARMABLE, valueNonEmpty: false })).toBe(false);
  });

  it('非リンク列 → arm しない（従来クリック）', () => {
    expect(shouldArmLinkCandidate({ ...ARMABLE, isLinkColumn: false })).toBe(false);
  });

  it('Shift+クリック（レンジ拡張）→ arm しない（AC3）', () => {
    expect(shouldArmLinkCandidate({ ...ARMABLE, shiftKey: true })).toBe(false);
  });

  it('連打の 2 打目以降（isPrimaryClick=false）→ arm しない（dblclick は 1 打目でのみ発火・AC4）', () => {
    expect(shouldArmLinkCandidate({ ...ARMABLE, isPrimaryClick: false })).toBe(false);
  });

  it('主ボタン以外（右/中クリック）→ arm しない', () => {
    expect(shouldArmLinkCandidate({ ...ARMABLE, button: 1 })).toBe(false);
    expect(shouldArmLinkCandidate({ ...ARMABLE, button: 2 })).toBe(false);
  });

  it('編集中クリック（phase!==Navigation）→ arm しない（従来経路・AC8）', () => {
    expect(shouldArmLinkCandidate({ ...ARMABLE, phase: 'EditingExisting' })).toBe(false);
    expect(shouldArmLinkCandidate({ ...ARMABLE, phase: 'EditingReplace' })).toBe(false);
    expect(shouldArmLinkCandidate({ ...ARMABLE, phase: 'Composing' })).toBe(false);
  });

  it('変換中クリック（composing）→ arm しない（AC8）', () => {
    expect(shouldArmLinkCandidate({ ...ARMABLE, composing: true })).toBe(false);
  });

  it('タッチのタップ（pointerType=touch）→ arm しない（Fable P2・公開契約「タッチでは発火しない」）', () => {
    expect(shouldArmLinkCandidate({ ...ARMABLE, pointerType: 'touch' })).toBe(false);
  });

  it('ペン（pointerType=pen）・synthetic 未指定（空文字）→ arm する（mouse 相当）', () => {
    expect(shouldArmLinkCandidate({ ...ARMABLE, pointerType: 'pen' })).toBe(true);
    expect(shouldArmLinkCandidate({ ...ARMABLE, pointerType: '' })).toBe(true);
  });
});
