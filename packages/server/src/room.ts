// 権威 Room（トランスポート非依存・メッセージ in/out）。Sequencer（全順序 Operation）と PresenceRegistry を束ね、
// クライアントメッセージ＋connectionId を入力に、宛先付きサーバーメッセージ列（Outbound[]）を返す純粋インターフェース。
// 実 WS/in-process いずれのトランスポートからも同じ Room を駆動できる（Phase 3/4）。
//
// connectionId はサーバーが払い出す（welcome.sessionId＝Presence 管理単位）。clientId（envelope）は clientSequence/
// 冪等キーで再接続不変（protocol-subset §2）。時刻・ID は注入（clock / idGenerator）でテスト再現可能。

import { CATCHUP_SNAPSHOT_THRESHOLD, serializeDocument } from '@nanairo-sheet/core';
import type {
  ClientMessageExceptJoin,
  ClientOperationEnvelope,
  JoinMessage,
  ReconcileInfo,
  ServerMessage,
  ServerOperationEnvelope,
  SheetDocument,
} from '@nanairo-sheet/core';

import type { OperationId } from '@nanairo-sheet/types';

import { createCounterIdGenerator } from './deps';
import type { Clock, IdGenerator } from './deps';
import { PresenceRegistry } from './presence';
import type { Sequencer, SequencerState } from './sequencer';

/**
 * durable 読取境界（DD-014-1・P1-3）。join/requestCatchup/welcome が観測してよい最大 revision（frontier）と
 * その revision に対応する権威文書を供給する。永続化無効時は Room が Sequencer の現在値を frontier とみなす
 * （in-memory のみ＝全 revision が即読取可能）。PersistentRoom が fsync 済み境界を注入して未 durable を隠す。
 */
export interface DurableBoundary {
  frontierRevision(): number; // fsync 済み最大 revision（この revision 以下のみ配布する）
  frontierDocument(): SheetDocument; // document@frontierRevision（COW ゆえ以降の op で不変・snapshot bootstrap の源）
  frontierClientSequenceTable(): ReadonlyMap<string, number>; // frontier 時点の clientId→処理済み clientSequence（再接続 reconcile・DD-015 P1-1）
}

/** Outbound の宛先。transport が 'all'/'others' を活性接続へ fan-out する。 */
export type OutboundTarget =
  | { kind: 'connection'; connectionId: string } // 直接宛先
  | { kind: 'others'; exceptConnectionId: string } // 送信元以外へ
  | { kind: 'all' }; // 全接続（送信元含む＝operations エコー）

export interface Outbound {
  target: OutboundTarget;
  message: ServerMessage;
}

const DEFAULT_TTL_MILLIS = 15_000; // §9.3 初期値（Presence TTL 目安 15 秒）
const PROTOCOL_VERSION = 1;

export class Room {
  private readonly sequencer: Sequencer;
  private readonly presence: PresenceRegistry;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly connections = new Map<string, { clientId: string }>();
  private durableBoundary: DurableBoundary | undefined;

  constructor(
    sequencer: Sequencer,
    deps: { clock: Clock; idGenerator?: IdGenerator; ttlMillis?: number },
  ) {
    this.sequencer = sequencer;
    this.clock = deps.clock;
    this.idGenerator = deps.idGenerator ?? createCounterIdGenerator();
    this.presence = new PresenceRegistry({
      clock: deps.clock,
      ttlMillis: deps.ttlMillis ?? DEFAULT_TTL_MILLIS,
    });
  }

  /**
   * durable 読取境界を注入する（PersistentRoom が構築時に呼ぶ・DD-014-1 P1-3）。以降 join/catch-up/welcome は
   * frontier 以下のみを配布する。未注入（永続化無効）なら Sequencer の現在 revision/document を frontier とみなす。
   */
  attachDurableBoundary(boundary: DurableBoundary): void {
    this.durableBoundary = boundary;
  }

  /** 配布してよい最大 revision（durable frontier）。永続化無効時は現在 revision（全 in-memory が読取可能）。 */
  private frontierRevision(): number {
    return this.durableBoundary?.frontierRevision() ?? this.sequencer.currentRevision;
  }

