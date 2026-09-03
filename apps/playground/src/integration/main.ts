// 統合 PoC ページ（playground）— @nanairo-sheet/grid Facade の consumer。
//
// 旧 integration/main.ts の手組み配線（transport / sessionSync / render / integration-editor / rAF / tick / handlers）は
// grid Facade の mount() が内部で担う（DD-016 で package へ昇華）。本ファイルは **Facade の consumer** として:
//   ① size 済み container（#int-stage）を渡して mount（Facade が Canvas/scroller/常駐 textarea を構築）
//   ② GridEvent（接続状態・pending・競合・エラー）を購読して #int-status に表示
//   ③ E2E 用の深い introspection を test-support（getDebugApi）経由で window へ公開する（旧 __integrationTestApi の後継）
// のみを行う。内部パッケージ（core/collab/render/...）は一切 import しない（R1・Facade 経由に一本化）。

import { mount } from '@nanairo-sheet/grid';
import type {
  GridColumnDisplayFormat,
  GridColumnFormatRule,
  GridColumnType,
  GridEvent,
  GridInstance,
} from '@nanairo-sheet/grid';
import { getDebugApi } from '@nanairo-sheet/grid/test-support';
import type { GridDebugApi } from '@nanairo-sheet/grid/test-support';

declare global {
  interface Window {
    /** E2E 検査用 introspection（test-support 経由・boot 前でも mount 直後から利用可）。 */
    __integrationTestApi?: GridDebugApi;
    __gridInstance?: GridInstance;
    /** E2E 用: 受信した GridEvent の記録（DD-027-1 config error の code 検証等）。 */
    __gridEvents?: GridEvent[];
  }
}

// DD-027-1: E2E が config error の公開 code（column-types-invalid 等）を検査できるよう受信イベントを記録する。
const gridEvents: GridEvent[] = [];
window.__gridEvents = gridEvents;

const stage = document.getElementById('int-stage');
const statusEl = document.getElementById('int-status');
if (!(stage instanceof HTMLElement)) {
  throw new Error('#int-stage が見つかりません');
}

const params = new URLSearchParams(location.search);
const serverUrl = params.get('server') ?? 'http://127.0.0.1:8787';
const nameParam = params.get('name');
// DD-012-5: 折り返し（wrap）列を URL で指定できる（E2E 用・例 ?wrap=col-2,col-3）。既定は無し（オーバーフローのみ）。
const wrapParam = params.get('wrap');
const wrapColumns = wrapParam !== null && wrapParam !== '' ? wrapParam.split(',') : undefined;

// DD-027-1: 選択式入力列を URL で指定できる（E2E 用・?wrap= と同方式）。
// 形式: `?select=col-3:進行中|受注|失注`（複数列は `,` 区切り）。列末尾に `!free` を付けると allowFreeText:true。
// 例: `?select=col-3:進行中|受注|失注,col-5:A|B|C!free`
const selectParam = params.get('select');
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
      columnTypes[columnId] = allowFreeText
        ? { type: 'select', options, allowFreeText: true }
        : { type: 'select', options };
    }
  }
  return Object.keys(columnTypes).length > 0 ? columnTypes : undefined;
}
// DD-027-2: ハイパーリンク列を URL で指定できる（E2E 用・?select= と同方式）。
// 形式: `?link=col-4`（複数列は `,` 区切り）。列末尾に `!open` を付けると defaultOpen:true（絶対 http/https のみ open）。
// 例: `?link=col-4,col-6!open`。select と併用時は同一 columnTypes へマージする（同一列指定は link を優先＝後勝ち）。
const linkParam = params.get('link');
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
// DD-033-1: 表示専用モードを URL で指定できる（E2E 用・?select= 等と同流儀）。例: `?readonly=1`。
const readOnly = params.get('readonly') === '1';
const columnTypes = parseLinkColumns(linkParam, parseColumnTypes(selectParam));

// DD-027-3: セル書式ルールを URL で指定できる（E2E/計測用・?select= と同方式）。
// 形式: `?format=<列>:<ルール>;<ルール>,<列>:...`
//   列 = `columnId:ルール群`／ルール = `<match|match>=<style+style>`／match は `|` で複数指定。
//   style トークン: `bg#RRGGBB`（背景色）・`fg#RRGGBB`（文字色）・`badge`（フラグ）・`bc#RRGGBB`（バッジ色）。
//   例: `?format=col-3:進行中=badge+bc#34a853+fg#ffffff;受注=bg#fde293,col-5:高=bg#fce8e6`
const formatParam = params.get('format');
function parseColumnFormats(
  raw: string | null,
): Record<string, GridColumnFormatRule[]> | undefined {
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
      const style: {
        cellBackground?: string;
        textColor?: string;
        badge?: boolean;
        badgeColor?: string;
      } = {};
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
const columnFormats = parseColumnFormats(formatParam);

// DD-033-2: 列見出しキャプションを URL で指定できる（E2E 用・?format= と同流儀）。
// 形式: `?caption=col-3:状態,col-4:受注金額`（列は `,`・columnId と表示名は最初の `:` で区切る）。
const captionParam = params.get('caption');
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
    const caption = spec.slice(colonAt + 1);
    if (columnId !== '') {
      captions[columnId] = caption;
    }
  }
  return Object.keys(captions).length > 0 ? captions : undefined;
}
// DD-033-2: 数値/日付の表示書式を URL で指定できる（E2E 用・?format= と同流儀）。
// 形式: `?display=<列>:<spec>,<列>:<spec>`。spec は `;` 区切りトークン。
//   number: `number` に続けて `group`（カンマ）・`dec<N>`（小数桁）・`pct`（%）・`pre<文字列>`（prefix）・`suf<文字列>`（suffix）。
//   date:   `date` に続けて 1 つ目のトークンをパターンとして扱う（例 `date;YYYY/MM/DD`）。
//   例: `?display=col-4:number;group;dec0;pre¥,col-5:date;YYYY-MM-DD HH:mm,col-6:number;pct;dec1`
const displayParam = params.get('display');
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
    const kind = tokens[0];
    if (columnId === '') {
      continue;
    }
    if (kind === 'number') {
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
    } else if (kind === 'date') {
      const pattern = tokens[1] ?? '';
      displays[columnId] = { type: 'date', pattern };
    }
  }
  return Object.keys(displays).length > 0 ? displays : undefined;
}
const columnCaptions = parseColumnCaptions(captionParam);
const columnDisplayFormats = parseColumnDisplayFormats(displayParam);

