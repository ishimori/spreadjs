import { describe, expect, it } from 'vitest';

import { DisplayConfigError, compileDisplayFormats } from './display-format';
import type { GridColumnDisplayFormat } from './display-format';

const COLUMN_ORDER = ['col-0', 'col-1', 'col-2', 'col-3'];

describe('compileDisplayFormats: 未指定（AC9・現行描画と一致）', () => {
  it('両オプション未指定 → hasAny=false・formatText=raw 恒等・captionFor=undefined', () => {
    const c = compileDisplayFormats(undefined, undefined, COLUMN_ORDER);
    expect(c.hasAny()).toBe(false);
    expect(c.formatText('col-1', '1234')).toBe('1234');
    expect(c.captionFor('col-1')).toBeUndefined();
  });

  it('空オブジェクト → hasAny=false', () => {
    const c = compileDisplayFormats({}, {}, COLUMN_ORDER);
    expect(c.hasAny()).toBe(false);
  });
});

describe('compileDisplayFormats: キャプション（AC1）', () => {
  it('指定列のキャプションを返し・未指定列は undefined', () => {
    const c = compileDisplayFormats(undefined, { 'col-1': '受注日', 'col-3': '状態' }, COLUMN_ORDER);
    expect(c.hasAny()).toBe(true);
    expect(c.captionFor('col-1')).toBe('受注日');
    expect(c.captionFor('col-3')).toBe('状態');
    expect(c.captionFor('col-0')).toBeUndefined();
  });

  it('キャプションだけでも hasAny=true（フック束縛のため）', () => {
    const c = compileDisplayFormats(undefined, { 'col-0': 'ID' }, COLUMN_ORDER);
    expect(c.hasAny()).toBe(true);
  });
});

describe('compileDisplayFormats: number 書式（AC3・文字列十進・決定的）', () => {
  const compile = (fmt: GridColumnDisplayFormat) =>
    compileDisplayFormats({ 'col-1': fmt }, undefined, COLUMN_ORDER);

  it('grouping=true で3桁カンマ区切り（decimals 未指定=raw の桁のまま・丸めなし）', () => {
    const c = compile({ type: 'number', grouping: true });
    expect(c.formatText('col-1', '1234567')).toBe('1,234,567');
    expect(c.formatText('col-1', '1234')).toBe('1,234');
    expect(c.formatText('col-1', '999')).toBe('999');
    expect(c.formatText('col-1', '1234.5')).toBe('1,234.5');
  });

  it('decimals=2 は half-up 丸め＋末尾ゼロ埋め（toFixed の2進誤差を回避）', () => {
    const c = compile({ type: 'number', decimals: 2 });
    expect(c.formatText('col-1', '1.5')).toBe('1.50');
    expect(c.formatText('col-1', '1.005')).toBe('1.01'); // half-up（float なら 1.00 になる）
    expect(c.formatText('col-1', '2.345')).toBe('2.35'); // half-up
    expect(c.formatText('col-1', '2.344')).toBe('2.34');
    expect(c.formatText('col-1', '0')).toBe('0.00');
  });

  it('decimals=0 は整数へ half-up 丸め（繰り上がりで桁が増える）', () => {
    const c = compile({ type: 'number', decimals: 0 });
    expect(c.formatText('col-1', '2.5')).toBe('3');
    expect(c.formatText('col-1', '2.4')).toBe('2');
    expect(c.formatText('col-1', '999.9')).toBe('1000');
  });

  it('負数: 符号を保ちつつ絶対値を整形（-0 は 0 へ正規化）', () => {
    const c = compile({ type: 'number', grouping: true, decimals: 1 });
    expect(c.formatText('col-1', '-1234.56')).toBe('-1,234.6');
    expect(c.formatText('col-1', '-0.04')).toBe('0.0'); // -0.04→-0.0→-0 を 0.0 に正規化
  });

  it('percent は丸めの前に小数点2桁右シフト → 末尾に %', () => {
    const c = compile({ type: 'number', percent: true, decimals: 1 });
    expect(c.formatText('col-1', '0.1234')).toBe('12.3%');
    expect(c.formatText('col-1', '0.5')).toBe('50.0%');
    expect(c.formatText('col-1', '1')).toBe('100.0%');
  });

  it('prefix/suffix と出力順（prefix + 本体 + % + suffix）', () => {
    const c = compile({ type: 'number', grouping: true, decimals: 0, prefix: '¥', suffix: ' 円' });
    expect(c.formatText('col-1', '1234567')).toBe('¥1,234,567 円');
    const pc = compile({ type: 'number', percent: true, decimals: 0, prefix: '達成 ', suffix: '（前年比）' });
    expect(pc.formatText('col-1', '0.87')).toBe('達成 87%（前年比）');
  });

  it('非数値 raw は素通し（NUMERIC_RE 不一致・書式済み文字列も再整形しない）', () => {
    const c = compile({ type: 'number', grouping: true });
    expect(c.formatText('col-1', 'abc')).toBe('abc');
    expect(c.formatText('col-1', '1,234')).toBe('1,234'); // 既にカンマ入り＝非数値
    expect(c.formatText('col-1', '')).toBe('');
    expect(c.formatText('col-1', '1.2.3')).toBe('1.2.3');
    expect(c.formatText('col-1', '1e3')).toBe('1e3'); // 指数表記は対象外
  });
});

