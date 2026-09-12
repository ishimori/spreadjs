// remote-change（DD-049 H4）: サーバー確定（受理済み）op → 公開 GridRemoteChange の写像（純関数・DOM 非依存）。
//
// ClientSession.onCommittedOperation（committed へ入った受理済み op）を受け、SetCells だけを cell-commit と同じ
// 表示文字列の前後値へ写す。起点は envelope.clientId で判定する（自分＝local／サーバー起点の予約 clientId＝server／他＝remote）。
// 内部の ServerOperationEnvelope・ChangeSet・CellScalar は公開型へ出さない（R7）。

import type { CellScalar, ChangeSet, ServerOperationEnvelope } from '@nanairo-sheet/core';

import { cellScalarToDisplay } from './document-view';
import type { GridCellCommitChange, GridRemoteChange, GridRemoteChangeOrigin } from './index';

/**
 * サーバー起点操作（`ServerInstance.submit`）の予約 clientId。server-hono の `SERVER_CLIENT_ID`（DD-026-3）と同値で、
 * クライアントはこの clientId で join できない（サーバーが 1008 で拒否する）ため、他クライアントの op と取り違えない。
 */
export const SERVER_ORIGIN_CLIENT_ID = 'server';

/** envelope の clientId から remote-change の起点を決める（自分の clientId を最優先）。 */
export function remoteChangeOrigin(clientId: string, ownClientId: string): GridRemoteChangeOrigin {
  if (clientId === ownClientId) {
    return 'local';
  }
  if (clientId === SERVER_ORIGIN_CLIENT_ID) {
    return 'server';
  }
  return 'remote';
}

/**
 * committed へ入った受理済み op を公開 GridRemoteChange へ写す。SetCells 以外（InsertRows/DeleteRows）は対象外で undefined。
 * 前後値は committed への適用 ChangeSet（changes 順・同一 op 内の同一セル複数書込は逐次）から表示文字列へ変換する。
 */
export function toGridRemoteChange(
  envelope: ServerOperationEnvelope,
  changeSet: ChangeSet,
  ownClientId: string,
): GridRemoteChange | undefined {
  if (envelope.operation.type !== 'setCells') {
    return undefined;
  }
  const changes: GridCellCommitChange[] = changeSet.cells.map((cell) => ({
    rowId: String(cell.rowId),
    columnId: String(cell.columnId),
    value: displayOf(cell.after),
    previousValue: displayOf(cell.before),
  }));
  return {
    origin: remoteChangeOrigin(envelope.clientId, ownClientId),
    revision: envelope.revision,
    actorId: envelope.actorId,
    changes,
  };
}

/** CellScalar | undefined を表示文字列へ（undefined=未書込セル=空・cell-commit と同じ変換）。 */
function displayOf(value: CellScalar | undefined): string {
  return value === undefined ? '' : cellScalarToDisplay(value);
}
