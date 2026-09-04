// DD-045 unit: RowId → 静的行背景のプリコンパイル契約。

import { describe, expect, it } from 'vitest';

import { FormatRuleConfigError, compileRowBackgrounds } from './format-rules';

describe('DD-045: compileRowBackgrounds', () => {
  it('未指定・空オブジェクトは hasAny=false（描画経路を束縛しない）', () => {
    expect(compileRowBackgrounds(undefined).hasAny()).toBe(false);
    expect(compileRowBackgrounds({}).hasAny()).toBe(false);
  });

  it('指定 RowId の色だけを O(1) で返し、入力を変更しない', () => {
    const input = Object.freeze({ r5: '#e5e7eb', r30: '#fff' });
    const compiled = compileRowBackgrounds(input);
    expect(compiled.hasAny()).toBe(true);
    expect(compiled.getBackground('r5')).toBe('#e5e7eb');
    expect(compiled.getBackground('r30')).toBe('#fff');
    expect(compiled.getBackground('r999')).toBeUndefined();
    expect(input).toEqual({ r5: '#e5e7eb', r30: '#fff' });
  });

  it('行一覧は mount 後に到着するため未知 RowId も受理する（診断は初回描画後の配線責務）', () => {
    const compiled = compileRowBackgrounds({ 'not-yet-loaded': '#eef3ff' });
    expect(compiled.getBackground('not-yet-loaded')).toBe('#eef3ff');
  });

  it('空・空白のみの色は fail-fast（公開 column-types-invalid 経路へ写像）', () => {
    expect(() => compileRowBackgrounds({ r5: '' })).toThrow(FormatRuleConfigError);
    expect(() => compileRowBackgrounds({ r5: '   ' })).toThrow(FormatRuleConfigError);
    try {
      compileRowBackgrounds({ r5: '' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FormatRuleConfigError);
      expect((error as FormatRuleConfigError).reason).toBe('empty-color');
      expect((error as FormatRuleConfigError).columnId).toBe('r5');
    }
  });

  it('CSS color の構文妥当性は検査しない（Canvas で安全に縮退）', () => {
    expect(compileRowBackgrounds({ r5: 'not-a-color' }).getBackground('r5')).toBe('not-a-color');
  });
});

