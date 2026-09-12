// SessionSync（DD-005 Phase 2）: browser-transport ↔ ClientSession ↔ DocumentView の結線。
//
// ClientSession を Document State の唯一の正本に保つため、サーバーメッセージは **必ず session が適用してから**
// DocumentView（Render State）へ反映する。そのため inner transport を「観測 decorator」でラップし、
// handleServerMessage の順序を session → observer に固定する（observer は適用後の文書だけを読む）。
//
// DocumentView は文書を複製しない（#2）。observer は operations の Operation 種別だけを見て dirty を立て、
// 次フレームの flush が可視範囲を読み直す。再接続時は catch-up で Document State が再収束するのに合わせ、
// Render State を全再構築する（#10 再接続経路）。

import { ClientSession } from '@nanairo-sheet/collab';
import type { ClientTransport, SessionConfig, TransportListener } from '@nanairo-sheet/collab';
import type { ServerMessage } from '@nanairo-sheet/core';
import type { TextMetricsCache } from '@nanairo-sheet/render';
import type { OperationId, RowId } from '@nanairo-sheet/types';

import { DocumentView } from './document-view';

/** session 適用後にサーバーメッセージ・接続イベントを観測するコールバック。 */
export interface SessionObserver {
  onServerMessage(message: ServerMessage): void;
  onConnected(): void;
  onDisconnected(): void;
}

/** 観測 decorator を含む ClientTransport（observer は後付けできる）。 */
export interface ObservingTransport extends ClientTransport {
  setObserver(observer: SessionObserver): void;
}

/**
 * inner transport をラップし、handleServerMessage/handleConnected/handleDisconnected を
 * 「session（唯一の正本）→ observer（Render 追従）」の順で配る decorator。
 */
export function createObservingTransport(inner: ClientTransport): ObservingTransport {
  let session: TransportListener | undefined;
  let observer: SessionObserver | undefined;

  const tap: TransportListener = {
    handleServerMessage(message) {
      session?.handleServerMessage(message); // 1) 唯一の正本を更新
      observer?.onServerMessage(message); // 2) 適用後の文書を Render State が読む
    },
    handleConnected() {
      session?.handleConnected();
      observer?.onConnected();
    },
    handleDisconnected() {
      session?.handleDisconnected();
      observer?.onDisconnected();
    },
  };

  return {
    setListener(listener) {
      session = listener; // = ClientSession
      inner.setListener(tap);
    },
    connect() {
      inner.connect();
    },
    send(message) {
      inner.send(message);
    },
    setObserver(next) {
      observer = next;
    },
  };
}

export interface SessionSyncConfig {
  /** 実トランスポート（browser-transport）またはテスト用（RecordingTransport）。 */
  innerTransport: ClientTransport;
  /** transport を除いた ClientSession 設定（clientId/userId/documentId/columnOrder/clock/idGenerator 等）。 */
  sessionConfig: Omit<SessionConfig, 'transport'>;
  rowHeight: number;
  colWidth: number;
  /** 初期の列幅 override（ColumnId 文字列→px・DD-012-4 D2・保存済み設定の復元）。 */
  columnWidths?: Readonly<Record<string, number>>;
  /** 初期の行高 override（RowId 文字列→px・DD-012-4 D2）。 */
  rowHeights?: Readonly<Record<string, number>>;
  /** 折り返し（wrap）列（ColumnId 文字列・DD-012-5 D1）。 */
  wrapColumns?: readonly string[];
  /** 行分割キャッシュ（DD-012-5 D4・base-layer と共有）。 */
  wrapCache?: TextMetricsCache;
  /** セル文字フォント（wrapLines 測定用・base-layer と一致）。 */
  cellFont?: string;
  /** wrap 折り返し行の行高（px・base-layer の lineHeight と一致）。 */
  lineHeight?: number;
  /** 接続確立時（#6 計測 wsConnected）。 */
  onConnected?: () => void;
  /** operations 受信時（#6 計測 firstSync＝Document State 初回反映）。 */
  onOperations?: () => void;
  /**
   * 自分の SetCells op が committed へ確定した（own echo 検出・DD-020-3 Undo）。operationId と**サーバー付与 revision**を
   * 渡す。Undo スタックの ownedRevision（補償 op の beforeRevision）を「元操作が付与した正確な revision」で更新する。
   * committed の事後読取ではなく own envelope が運ぶ revision を使うため、同一 echo batch に他者 op が混ざっても
   * foreign revision を owned と誤認しない（R-07 対策の要）。
   */
  onOwnSetCellsCommitted?: (operationId: OperationId, revision: number) => void;
  /**
   * 1 サーバーメッセージの処理（session の適用 → Render State の dirty 立て）が終わった直後（DD-049）。
   * 利用者向けの remote-change / presence はここで配る（listener が命令 API を呼んでも、適用途中の文書や dirty 未反映の
   * Render State を読まない）。
   */
  onServerMessageSettled?: (message: ServerMessage) => void;
}

