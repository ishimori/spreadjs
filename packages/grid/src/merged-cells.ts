// DD-064: 表示のための結合（view-local・consumer の指定・読むだけ）。描画の時に行へ張る解決（形の検査は merged-cell-spec.ts）。
//
// 契約の正本は doc/DD/DD-064/contract.md §1。
//
// - 解決（MergeRegistry.resolve）は**描画の時だけ**呼ぶ。setData・setRows・setMergedCells を同じ処理の中でどちらの順に
//   呼んでも、古い行の並びで張らないため（contract §1.2）。張る時に範囲の行 ID を覚え（固定 ID）、以後は覚えた行で持つ。
//   覚えた行が欠けた・間に行が入った・並びが変わったら壊れたとして捨てる（D-17 の「破壊時自動解除」を先に採る）。

import { createMergeIndex, EMPTY_MERGE_INDEX, type CellRange, type MergeIndex } from '@nanairo-sheet/selection';
import type { Axis } from '@nanairo-sheet/render';
import { createRowId, type RowId } from '@nanairo-sheet/types';

import type { MergeSpec } from './merged-cell-spec';

// 公開型と形の検査は merged-cell-spec.ts（Facade の公開宣言の閉包に入るため内部 package に依存しない）。互換のため再 export する。
export type { GridMergedCell, MergeSpec, MergeSpecIssue, MergeSpecValidation } from './merged-cell-spec';
export { MergedCellsConfigError, describeMergeIssues, validateMergedCells } from './merged-cell-spec';

/** 解決の診断（contract §8）。code は `merged-cell-unresolved`・`merged-cell-conflict`・`merged-cell-broken`。 */
export type MergeDiagnosticSink = (code: string, message: string) => void;

export interface MergeRegistry {
  /**
   * 指定を置き換える（`[]` で全部外す）。同じ内容でも次の解決で今の行の並びに張り直す（壊れた結合も指定し直せば戻る）。
   * 同じ番号・同じ内容の指定について、既に出した「張れない」理由の warn は出し直さない（React の props を毎 render
   * 渡し直す consumer で診断が溢れないように）。
   */
  replace(specs: readonly MergeSpec[]): void;
  /** 指定が 1 件以上あるか。 */
  hasSpecs(): boolean;
  /**
   * 描画の時に行へ張り直す（行 Axis・指定が前回と同じなら何もしない）。張った結合が変わったら true。
   * frozenRowCount は固定行数（境界をまたぐ結合は描かない）。
   */
  resolve(rowAxis: Axis<RowId>, frozenRowCount: number): boolean;
  /** 直前に張った結合（描画・クリック・キーの判定はこれを使う）。 */
  index(): MergeIndex;
}

type WarnReason = 'unresolved' | 'frozen' | 'overlap' | 'broken';

interface Entry {
  readonly spec: MergeSpec;
  /** 張った時の範囲の行 ID（null＝まだ張っていない）。 */
  boundIds: RowId[] | null;
  /** 覚えた行が欠けた・間に行が入った（指定し直すまで描かない）。 */
  broken: boolean;
  readonly warned: Set<WarnReason>;
}

function sameSpec(a: MergeSpec, b: MergeSpec): boolean {
  return a.rowId === b.rowId && a.columnId === b.columnId && a.rowSpan === b.rowSpan && a.columnSpan === b.columnSpan;
}

function sameRanges(a: readonly CellRange[], b: readonly CellRange[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.rowStart !== y.rowStart || x.rowEnd !== y.rowEnd || x.colStart !== y.colStart || x.colEnd !== y.colEnd) {
      return false;
    }
  }
  return true;
}

/** 覚えた行が今も隣り合って同じ順に並んでいれば上端の index、壊れていれば -1。 */
function contiguousTop(rowAxis: Axis<RowId>, ids: readonly RowId[]): number {
  const top = rowAxis.getIndex(ids[0]!);
  if (top < 0) {
    return -1;
  }
  for (let k = 1; k < ids.length; k += 1) {
    if (rowAxis.getIndex(ids[k]!) !== top + k) {
      return -1;
    }
  }
  return top;
}

function label(spec: MergeSpec): string {
  return `rowId=${spec.rowId} columnId=${spec.columnId} ${spec.rowSpan}行×${spec.columnSpan}列`;
}