describe('compileDisplayFormats: 負の数の表記（DD-059 AC1/AC2）', () => {
  const compile = (fmt: GridColumnDisplayFormat) =>
    compileDisplayFormats({ 'col-1': fmt }, undefined, COLUMN_ORDER);

  it('parentheses: 負の数を括弧で囲み、正の数と 0 はそのまま（AC1: -1234.5 → (1,235)）', () => {
    const c = compile({ type: 'number', grouping: true, decimals: 0, negative: { style: 'parentheses', color: '#c00' } });
    expect(c.formatText('col-1', '-1234.5')).toBe('(1,235)'); // 丸めは絶対値の half-up（0 から遠い側へ）
    expect(c.formatText('col-1', '1234')).toBe('1,234');
    expect(c.formatText('col-1', '0')).toBe('0');
  });

  it('triangle は ▲、minus と未指定は従来どおり -（AC2）', () => {
    const tri = compile({ type: 'number', grouping: true, decimals: 0, negative: { style: 'triangle' } });
    expect(tri.formatText('col-1', '-1234.5')).toBe('▲1,235');
    expect(tri.formatText('col-1', '1234.5')).toBe('1,235');
    const minus = compile({ type: 'number', grouping: true, decimals: 0, negative: { style: 'minus' } });
    expect(minus.formatText('col-1', '-1234.5')).toBe('-1,235');
    const none = compile({ type: 'number', grouping: true, decimals: 0 });
    expect(none.formatText('col-1', '-1234.5')).toBe('-1,235');
    const colorOnly = compile({ type: 'number', grouping: true, decimals: 0, negative: { color: 'red' } });
    expect(colorOnly.formatText('col-1', '-1234.5')).toBe('-1,235');
  });

  it('▲ は - と同じ位置（prefix の後）、括弧は prefix〜suffix の全体を囲む・% は本体に含む', () => {
    const tri = compile({ type: 'number', grouping: true, prefix: '¥', suffix: ' 円', negative: { style: 'triangle' } });
    expect(tri.formatText('col-1', '-1234')).toBe('¥▲1,234 円');
    const paren = compile({ type: 'number', grouping: true, prefix: '¥', suffix: ' 円', negative: { style: 'parentheses' } });
    expect(paren.formatText('col-1', '-1234')).toBe('(¥1,234 円)');
    expect(paren.formatText('col-1', '1234')).toBe('¥1,234 円');
    const pct = compile({ type: 'number', percent: true, decimals: 1, negative: { style: 'parentheses' } });
    expect(pct.formatText('col-1', '-0.1234')).toBe('(12.3%)');
  });

  it('0 に丸まる負数は負として扱わない（括弧・▲ を付けない＝-0 正規化を維持）', () => {
    const paren = compile({ type: 'number', decimals: 1, negative: { style: 'parentheses' } });
    expect(paren.formatText('col-1', '-0.04')).toBe('0.0');
    expect(paren.formatText('col-1', '-0')).toBe('0.0');
    const tri = compile({ type: 'number', decimals: 0, negative: { style: 'triangle' } });
    expect(tri.formatText('col-1', '-0.4')).toBe('0');
    expect(tri.formatText('col-1', '-0.5')).toBe('▲1'); // half-up で 1 へ繰り上がる＝負のまま
  });

  it('非数値 raw は素通し（負の数の書式も付けない）', () => {
    const c = compile({ type: 'number', grouping: true, negative: { style: 'parentheses', color: '#c00' } });
    expect(c.formatText('col-1', '-abc')).toBe('-abc');
    expect(c.formatText('col-1', '-')).toBe('-');
    expect(c.formatText('col-1', '-1,234')).toBe('-1,234');
    expect(c.formatText('col-1', '')).toBe('');
  });
});

