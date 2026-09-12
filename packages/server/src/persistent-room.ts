// 永続化 Room（DD-014・CG-3）。純粋な Room/Sequencer（同期・トランスポート非依存）に **durable 境界** と
// **snapshot 生成/再起動復旧** を合成する。DD-013（同期）と描画・IME には触れない。
//
// durable ACK 契約（要確認②確定）: submitOperation が accepted のとき、**oplog append（fsync）完了後に** ACK/broadcast を
//   dispatch する（＝「ACK 受領＝再起動後も失われない」）。submit 自体（revision 割当）は同期ゆえ順序は到着順で確定する。
// 再起動復旧（要確認④）: 最新 snapshot（document@R）を読み、oplog の tail（revision>R）だけ replay ＝ O(tail)。
//   snapshot 無しは oplog 全 replay（DD-006 の 14分経路・snapshot が無い縮退時のみ）。
// snapshot 生成（要確認③）: 前回から N=1,000 accepted op ごとに非同期生成。保持 K=2 世代。log 切詰めなし（正本保全）。

import { replayAcceptedOperations, serializeDocument } from '@nanairo-sheet/core';
import type {
  ClientMessageExceptJoin,
  ServerOperationEnvelope,
  SheetDocument,
} from '@nanairo-sheet/core';
import type { ColumnId } from '@nanairo-sheet/types';

import type { Clock } from './deps';
import type { OpLogStore } from './oplog-store';
import type { DurableBoundary, Outbound, Room } from './room';
import { Sequencer, freshSequencerState } from './sequencer';
import type { SequencerState } from './sequencer';
import { SNAPSHOT_VERSION, serializeSnapshot, deserializeSnapshot } from './snapshot';
import type { SnapshotData } from './snapshot';
import { createPersistedSnapshot } from './snapshot-store';
import type { SnapshotStore } from './snapshot-store';

/**
 * durable frontier（fsync 完了済み最大 revision）とその文書を保持する可変ホルダー（DD-014-1 P1-3/P1-4）。
 * Room は DurableBoundary として読取（join/catch-up を frontier 以下に制限）、PersistentRoom は append 解決時に advance する。
 * 文書は COW（applyOperation が新インスタンスを返す）ゆえ frontier 時点の参照を保持すれば以降の op で不変。
 */
class DurableFrontier implements DurableBoundary {
  constructor(
    private revision: number,
    private document: SheetDocument,
    private clientSequenceTable: ReadonlyMap<string, number>,
  ) {}

  frontierRevision(): number {
    return this.revision;
  }

  frontierDocument(): SheetDocument {
    return this.document;
  }

  /** frontier 時点の clientSequenceTable（durable snapshot 用・P1-C: live 表〔未 durable op を含む〕を混ぜない）。 */
  frontierClientSequenceTable(): ReadonlyMap<string, number> {
    return this.clientSequenceTable;
  }

  /**
   * append（fsync）解決後に呼ぶ。単調前進のみ（append は FIFO ゆえ通常昇順・順不同でも guard で安全）。
   * document・clientSequenceTable は submit 直後（revision R 確定時点・COW/コピー済み）に捕捉した値を渡す
   * （await 中に別 submit が live 表を前進させても frontier は R 時点のまま＝未 durable を漏らさない・P1-C）。
   */
  advance(revision: number, document: SheetDocument, clientSequenceTable: ReadonlyMap<string, number>): void {
    if (revision > this.revision) {
      this.revision = revision;
      this.document = document;
      this.clientSequenceTable = clientSequenceTable;
    }
  }
}

/** 再起動復旧の内訳（Evidence・性能測定用）。 */
export interface RecoveryReport {
  fromSnapshotRevision: number | undefined; // snapshot を使えば R、無ければ undefined（全 replay）
  totalOps: number; // oplog 全 operation 数（= 最終 revision N）
  tailReplayed: number; // 実際に replay した tail op 数（O(tail)。snapshot 無し時は N）
  discardedTornRecords: number; // 末尾 torn write の破棄件数
}