  /** frontier revision に対応する権威文書（snapshot bootstrap の源）。 */
  private frontierDocument(): SheetDocument {
    return this.durableBoundary?.frontierDocument() ?? this.sequencer.document;
  }

  /**
   * afterRevision 超〜frontier 以下の未受信 op を返す（catch-up/join tail 共通）。durable 境界未注入（永続化無効）時は
   * frontier=currentRevision ゆえ余計な filter 割当を避ける（実 WS 収束経路の per-message オーバーヘッドを増やさない）。
   */
  private operationsUpToFrontier(afterRevision: number, frontier: number): ServerOperationEnvelope[] {
    const since = this.sequencer.operationsSince(afterRevision);
    if (this.durableBoundary === undefined) {
      return since; // frontier == currentRevision＝全て配布可（filter 不要）
    }
    return since.filter((e) => e.revision <= frontier);
  }

  /**
   * join を処理し connectionId を払い出す（§8.2）。welcome ＋ lastAppliedRevision 以降の operations ＋
   * presenceSnapshot を送信元へ返す。join は userId/displayName を持たない（§1）ため presenceDelta は
   * 最初の presence メッセージで配信する（colorKey は join で予約・S-L1）。
   */
  handleJoin(join: JoinMessage): { connectionId: string; outbound: Outbound[] } {
    const connectionId = this.idGenerator.next();
    this.connections.set(connectionId, { clientId: join.clientId });
    const colorKey = this.presence.register(connectionId); // colorKey を welcome で返す（Phase 3 指示 3）

    const frontier = this.frontierRevision(); // welcome/配布は durable frontier 以下に限定（P1-3・未 durable を隠す）
    const reconcile = this.computeReconcile(join); // DD-015: 再接続 pending の受理済/未処理判定（join.pending 省略時は undefined）
    // revision 連続性 fail-fast（DD-015・C11）: client が権威 frontier より先を持つ＝server が巻き戻った（分岐した歴史）。
    // frontier は権威ゆえ join 処理時点で判定でき、応答（welcome/operations）の順序入れ替えに非依存（in-process reorder で誤検出しない）。
    const diverged = join.lastAppliedRevision > frontier;
    const welcome: ServerMessage = {
      type: 'welcome',
      sessionId: connectionId,
      colorKey,
      currentRevision: frontier,
      capabilities: { protocolVersion: PROTOCOL_VERSION },
      ...(reconcile !== undefined ? { reconcile } : {}),
      ...(diverged ? { diverged: true } : {}),
    };
    const outbound: Outbound[] = [{ target: { kind: 'connection', connectionId }, message: welcome }];

    // snapshot bootstrap: ①fresh join（lastAppliedRevision<=0・§8 既知制約回収 P1-6/P1-7）②再接続で差分>閾値T
    // （DD-015 要確認②: 大量差分の catch-up を避け document@frontier〔snapshot〕1 通で committed を確立）。
    // client は同一の (frontier, lastAppliedRevision) から同一判定を導き bootstrap を待つ（session.handleWelcome 対称）。
    if (this.shouldBootstrap(join.lastAppliedRevision, frontier)) {
      outbound.push({ target: { kind: 'connection', connectionId }, message: this.bootstrapMessage(frontier) });
    } else {
      // tail 経路（reconnect/catch-up・lastAppliedRevision>0）: frontier 以下の未受信 op だけを送る。
      const missed = this.operationsUpToFrontier(join.lastAppliedRevision, frontier);
      if (missed.length > 0) {
        outbound.push({ target: { kind: 'connection', connectionId }, message: operationsMessage(missed) });
      }
    }

    outbound.push({
      target: { kind: 'connection', connectionId },
      message: { type: 'presenceSnapshot', users: this.presence.snapshot() },
    });

    return { connectionId, outbound };
  }