export interface SessionSync {
  readonly session: ClientSession;
  readonly view: DocumentView;
  /** 接続を開始する（transport.connect → join）。 */
  start(): void;
}

/**
 * ClientSession と DocumentView を結線して返す。observer は operations の種別で dirty を立て、
 * 再接続時は Render State を全再構築する。文書の正本は常に session（view は派生）。
 */
export function createSessionSync(config: SessionSyncConfig): SessionSync {
  const observing = createObservingTransport(config.innerTransport);
  const session = new ClientSession({ ...config.sessionConfig, transport: observing });
  const ownClientId = config.sessionConfig.clientId; // own echo 判定（DD-020-3）
  const view = new DocumentView({
    getDocument: () => session.viewDocument, // 唯一の正本を読む派生 Adapter
    rowHeight: config.rowHeight,
    colWidth: config.colWidth,
    ...(config.columnWidths !== undefined ? { columnWidths: config.columnWidths } : {}),
    ...(config.rowHeights !== undefined ? { rowHeights: config.rowHeights } : {}),
    ...(config.wrapColumns !== undefined ? { wrapColumns: config.wrapColumns } : {}),
    ...(config.wrapCache !== undefined ? { wrapCache: config.wrapCache } : {}),
    ...(config.cellFont !== undefined ? { cellFont: config.cellFont } : {}),
    ...(config.lineHeight !== undefined ? { lineHeight: config.lineHeight } : {}),
  });

  let sawDisconnect = false;
  observing.setObserver({
    onServerMessage(message) {
      // session は適用済み。種別ごとに Render State の dirty を立てる（Render は常に Document State を追う・#1/#2）。
      switch (message.type) {
        case 'bootstrap':
          // snapshot bootstrap（DD-014-1）: committed が document@R へ丸ごと差し替わる。Render State は全再構築で追従
          // （全 operationLog を replay せず初期ロードを確立・§8 既知制約回収）。firstSync 計測も初回同期として点火する。
          view.markFullRebuild();
          config.onOperations?.();
          break;
        case 'operations': {
          // リモート適用後、変更セルの行だけ自動行高を再計算する（D5 トリガー②＝リモート SetCells）。
          const changedRows: RowId[] = [];
          for (const envelope of message.operations) {
            view.noteOperation(envelope.operation);
            const op = envelope.operation;
            if (op.type === 'setCells') {
              for (const change of op.changes) {
                changedRows.push(change.rowId);
              }
              // 自分の SetCells の echo（own commit）→ Undo の ownedRevision を正確な revision で更新する（DD-020-3）。
              if (envelope.clientId === ownClientId) {
                config.onOwnSetCellsCommitted?.(envelope.operationId, envelope.revision);
              }
            }
          }
          if (changedRows.length > 0) {
            view.recomputeAutoRowHeightsForRows(changedRows);
          }
          config.onOperations?.();
          break;
        }
        case 'operationRejected':
          // reject で楽観 pending がロールバックされ viewDocument が committed へ戻る（描画値が変わりうる）。
          // セル dirty を立てて可視範囲を描き直す。さもないと自分の rejected draft が Canvas に残る（Codex P1）。
          view.markCellDirty();
          // 楽観 insertRows/deleteRows の reject では行 Axis も committed へ戻す必要がある（Fable P3: 立てないと
          // rejected 行の RowId が次の構造 Op まで rowAxis に残り空行として表示され続け、K3 再ベースもずれた
          // Axis を oldOrder に使う）。reject は稀ゆえ op 種別を持たない本ハンドラでは一括で構造 dirty を立てる。
          view.markStructureDirty();
          // rollback で描画値が縮む/伸びるため自動行高も追従する（D5 トリガー②＝rollback 後）。reject は稀ゆえ一括で正す。
          view.recomputeAllAutoRowHeights();
          break;
        case 'presenceSnapshot':
        case 'presenceDelta':
        case 'presenceRemoved':
          // 他者 Presence の出現/移動/消滅は overlay-layer の再描画契機。dirty を立てないと、受信側がアイドルの間
          // 他者カーソル/名前タグが次の viewport/文書更新まで反映されない（シナリオ10・Codex P1）。
          view.markViewportDirty();
          break;
        // welcome/operationAck/heartbeatAck は Render 更新契機ではない（ack は値不変で pending→committed の昇格のみ）。
      }
      // DD-049: session の適用と Render State の dirty 立てが済んだ＝利用者向けイベント（remote-change/presence）を配ってよい。
      config.onServerMessageSettled?.(message);
    },
    onConnected() {
      config.onConnected?.();
      if (sawDisconnect) {
        // 再接続: catch-up で Document State が再収束する。Render State は全再構築で追従する（#10）。
        view.markFullRebuild();
        sawDisconnect = false;
      }
    },
    onDisconnected() {
      sawDisconnect = true;
    },
  });

  return {
    session,
    view,
    start: () => {
      session.start();
    },
  };
}
