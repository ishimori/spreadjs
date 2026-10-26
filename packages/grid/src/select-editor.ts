// select-editor（DD-027-1）: 選択式入力列のドロップダウン。
//
// 【分離】純粋状態コントローラ（open/close/highlight・DOM 非依存＝TDD 対象）＋ 薄い DOM アダプタ（listbox
// オーバーレイ・▼ インジケーター・rAF placement 追従＝badge と同方式）。加えて keydown の前段裁定 `decideSelectKey`
// を純関数として切り出す（integration-editor の interceptKeydown から状態機械の前で評価する・IME 経路無改変）。
// listbox の位置は可視域に収める（DD-055・popup-placement の純関数）。
//
// セル編集用の状態機械は変更しない。searchable の検索欄は独立した native input で、候補だけを既存確定経路へ渡す。
// 既定の候補欄は従来どおり常駐 textarea に focus を保つ。検索欄だけは focus を移し、内部移動と外部 blur を区別する。
//   フォーカスは常駐 textarea のまま（I-5 維持）。↑↓/Enter/Esc は mount-controller の interceptKeydown が消費して
//   本コントローラへ転送する。候補クリックは listbox の pointerdown（preventDefault で focus を textarea に保つ）。
//   composition 中は decideSelectKey が必ず 'none' を返す（前段消費しない＝I-3）。

import type { EditPhase } from '@nanairo-sheet/ime';
import type { CellRect } from '@nanairo-sheet/render';

import { computePopupPlacement, type PopupDirection, type VisibleArea } from './popup-placement';

// ---- 純粋コントローラ（TDD 対象） ------------------------------------------------------------

/**
 * 前方一致で候補を絞る（DD-037 決定③・純関数＝TDD 対象）。空プレフィクスは全件。大小文字は無視する
 * （英数の品番コードで実用的・日本語には影響しない）。**絞り込みは表示だけの関心**で、commit 検証
 * （`validateEditorCommit`）とは無関係＝候補 0 件でも自由入力は続けられる。
 */
export function filterOptionsByPrefix(options: readonly string[], prefix: string): readonly string[] {
  if (prefix === '') {
    return [...options];
  }
  const needle = prefix.toLowerCase();
  return options.filter((option) => option.toLowerCase().startsWith(needle));
}

/** 候補のみの列の文字選択（DD-057）。空入力・不一致は未選択。候補一覧の順で最初の一致を選ぶ。 */
export function findOptionIndexByPrefix(options: readonly string[], prefix: string): number {
  if (prefix === '') {
    return -1;
  }
  const needle = prefix.toLowerCase();
  return options.findIndex((option) => option.toLowerCase().startsWith(needle));
}

/** 検索付き候補用。表示値は保持し、検索キーだけ NFKC・大小文字・空白を正規化する。 */
export function filterOptionsBySubstring(options: readonly string[], query: string): readonly string[] {
  const normalize = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
  const needle = normalize(query);
  return options.filter((option) => normalize(option).includes(needle));
}

export interface SelectController {
  isOpen(): boolean;
  /**
   * 開く（候補・現値ハイライト）。現値が候補に無ければ先頭をハイライト。
   * `highlight:false`（DD-037 の suggest モード）はハイライト無しで開く＝Enter は候補でなく入力文字列を確定する
   * （決定④「ハイライトなしなら入力文字列をそのまま確定」）。
   */
  open(params: { readonly options: readonly string[]; readonly currentValue: string; readonly highlight?: boolean | undefined }): void;
  /**
   * 開いたまま候補を差し替える（DD-037 決定③の絞り込み）。ハイライトは解除する
   * （絞り込み結果を勝手に選ばせない＝入力文字列の確定を邪魔しない）。
   */
  setOptions(options: readonly string[]): void;
  getOptions(): readonly string[];
  getHighlightedIndex(): number;
  /** ハイライト中の候補値（未 open/候補空は null）。 */
  getHighlightedValue(): string | null;
  highlightNext(): void;
  highlightPrev(): void;
  setHighlight(index: number): void;
  /** DD-057: 開いている間の検索文字列に1文字を追加し、最初の前方一致を選ぶ。不一致なら選択を外す。 */
  typeCharacter(character: string): void;
  /** 検索文字列の末尾を1文字消す。未入力なら何もしない。全消去では選択を外す。 */
  backspace(): void;
  close(): void;
}