export interface RecoveryResult {
  state: SequencerState;
  report: RecoveryReport;
}

/**
 * snapshot＋oplog から Sequencer 状態を復元する（再起動復旧・§8「snapshotベース初期化」回収）。
 * - snapshot 有: document@R を起点に oplog tail（revision>R）のみ replay（O(tail)・14分経路を排除）。
 * - snapshot 無: oplog を空文書から全 replay（縮退・snapshot 生成前のみ）。
 * - fail-fast（AC6）: oplog の revision 連番違反・snapshot が oplog より先（R>N）・snapshot 参照 op 欠落を throw。
 * - fail-fast（DD-018-1 AC1/AC3）: 要求 documentId と persisted 側 documentId の不一致（別 ID で使用済み persistenceDir を
 *   再利用＝誤公開）・封筒 revision と内側 snapshot revision の相互不一致（改竄/bit-rot）を throw。
 */
export async function recoverSequencerState(opts: {
  oplog: OpLogStore;
  snapshotStore: SnapshotStore;
  columnOrder: ColumnId[];
  /** 要求 documentId。persisted 側（snapshot 優先・無ければ oplog 先頭 entry）と不一致なら fail-fast（DD-018-1 AC1）。 */
  documentId: string;
}): Promise<RecoveryResult> {
  const persisted = await opts.snapshotStore.loadLatest(); // 破損なら throw（fail-fast）
  const { entries, discardedTornRecords } = await opts.oplog.readAll();

  // documentId 相互検証（DD-018-1 AC1・§6 version-mismatch 哲学）: 使用済み persistenceDir を別 documentId で
  // 起動すると旧文書を新 ID として誤公開し得る。**snapshot・全 oplog entry の documentId を要求 documentId と照合**する
  // （Codex P1: snapshot と oplog tail に別 ID が混在した残骸〔旧版の別 ID 起動由来〕でも先頭以降の別 ID を見逃さない）。
  // 空 dir（persisted 無し・oplog 空）は fresh 起動ゆえ照合対象なし（過剰拒否しない）。
  if (persisted !== undefined && persisted.documentId !== opts.documentId) {
    throw new Error(
      `recoverSequencerState: snapshot documentId 不一致（persisted='${persisted.documentId}' requested='${opts.documentId}'）` +
        `。使用済み persistenceDir を別 documentId で再利用した可能性＝旧文書の誤公開を防ぐため起動を拒否`,
    );
  }

  // oplog は accepted のみ・revision 消費ゆえ 1..N 連番でなければ破損（fail-fast・AC6）。同ループで全 entry の
  // documentId も照合する（O(N) は既存の連番検査と同一走査＝追加コスト無し）。
  entries.forEach((entry, index) => {
    if (entry.revision !== index + 1) {
      throw new Error(
        `recoverSequencerState: oplog revision 不連続（index ${index} で revision ${entry.revision}・破損）`,
      );
    }
    if (String(entry.documentId) !== opts.documentId) {
      throw new Error(
        `recoverSequencerState: oplog entry documentId 不一致（index ${index} entry='${String(entry.documentId)}' ` +
          `requested='${opts.documentId}'）＝別文書の operation を混入したまま復元しない（誤公開防止）`,
      );
    }
  });
  const totalOps = entries.length;

  if (persisted === undefined) {
    // snapshot 無し: 空文書から全 replay（縮退経路）。in-place batch replay で op ごとの full clone を避ける（O(N²) 回避）。
    const state = freshSequencerState(opts.columnOrder);
    state.document = replayAcceptedOperations(state.document, entries);
    updateAuxFromOps(state, entries);
    state.currentRevision = totalOps;
    state.operationLog = [...entries];
    return {
      state,
      report: { fromSnapshotRevision: undefined, totalOps, tailReplayed: totalOps, discardedTornRecords },
    };
  }

  // 封筒 revision 相互一致検査（DD-018-1 AC3）: 封筒 revision＝内側 snapshot.currentRevision＝snapshot.document.revision の
  // 三者一致を検査する。書込時は三者とも state.currentRevision で一致するため、乖離は改竄/bit-rot＝黙って誤 revision で
  // 復元し tail slice を誤らせない（checksum を通り抜ける論理不整合を追加で塞ぐ）。
  const innerRevision = persisted.snapshot.currentRevision;
  const documentRevision = persisted.snapshot.document.revision;
  if (persisted.revision !== innerRevision || innerRevision !== documentRevision) {
    throw new Error(
      `recoverSequencerState: 封筒 revision ${persisted.revision} と内側 snapshot.currentRevision ${innerRevision}` +
        `/document.revision ${documentRevision} が不一致（破損・論理不整合）`,
    );
  }
  const base = deserializeSnapshot(persisted.snapshot); // document@R・aux@R（operationLog は空・owned＝破壊可）
  const snapshotRevision = persisted.revision;
  if (snapshotRevision > totalOps) {
    throw new Error(
      `recoverSequencerState: snapshot revision ${snapshotRevision} が oplog 長 ${totalOps} を超過（破損・snapshot が log より先）`,
    );
  }
  // document@R を起点に tail（revision>R）だけ **in-place** replay（clone 1 回＝O(tail)・14分経路排除・AC4/AC5）。
  // log 全体は catch-up 供給のため in-memory へ復元する。
  const tail = entries.slice(snapshotRevision); // revision R+1..N
  const document = replayAcceptedOperations(base.document, tail);
  updateAuxFromOps(base, tail);
  const state: SequencerState = {
    document,
    operationLog: [...entries],
    currentRevision: totalOps,
    ackCache: base.ackCache,
    clientSequenceTable: base.clientSequenceTable,
  };
  return {
    state,
    report: {
      fromSnapshotRevision: snapshotRevision,
      totalOps,
      tailReplayed: tail.length,
      discardedTornRecords,
    },
  };
}

