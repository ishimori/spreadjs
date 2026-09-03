// select-editor（DD-027-1）: 選択式入力列のドロップダウン。
//
// 【分離】純粋状態コントローラ（open/close/highlight・DOM 非依存＝TDD 対象）＋ 薄い DOM アダプタ（listbox
// オーバーレイ・▼ インジケーター・rAF placement 追従＝badge と同方式）。加えて keydown の前段裁定 `decideSelectKey`
// を純関数として切り出す（integration-editor の interceptKeydown から状態機械の前で評価する・IME 経路無改変）。
//
// 【IME 経路無改変（📐・T1 非該当）】editor-state-machine・ime-editing-session・常駐 textarea は改変しない。
//   フォーカスは常駐 textarea のまま（I-5 維持）。↑↓/Enter/Esc は mount-controller の interceptKeydown が消費して
//   本コントローラへ転送する。候補クリックは listbox の pointerdown（preventDefault で focus を textarea に保つ）。
//   composition 中は decideSelectKey が必ず 'none' を返す（前段消費しない＝I-3）。

import type { EditPhase } from '@nanairo-sheet/ime';
import type { CellRect } from '@nanairo-sheet/render';

// ---- 純粋コントローラ（TDD 対象） ------------------------------------------------------------

export interface SelectController {
  isOpen(): boolean;
  /** 開く（候補・現値ハイライト）。現値が候補に無ければ先頭をハイライト。 */
  open(params: { readonly options: readonly string[]; readonly currentValue: string }): void;
  getOptions(): readonly string[];
  getHighlightedIndex(): number;
  /** ハイライト中の候補値（未 open/候補空は null）。 */
  getHighlightedValue(): string | null;
  highlightNext(): void;
  highlightPrev(): void;
  setHighlight(index: number): void;
  close(): void;
}

export function createSelectController(): SelectController {
  let open = false;
  let options: readonly string[] = [];
  let highlighted = -1;

  const clamp = (index: number): number => {
    if (options.length === 0) {
      return -1;
    }
    return Math.min(Math.max(index, 0), options.length - 1);
  };

  return {
    isOpen: () => open,
    open: ({ options: opts, currentValue }) => {
      open = true;
      options = [...opts];
      const idx = options.indexOf(currentValue);
      highlighted = idx >= 0 ? idx : clamp(0);
    },
    getOptions: () => options,
    getHighlightedIndex: () => highlighted,
    getHighlightedValue: () => (highlighted >= 0 && highlighted < options.length ? options[highlighted]! : null),
    highlightNext: () => {
      if (open) {
        highlighted = clamp(highlighted + 1);
      }
    },
    highlightPrev: () => {
      if (open) {
        highlighted = clamp(highlighted - 1);
      }
    },
    setHighlight: (index) => {
      if (open) {
        highlighted = clamp(index);
      }
    },
    close: () => {
      open = false;
      options = [];
      highlighted = -1;
    },
  };
}

// ---- keydown 前段裁定（純関数・TDD 対象） ---------------------------------------------------

export type SelectKeyDecision =
  /** 前段消費しない（従来経路＝undo/redo・行操作・navigation・状態機械へ流す）。 */
  | 'none'
  /** 選択式列（allowFreeText:false）で編集開始キー → ドロップダウンを開く。 */
  | 'open'
  | 'move-down'
  | 'move-up'
  /** ハイライト中の候補を確定。 */
  | 'confirm'
  /** 取消（Esc・Tab）。 */
  | 'cancel'
  /** open 中の未処理キーを握り潰す（textarea への漏れ防止・状態変化なし）。 */
  | 'consume';

export interface SelectKeyInput {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  /** DOM の KeyboardEvent.isComposing。 */
  readonly eventComposing: boolean;
  /** 状態機械の内部 composing フラグ（I-2）。 */
  readonly sessionComposing: boolean;
  readonly phase: EditPhase;
  readonly isOpen: boolean;
  /** アクティブセルが選択式列（allowFreeText:false）か。 */
  readonly isSelectCell: boolean;
}

/** 印字可能な単一文字キー（修飾なし）か（Excel: 選択式セルで文字キー→ドロップダウン）。 */
function isPrintable(input: SelectKeyInput): boolean {
  return input.key.length === 1 && !input.ctrlKey && !input.metaKey && !input.altKey;
}

