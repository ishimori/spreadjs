// parseCellInput（型変換・標準セット）の受理書式表と偽陽性防止の網羅テスト（DD-012-1 AC3）。
import { describe, expect, it } from 'vitest';

import { parseCellInput } from './cell-input';

describe('parseCellInput: number（受理書式表）', () => {
  const cases: Array<[string, number]> = [
    ['123', 123],
    ['0', 0],
    ['-5', -5],
    ['007', 7], // 純数字の先頭0は数値（スプレッドシート標準）
    ['1.5', 1.5],
    ['0.25', 0.25],
    ['-0.5', -0.5],
    ['1,234', 1234],
    ['1,234,567', 1234567],
    ['-1,234', -1234],
    ['1,234.5', 1234.5],
    ['１２３', 123], // 全角数字
    ['－５', -5], // 全角マイナス + 全角数字
    ['１，２３４．５', 1234.5], // 全角の桁区切り + 小数
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → number ${expected}`, () => {
      expect(parseCellInput(input)).toEqual({ kind: 'number', value: expected });
    });
  }
});

describe('parseCellInput: date（→ LocalDate YYYY-MM-DD 正準化）', () => {
  const cases: Array<[string, string]> = [
    ['2026-07-13', '2026-07-13'],
    ['2026/07/13', '2026-07-13'], // '/' → 正準 '-'
    ['2026-7-3', '2026-07-03'], // 1桁月日 → 0埋め
    ['２０２６／７／３', '2026-07-03'], // 全角数字＋全角スラッシュ → 正準化
    ['2024-02-29', '2024-02-29'], // 閏年 2/29
    ['2000-02-29', '2000-02-29'], // 400年閏
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → date ${expected}`, () => {
      expect(parseCellInput(input)).toEqual({ kind: 'date', value: expected });
    });
  }
});

describe('parseCellInput: string（偽陽性防止＝非該当は入力どおり保持）', () => {
  const strings = [
    '', // これは blank だが下で別途
    '090-1234-5678', // 電話番号（年4桁でない・3グループ）
    '03-1234-5678', // 電話番号
    '123-4567', // 郵便番号（年4桁でない）
    'ABC-123', // 型番（英字混在）
    'A1', // セル参照風コード
    '型番123', // 日本語混在
    '2026-13-01', // 実在しない月 → string
    '2026-02-30', // 2月30日 → string
    '2023-02-29', // 平年の2/29 → string
    '2026-00-10', // 月0 → string
    '2026-07-32', // 日32 → string
    '1,23', // 不正な桁区切り（2桁群）
    '12,34', // 不正な桁区切り
    '1,2345', // 4桁群
    ' 123 ', // 前後空白付き（全体一致でないため変換しない）
    '1.2.3', // 複数小数点
    '-', // 符号のみ
    '1e5', // 指数表記は標準セット外 → string
    '+5', // 明示プラス符号は標準セット外 → string
  ];
  for (const s of strings) {
    if (s === '') continue;
    it(`"${s}" → string（そのまま）`, () => {
      expect(parseCellInput(s)).toEqual({ kind: 'string', value: s });
    });
  }

  it('"" → blank', () => {
    expect(parseCellInput('')).toEqual({ kind: 'blank' });
  });
});

describe('parseCellInput: forceString（RC12・DD-052-2）', () => {
  it('数値に見える文字列も forceString: true では string のまま（先頭ゼロ電話番号の保持）', () => {
    expect(parseCellInput('09012345678', { forceString: true })).toEqual({ kind: 'string', value: '09012345678' });
  });

  it('日付に見える文字列も forceString: true では string のまま', () => {
    expect(parseCellInput('2026-07-13', { forceString: true })).toEqual({ kind: 'string', value: '2026-07-13' });
  });

  it('forceString: true でも空文字は blank のまま', () => {
    expect(parseCellInput('', { forceString: true })).toEqual({ kind: 'blank' });
  });

  it('forceString: false または未指定は従来どおり型変換する', () => {
    expect(parseCellInput('123', { forceString: false })).toEqual({ kind: 'number', value: 123 });
    expect(parseCellInput('123')).toEqual({ kind: 'number', value: 123 });
  });
});
