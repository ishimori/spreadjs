// 単独グリッドモード（DD-024）の playground consumer。
//
// 共同編集サーバーを一切使わず mount('standalone') する。cell-commit を「利用側 API のモック」＝localStorage へ
// 保存し、次回ロード時に initialData として再注入する（利用側で認証・保存を持つ責務境界の実演＝roadmap §6）。
// E2E は本ページ（standalone.html）を対象に、表示/注入・cell-commit・F5 復元・再mount リークを検証する。
// 内部パッケージ（core/collab/...）は一切 import しない（R1・Facade 経由に一本化）。

import { mount, GRID_API_VERSION } from '@nanairo-sheet/grid';
import type {
  GridColumnDisplayFormat,
  GridColumnFormatRule,
  GridColumnType,
  GridDiagnostic,
  GridEvent,
  GridInstance,
  GridStandaloneData,
} from '@nanairo-sheet/grid';
import { getDebugApi } from '@nanairo-sheet/grid/test-support';
import type { GridDebugApi } from '@nanairo-sheet/grid/test-support';

const stage = document.getElementById('int-stage');
const statusEl = document.getElementById('int-status');
if (!(stage instanceof HTMLElement)) {
  throw new Error('#int-stage が見つかりません');
}

const COLUMN_ORDER = ['col-a', 'col-b', 'col-c', 'col-d'];
const SEED_ROW_COUNT = 20;

