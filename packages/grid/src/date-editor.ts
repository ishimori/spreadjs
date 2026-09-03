// date-editor（DD-035 R2）: 日付列のカレンダー・ポップオーバー。
//
// 【分離】純粋関数（LocalDate 加減算・月グリッド生成＝DOM/時刻非依存）＋純粋状態コントローラ（open/close/highlight・
// TDD 対象）＋ keydown 前段裁定 `decideDateKey`（純関数）＋ 薄い DOM アダプタ（ポップオーバー・📅 インジケーター・
// rAF placement 追従＝select-editor の listbox と同方式）。
//
// 【IME 経路無改変（📐・T1 非該当）】editor-state-machine・ime-editing-session・常駐 textarea は改変しない。
//   フォーカスは常駐 textarea のまま（I-5 維持）。キーは mount-controller の interceptKeydown が消費して本コントローラへ
//   転送する。日クリックはポップオーバーの pointerdown（preventDefault で focus を textarea に保つ）。composition 中は
//   decideDateKey が必ず 'none' を返す（前段消費しない＝I-3）。確定は mount-controller が既存 chokepoint（submitSetCells）へ流す。
//
// 【LocalDate】値は ADR-0012 の `YYYY-MM-DD`。加減算は Date.UTC（タイムゾーン非経由・決定的）で行い JS Date を値にしない。
//   「今日」だけはブラウザのローカル日付（利用者の体感日）を使う（todayLocalDate・テストでは注入可能）。

import type { EditPhase } from '@nanairo-sheet/ime';
import type { CellRect } from '@nanairo-sheet/render';

