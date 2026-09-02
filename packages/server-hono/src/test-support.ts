// 実 WebSocket トランスポート（phase3-design §4 の ClientTransport 実装）。ClientSession に注入され、
// join/submit/presence/heartbeat/requestCatchup を JSON でサーバーへ送り、サーバーメッセージを ClientSession へ配る。
//
// 【依存境界】このファイルは Node ws（client）を使う実 WS トランスポートで、collaboration-server 側に残す。
// ClientSession コア（session/deps/inprocess-transport）は @nanairo-sheet/collab へ移設済みで、
// その依存ゼロ（Node/DOM 非参照）は同パッケージの tsconfig（types:[]）で回帰検証する（DD-005 Phase 1）。
// heartbeat はトランスポートの責務にしない（session/デモ/smoke が sendHeartbeat を実タイマーで駆動）＝送受信・接続イベント・
// 再接続のみを担う。時刻依存は再接続 setTimeout のみ（アダプター層ゆえ実タイマー可・後始末は close で解除）。
//
// DD-015（要確認①確定）: 予期しない切断後の自動再接続は **指数バックオフ（初回 baseMillis・倍々・上限 maxMillis）＋ジッタ**
// で行い、タブ生存中は無期限にリトライする（回数上限で諦めない＝§6「タブ生存中の一時切断」を保証）。バックオフ計算は純粋関数
// `nextReconnectDelay` に切り出して単体検証する。scheduler（setTimeout 相当）と random（ジッタ源）は注入可能（既定は実タイマー・
// Math.random）で、決定論的な単体テストを可能にする。編集停止（offline 上限超）は ClientSession 側の責務でトランスポートは
// 接続を試み続ける（リトライ継続＝§6・要確認①）。

import { WebSocket } from 'ws';
import type { RawData } from 'ws';

import type { ClientMessage } from '@nanairo-sheet/core';
import { decodeServerMessage, isRecord } from '@nanairo-sheet/core';
import type { ClientTransport, TransportListener } from '@nanairo-sheet/collab';
import { ClientSession, createCounterIdGenerator, nextReconnectDelay } from '@nanairo-sheet/collab';
import { COLUMNS } from '@nanairo-sheet/collab/test-support';
import { createDocumentId } from '@nanairo-sheet/types';
import type { ColumnId } from '@nanairo-sheet/types';

import type {
  ServeOpLogReadResult,
  ServeOpLogStore,
  ServeOperationEnvelope,
  ServePersistedSnapshot,
  ServeSnapshotStore,
} from './serve-types';
import { rawDataToString } from './ws-frame';

/** scheduler（setTimeout 相当・注入で決定論テスト可）。返り値はキャンセルに使うハンドル。 */
export type ReconnectScheduler = (callback: () => void, delayMillis: number) => ReturnType<typeof setTimeout>;

export interface WsClientTransportOptions {
  /** 予期しない切断後の自動再接続を有効にする（既定 true）。close() で無効化。 */
  autoReconnect?: boolean;
  /** upgrade 要求に付ける HTTP ヘッダ（Cookie 等・DD-026-2 認証フックのテスト用）。 */
  headers?: Record<string, string>;
  /** 指数バックオフの初回待機（ミリ秒・既定 1000）。attempt=0 の基準値。 */
  reconnectDelayMillis?: number;
  /** 指数バックオフの上限待機（ミリ秒・既定 30000＝要確認①「上限 30s」）。 */
  maxReconnectDelayMillis?: number;
  /** ジッタ源（0..1・既定 Math.random）。注入で決定論テスト可。 */
  random?: () => number;
  /** タイマー scheduler（既定 setTimeout）。注入で決定論テスト可。 */
  scheduler?: ReconnectScheduler;
}

const DEFAULT_RECONNECT_DELAY = 1_000; // 初回 1s（要確認①）
const DEFAULT_MAX_RECONNECT_DELAY = 30_000; // 上限 30s（要確認①）

export class WsClientTransport implements ClientTransport {
  private readonly url: string;
  private readonly autoReconnect: boolean;
  private readonly baseReconnectDelayMillis: number;
  private readonly maxReconnectDelayMillis: number;
  private readonly random: () => number;
  private readonly scheduler: ReconnectScheduler;
  private readonly headers: Record<string, string> | undefined;

  private listener: TransportListener | undefined;
  private ws: WebSocket | undefined;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0; // 連続再接続失敗回数（open 成功で 0 リセット＝指数バックオフの指数）
  private readonly outbox: ClientMessage[] = []; // CONNECTING 中に送られたメッセージのバッファ（open で flush）

