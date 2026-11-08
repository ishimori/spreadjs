// 起動と 2 つのモード（共同編集の boot・単独モードの boot・boot 前の呼び出しの保留・再注入・tick）。DD-065 区画⑥。
// backend（共同編集 SessionSync / 単独 StandaloneSession）の持ち主はこの部品だけで、ほかの部品は backend() で読む。
// backend を作ったら deps.attachBackend() で描画層・編集・候補欄・日付・editor へ結線する（結線の順番は組み立てが 1 か所に持つ）。

import { displayRowOrder } from '@nanairo-sheet/core';
import type { ClientSession, Clock, IdGenerator, SessionEvent } from '@nanairo-sheet/collab';
import { CELL_TEXT_LINE_HEIGHT } from '@nanairo-sheet/render';
import type { TextMetricsCache } from '@nanairo-sheet/render';
import { createColumnId, createDocumentId } from '@nanairo-sheet/types';
import type { ColumnId } from '@nanairo-sheet/types';

import { BrowserWebSocketTransport } from '../browser-transport';
import { cellStatusInvalidMessage } from '../cell-status';
import type { CellStatusStore } from '../cell-status';
import type { DiagnosticSink } from '../diagnostics';
import { GridBootError, toCompensationConflictCode } from '../error-codes';
import type { GridBackend } from '../grid-backend';
import type {
  GridCellStatusRow,
  GridConnectionState,
  GridMountOptions,
  GridStandaloneData,
  GridStandaloneMountOptions,
  GridStandaloneRow,
} from '../index';
import type { LoadMetrics } from '../initial-load-metrics';
import type { IntegrationEditor } from '../integration-editor';
import { toGridRemoteChange } from '../remote-change';
import { createSessionSync } from '../session-sync';
import { validateStandaloneOptions } from '../standalone-options';
import { createStandaloneSession } from '../standalone-session';
import type { StandaloneSession } from '../standalone-session';
import type { UndoController } from '../undo-stack';
import { COL_WIDTH, ROW_HEIGHT, TICK_INTERVAL_MS, errorMessage } from './constants';
import type { MountConfig } from './config';
import type { EditSubmit } from './edit-submit';
import { toGridEvent } from './events';
import type { GridEvents } from './events';

interface ResolvedConfig {
  documentId: string;
  columnOrder: string[];
}

export interface LifecycleDeps {
  readonly options: GridMountOptions;
  readonly isStandalone: boolean;
  readonly serverOrigin: string;
  /** DD-043: 文書を名乗る接続の query（`?documentId=…`。未指定は空文字）。 */
  readonly documentQuery: string;
  readonly wsUrl: string;
  readonly clientId: string;
  readonly displayName: string;
  readonly wrapEnabled: boolean;
  readonly wrapColumns: NonNullable<GridMountOptions['wrapColumns']>;
  readonly stringColumns: NonNullable<GridMountOptions['stringColumns']>;
  readonly stringColumnStrings: ReadonlySet<string>;
  readonly cellTextCache: TextMetricsCache;
  /** destroy() で abort される（boot 進行中の /config を残さない・P2-2）。 */
  readonly signal: AbortSignal;
  readonly diag: DiagnosticSink;
  readonly metrics: LoadMetrics;
  readonly undoCtrl: UndoController;
  readonly cellStatusStore: CellStatusStore;
  readonly events: Pick<GridEvents, 'emit' | 'hasListeners' | 'queueRemoteChange' | 'flushRemoteChanges' | 'refreshPresence'>;
  readonly config: Pick<MountConfig, 'build' | 'appearance'>;
  readonly editSubmit: Pick<EditSubmit, 'recordPendingStandaloneUndo' | 'recordProgrammaticUndo'>;
  isDestroyed(): boolean;
  editor(): IntegrationEditor | undefined;
  /** DD-056 H12: pending・接続の変化で flush の待ち合わせを判定し直す（待つものが無ければ無コスト）。 */
  scheduleEditStateCheck(): void;
  /** DD-060: ホバー中のセルの状態表示が変わっていれば cell-hover を出し直す。 */
  refreshHoverStatus(): void;
  /** 作った backend を描画層・編集・候補欄・日付・editor へ結線して開始する。 */
  attachBackend(): void;
}

