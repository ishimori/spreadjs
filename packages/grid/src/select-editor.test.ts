import { describe, expect, it } from 'vitest';

import { createSelectController, decideSelectKey, filterOptionsByPrefix } from './select-editor';
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

describe('filterOptionsByPrefix: 前方一致の絞り込み（DD-037 決定③）', () => {
  const OPTIONS = ['A-100', 'A-200', 'B-100', 'あいうえお', 'あかさたな'];

  it('空プレフィクスは全件（絞り込み前の初期表示）', () => {
    expect(filterOptionsByPrefix(OPTIONS, '')).toEqual(OPTIONS);
  });

  it('前方一致だけを返す（部分一致は含めない）', () => {
    expect(filterOptionsByPrefix(OPTIONS, 'A-')).toEqual(['A-100', 'A-200']);
    expect(filterOptionsByPrefix(OPTIONS, 'A-1')).toEqual(['A-100']);
    expect(filterOptionsByPrefix(OPTIONS, '100')).toEqual([]); // 部分一致は対象外
  });

  it('日本語も前方一致で絞れる（IME 変換中の draft を想定）', () => {
    expect(filterOptionsByPrefix(OPTIONS, 'あ')).toEqual(['あいうえお', 'あかさたな']);
    expect(filterOptionsByPrefix(OPTIONS, 'あい')).toEqual(['あいうえお']);
  });

  it('大小文字は無視する（品番コードの実用性）', () => {
    expect(filterOptionsByPrefix(OPTIONS, 'a-2')).toEqual(['A-200']);
  });

  it('候補外の入力は 0 件（呼び出し側が閉じる＝自由入力の邪魔をしない）', () => {
    expect(filterOptionsByPrefix(OPTIONS, 'マスタに無い品番')).toEqual([]);
  });

  it('元配列を変更しない（純関数）', () => {
    const source = ['a', 'b'];
    filterOptionsByPrefix(source, 'a');
    expect(source).toEqual(['a', 'b']);
  });
});

describe('createSelectController: suggest モード（ハイライト無しで開く・絞り込み・DD-037）', () => {
  it('highlight:false で開くとハイライト無し＝Enter は入力文字列を確定する側に倒れる（決定④）', () => {
    const c = createSelectController();
    c.open({ options: ['A-100', 'A-200'], currentValue: 'A-100', highlight: false });
    expect(c.isOpen()).toBe(true);
    expect(c.getHighlightedIndex()).toBe(-1);
    expect(c.getHighlightedValue()).toBeNull();
  });

  it('ハイライト無しから ↑↓ で候補を選べる（先頭から始まる）', () => {
    const c = createSelectController();
    c.open({ options: ['A-100', 'A-200'], currentValue: '', highlight: false });
    c.highlightNext();
    expect(c.getHighlightedValue()).toBe('A-100');
  });

  it('setOptions は開いたまま候補を差し替え、ハイライトを解除する', () => {
    const c = createSelectController();
    c.open({ options: ['A-100', 'A-200', 'B-100'], currentValue: 'A-200' });
    expect(c.getHighlightedIndex()).toBe(1);
    c.setOptions(['A-100', 'A-200']);
    expect(c.getOptions()).toEqual(['A-100', 'A-200']);
    expect(c.getHighlightedIndex()).toBe(-1); // 絞り込みで勝手に選ばない
  });

  it('閉じている間の setOptions は no-op', () => {
    const c = createSelectController();
    c.setOptions(['A-100']);
    expect(c.isOpen()).toBe(false);
    expect(c.getOptions()).toEqual([]);
  });

  it('既定（highlight 省略）は従来どおり現値をハイライト＝picker の挙動不変', () => {
    const c = createSelectController();
    c.open({ options: ['A-100', 'A-200'], currentValue: 'A-200' });
    expect(c.getHighlightedIndex()).toBe(1);
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

describe('decideSelectKey: 自由入力併存モード（DD-037 決定①）', () => {
  const free: SelectKeyInput = { ...NAV_SELECT_CLOSED, allowsFreeText: true };

  it('印字文字は open にしない（textarea 編集を開始させる＝候補外を打ち切れる）', () => {
    expect(decideSelectKey({ ...free, key: 'x' })).toBe('none');
    expect(decideSelectKey({ ...free, key: 'あ' })).toBe('none');
    expect(decideSelectKey({ ...free, key: '1' })).toBe('none');
  });

  it('明示操作（F2 / Enter / Alt+↓）では候補を開く＝候補 UI は厳格モードと同じ発見性', () => {
    expect(decideSelectKey({ ...free, key: 'F2' })).toBe('open');
    expect(decideSelectKey({ ...free, key: 'Enter' })).toBe('open');
    expect(decideSelectKey({ ...free, key: 'ArrowDown', altKey: true })).toBe('open');
  });

  it('厳格モード（既定・allowsFreeText 未指定/false）は印字文字で open＝DD-027-1 の挙動不変', () => {
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'x' })).toBe('open');
    expect(decideSelectKey({ ...NAV_SELECT_CLOSED, key: 'x', allowsFreeText: false })).toBe('open');
  });

  it('非選択式セルは自由入力併存でも none（現行挙動）', () => {
    expect(decideSelectKey({ ...free, key: 'F2', isSelectCell: false })).toBe('none');
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
