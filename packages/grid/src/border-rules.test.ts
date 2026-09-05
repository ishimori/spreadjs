import { describe, expect, it } from 'vitest';
import { BorderConfigError, compileBorders, resolveBorder, type GridBorder, type GridRowBorders } from './border-rules';

const red = { color: '#ff0000', width: 2 };
const blue = { color: '#0000ff', width: 2 };
const normalize = (color: string): string | undefined => /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : undefined;

describe('DD-048 default / style', () => {
  it('共通線は現存行の下だけ、非連続ID・新規ID・最終行にもfallbackする', () => {
    const line: GridBorder = { ...red, width: 8, style: 'dotted' };
    const c = compileBorders({ r900: { top: blue }, r2: { bottom: red } }, undefined, ['a'], normalize, line);
    expect(c.hasRows).toBe(true);
    expect(c.row(undefined, undefined)).toBeUndefined();
    expect(c.row(undefined, 'r2')).toBeUndefined();
    expect(c.row('r2', 'r900')).toEqual(blue); // 同幅後側・共通より細い明示線が優先
    expect(c.row('r2', 'new')).toEqual(red);
    expect(c.row('new', 'r900')).toEqual(blue);
    expect(c.row('new', 'other')).toEqual(line);
    expect(c.row('other', undefined)).toEqual(line);
    expect(c.rowIds).toEqual(['r900', 'r2']); // 共通用IDを列挙しない
  });
  it.each(['solid', 'dotted', 'dashed'] as const)('style=%sを行列・共通で正規化、設定mutationから独立', (style) => {
    const value = { ...red, style };
    const c = compileBorders({ r0: { bottom: value } }, { a: { right: value } }, ['a'], normalize, value);
    const expected = style === 'solid' ? red : { ...red, style };
    value.width = 8;
    expect(c.row('r0', 'r1')).toEqual(expected);
    expect(c.row('new', undefined)).toEqual(expected);
    expect(c.column('a', undefined)).toEqual(expected);
    expect(Object.isFrozen(c.row('new', undefined))).toBe(true);
  });
  it.each([null, { ...red, style: 'double' }, { ...red, style: null }, { ...red, width: 0 }, { ...red, color: '' }])('不正共通設定を拒否 %j', (value) => {
    const invalid = value as unknown as GridBorder;
    expect(() => compileBorders(undefined, undefined, ['a'], normalize, invalid)).toThrow(BorderConfigError);
    expect(() => compileBorders({ r0: { bottom: invalid } }, undefined, ['a'], normalize)).toThrow(BorderConfigError);
    expect(() => compileBorders(undefined, { a: { left: invalid } }, ['a'], normalize)).toThrow(BorderConfigError);
  });
});

describe('DD-047 border configuration', () => {
  it('未指定・空・辺なしは描画なし', () => {
    const samples: Array<Readonly<Record<string, GridRowBorders>> | undefined> = [undefined, {}, { r0: {} }];
    for (const rows of samples) {
      const c = compileBorders(rows, {}, ['a'], normalize);
      expect(c.hasRows).toBe(false);
      expect(c.hasColumns).toBe(false);
      expect(c.row('r0', 'r1')).toBeUndefined();
    }
  });
  it('太さ優先、同幅は後側。設定の順番を逆にしても同じ', () => {
    expect(resolveBorder({ ...red, width: 3 }, blue)).toEqual({ ...red, width: 3 });
    expect(resolveBorder(red, blue)).toEqual(blue);
    for (const rows of [{ r0: { bottom: red }, r1: { top: blue } }, { r1: { top: blue }, r0: { bottom: red } }]) {
      const c = compileBorders(rows, { a: { right: red }, b: { left: blue } }, ['a', 'b'], normalize);
      expect(c.row('r0', 'r1')).toEqual(blue);
      expect(c.column('a', 'b')).toEqual(blue);
    }
  });
  it('現在の隣接IDで解決。挿入行へコピーせず削除・後着にも追従', () => {
    const c = compileBorders({ late: { top: red, bottom: blue } }, undefined, ['a'], normalize);
    expect(c.row('r0', 'new')).toBeUndefined();
    expect(c.row('new', 'late')).toEqual(red);
    expect(c.row('late', 'r1')).toEqual(blue);
    expect(c.row('new', 'r1')).toBeUndefined();
    expect(c.row(undefined, 'late')).toEqual(red);
    expect(c.row('late', undefined)).toEqual(blue);
    expect(c.rowIds).toEqual(['late']);
  });
  it('設定オブジェクトの後続mutationから独立', () => {
    const value = { ...red };
    const c = compileBorders({ r0: { top: value } }, undefined, ['a'], normalize);
    value.width = 8;
    value.color = '#000000';
    expect(c.row(undefined, 'r0')).toEqual(red);
    expect(Object.isFrozen(c.row(undefined, 'r0'))).toBe(true);
  });
  it.each([0, -1, 8.1, NaN, Infinity, -Infinity])('幅 %s を拒否', (width) => {
    expect(() => compileBorders({ r0: { top: { ...red, width } } }, undefined, ['a'], normalize)).toThrow(BorderConfigError);
  });
  it.each(['', ' ', 'not-a-color', 'var(--border)'])('色 %s を拒否', (color) => {
    expect(() => compileBorders(undefined, { a: { left: { ...red, color } } }, ['a'], normalize)).toThrow(BorderConfigError);
  });
  it('未知列を拒否、最小の正幅と8pxは受理', () => {
    expect(() => compileBorders(undefined, { missing: { right: red } }, ['a'], normalize)).toThrow(/未知の列/);
    const c = compileBorders({ r0: { top: { ...red, width: 0.1 }, bottom: { ...blue, width: 8 } } }, undefined, ['a'], normalize);
    expect(c.hasRows).toBe(true);
  });
});
