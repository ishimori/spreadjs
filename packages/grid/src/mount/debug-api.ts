// E2E 用 introspection（test-support 経由で debugRegistry に載せる観測口・DD-065 区画⑧）。
// 読むだけの口。例外は行操作の 2 つ（submitInsertRowsAfter・submitDeleteRow）で、readOnly では送信しない。

import { documentHash, getCell } from '@nanairo-sheet/core';
import type { DeleteRowsOperation, InsertRowsOperation } from '@nanairo-sheet/core';
import { createColumnId, createRowId } from '@nanairo-sheet/types';
import type { ColumnId, RowId } from '@nanairo-sheet/types';
import { columnLabel } from '@nanairo-sheet/render';
import type { ViewportTransform } from '@nanairo-sheet/render';
import type { MergeIndex } from '@nanairo-sheet/selection';

import type { BrowserWebSocketTransport } from '../browser-transport';
import type { DiagnosticSink } from '../diagnostics';
import type { CompiledColumnDisplay } from '../display-format';
import { cellScalarToDisplay } from '../document-view';
import type { GridBackend } from '../grid-backend';
import type { IntegrationEditor } from '../integration-editor';
import type { GridDebugApi, GridDebugCellAddress } from '../internal';
import type { SelectionController } from '../selection-controller';
import type { UndoController } from '../undo-stack';
import type { DateWiring } from './date-wiring';
import type { SelectWiring } from './select-wiring';

/** 観測口が読む部品（いずれも呼ばれた時点の値を読む）。 */
export interface DebugApiDeps {
  readonly isStandalone: boolean;
  readonly headerHeight: number;
  readonly scroller: HTMLElement;
  readonly diag: DiagnosticSink;
  readonly selectionCtrl: SelectionController;
  readonly undoCtrl: UndoController;
  backend(): GridBackend | undefined;
  editor(): IntegrationEditor | undefined;
  lastSessionEventType(): string;
  isFirstDataDrawn(): boolean;
  isReadOnly(): boolean;
  currentTransform(): ViewportTransform | undefined;
  display(): CompiledColumnDisplay | undefined;
  merges(): MergeIndex;
  readonly select: Pick<SelectWiring, 'isOpen' | 'options' | 'highlightedIndex' | 'highlightedValue'>;
  readonly date: Pick<DateWiring, 'isOpen' | 'highlightedValue' | 'viewMonth'>;
  transport(): BrowserWebSocketTransport | undefined;
}

function toAddress(cell: { rowId: RowId; columnId: ColumnId } | undefined): GridDebugCellAddress | null {
  return cell === undefined ? null : { rowId: String(cell.rowId), columnId: String(cell.columnId) };
}