// DD-027-1: 選択式入力列を URL で指定できる（E2E 用・main.ts と同形式）。
// 形式: `?select=col-b:進行中|受注|失注`（複数列は `,`・列末尾 `!free` で allowFreeText:true）。
function parseColumnTypes(raw: string | null): Record<string, GridColumnType> | undefined {
  if (raw === null || raw === '') {
    return undefined;
  }
  const columnTypes: Record<string, GridColumnType> = {};
  for (const spec of raw.split(',')) {
    const colonAt = spec.indexOf(':');
    if (colonAt < 0) {
      continue;
    }
    const columnId = spec.slice(0, colonAt);
    let optionsPart = spec.slice(colonAt + 1);
    const allowFreeText = optionsPart.endsWith('!free');
    if (allowFreeText) {
      optionsPart = optionsPart.slice(0, -'!free'.length);
    }
    const options = optionsPart.split('|').filter((o) => o !== '');
    if (columnId !== '' && options.length > 0) {
      columnTypes[columnId] = allowFreeText ? { type: 'select', options, allowFreeText: true } : { type: 'select', options };
    }
  }
  return Object.keys(columnTypes).length > 0 ? columnTypes : undefined;
}
// DD-027-2: ハイパーリンク列を URL で指定できる（E2E 用・main.ts と同形式）。
// 形式: `?link=col-b`（複数列は `,`・列末尾 `!open` で defaultOpen:true）。select と併用時は同一 columnTypes へマージ。
function parseLinkColumns(
  raw: string | null,
  base: Record<string, GridColumnType> | undefined,
): Record<string, GridColumnType> | undefined {
  const columnTypes: Record<string, GridColumnType> = { ...(base ?? {}) };
  if (raw !== null && raw !== '') {
    for (const spec of raw.split(',')) {
      let columnId = spec;
      const defaultOpen = columnId.endsWith('!open');
      if (defaultOpen) {
        columnId = columnId.slice(0, -'!open'.length);
      }
      if (columnId !== '') {
        columnTypes[columnId] = defaultOpen ? { type: 'link', defaultOpen: true } : { type: 'link' };
      }
    }
  }
  return Object.keys(columnTypes).length > 0 ? columnTypes : undefined;
}
// DD-027-3: セル書式ルールを URL で指定できる（E2E 用・main.ts と同形式）。Fable P3: standalone も配線し駆動可能にする
// （書式描画は mount-controller の buildColumnTypeRegistry→getCellStyle 経路が両モード共通＝経路は既に共有）。
// 形式: `?format=col-b:進行中=badge+bc#34a853+fg#ffffff;受注=bg#fde293`（列は `,`・ルールは `;`・match は `|`）。
function parseColumnFormats(raw: string | null): Record<string, GridColumnFormatRule[]> | undefined {
  if (raw === null || raw === '') {
    return undefined;
  }
  const columnFormats: Record<string, GridColumnFormatRule[]> = {};
  for (const columnSpec of raw.split(',')) {
    const colonAt = columnSpec.indexOf(':');
    if (colonAt < 0) {
      continue;
    }
    const columnId = columnSpec.slice(0, colonAt);
    const rulesPart = columnSpec.slice(colonAt + 1);
    if (columnId === '' || rulesPart === '') {
      continue;
    }
    const rules: GridColumnFormatRule[] = [];
    for (const ruleSpec of rulesPart.split(';')) {
      const eqAt = ruleSpec.indexOf('=');
      if (eqAt < 0) {
        continue;
      }
      const match = ruleSpec.slice(0, eqAt).split('|').filter((m) => m !== '');
      const style: { cellBackground?: string; textColor?: string; badge?: boolean; badgeColor?: string } = {};
      for (const token of ruleSpec.slice(eqAt + 1).split('+')) {
        if (token === 'badge') {
          style.badge = true;
        } else if (token.startsWith('bg')) {
          style.cellBackground = token.slice(2);
        } else if (token.startsWith('fg')) {
          style.textColor = token.slice(2);
        } else if (token.startsWith('bc')) {
          style.badgeColor = token.slice(2);
        }
      }
      if (match.length > 0) {
        rules.push({ match: match.length === 1 ? match[0]! : match, style });
      }
    }
    if (rules.length > 0) {
      columnFormats[columnId] = rules;
    }
  }
  return Object.keys(columnFormats).length > 0 ? columnFormats : undefined;
}
// DD-033-2: 列見出しキャプションを URL で指定できる（E2E 用・main.ts と同形式）。形式: `?caption=col-a:受注日,col-b:金額`。
function parseColumnCaptions(raw: string | null): Record<string, string> | undefined {
  if (raw === null || raw === '') {
    return undefined;
  }
  const captions: Record<string, string> = {};
  for (const spec of raw.split(',')) {
    const colonAt = spec.indexOf(':');
    if (colonAt < 0) {
      continue;
    }
    const columnId = spec.slice(0, colonAt);
    if (columnId !== '') {
      captions[columnId] = spec.slice(colonAt + 1);
    }
  }
  return Object.keys(captions).length > 0 ? captions : undefined;
}
// DD-033-2: 数値/日付の表示書式を URL で指定できる（E2E 用・main.ts と同形式）。
// 形式: `?display=<列>:number;group;dec0;pre¥,<列>:date;YYYY/MM/DD`（spec は `;` 区切りトークン）。
function parseColumnDisplayFormats(raw: string | null): Record<string, GridColumnDisplayFormat> | undefined {
  if (raw === null || raw === '') {
    return undefined;
  }
  const displays: Record<string, GridColumnDisplayFormat> = {};
  for (const spec of raw.split(',')) {
    const colonAt = spec.indexOf(':');
    if (colonAt < 0) {
      continue;
    }
    const columnId = spec.slice(0, colonAt);
    const tokens = spec.slice(colonAt + 1).split(';');
    if (columnId === '') {
      continue;
    }
    if (tokens[0] === 'number') {
      const fmt: {
        type: 'number';
        grouping?: boolean;
        decimals?: number;
        percent?: boolean;
        prefix?: string;
        suffix?: string;
      } = { type: 'number' };
      for (const token of tokens.slice(1)) {
        if (token === 'group') {
          fmt.grouping = true;
        } else if (token === 'pct') {
          fmt.percent = true;
        } else if (token.startsWith('dec')) {
          fmt.decimals = Number(token.slice(3));
        } else if (token.startsWith('pre')) {
          fmt.prefix = token.slice(3);
        } else if (token.startsWith('suf')) {
          fmt.suffix = token.slice(3);
        }
      }
      displays[columnId] = fmt;
    } else if (tokens[0] === 'date') {
      displays[columnId] = { type: 'date', pattern: tokens[1] ?? '' };
    }
  }
  return Object.keys(displays).length > 0 ? displays : undefined;
}
const searchParams = new URLSearchParams(location.search);
const columnTypes = parseLinkColumns(searchParams.get('link'), parseColumnTypes(searchParams.get('select')));
const columnFormats = parseColumnFormats(searchParams.get('format'));
const columnCaptions = parseColumnCaptions(searchParams.get('caption'));
const columnDisplayFormats = parseColumnDisplayFormats(searchParams.get('display'));
// DD-033-1: 表示専用モードを URL で指定できる（E2E 用・?select= 等と同流儀）。例: `?readonly=1`。
const readOnly = searchParams.get('readonly') === '1';

// 利用側の保存モック（localStorage）。cell-commit を rowId|columnId→value で蓄積し、次回 initialData に混ぜる。
const SAVE_KEY = 'nsheet:standalone:cells';
type SavedCells = Record<string /* rowId */, Record<string /* columnId */, string>>;

