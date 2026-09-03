// integration-editor（DD-005 Phase 3・DOM アダプタ）: 統合ページの常駐 textarea（§11.3）を生成し、
// DOM イベント → ime-editing-session（状態機械の結線）→ エフェクト適用の薄いアダプタに徹する。
// IME の正しさと Commit/#8/#4 のロジックは ime-editing-session（DOM 非依存・ユニット検証済み）にあり、
// このファイルは「実 textarea への value/selection/配置/見た目の反映」と「ViewportTransform での配置」だけを担う。
//
// §11.3 常駐 textarea 原則:
//   - グリッドに 1 個だけ生成し destroy まで保持（value/selection/DOM 親は composition 中に触らない・I-3）。
//   - Navigation では透明＋pointer-events:none（クリックは下の scroller へ通す＝入力受け口は保持）。
//   - Editing では白地＋pointer-events:auto。
//   - 可視セルへ ViewportTransform で配置し scroll 中も追従（AC3・§13.5）。画面外は隠す（仮想スクロール）。
//
// #9 競合表示: 競合枠（textarea outline）に加え、textarea より **上の z-index** の badge に他者の確定値を出す
//   （textarea がセル全面を覆ってもサーバー値と A の draft が同時に識別できる）。

import type { CellPosition, GridLayout } from '@nanairo-sheet/ime';
import type { EditorEvent } from '@nanairo-sheet/ime';
import type { CellRect, ViewportTransform } from '@nanairo-sheet/render';

import { computeEditorPlacement, type PlacementConfig } from './editor-placement';
import {
  createImeEditingSession,
  type DivertedDraft,
  type EditingDocumentPort,
  type ImeEditingSession,
} from './ime-editing-session';

import type { PresenceUpdate } from '@nanairo-sheet/collab';
import type { SetCellsOperation } from '@nanairo-sheet/core';
import type { OperationId } from '@nanairo-sheet/types';

const CELL_FONT = '13px system-ui, sans-serif';
const EDITING_BACKGROUND = '#ffffff';
const CONFLICT_COLOR = '#d93025';
const EDITOR_Z = '10';
const BADGE_Z = '12'; // textarea より上（#9: 競合表示を隠さない）

/** keydown 前段裁定へ渡す素の値（DOM 非依存・DD-020-1 案X＋DD-020-3 Undo/Redo 修飾キー）。 */
export interface KeydownInterceptInput {
  readonly key: string;
  readonly shiftKey: boolean;
  /** Ctrl（Windows/Linux の Undo/Redo・DD-020-3）。 */
  readonly ctrlKey: boolean;
  /** Meta=Cmd（macOS の Undo/Redo・DD-020-3）。 */
  readonly metaKey: boolean;
  /** Alt（Undo/Redo 裁定の除外条件・DD-020-3）。 */
  readonly altKey: boolean;
  readonly isComposing: boolean;
}

export interface IntegrationEditorConfig {
  /** textarea/badge を配置するコンテナ（position:relative の stage）。 */
  readonly host: HTMLElement;
  readonly document: EditingDocumentPort;
  readonly submit: (operation: SetCellsOperation) => OperationId | void;
  readonly layout: GridLayout;
  readonly onPresenceChange?: (update: PresenceUpdate) => void;
  readonly onChange?: () => void;
  /**
   * keydown の前段裁定（DD-020-1 案X・範囲選択）。true=消費（preventDefault し状態機械へ流さない）。
   * mount-controller が Navigation 位相の Shift+矢印（レンジ拡張）等をここで消費する。composition 中は
   * 裁定側（decideNavigationIntercept）が必ず false を返す契約＝IME 経路（CG-1 資産）は変わらない（I-3）。
   */
  readonly interceptKeydown?: (input: KeydownInterceptInput) => boolean;
  /**
   * copy の裁定（DD-020-2）。書き出す TSV を返せば消費（clipboardData.setData＋preventDefault）。null=非消費
   * （ブラウザ既定＝textarea 内テキストの copy）。Navigation 位相のみ TSV を返す契約（mount-controller 側で裁定）。
   */
  readonly onClipboardCopy?: () => string | null;
  /** cut の裁定（DD-020-2）。copy＋範囲クリアを実行し書き出す TSV を返す。null=非消費（textarea 既定）。 */
  readonly onClipboardCut?: () => string | null;
  /** paste の裁定（DD-020-2）。text/plain を受け取り消費したら true（preventDefault）。false=非消費（textarea 既定）。 */
  readonly onClipboardPaste?: (text: string) => boolean;
  /** K4（DD-021-2）: commit 時に対象行が削除済みで draft を退避したときの通知（公開 rejected への写像用）。 */
  readonly onDivert?: (draft: DivertedDraft) => void;
  /**
   * 常駐 textarea が blur したときの通知（DD-027-1・Fable 5 P3-9）。grid コンテナ外クリック等で focus が外れたら
   * mount-controller が選択式ドロップダウンを閉じる。IME 状態機械への blur dispatch は従来どおり（本 hook は追加通知）。
   */
  readonly onBlur?: () => void;
  /**
   * 表示専用モード（DD-033-1）。true のとき常駐 textarea に `readOnly` 属性を付け（実 IME/実キーボード入力を物理遮断）、
   * composition 系・beforeinput・input・dblclick の DOM イベントを状態機械へ dispatch しない（synthetic も論理遮断）。
   * これにより「実機でも synthetic でも編集 UI が開かない」を成立させる。false/未指定時は完全無変更（分岐追加のみ）。
   * keydown は従来どおり dispatch し、readOnly の編集キー抑止は mount-controller の interceptKeydown（readonly-policy）が担う。
   */
  readonly readOnly?: boolean;
}

