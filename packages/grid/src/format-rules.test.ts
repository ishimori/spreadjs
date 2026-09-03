import { describe, expect, it } from 'vitest';

import { FormatRuleConfigError, compileFormatRules } from './format-rules';
import type { GridColumnFormatRule } from './format-rules';

const COLUMN_ORDER = ['col-0', 'col-1', 'col-2', 'col-3'];

describe('compileFormatRules: 書式なし（AC3・現行描画と一致）', () => {
  it('columnFormats 未指定 → 書式なし解決器（hasAny=false・全 getStyle=undefined）', () => {
    const c = compileFormatRules(undefined, COLUMN_ORDER);
    expect(c.hasAny()).toBe(false);
    expect(c.getStyle('col-3', '進行中')).toBeUndefined();
  });

  it('空 columnFormats → 書式なし解決器', () => {
    const c = compileFormatRules({}, COLUMN_ORDER);
    expect(c.hasAny()).toBe(false);
  });
});

describe('compileFormatRules: 完全一致 lookup（値ベース・v1）', () => {
  it('単一 match・複数 match（string[]）を列→値→style へ展開する', () => {
    const c = compileFormatRules(
      {
        'col-3': [
          { match: '進行中', style: { badge: true, badgeColor: '#34a853', textColor: '#ffffff' } },
          { match: ['受注', '成約'], style: { cellBackground: '#fde293' } },
        ],
      },
      COLUMN_ORDER,
    );
    expect(c.hasAny()).toBe(true);
    expect(c.getStyle('col-3', '進行中')).toEqual({ badge: true, badgeColor: '#34a853', textColor: '#ffffff' });
    // 複数 match は同一 style を共有する。
    expect(c.getStyle('col-3', '受注')).toEqual({ cellBackground: '#fde293' });
    expect(c.getStyle('col-3', '成約')).toEqual({ cellBackground: '#fde293' });
  });

  it('非一致値・未指定列は undefined（部分一致しない＝完全一致のみ）', () => {
    const c = compileFormatRules({ 'col-3': [{ match: '進行中', style: { cellBackground: '#eee' } }] }, COLUMN_ORDER);
    expect(c.getStyle('col-3', '進行')).toBeUndefined(); // 部分一致しない
    expect(c.getStyle('col-3', '進行中 ')).toBeUndefined(); // 末尾空白の違い
    expect(c.getStyle('col-2', '進行中')).toBeUndefined(); // 列違い
  });

  it('resolveStyle は定義フィールドのみを含み freeze される（不変・過剰キーなし）', () => {
    const c = compileFormatRules({ 'col-0': [{ match: 'x', style: { textColor: '#111' } }] }, COLUMN_ORDER);
    const style = c.getStyle('col-0', 'x')!;
    expect(style).toEqual({ textColor: '#111' });
    expect(Object.isFrozen(style)).toBe(true);
    expect(() => {
      (style as { cellBackground?: string }).cellBackground = '#000';
    }).toThrow();
  });
});