/**
 * 選択式列の keydown 前段裁定。composition 中（DOM/内部いずれか）と非 Navigation 位相では必ず 'none'
 * （IME・編集中のキー処理は従来どおり状態機械が裁く＝IME 経路無改変・I-3）。open 中は ↑↓/Enter/Esc/Tab を処理し、
 * 残りは 'consume'（textarea への漏れ防止）。閉じているときは選択式セルでのみ編集開始キーを 'open' に写す。
 */
export function decideSelectKey(input: SelectKeyInput): SelectKeyDecision {
  if (input.eventComposing || input.sessionComposing || input.phase !== 'Navigation') {
    return 'none';
  }
  if (input.isOpen) {
    switch (input.key) {
      case 'ArrowDown':
        return 'move-down';
      case 'ArrowUp':
        return 'move-up';
      case 'Enter':
        return 'confirm';
      case 'Escape':
      case 'Tab':
        return 'cancel';
      default:
        // 開いている間の他キー（印字文字・PageUp 等）は握り潰す（textarea 編集を誘発させない）。
        // Alt+Down 等の修飾キー単独 press は consume で無害化。
        return 'consume';
    }
  }
  if (!input.isSelectCell) {
    return 'none';
  }
  // 閉じている & 選択式セル: 編集開始キー（F2・Enter・Alt+↓・印字文字）でドロップダウンを開く。
  // F2/Enter は修飾なしのみ（Fable 5 P3-6: Shift+Enter=確定して上移動、Ctrl/Alt 系ショートカットを奪わない）。
  if (
    (input.key === 'F2' || input.key === 'Enter') &&
    !input.ctrlKey &&
    !input.metaKey &&
    !input.altKey &&
    !input.shiftKey
  ) {
    return 'open';
  }
  if (input.key === 'ArrowDown' && input.altKey && !input.ctrlKey && !input.metaKey) {
    return 'open';
  }
  if (isPrintable(input)) {
    return 'open';
  }
  return 'none';
}

// ---- 薄い DOM アダプタ（listbox オーバーレイ・▼ インジケーター・E2E 対象） -------------------

const LISTBOX_Z = '30'; // 常駐 textarea(10)・badge(12) より上
const INDICATOR_Z = '11';
const HIGHLIGHT_BG = '#e8f0fe';

export interface SelectDropdownConfig {
  /** listbox/indicator を配置するコンテナ（position:relative の stage）。 */
  readonly host: HTMLElement;
  /** 候補クリック（pointerdown）での確定要求。mount-controller が SetCells を組んで submit する。 */
  readonly onConfirm: () => void;
}

export interface SelectDropdown {
  readonly controller: SelectController;
  isOpen(): boolean;
  /** 開く（cellRect の直下へ listbox を配置）。 */
  open(params: { readonly rect: CellRect | null; readonly options: readonly string[]; readonly currentValue: string }): void;
  highlightNext(): void;
  highlightPrev(): void;
  /** ハイライト中の値を返して閉じる（未 open/候補空は null）。 */
  confirmValue(): string | null;
  close(): void;
  /** rAF 追従: open 中の listbox 位置（openRect）と ▼ インジケーター位置（indicatorRect・null=非表示）を更新。 */
  refresh(params: { readonly openRect: CellRect | null; readonly indicatorRect: CellRect | null }): void;
  // E2E introspection
  options(): readonly string[];
  highlightedIndex(): number;
  highlightedValue(): string | null;
  destroy(): void;
}