export function createSelectController(): SelectController {
  let open = false;
  let options: readonly string[] = [];
  let highlighted = -1;
  let prefix = '';

  const clamp = (index: number): number => {
    if (options.length === 0) {
      return -1;
    }
    return Math.min(Math.max(index, 0), options.length - 1);
  };

  return {
    isOpen: () => open,
    open: ({ options: opts, currentValue, highlight = true }) => {
      open = true;
      options = [...opts];
      prefix = '';
      if (!highlight) {
        highlighted = -1; // suggest モード: 明示的に ↑↓ を押すまで何も選ばれていない状態で開く。
        return;
      }
      const idx = options.indexOf(currentValue);
      highlighted = idx >= 0 ? idx : clamp(0);
    },
    setOptions: (opts) => {
      if (!open) {
        return;
      }
      options = [...opts];
      prefix = '';
      highlighted = -1; // 絞り込みのたびにハイライトを解除（入力文字列の確定を既定に保つ）。
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
    typeCharacter: (character) => {
      if (open) {
        prefix += character;
        highlighted = findOptionIndexByPrefix(options, prefix);
      }
    },
    backspace: () => {
      if (open && prefix.length > 0) {
        prefix = prefix.slice(0, -1);
        highlighted = findOptionIndexByPrefix(options, prefix);
      }
    },
    close: () => {
      open = false;
      options = [];
      highlighted = -1;
      prefix = '';
    },
  };
}

// ---- keydown 前段裁定（純関数・TDD 対象） ---------------------------------------------------

export type SelectKeyDecision =
  /** 前段消費しない（従来経路＝undo/redo・行操作・navigation・状態機械へ流す）。 */
  | 'none'
  /** 選択式列で編集開始キー（F2/Enter/Alt+↓・厳格モードでは印字文字も）→ ドロップダウンを開く。 */
  | 'open'
  /** DD-057: 候補のみの列で、開いた候補を打った文字で選ぶ。 */
  | 'type'
  | 'backspace'
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
  /** アクティブセルが選択式列（候補 UI の対象）か。DD-037 以降は `allowFreeText` の値によらず選択式列なら true。 */
  readonly isSelectCell: boolean;
  /**
   * アクティブセルの列で自由入力が許可されているか（DD-037 決定①）。既定 false＝従来の厳格モード。
   * - `false`（厳格）: 印字文字でドロップダウンを開き、その文字で候補を選ぶ（DD-057・textarea 編集へ入らせない）。
   * - `true`（自由入力併存）: 印字文字は前段消費せず従来どおり textarea 編集を開始する。候補は明示操作
   *   （F2 / Enter / Alt+↓ / ダブルクリック）で開く＝「候補を出しつつ候補外も打てる」。
   */
  readonly allowsFreeText?: boolean;
}

/** 印字可能な単一文字キー（修飾なし）か（Excel: 選択式セルで文字キー→ドロップダウン）。 */
function isPrintable(input: SelectKeyInput): boolean {
  return input.key.length === 1 && !input.ctrlKey && !input.metaKey && !input.altKey;
}

/**
 * 選択式列の keydown 前段裁定。composition 中（DOM/内部いずれか）と非 Navigation 位相では必ず 'none'
 * （IME・編集中のキー処理は従来どおり状態機械が裁く＝IME 経路無改変・I-3）。open 中は ↑↓/Enter/Esc/Tab を処理し、
 * 候補のみの列の印字文字/Backspace は検索操作、それ以外は 'consume'（textarea への漏れ防止）。
 * 閉じているときは選択式セルでのみ編集開始キーを 'open' に写す
 * （DD-037: 印字文字を 'open' に写すのは厳格モード＝`allowsFreeText:false` のときだけ）。
 */
export function decideSelectKey(input: SelectKeyInput): SelectKeyDecision {
  if (input.eventComposing || input.sessionComposing || input.phase !== 'Navigation') {
    return 'none';
  }
  if (input.isOpen) {
    if (input.allowsFreeText !== true) {
      if (isPrintable(input)) {
        return 'type';
      }
      if (input.key === 'Backspace' && !input.ctrlKey && !input.metaKey && !input.altKey) {
        return 'backspace';
      }
    }
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
        // 検索以外のキーは握り潰す（自由入力併存列の印字文字も従来どおり）。
        // Alt+Down 等の修飾キー単独 press は consume で無害化。
        return 'consume';
    }
  }
  if (!input.isSelectCell) {
    return 'none';
  }
  // 閉じている & 選択式セル: 編集開始キー（F2・Enter・Alt+↓）でドロップダウンを開く。
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
  // 印字文字は「厳格モードだけ」ドロップダウンを開く（DD-037 決定①）。自由入力併存列では前段消費せず
  // 従来どおり textarea 編集を開始する（候補外の値を打ち切れることが併存の肝＝決定④）。
  if (isPrintable(input) && input.allowsFreeText !== true) {
    return 'open';
  }
  return 'none';
}

// ---- 薄い DOM アダプタ（listbox オーバーレイ・▼ インジケーター・E2E 対象） -------------------