/** accepted op 列から ackCache/clientSequenceTable を前進させる（document は replayAcceptedOperations が担当）。 */
function updateAuxFromOps(
  target: Pick<SequencerState, 'ackCache' | 'clientSequenceTable'>,
  ops: readonly ServerOperationEnvelope[],
): void {
  for (const env of ops) {
    target.ackCache.set(env.operationId, env.revision);
    target.clientSequenceTable.set(env.clientId, env.clientSequence);
  }
}

/** 復元済み Sequencer を作るヘルパー（app 層が Room 構築に使う）。 */
export function createRecoveredSequencer(state: SequencerState, clock: Clock): Sequencer {
  return new Sequencer(state, clock);
}

export interface PersistentRoomOptions {
  documentId: string;
  snapshotIntervalOps?: number | undefined; // 既定 1,000（要確認③）
}

const DEFAULT_SNAPSHOT_INTERVAL = 1_000;

/**
 * Room に durable ACK 境界と snapshot 生成を合成する。RoomBridge（transport）は本クラスを Room と同じ形で駆動できる
 * （handleJoin/handleDisconnect/sweep/activeConnectionIds は同期委譲、handleMessage は submit のみ durable のため Promise）。
 */
export class PersistentRoom {
  private readonly snapshotIntervalOps: number;
  private opsSinceSnapshot = 0;
  private snapshotInProgress = false;
  private lastSnapshotError: unknown;
  private readonly frontier: DurableFrontier;
  private poisoned = false; // append 失敗後は write を全停止（欠番防止・P1-5）

  constructor(
    private readonly room: Room,
    private readonly sequencer: Sequencer,
    private readonly oplog: OpLogStore,
    private readonly snapshotStore: SnapshotStore,
    private readonly clock: Clock,
    private readonly options: PersistentRoomOptions,
  ) {
    this.snapshotIntervalOps = options.snapshotIntervalOps ?? DEFAULT_SNAPSHOT_INTERVAL;
    // 構築時点の Sequencer 状態（recovery/seed 済み＝全て durable）を frontier の初期値にする。
    this.frontier = new DurableFrontier(
      sequencer.currentRevision,
      sequencer.document,
      new Map(sequencer.clientSequenceTable),
    );
    room.attachDurableBoundary(this.frontier); // 以降 Room の join/catch-up/welcome は frontier 以下に限定
  }

