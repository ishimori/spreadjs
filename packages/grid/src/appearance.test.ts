import { describe, expect, it } from 'vitest';
import { compileAppearance } from './appearance';

const validFont = (font: string): boolean => font.includes('sans-serif');
const color = (value: string): string | undefined => value.startsWith('#') ? value : undefined;
describe('consumer appearance', () => {
  it('未指定の既存consumerのfontを変えない', () => {
    const result = compileAppearance(undefined, ['name'], validFont, color);
    expect(result.fontFor('name')).toBe('13px system-ui, sans-serif');
    expect(result.headerFont).toBe('12px system-ui, sans-serif');
    expect(result.gridLineColor).toBeUndefined();
  });
  it('列fontを分離し、省略列は共通fontを使う', () => {
    const result = compileAppearance({ cellFont: '14px Meiryo, sans-serif', headerFont: '600 14px Meiryo, sans-serif', columnFonts: { name: '600 14px Meiryo, sans-serif' }, gridLineColor: '#e3e8ef' }, ['name', 'value'], validFont, color);
    expect(result.fontFor('name')).toBe('600 14px Meiryo, sans-serif');
    expect(result.fontFor('value')).toBe('14px Meiryo, sans-serif');
    expect(result.gridLineColor).toBe('#e3e8ef');
  });
  it('不明列・不正font・色をmount前に拒否する', () => {
    for (const value of [{ columnFonts: { unknown: '14px sans-serif' } }, { cellFont: 'bad' }, { headerFont: '14px invalid' }, { gridLineColor: 'invalid' }]) {
      expect(() => compileAppearance(value, ['name'], validFont, color)).toThrow();
    }
  });
});
