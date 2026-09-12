import { describe, expect, it } from 'vitest';

import { DEFAULT_GRID_LAYOUT, type CellPosition, cellKey } from './geometry';
import {
  type EditorEvent,
  type Effect,
  createEditorStateMachine,
} from './editor-state-machine';

// scenarios.md（44 シナリオ・Q-1〜5 ユーザー合意済み）を編集状態機械へコード化する。
// synthetic composition/keyboard/input 列で駆動し、確定 Enter 抑止（順序A/B）・
// pendingNavigation（§11.6）・MarkConflictOnly（§11.7）を機械検証する。
// 実 IME の候補ウィンドウ・ブラウザー間イベント順は再現しない（Phase 6 受入試験で判定）。

const A1: CellPosition = { row: 0, col: 0 };
const A2: CellPosition = { row: 1, col: 0 };
const B1: CellPosition = { row: 0, col: 1 };
const B2: CellPosition = { row: 1, col: 1 };
const C3: CellPosition = { row: 2, col: 2 };
const B5: CellPosition = { row: 4, col: 1 };

function makeMachine(options?: {
  initialCell?: CellPosition;
  values?: ReadonlyArray<readonly [CellPosition, string]>;
  wrapColumns?: ReadonlySet<number>;
}) {
  const values = new Map<string, string>();
  for (const [cell, value] of options?.values ?? []) {
    values.set(cellKey(cell), value);
  }
  return createEditorStateMachine({
    layout: DEFAULT_GRID_LAYOUT,
    initialCell: options?.initialCell ?? A1,
    getCellValue: (cell) => values.get(cellKey(cell)) ?? '',
    isWrapColumn: options?.wrapColumns === undefined ? undefined : (cell) => options.wrapColumns!.has(cell.col),
  });
}

/** 種別で効果を取り出す（型述語で絞り込み・as 不使用）。 */
function effectOf<K extends Effect['type']>(
  effects: readonly Effect[],
  type: K,
): Extract<Effect, { type: K }> | undefined {
  return effects.find((e): e is Extract<Effect, { type: K }> => e.type === type);
}

function types(effects: readonly Effect[]): string[] {
  return effects.map((e) => e.type);
}

// --- 素の値ヘルパ（synthetic イベント列を簡潔に組む） ---
const keydown = (
  key: string,
  opts?: { isComposing?: boolean; shiftKey?: boolean; altKey?: boolean },
): EditorEvent => ({
  type: 'keydown',
  key,
  isComposing: opts?.isComposing ?? false,
  shiftKey: opts?.shiftKey ?? false,
  altKey: opts?.altKey ?? false,
});
const keyup = (key: string, isComposing = false): EditorEvent => ({ type: 'keyup', key, isComposing });
const input = (value: string, isComposing = false): EditorEvent => ({ type: 'input', value, isComposing });

// ===========================================================================
// A. Navigation 状態（編集に入らない）
// ===========================================================================
describe('A. Navigation', () => {
  it('S-A1: ArrowDown で下へ 1 移動・Navigation のまま・BeginEdit なし', () => {
    const m = makeMachine();
    const effects = m.dispatch(keydown('ArrowDown'));
    expect(m.getActiveCell()).toEqual(A2);
    expect(m.getPhase()).toBe('Navigation');
    expect(effectOf(effects, 'BeginEdit')).toBeUndefined();
    expect(effectOf(effects, 'Move')?.direction).toBe('down');
  });

  it('S-A2: 端 A1 での ArrowUp / ArrowLeft はクランプし移動しない', () => {
    const m = makeMachine();
    m.dispatch(keydown('ArrowUp'));
    expect(m.getActiveCell()).toEqual(A1);
    m.dispatch(keydown('ArrowLeft'));
    expect(m.getActiveCell()).toEqual(A1);
    expect(m.getPhase()).toBe('Navigation');
  });

  it('S-A3: Enter=下 / Shift+Enter=上 / Tab=右 / Shift+Tab=左（編集しない）', () => {
    const m = makeMachine({ initialCell: B2 });
    expect(effectOf(m.dispatch(keydown('Enter')), 'Move')?.direction).toBe('down');
    const m2 = makeMachine({ initialCell: B2 });
    expect(effectOf(m2.dispatch(keydown('Enter', { shiftKey: true })), 'Move')?.direction).toBe('up');
    const m3 = makeMachine({ initialCell: B2 });
    expect(effectOf(m3.dispatch(keydown('Tab')), 'Move')?.direction).toBe('right');
    const m4 = makeMachine({ initialCell: B2 });
    expect(effectOf(m4.dispatch(keydown('Tab', { shiftKey: true })), 'Move')?.direction).toBe('left');
    expect(m.getPhase()).toBe('Navigation');
  });

  it('S-A4: Delete は選択セルをクリア（Commit(cell,"")）・移動しない・Navigation のまま', () => {
    const m = makeMachine({ initialCell: A1, values: [[A1, '値あり']] });
    const effects = m.dispatch(keydown('Delete'));
    expect(effectOf(effects, 'Commit')).toEqual({ type: 'Commit', cell: A1, value: '' });
    expect(effectOf(effects, 'Move')).toBeUndefined();
    expect(m.getActiveCell()).toEqual(A1);
    expect(m.getPhase()).toBe('Navigation');
  });

  it('S-A5: pointerdown{別セル} でクリック先を選択（MoveTo）', () => {
    const m = makeMachine();
    const effects = m.dispatch({ type: 'pointerdown', target: 'cell', cell: C3 });
    expect(effectOf(effects, 'MoveTo')?.cell).toEqual(C3);
    expect(m.getActiveCell()).toEqual(C3);
    expect(m.getPhase()).toBe('Navigation');
  });

  it('S-A6: pointerdown{ヘッダー/範囲外} は何もしない（None）', () => {
    const m = makeMachine();
    expect(m.dispatch({ type: 'pointerdown', target: 'header' })).toEqual([]);
    expect(m.dispatch({ type: 'pointerdown', target: 'outside' })).toEqual([]);
    expect(m.getActiveCell()).toEqual(A1);
  });
});