describe('compileDisplayFormats: 描画テキストの装飾（DD-059 色・括弧の右余白）', () => {
  const compile = (fmt: GridColumnDisplayFormat) =>
    compileDisplayFormats({ 'col-1': fmt }, undefined, COLUMN_ORDER);

  it('parentheses＋color: 負の数は色、正の数と 0 は右余白 `)`', () => {
    const c = compile({ type: 'number', grouping: true, decimals: 0, negative: { style: 'parentheses', color: '#c00' } });
    expect(c.hasDecorations()).toBe(true);
    expect(c.decorationFor('col-1', '-1234.5')).toEqual({ textColor: '#c00' });
    expect(c.decorationFor('col-1', '1234')).toEqual({ trailingPad: ')' });
    expect(c.decorationFor('col-1', '0')).toEqual({ trailingPad: ')' });
  });

  it('color だけなら負の数だけに色（正の数は装飾なし）・parentheses だけなら色なしで右余白だけ', () => {
    const colorOnly = compile({ type: 'number', negative: { color: 'red' } });
    expect(colorOnly.decorationFor('col-1', '-5')).toEqual({ textColor: 'red' });
    expect(colorOnly.decorationFor('col-1', '5')).toBeUndefined();
    const parenOnly = compile({ type: 'number', negative: { style: 'parentheses' } });
    expect(parenOnly.decorationFor('col-1', '-5')).toBeUndefined();
    expect(parenOnly.decorationFor('col-1', '5')).toEqual({ trailingPad: ')' });
  });

  it('0 に丸まる負数は正の数と同じ扱い（色を付けず括弧列なら右余白）', () => {
    const c = compile({ type: 'number', decimals: 1, negative: { style: 'parentheses', color: '#c00' } });
    expect(c.decorationFor('col-1', '-0.04')).toEqual({ trailingPad: ')' });
    expect(c.decorationFor('col-1', '-0.05')).toEqual({ textColor: '#c00' }); // -0.1 へ丸まる＝負
  });

  it('非数値 raw・装飾のない列・未知列・書式のない列は undefined', () => {
    const c = compileDisplayFormats(
      {
        'col-1': { type: 'number', negative: { style: 'parentheses', color: '#c00' } },
        'col-2': { type: 'number', grouping: true },
        'col-3': { type: 'number', negative: { style: 'triangle' } },
      },
      undefined,
      COLUMN_ORDER,
    );
    expect(c.decorationFor('col-1', 'abc')).toBeUndefined();
    expect(c.decorationFor('col-1', '-abc')).toBeUndefined();
    expect(c.decorationFor('col-1', '')).toBeUndefined();
    expect(c.decorationFor('col-2', '-5')).toBeUndefined();
    expect(c.decorationFor('col-3', '-5')).toBeUndefined(); // ▲ は文字だけで表せる＝装飾なし
    expect(c.decorationFor('col-0', '-5')).toBeUndefined();
  });

  it('hasDecorations は color か parentheses のある列があるときだけ true（cheap path）', () => {
    expect(compileDisplayFormats(undefined, undefined, COLUMN_ORDER).hasDecorations()).toBe(false);
    expect(compile({ type: 'number', grouping: true }).hasDecorations()).toBe(false);
    expect(compile({ type: 'number', negative: { style: 'triangle' } }).hasDecorations()).toBe(false);
    expect(compile({ type: 'number', negative: {} }).hasDecorations()).toBe(false);
    expect(compile({ type: 'number', negative: { color: 'red' } }).hasDecorations()).toBe(true);
    expect(compile({ type: 'number', negative: { style: 'parentheses' } }).hasDecorations()).toBe(true);
  });

  it('装飾は列ごとの不変オブジェクト（描画ホットパスで毎回生成しない）', () => {
    const c = compile({ type: 'number', negative: { style: 'parentheses', color: '#c00' } });
    expect(c.decorationFor('col-1', '-1')).toBe(c.decorationFor('col-1', '-2'));
    expect(c.decorationFor('col-1', '1')).toBe(c.decorationFor('col-1', '2'));
    expect(Object.isFrozen(c.decorationFor('col-1', '-1'))).toBe(true);
    expect(Object.isFrozen(c.decorationFor('col-1', '1'))).toBe(true);
  });
});

