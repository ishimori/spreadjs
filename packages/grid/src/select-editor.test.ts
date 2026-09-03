import { describe, expect, it } from 'vitest';

import { createSelectController, decideSelectKey } from './select-editor';
import type { SelectKeyInput } from './select-editor';

describe('createSelectController: 純粋状態（開閉・ハイライト）', () => {
  it('open で現値をハイライト（候補に含まれる場合）', () => {
    const c = createSelectController();
    expect(c.isOpen()).toBe(false);
    c.open({ options: ['進行中', '受注', '失注'], currentValue: '受注' });
    expect(c.isOpen()).toBe(true);
    expect(c.getHighlightedIndex()).toBe(1);
    expect(c.getHighlightedValue()).toBe('受注');
  });

  it('現値が候補に無ければ先頭をハイライト', () => {
    const c = createSelectController();
    c.open({ options: ['進行中', '受注'], currentValue: '(空)' });
    expect(c.getHighlightedIndex()).toBe(0);
  });

  it('highlightNext/Prev は端でクランプ（循環しない）', () => {
    const c = createSelectController();
    c.open({ options: ['a', 'b', 'c'], currentValue: 'a' });
    c.highlightPrev();
    expect(c.getHighlightedIndex()).toBe(0); // 端でクランプ
    c.highlightNext();
    c.highlightNext();
    expect(c.getHighlightedIndex()).toBe(2);
    c.highlightNext();
    expect(c.getHighlightedIndex()).toBe(2); // 端でクランプ
  });

  it('setHighlight はクランプ', () => {
    const c = createSelectController();
    c.open({ options: ['a', 'b'], currentValue: 'a' });
    c.setHighlight(99);
    expect(c.getHighlightedIndex()).toBe(1);
    c.setHighlight(-5);
    expect(c.getHighlightedIndex()).toBe(0);
  });

  it('close で状態リセット・閉じている間は操作が無効', () => {
    const c = createSelectController();
    c.open({ options: ['a', 'b'], currentValue: 'a' });
    c.close();
    expect(c.isOpen()).toBe(false);
    expect(c.getHighlightedIndex()).toBe(-1);
    expect(c.getHighlightedValue()).toBeNull();
    c.highlightNext();
    expect(c.getHighlightedIndex()).toBe(-1); // 閉じている間は no-op
  });
});

const NAV_SELECT_CLOSED: SelectKeyInput = {
  key: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  eventComposing: false,
  sessionComposing: false,
  phase: 'Navigation',
  isOpen: false,
  isSelectCell: true,
};

describe('decideSelectKey: IME 経路無改変の裁定（composition 中は必ず none）', () => {
  it('composition 中（DOM/内部いずれか）は必ず none', () => {
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'Enter', eventComposing: true })).toBe('none');
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'a', sessionComposing: true })).toBe('none');
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'ArrowDown', isOpen: true, sessionComposing: true })).toBe(
      'none',
    );
  });

  it('非 Navigation 位相は none（編集中のキーは状態機械へ）', () => {
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'Enter', phase: 'EditingExisting' })).toBe('none');
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'a', phase: 'Composing' })).toBe('none');
  });
});

describe('decideSelectKey: 閉じている選択式セルの編集開始キー（AC1）', () => {
  it('F2 / Enter / Alt+↓ / 印字文字 → open', () => {
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'F2' })).toBe('open');
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'Enter' })).toBe('open');
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'ArrowDown', altKey: true })).toBe('open');
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'x' })).toBe('open');
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'あ' })).toBe('open'); // 全角1字も印字扱い
  });

  it('修飾付きキー（Ctrl+Z 等）は open にしない（undo/redo 等を奪わない）', () => {
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'z', ctrlKey: true })).toBe('none');
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'ArrowDown' })).toBe('none'); // 素の↓は移動（open しない）
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'Delete' })).toBe('none');
  });

  it('F2/Enter は修飾なしのみ open（Shift+Enter=上移動・Ctrl/Alt 系を奪わない・P3-6）', () => {
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'Enter', shiftKey: true })).toBe('none');
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'Enter', ctrlKey: true })).toBe('none');
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'Enter', altKey: true })).toBe('none');
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'F2', shiftKey: true })).toBe('none');
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'F2', ctrlKey: true })).toBe('none');
  });

  it('非選択式セルは none（現行挙動・AC7）', () => {
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'Enter', isSelectCell: false })).toBe('none');
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'x', isSelectCell: false })).toBe('none');
  });
});

describe('decideSelectKey: open 中の裁定（AC1〜3）', () => {
  const open: SelectKeyInput = { ...NAV_SELECT_CLOSED, isOpen: true };
  it('↑↓/Enter/Esc/Tab を処理', () => {
    expect(decideSelectKey({ ...open, key: 'ArrowDown' })).toBe('move-down');
    expect(decideSelectKey({ ...open, key: 'ArrowUp' })).toBe('move-up');
    expect(decideSelectKey({ ...open, key: 'Enter' })).toBe('confirm');
    expect(decideSelectKey({ ...open, key: 'Escape' })).toBe('cancel');
    expect(decideSelectKey({ ...open, key: 'Tab' })).toBe('cancel');
  });
  it('open 中の他キーは consume（textarea 漏れ防止）', () => {
    expect(decideSelectKey({ ...open, key: 'a' })).toBe('consume');
    expect(decideSelectKey({ ...open, key: 'PageDown' })).toBe('consume');
  });
});