export interface IntegrationEditor {
  readonly session: ImeEditingSession;
  /** scroller の pointerdown（main が hitTest 済み。null=ヘッダー/範囲外）。 */
  pointerdownCell(cell: CellPosition | null): void;
  /** scroller の dblclick（既存値編集開始）。 */
  doubleClickCell(cell: CellPosition): void;
  /** rAF ごとに配置を更新（scroll 追従・RowId 再解決・#4/AC3）。 */
  refreshPlacement(transform: ViewportTransform, placement: PlacementConfig): void;
  focus(): void;
  destroy(): void;
}

export function createIntegrationEditor(config: IntegrationEditorConfig): IntegrationEditor {
  const { host } = config;
  const abort = new AbortController();
  const { signal } = abort;
  // DD-033-1: 表示専用モード。編集を起こす DOM イベントを状態機械へ渡さない（synthetic 論理遮断）。false/未指定は無変更。
  const readOnly = config.readOnly === true;

  // --- 常駐 textarea（1 個・破棄しない） ---
  const textarea = document.createElement('textarea');
  textarea.className = 'int-cell-editor';
  textarea.setAttribute('aria-label', 'セル入力');
  textarea.rows = 1;
  textarea.spellcheck = false;
  textarea.autocapitalize = 'off';
  textarea.style.position = 'absolute';
  textarea.style.display = 'none';
  textarea.style.margin = '0';
  textarea.style.padding = '0 4px';
  textarea.style.border = '2px solid #1a73e8';
  textarea.style.outline = 'none';
  textarea.style.background = 'transparent';
  textarea.style.font = CELL_FONT;
  textarea.style.color = '#202124';
  textarea.style.resize = 'none';
  textarea.style.overflow = 'hidden';
  textarea.style.whiteSpace = 'pre';
  textarea.style.boxSizing = 'border-box';
  textarea.style.zIndex = EDITOR_Z;
  textarea.style.pointerEvents = 'none';
  // DD-033-1: readOnly 属性で実 IME/実キーボードの入力（composition・input）を物理的に発生させない（選択/コピーは可）。
  if (readOnly) {
    textarea.readOnly = true;
  }
  host.appendChild(textarea);

  // --- 競合 badge（textarea より上・#9） ---
  const badge = document.createElement('div');
  badge.className = 'int-conflict-badge';
  badge.style.position = 'absolute';
  badge.style.display = 'none';
  badge.style.zIndex = BADGE_Z;
  badge.style.background = CONFLICT_COLOR;
  badge.style.color = '#fff';
  badge.style.font = '11px system-ui, sans-serif';
  badge.style.padding = '1px 5px';
  badge.style.borderRadius = '3px';
  badge.style.whiteSpace = 'nowrap';
  badge.style.pointerEvents = 'none';
  host.appendChild(badge);

  // port/badge のクロージャは session 生成後に実行されるため、前方参照を ref で保持する。
  const sessionRef: { current: ImeEditingSession | undefined } = { current: undefined };
  let currentRect: CellRect | null = null;

  // --- TextareaPort（実 DOM への反映。composition 中は value/selection を書かない・I-3） ---
  const port = {
    getValue: () => textarea.value,
    setValue: (value: string) => {
      textarea.value = value;
    },
    setSelectionRange: (start: number, end: number) => {
      textarea.setSelectionRange(start, end);
    },
    focus: () => {
      textarea.focus({ preventScroll: true });
    },
    place: (rect: CellRect | null) => {
      currentRect = rect;
      if (rect === null) {
        // 画面外/削除。composition 中は隠すと IME が壊れるため、直近位置に留める。
        // K4 行消失中（isTargetLost）も隠すと focus 中の textarea が display:none → blur → 非 composing 編集は
        // S-H1 で強制 Commit＝即 divert となり「ドラフトは利用者が確定/破棄するまで消さない」契約（親④/D7）が
        // 破れるため、直近位置に留めて編集を継続させる（Fable P2）。
        const s = sessionRef.current;
        if (s?.isComposing() !== true && s?.isTargetLost() !== true) {
          textarea.style.display = 'none';
          badge.style.display = 'none';
        }
        return;
      }
      textarea.style.display = 'block';
      textarea.style.left = `${rect.x}px`;
      textarea.style.top = `${rect.y}px`;
      textarea.style.width = `${rect.width}px`;
      textarea.style.height = `${rect.height}px`;
      textarea.style.lineHeight = `${rect.height}px`;
    },
    setEditingVisual: (editing: boolean) => {
      textarea.style.background = editing ? EDITING_BACKGROUND : 'transparent';
      // Navigation はクリックを下の scroller へ通す（入力受け口は focus で保持）。
      textarea.style.pointerEvents = editing ? 'auto' : 'none';
      // 編集開始時は focus() が効くよう display:block を先に確定する（正しい位置は直後の refreshPlacement が置く）。
      if (editing) {
        textarea.style.display = 'block';
      }
    },
    setConflict: (conflict: boolean) => {
      textarea.style.outline = conflict ? `2px solid ${CONFLICT_COLOR}` : 'none';
      updateBadge(conflict);
    },
  };

  function updateBadge(show: boolean): void {
    const s = sessionRef.current;
    const target = show ? s?.getEditingTarget() : undefined;
    if (target === undefined || target === null || currentRect === null) {
      badge.style.display = 'none';
      return;
    }
    // K4 行消失はセル競合と文言を分ける（Fable P3: 「他者の確定値」は行削除の説明として誤り）。
    if (s?.isTargetLost() === true) {
      badge.textContent = '⚠ この行は削除されました（確定するとドラフトは退避されます）';
    } else {
      const serverValue = config.document.displayText(target.rowId, target.columnId);
      badge.textContent = `⚠ 他者の確定値: ${serverValue === '' ? '(空)' : serverValue}`;
    }
    // セル上端の外側（少し上）へ。textarea を覆わず、かつ画面上端でクランプ。
    badge.style.left = `${currentRect.x}px`;
    badge.style.top = `${Math.max(0, currentRect.y - 16)}px`;
    badge.style.display = 'block';
  }

  const session = createImeEditingSession({
    document: config.document,
    port,
    submit: config.submit,
    layout: config.layout,
    onPresenceChange: config.onPresenceChange,
    onChange: config.onChange,
    onDivert: config.onDivert,
  });
  sessionRef.current = session;

  // --- DOM イベント → EditorEvent → session.handleEvent（薄いアダプタ） ---
  const on = <K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
  ): void => {
    textarea.addEventListener(type, handler, { signal });
  };

  on('compositionstart', () => {
    if (readOnly) {
      return; // DD-033-1: synthetic composition も状態機械へ渡さない（編集 UI を開かせない）
    }
    dispatch({ type: 'compositionstart' });
  });
  on('compositionupdate', (event) => {
    if (readOnly) {
      return;
    }
    dispatch({ type: 'compositionupdate', data: event.data });
  });
  on('compositionend', (event) => {
    if (readOnly) {
      return;
    }
    dispatch({ type: 'compositionend', data: event.data });
  });
  on('beforeinput', (event) => {
    if (readOnly) {
      return;
    }
    if (event instanceof InputEvent) {
      dispatch({ type: 'beforeinput', inputType: event.inputType, data: event.data });
    }
  });
  on('input', (event) => {
    if (readOnly) {
      return; // DD-033-1: synthetic input（印字）も dispatch しない＝BeginEdit を論理遮断
    }
    if (event instanceof InputEvent) {
      dispatch({
        type: 'input',
        value: textarea.value,
        isComposing: event.isComposing,
        inputType: event.inputType,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
      });
    }
  });
  on('keydown', (event) => {
    // DD-020-1 前段裁定（案X）: Navigation 位相の Shift+矢印（範囲拡張）等を状態機械の前で消費する。
    // 消費された keydown は状態機械へ届かない（通常 Move にしない）。それ以外は従来どおり全量を流す。
    if (
      config.interceptKeydown?.({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        isComposing: event.isComposing,
      }) === true
    ) {
      event.preventDefault();
      return;
    }
    const consumed = session.handleEvent({
      type: 'keydown',
      key: event.key,
      code: event.code,
      isComposing: event.isComposing,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
    });
    // 状態機械が消費したキー（Move/Commit/Cancel/BeginEdit/SuppressKey）は既定動作を止める。
    if (consumed) {
      event.preventDefault();
    }
  });
  on('keyup', (event) => {
    dispatch({ type: 'keyup', key: event.key, isComposing: event.isComposing });
  });
  // DD-020-2 clipboard 配線（常駐 textarea の ClipboardEvent＝IME 資産と共有）。裁定（Navigation 位相か・
  // composition 中でないか）は mount-controller 側の callback が行い、消費時のみ preventDefault する。
  // composition 中は callback が null/false を返す契約＝ブラウザ既定（textarea 内テキスト編集）のまま（I-3）。
  on('copy', (event) => {
    const tsv = config.onClipboardCopy?.();
    if (tsv !== null && tsv !== undefined) {
      event.clipboardData?.setData('text/plain', tsv);
      event.preventDefault(); // 既定の textarea copy を止めてグリッド選択範囲を書き出す
    }
  });
  on('cut', (event) => {
    const tsv = config.onClipboardCut?.();
    if (tsv !== null && tsv !== undefined) {
      event.clipboardData?.setData('text/plain', tsv);
      event.preventDefault();
    }
  });
  on('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (config.onClipboardPaste?.(text) === true) {
      event.preventDefault(); // グリッドが消費（textarea へテキストを入れない）
    }
  });
  on('focus', () => {
    dispatch({ type: 'focus' });
  });
  on('blur', () => {
    dispatch({ type: 'blur' }); // IME 状態機械への通知（従来どおり・無改変）
    config.onBlur?.(); // DD-027-1: focus 外れでドロップダウンを閉じる（追加通知のみ）
  });
  // 常駐 textarea 自身のダブルクリック（active セルの既存値編集）。
  on('dblclick', () => {
    if (readOnly) {
      return; // DD-033-1: textarea 上の dblclick でも編集を開始しない
    }
    dispatch({ type: 'doubleClick', cell: session.getActiveCell() });
  });

  function dispatch(event: EditorEvent): void {
    session.handleEvent(event);
  }

  return {
    session,
    pointerdownCell: (cell) => {
      dispatch(cell === null ? { type: 'pointerdown', target: 'outside' } : { type: 'pointerdown', target: 'cell', cell });
      if (cell !== null && !session.isComposing()) {
        // preventScroll: 位置合わせは scroll-follow（mount-controller）が担うので、focus 既定の
        // scrollIntoView がそれと競合して画面が跳ねるのを防ぐ。
        textarea.focus({ preventScroll: true });
      }
    },
    doubleClickCell: (cell) => {
      dispatch({ type: 'doubleClick', cell });
    },
    refreshPlacement: (transform, placement) => {
      session.refreshPlacement((rowIndex, colIndex) => {
        const p = computeEditorPlacement(transform, rowIndex, colIndex, placement);
        return p.visible ? p.rect : null;
      });
      // badge 位置も追従（セル競合 or K4 行消失で表示。targetLost を見ないと rAF ごとに行消失 badge が消える）。
      updateBadge(session.isConflicting() || session.isTargetLost());
    },
    focus: () => {
      textarea.focus({ preventScroll: true });
    },
    destroy: () => {
      abort.abort();
      textarea.remove();
      badge.remove();
    },
  };
}