// ===========================================================================
// B. 直接入力（EditingReplace・非 IME / ASCII）
// ===========================================================================
describe('B. 直接入力（EditingReplace）', () => {
  it('S-B1: 既存値を捨て printable で置換編集を開始（値の正は input 後・I-1）', () => {
    const m = makeMachine({ values: [[A1, 'old']] });
    // keydown だけでは編集を起こさない（I-1）。
    expect(m.dispatch(keydown('a'))).toEqual([]);
    expect(m.getPhase()).toBe('Navigation');
    const effects = m.dispatch(input('a'));
    expect(effectOf(effects, 'BeginEdit')).toEqual({
      type: 'BeginEdit',
      mode: 'replace',
      cell: A1,
      initialValue: '',
    });
    expect(m.getPhase()).toBe('EditingReplace');
    expect(m.getDraft()).toBe('a');
  });

  it('S-B2: 続けて入力すると draft が伸びる（EditingReplace のまま）', () => {
    const m = makeMachine({ values: [[A1, 'old']] });
    m.dispatch(input('a'));
    m.dispatch(input('ab'));
    expect(m.getDraft()).toBe('ab');
    expect(m.getPhase()).toBe('EditingReplace');
  });

  it('S-B3: Enter で Commit → 下移動 → Navigation', () => {
    const m = makeMachine();
    m.dispatch(input('ab'));
    const effects = m.dispatch(keydown('Enter'));
    expect(effectOf(effects, 'Commit')).toEqual({ type: 'Commit', cell: A1, value: 'ab' });
    expect(effectOf(effects, 'Move')?.direction).toBe('down');
    expect(m.getActiveCell()).toEqual(A2);
    expect(m.getPhase()).toBe('Navigation');
  });

  it('S-B4: commit-Enter 直後の Enter は通常移動（混同しない）', () => {
    const m = makeMachine();
    m.dispatch(input('ab'));
    m.dispatch(keydown('Enter')); // commit + move → A2
    m.dispatch(keyup('Enter'));
    const effects = m.dispatch(keydown('Enter')); // 通常移動
    expect(effectOf(effects, 'Commit')).toBeUndefined();
    expect(effectOf(effects, 'Move')?.direction).toBe('down');
  });

  it('S-B5: Tab で Commit → 右移動', () => {
    const m = makeMachine();
    m.dispatch(input('ab'));
    const effects = m.dispatch(keydown('Tab'));
    expect(effectOf(effects, 'Commit')).toEqual({ type: 'Commit', cell: A1, value: 'ab' });
    expect(effectOf(effects, 'Move')?.direction).toBe('right');
    expect(m.getActiveCell()).toEqual(B1);
  });

  it('S-B6: Escape で Cancel（元値のまま・移動しない）', () => {
    const m = makeMachine({ values: [[A1, 'old']] });
    m.dispatch(input('ab'));
    const effects = m.dispatch(keydown('Escape'));
    expect(types(effects)).toEqual(['Cancel']);
    expect(m.getPhase()).toBe('Navigation');
    expect(m.getActiveCell()).toEqual(A1);
    expect(m.getDraft()).toBe('');
  });

  it('S-B7: 空セルでも printable で EditingReplace 開始', () => {
    const m = makeMachine();
    m.dispatch(input('x'));
    expect(m.getPhase()).toBe('EditingReplace');
    expect(m.getDraft()).toBe('x');
  });
});

