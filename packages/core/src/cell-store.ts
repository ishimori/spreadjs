// 安定ID・チャンク化 CellStore（DD-010・CG-2・ADR-0011 A案「slot 間接」）。
//
// 目的: ADR-0011 の chunked-rowslot 構造（チャンク×行スロット×列昇順並列配列）を、行 index キーから
// **安定 slot キー**へ差し替える。slot は RowMeta.slot（§6.3・単調・tombstone でも保持・回収しない）で、
// RowId→slot の解決は document.ts が rowMeta で行う（本ストアは slot: number / colIndex: number の
// 整数キーだけを扱う純データ構造）。列は columnOrder 上の位置 = colIndex（整数）。
//
// これにより InsertRows/DeleteRows でセルデータは物理移動しない（slot 不変）＝index ずれ・サイレント
// 上書きが構造的に起きない（CG-2 の核）。同時に ADR-0011 の実測優位（O(可視セル) 走査・省メモリ・
// 昇順 append ロード）を維持する。DOM/Node 非参照・ランタイム依存ゼロ。
//
// 二段 Map（Map<RowId, Map<ColumnId, CellRecord>>）と論理等価であることは differential test で機械実証する
// （cell-store-differential.test.ts）。二段 Map と違い、行内は colIndex 昇順の並列配列＋二分探索で保持する。

import type { CellRecord } from './document';
import type { CellScalar } from './operations';

/** slot 内の行スロット: colIndex 昇順の並列配列（cols[i] の値が records[i]）。 */
interface RowSlot {
  cols: number[];
  records: CellRecord[];
}

interface Chunk {
  slots: (RowSlot | undefined)[];
}

const DEFAULT_CHUNK_ROWS = 256;
// メモリ概算の係数（レポート用・厳密値ではない）。
const BYTES_PER_COL_ENTRY = 8; // cols:number 1 要素の概算
const BYTES_PER_RECORD_REF = 8; // records[] の参照 1 要素
const BYTES_PER_RECORD_OBJECT = 32; // CellRecord + CellScalar オブジェクトの概算
const BYTES_PER_CHAR = 2; // UTF-16

/** CellScalar を深く複製する（clone() 用・cloneCellScalar と等価。循環 import 回避のため本ファイルに保持）。 */
function cloneScalar(value: CellScalar): CellScalar {
  switch (value.kind) {
    case 'blank':
      return { kind: 'blank' };
    case 'string':
      return { kind: 'string', value: value.value };
    case 'number':
      return { kind: 'number', value: value.value };
    case 'date':
      return { kind: 'date', value: value.value };
  }
}

function cloneRecord(record: CellRecord): CellRecord {
  return { value: cloneScalar(record.value), lastChangedRevision: record.lastChangedRevision };
}

