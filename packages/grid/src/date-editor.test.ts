// DD-035 R2 unit: 日付カレンダーの純関数（LocalDate 加減算・月グリッド）・状態コントローラ・keydown 前段裁定。
// DOM アダプタ（ポップオーバー・インジケーター）は E2E（date-column.spec.ts）が担う。

import { describe, expect, it } from 'vitest';

import {
  addDays,
  addMonths,
  buildMonthGrid,
  createCalendarController,
  daysInMonth,
  decideDateKey,
  isLocalDate,
  todayLocalDate,
  weekdayOf,
  type DateKeyInput,
} from './date-editor';

describe('LocalDate 純関数', () => {
  it('isLocalDate は YYYY-MM-DD の実在暦日のみ true', () => {
    expect(isLocalDate('2026-07-31')).toBe(true);
    expect(isLocalDate('2024-02-29')).toBe(true);
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2026/07/31')).toBe(false); // 正準形以外（core が正準化する前の手入力形）は false
    expect(isLocalDate('')).toBe(false);
    expect(isLocalDate('abc')).toBe(false);
  });

  it('addDays は月末・年末・閏日を跨ぐ（UTC 経由でタイムゾーン非依存）', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-07-15', 7)).toBe('2026-07-22');
    expect(addDays('2026-07-15', -7)).toBe('2026-07-08');
  });

  it('addMonths は日を移動先の月末で clamp し年を跨ぐ', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('2026-01-15', 12)).toBe('2027-01-15');
  });

  it('年境界（Codex P2）: 0001〜9999 年を外れる移動は no-op・0〜99 年を 1900 年代へ写像しない', () => {
    expect(addDays('9999-12-31', 1)).toBe('9999-12-31');
    expect(addDays('0001-01-01', -1)).toBe('0001-01-01');
    expect(addMonths('9999-12-15', 1)).toBe('9999-12-15');
    expect(addMonths('0001-01-15', -1)).toBe('0001-01-15');
    expect(addDays('0050-06-15', 1)).toBe('0050-06-16');
    expect(addMonths('0050-01-31', 1)).toBe('0050-02-28');
    expect(addDays('9999-12-30', 1)).toBe('9999-12-31');
    expect(isLocalDate(addDays('0099-12-31', 1))).toBe(true);
    expect(addDays('0099-12-31', 1)).toBe('0100-01-01');
  });

  it('daysInMonth / weekdayOf', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(weekdayOf('2026-09-03')).toBe(4); // 木
    expect(weekdayOf('2026-09-06')).toBe(0); // 日
  });

  it('buildMonthGrid は日曜始まり 42 セル・前後月は inMonth=false', () => {
    const grid = buildMonthGrid(2026, 9); // 2026-09-01 は火曜
    expect(grid).toHaveLength(42);
    expect(grid[0]).toEqual({ date: '2026-08-30', inMonth: false });
    expect(grid[2]).toEqual({ date: '2026-09-01', inMonth: true });
    expect(grid[31]).toEqual({ date: '2026-09-30', inMonth: true });
    expect(grid[32]).toEqual({ date: '2026-10-01', inMonth: false });
    expect(grid.filter((c) => c.inMonth)).toHaveLength(30);
    expect(weekdayOf(grid[0]!.date)).toBe(0);
  });

  it('todayLocalDate はローカル日付フィールドで組む（注入した Date から）', () => {
    expect(todayLocalDate(new Date(2026, 8, 3, 23, 59))).toBe('2026-09-03');
    expect(todayLocalDate(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });
});

