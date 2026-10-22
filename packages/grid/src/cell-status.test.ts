// DD-061 unit: 状態表示の色の設定（cellStatusColors）の検証。

import { describe, expect, it } from 'vitest';

import { cellStatusInvalidMessage, createCellStatusStore, validateCellStatusColors } from './cell-status';
import { FormatRuleConfigError } from './format-rules';

describe('DD-061: validateCellStatusColors', () => {
  it('未指定は undefined（既定色のまま）', () => {
    expect(validateCellStatusColors(undefined)).toBeUndefined();
  });

  it('指定した水準・項目だけを写し、入力を保持しない', () => {
    const input = { error: { frame: '#00f' }, warning: { frame: '#0a0', background: '#efe' } };
    const result = validateCellStatusColors(input);
    expect(result).toEqual({ error: { frame: '#00f' }, warning: { frame: '#0a0', background: '#efe' } });
    input.error.frame = '#f00';
    expect(result?.error?.frame).toBe('#00f');
  });

  it('CSS の色としての妥当性は検査しない（描画側で既定色へ落ちる）', () => {
    expect(validateCellStatusColors({ error: { background: 'not-a-color' } })).toEqual({ error: { background: 'not-a-color' } });
  });

  it.each([
    ['オブジェクトでない', 'red'],
    ['null', null],
    ['配列', [{ frame: '#000' }]],
    ['未知の水準', { info: { frame: '#000' } }],
    ['水準がオブジェクトでない', { error: '#000' }],
    ['未知の項目', { error: { text: '#000' } }],
    ['空の色', { error: { frame: '' } }],
    ['空白だけの色', { warning: { background: '  ' } }],
    ['文字列でない色', { error: { frame: 0 } }],
  ])('%s は fail-fast（column-types-invalid の経路）', (_label, value) => {
    expect(() => validateCellStatusColors(value)).toThrow(FormatRuleConfigError);
    try {
      validateCellStatusColors(value);
    } catch (error) {
      expect((error as FormatRuleConfigError).reason).toBe('invalid-status-colors');
      expect((error as Error).message).toContain('cellStatusColors');
    }
  });
});

describe('DD-062: createCellStatusStore', () => {
  it('行ごとに丸ごと置き換え、{} で消す。未知列は既知列の判定があるときだけ落とす', () => {
    const known = createCellStatusStore((c) => c === 'a' || c === 'b');
    const invalid: string[] = [];
    expect(known.replaceRow('r1', { a: { level: 'error', message: 'm' }, zzz: { level: 'error' } }, invalid)).toBe(true);
    expect(known.statusOf('r1', 'a')).toEqual({ level: 'error', message: 'm' });
    expect(known.statusOf('r1', 'zzz')).toBeUndefined();
    expect(known.replaceRow('r1', { b: { level: 'warning' } }, invalid)).toBe(true);
    expect(known.statusOf('r1', 'a')).toBeUndefined();
    expect([...(known.row('r1') ?? new Map()).keys()]).toEqual(['b']);
    expect(known.replaceRow('r1', {}, invalid)).toBe(true);
    expect(known.hasAny()).toBe(false);
    expect(invalid).toEqual([]);

    // 既知列の判定が無ければ（共同編集モード）列はそのまま持ち、描画側で解決できない列を落とす。
    const any = createCellStatusStore(undefined);
    any.replaceRow('r1', { zzz: { level: 'error' } }, invalid);
    expect(any.statusOf('r1', 'zzz')).toEqual({ level: 'error' });
  });

  it('Record でない値はその行を変えずに invalid へ積み、不正な level のセルだけ落とす', () => {
    const store = createCellStatusStore(undefined);
    const invalid: string[] = [];
    store.replaceRow('r1', { a: { level: 'error' } }, invalid);
    expect(store.replaceRow('r1', null, invalid)).toBe(false);
    expect(store.replaceRow('r1', undefined, invalid)).toBe(false);
    expect(store.statusOf('r1', 'a')).toEqual({ level: 'error' });
    expect(store.replaceRow('r2', { a: { level: 'info' }, b: { level: 'warning', message: 1 } }, invalid)).toBe(true);
    expect(store.statusOf('r2', 'a')).toBeUndefined();
    expect(store.statusOf('r2', 'b')).toEqual({ level: 'warning' });
    expect(invalid).toEqual(['r1', 'r1', 'r2/a']);
    expect(cellStatusInvalidMessage(invalid)).toContain('r2/a');
  });

  it('clear で全部消える', () => {
    const store = createCellStatusStore(undefined);
    store.replaceRow('r1', { a: { level: 'error' } }, []);
    store.clear();
    expect(store.hasAny()).toBe(false);
    expect(store.row('r1')).toBeUndefined();
  });
});