// ===========================================================================
// C. 既存値編集（EditingExisting・F2 / ダブルクリック）
// ===========================================================================
describe('C. 既存値編集（EditingExisting）', () => {
  it('S-C1: F2 で既存値を初期値に編集開始', () => {
    const m = makeMachine({ values: [[A1, '山田']] });
    const effects = m.dispatch({ type: 'f2' });
    expect(effectOf(effects, 'BeginEdit')).toEqual({
      type: 'BeginEdit',
      mode: 'existing',
      cell: A1,
      initialValue: '山田',
    });
    expect(m.getPhase()).toBe('EditingExisting');
    expect(m.getDraft()).toBe('山田');
  });

  it('S-C2: ダブルクリックで既存値編集', () => {
    const m = makeMachine({ values: [[A1, '山田']] });
    const effects = m.dispatch({ type: 'doubleClick', cell: A1 });
    expect(effectOf(effects, 'BeginEdit')?.initialValue).toBe('山田');
    expect(m.getDraft()).toBe('山田');
  });

  it('S-C3: 追記して Enter で Commit → 下移動', () => {
    const m = makeMachine({ values: [[A1, '山田']] });
    m.dispatch({ type: 'f2' });
    m.dispatch(input('山田子'));
    const effects = m.dispatch(keydown('Enter'));
    expect(effectOf(effects, 'Commit')).toEqual({ type: 'Commit', cell: A1, value: '山田子' });
    expect(effectOf(effects, 'Move')?.direction).toBe('down');
  });

  it('S-C4: Escape で Cancel（既存値のまま）', () => {
    const m = makeMachine({ values: [[A1, '山田']] });
    m.dispatch({ type: 'f2' });
    const effects = m.dispatch(keydown('Escape'));
    expect(types(effects)).toEqual(['Cancel']);
    expect(m.getPhase()).toBe('Navigation');
  });

  it('S-C5: 空セルの F2 は初期値 "" で編集開始', () => {
    const m = makeMachine();
    m.dispatch({ type: 'f2' });
    expect(m.getPhase()).toBe('EditingExisting');
    expect(m.getDraft()).toBe('');
  });

  it('S-C6 ★回帰（DD-012-3）: F2 後にキャレット先頭で IME 挿入 → compositionend が base+data 近似で上書きしない', () => {
    // 実機再現（2026-07-15 ユーザー報告）: 「柿食えば」を F2 → キャレットを先頭へ → 「いいい」を変換確定 → blur
    // で「柿食えばいいい」になる。変換中 input（isComposing=true）は実 textarea 値「いいい柿食えば」を運んで
    // いるのに、compositionend の暫定確定（compositionBase+data・キャレット末尾前提）が正値を壊していた。
    // 順序B（Chromium 150 実測）: compositionend の後に確定 input は来ない → 近似値がそのまま Commit される。
    const m = makeMachine({ values: [[A1, '柿食えば']] });
    m.dispatch({ type: 'f2' });
    // （キャレット移動の矢印キーは編集中は textarea 委譲＝機械イベントなし）
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: 'い' });
    m.dispatch(input('い柿食えば', true));
    m.dispatch({ type: 'compositionupdate', data: 'いい' });
    m.dispatch(input('いい柿食えば', true));
    m.dispatch({ type: 'compositionupdate', data: 'いいい' });
    m.dispatch(input('いいい柿食えば', true));
    m.dispatch({ type: 'compositionend', data: 'いいい' });
    // 順序B: これ以降 input は来ない。draft は実 textarea 値を保持していること。
    expect(m.getDraft()).toBe('いいい柿食えば');
    // 確定 Enter の keyup（抑止窓クローズ）→ 独立 Enter で commit（実機の確定→確定操作列）。
    m.dispatch(keyup('Enter'));
    const effects = m.dispatch(keydown('Enter'));
    expect(effectOf(effects, 'Commit')).toEqual({ type: 'Commit', cell: A1, value: 'いいい柿食えば' });
  });

  it('S-C7 ★回帰（DD-012-3）: 変換中 input が来ない環境では従来どおり base+data で暫定確定（後退なし）', () => {
    const m = makeMachine({ values: [[A1, '柿食えば']] });
    m.dispatch({ type: 'f2' });
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: 'いいい' });
    m.dispatch({ type: 'compositionend', data: 'いいい' });
    // input イベントが一切来ない synthetic/特殊環境: キャレット末尾前提の近似のまま（従来挙動を維持）。
    expect(m.getDraft()).toBe('柿食えばいいい');
  });
});