describe('createCalendarController', () => {
  it('open: 現値が LocalDate ならそれを、そうでなければ today をハイライトし月を追従する', () => {
    const c = createCalendarController();
    expect(c.isOpen()).toBe(false);
    expect(c.getHighlighted()).toBeNull();
    c.open({ currentValue: '2026-07-31', today: '2026-09-03' });
    expect(c.isOpen()).toBe(true);
    expect(c.getHighlighted()).toBe('2026-07-31');
    expect(c.getViewMonth()).toEqual({ year: 2026, month: 7 });
    c.close();
    c.open({ currentValue: 'abc', today: '2026-09-03' });
    expect(c.getHighlighted()).toBe('2026-09-03');
    expect(c.getViewMonth()).toEqual({ year: 2026, month: 9 });
    c.close();
    c.open({ currentValue: '', today: '2026-09-03' });
    expect(c.getHighlighted()).toBe('2026-09-03');
  });

  it('moveDays/moveMonths/setHighlight は表示月を追従し、閉じていれば無視', () => {
    const c = createCalendarController();
    c.moveDays(1);
    expect(c.getHighlighted()).toBeNull();
    c.open({ currentValue: '2026-01-30', today: '2026-09-03' });
    c.moveDays(2);
    expect(c.getHighlighted()).toBe('2026-02-01');
    expect(c.getViewMonth()).toEqual({ year: 2026, month: 2 });
    c.moveMonths(-2);
    expect(c.getHighlighted()).toBe('2025-12-01');
    expect(c.getViewMonth()).toEqual({ year: 2025, month: 12 });
    c.setHighlight('2026-03-15');
    expect(c.getHighlighted()).toBe('2026-03-15');
    c.setHighlight('bad'); // 非日付は無視
    expect(c.getHighlighted()).toBe('2026-03-15');
  });

  it('confirmValue はハイライト値を返して閉じる', () => {
    const c = createCalendarController();
    expect(c.confirmValue()).toBeNull();
    c.open({ currentValue: '2026-07-31', today: '2026-09-03' });
    c.moveDays(-1);
    expect(c.confirmValue()).toBe('2026-07-30');
    expect(c.isOpen()).toBe(false);
    expect(c.getHighlighted()).toBeNull();
  });
});

describe('decideDateKey（keydown 前段裁定）', () => {
  const base: DateKeyInput = {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    eventComposing: false,
    sessionComposing: false,
    phase: 'Navigation',
    isOpen: false,
    isDateCell: true,
    openOn: 'dblclick',
  };
  const decide = (over: Partial<DateKeyInput>): string => decideDateKey({ ...base, ...over });

  it('composition 中・非 Navigation は常に none（IME 経路無改変）', () => {
    expect(decide({ key: 'Enter', eventComposing: true })).toBe('none');
    expect(decide({ key: 'Enter', sessionComposing: true, isOpen: true })).toBe('none');
    expect(decide({ key: 'F2', phase: 'EditingReplace' })).toBe('none');
    expect(decide({ key: 'ArrowDown', phase: 'EditingReplace', isOpen: true })).toBe('none');
  });

  it('閉じている日付セル: Alt+↓ は常に open、F2/Enter（修飾なし）は openOn=dblclick のみ open、印字文字は none（手入力併存）', () => {
    expect(decide({ key: 'ArrowDown', altKey: true })).toBe('open');
    expect(decide({ key: 'ArrowDown', altKey: true, openOn: 'icon' })).toBe('open');
    expect(decide({ key: 'F2' })).toBe('open');
    expect(decide({ key: 'Enter' })).toBe('open');
    expect(decide({ key: 'F2', openOn: 'icon' })).toBe('none');
    expect(decide({ key: 'Enter', openOn: 'icon' })).toBe('none');
    expect(decide({ key: 'Enter', shiftKey: true })).toBe('none'); // Shift+Enter=確定して上移動を奪わない
    expect(decide({ key: 'F2', ctrlKey: true })).toBe('none');
    expect(decide({ key: 'a' })).toBe('none');
    expect(decide({ key: '2' })).toBe('none');
    expect(decide({ key: 'ArrowDown' })).toBe('none');
    expect(decide({ key: 'Delete' })).toBe('none');
  });

  it('非日付セルでは常に none', () => {
    expect(decide({ key: 'F2', isDateCell: false })).toBe('none');
    expect(decide({ key: 'ArrowDown', altKey: true, isDateCell: false })).toBe('none');
  });

  it('open 中: 矢印=日移動・PageUp/Down=月移動・Enter=confirm・Esc/Tab=cancel・他は consume', () => {
    expect(decide({ key: 'ArrowLeft', isOpen: true })).toBe('move-left');
    expect(decide({ key: 'ArrowRight', isOpen: true })).toBe('move-right');
    expect(decide({ key: 'ArrowUp', isOpen: true })).toBe('move-up');
    expect(decide({ key: 'ArrowDown', isOpen: true })).toBe('move-down');
    expect(decide({ key: 'PageUp', isOpen: true })).toBe('prev-month');
    expect(decide({ key: 'PageDown', isOpen: true })).toBe('next-month');
    expect(decide({ key: 'Enter', isOpen: true })).toBe('confirm');
    expect(decide({ key: 'Escape', isOpen: true })).toBe('cancel');
    expect(decide({ key: 'Tab', isOpen: true })).toBe('cancel');
    expect(decide({ key: 'a', isOpen: true })).toBe('consume');
    expect(decide({ key: 'Delete', isOpen: true })).toBe('consume');
    expect(decide({ key: 'F2', isOpen: true })).toBe('consume');
  });
});
