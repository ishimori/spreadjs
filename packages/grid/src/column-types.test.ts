import { describe, expect, it } from 'vitest';

import { ColumnTypeConfigError, createColumnTypeRegistry, isAbsoluteHttpUrl } from './column-types';
import type { GridColumnType } from './column-types';

const COLUMN_ORDER = ['col-0', 'col-1', 'col-2', 'col-3'];

describe('createColumnTypeRegistry: fail-fast 検証（AC8）', () => {
  it('columnTypes 未指定なら型なし registry（現行挙動＝全列自由入力・AC7）', () => {
    const reg = createColumnTypeRegistry(undefined, COLUMN_ORDER);
    expect(reg.hasAnySelectColumn()).toBe(false);
    expect(reg.isSelectColumn('col-3')).toBe(false);
    expect(reg.allowsFreeText('col-3')).toBe(true);
    expect(reg.getSelectOptions('col-3')).toBeUndefined();
  });

  it('空 columnTypes も型なし registry', () => {
    const reg = createColumnTypeRegistry({}, COLUMN_ORDER);
    expect(reg.hasAnySelectColumn()).toBe(false);
  });

  it('未知列 → ColumnTypeConfigError(unknown-column)', () => {
    expect(() =>
      createColumnTypeRegistry({ 'col-x': { type: 'select', options: ['a'] } }, COLUMN_ORDER),
    ).toThrowError(ColumnTypeConfigError);
    try {
      createColumnTypeRegistry({ 'col-x': { type: 'select', options: ['a'] } }, COLUMN_ORDER);
    } catch (error) {
      expect(error).toBeInstanceOf(ColumnTypeConfigError);
      expect((error as ColumnTypeConfigError).reason).toBe('unknown-column');
      expect((error as ColumnTypeConfigError).columnId).toBe('col-x');
    }
  });

  it('候補 0 件 → empty-options', () => {
    try {
      createColumnTypeRegistry({ 'col-3': { type: 'select', options: [] } }, COLUMN_ORDER);
      expect.unreachable();
    } catch (error) {
      expect((error as ColumnTypeConfigError).reason).toBe('empty-options');
    }
  });

  it('候補重複 → duplicate-options', () => {
    try {
      createColumnTypeRegistry(
        { 'col-3': { type: 'select', options: ['受注', '受注'] } },
        COLUMN_ORDER,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ColumnTypeConfigError).reason).toBe('duplicate-options');
    }
  });

  it('未対応 type → unsupported-type', () => {
    const bogus = { 'col-3': { type: 'radio', options: ['a'] } } as unknown as Record<string, GridColumnType>;
    try {
      createColumnTypeRegistry(bogus, COLUMN_ORDER);
      expect.unreachable();
    } catch (error) {
      expect((error as ColumnTypeConfigError).reason).toBe('unsupported-type');
    }
  });

  it('候補が値解釈で round-trip しない → option-not-round-trip（決定⑥・Fable 5 P2-3）', () => {
    // "1,000" は数値 1000 に解釈され表示 "1000" になり round-trip しない。
    try {
      createColumnTypeRegistry({ 'col-3': { type: 'select', options: ['受注', '1,000'] } }, COLUMN_ORDER);
      expect.unreachable();
    } catch (error) {
      expect((error as ColumnTypeConfigError).reason).toBe('option-not-round-trip');
      expect((error as ColumnTypeConfigError).message).toContain('1,000'); // 違反候補
      expect((error as ColumnTypeConfigError).message).toContain('1000'); // 正規化後表示
    }
    // 前ゼロ "01" は数値 1 に正規化され round-trip しない。
    try {
      createColumnTypeRegistry({ 'col-3': { type: 'select', options: ['01'] } }, COLUMN_ORDER);
      expect.unreachable();
    } catch (error) {
      expect((error as ColumnTypeConfigError).reason).toBe('option-not-round-trip');
    }
  });

  it('文字列候補（進行中/受注/失注）は round-trip して受理される', () => {
    expect(() =>
      createColumnTypeRegistry({ 'col-3': { type: 'select', options: ['進行中', '受注', '失注'] } }, COLUMN_ORDER),
    ).not.toThrow();
  });
});

describe('ColumnTypeRegistry: 参照系', () => {
  const reg = createColumnTypeRegistry(
    {
      'col-3': { type: 'select', options: ['進行中', '受注', '失注'] },
      'col-1': { type: 'select', options: ['A', 'B'], allowFreeText: true },
    },
    COLUMN_ORDER,
  );

  it('選択式列の候補・自由入力可否を返す', () => {
    expect(reg.hasAnySelectColumn()).toBe(true);
    expect(reg.isSelectColumn('col-3')).toBe(true);
    expect(reg.getSelectOptions('col-3')).toEqual(['進行中', '受注', '失注']);
    expect(reg.allowsFreeText('col-3')).toBe(false);
    expect(reg.allowsFreeText('col-1')).toBe(true);
  });

  it('非選択式列は制約なし（自由入力可）', () => {
    expect(reg.isSelectColumn('col-0')).toBe(false);
    expect(reg.allowsFreeText('col-0')).toBe(true);
    expect(reg.getSelectOptions('col-0')).toBeUndefined();
  });
});