describe('compileDisplayFormats: date 書式（AC4・フィールド直取り・TZ 非経由）', () => {
  const compile = (pattern: string) =>
    compileDisplayFormats({ 'col-2': { type: 'date', pattern } }, undefined, COLUMN_ORDER);

  it('YYYY-MM-DD をトークン置換（リテラルは素通し）', () => {
    const c = compile('YYYY/MM/DD');
    expect(c.formatText('col-2', '2026-07-21')).toBe('2026/07/21');
    const jp = compile('YYYY年MM月DD日');
    expect(jp.formatText('col-2', '2026-07-21')).toBe('2026年07月21日');
  });

  it('日時形（T 区切り・空白区切り・秒あり/なし）を受理', () => {
    const c = compile('YYYY-MM-DD HH:mm:ss');
    expect(c.formatText('col-2', '2026-07-21T09:05:03')).toBe('2026-07-21 09:05:03');
    expect(c.formatText('col-2', '2026-07-21 09:05:03')).toBe('2026-07-21 09:05:03');
    const hm = compile('HH:mm');
    expect(hm.formatText('col-2', '2026-07-21T09:05')).toBe('09:05');
  });

  it('非受理形（数値シリアル・和暦・スラッシュ入力）は raw 素通し', () => {
    const c = compile('YYYY/MM/DD');
    expect(c.formatText('col-2', '46000')).toBe('46000');
    expect(c.formatText('col-2', '令和8年')).toBe('令和8年');
    expect(c.formatText('col-2', '2026/07/21')).toBe('2026/07/21'); // 入力がスラッシュ形＝非受理
    expect(c.formatText('col-2', '')).toBe('');
  });

  it('時刻欠落 raw に時刻トークン → raw 素通し（00 を埋めない）', () => {
    const c = compile('YYYY-MM-DD HH:mm');
    expect(c.formatText('col-2', '2026-07-21')).toBe('2026-07-21'); // HH/mm 欠落 → 全体 raw
    const withSec = compile('HH:mm:ss');
    expect(withSec.formatText('col-2', '2026-07-21T09:05')).toBe('2026-07-21T09:05'); // ss 欠落 → raw
  });

  it('date-only パターンは日時 raw でも日付フィールドで整形（時刻は落とす）', () => {
    const c = compile('YYYY.MM.DD');
    expect(c.formatText('col-2', '2026-07-21T09:05:03')).toBe('2026.07.21');
  });
});