const LISTBOX_Z = '30'; // 常駐 textarea(10)・badge(12) より上
const INDICATOR_Z = '11';
const HIGHLIGHT_BG = '#e8f0fe';
// listbox の高さの既定の上限。可視域の余白がこれより狭ければ余白の高さまで縮める（DD-055）。
const LISTBOX_MAX_HEIGHT = 220;
let dropdownSequence = 0;

export interface SelectDropdownConfig {
  /** listbox/indicator を配置するコンテナ（position:relative の stage）。 */
  readonly host: HTMLElement;
  /** 候補クリック（pointerdown）での確定要求。mount-controller が SetCells を組んで submit する。 */
  readonly onConfirm: () => void;
  readonly onDismiss?: (restoreFocus: boolean) => void;
  readonly font?: string;
  /** DD-055（RC16）: 可視域（ネイティブスクロールバーを除く stage 座標の幅・高さ）。listbox をこの中に収める（開いている間だけ読む）。 */
  readonly visibleArea: () => VisibleArea;
}

export interface SelectDropdown {
  readonly controller: SelectController;
  isOpen(): boolean;
  contains(target: EventTarget | null): boolean;
  /**
   * 開く（セルの真下。下に入りきらず上の余白のほうが広ければセルの上＝DD-055）。向きは開いた時点で決め、閉じるまで保つ。
   * `highlight:false` はハイライト無しで開く（DD-037 suggest モード）。
   */
  open(params: {
    readonly rect: CellRect | null;
    readonly options: readonly string[];
    readonly currentValue: string;
    readonly highlight?: boolean;
    readonly searchable?: boolean;
  }): void;
  /** 開いたまま候補を差し替える（DD-037 決定③の絞り込み。ハイライトは解除される）。 */
  setOptions(options: readonly string[]): void;
  highlightNext(): void;
  highlightPrev(): void;
  /** DD-057: 候補のみの列で文字を追加し、ハイライト表示を更新する。 */
  typeCharacter(character: string): void;
  backspace(): void;
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
  listbox.style.font = config.font ?? '13px system-ui, sans-serif';
  listbox.style.color = '#202124';
  listbox.style.maxHeight = `${LISTBOX_MAX_HEIGHT}px`;
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