describe('ハイパーリンク列（DD-027-2）: registry・fail-fast・非退行', () => {
  it('link 列を受理し isLinkColumn/getLinkType/hasAnyLinkColumn を返す', () => {
    const reg = createColumnTypeRegistry(
      { 'col-3': { type: 'link' }, 'col-2': { type: 'link', defaultOpen: true } },
      COLUMN_ORDER,
    );
    expect(reg.hasAnyLinkColumn()).toBe(true);
    expect(reg.isLinkColumn('col-3')).toBe(true);
    expect(reg.isLinkColumn('col-2')).toBe(true);
    expect(reg.getLinkType('col-3')).toEqual({ type: 'link' });
    expect(reg.getLinkType('col-2')).toEqual({ type: 'link', defaultOpen: true });
  });

  it('link 列は選択式ではなく editor 経路は制約なし（T1 非該当・素通り＝DD-027-1 非退行）', () => {
    const reg = createColumnTypeRegistry({ 'col-3': { type: 'link' } }, COLUMN_ORDER);
    expect(reg.isSelectColumn('col-3')).toBe(false);
    expect(reg.hasAnySelectColumn()).toBe(false);
    expect(reg.getSelectOptions('col-3')).toBeUndefined();
    expect(reg.allowsFreeText('col-3')).toBe(true);
    expect(reg.validateEditorCommit('col-3', 'https://example.com/x').allowed).toBe(true);
  });

  it('select と link の混在: それぞれ独立に判定する', () => {
    const reg = createColumnTypeRegistry(
      { 'col-1': { type: 'select', options: ['A', 'B'] }, 'col-3': { type: 'link' } },
      COLUMN_ORDER,
    );
    expect(reg.isSelectColumn('col-1')).toBe(true);
    expect(reg.isLinkColumn('col-1')).toBe(false);
    expect(reg.isSelectColumn('col-3')).toBe(false);
    expect(reg.isLinkColumn('col-3')).toBe(true);
    expect(reg.hasAnySelectColumn()).toBe(true);
    expect(reg.hasAnyLinkColumn()).toBe(true);
  });

  it('link 列 × wrapColumns 併用 → wrap-link-conflict で fail-fast', () => {
    try {
      createColumnTypeRegistry({ 'col-3': { type: 'link' } }, COLUMN_ORDER, ['col-3']);
      expect.unreachable();
    } catch (error) {
      expect((error as ColumnTypeConfigError).reason).toBe('wrap-link-conflict');
      expect((error as ColumnTypeConfigError).columnId).toBe('col-3');
    }
  });

  it('link 列と別列の wrap は併用可（衝突は同一列のときだけ）', () => {
    expect(() =>
      createColumnTypeRegistry({ 'col-3': { type: 'link' } }, COLUMN_ORDER, ['col-2']),
    ).not.toThrow();
  });

  it('未知 type は従来どおり unsupported-type（link 追加で select の fail-fast を退行させない）', () => {
    const bogus = { 'col-3': { type: 'radio' } } as unknown as Record<string, GridColumnType>;
    try {
      createColumnTypeRegistry(bogus, COLUMN_ORDER);
      expect.unreachable();
    } catch (error) {
      expect((error as ColumnTypeConfigError).reason).toBe('unsupported-type');
    }
  });
});

describe('isAbsoluteHttpUrl（DD-027-2・defaultOpen の open 可否）', () => {
  it('絶対 http/https URL は true', () => {
    expect(isAbsoluteHttpUrl('https://example.com/detail/1')).toBe(true);
    expect(isAbsoluteHttpUrl('http://example.com')).toBe(true);
    expect(isAbsoluteHttpUrl('HTTPS://EXAMPLE.COM')).toBe(true); // protocol は小文字化される
  });

  it('javascript:/data:/file: 等の危険/非 http スキームは false', () => {
    expect(isAbsoluteHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isAbsoluteHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isAbsoluteHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isAbsoluteHttpUrl('ftp://example.com')).toBe(false);
  });

  it('相対 URL・非 URL 文字列・空文字は false（base を渡さないため相対は構築失敗）', () => {
    expect(isAbsoluteHttpUrl('/detail/1')).toBe(false);
    expect(isAbsoluteHttpUrl('detail/1')).toBe(false);
    expect(isAbsoluteHttpUrl('ただのテキスト')).toBe(false);
    expect(isAbsoluteHttpUrl('')).toBe(false);
  });
});

describe('validateEditorCommit: editor 経路の commit 前検証（AC4/AC5/AC6）', () => {
  const reg = createColumnTypeRegistry(
    {
      'col-3': { type: 'select', options: ['進行中', '受注', '失注'] },
      'col-1': { type: 'select', options: ['A', 'B'], allowFreeText: true },
    },
    COLUMN_ORDER,
  );

  it('選択式（allowFreeText:false）: 候補一致は許可・非候補は拒否（AC4）', () => {
    expect(reg.validateEditorCommit('col-3', '受注').allowed).toBe(true);
    const rejected = reg.validateEditorCommit('col-3', 'なんでも');
    expect(rejected.allowed).toBe(false);
    expect(rejected.value).toBe('なんでも'); // 拒否値を含む
    expect(rejected.columnId).toBe('col-3');
  });

  it('選択式でも空文字（クリア）は常に許可（ユーザーを閉じ込めない）', () => {
    expect(reg.validateEditorCommit('col-3', '').allowed).toBe(true);
  });

  it('allowFreeText:true 列は候補外も許可（AC5）', () => {
    expect(reg.validateEditorCommit('col-1', '任意テキスト').allowed).toBe(true);
  });

  it('非選択式列は常に許可（現行挙動・AC7）', () => {
    expect(reg.validateEditorCommit('col-0', '任意').allowed).toBe(true);
  });
});