  handleJoin(join: Parameters<Room['handleJoin']>[0]): ReturnType<Room['handleJoin']> {
    return this.room.handleJoin(join);
  }

  /** append 失敗で room が poisoned（write 停止）か。運用監視・テスト用。 */
  get isPoisoned(): boolean {
    return this.poisoned;
  }

  /**
   * submit のみ durable 境界を挟む（oplog append=fsync 完了後に ACK/broadcast を返す）。それ以外は同期委譲。
   * 返り値の dispatch（RoomBridge 側）は Promise 解決後＝durable 化後に行われる。
   */
  async handleMessage(connectionId: string, message: ClientMessageExceptJoin): Promise<Outbound[]> {
    if (message.type !== 'submitOperation') {
      return this.room.handleMessage(connectionId, message);
    }
    // poisoning（P1-5）: 直前の append 失敗で room の durable 一貫性が壊れている。新規 write は全て拒否し、
    // Sequencer をこれ以上前進させない（revision 欠番＝oplog に穴、を作らない）。RoomBridge が接続を閉じる。
    if (this.poisoned) {
      throw new Error('PersistentRoom: poisoned（直前の durable 書込失敗により write 停止中）');
    }
    const revisionBefore = this.sequencer.currentRevision;
    // submit（revision 割当・ログ in-memory 追記）は同期。ここまでで順序が確定する。
    const outbound = this.room.handleMessage(connectionId, message);
    const accepted = this.sequencer.operationsSince(revisionBefore); // 新規 accepted（0 or 1 件）
    if (accepted.length > 0) {
      // append 前に「この op を durable 化したら frontier はどこか」を submit 直後（revision R 確定時点）に捕捉する。
      // document は COW ゆえ不変・clientSequenceTable は R 時点をコピー（await 中に別 submit が live 表を前進させても
      // frontier は R のまま＝未 durable の clientSequence を漏らさない・P1-C）。
      const revision = this.sequencer.currentRevision;
      const document = this.sequencer.document;
      const clientSequenceTable = new Map(this.sequencer.clientSequenceTable);
      try {
        await this.oplog.append(accepted); // ★ durable 境界（fsync）。解決後に ACK/broadcast を dispatch。
      } catch (error) {
        this.poisoned = true; // 以降の submit は上の poisoned チェックで reject（fail-stop・欠番0）
        throw error;
      }
      // P1-A: await 中に別の in-flight append が失敗して room を poison した可能性を再確認する。
      // 失敗が先行していれば frontier を前進させず ACK/broadcast も出さない（欠番・偽 durable ACK を防ぐ）。
      // oplog は先行失敗後に fail-stop するため本 append 自体が reject される経路が主だが、二重の防御として保持する。
      if (this.poisoned) {
        throw new Error('PersistentRoom: poisoned（在庫中の durable 書込が失敗したため本 op も破棄）');
      }
      this.frontier.advance(revision, document, clientSequenceTable); // durable 化完了 → 配布境界を前進
      this.opsSinceSnapshot += accepted.length;
      this.maybeSnapshot();
    }
    return outbound;
  }

  handleDisconnect(connectionId: string): Outbound[] {
    return this.room.handleDisconnect(connectionId);
  }

  sweep(): Outbound[] {
    return this.room.sweep();
  }

  activeConnectionIds(): readonly string[] {
    return this.room.activeConnectionIds();
  }

  exportState(): SequencerState {
    return this.room.exportState();
  }

  /** 直近の非同期 snapshot 生成で発生したエラー（あれば）。運用監視用。 */
  get snapshotError(): unknown {
    return this.lastSnapshotError;
  }