/** cols 昇順配列で target 以上になる最初の位置（lower bound・二分探索）。 */
function lowerBound(cols: readonly number[], target: number): number {
  let lo = 0;
  let hi = cols.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((cols[mid] ?? 0) < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * 安定 slot キー CellStore。document.ts が RowId→slot・ColumnId→colIndex を解決して呼ぶ。
 * - `get`/`set`/`delete` は (slot, colIndex) 整数キー。set は blank レコードも保持する（二段 Map と等価）。
 * - `forEachInRow` は colIndex 昇順で列挙（正準直列化・serialization が Map 反復順に依存しないための決定順）。
 * - `deleteRow` は挿入 rollback（inverseSeed）で行ごと除去する経路。
 * - `clone` は CellRecord/CellScalar まで別オブジェクトへ深く複製する（完全に切り離した複製）。
 * - `fork` はチャンクと行を共有する複製（DD-070-10）。どちらかが書くときに、書くチャンクと行だけを写す
 *   （copy-on-write）。CellRecord/CellScalar は共有するため、get で得たレコードをその場で書き換えないこと
 *   （書き換えは set で差し替える）。費用は O(チャンク数)＝表の大きさに比例しない（256 行で 1 チャンク）。
 */
export interface CellStore {
  get(slot: number, colIndex: number): CellRecord | undefined;
  set(slot: number, colIndex: number, record: CellRecord): void;
  delete(slot: number, colIndex: number): void;
  deleteRow(slot: number): void;
  hasRow(slot: number): boolean;
  forEachInRow(slot: number, visit: (colIndex: number, record: CellRecord) => void): void;
  clone(): CellStore;
  fork(): CellStore;
  /** 保持レコード総数（blank レコードも含む。二段 Map の Σ rowCells.size と一致）。 */
  nonEmptyCount(): number;
  approxMemoryBytes(): number;
}

export interface CellStoreConfig {
  /** 1 チャンクの slot 数（既定 256・§6.4）。 */
  chunkRows?: number;
}

export function createCellStore(config: CellStoreConfig = {}): CellStore {
  const chunkRows = config.chunkRows ?? DEFAULT_CHUNK_ROWS;
  if (!Number.isInteger(chunkRows) || chunkRows <= 0) {
    throw new Error(`chunkRows は正の整数（受領: ${chunkRows}）`);
  }
  return buildCellStore(chunkRows, new Map(), 0, 0);
}

/**
 * `chunks` を土台にストアを組む。`chunks` の Map 自体はこのストアのもの（他と共有しない）だが、中のチャンクと行は
 * fork 元と共有しうる。このストアが書いてよいのは、自分で作った・写したチャンクと行（owned）だけ。
 */
function buildCellStore(
  chunkRows: number,
  chunks: Map<number, Chunk>,
  initialCount: number,
  initialValueChars: number,
): CellStore {
  let count = initialCount;
  let totalValueChars = initialValueChars;
  // 書いてよいチャンク・行。fork のたびに自分の側も空に戻す（それまでのチャンクと行は fork 先と共有になるため）。
  let ownedChunks = new WeakSet<Chunk>();
  let ownedRows = new WeakSet<RowSlot>();

  const locate = (slot: number): { chunkIndex: number; local: number } => {
    if (slot < 0 || !Number.isInteger(slot)) {
      throw new Error(`slot は 0 以上の整数（受領: ${slot}）`);
    }
    const chunkIndex = Math.floor(slot / chunkRows);
    return { chunkIndex, local: slot - chunkIndex * chunkRows };
  };

  const readRow = (slot: number): RowSlot | undefined => {
    const { chunkIndex, local } = locate(slot);
    return chunks.get(chunkIndex)?.slots[local];
  };

  /** 書いてよいチャンク（無ければ作る・共有中なら写して差し替える）。 */
  const writableChunk = (chunkIndex: number): Chunk => {
    const current = chunks.get(chunkIndex);
    if (current !== undefined && ownedChunks.has(current)) {
      return current;
    }
    const chunk: Chunk = { slots: current === undefined ? new Array<RowSlot | undefined>(chunkRows) : current.slots.slice() };
    chunks.set(chunkIndex, chunk);
    ownedChunks.add(chunk);
    return chunk;
  };

  /** 書いてよい行（無ければ作る・共有中なら写して差し替える）。 */
  const writableRow = (slot: number): RowSlot => {
    const { chunkIndex, local } = locate(slot);
    const chunk = writableChunk(chunkIndex);
    const current = chunk.slots[local];
    if (current !== undefined && ownedRows.has(current)) {
      return current;
    }
    const row: RowSlot = current === undefined ? { cols: [], records: [] } : { cols: current.cols.slice(), records: current.records.slice() };
    chunk.slots[local] = row;
    ownedRows.add(row);
    return row;
  };

  const valueChars = (record: CellRecord): number =>
    // string と date（LocalDate 文字列）は UTF-16 文字列領域を持つため文字数を計上する。
    // date を除外すると大量日付セルのメモリを過少評価する（Codex P2）。
    record.value.kind === 'string' || record.value.kind === 'date' ? record.value.value.length : 0;

  const store: CellStore = {
    get(slot, colIndex) {
      if (colIndex < 0) {
        return undefined;
      }
      const row = readRow(slot);
      if (row === undefined) {
        return undefined;
      }
      const idx = lowerBound(row.cols, colIndex);
      if (idx < row.cols.length && row.cols[idx] === colIndex) {
        return row.records[idx];
      }
      return undefined;
    },
    set(slot, colIndex, record) {
      if (colIndex < 0 || !Number.isInteger(colIndex)) {
        throw new Error(`colIndex は 0 以上の整数（受領: ${colIndex}）`);
      }
      const row = writableRow(slot);
      const idx = lowerBound(row.cols, colIndex);
      if (idx < row.cols.length && row.cols[idx] === colIndex) {
        totalValueChars += valueChars(record) - valueChars(row.records[idx]!);
        row.records[idx] = record;
      } else {
        row.cols.splice(idx, 0, colIndex);
        row.records.splice(idx, 0, record);
        totalValueChars += valueChars(record);
        count += 1;
      }
    },
    delete(slot, colIndex) {
      if (colIndex < 0) {
        return;
      }
      const existing = readRow(slot);
      if (existing === undefined) {
        return;
      }
      const idx = lowerBound(existing.cols, colIndex);
      if (idx >= existing.cols.length || existing.cols[idx] !== colIndex) {
        return; // 無いセルの削除は何も写さない
      }
      const row = writableRow(slot);
      totalValueChars -= valueChars(row.records[idx]!);
      row.cols.splice(idx, 1);
      row.records.splice(idx, 1);
      count -= 1;
    },
    deleteRow(slot) {
      const row = readRow(slot);
      if (row === undefined) {
        return;
      }
      for (const record of row.records) {
        totalValueChars -= valueChars(record);
      }
      count -= row.cols.length;
      const { chunkIndex, local } = locate(slot);
      writableChunk(chunkIndex).slots[local] = undefined;
    },
    hasRow(slot) {
      const row = readRow(slot);
      return row !== undefined && row.cols.length > 0;
    },
    forEachInRow(slot, visit) {
      const row = readRow(slot);
      if (row === undefined) {
        return;
      }
      for (let i = 0; i < row.cols.length; i += 1) {
        visit(row.cols[i]!, row.records[i]!);
      }
    },
    clone() {
      const copy = createCellStore({ chunkRows });
      for (const [chunkIndex, chunk] of chunks) {
        for (let local = 0; local < chunk.slots.length; local += 1) {
          const row = chunk.slots[local];
          if (row === undefined) {
            continue;
          }
          const slot = chunkIndex * chunkRows + local;
          for (let i = 0; i < row.cols.length; i += 1) {
            copy.set(slot, row.cols[i]!, cloneRecord(row.records[i]!));
          }
        }
      }
      return copy;
    },
    fork() {
      // ここから先は今のチャンクと行を fork 先と共有する＝自分の側も書く前に写す。
      ownedChunks = new WeakSet();
      ownedRows = new WeakSet();
      return buildCellStore(chunkRows, new Map(chunks), count, totalValueChars);
    },
    nonEmptyCount() {
      return count;
    },
    approxMemoryBytes() {
      return (
        count * (BYTES_PER_COL_ENTRY + BYTES_PER_RECORD_REF + BYTES_PER_RECORD_OBJECT) +
        totalValueChars * BYTES_PER_CHAR +
        chunks.size * chunkRows * BYTES_PER_RECORD_REF
      );
    },
  };
  return store;
}