// DD-012-4: 列幅・行高は view-local。利用側（このページ）が localStorage へ保存し、次回 mount の初期値へ渡す
// ＝F5 リロードで復元される（保存・復元は利用側アプリの責務という D1/D2 契約の実演）。
const LAYOUT_KEY = 'nsheet:playground:layout';
interface SavedLayout {
  columnWidths: Record<string, number>;
  rowHeights: Record<string, number>;
}
function loadLayout(): SavedLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw === null) {
      return { columnWidths: {}, rowHeights: {} };
    }
    const parsed = JSON.parse(raw) as Partial<SavedLayout>;
    return { columnWidths: parsed.columnWidths ?? {}, rowHeights: parsed.rowHeights ?? {} };
  } catch {
    return { columnWidths: {}, rowHeights: {} };
  }
}
function saveLayout(layout: SavedLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // ストレージ不可（プライベートモード等）でも致命ではない＝保存を諦めるだけ。
  }
}
const savedLayout = loadLayout();

let connLabel = '未接続';
let pendingNow = 0;
function renderBar(): void {
  if (statusEl !== null) {
    statusEl.textContent = `接続: ${connLabel}  ｜  未送信(pending): ${pendingNow}  ｜  名前: ${nameParam ?? '(anon)'}`;
  }
}
function renderStatus(event: GridEvent): void {
  gridEvents.push(event); // E2E 記録（DD-027-1）
  if (statusEl === null) {
    return;
  }
  switch (event.type) {
    case 'connection':
      connLabel =
        event.state === 'stopped'
          ? '🛑 stopped（編集停止・再接続試行中）'
          : event.state === 'online'
            ? '🟢 online'
            : '🟠 offline（再接続中…）';
      pendingNow = event.pendingCount;
      renderBar();
      break;
    case 'pending':
      // offline 中は connection が変化せず抑止されるため、pending イベントで backlog 件数を更新する（P2-4）。
      pendingNow = event.pendingCount;
      renderBar();
      break;
    case 'rejected':
      statusEl.textContent = `⚠ 競合 (${event.conflict.reason}${event.conflict.code !== undefined ? `/${event.conflict.code}` : ''})  ｜  未送信: ${event.pendingCount}`;
      break;
    case 'divergence':
      statusEl.textContent = `🛑 divergence（server=${event.serverRevision} / committed=${event.committedRevision}）`;
      break;
    case 'error':
      statusEl.textContent = `起動/接続エラー[${event.phase}]: ${event.message}`;
      break;
    case 'layout':
      // DD-012-4: 列幅・行高の確定 → 利用側で保存（次回 mount で復元）。
      saveLayout({ columnWidths: event.columnWidths, rowHeights: event.rowHeights });
      break;
    case 'link-open':
      // DD-027-2: リンク列クリックの通知（SDK は navigate しない＝利用側が受けて遷移を実装する）。E2E 観測点。
      statusEl.textContent = `🔗 link-open: row=${event.rowId} col=${event.columnId} value=${event.value}`;
      break;
  }
}

const instance = mount(
  { container: stage },
  {
    serverUrl,
    ...(nameParam !== null ? { displayName: nameParam } : {}),
    columnWidths: savedLayout.columnWidths,
    rowHeights: savedLayout.rowHeights,
    ...(wrapColumns !== undefined ? { wrapColumns } : {}),
    ...(columnTypes !== undefined ? { columnTypes } : {}),
    ...(columnFormats !== undefined ? { columnFormats } : {}),
    ...(columnCaptions !== undefined ? { columnCaptions } : {}),
    ...(columnDisplayFormats !== undefined ? { columnDisplayFormats } : {}),
    ...(readOnly ? { readOnly: true } : {}),
    onEvent: renderStatus,
  },
);

// E2E 用 introspection（旧 window.__integrationTestApi の後継。test-support 経由・mount 直後に登録済み）。
window.__gridInstance = instance;
window.__integrationTestApi = getDebugApi(instance);

// CG-1 実機 IME trace 採取（DD-016-2 Phase 4）。`?trace=1` のときだけ dynamic import で有効化する
// （通常利用・E2E には無影響。trace-capture は内部 @nanairo-sheet/* を import しない＝R1 維持）。
if (params.get('trace') === '1') {
  void import('./trace-capture').then((m) => {
    m.installTraceCapture(stage);
  });
}

// CG-6 精密メモリ＋frame 計測（DD-016-2 Phase 4）。`?perf=1` のときだけ dynamic import で有効化する
// （通常利用・E2E には無影響。perf-capture も内部 @nanairo-sheet/* を import しない＝R1 維持）。
if (params.get('perf') === '1') {
  const scroller = stage.querySelector('.nsheet-scroller');
  if (scroller instanceof HTMLDivElement) {
    void import('./perf-capture').then((m) => {
      m.installPerfCapture(scroller, stage);
    });
  }
}
