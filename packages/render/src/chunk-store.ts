// 行スロット＋チャンク化セルストア（ADR-011 素材・計画書 §18.4/§21）。
// 可視範囲クエリを O(可視セル数) で返すのが目的。500,000 非空セルでも毎フレーム全走査しない。
// DOM 非依存。既存 `src/grid/cell-store.ts`（DD-002）は変更せず、PoC-B 専用に別実装する。
//
// 構造:
//   chunks: Map<chunkIndex, Chunk>   chunkIndex = floor(row / CHUNK_ROWS)
//   Chunk.slots[row % CHUNK_ROWS] = RowSlot | undefined
//   RowSlot = { cols: number[](昇順), values: string[] }（列 index 昇順の並列配列）
// 可視範囲クエリは「重なるチャンクの、範囲内の行スロットだけ」を走査し、
// 各行内は列の二分探索で colStart 以降だけを見る（O(可視セル数 + log)）。

import type { GeneratedCell } from './data-gen';

/**
 * 範囲クエリで 1 セルごとに呼ばれる訪問関数。`false` を返すと走査を即中断する（それ以外の戻り値＝void/undefined は
 * 継続＝後方互換）。中断は auto-fit の予算保護（DD-027-3・Fable P2）等の早期打ち切りに使う。
 */
export type RangeVisitor = (row: number, col: number, value: string) => void | boolean;

export interface ChunkStore {
  get(row: number, col: number): string;
  set(row: number, col: number, value: string): void;
  /** (row,col) 昇順のセル列を高速一括ロードする（末尾 append 経路）。 */
  bulkLoad(cells: Iterable<GeneratedCell>): void;
  /**
   * [rowStart,rowEnd) × [colStart,colEnd) の非空セルだけを visit する。
   * @returns visit した件数（＝範囲内の非空セル数）。
   */
  queryRange(
    rowStart: number,
    rowEnd: number,
    colStart: number,
    colEnd: number,
    visit: RangeVisitor,
  ): number;
  nonEmptyCount(): number;
  /** メモリ概算（バイト・レポート用フック）。 */
  approxMemoryBytes(): number;
}

interface RowSlot {
  cols: number[];
  values: string[];
}

interface Chunk {
  slots: (RowSlot | undefined)[];
}

const DEFAULT_CHUNK_ROWS = 256;
// メモリ概算の係数（UTF-16 char=2byte・数値/参照の概算）。厳密値ではなく傾向把握用。
const BYTES_PER_CELL_OVERHEAD = 16;

/** cols 昇順配列で target 以上になる最初の位置（lower bound）。 */
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

export function createChunkStore(config: { chunkRows?: number } = {}): ChunkStore {
  const chunkRows = config.chunkRows ?? DEFAULT_CHUNK_ROWS;
  if (chunkRows <= 0) {
    throw new Error(`chunkRows は正の数（受領: ${chunkRows}）`);
  }
  const chunks = new Map<number, Chunk>();
  let nonEmpty = 0;
  let totalValueChars = 0;

  const getSlot = (row: number, create: boolean): RowSlot | undefined => {
    const chunkIndex = Math.floor(row / chunkRows);
    let chunk = chunks.get(chunkIndex);
    if (chunk === undefined) {
      if (!create) {
        return undefined;
      }
      chunk = { slots: new Array<RowSlot | undefined>(chunkRows) };
      chunks.set(chunkIndex, chunk);
    }
    const local = row - chunkIndex * chunkRows;
    let slot = chunk.slots[local];
    if (slot === undefined && create) {
      slot = { cols: [], values: [] };
      chunk.slots[local] = slot;
    }
    return slot;
  };

  const setInternal = (row: number, col: number, value: string): void => {
    if (value === '') {
      const slot = getSlot(row, false);
      if (slot === undefined) {
        return;
      }
      const idx = lowerBound(slot.cols, col);
      if (idx < slot.cols.length && slot.cols[idx] === col) {
        totalValueChars -= (slot.values[idx] ?? '').length;
        slot.cols.splice(idx, 1);
        slot.values.splice(idx, 1);
        nonEmpty -= 1;
      }
      return;
    }
    const slot = getSlot(row, true);
    if (slot === undefined) {
      return;
    }
    const idx = lowerBound(slot.cols, col);
    if (idx < slot.cols.length && slot.cols[idx] === col) {
      totalValueChars += value.length - (slot.values[idx] ?? '').length;
      slot.values[idx] = value;
    } else {
      slot.cols.splice(idx, 0, col);
      slot.values.splice(idx, 0, value);
      totalValueChars += value.length;
      nonEmpty += 1;
    }
  };

  const store: ChunkStore = {
    get(row, col) {
      const slot = getSlot(row, false);
      if (slot === undefined) {
        return '';
      }
      const idx = lowerBound(slot.cols, col);
      if (idx < slot.cols.length && slot.cols[idx] === col) {
        return slot.values[idx] ?? '';
      }
      return '';
    },
    set(row, col, value) {
      setInternal(row, col, value);
    },
    bulkLoad(cells) {
      for (const cell of cells) {
        const slot = getSlot(cell.row, true);
        if (slot === undefined) {
          continue;
        }
        const lastCol = slot.cols.length > 0 ? slot.cols[slot.cols.length - 1] : undefined;
        if (cell.value === '') {
          continue;
        }
        if (lastCol === undefined || cell.col > lastCol) {
          // 昇順入力の高速 append 経路。
          slot.cols.push(cell.col);
          slot.values.push(cell.value);
          totalValueChars += cell.value.length;
          nonEmpty += 1;
        } else {
          // 昇順でない場合は正規経路へフォールバック（正しさ優先）。
          setInternal(cell.row, cell.col, cell.value);
        }
      }
    },
    queryRange(rowStart, rowEnd, colStart, colEnd, visit) {
      if (rowEnd <= rowStart || colEnd <= colStart) {
        return 0;
      }
      let visited = 0;
      const firstChunk = Math.floor(rowStart / chunkRows);
      const lastChunk = Math.floor((rowEnd - 1) / chunkRows);
      for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex += 1) {
        const chunk = chunks.get(chunkIndex);
        if (chunk === undefined) {
          continue;
        }
        const chunkRowBase = chunkIndex * chunkRows;
        const localStart = Math.max(rowStart - chunkRowBase, 0);
        const localEnd = Math.min(rowEnd - chunkRowBase, chunkRows);
        for (let local = localStart; local < localEnd; local += 1) {
          const slot = chunk.slots[local];
          if (slot === undefined) {
            continue;
          }
          const row = chunkRowBase + local;
          // 列は昇順のため colStart 以降だけを走査する。
          for (let i = lowerBound(slot.cols, colStart); i < slot.cols.length; i += 1) {
            const col = slot.cols[i] ?? 0;
            if (col >= colEnd) {
              break;
            }
            const stop = visit(row, col, slot.values[i] ?? '');
            visited += 1;
            if (stop === false) {
              return visited; // 訪問関数が中断を要求（DD-027-3・予算保護）
            }
          }
        }
      }
      return visited;
    },
    nonEmptyCount() {
      return nonEmpty;
    },
    approxMemoryBytes() {
      return nonEmpty * BYTES_PER_CELL_OVERHEAD + totalValueChars * 2 + chunks.size * chunkRows * 8;
    },
  };
  return store;
}
