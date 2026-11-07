// 読み取り専用の判定（列・行・セル・結合範囲）と、常駐 textarea のロック（DD-065 区画⑤の判定側）。
// 判定は入口の抑止・送信直前の保証層（chokepoint）・textarea のロックで共有する。

import type { SetCellsChange, SetCellsOperation } from '@nanairo-sheet/core';
import { createRowId } from '@nanairo-sheet/types';

import type { ColumnTypeRegistry } from '../column-types';
import type { DiagnosticSink } from '../diagnostics';
import type { GridBackend } from '../grid-backend';
import type { IntegrationEditor } from '../integration-editor';
import { partitionReadOnlyCellChanges, partitionReadOnlyColumnChanges, partitionReadOnlyRowChanges } from '../readonly-policy';
import type { StandaloneSession } from '../standalone-session';
import type { MountMerges } from './merges';

export interface CellLockDeps {
  readonly diag: DiagnosticSink;
  readonly isStandalone: boolean;
  readonly readOnlyRows: readonly string[] | undefined;
  readonly merges: Pick<MountMerges, 'any' | 'isMergedCellIndex' | 'isMergedCellId'>;
  backend(): GridBackend | undefined;
  /** 単独モードの backend（行データ指定のセル単位 readOnly を読む）。共同編集モードは undefined。 */
  standalone(): StandaloneSession | undefined;
  editor(): IntegrationEditor | undefined;
  /** 列タイプメタの registry（readOnlyColumns もここで持つ。boot 前は undefined）。 */
  registry(): ColumnTypeRegistry | undefined;
}

export interface CellLock {
  hasReadOnlyColumns(): boolean;
  isReadOnlyColumnId(columnId: string): boolean;
  isReadOnlyColumnIndex(colIndex: number): boolean;
  hasReadOnlyRows(): boolean;
  isReadOnlyRowId(rowId: string): boolean;
  isReadOnlyRowIndex(rowIndex: number): boolean;
  isReadOnlyCellId(rowId: string, columnId: string): boolean;
  isReadOnlyCellIndex(rowIndex: number, colIndex: number): boolean;
  hasReadOnlyCellRows(): boolean;
  hasReadOnlyCells(): boolean;
  isActiveCellReadOnly(): boolean;
  isActiveCellMergedForNewInput(): boolean;
  readOnlyEntryBlocked(what: string): ['info', string, string];
  validateReadOnlyRowsOnce(): void;
  syncCellLock(): void;
  filterReadOnlyCells(op: SetCellsOperation, label: string): SetCellsOperation | null;
}