// ===========================================================================
// D. IME 変換（Composing・確定 Enter と通常 Enter の区別）★中核
// ===========================================================================
describe('D. IME 変換（確定 Enter 抑止）', () => {
  it('S-D1: compositionstart→update で Composing・draft 追従（BeginEdit replace 経由）', () => {
    const m = makeMachine();
    const started = m.dispatch({ type: 'compositionstart' });
    expect(effectOf(started, 'BeginEdit')?.mode).toBe('replace');
    expect(m.getPhase()).toBe('Composing');
    expect(m.isComposing()).toBe(true);
    m.dispatch({ type: 'compositionupdate', data: 'にほ' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    expect(m.getDraft()).toBe('日本');
  });

  it('S-D2: compositionend→input で確定値を採用（まだ Commit/移動しない）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    m.dispatch({ type: 'compositionend', data: '日本' });
    expect(m.getPhase()).toBe('EditingAwaitFinalInput');
    const effects = m.dispatch(input('日本', false));
    expect(effectOf(effects, 'Commit')).toBeUndefined();
    expect(effectOf(effects, 'Move')).toBeUndefined();
    expect(m.getDraft()).toBe('日本');
    expect(m.getPhase()).toBe('EditingReplace');
  });

  it('S-D3 ★（順序A）: composition 中の確定 Enter を抑止（Commit/Move しない）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    const effects = m.dispatch(keydown('Enter', { isComposing: true }));
    expect(types(effects)).toEqual(['SuppressKey']);
    expect(m.getActiveCell()).toEqual(A1);
  });

  it('S-D4 ★: 確定の次の独立 Enter で Commit → 下移動（受け入れ #2）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    m.dispatch(keydown('Enter', { isComposing: true })); // 確定 Enter（抑止）
    m.dispatch({ type: 'compositionend', data: '日本' });
    m.dispatch(input('日本', false));
    m.dispatch(keyup('Enter'));
    const effects = m.dispatch(keydown('Enter')); // 独立した次の Enter
    expect(effectOf(effects, 'Commit')).toEqual({ type: 'Commit', cell: A1, value: '日本' });
    expect(effectOf(effects, 'Move')?.direction).toBe('down');
    expect(m.getActiveCell()).toEqual(A2);
  });

  it('S-D5 ★（順序B）: compositionend 後の Enter を keyup まで抑止', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    m.dispatch({ type: 'compositionend', data: '日本' });
    m.dispatch(input('日本', false));
    const suppressed = m.dispatch(keydown('Enter')); // 順序B の確定 Enter
    expect(types(suppressed)).toEqual(['SuppressKey']);
    m.dispatch(keyup('Enter')); // フラグ解除
    const commit = m.dispatch(keydown('Enter')); // 以後の独立 Enter で commit
    expect(effectOf(commit, 'Commit')).toEqual({ type: 'Commit', cell: A1, value: '日本' });
    expect(effectOf(commit, 'Move')?.direction).toBe('down');
  });

  it('S-D6: keyCode 229 相当（key="Process"）を主判定にしない（I-2）', () => {
    const m = makeMachine();
    const effects = m.dispatch({ type: 'keydown', key: 'Process', code: 'KeyA', isComposing: false });
    expect(effects).toEqual([]);
    expect(m.getPhase()).toBe('Navigation');
    expect(m.getActiveCell()).toEqual(A1);
  });

  it('S-D7: 確定→下移動直後の即 composition で先頭欠落なく Composing 開始', () => {
    const m = makeMachine();
    m.dispatch(input('あ'));
    m.dispatch(keydown('Enter')); // commit + move → A2
    m.dispatch(keyup('Enter'));
    expect(m.getActiveCell()).toEqual(A2);
    const started = m.dispatch({ type: 'compositionstart' });
    expect(effectOf(started, 'BeginEdit')?.cell).toEqual(A2);
    expect(m.getPhase()).toBe('Composing');
  });

  it('S-D8: composition 中の矢印はナビ移動にしない（抑止・アクティブセル不動）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    const effects = m.dispatch(keydown('ArrowDown', { isComposing: true }));
    expect(types(effects)).toEqual(['SuppressKey']);
    expect(m.getActiveCell()).toEqual(A1);
  });

  it('S-D9: composition 中の Tab はセル移動にしない（抑止）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    const effects = m.dispatch(keydown('Tab', { isComposing: true }));
    expect(types(effects)).toEqual(['SuppressKey']);
    expect(m.getActiveCell()).toEqual(A1);
  });

  it('S-D10: composition 中 Escape（1回目）は編集を Cancel しない（IME 取消優先）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: 'にほん' });
    const effects = m.dispatch(keydown('Escape', { isComposing: true }));
    expect(effects).toEqual([]);
    expect(m.getPhase()).toBe('Composing');
  });

  it('S-D11: composition 取消後の Escape（2回目）で初めて Cancel', () => {
    const m = makeMachine({ values: [[A1, 'orig']] });
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: 'にほん' });
    m.dispatch(keydown('Escape', { isComposing: true })); // IME 取消
    m.dispatch({ type: 'compositionend', data: '' }); // composition だけ取消
    m.dispatch(input('', false));
    expect(m.getPhase()).toBe('EditingReplace');
    const effects = m.dispatch(keydown('Escape')); // 2 回目 = 編集取消
    expect(types(effects)).toEqual(['Cancel']);
    expect(m.getPhase()).toBe('Navigation');
    expect(m.getActiveCell()).toEqual(A1);
  });
});

