// serve() の公開型 ⇄ 内部型の変換と、consumer 注入ストア／初期文書の adapter（DD-026-1〜3・内部 glue・公開面ではない）。
// 公開→内部は brand ファクトリ（createRowId 等）で組み直す（ダブルキャスト不使用・coding-standards P19）。
// 内部→公開は構造的に代入可能（brand 付き string → string・readonly 化）ゆえ変換不要。

import { applyOperation, createDocument } from '@nanairo-sheet/core';
import type {
  CellScalar,
  DocumentOperation,
  ServerOperationEnvelope,
  SetCellsChange,
  SetCellsOperation,
  SheetDocument,
} from '@nanairo-sheet/core';
import { parsePersistedSnapshot } from '@nanairo-sheet/server';
import type { OpLogStore, SnapshotStore } from '@nanairo-sheet/server';
import {
  createColumnId,
  createDocumentId,
  createOperationId,
  createRowId,
  createTransactionId,
} from '@nanairo-sheet/types';
import type { ColumnId } from '@nanairo-sheet/types';

import type {
  ServeCellScalar,
  ServeDocumentOperation,
  ServeInitialDocument,
  ServeOpLogStore,
  ServeOperationEnvelope,
  ServeSetCellsChange,
  ServeSetCellsInput,
  ServeSnapshotStore,
} from './serve-types';

/** consumer の oplog ストアを内部 OpLogStore へ包む（readAll の公開 envelope を brand 付き内部形へ持ち上げる）。 */
export function adaptOpLogStore(store: ServeOpLogStore): OpLogStore {
  return {
    append: (entries) => store.append(entries),
    readAll: async () => {
      const result = await store.readAll();
      return {
        entries: result.entries.map(liftEnvelope),
        discardedTornRecords: result.discardedTornRecords ?? 0,
      };
    },
    close: () => store.close(),
  };
}

/**
 * consumer の snapshot ストアを内部 SnapshotStore へ包む。loadLatest の結果は内部の検証付き parse（format version・
 * checksum）を通す＝保存先の破損・改竄を fail-fast。v2 checksum は正準化済みゆえ jsonb 等でキー順が入れ替わっても一致する。
 */
export function adaptSnapshotStore(store: ServeSnapshotStore): SnapshotStore {
  return {
    save: (persisted) => store.save(persisted),
    loadLatest: async () => {
      const loaded = await store.loadLatest();
      if (loaded === undefined) {
        return undefined;
      }
      return parsePersistedSnapshot(JSON.stringify(loaded));
    },
    close: () => store.close(),
  };
}

/** 公開 envelope（保存先から読んだもの）を内部 ServerOperationEnvelope へ持ち上げる。未知の operation 種別は fail-fast。 */
export function liftEnvelope(envelope: ServeOperationEnvelope): ServerOperationEnvelope {
  return {
    protocolVersion: envelope.protocolVersion,
    documentId: createDocumentId(envelope.documentId),
    operationId: createOperationId(envelope.operationId),
    transactionId: createTransactionId(envelope.transactionId),
    actorId: envelope.actorId,
    clientId: envelope.clientId,
    clientSequence: envelope.clientSequence,
    baseRevision: envelope.baseRevision,
    operation: liftOperation(envelope.operation),
    revision: envelope.revision,
    acceptedAt: envelope.acceptedAt,
    canonicalOperation: liftOperation(envelope.canonicalOperation),
  };
}

export function liftOperation(operation: ServeDocumentOperation): DocumentOperation {
  switch (operation.type) {
    case 'setCells':
      return { type: 'setCells', changes: operation.changes.map(liftSetCellsChange), conflictPolicy: 'reject-overlap' };
    case 'insertRows':
      return {
        type: 'insertRows',
        afterRowId: operation.afterRowId === null ? null : createRowId(operation.afterRowId),
        rows: operation.rows.map((r) => (r.height !== undefined ? { rowId: createRowId(r.rowId), height: r.height } : { rowId: createRowId(r.rowId) })),
      };
    case 'deleteRows':
      return { type: 'deleteRows', rowIds: operation.rowIds.map((r) => createRowId(r)) };
    default:
      return unknownOperation(operation);
  }
}

/** `ServerInstance.submit` 入力を内部 SetCellsOperation へ（conflictPolicy はサーバー付与・DD-026-3）。 */
export function liftSetCellsInput(input: ServeSetCellsInput): SetCellsOperation {
  return { type: 'setCells', changes: input.changes.map(liftSetCellsChange), conflictPolicy: 'reject-overlap' };
}

function liftSetCellsChange(change: ServeSetCellsChange): SetCellsChange {
  return {
    rowId: createRowId(change.rowId),
    columnId: createColumnId(change.columnId),
    ...(change.beforeRevision !== undefined ? { beforeRevision: change.beforeRevision } : {}),
    value: liftCellScalar(change.value),
  };
}

export function liftCellScalar(value: ServeCellScalar): CellScalar {
  switch (value.kind) {
    case 'blank':
      return { kind: 'blank' };
    case 'string':
      return { kind: 'string', value: value.value };
    case 'number':
      return { kind: 'number', value: value.value };
    case 'date':
      return { kind: 'date', value: value.value };
    default:
      return unknownCellScalar(value);
  }
}

/**
 * 初期文書（DD-026-1）を document@0 として組む: revision 0・行/セルの lastChangedRevision 0・oplog には載せない
 * （oplog は consumer の操作だけを記録する＝「操作ログを汚さない」）。行 ID の重複/空・columnOrder 外の列は fail-fast。
 */
export function buildInitialDocument(columnOrder: readonly ColumnId[], input: ServeInitialDocument): SheetDocument {
  const knownColumns = new Set<string>(columnOrder.map((c) => String(c)));
  const seenRows = new Set<string>();
  const changes: SetCellsChange[] = [];
  for (const row of input.rows) {
    if (row.rowId.length === 0) {
      throw new Error('serve: initialDocument の rowId が空です');
    }
    if (seenRows.has(row.rowId)) {
      throw new Error(`serve: initialDocument の rowId が重複しています（${row.rowId}）`);
    }
    seenRows.add(row.rowId);
    for (const [columnId, value] of Object.entries(row.cells ?? {})) {
      if (!knownColumns.has(columnId)) {
        throw new Error(`serve: initialDocument の列 '${columnId}'（行 ${row.rowId}）は columnOrder にありません`);
      }
      changes.push({ rowId: createRowId(row.rowId), columnId: createColumnId(columnId), value: liftCellScalar(value) });
    }
  }
  let document = createDocument([...columnOrder]);
  if (input.rows.length === 0) {
    return document;
  }
  document = applyOperation(
    document,
    { type: 'insertRows', afterRowId: null, rows: input.rows.map((r) => ({ rowId: createRowId(r.rowId) })) },
    { revision: 0 },
  ).document;
  if (changes.length > 0) {
    document = applyOperation(document, { type: 'setCells', conflictPolicy: 'reject-overlap', changes }, { revision: 0 }).document;
  }
  return document;
}

function unknownOperation(operation: never): never {
  throw new Error(`serve: 未知の operation 種別です: ${JSON.stringify(operation)}`);
}

function unknownCellScalar(value: never): never {
  throw new Error(`serve: 未知のセル値 kind です: ${JSON.stringify(value)}`);
}