export function createCellLock(deps: CellLockDeps): CellLock {
  const { diag, isStandalone, merges } = deps;

  // ---- DD-035 R4: 列単位 readOnly（readOnlyColumns）の判定（入口・chokepoint・textarea ロックで共有）----
  /** readOnlyColumns が 1 つでもあるか（無ければ以下の判定は全て即 false＝現行経路のコスト増ゼロ）。 */
  function hasReadOnlyColumns(): boolean {
    return deps.registry()?.hasAnyReadOnlyColumn() === true;
  }
  /** ColumnId 文字列が readOnly 列か（SetCells フィルタ・chokepoint 用）。 */
  function isReadOnlyColumnId(columnId: string): boolean {
    return deps.registry()?.isReadOnlyColumn(columnId) === true;
  }
  /** 列 index が readOnly 列か（dblclick・キー裁定・インジケーター用）。registry 未生成/列消失は false。 */
  function isReadOnlyColumnIndex(colIndex: number): boolean {
    const sync = deps.backend();
    if (!hasReadOnlyColumns() || sync === undefined) {
      return false;
    }
    const colId = sync.view.columnIdAt(colIndex);
    return colId !== undefined && isReadOnlyColumnId(String(colId));
  }
  // ---- DD-036 C3: 行単位 readOnly（readOnlyRows）の判定（列版と同型・mount 固定・未知 rowId は warn のみ）----
  // 列（columnOrder で mount 時に全 ID が既知）と違い行 ID は初期データ到着前に検証できないため registry へは
  // 載せず、ここで Set を持つ（重複は集合として吸収＝fail-fast しない・契約 §3）。
  const readOnlyRowSet = new Set<string>((deps.readOnlyRows ?? []).map((r) => String(r)));
  /** readOnlyRows が 1 つでもあるか（無ければ以下の判定は全て即 false＝現行経路のコスト増ゼロ）。 */
  function hasReadOnlyRows(): boolean {
    return readOnlyRowSet.size > 0;
  }
  /** RowId 文字列が readOnly 行か（SetCells フィルタ・chokepoint 用）。 */
  function isReadOnlyRowId(rowId: string): boolean {
    return readOnlyRowSet.has(rowId);
  }
  /** 行 index が readOnly 行か（dblclick・キー裁定・インジケーター用）。行消失は false。 */
  function isReadOnlyRowIndex(rowIndex: number): boolean {
    const sync = deps.backend();
    if (!hasReadOnlyRows() || sync === undefined) {
      return false;
    }
    const rowId = sync.view.rowIdAt(rowIndex);
    return rowId !== undefined && isReadOnlyRowId(String(rowId));
  }
  // ---- RC3（DD-052-3）: セル単位 readOnly（GridStandaloneRow.readOnlyColumns）の判定。standalone モード専用 ----
  /** RowId/ColumnId 文字列が行データ指定の readOnly セルか（SetCells フィルタ・chokepoint 用）。 */
  function isReadOnlyCellId(rowId: string, columnId: string): boolean {
    const standalone = deps.standalone();
    return isStandalone && standalone !== undefined && standalone.isCellReadOnly(rowId, columnId);
  }
  /** 行・列 index が行データ指定の readOnly セルか（textarea ロック用）。共同編集モードは常に false。 */
  function isReadOnlyCellIndex(rowIndex: number, colIndex: number): boolean {
    const sync = deps.backend();
    if (!isStandalone || sync === undefined) {
      return false;
    }
    const rowId = sync.view.rowIdAt(rowIndex);
    const colId = sync.view.columnIdAt(colIndex);
    return rowId !== undefined && colId !== undefined && isReadOnlyCellId(String(rowId), String(colId));
  }
  /** RC3 のセル単位 readOnly が 1 件でも現在の行データに指定されているか（standalone 専用・共同編集は常に false）。 */
  function hasReadOnlyCellRows(): boolean {
    return isStandalone && deps.standalone()?.hasAnyCellReadOnly() === true;
  }
  /** readOnly 列/行/セルが 1 つでも指定されているか（未指定なら以下の分岐は一切コストを持たない）。 */
  function hasReadOnlyCells(): boolean {
    return hasReadOnlyColumns() || hasReadOnlyRows() || hasReadOnlyCellRows();
  }
  /**
   * アクティブセルが readOnly 列・readOnly 行・行データ指定の readOnly セルのいずれかにあるか
   * （textarea のロック・入口抑止の共通条件）。DD-035 R4（列）・DD-036 C3（行）・RC3（セル）の和。
   * DD-064: 結合範囲のセルも読むだけ（K3）なので含める（送信直前の保証層 touchesReadOnly* には含めない・contract §2）。
   */
  function isActiveCellReadOnly(): boolean {
    const editor = deps.editor();
    if (editor === undefined) {
      return false;
    }
    const active = editor.session.getActiveCell();
    return (
      isReadOnlyColumnIndex(active.col) ||
      isReadOnlyRowIndex(active.row) ||
      isReadOnlyCellIndex(active.row, active.col) ||
      isActiveCellMergedForNewInput()
    );
  }
  /**
   * DD-064: アクティブセルが結合範囲にあって、新しい入力を止める状態か（Navigation かつ変換中でないときだけ true）。
   * 結合は実行中に足せる（setMergedCells）ので、足す前に始まった編集・変換（IME）は終わるまで止めない（Codex P1: 変換中に
   * 結合を足すと、論理ロックが compositionend・最終 input まで捨て、変換が終わらなくなる）。終わって Navigation に戻ると
   * onChange が左上へ移し、ここが true になってロックされる。
   */
  function isActiveCellMergedForNewInput(): boolean {
    const editor = deps.editor();
    if (editor === undefined || !merges.any() || editor.session.isComposing() || editor.session.getPhase() !== 'Navigation') {
      return false;
    }
    const active = editor.session.getActiveCell();
    return merges.isMergedCellIndex(active.row, active.col);
  }
  /**
   * 読み取り専用のアクティブセルで編集 UI（候補欄・カレンダー）を止めたときの診断（DD-064: 結合範囲なら専用の code）。
   * diag.emit へ展開して渡す引数（level・code・message）。
   */
  function readOnlyEntryBlocked(what: string): ['info', string, string] {
    const active = deps.editor()?.session.getActiveCell();
    if (active !== undefined && merges.isMergedCellIndex(active.row, active.col)) {
      return ['info', 'merged-cell-blocked', `mergedCells: 結合範囲で${what}を抑止`];
    }
    return ['info', 'readonly-column-blocked', `readOnlyColumns/readOnlyRows: ${what}を抑止`];
  }
  /**
   * 未知 rowId の診断 warn（DD-036 C3・契約 §3）。行 ID は mount 時点では検証できないため、**初回描画の直後に 1 回だけ**
   * 現在の行 Axis と突き合わせる（それ以降の行削除・tombstone では警告しない＝実行時に警告を出し続けない）。
   * 未知でも mount は成功する（列の fail-fast とは扱いを分ける）。
   */
  let readOnlyRowsChecked = false;
  function validateReadOnlyRowsOnce(): void {
    const backend = deps.backend();
    if (readOnlyRowsChecked || !hasReadOnlyRows() || backend === undefined) {
      return;
    }
    readOnlyRowsChecked = true;
    const unknown = [...readOnlyRowSet].filter((rowId) => backend.view.rowIndexOf(createRowId(rowId)) < 0);
    if (unknown.length > 0) {
      diag.emit(
        'warn',
        'readonly-row-unknown',
        `readOnlyRows: 未知の行 ${unknown.join(', ')}（初回描画時点の文書に存在しない）→ 該当 RowId が現れれば読み取り専用になる`,
      );
    }
  }
  /**
   * アクティブセルのロックを常駐 textarea へ同期する（activeCell 移動のたびに呼ぶ・同値なら無操作）。
   * DD-052-3（Codex P1）: `hasReadOnlyCells()` では早期 return しない。readOnly 指定を setData/setRows で
   * 全解除した直後は false になるが、その回でロック解除の `setInputLock(false)` を呼ばないと textarea が
   * readOnly のまま固着する。`setInputLock` 自体が同値なら無操作なので毎回呼んでも無コスト。
   */
  function syncCellLock(): void {
    const editor = deps.editor();
    if (editor !== undefined) {
      editor.setInputLock(isActiveCellReadOnly());
    }
  }
  /**
   * 範囲操作（貼り付け・範囲クリア・cut）の SetCells から readOnly 列への変更を除く（論点4: スキップして他列へ適用）。
   * 全件スキップなら null（呼び出し側は no-op）。上限/はみ出し検査は矩形全体で先に済んでいる（事後フィルタ）。
   */
  function filterReadOnlyCells(op: SetCellsOperation, label: string): SetCellsOperation | null {
    if (!hasReadOnlyCells() && !merges.any()) {
      return op;
    }
    let changes: readonly SetCellsChange[] = op.changes;
    // DD-064: 結合範囲のセルは読むだけ（K3）。貼り付け・範囲の消去・cut は範囲のセルだけ飛ばす（readOnly 列・行と同じ）。
    if (merges.any()) {
      const kept = changes.filter((change) => !merges.isMergedCellId(change.rowId, change.columnId));
      const skipped = changes.length - kept.length;
      if (skipped > 0) {
        diag.emit('info', 'merged-cell-skipped', `${label}: 結合範囲のセル ${skipped} 件をスキップ（残り ${kept.length} 件）`);
      }
      changes = kept;
    }
    if (hasReadOnlyColumns()) {
      const partition = partitionReadOnlyColumnChanges(changes, isReadOnlyColumnId);
      if (partition.skipped > 0) {
        diag.emit(
          'info',
          'readonly-column-skipped',
          `${label}: readOnly 列のセル ${partition.skipped} 件をスキップ（残り ${partition.kept.length} 件）`,
        );
      }
      changes = partition.kept;
    }
    // DD-036 C3: 行版を続けて適用する（和＝列 or 行のどちらかに該当するセルがスキップされる）。
    if (hasReadOnlyRows()) {
      const partition = partitionReadOnlyRowChanges(changes, isReadOnlyRowId);
      if (partition.skipped > 0) {
        diag.emit(
          'info',
          'readonly-row-skipped',
          `${label}: readOnly 行のセル ${partition.skipped} 件をスキップ（残り ${partition.kept.length} 件）`,
        );
      }
      changes = partition.kept;
    }
    // RC3（DD-052-3）: 行データ指定のセル単位 readOnly を続けて適用する（和・standalone 専用）。
    if (hasReadOnlyCellRows()) {
      const partition = partitionReadOnlyCellChanges(changes, isReadOnlyCellId);
      if (partition.skipped > 0) {
        diag.emit(
          'info',
          'readonly-cell-skipped',
          `${label}: readOnly セル ${partition.skipped} 件をスキップ（残り ${partition.kept.length} 件）`,
        );
      }
      changes = partition.kept;
    }
    return changes.length === 0 ? null : { ...op, changes: [...changes] };
  }

  return {
    hasReadOnlyColumns,
    isReadOnlyColumnId,
    isReadOnlyColumnIndex,
    hasReadOnlyRows,
    isReadOnlyRowId,
    isReadOnlyRowIndex,
    isReadOnlyCellId,
    isReadOnlyCellIndex,
    hasReadOnlyCellRows,
    hasReadOnlyCells,
    isActiveCellReadOnly,
    isActiveCellMergedForNewInput,
    readOnlyEntryBlocked,
    validateReadOnlyRowsOnce,
    syncCellLock,
    filterReadOnlyCells,
  };
}