export function createDebugApi(deps: DebugApiDeps): GridDebugApi {
  const { diag, selectionCtrl, undoCtrl, scroller } = deps;
  const backend = (): GridBackend | undefined => deps.backend();
  const editor = (): IntegrationEditor | undefined => deps.editor();
  return {
    ready: () => {
      const sync = backend();
      return sync !== undefined && deps.isFirstDataDrawn() && sync.view.rowAxis.count() > 1;
    },
    online: () => backend()?.session.isOnline ?? false,
    connectionState: () => {
      const sync = backend();
      return deps.isStandalone
        ? 'standalone'
        : sync === undefined
          ? 'offline'
          : sync.session.isStopped
            ? 'stopped'
            : sync.session.isOnline
              ? 'online'
              : 'offline';
    },
    lastEventType: () => deps.lastSessionEventType(),
    rowCount: () => backend()?.view.rowAxis.count() ?? 0,
    committedRevision: () => backend()?.session.committedDocument.revision ?? 0,
    committedHash: () => {
      const sync = backend();
      return sync === undefined ? '' : documentHash(sync.session.committedDocument);
    },
    pendingCount: () => backend()?.session.pendingCount ?? 0,
    conflictCount: () => backend()?.session.conflictQueue.length ?? 0,
    divertedCount: () => editor()?.session.divertedDrafts().length ?? 0,
    knownPresenceCount: () => backend()?.session.knownPresences().length ?? 0,
    bootstrapRevision: () => backend()?.session.bootstrapRevision ?? 0,
    appliedServerOpCount: () => backend()?.session.appliedServerOpCount ?? 0,
    presences: () =>
      (backend()?.session.knownPresences() ?? []).map((p) => ({
        displayName: p.displayName,
        activeCell: toAddress(p.activeCell),
        editingCell: toAddress(p.editingCell),
        selectionRanges: p.selectionRanges.map((r) => ({
          startRowId: String(r.startRowId),
          startColumnId: String(r.startColumnId),
          endRowId: String(r.endRowId),
          endColumnId: String(r.endColumnId),
        })),
      })),
    isConflicting: () => editor()?.session.isConflicting() ?? false,
    isTargetLost: () => editor()?.session.isTargetLost() ?? false,
    isComposing: () => editor()?.session.isComposing() ?? false,
    draft: () => editor()?.session.getDraft() ?? '',
    activeCell: () => editor()?.session.getActiveCell() ?? { row: 0, col: 0 },
    selectionRange: () => selectionCtrl.getRange(),
    dragRange: () => selectionCtrl.getDragRange(),
    // DD-027-1: 選択式ドロップダウンの観測（開閉・候補・ハイライト）。
    selectOpen: () => deps.select.isOpen(),
    selectOptions: () => [...deps.select.options()],
    selectHighlightedIndex: () => deps.select.highlightedIndex(),
    selectHighlightedValue: () => deps.select.highlightedValue(),
    // DD-035 R2: 日付カレンダーの観測（開閉・ハイライト・表示月）。
    dateOpen: () => deps.date.isOpen(),
    dateHighlightedValue: () => deps.date.highlightedValue(),
    dateViewMonth: () => deps.date.viewMonth(),
    // DD-020-3: Undo/Redo 可否・深さ（pending が読めないときは undo 不可側に倒す）。
    canUndo: () => undoCtrl.canUndo(backend()?.session.pendingCount ?? 1),
    canRedo: () => undoCtrl.canRedo(backend()?.session.pendingCount ?? 1),
    undoDepth: () => undoCtrl.undoDepth(),
    redoDepth: () => undoCtrl.redoDepth(),
    editingTarget: () => {
      const t = editor()?.session.getEditingTarget() ?? null;
      return t === null ? null : { rowId: String(t.rowId), columnId: String(t.columnId) };
    },
    rowIdAt: (index) => {
      const id = backend()?.view.rowIdAt(index);
      return id === undefined ? undefined : String(id);
    },
    colIdAt: (index) => {
      const id = backend()?.view.columnIdAt(index);
      return id === undefined ? undefined : String(id);
    },
    rowIndexOf: (rowId) => backend()?.view.rowIndexOf(createRowId(rowId)) ?? -1,
    cellRectAt: (row, col) => deps.currentTransform()?.cellRect(row, col) ?? null,
    // DD-035 R6: scrollToRow の観測（scroller の実 scrollTop/Left）。
    scrollTop: () => scroller.scrollTop,
    scrollLeft: () => scroller.scrollLeft,
    columnHeaderRectAt: (col) => deps.currentTransform()?.columnHeaderRect(col) ?? null,
    rowHeaderRectAt: (row) => deps.currentTransform()?.rowHeaderRect(row) ?? null,
    columnWidthOverrides: () => backend()?.view.columnWidthOverrideRecord() ?? {},
    rowHeightOverrides: () => backend()?.view.rowHeightOverrideRecord() ?? {},
    committedCell: (rowId, columnId) => {
      const sync = backend();
      if (sync === undefined) {
        return '';
      }
      const record = getCell(sync.session.committedDocument, createRowId(rowId), createColumnId(columnId));
      return record === undefined ? '' : cellScalarToDisplay(record.value);
    },
    committedCellKind: (rowId, columnId) => {
      const sync = backend();
      if (sync === undefined) {
        return 'blank';
      }
      const record = getCell(sync.session.committedDocument, createRowId(rowId), createColumnId(columnId));
      return record === undefined ? 'blank' : record.value.kind;
    },
    displayCell: (rowId, columnId) => {
      const sync = backend();
      return sync === undefined ? '' : sync.view.cellDisplay(createRowId(rowId), createColumnId(columnId));
    },
    // DD-033-2: base-layer が実際に描く display テキスト（raw→表示書式適用後）。canvas 文字は DOM から読めないため、
    // 描画経路と同じ compiledDisplay.formatText を通した結果を E2E に露出する（判定は raw・描画は display の検証用）。
    cellRenderText: (rowId, columnId) => {
      const sync = backend();
      if (sync === undefined) {
        return '';
      }
      const raw = sync.view.cellDisplay(createRowId(rowId), createColumnId(columnId));
      return deps.display()?.formatText(columnId, raw) ?? raw;
    },
    // DD-033-2: 列ヘッダーに描く見出し（キャプション指定列はキャプション・未指定列は列記号 A/B/…）。
    columnHeaderText: (col) => {
      const id = backend()?.view.columnIdAt(col);
      const caption = id === undefined ? undefined : deps.display()?.captionFor(String(id));
      return caption ?? columnLabel(col);
    },
    // DD-064: 直前の描画で張った結合範囲（canvas の描画を DOM から読めないための E2E 観測用）。
    mergedRanges: () => deps.merges().all().map((range) => ({ ...range })),
    // DD-064 K4: 見出しの高さ（2段なら 48）。
    headerHeight: () => deps.headerHeight,
    // DD-033-1（統合レビュー P3-1）: debug API（test-support）も readOnly では文書 Operation を送信しない。
    // 行操作は submitToBackend を通らず session.submitLocalOperation 直呼びのため、素通しだと
    // 「送信ゼロの構造的保証」の唯一の例外になる（perform* 先頭ガードの設計規約に合わせる）。
    submitInsertRowsAfter: (afterRowId, newRowId) => {
      const sync = backend();
      if (sync === undefined) {
        return;
      }
      if (deps.isReadOnly()) {
        diag.emit('warn', 'readonly-blocked', 'readOnly: debug submitInsertRowsAfter を破棄');
        return;
      }
      const op: InsertRowsOperation = {
        type: 'insertRows',
        afterRowId: afterRowId === null ? null : createRowId(afterRowId),
        rows: [{ rowId: createRowId(newRowId) }],
      };
      sync.session.submitLocalOperation(op);
    },
    submitDeleteRow: (rowId) => {
      const sync = backend();
      if (sync === undefined) {
        return;
      }
      if (deps.isReadOnly()) {
        diag.emit('warn', 'readonly-blocked', 'readOnly: debug submitDeleteRow を破棄');
        return;
      }
      const op: DeleteRowsOperation = { type: 'deleteRows', rowIds: [createRowId(rowId)] };
      sync.session.submitLocalOperation(op);
    },
    simulateDrop: () => {
      deps.transport()?.dropForTest();
    },
    simulateReconnect: () => {
      deps.transport()?.resumeReconnectForTest();
    },
  };
}
