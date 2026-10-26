// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSelectDropdown, filterOptionsBySubstring } from './select-editor';

afterEach(() => document.body.replaceChildren());

function setup(searchable = true) {
  const host = document.createElement('div'); document.body.append(host);
  const onConfirm = vi.fn(); const onDismiss = vi.fn();
  const dropdown = createSelectDropdown({ host, onConfirm, onDismiss, visibleArea: () => ({ width: 600, height: 400 }) });
  dropdown.open({ rect: { x: 0, y: 0, width: 140, height: 39 }, options: ['未設定', '山田 太郎（ID:1）', '山田 太郎（ID:2）', '佐藤 花子'], currentValue: '未設定', searchable });
  const search = host.querySelector<HTMLInputElement>('input')!;
  const input = (value: string) => { search.value = value; search.dispatchEvent(new Event('input', { bubbles: true })); };
  return { host, dropdown, search, input, onConfirm, onDismiss };
}

describe('searchable select', () => {
  it('部分一致・全角英数・空白を正規化し、候補値と順序を保つ', () => {
    expect(filterOptionsBySubstring(['山田 太郎', '佐藤 花子', 'Alice Ｓｍｉｔｈ'], '太郎')).toEqual(['山田 太郎']);
    expect(filterOptionsBySubstring(['山田 太郎'], '田　太')).toEqual(['山田 太郎']);
    expect(filterOptionsBySubstring(['Alice Ｓｍｉｔｈ'], 'sMIt')).toEqual(['Alice Ｓｍｉｔｈ']);
  });
  it('検索欄に focus し、絞り込んでも同じ入力要素を保ち、ID付き候補だけを確定する', () => {
    const { dropdown, search, input, onConfirm } = setup();
    expect(document.activeElement).toBe(search);
    expect(dropdown.contains(search)).toBe(true);
    input('太郎');
    expect(document.activeElement).toBe(search);
    expect(dropdown.options()).toEqual(['山田 太郎（ID:1）', '山田 太郎（ID:2）']);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(dropdown.confirmValue()).toBe('山田 太郎（ID:2）');
  });
  it('不一致では未選択になり、検索文字列を値として返さない', () => {
    const { dropdown, host, input } = setup(); input('該当なし');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('候補がありません');
    expect(dropdown.confirmValue()).toBeNull();
  });
  it('検索を消すと全件に戻り、未設定を選べる', () => {
    const { dropdown, input } = setup(); input('花子'); input('');
    expect(dropdown.options()).toHaveLength(4);
    expect(dropdown.confirmValue()).toBe('未設定');
  });
  it('変換中・変換確定Enterでは候補を保存せず、確定文字で絞る', async () => {
    const { dropdown, search, input, onConfirm } = setup();
    search.dispatchEvent(new CompositionEvent('compositionstart'));
    input('花子');
    expect(dropdown.options()).toHaveLength(4);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    search.dispatchEvent(new CompositionEvent('compositionend'));
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(dropdown.options()).toEqual(['佐藤 花子']);
    await Promise.resolve();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
  it('Escapeと外部へのblurは確定を要求しない', () => {
    const { search, onDismiss, onConfirm } = setup();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onDismiss).toHaveBeenCalledWith(true);
    search.dispatchEvent(new FocusEvent('blur', { relatedTarget: document.body }));
    expect(onDismiss).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
  it('既定の選択欄は検索入力を持たず、前方一致の文字選択を維持する', () => {
    const { host, dropdown } = setup(false);
    expect(host.querySelector('input')).toBeNull();
    dropdown.typeCharacter('佐');
    expect(dropdown.confirmValue()).toBe('佐藤 花子');
  });
});