describe('compileDisplayFormats: fail-fast（AC7・code=column-display-invalid の写像対象）', () => {
  const reasonOf = (fn: () => unknown): string => {
    try {
      fn();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DisplayConfigError);
      return (error as DisplayConfigError).reason;
    }
    return '';
  };

  it('未知列（caption / displayFormat 双方）→ unknown-column', () => {
    expect(reasonOf(() => compileDisplayFormats(undefined, { 'col-x': 'X' }, COLUMN_ORDER))).toBe('unknown-column');
    expect(
      reasonOf(() => compileDisplayFormats({ 'col-x': { type: 'number' } }, undefined, COLUMN_ORDER)),
    ).toBe('unknown-column');
  });

  it('空/空白キャプション → empty-caption', () => {
    expect(reasonOf(() => compileDisplayFormats(undefined, { 'col-1': '' }, COLUMN_ORDER))).toBe('empty-caption');
    expect(reasonOf(() => compileDisplayFormats(undefined, { 'col-1': '   ' }, COLUMN_ORDER))).toBe('empty-caption');
  });

  it('不正 type → invalid-type', () => {
    expect(
      reasonOf(() =>
        compileDisplayFormats(
          { 'col-1': { type: 'currency' } as unknown as GridColumnDisplayFormat },
          undefined,
          COLUMN_ORDER,
        ),
      ),
    ).toBe('invalid-type');
  });

  it('decimals が非整数/範囲外（0〜20外）→ invalid-decimals', () => {
    const bad = (d: number) =>
      reasonOf(() => compileDisplayFormats({ 'col-1': { type: 'number', decimals: d } }, undefined, COLUMN_ORDER));
    expect(bad(1.5)).toBe('invalid-decimals');
    expect(bad(-1)).toBe('invalid-decimals');
    expect(bad(21)).toBe('invalid-decimals');
    // 境界は許可（throw しない）。
    expect(() =>
      compileDisplayFormats({ 'col-1': { type: 'number', decimals: 0 } }, undefined, COLUMN_ORDER),
    ).not.toThrow();
    expect(() =>
      compileDisplayFormats({ 'col-1': { type: 'number', decimals: 20 } }, undefined, COLUMN_ORDER),
    ).not.toThrow();
  });

  it('pattern 空/既知トークン皆無 → invalid-pattern', () => {
    expect(
      reasonOf(() => compileDisplayFormats({ 'col-2': { type: 'date', pattern: '' } }, undefined, COLUMN_ORDER)),
    ).toBe('invalid-pattern');
    expect(
      reasonOf(() =>
        compileDisplayFormats({ 'col-2': { type: 'date', pattern: '年月日' } }, undefined, COLUMN_ORDER),
      ),
    ).toBe('invalid-pattern');
  });

  it('negative の不正 style・空/空白/非文字列 color・非オブジェクト → invalid-negative（DD-059 AC4）', () => {
    const bad = (negative: unknown) =>
      reasonOf(() =>
        compileDisplayFormats(
          { 'col-1': { type: 'number', negative } as unknown as GridColumnDisplayFormat },
          undefined,
          COLUMN_ORDER,
        ),
      );
    expect(bad({ style: 'brackets' })).toBe('invalid-negative');
    expect(bad({ style: '' })).toBe('invalid-negative');
    expect(bad({ color: '' })).toBe('invalid-negative');
    expect(bad({ color: '   ' })).toBe('invalid-negative');
    expect(bad({ color: 0xcc0000 })).toBe('invalid-negative');
    expect(bad('parentheses')).toBe('invalid-negative');
    expect(bad(null)).toBe('invalid-negative');
    // 受理値（3 種の style・色だけ・空オブジェクト）は throw しない。
    for (const negative of [{ style: 'minus' }, { style: 'parentheses' }, { style: 'triangle' }, { color: '#c00' }, {}]) {
      expect(() =>
        compileDisplayFormats(
          { 'col-1': { type: 'number', negative } as unknown as GridColumnDisplayFormat },
          undefined,
          COLUMN_ORDER,
        ),
      ).not.toThrow();
    }
  });

  it('invalid-negative の message は列と不正値を含む', () => {
    try {
      compileDisplayFormats(
        { 'col-1': { type: 'number', negative: { style: 'brackets' } } as unknown as GridColumnDisplayFormat },
        undefined,
        COLUMN_ORDER,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as DisplayConfigError).columnId).toBe('col-1');
      expect((error as DisplayConfigError).message).toContain('col-1');
      expect((error as DisplayConfigError).message).toContain('brackets');
    }
  });

  it('DisplayConfigError は columnId と message を保持する', () => {
    try {
      compileDisplayFormats(undefined, { 'col-x': 'X' }, COLUMN_ORDER);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DisplayConfigError);
      expect((error as DisplayConfigError).columnId).toBe('col-x');
      expect((error as DisplayConfigError).message).toContain('col-x');
      expect((error as DisplayConfigError).name).toBe('DisplayConfigError');
    }
  });
});