// ---- 純粋関数（LocalDate・月グリッド） --------------------------------------------------------

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` かつ実在暦日か（core parseCellInput の正準出力と同形）。 */
export function isLocalDate(value: string): boolean {
  const m = LOCAL_DATE_RE.exec(value);
  if (m === null) {
    return false;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** 月の日数（閏年考慮）。 */
export function daysInMonth(year: number, month: number): number {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** (year, month, day) → `YYYY-MM-DD`。 */
export function toLocalDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** `YYYY-MM-DD` → 各フィールド（検証済み前提・非日付は呼び出し側で isLocalDate を通す）。 */
export function splitLocalDate(value: string): { year: number; month: number; day: number } {
  return { year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)), day: Number(value.slice(8, 10)) };
}

// サポートする年範囲（4 桁 LocalDate の契約・ADR-0012）。範囲外へ出る移動は no-op（Codex P2: Date.UTC は 0〜99 年を
// 1900 年代へ写像し、9999 年超は 5 桁になって `kind:'date'` で確定できなくなる）。JS Date を使わず暦計算で行う。
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

/** 暦日 → 1970-01-01 起点の通算日（proleptic Gregorian・Howard Hinnant の days_from_civil）。 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** 通算日 → 暦日（civil_from_days）。 */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

/** 日数加算（負も可・暦計算でタイムゾーン非依存）。結果が 0001〜9999 年を外れるときは元の値を返す（no-op）。 */
export function addDays(value: string, delta: number): string {
  const { year, month, day } = splitLocalDate(value);
  const moved = civilFromDays(daysFromCivil(year, month, day) + delta);
  if (moved.year < MIN_YEAR || moved.year > MAX_YEAR) {
    return value;
  }
  return toLocalDate(moved.year, moved.month, moved.day);
}

/** 月加算（日は移動先の月末で clamp。例: 01-31 +1 → 02-28/29）。0001〜9999 年を外れるときは元の値を返す（no-op）。 */
export function addMonths(value: string, delta: number): string {
  const { year, month, day } = splitLocalDate(value);
  const total = year * 12 + (month - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  if (ny < MIN_YEAR || ny > MAX_YEAR) {
    return value;
  }
  return toLocalDate(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}

/** 曜日（0=日 … 6=土）。1970-01-01 が木曜（4）。 */
export function weekdayOf(value: string): number {
  const { year, month, day } = splitLocalDate(value);
  return (((daysFromCivil(year, month, day) + 4) % 7) + 7) % 7;
}

/** ブラウザのローカル日付（利用者の体感の「今日」）。`now` はテスト注入用。 */
export function todayLocalDate(now: Date = new Date()): string {
  return toLocalDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export interface CalendarCell {
  readonly date: string;
  /** 表示中の月に属するか（前後月の埋め草は false）。 */
  readonly inMonth: boolean;
}

/** 表示月の 6 週×7 日（日曜始まり・42 セル固定＝月送りでポップオーバーの高さが変わらない）。 */
export function buildMonthGrid(year: number, month: number): CalendarCell[] {
  const first = toLocalDate(year, month, 1);
  const start = addDays(first, -weekdayOf(first));
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const date = addDays(start, i);
    cells.push({ date, inMonth: date.slice(0, 7) === first.slice(0, 7) });
  }
  return cells;
}

// ---- 純粋コントローラ（TDD 対象） ------------------------------------------------------------

export interface CalendarController {
  isOpen(): boolean;
  /** 開く。currentValue が LocalDate ならそれを、そうでなければ today をハイライトし、その月を表示する。 */
  open(params: { readonly currentValue: string; readonly today: string }): void;
  /** 表示中の月。 */
  getViewMonth(): { readonly year: number; readonly month: number };
  /** ハイライト中の日付（未 open は null）。 */
  getHighlighted(): string | null;
  moveDays(delta: number): void;
  moveMonths(delta: number): void;
  setHighlight(date: string): void;
  close(): void;
  /** ハイライト中の値を返して閉じる（未 open は null）。 */
  confirmValue(): string | null;
}

export function createCalendarController(): CalendarController {
  let open = false;
  let highlighted: string | null = null;
  let viewYear = 1970;
  let viewMonth = 1;

  const follow = (): void => {
    if (highlighted !== null) {
      const { year, month } = splitLocalDate(highlighted);
      viewYear = year;
      viewMonth = month;
    }
  };

  return {
    isOpen: () => open,
    open: ({ currentValue, today }) => {
      open = true;
      highlighted = isLocalDate(currentValue) ? currentValue : isLocalDate(today) ? today : '1970-01-01';
      follow();
    },
    getViewMonth: () => ({ year: viewYear, month: viewMonth }),
    getHighlighted: () => highlighted,
    moveDays: (delta) => {
      if (open && highlighted !== null) {
        highlighted = addDays(highlighted, delta);
        follow();
      }
    },
    moveMonths: (delta) => {
      if (open && highlighted !== null) {
        highlighted = addMonths(highlighted, delta);
        follow();
      }
    },
    setHighlight: (date) => {
      if (open && isLocalDate(date)) {
        highlighted = date;
        follow();
      }
    },
    close: () => {
      open = false;
      highlighted = null;
    },
    confirmValue: () => {
      const value = highlighted;
      open = false;
      highlighted = null;
      return value;
    },
  };
}

// ---- keydown 前段裁定（純関数・TDD 対象） ---------------------------------------------------

export type DateKeyDecision =
  /** 前段消費しない（従来経路＝手入力・undo/redo・行操作・navigation・状態機械へ流す）。 */
  | 'none'
  /** 日付列で開くキー → カレンダーを開く。 */
  | 'open'
  | 'move-left'
  | 'move-right'
  | 'move-up'
  | 'move-down'
  | 'prev-month'
  | 'next-month'
  /** ハイライト中の日付を確定。 */
  | 'confirm'
  /** 取消（Esc・Tab）。 */
  | 'cancel'
  /** open 中の未処理キーを握り潰す（textarea への漏れ防止・状態変化なし）。 */
  | 'consume';

export interface DateKeyInput {
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
  /** アクティブセルが日付列か（readOnly 列・グリッド readOnly の除外は呼び出し側）。 */
  readonly isDateCell: boolean;
  /** 日付列の開き方（既定 'dblclick'）。 */
  readonly openOn: 'dblclick' | 'icon';
}

/**
 * 日付列の keydown 前段裁定。composition 中（DOM/内部いずれか）と非 Navigation 位相では必ず 'none'（IME・編集中の
 * キー処理は従来どおり状態機械が裁く＝IME 経路無改変・I-3）。open 中は 矢印/PageUp/PageDown/Enter/Esc/Tab を処理し、
 * 残りは 'consume'。閉じているときは日付セルでのみ Alt+↓（常時）と F2/Enter（openOn='dblclick' のみ・修飾なし）を 'open' に
 * 写す。**印字文字は 'none'**＝従来どおり textarea の手入力を開始する（手入力併存・select 列との差）。
 */
export function decideDateKey(input: DateKeyInput): DateKeyDecision {
  if (input.eventComposing || input.sessionComposing || input.phase !== 'Navigation') {
    return 'none';
  }
  if (input.isOpen) {
    switch (input.key) {
      case 'ArrowLeft':
        return 'move-left';
      case 'ArrowRight':
        return 'move-right';
      case 'ArrowUp':
        return 'move-up';
      case 'ArrowDown':
        return 'move-down';
      case 'PageUp':
        return 'prev-month';
      case 'PageDown':
        return 'next-month';
      case 'Enter':
        return 'confirm';
      case 'Escape':
      case 'Tab':
        return 'cancel';
      default:
        return 'consume';
    }
  }
  if (!input.isDateCell) {
    return 'none';
  }
  if (input.key === 'ArrowDown' && input.altKey && !input.ctrlKey && !input.metaKey) {
    return 'open';
  }
  if (
    input.openOn === 'dblclick' &&
    (input.key === 'F2' || input.key === 'Enter') &&
    !input.ctrlKey &&
    !input.metaKey &&
    !input.altKey &&
    !input.shiftKey
  ) {
    return 'open';
  }
  return 'none';
}

// ---- 薄い DOM アダプタ（ポップオーバー・📅 インジケーター・E2E 対象） ----------------------

const POPOVER_Z = '30'; // 常駐 textarea(10)・badge(12) より上（listbox と同層）
const INDICATOR_Z = '11';
const HIGHLIGHT_BG = '#1a73e8';
const HIGHLIGHT_FG = '#ffffff';
const MUTED_FG = '#9aa0a6';
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export interface DatePickerConfig {
  /** ポップオーバー/インジケーターを配置するコンテナ（position:relative の stage）。 */
  readonly host: HTMLElement;
  /** 日クリック・「今日」・「クリア」（value=''）での確定要求。mount-controller が SetCells を組んで submit する。 */
  readonly onConfirm: (value: string) => void;
  /** 📅 インジケーターのクリック（開く要求）。 */
  readonly onIndicatorClick: () => void;
  /** 「今日」の解決（テスト注入用・既定はブラウザのローカル日付）。 */
  readonly today?: () => string;
}

export interface DatePicker {
  readonly controller: CalendarController;
  isOpen(): boolean;
  /** 開く（cellRect の直下へポップオーバーを配置）。 */
  open(params: { readonly rect: CellRect | null; readonly currentValue: string }): void;
  moveDays(delta: number): void;
  moveMonths(delta: number): void;
  /** ハイライト中の値を返して閉じる（未 open は null）。 */
  confirmValue(): string | null;
  close(): void;
  /** rAF 追従: open 中のポップオーバー位置（openRect）と 📅 インジケーター位置（indicatorRect・null=非表示）を更新。 */
  refresh(params: { readonly openRect: CellRect | null; readonly indicatorRect: CellRect | null }): void;
  // E2E introspection
  highlightedValue(): string | null;
  viewMonth(): { year: number; month: number };
  destroy(): void;
}

export function createDatePicker(config: DatePickerConfig): DatePicker {
  const { host } = config;
  const controller = createCalendarController();
  const today = config.today ?? (() => todayLocalDate());

  const popover = document.createElement('div');
  popover.className = 'ns-date-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', '日付を選択');
  popover.style.position = 'absolute';
  popover.style.display = 'none';
  popover.style.zIndex = POPOVER_Z;
  popover.style.background = '#fff';
  popover.style.border = '1px solid #1a73e8';
  popover.style.borderRadius = '3px';
  popover.style.boxShadow = '0 2px 8px rgba(0,0,0,0.18)';
  popover.style.font = '12px system-ui, sans-serif';
  popover.style.color = '#202124';
  popover.style.padding = '6px';
  popover.style.boxSizing = 'border-box';
  popover.style.userSelect = 'none';
  popover.style.width = '224px';
  // 枠・ボタン・日セルへの pointerdown で常駐 textarea が blur しないよう focus を保持する（listbox と同じ・I-5）。
  popover.addEventListener('pointerdown', (event) => {
    event.preventDefault();
  });
  host.appendChild(popover);

  const indicator = document.createElement('div');
  indicator.className = 'ns-date-indicator';
  indicator.textContent = '📅';
  indicator.setAttribute('role', 'button');
  indicator.setAttribute('aria-label', 'カレンダーを開く');
  indicator.style.position = 'absolute';
  indicator.style.display = 'none';
  indicator.style.zIndex = INDICATOR_Z;
  indicator.style.font = '11px system-ui, sans-serif';
  indicator.style.lineHeight = '1';
  indicator.style.cursor = 'pointer';
  indicator.addEventListener('pointerdown', (event) => {
    event.preventDefault(); // focus は textarea のまま
    config.onIndicatorClick();
  });
  host.appendChild(indicator);

  // --- 内容の構築（open/月送り/ハイライト移動のたびに全再描画。42 セル固定＝安価） ---
  function render(): void {
    popover.replaceChildren();
    const { year, month } = controller.getViewMonth();
    const highlighted = controller.getHighlighted();

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.marginBottom = '4px';
    const prev = navButton('‹', 'prev-month', () => {
      controller.moveMonths(-1);
      render();
    });
    const label = document.createElement('span');
    label.className = 'ns-date-month';
    label.textContent = `${year}年${month}月`;
    label.style.fontWeight = '600';
    const next = navButton('›', 'next-month', () => {
      controller.moveMonths(1);
      render();
    });
    header.append(prev, label, next);
    popover.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'ns-date-grid';
    grid.setAttribute('role', 'grid');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(7, 1fr)';
    grid.style.gap = '1px';
    for (const wd of WEEKDAYS) {
      const el = document.createElement('div');
      el.textContent = wd;
      el.style.textAlign = 'center';
      el.style.color = MUTED_FG;
      el.style.padding = '2px 0';
      grid.appendChild(el);
    }
    for (const cell of buildMonthGrid(year, month)) {
      const el = document.createElement('div');
      el.className = 'ns-date-day';
      el.setAttribute('role', 'gridcell');
      el.dataset.date = cell.date;
      el.textContent = String(Number(cell.date.slice(8, 10)));
      el.style.textAlign = 'center';
      el.style.padding = '3px 0';
      el.style.borderRadius = '3px';
      el.style.cursor = 'pointer';
      el.style.color = cell.inMonth ? '#202124' : MUTED_FG;
      if (cell.date === highlighted) {
        el.style.background = HIGHLIGHT_BG;
        el.style.color = HIGHLIGHT_FG;
        el.setAttribute('aria-selected', 'true');
      }
      // 日クリックは pointerdown で確定する（preventDefault は popover 側・focus は textarea のまま）。
      el.addEventListener('pointerdown', () => {
        controller.setHighlight(cell.date);
        config.onConfirm(cell.date);
      });
      grid.appendChild(el);
    }
    popover.appendChild(grid);

    const footer = document.createElement('div');
    footer.style.display = 'flex';
    footer.style.justifyContent = 'space-between';
    footer.style.marginTop = '4px';
    footer.append(
      navButton('今日', 'today', () => {
        config.onConfirm(today());
      }),
      navButton('クリア', 'clear', () => {
        config.onConfirm('');
      }),
    );
    popover.appendChild(footer);
  }

  function navButton(text: string, action: string, onPress: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1; // focus は常駐 textarea に留める
    button.className = `ns-date-${action}`;
    button.dataset.action = action;
    button.textContent = text;
    button.style.font = 'inherit';
    button.style.padding = '1px 6px';
    button.style.cursor = 'pointer';
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      onPress();
    });
    return button;
  }

  function placePopover(rect: CellRect | null): void {
    if (rect === null) {
      return;
    }
    popover.style.left = `${rect.x}px`;
    popover.style.top = `${rect.y + rect.height}px`;
  }

  return {
    controller,
    isOpen: () => controller.isOpen(),
    open: ({ rect, currentValue }) => {
      controller.open({ currentValue, today: today() });
      render();
      popover.style.display = 'block';
      placePopover(rect);
    },
    moveDays: (delta) => {
      controller.moveDays(delta);
      render();
    },
    moveMonths: (delta) => {
      controller.moveMonths(delta);
      render();
    },
    confirmValue: () => {
      const value = controller.confirmValue();
      popover.style.display = 'none';
      popover.replaceChildren();
      return value;
    },
    close: () => {
      controller.close();
      popover.style.display = 'none';
      popover.replaceChildren();
    },
    refresh: ({ openRect, indicatorRect }) => {
      if (controller.isOpen()) {
        placePopover(openRect);
      }
      if (indicatorRect === null) {
        indicator.style.display = 'none';
      } else {
        indicator.style.display = 'block';
        // セル右端の内側へ 📅 を出す（select の ▼ と同じ位置取り）。
        indicator.style.left = `${indicatorRect.x + indicatorRect.width - 15}px`;
        indicator.style.top = `${indicatorRect.y + indicatorRect.height / 2 - 6}px`;
      }
    },
    highlightedValue: () => controller.getHighlighted(),
    viewMonth: () => controller.getViewMonth(),
    destroy: () => {
      popover.remove();
      indicator.remove();
    },
  };
}