// ===========================================================================
// E. 変換中に別セルクリック（pendingNavigation・§11.6）★
// ===========================================================================
describe('E. 変換中クリック（pendingNavigation）', () => {
  it('S-E1 ★: 変換中クリックは pendingNavigation として保持（composition 継続・移動しない）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    const effects = m.dispatch({ type: 'pointerdown', target: 'cell', cell: C3 });
    expect(effectOf(effects, 'SetPendingNavigation')?.cell).toEqual(C3);
    expect(m.getPhase()).toBe('Composing');
    expect(m.getPendingNavigation()).toEqual(C3);
    expect(m.getActiveCell()).toEqual(A1);
    expect(m.getDraft()).toBe('日本');
  });

  it('S-E2 ★: 最終 input 後に競合なければ Commit → クリック先へ MoveTo', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    m.dispatch({ type: 'pointerdown', target: 'cell', cell: C3 });
    m.dispatch({ type: 'compositionend', data: '日本' });
    const effects = m.dispatch(input('日本', false));
    expect(effectOf(effects, 'Commit')).toEqual({ type: 'Commit', cell: A1, value: '日本' });
    expect(effectOf(effects, 'MoveTo')?.cell).toEqual(C3);
    expect(effectOf(effects, 'ClearPendingNavigation')).toBeDefined();
    expect(m.getActiveCell()).toEqual(C3);
    expect(m.getPhase()).toBe('Navigation');
  });

  it('S-E3 ★: 変換中に編集セルが競合したら留まり draft 保持（クリック先へ移動しない・Q-3 破棄）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    m.dispatch({ type: 'pointerdown', target: 'cell', cell: C3 });
    m.dispatch({ type: 'remoteUpdate', cell: A1, value: '他人の値' }); // S-F2 相当
    m.dispatch({ type: 'compositionend', data: '日本' });
    const effects = m.dispatch(input('日本', false));
    expect(effectOf(effects, 'MoveTo')).toBeUndefined();
    expect(effectOf(effects, 'ClearPendingNavigation')).toBeDefined();
    expect(m.getActiveCell()).toEqual(A1);
    expect(m.getDraft()).toBe('日本');
    expect(m.getConflictCells().has(cellKey(A1))).toBe(true);
    expect(m.getPendingNavigation()).toBeNull();
  });

  it('S-E4: pendingNavigation 保持中の Escape 2 回で Cancel + ClearPendingNavigation（A1 のまま）', () => {
    const m = makeMachine({ values: [[A1, 'orig']] });
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    m.dispatch({ type: 'pointerdown', target: 'cell', cell: C3 });
    m.dispatch(keydown('Escape', { isComposing: true })); // IME 取消
    m.dispatch({ type: 'compositionend', data: '' });
    m.dispatch(input('', false));
    expect(m.getPendingNavigation()).toEqual(C3); // まだ保持
    const effects = m.dispatch(keydown('Escape')); // 2 回目 = 編集取消
    expect(types(effects)).toEqual(['Cancel']);
    expect(m.getActiveCell()).toEqual(A1);
    expect(m.getPendingNavigation()).toBeNull();
  });
});

// ===========================================================================
// F. リモート更新（§11.7・MarkConflictOnly）★
// ===========================================================================
describe('F. リモート更新（MarkConflictOnly）', () => {
  it('S-F1 ★: 別セルへのリモート更新は draft 消失なし・競合マークなし', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    const effects = m.dispatch({ type: 'remoteUpdate', cell: B5, value: '他人の値' });
    expect(effects).toEqual([]);
    expect(m.getDraft()).toBe('日本');
    expect(m.isComposing()).toBe(true);
    expect(m.getConflictCells().size).toBe(0);
  });

  it('S-F2 ★: 編集中セルへのリモート更新は MarkConflict のみ（draft 保持・textarea 不変）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    const effects = m.dispatch({ type: 'remoteUpdate', cell: A1, value: '別値' });
    expect(effectOf(effects, 'MarkConflict')?.cell).toEqual(A1);
    expect(m.isComposing()).toBe(true);
    expect(m.getDraft()).toBe('日本');
    expect(m.getConflictCells().has(cellKey(A1))).toBe(true);
  });

  it('S-F3 ★: 編集中セルのリモート削除も MarkConflict・draft 退避（保持）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    const effects = m.dispatch({ type: 'remoteUpdate', cell: A1, value: null });
    expect(effectOf(effects, 'MarkConflict')?.cell).toEqual(A1);
    expect(m.getDraft()).toBe('日本');
  });

  it('S-F4 ★: 他セルへの連続リモート更新でも Composing draft は不変（受け入れ #4）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    for (let i = 0; i < 5; i += 1) {
      m.dispatch({ type: 'remoteUpdate', cell: { row: 3 + i, col: 4 }, value: `v${i}` });
    }
    expect(m.getDraft()).toBe('日本');
    expect(m.isComposing()).toBe(true);
    expect(m.getConflictCells().size).toBe(0);
  });

  it('S-F5: 競合未解決の Enter はサイレント上書きしない（commit 保留・移動しない）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    m.dispatch({ type: 'remoteUpdate', cell: A1, value: '別値' }); // 競合
    m.dispatch({ type: 'compositionend', data: '日本' });
    m.dispatch(input('日本', false));
    const effects = m.dispatch(keydown('Enter'));
    expect(effectOf(effects, 'Commit')).toBeUndefined();
    expect(effectOf(effects, 'Move')).toBeUndefined();
    expect(m.getDraft()).toBe('日本');
    expect(m.getConflictCells().has(cellKey(A1))).toBe(true);
  });
});