export function createSelectDropdown(config: SelectDropdownConfig): SelectDropdown {
  const { host } = config;
  const controller = createSelectController();

  const listbox = document.createElement('div');
  listbox.className = 'ns-select-listbox';
  listbox.setAttribute('role', 'listbox');
  listbox.style.position = 'absolute';
  listbox.style.display = 'none';
  listbox.style.zIndex = LISTBOX_Z;
  listbox.style.background = '#fff';
  listbox.style.border = '1px solid #1a73e8';
  listbox.style.borderRadius = '3px';
  listbox.style.boxShadow = '0 2px 8px rgba(0,0,0,0.18)';
  listbox.style.font = '13px system-ui, sans-serif';
  listbox.style.color = '#202124';
  listbox.style.maxHeight = '220px';
  listbox.style.overflowY = 'auto';
  listbox.style.boxSizing = 'border-box';
  // Fable 5 P2-1: listbox 自体（枠・内部スクロールバー＝候補16件超で出現）への pointerdown で常駐 textarea が
  // blur → キー操作不能になるのを防ぐ。候補 div の pointerdown（確定）より前に preventDefault で focus を保持する
  // （候補 div の handler は stopPropagation しないため、ここでも preventDefault されるが確定処理は候補側で行う）。
  listbox.addEventListener('pointerdown', (event) => {
    event.preventDefault();
  });
  host.appendChild(listbox);

  const indicator = document.createElement('div');
  indicator.className = 'ns-select-indicator';
  indicator.textContent = '▼';
  indicator.style.position = 'absolute';
  indicator.style.display = 'none';
  indicator.style.zIndex = INDICATOR_Z;
  indicator.style.font = '9px system-ui, sans-serif';
  indicator.style.color = '#5f6368';
  indicator.style.pointerEvents = 'none';
  indicator.style.lineHeight = '1';
  host.appendChild(indicator);

  let optionEls: HTMLDivElement[] = [];

  function renderOptions(): void {
    listbox.replaceChildren();
    optionEls = controller.getOptions().map((value, index) => {
      const el = document.createElement('div');
      el.className = 'ns-select-option';
      el.setAttribute('role', 'option');
      el.dataset.value = value;
      el.dataset.index = String(index);
      el.textContent = value === '' ? ' ' : value;
      el.style.padding = '3px 10px';
      el.style.cursor = 'pointer';
      el.style.whiteSpace = 'nowrap';
      // 候補クリックは pointerdown で確定する。preventDefault で常駐 textarea の focus を奪わない（I-5）。
      el.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        controller.setHighlight(index);
        paintHighlight();
        config.onConfirm();
      });
      el.addEventListener('mouseenter', () => {
        controller.setHighlight(index);
        paintHighlight();
      });
      listbox.appendChild(el);
      return el;
    });
  }

  function paintHighlight(): void {
    const hi = controller.getHighlightedIndex();
    optionEls.forEach((el, index) => {
      el.style.background = index === hi ? HIGHLIGHT_BG : '';
      el.setAttribute('aria-selected', index === hi ? 'true' : 'false');
    });
    // ハイライトが表示外なら listbox 内をスクロールして可視化する。
    const active = optionEls[hi];
    if (active !== undefined) {
      const boxTop = listbox.scrollTop;
      const boxBottom = boxTop + listbox.clientHeight;
      if (active.offsetTop < boxTop) {
        listbox.scrollTop = active.offsetTop;
      } else if (active.offsetTop + active.offsetHeight > boxBottom) {
        listbox.scrollTop = active.offsetTop + active.offsetHeight - listbox.clientHeight;
      }
    }
  }

  function placeListbox(rect: CellRect | null): void {
    if (rect === null) {
      return;
    }
    listbox.style.minWidth = `${Math.max(rect.width, 80)}px`;
    listbox.style.left = `${rect.x}px`;
    listbox.style.top = `${rect.y + rect.height}px`;
  }

  return {
    controller,
    isOpen: () => controller.isOpen(),
    open: ({ rect, options, currentValue }) => {
      controller.open({ options, currentValue });
      renderOptions();
      paintHighlight();
      listbox.style.display = 'block';
      placeListbox(rect);
    },
    highlightNext: () => {
      controller.highlightNext();
      paintHighlight();
    },
    highlightPrev: () => {
      controller.highlightPrev();
      paintHighlight();
    },
    confirmValue: () => {
      const value = controller.getHighlightedValue();
      controller.close();
      listbox.style.display = 'none';
      listbox.replaceChildren();
      optionEls = [];
      return value;
    },
    close: () => {
      controller.close();
      listbox.style.display = 'none';
      listbox.replaceChildren();
      optionEls = [];
    },
    refresh: ({ openRect, indicatorRect }) => {
      if (controller.isOpen()) {
        placeListbox(openRect);
      }
      if (indicatorRect === null) {
        indicator.style.display = 'none';
      } else {
        indicator.style.display = 'block';
        // セル右端の内側（少し内側）へ ▼ を出す。
        indicator.style.left = `${indicatorRect.x + indicatorRect.width - 12}px`;
        indicator.style.top = `${indicatorRect.y + indicatorRect.height / 2 - 5}px`;
      }
    },
    options: () => controller.getOptions(),
    highlightedIndex: () => controller.getHighlightedIndex(),
    highlightedValue: () => controller.getHighlightedValue(),
    destroy: () => {
      listbox.remove();
      indicator.remove();
    },
  };
}