export interface MountLifecycle {
  backend(): GridBackend | undefined;
  /** 単独モードの再注入（setData）用の具体参照。共同編集モードでは undefined のまま。 */
  standalone(): StandaloneSession | undefined;
  /** DD-049 H4/H5: 共同編集モードの ClientSession（参加者一覧の join 判定・他者 presence の読取に使う）。 */
  collabSession(): ClientSession | undefined;
  transport(): BrowserWebSocketTransport | undefined;
  documentId(): string;
  connectionState(): GridConnectionState;
  lastSessionEventType(): string;
  setData(data: GridStandaloneData): void;
  setRows(rows: readonly GridStandaloneRow[]): void;
  setCellStatus(rows: readonly GridCellStatusRow[]): void;
  /** 起動する（単独モードは microtask で backend を作る。共同編集モードは tick interval を始めて boot する）。 */
  start(): void;
  /** destroy: tick interval を止める。 */
  stopTimers(): void;
  /** destroy: WS を閉じ再接続タイマーを解放する。 */
  closeTransport(): void;
}

export function createLifecycle(deps: LifecycleDeps): MountLifecycle {
  const { options, isStandalone, diag, metrics, undoCtrl, cellStatusStore, events, config, editSubmit } = deps;
  const emit = events.emit;
  // backend は共同編集（SessionSync）と単独（StandaloneSession）の共通面（GridBackend・DD-024）。
  let sync: GridBackend | undefined;
  let standalone: StandaloneSession | undefined;
  let collabSession: ClientSession | undefined;
  let browserTransport: BrowserWebSocketTransport | undefined;
  let lastSessionEvent: SessionEvent | undefined;
  let resolvedDocumentId = options.documentId;
  let hasEverConnected = false; // 一度でも接続確立したか（初回接続失敗のみ connect error として通知・P1-2）
  let intervalId = 0;
  // boot（microtask）完了前に setData/setRows が呼ばれたときの保留分（Codex[P1]: mount 直後の同期呼び出しを
  // 捨てない）。DD-052-4（Codex P2）: setData 用・setRows 用に別々のキューへ分けると、2 つの API を跨いだ
  // 呼び出し順（例: setRows→setData の順で呼んだのに boot 側で setData を先に適用してしまう）が壊れるため、
  // 呼ばれた順そのままを 1 本の queue に積む（setData は都度フル置換なので複数回積んでも最終状態は変わらない）。
  // DD-062: setCellStatus も同じ queue に積む（boot 前の setData→setCellStatus の順を、保留した setData の
  // 作り直しで setCellStatus の状態が消える形へ逆転させない）。
  const pendingStandaloneCalls: Array<
    | { readonly kind: 'data'; readonly data: GridStandaloneData }
    | { readonly kind: 'rows'; readonly rows: readonly GridStandaloneRow[] }
    | { readonly kind: 'status'; readonly rows: readonly GridCellStatusRow[] }
  > = [];

  async function fetchConfig(): Promise<ResolvedConfig> {
    // destroy() で abort される（boot 進行中の /config を残さない・P2-2）。
    const response = await fetch(`${deps.serverOrigin}/config${deps.documentQuery}`, { signal: deps.signal });
    if (!response.ok) {
      throw new GridBootError('config-unavailable', `/config 取得失敗: ${response.status}`);
    }
    // HTTP 200 でも本文が不正 JSON なら「到達性」でなく「応答形式」の問題＝config-invalid（P2-3）。
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new GridBootError('config-invalid', `/config の JSON 解析失敗: ${errorMessage(error)}`);
    }
    if (
      typeof json !== 'object' ||
      json === null ||
      !('documentId' in json) ||
      !('columnOrder' in json) ||
      !Array.isArray((json as { columnOrder: unknown }).columnOrder)
    ) {
      throw new GridBootError('config-invalid', '/config の形式が不正');
    }
    const record = json as { documentId: string; columnOrder: string[] };
    return { documentId: record.documentId, columnOrder: record.columnOrder };
  }

  // D1: columnOrder は既定で /config から取得（明示指定で上書き可）。documentId も同様。
  async function resolveConfig(): Promise<ResolvedConfig> {
    if (options.columnOrder !== undefined && options.documentId !== undefined) {
      return { documentId: options.documentId, columnOrder: [...options.columnOrder] };
    }
    const fetched = await fetchConfig();
    return {
      documentId: options.documentId ?? fetched.documentId,
      columnOrder: options.columnOrder !== undefined ? [...options.columnOrder] : fetched.columnOrder,
    };
  }

  async function boot(): Promise<void> {
    diag.emit('info', 'boot-start', `boot 開始（server=${deps.serverOrigin}）`);
    let resolved: ResolvedConfig;
    try {
      resolved = await resolveConfig();
    } catch (error) {
      // destroy() 由来の AbortError は正常な後始末ゆえエラー通知しない（P2-2）。
      if (!deps.isDestroyed()) {
        // GridBootError は phase/code を保持する。それ以外（想定外）は config-unavailable 相当で通知。
        const code = error instanceof GridBootError ? error.code : 'config-unavailable';
        diag.emit('error', 'config-error', `${code}: ${errorMessage(error)}`);
        emit({ type: 'error', phase: 'config', code, message: errorMessage(error) });
      }
      return;
    }
    diag.emit('info', 'config-resolved', `documentId=${resolved.documentId} columns=${resolved.columnOrder.length}`);
    if (deps.isDestroyed()) {
      return; // boot 中に destroy された（wiring しない）
    }
    resolvedDocumentId = resolved.documentId;
    const columnOrder: ColumnId[] = resolved.columnOrder.map((c) => createColumnId(c));

    // DD-027-1: 列タイプメタの registry を columnOrder 解決後に生成する（未知列検証のため）。不正設定は
    // fail-fast＝公開 error（phase=config・code=column-types-invalid）を出して配線しない（AC8）。
    if (!config.build(resolved.columnOrder)) {
      return;
    }

    const clock: Clock = { now: () => Date.now() };
    const idGenerator: IdGenerator = { next: () => crypto.randomUUID() };
    const transport = new BrowserWebSocketTransport(deps.wsUrl, {
      onServerFrame: (info) => {
        metrics.recordFrame(info);
      },
      // 初回接続確立前の WS エラーは connect error として通知する（approved lifecycle mapping・P1-2）。
      // 接続確立後の一時エラーは reconnect の一部＝connection offline イベントで表現するため connect error にしない。
      logger: (message) => {
        diag.emit('warn', 'transport', message);
        if (!hasEverConnected && !deps.isDestroyed()) {
          emit({ type: 'error', phase: 'connect', code: 'connect-failed', message });
        }
      },
    });
    browserTransport = transport;

    const appearance = config.appearance();
    const collabSync = createSessionSync({
      innerTransport: transport,
      sessionConfig: {
        clientId: deps.clientId,
        userId: deps.clientId,
        displayName: deps.displayName,
        documentId: createDocumentId(resolved.documentId),
        columnOrder,
        clock,
        idGenerator,
        // イベント通知契約を GridEvent へ写像して購読者へ配信する（接続断/pending/reject/divergence を即時通知）。
        observer: (event) => {
          lastSessionEvent = event;
          if (event.type === 'connection' && event.state === 'online') {
            hasEverConnected = true; // 以降の transport エラーは connect error にしない（reconnect＝offline で表現）
          }
          if (event.type === 'rejected') {
            // DD-020-3: 補償 op（undo/redo）の reject は undo-blocked/redo-blocked へ写像して通知する
            // （エントリは onRejected 内で除去＝既定案 a）。元 op（未 ACK）の reject は onRejected が除去し undefined を返す
            // → 従来どおり cell-conflict 等へ写像して emit する（consumer は競合を従来語彙で受ける）。
            const block = undoCtrl.onRejected(event.entry.operationId);
            if (block !== undefined) {
              // DD-056 H11（Codex 設計レビュー P2-3）: 補償 op の認可拒否は undo-blocked/redo-blocked より permission-denied を優先する
              // （エントリの除去＝Undo 状態の後始末は onRejected で済んでいる）。
              const code = toCompensationConflictCode(block, event.entry.code);
              diag.emit('warn', 'rejected', `code=${code} op=${String(event.entry.operationId)}`);
              emit({
                type: 'rejected',
                pendingCount: event.pendingCount,
                conflict: { operationId: String(event.entry.operationId), reason: 'rejected', code },
              });
              deps.scheduleEditStateCheck(); // DD-056 H12: 補償の拒否でも pending が変わる
              return;
            }
          }
          const gridEvent = toGridEvent(event);
          if (gridEvent.type === 'connection') {
            diag.emit('info', 'connection', `state=${gridEvent.state} pending=${gridEvent.pendingCount}`);
          } else if (gridEvent.type === 'rejected') {
            diag.emit('warn', 'rejected', `code=${gridEvent.conflict.code} op=${gridEvent.conflict.operationId}`);
          } else if (gridEvent.type === 'divergence') {
            diag.emit('warn', 'divergence', `server=${gridEvent.serverRevision} committed=${gridEvent.committedRevision}`);
          }
          emit(gridEvent);
          deps.scheduleEditStateCheck(); // DD-056 H12: pending・接続の変化で flush の待ち合わせを判定し直す（待つものが無ければ無コスト）
        },
        // DD-049 H4: committed へ入った受理済み op を公開形へ写してキューに積む（配るのは settle＝描画の dirty 立ての後）。
        // 購読者が居なければ写像しない（未使用の consumer に表示文字列変換のコストを足さない）。
        onCommittedOperation: (event) => {
          if (!events.hasListeners()) {
            return;
          }
          const change = toGridRemoteChange(event.envelope, event.changeSet, deps.clientId);
          if (change !== undefined) {
            events.queueRemoteChange(change);
          }
        },
      },
      rowHeight: ROW_HEIGHT,
      colWidth: COL_WIDTH,
      ...(options.columnWidths !== undefined ? { columnWidths: options.columnWidths } : {}),
      ...(options.rowHeights !== undefined ? { rowHeights: options.rowHeights } : {}),
      // DD-012-5: wrap 列・行分割キャッシュ・フォント・行高を DocumentView へ渡す（自動行高の計算基盤）。
      ...(deps.wrapEnabled ? { wrapColumns: deps.wrapColumns } : {}),
      wrapCache: deps.cellTextCache,
      cellFont: appearance.cellFont,
      columnFont: appearance.fontFor,
      lineHeight: CELL_TEXT_LINE_HEIGHT,
      onConnected: () => {
        metrics.mark('wsConnected');
      },
      onOperations: () => {
        metrics.mark('firstSync');
        deps.editor()?.session.noteServerUpdate();
      },
      // DD-020-3: 自分の SetCells op が committed へ確定した（own echo）→ Undo の ownedRevision を正確な revision で更新。
      onOwnSetCellsCommitted: (operationId, revision) => {
        undoCtrl.onCommitted(operationId, revision);
      },
      // DD-049: 1 サーバーメッセージの処理（適用・rollback/replay・描画の dirty 立て）が終わった時点で利用者向けイベントを配る
      // （listener から命令 API を呼んでも整合した状態を読む）。presence は一覧が変わりうるメッセージのときだけ再計算する。
      onServerMessageSettled: (message) => {
        events.flushRemoteChanges();
        if (
          message.type === 'welcome' ||
          message.type === 'presenceSnapshot' ||
          message.type === 'presenceDelta' ||
          message.type === 'presenceRemoved'
        ) {
          events.refreshPresence();
        }
      },
    });
    sync = collabSync;
    collabSession = collabSync.session;

    deps.attachBackend();
  }

  /** 単独モードの backend を構築して結線する（同期・共同編集の boot に相当・DD-024）。 */
  function bootStandalone(): void {
    if (deps.isDestroyed()) {
      return;
    }
    const errorCode = validateStandaloneOptions(options);
    if (errorCode !== undefined) {
      diag.emit('error', 'config-error', `${errorCode}: 単独モードの options 検証に失敗`);
      emit({ type: 'error', phase: 'config', code: errorCode, message: `standalone options invalid (${errorCode})` });
      return; // 配線しない（rAF ループは backend=undefined で no-op）
    }
    const standaloneOptions = options as GridStandaloneMountOptions;
    // DD-027-1: 列タイプ registry を生成（fail-fast）。不正なら配線しない（AC8）。
    if (!config.build(standaloneOptions.columnOrder)) {
      return;
    }
    resolvedDocumentId = standaloneOptions.documentId;
    diag.emit('info', 'standalone-boot', `columns=${standaloneOptions.columnOrder.length}`);
    const appearance = config.appearance();
    standalone = createStandaloneSession({
      columnOrder: standaloneOptions.columnOrder,
      ...(standaloneOptions.initialData !== undefined ? { initialData: standaloneOptions.initialData } : {}),
      rowHeight: ROW_HEIGHT,
      colWidth: COL_WIDTH,
      ...(options.columnWidths !== undefined ? { columnWidths: options.columnWidths } : {}),
      ...(options.rowHeights !== undefined ? { rowHeights: options.rowHeights } : {}),
      ...(deps.wrapEnabled ? { wrapColumns: deps.wrapColumns } : {}),
      ...(deps.stringColumnStrings.size > 0 ? { stringColumns: deps.stringColumns } : {}),
      wrapCache: deps.cellTextCache,
      cellFont: appearance.cellFont,
      columnFont: appearance.fontFor,
      lineHeight: CELL_TEXT_LINE_HEIGHT,
      // RC13（DD-052-4）: submitSetCells が積んだ逆値パッチを、consumer 通知（onCellCommit）より前に記録する。
      beforeCellCommit: () => editSubmit.recordPendingStandaloneUndo(standalone),
      // 確定通知（決定②「通知のみ」）: 表示文字列 batch を cell-commit イベントへ写して購読者へ配信する。
      onCellCommit: (changes) => {
        emit({ type: 'cell-commit', changes });
      },
      // DD-060: 不正な level で無視したセルの診断（未知列は cells・readOnlyColumns と同じく静かにスキップ）。
      onCellStatusInvalid: (message) => {
        diag.emit('warn', 'cell-status-invalid', message);
      },
      // DD-062: 状態の置き場は setCellStatus と共有する（setData の作り直しは setCellStatus の分も含む）。
      cellStatusStore,
    });
    sync = standalone;
    deps.attachBackend();
    // boot 前に呼ばれた setData/setRows（キャッシュ済みデータの mount 直後注入等）を、呼ばれた順に適用する
    // （Codex[P1]・DD-052-4 Codex[P2]: setData/setRows のどちらから呼ばれても実際の呼び出し順を保つ）。
    while (pendingStandaloneCalls.length > 0) {
      const call = pendingStandaloneCalls.shift()!;
      if (call.kind === 'data') {
        applyStandaloneData(call.data);
      } else if (call.kind === 'rows') {
        applyStandaloneSetRows(call.rows);
      } else {
        applyCellStatus(call.rows);
      }
    }
  }

  /**
   * 単独モードの再注入を適用する（setData 経由）。文書差し替え後、IME state machine の activeCell が新しい行/列
   * 範囲外に取り残されると以後の入力/Delete が無効 RowId へ落ちて無言で失われるため、範囲外なら active cell を
   * クランプして再シートする（Codex[P2]）。合成中は I-3 を守って触らない（利用側は編集完了後の再注入を推奨）。
   */
  function applyStandaloneData(data: GridStandaloneData): void {
    if (standalone === undefined) {
      return;
    }
    standalone.setData(data);
    // 文書を丸ごと差し替えた → 旧文書に対する undo/redo 履歴・ownedRevision は無効（別文書の逆値を新文書へ適用すると
    // standalone は beforeRevision を無視するためサイレント上書き、削除 ID なら throw になる・Codex P1）。全消去する。
    undoCtrl.clear();
    clampActiveCellToDocument(standalone);
    // DD-060: 状態表示も作り直されたので、ホバー中のセルの状態が変わっていれば cell-hover を出し直す
    // （クランプの後に呼ぶ: 出し直しは構造 flush を同期で走らせうるため、クランプとの順序を従来どおりに保つ）。
    deps.refreshHoverStatus();
  }

  /** setData 直後に activeCell が新文書の範囲外なら範囲内へ寄せる（applyStandaloneData の上記コメント参照）。 */
  function clampActiveCellToDocument(backend: StandaloneSession): void {
    const editor = deps.editor();
    if (editor === undefined || editor.session.isComposing()) {
      return;
    }
    // 新文書（差し替え直後・Axis は次 flush で再構築される）から行数・列数を読む。
    const doc = backend.session.committedDocument;
    const rowCount = displayRowOrder(doc).length;
    const colCount = doc.columnOrder.length;
    const active = editor.session.getActiveCell();
    if (active.row < rowCount && active.col < colCount) {
      return; // 範囲内 → active cell は触らない（周期リフレッシュでカーソルを飛ばさない）
    }
    if (rowCount === 0 || colCount === 0) {
      editor.pointerdownCell(null); // 空文書 → 選択解除
      return;
    }
    editor.pointerdownCell({ row: Math.min(active.row, rowCount - 1), col: Math.min(active.col, colCount - 1) });
  }

  /**
   * RC4（DD-052-4）: 行単位の部分更新（`setRows`）を適用する。`setData` と違い Undo を消さず、渡した行の
   * 変更セルだけを 1 Undo エントリとして記録する（新規行の挿入自体は行操作と同様 Undo 対象外）。readOnly は
   * `setData` と同様にバイパスする（プログラム的な再注入のため）。行が増えるだけで列は変わらないため、
   * `applyStandaloneData` と違い activeCell のクランプは不要（既存の選択が範囲外になることがない）。
   */
  function applyStandaloneSetRows(rows: readonly GridStandaloneRow[]): void {
    if (standalone === undefined) {
      return; // 共同編集モードは対象外（setData と同様の扱い）
    }
    const result = standalone.setRows(rows);
    if (result.changes.length > 0) {
      editSubmit.recordProgrammaticUndo(standalone, [...result.changes]);
    }
    // DD-060: 状態表示だけの変更は Undo に記録しない（文書のデータではない）。ホバー中のセルが変わっていれば出し直す。
    if (result.cellStatusUpdated) {
      deps.refreshHoverStatus();
    }
  }

  /**
   * DD-062: 両モード共通の状態表示の付け外し（`setCellStatus`）を適用する。渡した行の状態を丸ごと置き換える
   * （`{}` で消す）。状態は view-local で文書・サーバー・Undo には触れない。描画中なら可視セルの再描画を要求し、
   * ホバー中のセルの状態が変わっていれば cell-hover を出し直す。
   */
  function applyCellStatus(rows: readonly GridCellStatusRow[]): void {
    // JS の consumer の不正な形（配列でない・行がオブジェクトでない・rowId が文字列でない）は例外にせず、その行だけ
    // 飛ばして診断する（Codex P2: 単独モードの boot 前は queue の再生ごと止まり、後続の setData/setRows まで失われる）。
    const list: unknown = rows;
    if (!Array.isArray(list)) {
      diag.emit('warn', 'cell-status-invalid', 'setCellStatus: rows は { rowId, cellStatus } の配列が必要（無視）');
      return;
    }
    const invalid: string[] = [];
    const malformed: number[] = [];
    let updated = false;
    list.forEach((row: unknown, index) => {
      const rowId: unknown = typeof row === 'object' && row !== null ? (row as { rowId?: unknown }).rowId : undefined;
      if (typeof rowId !== 'string') {
        malformed.push(index);
        return;
      }
      if (cellStatusStore.replaceRow(rowId, (row as { cellStatus?: unknown }).cellStatus, invalid)) {
        updated = true;
      }
    });
    if (malformed.length > 0) {
      diag.emit('warn', 'cell-status-invalid', `setCellStatus: rows[${malformed.join(', ')}] は { rowId, cellStatus } ではないため無視しました`);
    }
    if (invalid.length > 0) {
      diag.emit('warn', 'cell-status-invalid', cellStatusInvalidMessage(invalid));
    }
    if (updated) {
      sync?.view.markCellDirty();
      deps.refreshHoverStatus();
    }
  }

  return {
    backend: () => sync,
    standalone: () => standalone,
    collabSession: () => collabSession,
    transport: () => browserTransport,
    documentId: () => resolvedDocumentId ?? options.documentId ?? '',
    connectionState() {
      // 単独モードは恒常的に非接続（DD-024・contract §4）。'offline'（一時切断）と区別する専用値。
      if (isStandalone) {
        return 'standalone';
      }
      if (sync === undefined) {
        return 'offline';
      }
      return sync.session.isStopped ? 'stopped' : sync.session.isOnline ? 'online' : 'offline';
    },
    lastSessionEventType: () => lastSessionEvent?.type ?? '',
    setData(data) {
      // 単独モード専用（DD-024・決定③）。
      if (standalone !== undefined) {
        applyStandaloneData(data);
        return;
      }
      // 単独モードだが boot（microtask）未完了 → 保留し構築後に順番どおり適用する（Codex[P1]・mount 直後注入を捨てない）。
      if (isStandalone && !deps.isDestroyed()) {
        pendingStandaloneCalls.push({ kind: 'data', data });
        return;
      }
      // 共同編集モードでは no-op（診断のみ）。
      diag.emit('warn', 'setData', 'setData は単独モード専用（共同編集モードでは無視）');
    },
    setRows(rows) {
      // RC4（DD-052-4）: 単独モード専用（setData の部分更新版）。
      if (standalone !== undefined) {
        applyStandaloneSetRows(rows);
        return;
      }
      // 単独モードだが boot（microtask）未完了 → 保留し構築後に順番どおり適用する（setData と同じ理由・Codex[P1]）。
      if (isStandalone && !deps.isDestroyed()) {
        pendingStandaloneCalls.push({ kind: 'rows', rows });
        return;
      }
      diag.emit('warn', 'setRows', 'setRows は単独モード専用（共同編集モードでは無視）');
    },
    setCellStatus(rows) {
      // DD-062: 両モード共通。単独モードの boot 前は setData/setRows と同じ queue に積んで呼び出し順を保つ
      // （保留した setData の作り直しで、先に付けた状態が消えないように）。共同編集モードはすぐ置き場へ書く。
      if (deps.isDestroyed()) {
        return;
      }
      if (isStandalone && standalone === undefined) {
        pendingStandaloneCalls.push({ kind: 'status', rows });
        return;
      }
      applyCellStatus(rows);
    },
    start() {
      if (isStandalone) {
        // 単独モード（DD-024）: WS/tick interval は不要（transport 無し）。backend 構築は microtask で行い、
        // mount() の同期 return 契約（イベントは return 後に届く）を共同編集経路と揃える。destroy 済みなら配線しない。
        queueMicrotask(() => {
          try {
            bootStandalone();
          } catch (error) {
            diag.emit('error', 'runtime-error', errorMessage(error));
            emit({ type: 'error', phase: 'runtime', code: 'runtime-fault', message: errorMessage(error) });
          }
        });
        return;
      }
      intervalId = window.setInterval(() => {
        // tick=再送/catch-up ポーリング、heartbeat=サーバー TTL（15秒）失効を防ぐ生存通知。offline 時は transport が drop。
        sync?.session.tick();
        sync?.session.sendHeartbeat();
      }, TICK_INTERVAL_MS);
      // boot は自前で config 失敗を error イベント化するが、config 以降の配線例外は runtime error として通知する
      // （旧 main.ts の `void boot().catch(...)` と等価・unhandled rejection を出さない）。
      void boot().catch((error) => {
        diag.emit('error', 'runtime-error', errorMessage(error));
        emit({ type: 'error', phase: 'runtime', code: 'runtime-fault', message: errorMessage(error) });
      });
    },
    stopTimers() {
      window.clearInterval(intervalId);
    },
    closeTransport() {
      browserTransport?.close();
    },
  };
}