// ===========================================================================
// G. 移動直後の再入力（受け入れ #3・5 経路）
// ===========================================================================
describe('G. 移動直後の再入力（受け入れ #3）', () => {
  it('S-G1: Enter 確定→下移動直後に日本語入力で即 Composing', () => {
    const m = makeMachine();
    m.dispatch(input('あ'));
    m.dispatch(keydown('Enter'));
    m.dispatch(keyup('Enter'));
    m.dispatch({ type: 'compositionstart' });
    expect(m.getPhase()).toBe('Composing');
    expect(m.getActiveCell()).toEqual(A2);
  });

  it('S-G2: ArrowRight 移動直後に直接入力で EditingReplace→Composing', () => {
    const m = makeMachine();
    m.dispatch(keydown('ArrowRight'));
    m.dispatch(input('x'));
    expect(m.getPhase()).toBe('EditingReplace');
    m.dispatch({ type: 'compositionstart' });
    expect(m.getPhase()).toBe('Composing');
    expect(m.getActiveCell()).toEqual(B1);
  });

  it('S-G3: Tab / Shift+Tab / Shift+Enter 各移動後も再入力成功（5 経路網羅）', () => {
    for (const key of ['Tab'] as const) {
      const m = makeMachine({ initialCell: B2 });
      m.dispatch(keydown(key));
      m.dispatch({ type: 'compositionstart' });
      expect(m.getPhase()).toBe('Composing');
    }
    const shiftTab = makeMachine({ initialCell: B2 });
    shiftTab.dispatch(keydown('Tab', { shiftKey: true }));
    shiftTab.dispatch({ type: 'compositionstart' });
    expect(shiftTab.getPhase()).toBe('Composing');
    expect(shiftTab.getActiveCell()).toEqual({ row: 1, col: 0 });

    const shiftEnter = makeMachine({ initialCell: B2 });
    shiftEnter.dispatch(keydown('Enter', { shiftKey: true }));
    shiftEnter.dispatch({ type: 'compositionstart' });
    expect(shiftEnter.getPhase()).toBe('Composing');
    expect(shiftEnter.getActiveCell()).toEqual({ row: 0, col: 1 });
  });
});

// ===========================================================================
// H. フォーカス・その他境界
// ===========================================================================
describe('H. フォーカス境界', () => {
  it('S-H1: 非 composing 編集中の blur は Commit（Q-4・移動しない）', () => {
    const m = makeMachine();
    m.dispatch(input('ab'));
    const effects = m.dispatch({ type: 'blur' });
    expect(effectOf(effects, 'Commit')).toEqual({ type: 'Commit', cell: A1, value: 'ab' });
    expect(effectOf(effects, 'Move')).toBeUndefined();
    expect(m.getPhase()).toBe('Navigation');
    expect(m.getActiveCell()).toEqual(A1);
  });

  it('S-H2: composition 中の blur は machine から強制確定しない', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    const effects = m.dispatch({ type: 'blur' });
    expect(effects).toEqual([]);
    expect(m.isComposing()).toBe(true);
    expect(m.getDraft()).toBe('日本');
  });

  it('S-H3: Navigation の focus は状態不変', () => {
    const m = makeMachine();
    const effects = m.dispatch({ type: 'focus' });
    expect(effects).toEqual([]);
    expect(m.getPhase()).toBe('Navigation');
  });
});

// ===========================================================================
// RC1（DD-052-1）: wrap 列の Alt+Enter はセル内改行（Effect を返さず textarea の既定動作に任せる）
// ===========================================================================
describe('RC1: wrap 列の Alt+Enter', () => {
  it('wrap 列で Alt+Enter → InsertNewline のみ（commit も移動もしない・UI アダプタが caret へ改行を挿入する）', () => {
    const m = makeMachine({ wrapColumns: new Set([0]) }); // col=0 が wrap 列
    m.dispatch(input('ab'));
    const effects = m.dispatch(keydown('Enter', { altKey: true }));
    expect(types(effects)).toEqual(['InsertNewline']);
    expect(m.getPhase()).toBe('EditingReplace'); // 編集継続（確定しない）
    expect(m.getActiveCell()).toEqual(A1); // 移動しない
    expect(m.getDraft()).toBe('ab'); // draft は状態機械側では変えない（UI アダプタからの input で更新される）
  });

  it('wrap 列でない列（未指定）の Alt+Enter → 通常の Enter と同じ確定＋下移動', () => {
    const m = makeMachine(); // isWrapColumn 未指定 = 全列 wrap でない
    m.dispatch(input('ab'));
    const effects = m.dispatch(keydown('Enter', { altKey: true }));
    expect(effectOf(effects, 'Commit')).toEqual({ type: 'Commit', cell: A1, value: 'ab' });
    expect(effectOf(effects, 'Move')?.direction).toBe('down');
    expect(m.getActiveCell()).toEqual(A2);
    expect(m.getPhase()).toBe('Navigation');
  });

  it('wrap 列指定があっても他の列（col=1）は対象外 → Alt+Enter は通常どおり確定＋移動', () => {
    const m = makeMachine({ initialCell: B1, wrapColumns: new Set([0]) }); // wrap は col=0 のみ
    m.dispatch(input('ab'));
    const effects = m.dispatch(keydown('Enter', { altKey: true }));
    expect(effectOf(effects, 'Commit')).toEqual({ type: 'Commit', cell: B1, value: 'ab' });
    expect(effectOf(effects, 'Move')?.direction).toBe('down');
  });

  it('wrap 列でも Alt を伴わない通常の Enter は従来どおり確定＋下移動', () => {
    const m = makeMachine({ wrapColumns: new Set([0]) });
    m.dispatch(input('ab'));
    const effects = m.dispatch(keydown('Enter'));
    expect(effectOf(effects, 'Commit')).toEqual({ type: 'Commit', cell: A1, value: 'ab' });
    expect(effectOf(effects, 'Move')?.direction).toBe('down');
  });

  it('wrap 列で競合未解決中の Alt+Enter は SuppressKey（サイレント上書きしない・S-F5 と同型）', () => {
    const m = makeMachine({ wrapColumns: new Set([0]) });
    m.dispatch(input('ab'));
    m.dispatch({ type: 'remoteUpdate', cell: A1, value: 'other' }); // conflictCell を立てる
    const effects = m.dispatch(keydown('Enter', { altKey: true }));
    expect(types(effects)).toEqual(['SuppressKey']);
  });
});

