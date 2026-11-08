// 日付列のカレンダー（DD-035 R2・ポップオーバー・editor 経路無改変）。DD-065 区画③。
// 生成は mount 時、backend への結線は attach で行う。結線前の操作は何もしない（従来の「後から代入する関数」が未設定の状態と同じ）。

import type { SetCellsOperation } from '@nanairo-sheet/core';
import type { CellRect, ViewportTransform } from '@nanairo-sheet/render';
import type { ColumnId, OperationId, RowId } from '@nanairo-sheet/types';

import type { ColumnTypeRegistry } from '../column-types';
import { captureEditStartRevision, draftToScalar, isRowLive } from '../commit-bridge';
import { createDatePicker } from '../date-editor';
import type { DatePicker } from '../date-editor';
import type { DiagnosticSink } from '../diagnostics';
import { computeEditorPlacement } from '../editor-placement';
import type { PlacementConfig } from '../editor-placement';
import type { GridConflictCode } from '../error-codes';
import type { GridBackend } from '../grid-backend';
import type { IntegrationEditor } from '../integration-editor';
import type { VisibleArea } from '../popup-placement';
import type { CellLock } from './cell-lock';
import type { CellValidationSource } from './constants';
import type { MountMerges } from './merges';

export interface DateWiringDeps {
  /** ポップオーバー・📅 インジケーターを置く要素（stage）。 */
  readonly host: HTMLElement;
  readonly diag: DiagnosticSink;
  readonly stringColumnStrings: ReadonlySet<string>;
  readonly cellLock: Pick<CellLock, 'isActiveCellReadOnly' | 'readOnlyEntryBlocked' | 'isReadOnlyColumnIndex'>;
  readonly merges: Pick<MountMerges, 'isMergedCellId'>;
  editor(): IntegrationEditor | undefined;
  registry(): ColumnTypeRegistry | undefined;
  isReadOnly(): boolean;
  /** 開いている候補欄を閉じる（同じセルで候補欄とカレンダーを併存させない）。 */
  closeSelect(): void;
  ensureActiveCellVisible(): void;
  currentTransform(): ViewportTransform | undefined;
  placementConfig(): PlacementConfig;
  visibleArea(): VisibleArea;
  submitSetCells(op: SetCellsOperation, source: CellValidationSource): OperationId | void;
  notifyRowReject(code: GridConflictCode, diagCode: string, detail: string): void;
}

export interface DateWiring {
  /** backend へ結線する（日付列があるときだけカレンダーを作る＝無ければ overhead ゼロ）。 */
  attach(backend: GridBackend): void;
  /** カレンダーを配線したか（キー入力の裁定に日付の段が入るか）。 */
  isAttached(): boolean;
  isOpen(): boolean;
  /** アクティブセルのカレンダーを開く。 */
  open(): void;
  /** 開いているカレンダーを閉じる（文書は変えない）。 */
  close(): void;
  /** 日付を確定する（日クリック・Enter・「今日」・「クリア」=''）。 */
  confirm(value: string): void;
  moveDays(delta: number): void;
  moveMonths(delta: number): void;
  /** 毎フレーム: 📅 インジケーターと開いているポップオーバーを scroll・構造 Op に追従させる。 */
  refreshPlacement(transform: ViewportTransform): void;
  /** 列 index の日付列 openOn（既定 'dblclick'）。日付列でなければ undefined。 */
  openOnOf(colIndex: number): 'dblclick' | 'icon' | undefined;
  /** 列 index が「dblclick で開く日付列」か（dblclick 分岐用。openOn='icon' の列は従来どおり textarea 編集）。 */
  isDblclickDateColumnIndex(colIndex: number): boolean;
  highlightedValue(): string | null;
  viewMonth(): { year: number; month: number } | null;
  dispose(): void;
}