  /**
   * 再接続 reconcile（DD-015・exactly-once・fault matrix C2〜C4）を計算する。join.pending（未ACK pending 参照）を受け、
   * ①この clientId の処理済み clientSequence 高水位 ②pending のうち確定ログ（ackCache＝accepted/noop）に在る operationId 集合
   * を返す。join.pending 省略（legacy/synthetic）時は undefined（従来の再送経路）。scan は pending 件数分（bounded ≤ maxOfflinePending）
   * ゆえ差分サイズ非依存（snapshot 再取得の大量差分でも O(pending)）。
   */
  private computeReconcile(join: JoinMessage): ReconcileInfo | undefined {
    if (join.pending === undefined) {
      return undefined;
    }
    const frontier = this.frontierRevision();
    // ackedClientSequence は **live** clientSequenceTable の高水位を使う（Codex P1-e）: reject/no-op も clientSequence を消費するが
    // durable frontier の表には反映されない（accepted のみ frontier を前進させる）。frontier 表を使うと reject 済み op（seq 消費済み・
    // frontier 表では未消費に見える）を「未処理」と誤判定して再送→client-sequence-violation ループになる。live 表なら reject 済みを
    // 正しく「seq≦acked かつ非accepted＝reject」と分類できる。
    const ackedClientSequence = this.sequencer.clientSequenceTable.get(join.clientId) ?? 0;
    // pending を「durable-accepted（除去）／in-flight（未 durable・保持）／それ以外（client 側で reject or 未処理）」に分類する。
    // acceptedOperationIds: ackCache 在 かつ revision≦frontier＝durable ＝client は除去（committed@frontier に反映済み・Codex P1-1）。
    // inFlightOperationIds: ackCache 在 だが revision>frontier＝pre-fsync accepted（未 durable）＝client は保持（再送）＝除去も reject も
    //   しない（除去は append 失敗時の喪失・reject は durable 化後の false conflict を招く・Codex 第3回 P1-b）。
    const acceptedOperationIds: OperationId[] = [];
    const inFlightOperationIds: OperationId[] = [];
    for (const ref of join.pending) {
      const revision = this.sequencer.ackedRevisionOf(ref.operationId);
      if (revision === undefined) {
        continue; // 未処理 or reject（client 側で seq と突合せ）
      }
      if (revision <= frontier) {
        acceptedOperationIds.push(ref.operationId);
      } else {
        inFlightOperationIds.push(ref.operationId);
      }
    }
    return {
      ackedClientSequence,
      acceptedOperationIds,
      ...(inFlightOperationIds.length > 0 ? { inFlightOperationIds } : {}),
    };
  }

  /**
   * bootstrap（snapshot 再取得）を返すべきか（client の session.handleWelcome/handleBootstrap と対称）。
   * - fresh join（afterRevision≦0）: 文書が非空なら返す。frontier>0 に加え、**frontier 0 でも非空**（DD-026-1 の初期文書
   *   `initialDocument`＝document@0）なら bootstrap@0 を返す（client は committed 0 かつ未 bootstrap のとき受理する）。
   *   空文書@0 は従来どおり返さない（後方互換）。
   * - reconnect（afterRevision>0）: 差分>閾値 T なら snapshot 再取得。
   */
  private shouldBootstrap(afterRevision: number, frontier: number): boolean {
    if (afterRevision <= 0) {
      return frontier > 0 || this.frontierDocument().rowOrder.length > 0;
    }
    return frontier - afterRevision > CATCHUP_SNAPSHOT_THRESHOLD;
  }

  private bootstrapMessage(frontier: number): ServerMessage {
    return { type: 'bootstrap', document: serializeDocument(this.frontierDocument()), revision: frontier };
  }

  /** 確立済み接続からのメッセージ（join 以外）を処理する。 */
  handleMessage(connectionId: string, message: ClientMessageExceptJoin): Outbound[] {
    switch (message.type) {
      case 'submitOperation':
        return this.handleSubmit(connectionId, message.envelope);
      case 'presence':
        return this.handlePresence(connectionId, message.sequence, message.payload);
      case 'heartbeat':
        return this.handleHeartbeat(connectionId);
      case 'requestCatchup':
        return this.handleRequestCatchup(connectionId, message.afterRevision);
    }
  }

