// consumer-app — @nanairo-sheet/grid Facade の独立 consumer（DD-016-2 Phase 3・S1-3 実証）。
//
// 【S1-3】この consumer は**公開 Facade だけ**を import する:
//   - 内部 package（core/types/collab/render/selection/ime/server）は import しない（R1）。
//   - @nanairo-sheet/grid/test-support（E2E introspection・非公開契約）も import しない。
//   - serverUrl は必須（開発サーバーの暗黙設定に依存しない＝型が強制する）。
// pack 済み tarball 経由で解決される（scripts/consumer-app.sh が pack closure を install する）。
//
// 実挙動: size 済み container（#app）へ mount → GridEvent（接続状態・エラー通知）を購読して #status に表示。
// destroy()/再mount は consumer が任意に呼べる（route 遷移・再表示の想定）。lifecycle 契約（再mount で leak なし）は
// e2e/lifecycle.spec.ts が外部観測で検証する（consumer 側に leak 計測コードは持たない＝Facade の契約を信頼する）。

import { mount, GRID_API_VERSION } from '@nanairo-sheet/grid';
import type { GridEvent, GridInstance, GridMountOptions } from '@nanairo-sheet/grid';

const container = document.getElementById('app');
const statusEl = document.getElementById('status');
if (!(container instanceof HTMLElement) || !(statusEl instanceof HTMLElement)) {
  throw new Error('#app / #status が見つかりません');
}

const params = new URLSearchParams(location.search);
const serverUrl = params.get('server') ?? 'http://127.0.0.1:8790';
const nameParam = params.get('name');

const events: GridEvent[] = [];
let connLabel = '未接続';
let pendingNow = 0;

function renderBar(): void {
  statusEl!.textContent = `SDK ${GRID_API_VERSION} ｜ 接続: ${connLabel} ｜ pending: ${pendingNow} ｜ 名前: ${nameParam ?? '(anon)'}`;
}

function onEvent(event: GridEvent): void {
  events.push(event);
  switch (event.type) {
    case 'connection':
      connLabel =
        event.state === 'stopped' ? 'stopped' : event.state === 'online' ? 'online' : 'offline';
      pendingNow = event.pendingCount;
      break;
    case 'pending':
      pendingNow = event.pendingCount;
      break;
    case 'rejected':
      connLabel = `rejected(${event.conflict.reason})`;
      pendingNow = event.pendingCount;
      break;
    case 'divergence':
      connLabel = `divergence(server=${event.serverRevision})`;
      break;
    case 'error':
      connLabel = `error[${event.phase}]: ${event.message}`;
      break;
  }
  renderBar();
}

function buildOptions(): GridMountOptions {
  return {
    serverUrl,
    onEvent,
    ...(nameParam !== null ? { displayName: nameParam } : {}),
  };
}

/** consumer が公開 API だけで grid を制御するハンドル（route 遷移で mount/unmount する想定）。 */
interface ConsumerHandle {
  instance: GridInstance | null;
  readonly events: GridEvent[];
  connectionState(): string;
  mount(): void;
  destroy(): void;
}

const handle: ConsumerHandle = {
  instance: null,
  events,
  connectionState(): string {
    return this.instance?.connectionState() ?? 'none';
  },
  mount(): void {
    if (this.instance !== null) {
      return;
    }
    this.instance = mount({ container: container as HTMLElement }, buildOptions());
    this.instance.focus();
  },
  destroy(): void {
    this.instance?.destroy();
    this.instance = null;
    connLabel = '未接続';
    pendingNow = 0;
    renderBar();
  },
};

declare global {
  interface Window {
    /** e2e が mount/destroy/再mount を駆動し、公開イベント・接続状態を観測するためのハンドル（consumer 公開 API のみ）。 */
    __consumer?: ConsumerHandle;
  }
}

window.__consumer = handle;
renderBar();
if (params.has('borders')) {
  void import('./borders').then(({ mountBorderExample }) => mountBorderExample(container, params)).catch((error: unknown) => {
    statusEl.textContent = `error: ${String(error)}`;
  });
} else handle.mount();