  const optionsBox = document.createElement('div');
  optionsBox.id = `ns-select-options-${++dropdownSequence}`;
  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'ns-select-search';
  search.placeholder = '名前の一部で検索';
  search.setAttribute('aria-label', '候補を検索');
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-autocomplete', 'list');
  search.setAttribute('aria-controls', optionsBox.id);
  search.style.cssText = 'position:sticky;top:0;z-index:1;width:100%;box-sizing:border-box;padding:8px;border:0;border-bottom:1px solid #cbd5e1;background:white;color:#202124;font:inherit;outline-offset:-2px';
  const empty = document.createElement('div');
  empty.textContent = '候補がありません';
  empty.setAttribute('role', 'status');
  empty.style.padding = '8px 10px';
  let searchable = false;
  let allOptions: readonly string[] = [];
  let composing = false;
  let compositionSettling = false;
  search.addEventListener('pointerdown', (event) => event.stopPropagation());
  search.addEventListener('compositionstart', () => { composing = true; });
  search.addEventListener('compositionend', () => {
    composing = false;
    // 同一イベントループの IME 確定 Enter を候補確定に転用しない。
    compositionSettling = true;
    queueMicrotask(() => { compositionSettling = false; });
    updateSearch();
  });
  search.addEventListener('input', () => { if (!composing) updateSearch(); });
  search.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (composing || compositionSettling || event.isComposing || event.keyCode === 229) return;
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); controller.highlightNext(); paintHighlight(); break;
      case 'ArrowUp': event.preventDefault(); controller.highlightPrev(); paintHighlight(); break;
      case 'Enter': event.preventDefault(); config.onConfirm(); break;
      case 'Escape': event.preventDefault(); config.onDismiss?.(true); break;
      case 'Tab': config.onDismiss?.(true); break;
    }
  });
  search.addEventListener('blur', (event) => {
    if (controller.isOpen() && !(event.relatedTarget instanceof Node && listbox.contains(event.relatedTarget))) {
      config.onDismiss?.(false);
    }
  });

  let optionEls: HTMLDivElement[] = [];
  // DD-055: 開いた時点で決めた向き（スクロール・絞り込みで上下に跳ねないよう閉じるまで保つ）。閉じている間は null。
  let direction: PopupDirection | null = null;

  function renderOptions(): void {
    optionsBox.replaceChildren();
    optionEls = controller.getOptions().map((value, index) => {
      const el = document.createElement('div');
      el.className = 'ns-select-option';
      el.setAttribute('role', 'option');
      el.id = `${optionsBox.id}-${index}`;
      el.dataset.value = value;
      el.dataset.index = String(index);
      el.textContent = value === '' ? ' ' : value;
      el.style.padding = searchable ? '7px 10px' : '3px 10px';
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
      optionsBox.appendChild(el);
      return el;
    });
    if (searchable && optionEls.length === 0) optionsBox.appendChild(empty);
  }

  function updateSearch(): void {
    if (!controller.isOpen()) return;
    controller.setOptions(filterOptionsBySubstring(allOptions, search.value));
    controller.setHighlight(0);
    renderOptions();
    listbox.scrollTop = 0;
    paintHighlight();
  }

  function paintHighlight(): void {
    const hi = controller.getHighlightedIndex();
    optionEls.forEach((el, index) => {
      el.style.background = index === hi ? HIGHLIGHT_BG : '';
      el.setAttribute('aria-selected', index === hi ? 'true' : 'false');
    });
    const selected = optionEls[hi];
    if (selected) search.setAttribute('aria-activedescendant', selected.id);
    else search.removeAttribute('aria-activedescendant');
    // ハイライトが表示外なら listbox 内をスクロールして可視化する。
    const active = optionEls[hi];
    if (active !== undefined) {
      const searchHeight = searchable ? search.offsetHeight : 0;
      const boxTop = listbox.scrollTop + searchHeight;
      const boxBottom = listbox.scrollTop + listbox.clientHeight;
      if (active.offsetTop < boxTop) {
        listbox.scrollTop = active.offsetTop - searchHeight;
      } else if (active.offsetTop + active.offsetHeight > boxBottom) {
        listbox.scrollTop = active.offsetTop + active.offsetHeight - listbox.clientHeight;
      }
    }
  }

  function placeListbox(rect: CellRect | null): void {
    if (rect === null) {
      return;
    }
    listbox.style.minWidth = `${Math.min(config.visibleArea().width, Math.max(rect.width, searchable ? 260 : 80))}px`;
    // 余白で縮める前の高さ＝中身の高さ＋上下の枠（既定の上限まで）。max-height を変えずに測る（内部スクロール位置を保つ）。
    const naturalHeight = Math.min(LISTBOX_MAX_HEIGHT, listbox.scrollHeight + listbox.offsetHeight - listbox.clientHeight);
    const placement = computePopupPlacement({
      cellRect: rect,
      popupWidth: listbox.offsetWidth,
      popupHeight: naturalHeight,
      visibleArea: config.visibleArea(),
      direction: direction ?? undefined,
    });
    direction = placement.direction;
    listbox.style.maxHeight = `${Math.min(LISTBOX_MAX_HEIGHT, placement.maxHeight)}px`;
    listbox.style.left = `${placement.left}px`;
    listbox.style.top = `${placement.top}px`;
  }

  return {
    controller,
    isOpen: () => controller.isOpen(),
    contains: (target) => target instanceof Node && listbox.contains(target),
    open: ({ rect, options, currentValue, highlight, searchable: enableSearch = false }) => {
      searchable = enableSearch;
      allOptions = [...options];
      composing = false;
      search.value = '';
      search.setAttribute('aria-expanded', 'true');
      listbox.replaceChildren(...(searchable ? [search, optionsBox] : [optionsBox]));
      listbox.setAttribute('role', searchable ? 'presentation' : 'listbox');
      if (searchable) { optionsBox.setAttribute('role', 'listbox'); optionsBox.setAttribute('aria-label', '候補'); }
      else optionsBox.removeAttribute('role');
      controller.open({ options, currentValue, highlight });
      direction = null;
      renderOptions();
      listbox.style.display = 'block';
      placeListbox(rect);
      paintHighlight(); // 高さが決まってから、現値のハイライトを listbox の表示範囲へスクロールする
      if (searchable) search.focus({ preventScroll: true });
    },
    setOptions: (options) => {
      if (!controller.isOpen()) {
        return;
      }
      controller.setOptions(options);
      renderOptions();
      paintHighlight();
    },
    highlightNext: () => {
      controller.highlightNext();
      paintHighlight();
    },
    highlightPrev: () => {
      controller.highlightPrev();
      paintHighlight();
    },
    typeCharacter: (character) => {
      if (searchable) { search.value += character; updateSearch(); }
      else { controller.typeCharacter(character); paintHighlight(); }
    },
    backspace: () => {
      if (searchable) { search.value = search.value.slice(0, -1); updateSearch(); }
      else { controller.backspace(); paintHighlight(); }
    },
    confirmValue: () => {
      const value = controller.getHighlightedValue();
      controller.close();
      search.setAttribute('aria-expanded', 'false');
      listbox.style.display = 'none';
      listbox.replaceChildren();
      optionEls = [];
      direction = null;
      return value;
    },
    close: () => {
      controller.close();
      search.setAttribute('aria-expanded', 'false');
      listbox.style.display = 'none';
      listbox.replaceChildren();
      optionEls = [];
      direction = null;
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