  /**
   * N op ごとに非同期 snapshot 生成をトリガーする（P1-4 barrier・P2-5 再判定）。
   * - **barrier（P1-4）**: snapshot は durable frontier == currentRevision の**完全 durable 状態**からのみ生成する。
   *   in-flight append で currentRevision が frontier を超えている間は延期する（snapshot.revision > durable oplog 長＝
   *   再起動 fail-fast を構造的に防ぐ）。延期は opsSinceSnapshot を保持したまま return し、次の append 解決後に再評価する。
   * - **P2-5**: 生成完了時に蓄積分（write 中に到着した op）を再評価し、閾値超過なら続けて生成する（tail 肥大を防ぐ）。
   */
  private maybeSnapshot(): void {
    if (this.snapshotInProgress || this.opsSinceSnapshot < this.snapshotIntervalOps) {
      return;
    }
    // barrier: 完全 durable 状態（frontier == currentRevision）でのみ snapshot を取る。in-flight があれば延期。
    if (this.frontier.frontierRevision() !== this.sequencer.currentRevision) {
      return; // opsSinceSnapshot は据え置き＝次の append 解決後に再評価される（取り漏らし無し）
    }
    this.opsSinceSnapshot = 0;
    this.snapshotInProgress = true;
    // exportState は同期＝生成時点の一貫した状態（frontier==current ゆえ全て durable・snapshot<=frontier を満たす）。
    const state = this.sequencer.exportState();
    const revision = state.currentRevision;
    void this.writeSnapshot(state, revision)
      .catch((error: unknown) => {
        this.lastSnapshotError = error; // snapshot は最適化物＝生成失敗でも oplog（正本）は無傷。ACK は既に durable。
      })
      .finally(() => {
        this.snapshotInProgress = false;
        this.maybeSnapshot(); // P2-5: write 中に蓄積した分を再判定（閾値未満なら即 return）
      });
  }

  /**
   * durable frontier 以下に制限した snapshot を返す（`/snapshot` エンドポイント・検査用・P1-3）。
   * 未 fsync（frontier 超過）の revision は document・operationLog・currentRevision・ackCache のいずれからも観測させない。
   * frontier == currentRevision（in-flight 無し）のときは通常の serializeSnapshot と一致する。
   */
  durableSnapshot(): SnapshotData {
    const R = this.frontier.frontierRevision();
    const state = this.sequencer.exportState();
    return {
      version: SNAPSHOT_VERSION,
      document: serializeDocument(this.frontier.frontierDocument()),
      operationLog: state.operationLog.filter((e) => e.revision <= R),
      currentRevision: R,
      // ackCache（値=revision）は revision≦R で gate。clientSequenceTable（値=clientSequence）は R で gate できないため
      // frontier 時点のコピーを使う（未 durable op〔R+1〕の clientSequence を漏らさない・P1-C: 復元後の retry 誤 reject を防ぐ）。
      ackCache: [...state.ackCache]
        .filter(([, revision]) => revision <= R)
        .map(([operationId, revision]) => ({ operationId, revision })),
      clientSequenceTable: [...this.frontier.frontierClientSequenceTable()].map(([clientId, lastSequence]) => ({
        clientId,
        lastSequence,
      })),
    };
  }

  private async writeSnapshot(state: SequencerState, revision: number): Promise<void> {
    const data = serializeSnapshot(state);
    const persisted = createPersistedSnapshot({
      documentId: this.options.documentId,
      revision,
      createdAt: new Date(this.clock.now()).toISOString(),
      // persisted snapshot は operationLog を埋め込まない（log は oplog が正本・O(document) サイズ・write amplification 回避）。
      snapshot: { ...data, operationLog: [] },
    });
    await this.snapshotStore.save(persisted);
  }

  /** 保留中の durable 書込を確定してから閉じる（graceful shutdown）。 */
  async close(): Promise<void> {
    await this.oplog.close();
    await this.snapshotStore.close();
  }

  /** テスト用: 手動 snapshot 生成（生成トリガーを待たずに現在状態を永続化する）。 */
  async forceSnapshot(): Promise<void> {
    const state = this.sequencer.exportState();
    await this.writeSnapshot(state, state.currentRevision);
    this.opsSinceSnapshot = 0;
  }
}