  constructor(url: string, options: WsClientTransportOptions = {}) {
    this.url = url;
    this.autoReconnect = options.autoReconnect ?? true;
    this.baseReconnectDelayMillis = options.reconnectDelayMillis ?? DEFAULT_RECONNECT_DELAY;
    this.maxReconnectDelayMillis = options.maxReconnectDelayMillis ?? DEFAULT_MAX_RECONNECT_DELAY;
    this.random = options.random ?? Math.random;
    this.scheduler = options.scheduler ?? ((cb, ms) => setTimeout(cb, ms));
    this.headers = options.headers;
  }

  setListener(listener: TransportListener): void {
    this.listener = listener;
  }

  /** 接続を確立する（open で handleConnected → session が join 送信）。 */
  connect(): void {
    this.closedByUser = false;
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  /** ClientMessage を送信する（OPEN は即送信・CONNECTING はバッファ・その他は drop＝session の再送に委ねる）。 */
  send(message: ClientMessage): void {
    const ws = this.ws;
    if (ws !== undefined && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      return;
    }
    if (ws !== undefined && ws.readyState === WebSocket.CONNECTING) {
      this.outbox.push(message);
    }
    // CLOSING/CLOSED は drop（未 ACK pending は ClientSession が再接続後に再送＝§8.5・phase3-design §6）。
  }

  /** 明示 close（再接続を止め、ソケットとタイマーを解放する＝テスト後始末・graceful shutdown）。 */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.outbox.length = 0;
    this.detachAndClose(this.ws);
    this.ws = undefined;
  }

  /** 現在の連続再接続試行回数（0=接続確立済み or 初回。運用監視・テスト用）。 */
  get reconnectAttemptCount(): number {
    return this.reconnectAttempt;
  }

  /**
   * 【テスト専用フォールト注入】現在のソケットを異常切断し（タブ生存・session の pending 保持）、自動再接続を**抑止**する。
   * resumeAfterDrop() で再接続を明示駆動するまで offline のまま＝offline 編集ウィンドウを決定論的に作れる（実ネットワーク断のシミュレート）。
   * 本番挙動は変えない（本番は openSocket→handleSocketDown の指数バックオフ経路のみを使う）。
   */
  dropForTest(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.detachAndClose(this.ws); // close イベントで handleSocketDown が発火しない＝自動再接続を抑止
    this.ws = undefined;
    this.requireListener().handleDisconnected(); // session を offline へ（pending は保持）
  }

  /**
   * ソケットのリスナーを外して閉じる（後始末専用）。CONNECTING 中に close するとws が非同期に 'error'
   * （"WebSocket was closed before the connection was established"）を出し、listener 無しでは Node の EventEmitter が
   * uncaught 例外に昇格させる。removeAllListeners 後に no-op error handler を再付与して吸収する（P08 の意図的無視）。
   */
  private detachAndClose(ws: WebSocket | undefined): void {
    if (ws === undefined) {
      return;
    }
    ws.removeAllListeners();
    ws.on('error', () => {}); // 後始末中の CONNECTING abort エラーを吸収（uncaught 化を防ぐ）
    ws.close();
  }

  /** 【テスト専用】dropForTest 後に再接続を明示駆動する（同一 clientId で再 join＝reconnect 経路）。 */
  resumeAfterDrop(): void {
    this.closedByUser = false;
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  private openSocket(): void {
    const ws = this.headers !== undefined ? new WebSocket(this.url, { headers: this.headers }) : new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      this.reconnectAttempt = 0; // 接続確立 → バックオフをリセット（次の切断は初回待機から）
      this.flushOutbox();
      this.requireListener().handleConnected();
    });
    ws.on('message', (data: RawData) => {
      this.receive(data);
    });
    ws.on('close', () => {
      this.handleSocketDown();
    });
    ws.on('error', (error: Error) => {
      // 予期しないエラーは記録する（P08: 握りつぶさない）。close() 後の teardown 由来は抑止（AbortError 相当の意図的無視）。
      if (!this.closedByUser) {
        console.error(`WsClientTransport: socket error (${this.url}): ${error.message}`);
      }
      // 'close' が続いて発火し handleSocketDown で切断通知＋再接続する（error 単独では二重処理しない）。
    });
  }

  private receive(data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data));
    } catch {
      console.error(`WsClientTransport: dropped non-JSON frame from ${this.url}`);
      return;
    }
    const message = decodeServerMessage(parsed);
    if (message === undefined) {
      console.error(`WsClientTransport: dropped unrecognized server message from ${this.url}`);
      return;
    }
    this.requireListener().handleServerMessage(message);
  }

  private handleSocketDown(): void {
    this.ws = undefined;
    this.requireListener().handleDisconnected();
    if (!this.closedByUser && this.autoReconnect) {
      // 指数バックオフ＋ジッタで再接続を予約する（タブ生存中は無期限リトライ＝回数上限なし・要確認①）。
      const delay = nextReconnectDelay(
        this.reconnectAttempt,
        { baseMillis: this.baseReconnectDelayMillis, maxMillis: this.maxReconnectDelayMillis },
        this.random,
      );
      this.reconnectAttempt += 1;
      this.reconnectTimer = this.scheduler(() => {
        this.reconnectTimer = undefined;
        if (!this.closedByUser) {
          this.openSocket(); // 再 open → handleConnected → 同一 clientId で再 join（§8.5・phase3-design §7）
        }
      }, delay);
    }
  }

  private flushOutbox(): void {
    const ws = this.ws;
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    for (const message of this.outbox) {
      ws.send(JSON.stringify(message));
    }
    this.outbox.length = 0;
  }

  private requireListener(): TransportListener {
    if (this.listener === undefined) {
      throw new Error('WsClientTransport: listener not set (call setListener before connect)');
    }
    return this.listener;
  }
}