export function createDateWiring(deps: DateWiringDeps): DateWiring {
  const { diag, cellLock, merges, stringColumnStrings } = deps;
  let backend: GridBackend | undefined;
  let datePicker: DatePicker | undefined;
  // カレンダーを開いた時点の対象セル（beforeRevision 凍結・確定で OCC 裁定に使う・select と同型）。
  let dateOpenTarget: { readonly rowId: RowId; readonly columnId: ColumnId; readonly beforeRevision: number } | null = null;

  /** 列 index が日付列か（readOnly 列・グリッド readOnly は開けない側で除外する）。 */
  function isDateCellIndex(colIndex: number): boolean {
    const registry = deps.registry();
    if (backend === undefined || registry === undefined) {
      return false;
    }
    const colId = backend.view.columnIdAt(colIndex);
    return colId !== undefined && registry.isDateColumn(String(colId));
  }

  function dateOpenOnOf(colIndex: number): 'dblclick' | 'icon' | undefined {
    if (backend === undefined) {
      return undefined;
    }
    const colId = backend.view.columnIdAt(colIndex);
    const type = colId === undefined ? undefined : deps.registry()?.getDateType(String(colId));
    return type === undefined ? undefined : (type.openOn ?? 'dblclick');
  }

  function openDate(): void {
    if (backend === undefined) {
      return; // 結線前（従来の「後から代入する関数」が未設定のとき）は何もしない
    }
    if (deps.isReadOnly()) {
      diag.emit('info', 'readonly-blocked', 'readOnly: 日付カレンダーを抑止');
      return;
    }
    if (cellLock.isActiveCellReadOnly()) {
      diag.emit(...cellLock.readOnlyEntryBlocked('日付カレンダー'));
      return;
    }
    const editor = deps.editor();
    if (editor === undefined || datePicker === undefined || deps.registry() === undefined) {
      return;
    }
    // composition 中・非 Navigation は開かない（IME 経路無改変・I-3）。
    if (editor.session.isComposing() || editor.session.getPhase() !== 'Navigation') {
      return;
    }
    const active = editor.session.getActiveCell();
    if (!isDateCellIndex(active.col)) {
      return;
    }
    const rowId = backend.view.rowIdAt(active.row);
    const columnId = backend.view.columnIdAt(active.col);
    if (rowId === undefined || columnId === undefined) {
      return;
    }
    deps.closeSelect(); // 併存しない（同一列に両型は無いが防御）
    const currentValue = backend.view.cellDisplay(rowId, columnId);
    const beforeRevision = captureEditStartRevision(backend.session.committedDocument, rowId, columnId);
    dateOpenTarget = { rowId, columnId, beforeRevision };
    deps.ensureActiveCellVisible();
    const transform = deps.currentTransform();
    const placement = transform === undefined ? null : computeEditorPlacement(transform, active.row, active.col, deps.placementConfig());
    datePicker.open({ rect: placement !== null && placement.visible ? placement.rect : null, currentValue });
    diag.emit('info', 'date-open', `date: カレンダーを開く row=${String(rowId)} col=${String(columnId)} current=「${currentValue}」`);
    backend.view.markViewportDirty();
  }

  function cancelDate(): void {
    if (backend === undefined || datePicker === undefined || !datePicker.isOpen()) {
      return;
    }
    datePicker.close();
    dateOpenTarget = null;
    backend.view.markViewportDirty();
  }

  /**
   * カレンダーの確定（日クリック・Enter・「今日」・「クリア」=''）。閉じてから既存 chokepoint（submitSetCells）へ流す＝
   * Undo 記録・cell-commit 通知・OCC（開いた時点の beforeRevision を凍結）が既存経路で成立する（confirmSelect と同型）。
   * 確定時点で同値なら文書を触らず、対象行が削除済みなら実行前拒否（row-unavailable）。
   */
  function confirmDate(value: string): void {
    if (backend === undefined || datePicker === undefined || !datePicker.isOpen() || dateOpenTarget === null) {
      return;
    }
    // DD-056 H12: 表示専用（変換の終わり待ちを含む）では確定しない（confirmSelect と同じ。開いた後に切り替わった場合の防御）。
    if (deps.isReadOnly()) {
      diag.emit('info', 'readonly-blocked', 'readOnly: 日付の確定を抑止');
      cancelDate();
      return;
    }
    // DD-064（Codex P2）: 開いている間に対象セルが結合範囲になったら確定しない（confirmSelect と同じ）。
    if (merges.isMergedCellId(dateOpenTarget.rowId, dateOpenTarget.columnId)) {
      diag.emit('info', 'merged-cell-blocked', 'mergedCells: 結合範囲になったセルへの日付の確定を抑止');
      cancelDate();
      return;
    }
    const target = dateOpenTarget;
    datePicker.close();
    dateOpenTarget = null;
    backend.view.markViewportDirty();
    const currentNow = backend.view.cellDisplay(target.rowId, target.columnId);
    if (value === currentNow) {
      return;
    }
    if (!isRowLive(backend.session.committedDocument, target.rowId)) {
      deps.notifyRowReject('row-unavailable', 'date-row-deleted', `日付確定対象の行が削除済み: row=${String(target.rowId)}`);
      return;
    }
    const op: SetCellsOperation = {
      type: 'setCells',
      conflictPolicy: 'reject-overlap',
      changes: [
        {
          rowId: target.rowId,
          columnId: target.columnId,
          beforeRevision: target.beforeRevision,
          // RC12（DD-052-2・Codex P2）: stringColumns 指定列は日付ピッカーでも型変換をスキップする（他2経路と同じ契約）。
          // 通常時は 'YYYY-MM-DD' → kind:'date'（ADR-0012 正準）／'' → blank（クリア）。
          value: draftToScalar(value, stringColumnStrings.has(String(target.columnId))),
        },
      ],
    };
    deps.submitSetCells(op, 'date'); // DD-063: 日付のカレンダーの確定も検証する
    backend.view.markCellDirty();
  }

  function refreshPlacement(transform: ViewportTransform): void {
    const editor = deps.editor();
    if (backend === undefined || datePicker === undefined || editor === undefined) {
      return;
    }
    // open 中に IME composition が始まる/非 Navigation へ遷移したら閉じる（select と同じ毎フレーム防御）。
    if (datePicker.isOpen() && (editor.session.isComposing() || editor.session.getPhase() !== 'Navigation')) {
      cancelDate();
    }
    // 📅 インジケーター: アクティブセルが日付列 & Navigation & 非 composition & 開ける状態（readOnly/列 readOnly でない）。
    const active = editor.session.getActiveCell();
    const showIndicator =
      !deps.isReadOnly() &&
      isDateCellIndex(active.col) &&
      !cellLock.isActiveCellReadOnly() && // DD-035 R4 / DD-036 C3: readOnly 列・行では開けないため affordance も出さない
      !editor.session.isComposing() &&
      editor.session.getPhase() === 'Navigation';
    let indicatorRect: CellRect | null = null;
    if (showIndicator) {
      const ip = computeEditorPlacement(transform, active.row, active.col, deps.placementConfig());
      indicatorRect = ip.visible ? ip.rect : null;
    }
    let openRect: CellRect | null = null;
    if (datePicker.isOpen() && dateOpenTarget !== null) {
      const r = backend.view.rowIndexOf(dateOpenTarget.rowId);
      const c = backend.view.colIndexOf(dateOpenTarget.columnId);
      if (r < 0 || c < 0) {
        diag.emit('warn', 'date-target-removed', `日付カレンダーの対象セルが消失したため閉じる: row=${String(dateOpenTarget.rowId)} col=${String(dateOpenTarget.columnId)}`);
        cancelDate();
      } else {
        const op = computeEditorPlacement(transform, r, c, deps.placementConfig());
        if (op.visible) {
          openRect = op.rect;
        } else {
          cancelDate(); // 画面外スクロール → 閉じる
        }
      }
    }
    datePicker.refresh({ openRect, indicatorRect });
  }

  return {
    attach(next) {
      backend = next;
      // カレンダーは日付列があるときだけ配線する（無ければ overhead ゼロ）。
      if (deps.registry()?.hasAnyDateColumn() === true) {
        datePicker = createDatePicker({
          host: deps.host,
          onConfirm: (value) => confirmDate(value),
          onIndicatorClick: () => openDate(),
          visibleArea: deps.visibleArea,
        });
      }
    },
    isAttached: () => datePicker !== undefined,
    isOpen: () => datePicker?.isOpen() === true,
    open: openDate,
    close: cancelDate,
    confirm: confirmDate,
    moveDays: (delta) => datePicker?.moveDays(delta),
    moveMonths: (delta) => datePicker?.moveMonths(delta),
    refreshPlacement,
    openOnOf: dateOpenOnOf,
    isDblclickDateColumnIndex: (colIndex) =>
      backend !== undefined && dateOpenOnOf(colIndex) === 'dblclick' && !cellLock.isReadOnlyColumnIndex(colIndex),
    highlightedValue: () => datePicker?.highlightedValue() ?? null,
    viewMonth: () => datePicker?.viewMonth() ?? null,
    dispose() {
      datePicker?.destroy();
    },
  };
}
