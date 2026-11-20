// 文書の JSON セーフな直列化/復元（DD-014-1・CG-3）。サーバー snapshot（server/snapshot.ts）と
// クライアント snapshot bootstrap（collab/session.ts の join 応答 `bootstrap` メッセージ）が **同一の wire 形式**
// を共有するため core が所有する（両端の実装乖離＝hash 非決定化を構造的に防ぐ・CG-2/DD-013 の収束テスト維持）。
//
// SheetDocument の Map/二段 CellStore を JSON セーフな配列へ変換する（Presence・operationLog は含まない＝純粋な文書）。
// 復元時は slot の健全性（非負整数・一意）と参照整合（rowMeta に無い行・columnOrder 外の列）を fail-fast で検証する
// （DD-010 Codex[P2] の安定 ID 破損検知を継承）。

import { createCellStore } from './cell-store';
import {
  cloneCellScalar,
  computeMaxSlot,
  createDocument,
  forEachCellInRow,
} from './document';
import type { RowMeta, SheetDocument } from './document';
import type { CellScalar } from './operations';

import { createColumnId, createRowId } from '@nanairo-sheet/types';
import type { ColumnId, RowId } from '@nanairo-sheet/types';

interface SerializedRowMeta {
  id: string;
  slot: number;
  tombstone: boolean;
  lastChangedRevision: number;
}
interface SerializedRowCells {
  rowId: string;
  columns: Array<{ columnId: string; value: CellScalar; lastChangedRevision: number }>;
}

/**
 * JSON セーフな文書スナップショット（Map→配列・cells→行×列配列）。wire 契約ゆえ形は不変に保つ。
 * `bootstrap` メッセージ（server→client join 応答）と server の persisted snapshot document 部が共有する。
 */
export interface DocumentSnapshot {
  revision: number;
  rowOrder: string[];
  rowMeta: SerializedRowMeta[];
  columnOrder: string[];
  cells: SerializedRowCells[];
}

/** SheetDocument を JSON セーフな DocumentSnapshot へ直列化する（非空セルを持つ行のみ cells に載せる）。 */
export function serializeDocument(doc: SheetDocument): DocumentSnapshot {
  const rowMeta: SerializedRowMeta[] = [];
  for (const meta of doc.rowMeta.values()) {
    rowMeta.push({
      id: meta.id,
      slot: meta.slot,
      tombstone: meta.tombstone,
      lastChangedRevision: meta.lastChangedRevision,
    });
  }
  // 全行（tombstone 含む）を rowMeta 順に走査し、非空セルを持つ行だけを直列化する（slot キー CellStore を
  // rowId で読み直す）。列は colIndex 昇順。tombstone 行のセルも保全される（round-trip 一致）。
  const cells: SerializedRowCells[] = [];
  for (const rowId of doc.rowMeta.keys()) {
    const columns: SerializedRowCells['columns'] = [];
    forEachCellInRow(doc, rowId, (columnId, record) => {
      // 値は写す（文書のレコードは適用の前後の文書で共有する・DD-070-10。スナップショットを書き換えても文書を変えない）。
      columns.push({
        columnId,
        value: cloneCellScalar(record.value),
        lastChangedRevision: record.lastChangedRevision,
      });
    });
    if (columns.length > 0) {
      cells.push({ rowId, columns });
    }
  }
  return {
    revision: doc.revision,
    rowOrder: [...doc.rowOrder],
    rowMeta,
    columnOrder: [...doc.columnOrder],
    cells,
  };
}

/** DocumentSnapshot を SheetDocument へ復元する（slot 健全性・参照整合を fail-fast 検証）。 */
export function deserializeDocument(data: DocumentSnapshot): SheetDocument {
  // rowMeta を構築しつつ slot の健全性を検証する（DD-010 Codex[P2]・安定 ID 復元の fail-fast）:
  // slot は非負整数・**一意**であること（重複 slot は複数 RowId が同一物理行を共有＝サイレント上書き経路）。
  const rowMeta = new Map<RowId, RowMeta>();
  const seenSlots = new Set<number>();
  for (const meta of data.rowMeta) {
    if (!Number.isInteger(meta.slot) || meta.slot < 0) {
      throw new Error(`deserializeDocument: 不正な slot ${String(meta.slot)}（行 ${meta.id}）`);
    }
    if (seenSlots.has(meta.slot)) {
      throw new Error(`deserializeDocument: slot ${meta.slot} が重複（安定 ID 破損・行 ${meta.id}）`);
    }
    seenSlots.add(meta.slot);
    const id = createRowId(meta.id);
    rowMeta.set(id, {
      id,
      slot: meta.slot,
      tombstone: meta.tombstone,
      lastChangedRevision: meta.lastChangedRevision,
    });
  }
  // ColumnId→colIndex は columnOrder、RowId→slot は rowMeta で解決して安定 slot キー CellStore へ復元する。
  // 解決不能なセル参照（rowMeta に無い行・columnOrder 外の列）は黙って捨てず fail-fast（データ欠落を検知）。
  const columnOrder: ColumnId[] = data.columnOrder.map((c) => createColumnId(c));
  const colIndexById = new Map<string, number>();
  columnOrder.forEach((columnId, index) => colIndexById.set(String(columnId), index));
  const cells = createCellStore();
  for (const rowCells of data.cells) {
    const slot = rowMeta.get(createRowId(rowCells.rowId))?.slot;
    if (slot === undefined) {
      throw new Error(`deserializeDocument: rowMeta に無い行 ${rowCells.rowId} のセル（安定 ID 破損）`);
    }
    for (const cell of rowCells.columns) {
      const colIndex = colIndexById.get(cell.columnId);
      if (colIndex === undefined) {
        throw new Error(
          `deserializeDocument: columnOrder 外の列 ${cell.columnId}（行 ${rowCells.rowId}・安定 ID 破損）`,
        );
      }
      cells.set(slot, colIndex, {
        value: cloneCellScalar(cell.value), // 受け取ったスナップショットと値を共有しない（DD-070-10）
        lastChangedRevision: cell.lastChangedRevision,
      });
    }
  }
  const doc: SheetDocument = createDocument(columnOrder);
  doc.revision = data.revision;
  doc.rowOrder = data.rowOrder.map((r) => createRowId(r));
  doc.rowMeta = rowMeta;
  doc.cells = cells;
  // maxSlot は rowMeta の最大 slot から再計算する（wire には持たない導出値・DD-021-3 P2-1）。
  // 永続化される文書（server committed・client bootstrap）は rollback 由来の ghost slot を含まないため、
  // max(現 slot) が採番カーソルと厳密一致する（決定論を保つ）。
  doc.maxSlot = computeMaxSlot(rowMeta);
  return doc;
}
