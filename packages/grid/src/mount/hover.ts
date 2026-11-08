// セルのホバー通知（RC6・DD-052-5 の cell-hover。出入りで発火し、同じセルの中の移動では出し直さない）。DD-065 区画④の一部。
// DD-060: 状態表示（cellStatus）があれば status を載せ、ホバー中のセルの状態が変わったら同じセルのまま出し直す。

import { mergedCellRect } from '@nanairo-sheet/render';
import type { ViewportTransform } from '@nanairo-sheet/render';
import { mergeAnchorOf } from '@nanairo-sheet/selection';
import { createColumnId, createRowId } from '@nanairo-sheet/types';

import type { CellStatusStore } from '../cell-status';
import type { GridBackend } from '../grid-backend';
import type { GridCellRect, GridCellStatus, GridEvent } from '../index';
import type { MountMerges } from './merges';

export interface CellHoverDeps {
  readonly cellStatusStore: CellStatusStore;
  readonly merges: Pick<MountMerges, 'any' | 'current'>;
  emit(event: GridEvent): void;
  backend(): GridBackend | undefined;
  currentTransform(): ViewportTransform | undefined;
  /** 命令を即時に行うか、次の構造 flush の後まで保留する（setData 直後は行 Axis の再構築を待つ）。 */
  runOrDefer(command: () => void): void;
}

export interface CellHover {
  /** hit（セル以外は null）を見て、ホバー中のセルが変わっていれば cell-hover を出す。 */
  update(hit: { readonly rowIndex: number; readonly colIndex: number } | null): void;
  /** ホバー中のセルの状態表示が setRows/setData/setCellStatus で変わっていれば、同じセルのまま cell-hover を出し直す。 */
  refreshStatus(): void;
}

export function createCellHover(deps: CellHoverDeps): CellHover {
  const { cellStatusStore, merges } = deps;
  let hoveredCell: { readonly rowId: string; readonly columnId: string } | null = null;
  // DD-060: 直近の cell-hover に載せた状態表示（ホバー中のセルの状態が変わったら出し直すために比べる）。
  let hoveredStatus: GridCellStatus | undefined;

  /** DD-060: セルの cell-hover イベントを作る（状態表示があれば status を載せ、無ければキー自体を付けない）。 */
  function cellHoverEvent(rowId: string, columnId: string, rect: GridCellRect): GridEvent {
    const status = cellStatusStore.statusOf(rowId, columnId);
    hoveredStatus = status;
    return status === undefined
      ? { type: 'cell-hover', rowId, columnId, rect }
      : { type: 'cell-hover', rowId, columnId, rect, status };
  }

  /** DD-060: このセルの今の状態表示が、直近の cell-hover に載せたもの（level・message）と違うか。 */
  function hoverStatusChanged(cell: { readonly rowId: string; readonly columnId: string }): boolean {
    const status = cellStatusStore.statusOf(cell.rowId, cell.columnId);
    return status?.level !== hoveredStatus?.level || status?.message !== hoveredStatus?.message;
  }

  /** DD-064: ホバーの矩形（結合の左上なら範囲全体）。 */
  function hoverRect(transform: ViewportTransform, row: number, col: number): GridCellRect {
    const merge = merges.any() ? merges.current().at(row, col) : undefined;
    return merge !== undefined ? mergedCellRect(transform, merge) : transform.cellRect(row, col);
  }

  return {
    update(hit) {
      const sync = deps.backend();
      if (sync === undefined) {
        return;
      }
      const transform = deps.currentTransform();
      let next: { rowId: string; columnId: string; rect: GridCellRect } | null = null;
      if (hit !== null && transform !== undefined) {
        // DD-064: 結合範囲の中は左上のセルとして通知する（範囲の中を動いても出し直さない・rect は範囲全体）。
        const cell = mergeAnchorOf(merges.current(), { row: hit.rowIndex, col: hit.colIndex });
        const rowId = sync.view.rowIdAt(cell.row);
        const columnId = sync.view.columnIdAt(cell.col);
        if (rowId !== undefined && columnId !== undefined) {
          next = { rowId: String(rowId), columnId: String(columnId), rect: hoverRect(transform, cell.row, cell.col) };
        }
      }
      if (next?.rowId === hoveredCell?.rowId && next?.columnId === hoveredCell?.columnId) {
        return; // 同一セル（or 両方 null）のまま → 再発火しない
      }
      hoveredCell = next === null ? null : { rowId: next.rowId, columnId: next.columnId };
      if (next === null) {
        hoveredStatus = undefined;
        deps.emit({ type: 'cell-hover', rowId: null, columnId: null, rect: null });
        return;
      }
      deps.emit(cellHoverEvent(next.rowId, next.columnId, next.rect));
    },
    /**
     * DD-060: 確定直後に consumer が検証して印を付けたとき、マウスを動かさなくてもメッセージを出せるように出し直す。
     * 行 Axis の再構築待ち（setData 直後）は runOrDefer で構造 flush 後の矩形を使う。行が消えていれば出さない。
     */
    refreshStatus() {
      const hovered = hoveredCell;
      if (hovered === null || !hoverStatusChanged(hovered)) {
        return;
      }
      deps.runOrDefer(() => {
        const transform = deps.currentTransform();
        const sync = deps.backend();
        if (hoveredCell !== hovered || transform === undefined || sync === undefined) {
          return; // その間にポインタが別のセルへ移った（そちらの cell-hover が最新の状態を載せている）
        }
        // 保留中に setRows が重なると要求も重なる。実行時にも比べ、先に出した通知と同じなら出さない（Codex P2）。
        if (!hoverStatusChanged(hovered)) {
          return;
        }
        const row = sync.view.rowIndexOf(createRowId(hovered.rowId));
        const col = sync.view.colIndexOf(createColumnId(hovered.columnId));
        if (row < 0 || col < 0) {
          return;
        }
        deps.emit(cellHoverEvent(hovered.rowId, hovered.columnId, hoverRect(transform, row, col)));
      });
    },
  };
}