function loadSaved(): SavedCells {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw === null ? {} : (JSON.parse(raw) as SavedCells);
  } catch {
    return {};
  }
}
function persist(saved: SavedCells): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(saved));
  } catch {
    // 保存不可（プライベートモード等）でも致命ではない。
  }
}

/** シード行（r0..r19）＋保存済み値をマージした初期データを組む（F5 復元の実演）。 */
function buildInitialData(): GridStandaloneData {
  const saved = loadSaved();
  const rows: GridStandaloneData['rows'] = Array.from({ length: SEED_ROW_COUNT }, (_, i) => {
    const rowId = `r${i}`;
    // 既定シード: col-a に行ラベル。保存済み値があれば上書き。
    const cells: Record<string, string> = { 'col-a': `行${i}` };
    Object.assign(cells, saved[rowId] ?? {});
    return { rowId, cells };
  });
  return { rows };
}

const events: GridEvent[] = [];
// DD-033-1: 診断エントリ（readonly-mode/readonly-blocked/readonly-invalid 等）を記録して E2E から検証する（notice 検証用）。
const diagnostics: GridDiagnostic[] = [];
let connLabel = '未接続';

function renderBar(): void {
  if (statusEl !== null) {
    statusEl.textContent = `SDK ${GRID_API_VERSION} ｜ 単独モード ｜ 接続: ${connLabel} ｜ cell-commit: ${events.filter((e) => e.type === 'cell-commit').length} 件`;
  }
}

function onEvent(event: GridEvent): void {
  events.push(event);
  if (event.type === 'cell-commit') {
    // 利用側 API（モック）へ保存する（決定②「通知のみ」＝grid は書き戻さない・利用側が保存）。
    const saved = loadSaved();
    for (const change of event.changes) {
      const row = saved[change.rowId] ?? (saved[change.rowId] = {});
      row[change.columnId] = change.value;
    }
    persist(saved);
  } else if (event.type === 'error') {
    connLabel = `error[${event.phase}]: ${event.message}`;
  }
  renderBar();
}

/** consumer が公開 API だけで grid を制御するハンドル（route 遷移・E2E 駆動用）。 */
interface StandaloneHandle {
  instance: GridInstance | null;
  readonly events: GridEvent[];
  /** DD-033-1: 診断エントリ列（readOnly 抑止 notice 等の観測用）。 */
  readonly diagnostics: GridDiagnostic[];
  connectionState(): string;
  mount(): void;
  destroy(): void;
  /** 再注入デモ（決定③）: 指定データで setData を呼ぶ。 */
  reinject(data: GridStandaloneData): void;
  /** localStorage の保存モックを消す（テストの独立性）。 */
  clearSaved(): void;
}

const handle: StandaloneHandle = {
  instance: null,
  events,
  diagnostics,
  connectionState(): string {
    return this.instance?.connectionState() ?? 'none';
  },
  mount(): void {
    if (this.instance !== null) {
      return;
    }
    const instance = mount(
      { container: stage },
      {
        mode: 'standalone',
        columnOrder: COLUMN_ORDER,
        initialData: buildInitialData(),
        ...(columnTypes !== undefined ? { columnTypes } : {}),
        ...(columnFormats !== undefined ? { columnFormats } : {}),
        ...(columnCaptions !== undefined ? { columnCaptions } : {}),
        ...(columnDisplayFormats !== undefined ? { columnDisplayFormats } : {}),
        ...(readOnly ? { readOnly: true } : {}),
        onEvent,
        onDiagnostic: (entry) => {
          diagnostics.push(entry);
        },
      },
    );
    this.instance = instance;
    connLabel = instance.connectionState();
    renderBar();
    instance.focus();
    // E2E introspection（displayCell/ready 等）を公開する（test-support 経由・mount 直後に登録済み）。
    window.__integrationTestApi = getDebugApi(instance);
    window.__gridInstance = instance;
  },
  destroy(): void {
    this.instance?.destroy();
    this.instance = null;
    window.__integrationTestApi = undefined;
    window.__gridInstance = undefined;
    connLabel = '未接続';
    renderBar();
  },
  reinject(data: GridStandaloneData): void {
    this.instance?.setData(data);
  },
  clearSaved(): void {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      // no-op
    }
  },
};

declare global {
  interface Window {
    __standalone?: StandaloneHandle;
    __integrationTestApi?: GridDebugApi;
    __gridInstance?: GridInstance;
  }
}

window.__standalone = handle;
renderBar();
handle.mount();
