// 全順序シーケンサー（protocol-subset §5 の処理順を厳守）。権威文書＋Operation ログ＋冪等キャッシュ＋
// clientSequence 表を保持し、submitOperation を「operationId 冪等 → clientSequence → baseRevision → 検証 → 適用」
// の順で処理する。順序が正しさを決める（DA D3: 重複再送を先に救済しないと clientSequence 違反で誤 reject＝AC2 破綻）。
//
// 適用は core の applyOperation（クライアントと共有・§5.3）。reject 判定は core の validateOperation
// （サーバー/クライアント判定一致・指示 1）。時刻・乱数・Node API 非参照（clock は注入・§7.6 の精神をサーバーへ拡張）。

import {
  applyOperation,
  createDocument,
  validateOperation,
} from '@nanairo-sheet/core';
import type {
  ChangeSet,
  ClientOperationEnvelope,
  OperationAckMessage,
  OperationRejectedMessage,
  OperationViolation,
  RejectCode,
  RejectDetails,
  ServerOperationEnvelope,
  SheetDocument,
} from '@nanairo-sheet/core';
import type { ColumnId, OperationId } from '@nanairo-sheet/types';

import type { Clock } from './deps';

/** Sequencer の全状態（snapshot エクスポート/インポートの単位）。 */
export interface SequencerState {
  document: SheetDocument;
  operationLog: ServerOperationEnvelope[];
  currentRevision: number;
  ackCache: Map<OperationId, number>; // operationId → ACK revision（accepted と no-op を登録・指示 5）
  clientSequenceTable: Map<string, number>; // clientId → 最終処理 clientSequence
}

/** submit の結果。Room がトランスポートへの配信（ACK / broadcast / reject）に写像する。 */
export type SequencerOutcome =
  | { status: 'accepted'; ack: OperationAckMessage; envelope: ServerOperationEnvelope }
  | { status: 'noop'; ack: OperationAckMessage }
  | { status: 'duplicate'; ack: OperationAckMessage }
  | { status: 'rejected'; rejection: OperationRejectedMessage };

/** 空の Sequencer 状態を作る（固定 ColumnId 列・revision=0）。 */
export function freshSequencerState(columnOrder: ColumnId[]): SequencerState {
  return {
    document: createDocument(columnOrder),
    operationLog: [],
    currentRevision: 0,
    ackCache: new Map(),
    clientSequenceTable: new Map(),
  };
}

export class Sequencer {
  private state: SequencerState;
  private readonly clock: Clock;

  constructor(state: SequencerState, clock: Clock) {
    this.state = state;
    this.clock = clock;
  }

  get currentRevision(): number {
    return this.state.currentRevision;
  }

  /** 権威文書（読み取り専用に扱う。呼び出し側は変更しない）。 */
  get document(): SheetDocument {
    return this.state.document;
  }

  /**
   * clientId→最終処理 clientSequence の読み取りビュー（durable frontier での state 捕捉用・DD-014-1 P1-C）。
   * 呼び出し側はコピーして保持する（内部 Map は submit で前進する）。
   */
  get clientSequenceTable(): ReadonlyMap<string, number> {
    return this.state.clientSequenceTable;
  }

  /**
   * operationId が確定ログに在る（accepted/noop で ackCache 登録済み）なら ACK revision、未処理/reject 済みなら undefined。
   * 再接続 reconcile（DD-015・exactly-once）で「client の未ACK pending が実は受理済みか」を判定するのに使う。
   * reject 済み op は ackCache に登録されない（＝undefined）ため、accepted と reject を区別できる。
   */
  ackedRevisionOf(operationId: OperationId): number | undefined {
    return this.state.ackCache.get(operationId);
  }