// ===========================================================================
// Codex レビュー指摘の回帰（イベント順差・確定 Enter 抑止窓・blur・競合破棄）
// ===========================================================================
describe('Codex 指摘の回帰', () => {
  it('#1: 内部フラグ未設定でも event.isComposing:true の Enter/Tab/矢印は抑止（I-2）', () => {
    const enter = makeMachine();
    // compositionstart 未処理のまま isComposing:true の Enter が先に来るイベント順。
    expect(types(enter.dispatch({ type: 'keydown', key: 'Enter', isComposing: true }))).toEqual([
      'SuppressKey',
    ]);
    expect(enter.getActiveCell()).toEqual(A1); // 誤移動しない
    const arrow = makeMachine();
    expect(types(arrow.dispatch({ type: 'keydown', key: 'ArrowDown', isComposing: true }))).toEqual([
      'SuppressKey',
    ]);
    expect(arrow.getActiveCell()).toEqual(A1);
  });

  it('#2: 確定 Enter を 1 回抑止したら self-clear し、次の Enter は commit（keyup 非依存）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    m.dispatch({ type: 'compositionend', data: '日本' });
    m.dispatch(input('日本', false));
    expect(types(m.dispatch(keydown('Enter')))).toEqual(['SuppressKey']); // 確定 Enter
    const second = m.dispatch(keydown('Enter')); // keyup を挟まず次の Enter
    expect(effectOf(second, 'Commit')).toEqual({ type: 'Commit', cell: A1, value: '日本' });
    expect(effectOf(second, 'Move')?.direction).toBe('down');
  });

  it('#2: フォーカス変更で抑止窓が閉じ、以後の Enter は commit（マウス確定後の正規 Enter を飲まない）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    m.dispatch({ type: 'compositionend', data: '日本' }); // Enter を伴わない確定
    m.dispatch(input('日本', false));
    m.dispatch({ type: 'focus' }); // フォーカス変更 → 抑止窓を閉じる
    const effects = m.dispatch(keydown('Enter')); // 正規の移動 Enter
    expect(effectOf(effects, 'Commit')).toEqual({ type: 'Commit', cell: A1, value: '日本' });
    expect(effectOf(effects, 'Move')?.direction).toBe('down');
  });

  it('#3: AwaitFinalInput 中の blur は暫定値で commit せず、最終 input の確定値で commit（I-1）', () => {
    const m = makeMachine();
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    m.dispatch({ type: 'compositionend', data: '日本' }); // 暫定 '日本'
    expect(m.getPhase()).toBe('EditingAwaitFinalInput');
    expect(m.dispatch({ type: 'blur' })).toEqual([]); // 暫定値を commit しない（保留）
    expect(m.getPhase()).toBe('EditingAwaitFinalInput');
    const onInput = m.dispatch(input('日本語', false)); // 最終確定値（暫定と異なる）
    expect(effectOf(onInput, 'Commit')).toEqual({ type: 'Commit', cell: A1, value: '日本語' });
    expect(m.getPhase()).toBe('Navigation');
  });

  it('#4: 競合中のダブルクリックは draft/競合を破棄しない（無視・移動しない）', () => {
    const m = makeMachine({ values: [[A1, 'orig']] });
    m.dispatch({ type: 'compositionstart' });
    m.dispatch({ type: 'compositionupdate', data: '日本' });
    m.dispatch({ type: 'remoteUpdate', cell: A1, value: '別値' }); // 競合
    m.dispatch({ type: 'compositionend', data: '日本' });
    m.dispatch(input('日本', false));
    expect(m.getConflictCells().has(cellKey(A1))).toBe(true);
    const effects = m.dispatch({ type: 'doubleClick', cell: C3 });
    expect(effects).toEqual([]);
    expect(m.getActiveCell()).toEqual(A1);
    expect(m.getDraft()).toBe('日本');
    expect(m.getConflictCells().has(cellKey(A1))).toBe(true);
  });
});

