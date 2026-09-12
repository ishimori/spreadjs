// snapshot＋Operation ログの JSON エクスポート/インポート（サーバー再起動模擬・S-K1〜K4）。
// エクスポート内容は {document(正準構造), operationLog, currentRevision, ackCache, clientSequenceTable} を全部含める
// （指示 5）。no-op の ACK はログから再構築できないため ackCache の明示エクスポートが必須（DA D17）。
// Presence は非永続（§9）ゆえ含めない。SheetDocument の Map/二段 Map は JSON セーフな配列へ変換する。

import {
  applyOperation,
  createDocument,
  deserializeDocument,
  documentHash,
  serializeDocument,
} from '@nanairo-sheet/core';
import type {
  DocumentSnapshot,
  ServerOperationEnvelope,
  SheetDocument,
} from '@nanairo-sheet/core';
import { createColumnId, createOperationId } from '@nanairo-sheet/types';
import type { ColumnId } from '@nanairo-sheet/types';

import type { SequencerState } from './sequencer';

// 文書の直列化/復元は core（document-snapshot.ts）が正本（bootstrap メッセージと wire 形式を共有・DD-014-1）。
// 旧 SerializedDocument は DocumentSnapshot の別名として残す（既存 import の後方互換）。
export type SerializedDocument = DocumentSnapshot;

/**
 * SnapshotData の版数。DD-010（安定 slot キー CellStore・CG-2）で 2 に更新。
 * DD-012-1 で CellScalar へ date wire variant を追加したため 3 に更新した（Codex P2）:
 * date 分岐を持たない旧 deserialize が date snapshot を復元すると cloneCellScalar が undefined 化/例外に
 * なりうるため、cross-version は fail-fast させる（version 不一致 throw）。
 * PoC 形式で永続データは実在しない（互換層・migration なし）。正式 versioned snapshot・tail replay は DD-014 スコープ。
 */
export const SNAPSHOT_VERSION = 3 as const;

/** JSON セーフなスナップショット表現（Map→配列・cells→行×列配列。SerializedDocument の wire 形は不変）。 */
export interface SnapshotData {
  version: typeof SNAPSHOT_VERSION;
  document: SerializedDocument;
  operationLog: ServerOperationEnvelope[]; // 平坦オブジェクト（RowId 等は実行時 string）でそのまま JSON セーフ
  currentRevision: number;
  ackCache: Array<{ operationId: string; revision: number }>;
  clientSequenceTable: Array<{ clientId: string; lastSequence: number }>;
}

/** Sequencer 状態を JSON セーフな SnapshotData へ直列化する。 */
export function serializeSnapshot(state: SequencerState): SnapshotData {
  return {
    version: SNAPSHOT_VERSION,
    document: serializeDocument(state.document),
    operationLog: [...state.operationLog],
    currentRevision: state.currentRevision,
    ackCache: [...state.ackCache].map(([operationId, revision]) => ({ operationId, revision })),
    clientSequenceTable: [...state.clientSequenceTable].map(([clientId, lastSequence]) => ({
      clientId,
      lastSequence,
    })),
  };
}

/** SnapshotData を Sequencer 復元入力（SequencerState）へ復元する（S-K2）。revision も復元し継続する（S-K4）。 */
export function deserializeSnapshot(data: SnapshotData): SequencerState {
  if (data.version !== SNAPSHOT_VERSION) {
    // 互換層・migration は作らない（PoC 形式・永続データ非実在）。不一致は fail-fast（ADR-0015・要確認2）。
    throw new Error(
      `deserializeSnapshot: 非対応の snapshot version ${String(data.version)}（対応=${SNAPSHOT_VERSION}）`,
    );
  }
  const ackCache = new Map<ReturnType<typeof createOperationId>, number>();
  for (const entry of data.ackCache) {
    ackCache.set(createOperationId(entry.operationId), entry.revision);
  }
  const clientSequenceTable = new Map<string, number>();
  for (const entry of data.clientSequenceTable) {
    clientSequenceTable.set(entry.clientId, entry.lastSequence);
  }
  return {
    document: deserializeDocument(data.document),
    operationLog: [...data.operationLog],
    currentRevision: data.currentRevision,
    ackCache,
    clientSequenceTable,
  };
}

/**
 * 整合検証: 復元 document とログ replay の整合を多面で確認する（S-K1/K2・DA D7・Codex [P2]）。
 * - **content hash 一致**: 復元 document の hash == ログを空文書から replay した文書の hash（no-op はログ非追記＝replay 不変）。
 * - **構造一致**: rowOrder（tombstone 含む）・各行 tombstone・revision が復元と replay で一致（hash 盲点＝空行/tombstone
 *   のみの破損を検知・D12）。
 * - **revision 整合**: ログ revision が 1..N 連番（`log[i].revision===i+1`）・`currentRevision===ログ長`・
 *   `document.revision===currentRevision`。改竄された currentRevision（飛び番）を検知し、復元後の飛び番 revision で
 *   クライアントが欠落 revision を永久に待つ事故を防ぐ。
 */
export function verifySnapshotIntegrity(data: SnapshotData): {
  ok: boolean;
  documentHash: string;
  replayHash: string;
} {
  const restored = deserializeDocument(data.document);
  const columnOrder: ColumnId[] = data.document.columnOrder.map((c) => createColumnId(c));
  let replay: SheetDocument = createDocument(columnOrder);
  for (const envelope of data.operationLog) {
    replay = applyOperation(replay, envelope.operation, { revision: envelope.revision }).document;
  }
  const documentHashValue = documentHash(restored);
  const replayHashValue = documentHash(replay);

  // revision 整合: ログは accepted のみ・revision 消費ゆえ連番 1..N かつ currentRevision===N===document.revision。
  const logContiguous = data.operationLog.every((envelope, index) => envelope.revision === index + 1);
  const revisionConsistent =
    data.currentRevision === data.operationLog.length && data.document.revision === data.currentRevision;
  // 構造一致（tombstone/空行の hash 盲点対策）: rowOrder と各行 tombstone・revision を比較。
  const structureConsistent = structuralMatch(restored, replay);

  return {
    ok: documentHashValue === replayHashValue && logContiguous && revisionConsistent && structureConsistent,
    documentHash: documentHashValue,
    replayHash: replayHashValue,
  };
}

/** rowOrder（tombstone 含む）・各行 tombstone・revision の構造一致（hash 非依存・空行/tombstone 破損を検知）。 */
function structuralMatch(a: SheetDocument, b: SheetDocument): boolean {
  if (a.revision !== b.revision) {
    return false;
  }
  if (a.rowOrder.length !== b.rowOrder.length) {
    return false;
  }
  for (const [i, rowId] of a.rowOrder.entries()) {
    const otherRowId = b.rowOrder[i]; // 長さは上で一致を確認済み（undefined は検証関数として不一致に倒す）
    if (otherRowId === undefined || String(rowId) !== String(otherRowId)) {
      return false;
    }
    if ((a.rowMeta.get(rowId)?.tombstone ?? true) !== (b.rowMeta.get(otherRowId)?.tombstone ?? true)) {
      return false;
    }
  }
  return true;
}