export function createMergeRegistry(warn: MergeDiagnosticSink): MergeRegistry {
  let entries: Entry[] = [];
  let generation = 0;
  let resolvedAxis: Axis<RowId> | undefined;
  let resolvedGeneration = -1;
  let resolvedFrozen = -1;
  let currentRanges: readonly CellRange[] = [];
  let current: MergeIndex = EMPTY_MERGE_INDEX;

  const warnOnce = (entry: Entry, reason: WarnReason, code: string, message: string): void => {
    if (entry.warned.has(reason)) {
      return;
    }
    entry.warned.add(reason);
    warn(code, message);
  };

  return {
    replace(specs) {
      const previous = entries;
      entries = specs.map((spec, position) => {
        const old = previous[position];
        const warned = new Set<WarnReason>();
        if (old !== undefined && sameSpec(old.spec, spec)) {
          for (const reason of old.warned) {
            if (reason !== 'broken') {
              warned.add(reason); // 同じ指定の「張れない」理由は出し直さない（壊れたは、張り直してまた壊れたら出す）
            }
          }
        }
        return { spec, boundIds: null, broken: false, warned };
      });
      generation += 1;
    },
    hasSpecs: () => entries.length > 0,
    resolve(rowAxis, frozenRowCount) {
      if (rowAxis === resolvedAxis && generation === resolvedGeneration && frozenRowCount === resolvedFrozen) {
        return false;
      }
      resolvedAxis = rowAxis;
      resolvedGeneration = generation;
      resolvedFrozen = frozenRowCount;
      const rowCount = rowAxis.count();
      const frozen = Math.min(Math.max(frozenRowCount, 0), rowCount);
      const accepted: CellRange[] = [];
      // 行が 1 件も無い間（共同編集モードの snapshot 前・空の文書）は判定しない: 張れる結合は無く、ここで「左上の行が無い」を
      // warn すると、行が届く前の最初の描画で全部の指定に診断が出てしまう。張った結合の覚えた行もそのまま持つ。
      const noRows = rowCount === 0;
      // 行 index → その行で既に張った結合の列の区間（重なりの判定・行ごとに数件）。
      const occupied = new Map<number, CellRange[]>();
      const overlaps = (range: CellRange): boolean => {
        for (let row = range.rowStart; row < range.rowEnd; row += 1) {
          for (const other of occupied.get(row) ?? []) {
            if (range.colStart < other.colEnd && other.colStart < range.colEnd) {
              return true;
            }
          }
        }
        return false;
      };
      for (const entry of entries) {
        if (entry.broken || noRows) {
          continue;
        }
        const { spec } = entry;
        let top: number;
        if (entry.boundIds === null) {
          const anchor = rowAxis.getIndex(createRowId(spec.rowId));
          if (anchor < 0 || anchor + spec.rowSpan > rowCount) {
            warnOnce(
              entry,
              'unresolved',
              'merged-cell-unresolved',
              anchor < 0
                ? `mergedCells: 左上の行が無い（${label(spec)}）→ 行が届いたら張る`
                : `mergedCells: 左上の行から下に ${spec.rowSpan} 行ない（${label(spec)}）→ 行が届いたら張る`,
            );
            continue;
          }
          const ids: RowId[] = [];
          for (let k = 0; k < spec.rowSpan; k += 1) {
            ids.push(rowAxis.getId(anchor + k));
          }
          entry.boundIds = ids;
          top = anchor;
        } else {
          top = contiguousTop(rowAxis, entry.boundIds);
          if (top < 0) {
            entry.broken = true;
            warnOnce(
              entry,
              'broken',
              'merged-cell-broken',
              `mergedCells: 範囲の行が欠けた・間に行が入った・並びが変わったため捨てた（${label(spec)}）→ setMergedCells で指定し直すと張る`,
            );
            continue;
          }
        }
        const range: CellRange = {
          rowStart: top,
          rowEnd: top + spec.rowSpan,
          colStart: spec.colStart,
          colEnd: spec.colStart + spec.columnSpan,
        };
        if (range.rowStart < frozen && range.rowEnd > frozen) {
          warnOnce(
            entry,
            'frozen',
            'merged-cell-conflict',
            `mergedCells: 固定行（frozenRowCount=${frozen}）の境界をまたぐため描かない（${label(spec)}）→ 先頭の行から結合するなら frozenRowCount: 0`,
          );
          continue;
        }
        if (overlaps(range)) {
          warnOnce(entry, 'overlap', 'merged-cell-conflict', `mergedCells: 先の指定の結合と重なるため描かない（${label(spec)}）`);
          continue;
        }
        for (let row = range.rowStart; row < range.rowEnd; row += 1) {
          const list = occupied.get(row);
          if (list === undefined) {
            occupied.set(row, [range]);
          } else {
            list.push(range);
          }
        }
        accepted.push(range);
      }
      if (sameRanges(accepted, currentRanges)) {
        return false;
      }
      currentRanges = accepted;
      current = createMergeIndex(accepted);
      return true;
    },
    index: () => current,
  };
}