// ===========================================================================
// 合成リファレンストレースの再生（DA #1: 順序A/B を両方コード化）
// 下記 3 列は doc/DD/DD-002/traces/synthetic-reference/*.json（合成リファレンス）と
// 同一のイベント列を写したもの（初期セル {row:1,col:0}）。playground の tsconfig は
// node 型を含まない（"types":[]）ため、ファイル読込ではなくインラインで再生素材にする。
// ===========================================================================
describe('合成リファレンストレース再生（synthetic-reference）', () => {
  const REF_CELL: CellPosition = { row: 1, col: 0 };

  // orderA-enter-during-composition.json（S-D3: 確定 Enter が composition 中）。
  const ORDER_A: readonly EditorEvent[] = [
    { type: 'compositionstart' },
    { type: 'compositionupdate', data: 'にほ' },
    { type: 'compositionupdate', data: '日本' },
    { type: 'keydown', key: 'Enter', code: 'Enter', isComposing: true },
    { type: 'compositionend', data: '日本' },
    { type: 'input', value: '日本', isComposing: false, inputType: 'insertCompositionText' },
    { type: 'keyup', key: 'Enter', isComposing: false },
  ];

  // orderB-enter-after-compositionend.json（S-D5: 確定 Enter が compositionend 後）。
  const ORDER_B: readonly EditorEvent[] = [
    { type: 'compositionstart' },
    { type: 'compositionupdate', data: 'にほ' },
    { type: 'compositionupdate', data: '日本' },
    { type: 'compositionend', data: '日本' },
    { type: 'input', value: '日本', isComposing: false, inputType: 'insertCompositionText' },
    { type: 'keydown', key: 'Enter', code: 'Enter', isComposing: false },
    { type: 'keyup', key: 'Enter', isComposing: false },
  ];

  // direct-input-convert-confirm-move.json（受け入れ #2: 確定の次の Enter で下移動）。
  const DIRECT_INPUT: readonly EditorEvent[] = [
    { type: 'compositionstart' },
    { type: 'compositionupdate', data: 'にほ' },
    { type: 'compositionupdate', data: '日本' },
    { type: 'compositionend', data: '日本' },
    { type: 'input', value: '日本', isComposing: false, inputType: 'insertCompositionText' },
    { type: 'keydown', key: 'Enter', code: 'Enter', isComposing: false },
    { type: 'keyup', key: 'Enter', isComposing: false },
    { type: 'keydown', key: 'Enter', code: 'Enter', isComposing: false },
    { type: 'keyup', key: 'Enter', isComposing: false },
  ];

  /** トレースを 1 ステップずつ流し、全ステップの効果を平坦化して返す。 */
  function replay(events: readonly EditorEvent[]) {
    const machine = makeMachine({ initialCell: REF_CELL });
    const flat = events.flatMap((event) => [...machine.dispatch(event)]);
    return { machine, flat };
  }

  it('orderA: 確定 Enter（composition 中・isComposing:true）を抑止し Commit/Move しない（S-D3）', () => {
    const { machine, flat } = replay(ORDER_A);
    expect(flat.some((e) => e.type === 'SuppressKey')).toBe(true);
    expect(flat.some((e) => e.type === 'Commit')).toBe(false);
    expect(flat.some((e) => e.type === 'Move')).toBe(false);
    expect(machine.getDraft()).toBe('日本');
    expect(machine.getActiveCell()).toEqual(REF_CELL);
  });

  it('orderB: compositionend 後の確定 Enter を keyup まで抑止（Commit/Move しない・S-D5）', () => {
    const { machine, flat } = replay(ORDER_B);
    expect(flat.some((e) => e.type === 'SuppressKey')).toBe(true);
    expect(flat.some((e) => e.type === 'Commit')).toBe(false);
    expect(flat.some((e) => e.type === 'Move')).toBe(false);
    expect(machine.getDraft()).toBe('日本');
    expect(machine.getActiveCell()).toEqual(REF_CELL);
  });

  it('direct-input: 確定 Enter は抑止し、次の独立 Enter で Commit → 下移動（受け入れ #2）', () => {
    const { machine, flat } = replay(DIRECT_INPUT);
    expect(flat.filter((e) => e.type === 'SuppressKey').length).toBeGreaterThanOrEqual(1);
    const commit = flat.find((e): e is Extract<Effect, { type: 'Commit' }> => e.type === 'Commit');
    expect(commit).toEqual({ type: 'Commit', cell: REF_CELL, value: '日本' });
    const move = flat.find((e): e is Extract<Effect, { type: 'Move' }> => e.type === 'Move');
    expect(move?.direction).toBe('down');
    expect(machine.getActiveCell()).toEqual({ row: 2, col: 0 });
    expect(machine.getPhase()).toBe('Navigation');
  });
});