  /** 正常 close: 接続削除・Presence 即時削除（TTL を待たない・S-L6）。 */
  handleDisconnect(connectionId: string): Outbound[] {
    this.connections.delete(connectionId);
    const hadPresence = this.presence.remove(connectionId);
    if (!hadPresence) {
      return [];
    }
    return [
      {
        target: { kind: 'others', exceptConnectionId: connectionId },
        message: { type: 'presenceRemoved', sessionId: connectionId },
      },
    ];
  }

  /** TTL 失効スイープ（注入クロックで明示発火・DA D6）。失効接続を presenceRemoved で配信（S-L5）。 */
  sweep(): Outbound[] {
    const outbound: Outbound[] = [];
    for (const removed of this.presence.sweep()) {
      this.connections.delete(removed.connectionId);
      if (removed.hadPresence) {
        outbound.push({
          target: { kind: 'others', exceptConnectionId: removed.connectionId },
          message: { type: 'presenceRemoved', sessionId: removed.connectionId },
        });
      }
    }
    return outbound;
  }

  /** 'all'/'others' 展開用の活性接続一覧（transport が fan-out する）。 */
  activeConnectionIds(): readonly string[] {
    return [...this.connections.keys()];
  }

  /** snapshot エクスポート用に Sequencer 状態を返す（Presence は非永続ゆえ含めない）。 */
  exportState(): SequencerState {
    return this.sequencer.exportState();
  }

  private handleSubmit(connectionId: string, envelope: ClientOperationEnvelope): Outbound[] {
    const outcome = this.sequencer.submit(envelope);
    switch (outcome.status) {
      case 'accepted':
        return [
          { target: { kind: 'connection', connectionId }, message: outcome.ack },
          { target: { kind: 'all' }, message: operationsMessage([outcome.envelope]) },
        ];
      case 'noop':
      case 'duplicate':
        return [{ target: { kind: 'connection', connectionId }, message: outcome.ack }];
      case 'rejected':
        return [{ target: { kind: 'connection', connectionId }, message: outcome.rejection }];
    }
  }

  private handlePresence(
    connectionId: string,
    sequence: number,
    payload: Parameters<PresenceRegistry['update']>[2],
  ): Outbound[] {
    const presence = this.presence.update(connectionId, sequence, payload);
    if (presence === undefined) {
      return []; // 未登録 or 古い sequence（S-L3）
    }
    return [
      {
        target: { kind: 'others', exceptConnectionId: connectionId },
        message: { type: 'presenceDelta', presence },
      },
    ];
  }

  private handleHeartbeat(connectionId: string): Outbound[] {
    this.presence.touch(connectionId);
    return [
      {
        target: { kind: 'connection', connectionId },
        message: { type: 'heartbeatAck', serverTime: this.clock.now() },
      },
    ];
  }

  private handleRequestCatchup(connectionId: string, afterRevision: number): Outbound[] {
    // durable frontier 以下のみ配布する（未 fsync revision を catch-up から観測させない・P1-3）。
    // requestCatchup は **tail（operations）のみ**を返す（Codex 第3回 P1-a）: bootstrap を返すと reconcile 情報（join.pending 依存）を
    // 伴わないため、受理済み未ACK own op を phantom conflict / 永久 acknowledged 化する。snapshot 再取得は reconcile を伴う join 経路
    // に限定する。差分>閾値の catch-up は大きな tail になるが正しい（incremental 適用・phantom なし）。bootstrap フレーム自体は
    // welcome と同梱で順序保証・信頼性のある transport（TCP）が確実に配送し、hub でも非 drop ゆえ「open 中に喪失」は到達不能。
    const frontier = this.frontierRevision();
    const missed = this.operationsUpToFrontier(afterRevision, frontier);
    // off-by-one: fromRevision = afterRevision+1（afterRevision 自身は再送しない・S-I5）。空でも range を返し確定応答。
    return [
      {
        target: { kind: 'connection', connectionId },
        message: {
          type: 'operations',
          fromRevision: afterRevision + 1,
          toRevision: frontier,
          operations: missed,
        },
      },
    ];
  }
}

function operationsMessage(operations: ServerOperationEnvelope[]): ServerMessage {
  return {
    type: 'operations',
    fromRevision: operations[0].revision,
    toRevision: operations[operations.length - 1].revision,
    operations,
  };
}
