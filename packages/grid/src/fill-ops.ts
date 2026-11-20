// fill-ops（DD-070-3）: Ctrl+D（上のセルを下へ）・Ctrl+R（左のセルを右へ）の写す元と先の決定、原子的 SetCells の生成、
// キーの判定（DOM 非依存の純粋関数）。書き込みは呼び出し側が貼り付けと同じ経路（読むだけのセルを飛ばす・validateCell・
// Undo・OCC）へ流す。
//
// 写す値は「コピーと同じ規則で読んだ表示文字列（結合範囲の左上以外は空）を、写す先の列の設定で貼り付けと同じ型変換に
// 通したもの」＝コピーして貼り付けたのと同じ結果。写す先の今の値（自分の未確定の変更を含む view）と型・値が同じセルは書かない
// （Codex P1・P2）。

import { SETCELLS_MAX_CELLS, parseCellInput } from '@nanairo-sheet/core';
import type { CellScalar, SetCellsChange, SetCellsOperation } from '@nanairo-sheet/core';
import type { ColumnId, RowId } from '@nanairo-sheet/types';
import type { EditPhase } from '@nanairo-sheet/ime';
import type { CellRange } from '@nanairo-sheet/selection';

import { captureEditStartRevision } from './commit-bridge';
import type { RangeDocumentPort } from './range-ops';

export type FillDirection = 'down' | 'right';

/** 写す元（1 行または 1 列）と写す先の範囲（どちらも半開区間）。 */
export interface FillRanges {
  readonly source: CellRange;
  readonly target: CellRange;
}

/**
 * 選択範囲から写す元と先を決める（Excel 準拠）。down: 2 行以上なら一番上の行を残りの行へ、1 行なら上の行を範囲へ。
 * right: 同じことを列の向きで。写す先が無い（先頭の行・列で 1 行・1 列）・空の範囲なら null。
 */
export function fillRanges(range: CellRange, direction: FillDirection): FillRanges | null {
  const rows = range.rowEnd - range.rowStart;
  const cols = range.colEnd - range.colStart;
  if (rows <= 0 || cols <= 0) {
    return null;
  }
  if (direction === 'down') {
    if (rows >= 2) {
      return {
        source: { ...range, rowEnd: range.rowStart + 1 },
        target: { ...range, rowStart: range.rowStart + 1 },
      };
    }
    if (range.rowStart === 0) {
      return null;
    }
    return { source: { ...range, rowStart: range.rowStart - 1, rowEnd: range.rowStart }, target: range };
  }
  if (cols >= 2) {
    return {
      source: { ...range, colEnd: range.colStart + 1 },
      target: { ...range, colStart: range.colStart + 1 },
    };
  }
  if (range.colStart === 0) {
    return null;
  }
  return { source: { ...range, colStart: range.colStart - 1, colEnd: range.colStart }, target: range };
}

export type FillOutcome =
  /** 1 つの原子的 SetCells として submit する（値が変わるセルだけ・beforeRevision 付き）。 */
  | { readonly kind: 'submit'; readonly operation: SetCellsOperation; readonly cellCount: number }
  /** 写す先のセル数が上限超過 → 実行前拒否（走査もしない）。 */
  | { readonly kind: 'too-large'; readonly cellCount: number; readonly limit: number }
  /** 写す先が無い・値が変わるセルが無い → 変更なし。 */
  | { readonly kind: 'noop' };

/** 2 つの値が同じか（型と値）。 */
function sameScalar(a: CellScalar, b: CellScalar): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  return a.kind === 'blank' || (b.kind !== 'blank' && a.value === b.value);
}

/**
 * 選択範囲の Ctrl+D／Ctrl+R を原子的 SetCells へ（生成のみ。submit は呼び出し側）。
 * @param port 写す元を読むポート。**コピーと同じ規則**（結合範囲の左上以外は空）の displayText を渡す（Codex P1）。
 * @param targetValue 写す先の今の値（自分の未確定の変更を含む view）。型と値が同じセルは書かない（Codex P2）。
 */
export function buildFill(
  port: RangeDocumentPort,
  range: CellRange,
  direction: FillDirection,
  targetValue: (rowId: RowId, columnId: ColumnId) => CellScalar,
  /** 文字列として保つ列か（型変換をスキップ・貼り付けと同じ）。 */
  isStringColumn?: (columnId: string) => boolean,
): FillOutcome {
  const ranges = fillRanges(range, direction);
  if (ranges === null) {
    return { kind: 'noop' };
  }
  const { source, target } = ranges;
  const cellCount = (target.rowEnd - target.rowStart) * (target.colEnd - target.colStart);
  if (cellCount > SETCELLS_MAX_CELLS) {
    return { kind: 'too-large', cellCount, limit: SETCELLS_MAX_CELLS };
  }
  const committed = port.getCommittedDocument();
  const changes: SetCellsChange[] = [];
  for (let row = target.rowStart; row < target.rowEnd; row += 1) {
    const rowId = port.rowIdAt(row);
    if (rowId === undefined) {
      continue;
    }
    for (let col = target.colStart; col < target.colEnd; col += 1) {
      const columnId = port.colIdAt(col);
      if (columnId === undefined) {
        continue;
      }
      // 写す元: down は同じ列の元の行、right は同じ行の元の列。
      const sourceRowId = direction === 'down' ? port.rowIdAt(source.rowStart) : rowId;
      const sourceColumnId = direction === 'down' ? columnId : port.colIdAt(source.colStart);
      if (sourceRowId === undefined || sourceColumnId === undefined) {
        continue;
      }
      // 写す先の列の設定で型変換する（stringColumns の "007" を数値の列へ写せば 7、その逆は "7"＝貼り付けと同じ）。
      const value = parseCellInput(port.displayText(sourceRowId, sourceColumnId), {
        forceString: isStringColumn?.(String(columnId)) === true,
      });
      if (sameScalar(targetValue(rowId, columnId), value)) {
        continue; // 型も値も同じなら書かない（無駄な Undo・cell-commit を作らない）
      }
      changes.push({ rowId, columnId, beforeRevision: captureEditStartRevision(committed, rowId, columnId), value });
    }
  }
  if (changes.length === 0) {
    return { kind: 'noop' };
  }
  return { kind: 'submit', operation: { type: 'setCells', conflictPolicy: 'reject-overlap', changes }, cellCount };
}

export interface FillKeyInput {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly eventComposing: boolean;
  readonly sessionComposing: boolean;
  readonly phase: EditPhase;
}

/**
 * Ctrl+D・Ctrl+R の判定。Navigation で変換中でなければ写す向き。編集中（Navigation でない位相）は 'block'
 * （何もしないがブラウザーの既定＝ブックマーク・再読み込みを止める）。変換中・修飾が違う・別のキーは 'none'。
 */
export function decideFillKey(input: FillKeyInput): FillDirection | 'block' | 'none' {
  if (input.eventComposing || input.sessionComposing) {
    return 'none';
  }
  if (!(input.ctrlKey || input.metaKey) || input.shiftKey || input.altKey) {
    return 'none';
  }
  const key = input.key.toLowerCase();
  if (key !== 'd' && key !== 'r') {
    return 'none';
  }
  if (input.phase !== 'Navigation') {
    return 'block';
  }
  return key === 'd' ? 'down' : 'right';
}