describe('compileDisplayFormats: 併用相互作用（AC7・wrap=fail-fast / link=fail-fast / select=許可）', () => {
  it('wrapColumns 同一列に表示書式 → wrap-conflict', () => {
    try {
      compileDisplayFormats(
        { 'col-1': { type: 'number', grouping: true } },
        undefined,
        COLUMN_ORDER,
        { isWrapColumn: (id) => id === 'col-1' },
      );
      expect.unreachable();
    } catch (error) {
      expect((error as DisplayConfigError).reason).toBe('wrap-conflict');
      expect((error as DisplayConfigError).columnId).toBe('col-1');
    }
  });

  it('link 列に表示書式 → link-conflict', () => {
    try {
      compileDisplayFormats(
        { 'col-2': { type: 'date', pattern: 'YYYY-MM-DD' } },
        undefined,
        COLUMN_ORDER,
        { isLinkColumn: (id) => id === 'col-2' },
      );
      expect.unreachable();
    } catch (error) {
      expect((error as DisplayConfigError).reason).toBe('link-conflict');
    }
  });

  it('wrap/link 列でも caption は許可（ヘッダーのみ・セル描画契約に影響しない）', () => {
    const c = compileDisplayFormats(
      undefined,
      { 'col-1': 'ラベルA', 'col-2': 'ラベルB' },
      COLUMN_ORDER,
      { isWrapColumn: (id) => id === 'col-1', isLinkColumn: (id) => id === 'col-2' },
    );
    expect(c.captionFor('col-1')).toBe('ラベルA');
    expect(c.captionFor('col-2')).toBe('ラベルB');
  });

  it('select 列（wrap/link でない）への表示書式は許可（構造不整合なし）', () => {
    expect(() =>
      compileDisplayFormats(
        { 'col-1': { type: 'number', grouping: true } },
        undefined,
        COLUMN_ORDER,
        { isWrapColumn: () => false, isLinkColumn: () => false },
      ),
    ).not.toThrow();
  });
});

describe('compileDisplayFormats: columnFormats 併用の判定不変（AC6・match は raw）', () => {
  it('formatText は表示専用で、compile 結果は raw→display 写像であって raw を変えない', () => {
    // number 列 col-1 に grouping。raw "1234" の display は "1,234" だが、columnFormats の match は
    // raw（"1234"）で行う契約＝本関数は formatText（display）だけを提供し、match には関与しない。
    const c = compileDisplayFormats({ 'col-1': { type: 'number', grouping: true } }, undefined, COLUMN_ORDER);
    expect(c.formatText('col-1', '1234')).toBe('1,234');
    // 未指定列は素通し（columnFormats の match 対象 raw と一致する）。
    expect(c.formatText('col-3', '進行中')).toBe('進行中');
  });
});

// 型が公開契約として import できることの smoke。
const _numberSmoke: GridColumnDisplayFormat = { type: 'number', grouping: true, decimals: 2 };
const _dateSmoke: GridColumnDisplayFormat = { type: 'date', pattern: 'YYYY-MM-DD' };
const _negativeSmoke: GridColumnDisplayFormat = { type: 'number', grouping: true, negative: { style: 'parentheses', color: '#c00' } };
void _numberSmoke;
void _dateSmoke;
void _negativeSmoke;