// ---- DD-026 テスト補助: 公開インターフェース（ServeOpLogStore / ServeSnapshotStore）のメモリ実装・クライアント生成・待機 ----

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 全階層のオブジェクトキーを逆順に並べ替える（Postgres jsonb 等「キー順を保持しない保存先」の模倣）。 */
export function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => reverseKeys(item));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort().reverse()) {
      out[key] = reverseKeys(value[key]);
    }
    return out;
  }
  return value;
}

/** 公開 ServeOpLogStore のメモリ実装。append の保留（durable ACK 観測）・失敗注入（poisoning 観測）ができる。 */
export class MemoryServeOpLog implements ServeOpLogStore {
  readonly entries: ServeOperationEnvelope[] = [];
  /** true の間 append を保留する。release() で解決（「append 解決＝durable」の後に ACK が出ることを観測する）。 */
  gate = false;
  /** 次の append を reject する（durable 失敗→write 停止の観測用）。 */
  failNext = false;
  appendCalls = 0;
  private waiting: Array<() => void> = [];

  async append(entries: readonly ServeOperationEnvelope[]): Promise<void> {
    this.appendCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('append failed (test injection)');
    }
    if (this.gate) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    this.entries.push(...entries.map(cloneJson));
  }

  release(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const resolve of waiting) {
      resolve();
    }
  }

  readAll(): Promise<ServeOpLogReadResult> {
    return Promise.resolve({ entries: this.entries.map(cloneJson) });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** 公開 ServeSnapshotStore のメモリ実装（JSON 文字列で保持）。shuffleKeys=true で jsonb のようにキー順を崩して返す。 */
export class MemoryServeSnapshots implements ServeSnapshotStore {
  private latest: string | undefined;
  saveCount = 0;

  constructor(private readonly shuffleKeys = false) {}

  save(snapshot: ServePersistedSnapshot): Promise<void> {
    this.latest = JSON.stringify(snapshot);
    this.saveCount += 1;
    return Promise.resolve();
  }

  loadLatest(): Promise<ServePersistedSnapshot | undefined> {
    if (this.latest === undefined) {
      return Promise.resolve(undefined);
    }
    const parsed: unknown = JSON.parse(this.latest);
    return Promise.resolve((this.shuffleKeys ? reverseKeys(parsed) : parsed) as ServePersistedSnapshot);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface SessionClient {
  session: ClientSession;
  transport: WsClientTransport;
}

export interface SessionClientOptions {
  clientId: string;
  userId?: string;
  displayName?: string;
  /** upgrade 要求の HTTP ヘッダ（Cookie 等・認証フックのテスト用）。 */
  headers?: Record<string, string>;
  documentId?: string;
  columnOrder?: ColumnId[];
  autoReconnect?: boolean;
}

/** 実 WS transport ＋ ClientSession を作って start する（DD-026 のテスト共通）。後始末は呼び出し側が transport.close()。 */
export function createSessionClient(wsUrl: string, options: SessionClientOptions): SessionClient {
  const transport = new WsClientTransport(wsUrl, {
    autoReconnect: options.autoReconnect ?? false,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  });
  const session = new ClientSession({
    clientId: options.clientId,
    userId: options.userId ?? `user-${options.clientId}`,
    displayName: options.displayName ?? options.clientId,
    documentId: createDocumentId(options.documentId ?? 'demo-doc'),
    columnOrder: options.columnOrder ?? COLUMNS,
    transport,
    clock: { now: () => Date.now() },
    idGenerator: createCounterIdGenerator(`${options.clientId}-op`),
  });
  session.start();
  return { session, transport };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout: ${label}`);
    }
    await delay(10);
  }
}
