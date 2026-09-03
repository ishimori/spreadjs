// 動作デモページ（DD-017-2）。@nanairo-sheet/grid Facade（公開API）だけでグリッドを組み込む＝
// このファイル自体が「consumer は Facade のみで統合できる」ことの実演でもある（R1・S1-3 と同じ経路）。
import { mount } from '@nanairo-sheet/grid';
import type {
  GridColumnDisplayFormat,
  GridColumnFormatRule,
  GridColumnType,
  GridEvent,
} from '@nanairo-sheet/grid';

import { SCENARIOS, findScenario } from './scenarios';

const params = new URLSearchParams(location.search);
// 既定は dev-start.sh --showcase が起動する server-hono（:9499）。E2E 等はクエリで差し替える。
const serverUrl = params.get('server') ?? 'http://127.0.0.1:9499';
const scenario = findScenario(params.get('scenario'));
const displayName = params.get('name') ?? `見学者-${Math.floor(Math.random() * 1000)}`;

// DD-012-4: 列幅・行高は view-local。利用側（デモ）が localStorage へ保存し次回 mount へ渡す＝F5 で復元される。
const LAYOUT_KEY = 'nsheet:showcase:layout';
function loadLayout(): { columnWidths: Record<string, number>; rowHeights: Record<string, number> } {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw === null) return { columnWidths: {}, rowHeights: {} };
    const p = JSON.parse(raw) as { columnWidths?: Record<string, number>; rowHeights?: Record<string, number> };
    return { columnWidths: p.columnWidths ?? {}, rowHeights: p.rowHeights ?? {} };
  } catch {
    return { columnWidths: {}, rowHeights: {} };
  }
}
const savedLayout = loadLayout();

// DD-012-5: 「Excel風テキスト表示」シナリオだけ C 列（col-2）を折り返し（wrap）列にする。
// 他シナリオは wrap 無し＝左寄せ文字列が右隣の空セルへはみ出すオーバーフロー挙動を見せる。
const wrapColumns = scenario.id === 'text-display' ? ['col-2'] : undefined;

// DD-027: 「列タイプ」シナリオだけ D 列（col-3）を選択式＋バッジ/背景書式、E 列（col-4）をリンク列にする。
// いずれも mount 時固定の宣言的オプション（consumer は Facade のみで設定）。値は string のまま（core 不変）。
const isColumnTypesScenario = scenario.id === 'column-types';
const columnTypes: Record<string, GridColumnType> | undefined = isColumnTypesScenario
  ? {
      // allowFreeText:true=既存シード値（候補外）も編集でき、非候補値も保持・表示される（決定②）。
      'col-3': { type: 'select', options: ['進行中', '受注', '失注'], allowFreeText: true },
      'col-4': { type: 'link' },
    }
  : undefined;
// DD-033: 「明細閲覧ビュー」シナリオだけ 表示専用（readOnly）＋業務名の列見出し（columnCaptions）＋
// 数値/日付の表示書式（columnDisplayFormats）＋値の装飾（columnFormats）を併用する BI 明細閲覧構成。
// いずれも mount 時固定の宣言的オプション（consumer は Facade のみ）・view-local（文書の raw 値は不変）。
const isDetailViewScenario = scenario.id === 'detail-view';
const readOnly = isDetailViewScenario ? true : undefined;
const columnCaptions: Record<string, string> | undefined = isDetailViewScenario
  ? {
      'col-0': '取引先コード',
      'col-1': '担当者',
      'col-2': 'ステータス',
      'col-3': '契約金額',
      'col-4': '登録日',
    }
  : undefined;
const columnDisplayFormats: Record<string, GridColumnDisplayFormat> | undefined = isDetailViewScenario
  ? {
      // 数値形の raw だけを 3 桁区切り＋通貨記号で整形（非数値 raw は素通し・raw 契約不変）。
      'col-3': { type: 'number', grouping: true, prefix: '¥' },
      // ISO 日付形の raw だけを YYYY/MM/DD で整形（非受理 raw は素通し）。
      'col-4': { type: 'date', pattern: 'YYYY/MM/DD' },
    }
  : undefined;
const columnFormats: Record<string, readonly GridColumnFormatRule[]> | undefined = isColumnTypesScenario
  ? {
      'col-3': [
        { match: '進行中', style: { badge: true, badgeColor: '#34a853', textColor: '#ffffff' } },
        { match: '受注', style: { cellBackground: '#fde293' } },
      ],
    }
  : isDetailViewScenario
    ? {
        // ステータス列（col-2）を値で色分け・バッジ表示（シード JP_WORDS に一致する値へ適用・match は raw 完全一致）。
        'col-2': [
          { match: '完了', style: { badge: true, badgeColor: '#34a853', textColor: '#ffffff' } },
          { match: '承認済み', style: { badge: true, badgeColor: '#1a73e8', textColor: '#ffffff' } },
          { match: '対応中', style: { cellBackground: '#d2e3fc' } },
          { match: '保留中', style: { cellBackground: '#fde293' } },
          { match: '要確認', style: { cellBackground: '#fad2cf' } },
        ],
      }
    : undefined;