describe('compileFormatRules: fail-fast（AC8）', () => {
  it('未知列 → FormatRuleConfigError(unknown-column)', () => {
    try {
      compileFormatRules({ 'col-x': [{ match: 'a', style: { cellBackground: '#eee' } }] }, COLUMN_ORDER);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FormatRuleConfigError);
      expect((error as FormatRuleConfigError).reason).toBe('unknown-column');
      expect((error as FormatRuleConfigError).columnId).toBe('col-x');
    }
  });

  it('空ルール配列 → empty-rules', () => {
    try {
      compileFormatRules({ 'col-3': [] }, COLUMN_ORDER);
      expect.unreachable();
    } catch (error) {
      expect((error as FormatRuleConfigError).reason).toBe('empty-rules');
    }
  });

  it('同一列内の match 重複（別ルール間）→ duplicate-match', () => {
    try {
      compileFormatRules(
        {
          'col-3': [
            { match: '受注', style: { cellBackground: '#a' } },
            { match: '受注', style: { cellBackground: '#b' } },
          ],
        },
        COLUMN_ORDER,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as FormatRuleConfigError).reason).toBe('duplicate-match');
      expect((error as FormatRuleConfigError).columnId).toBe('col-3');
    }
  });

  it('同一ルール内の match 重複（string[] の重複）→ duplicate-match', () => {
    try {
      compileFormatRules({ 'col-3': [{ match: ['A', 'A'], style: { textColor: '#000' } }] }, COLUMN_ORDER);
      expect.unreachable();
    } catch (error) {
      expect((error as FormatRuleConfigError).reason).toBe('duplicate-match');
    }
  });

  it('空の match 配列 → empty-match（死にルールを黙認しない・Fable P2）', () => {
    try {
      compileFormatRules({ 'col-3': [{ match: [], style: { cellBackground: '#eee' } }] }, COLUMN_ORDER);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FormatRuleConfigError);
      expect((error as FormatRuleConfigError).reason).toBe('empty-match');
      expect((error as FormatRuleConfigError).columnId).toBe('col-3');
    }
  });

  it('空文字の match → empty-match（非空セルにしか書式は付かず永遠に一致しない・Fable P2）', () => {
    try {
      compileFormatRules({ 'col-3': [{ match: '', style: { cellBackground: '#eee' } }] }, COLUMN_ORDER);
      expect.unreachable();
    } catch (error) {
      expect((error as FormatRuleConfigError).reason).toBe('empty-match');
    }
    // string[] 内の空文字も同様に拒否する。
    try {
      compileFormatRules({ 'col-3': [{ match: ['受注', ''], style: { cellBackground: '#eee' } }] }, COLUMN_ORDER);
      expect.unreachable();
    } catch (error) {
      expect((error as FormatRuleConfigError).reason).toBe('empty-match');
    }
  });

  it('全ルールが空 match でも hasAny を true にしない（cheap path 保護＝fail-fast で mount 失敗）', () => {
    // 空 match が黙認されると byColumn に空 Map が入り hasAny=true になってしまう回帰の防止。
    expect(() =>
      compileFormatRules({ 'col-3': [{ match: [], style: { badge: true } }] }, COLUMN_ORDER),
    ).toThrow(FormatRuleConfigError);
  });

  it('別列の同一 match 値は重複ではない（列ごとに独立）', () => {
    const c = compileFormatRules(
      {
        'col-2': [{ match: '受注', style: { cellBackground: '#a' } }],
        'col-3': [{ match: '受注', style: { cellBackground: '#b' } }],
      },
      COLUMN_ORDER,
    );
    expect(c.getStyle('col-2', '受注')).toEqual({ cellBackground: '#a' });
    expect(c.getStyle('col-3', '受注')).toEqual({ cellBackground: '#b' });
  });
});

describe('compileFormatRules: 数値/文字列の正準性（😈 DA・Phase 1）', () => {
  // rule Map のキー＝表示文字列。数値セルの表示は cellScalarToDisplay の結果（"1234"）で lookup されるため、
  // ルールも表示文字列で書く（"1,234" のような桁区切りは表示に現れず一致しない）。この期待を固定する。
  it('数値セルの一致対象は表示文字列（"1234"）であり桁区切り "1,234" では一致しない', () => {
    const c = compileFormatRules(
      { 'col-1': [{ match: '1234', style: { textColor: '#c00' } }] },
      COLUMN_ORDER,
    );
    expect(c.getStyle('col-1', '1234')).toEqual({ textColor: '#c00' });
    expect(c.getStyle('col-1', '1,234')).toBeUndefined();
  });
});

// 型が公開契約として import できることの smoke（未使用でも型エラーで落ちれば検知される）。
const _typeSmoke: GridColumnFormatRule = { match: 'x', style: { badge: true } };
void _typeSmoke;