  /**
   * submitOperation を §5 の処理順で処理する。
   * 1 operationId 冪等 → 2 clientSequence → 3 baseRevision → 4 検証 → 5 適用（no-op は revision 非消費）。
   */
  submit(env: ClientOperationEnvelope): SequencerOutcome {
    // 1. operationId 冪等（clientSequence 検査より先＝DA D3）。既知なら同一 ACK を再返却し以降を行わない（S-F2）。
    const cachedRevision = this.state.ackCache.get(env.operationId);
    if (cachedRevision !== undefined) {
      return { status: 'duplicate', ack: ackMessage(env.operationId, cachedRevision) };
    }

    // 2. clientSequence 検査（clientId 単位・単調 expected=(last??0)+1）。欠番/戻りは reject（advance しない・S-F3）。
    const lastSequence = this.state.clientSequenceTable.get(env.clientId) ?? 0;
    const expectedSequence = lastSequence + 1;
    if (env.clientSequence !== expectedSequence) {
      return {
        status: 'rejected',
        rejection: rejectMessage(env.operationId, 'client-sequence-violation', {
          expectedSequence,
          receivedSequence: env.clientSequence,
        }),
      };
    }
    // seq スロット消費: ここを通ったら以降の reject でも clientSequence を必ず前進させる
    // （well-behaved クライアントの次 op が seq+1 で受理されるため。reject 済み op は Conflict Queue 行き＝再送しない）。
    this.state.clientSequenceTable.set(env.clientId, env.clientSequence);

    // 3. baseRevision 検査（baseRevision ≤ currentRevision を要求・S-F6）。
    if (env.baseRevision > this.state.currentRevision) {
      return {
        status: 'rejected',
        rejection: rejectMessage(env.operationId, 'invalid-base-revision', {
          currentRevision: this.state.currentRevision,
        }),
      };
    }

    // 4. 検証（validateOperation を共有・SetCells 原子性で全違反を列挙・§3/§5-5）。
    const violations = validateOperation(this.state.document, env.operation);
    if (violations.length > 0) {
      return {
        status: 'rejected',
        rejection: rejectMessage(env.operationId, primaryRejectCode(violations), { violations }),
      };
    }

    // 5. 適用（apply を共有）。検証を通過済みゆえ apply は throw しない（validate の契約）。
    const nextRevision = this.state.currentRevision + 1;
    const result = applyOperation(this.state.document, env.operation, { revision: nextRevision });

    if (isEmptyChangeSet(result.changeSet)) {
      // Q-1 no-op（全件 tombstone 済み DeleteRows 等）: revision 非消費・ログ非追記・配信なし。
      // ACK は処理時点の currentRevision を返し、ackCache 登録・clientSequence は前進済み（S-E3・指示 4）。
      const ackRevision = this.state.currentRevision;
      this.state.ackCache.set(env.operationId, ackRevision);
      return { status: 'noop', ack: ackMessage(env.operationId, ackRevision) };
    }

    // accepted: revision 消費・文書更新・ログ追記・ackCache 登録。
    this.state.document = result.document;
    this.state.currentRevision = nextRevision;
    const envelope: ServerOperationEnvelope = {
      ...env,
      revision: nextRevision,
      acceptedAt: new Date(this.clock.now()).toISOString(), // 監査用（hash 非依存・注入クロックで決定的）
      canonicalOperation: env.operation, // PoC では operation と同一
    };
    this.state.operationLog.push(envelope);
    this.state.ackCache.set(env.operationId, nextRevision);
    return { status: 'accepted', ack: ackMessage(env.operationId, nextRevision), envelope };
  }

  /** revision > afterRevision のログ（catch-up / join 用。off-by-one: afterRevision 自身は含まない・S-I5）。 */
  operationsSince(afterRevision: number): ServerOperationEnvelope[] {
    return this.state.operationLog.filter((envelope) => envelope.revision > afterRevision);
  }

  /** snapshot エクスポート用に状態の深いコピーを返す（snapshot.ts が JSON へ直列化する）。 */
  exportState(): SequencerState {
    return {
      document: this.state.document, // 文書は accepted 毎に新インスタンス（apply が clone を返す）ゆえ共有参照で安全
      operationLog: [...this.state.operationLog],
      currentRevision: this.state.currentRevision,
      ackCache: new Map(this.state.ackCache),
      clientSequenceTable: new Map(this.state.clientSequenceTable),
    };
  }
}

// 適用結果が「実質変更なし（no-op）」かを判定する（Q-1: 全件 tombstone 済み DeleteRows 等）。
// changeSet の cells/rowsInserted/rowsDeleted がすべて空 ＝ no-op（同値 SetCells は cells に before/after が
// 載るため no-op 扱いしない＝revision 消費・S-A9/Q-1 裁定と整合）。
function isEmptyChangeSet(changeSet: ChangeSet): boolean {
  return (
    changeSet.cells.length === 0 &&
    changeSet.rowsInserted.length === 0 &&
    changeSet.rowsDeleted.length === 0
  );
}

function primaryRejectCode(violations: OperationViolation[]): RejectCode {
  // 固定優先順位（決定的）: 構造行エラー → アンカー/重複 → stale。
  const order: RejectCode[] = [
    'unknown-row',
    'unknown-anchor',
    'duplicate-row',
    'target-row-deleted',
    'unknown-column',
    'stale-cell-revision',
  ];
  for (const code of order) {
    if (violations.some((v) => v.code === code)) {
      return code;
    }
  }
  // 呼び出し側は violations が 1 件以上のときだけ呼ぶ（空なら accepted 経路）。空は内部不変条件の破れとして止める（DD-050）。
  const first = violations[0];
  if (first === undefined) {
    throw new Error('primaryRejectCode: violations が空です（内部不変条件違反）');
  }
  return first.code;
}

function ackMessage(operationId: OperationId, revision: number): OperationAckMessage {
  return { type: 'operationAck', operationId, revision };
}

function rejectMessage(
  operationId: OperationId,
  code: RejectCode,
  details: RejectDetails,
): OperationRejectedMessage {
  return { type: 'operationRejected', operationId, code, details };
}