// --- シナリオパネル ---------------------------------------------------------

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`demo: #${id} が demo.html にありません`);
  return el;
}

document.title = `Nanairo Sheet（仮称）SDK — デモ: ${scenario.title}`;
byId('demo-title').textContent = `動作デモ — ${scenario.title}`;
byId('scenario-title').textContent = scenario.title;
byId('scenario-goal').textContent = scenario.goal;

const stepsEl = byId('scenario-steps');
for (const step of scenario.steps) {
  const li = document.createElement('li');
  // <code>コマンド</code> 区切りだけを解釈して DOM を組み立てる（innerHTML は使わない）。
  for (const [index, segment] of step.split(/<\/?code>/).entries()) {
    if (segment === '') continue;
    if (index % 2 === 1) {
      const code = document.createElement('code');
      code.textContent = segment;
      li.appendChild(code);
    } else {
      li.appendChild(document.createTextNode(segment));
    }
  }
  stepsEl.appendChild(li);
}

if (scenario.action === 'open-second-window') {
  const button = document.createElement('button');
  button.textContent = '別ウィンドウで開く';
  button.addEventListener('click', () => {
    const url = new URL(location.href);
    url.searchParams.set('name', `ゲスト-${Math.floor(Math.random() * 1000)}`);
    window.open(url.toString(), '_blank', 'width=1000,height=700');
  });
  byId('scenario-actions').appendChild(button);
}

const othersEl = byId('scenario-others');
const othersLabel = document.createElement('b');
othersLabel.textContent = '他のシナリオ';
othersEl.appendChild(othersLabel);
for (const s of SCENARIOS) {
  const a = document.createElement('a');
  const url = new URL(location.href);
  url.searchParams.set('scenario', s.id);
  a.href = url.toString();
  a.textContent = s.title;
  if (s.id === scenario.id) a.className = 'current';
  othersEl.appendChild(a);
}

// --- 接続ステータス・イベントログ -------------------------------------------

const connEl = byId('conn');
const pendingEl = byId('pending');
const logEl = byId('event-log');

const CONN_LABEL: Record<string, string> = {
  online: 'オンライン',
  offline: 'オフライン（編集はローカル保持）',
  stopped: '停止',
};

function log(message: string): void {
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()} ${message}`;
  logEl.prepend(line);
  while (logEl.childElementCount > 50) logEl.lastElementChild?.remove();
}

function onEvent(event: GridEvent): void {
  switch (event.type) {
    case 'connection':
      connEl.textContent = CONN_LABEL[event.state] ?? event.state;
      connEl.className = `pill ${event.state}`;
      pendingEl.textContent = `未送信 ${event.pendingCount}`;
      log(`接続状態: ${event.state}`);
      break;
    case 'pending':
      pendingEl.textContent = `未送信 ${event.pendingCount}`;
      break;
    case 'rejected':
      pendingEl.textContent = `未送信 ${event.pendingCount}`;
      log(`競合を検出（黙って上書きしません）: ${event.conflict.code}`);
      break;
    case 'divergence':
      log(`divergence: server=${event.serverRevision} committed=${event.committedRevision}`);
      break;
    case 'error':
      log(`エラー [${event.phase}/${event.code}] ${event.message}`);
      break;
    case 'layout':
      try {
        localStorage.setItem(
          LAYOUT_KEY,
          JSON.stringify({ columnWidths: event.columnWidths, rowHeights: event.rowHeights }),
        );
      } catch {
        // 保存不可でも致命ではない。
      }
      log(`レイアウト変更を保存（列 ${Object.keys(event.columnWidths).length} / 行 ${Object.keys(event.rowHeights).length}）`);
      break;
    case 'link-open':
      // DD-027-2: SDK は画面遷移しない（通知のみ）。遷移は利用側アプリの責務＝ここではログに出すだけ。
      log(`link-open: row=${event.rowId} col=${event.columnId} value=${event.value}`);
      break;
  }
}

// --- グリッド組み込み（Facade のみ） -----------------------------------------

const instance = mount(
  { container: byId('stage') },
  {
    serverUrl,
    displayName,
    columnWidths: savedLayout.columnWidths,
    rowHeights: savedLayout.rowHeights,
    ...(wrapColumns !== undefined ? { wrapColumns } : {}),
    ...(columnTypes !== undefined ? { columnTypes } : {}),
    ...(columnFormats !== undefined ? { columnFormats } : {}),
    ...(columnCaptions !== undefined ? { columnCaptions } : {}),
    ...(columnDisplayFormats !== undefined ? { columnDisplayFormats } : {}),
    ...(readOnly !== undefined ? { readOnly } : {}),
    onEvent,
  },
);
byId('stage').addEventListener('click', () => instance.focus());
log(`mount 完了（server: ${serverUrl} / 表示名: ${displayName}）`);
