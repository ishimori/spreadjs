// SetCells の送信の関所（確定単位 chokepoint）・Undo の記録・確定前の検証・行操作・行の再ベース（DD-065 区画⑦の前半）。
// 1 利用者操作 = 1 SetCells の全経路（IME 単一セル確定・範囲クリア・貼り付け・cut のクリア・候補欄・日付）がここを通る。

import { SETCELLS_MAX_CELLS, cloneCellScalar, displayRowOrder, getCell, validateOperation } from '@nanairo-sheet/core';
import type { DeleteRowsOperation, InsertRowsOperation, SetCellsOperation, SheetDocument } from '@nanairo-sheet/core';
import type { CellPosition } from '@nanairo-sheet/ime';
import { createRowId } from '@nanairo-sheet/types';
import type { ColumnId, OperationId, RowId } from '@nanairo-sheet/types';

import type { DiagnosticSink } from '../diagnostics';
import { cellScalarToDisplay } from '../document-view';
import type { GridConflictCode } from '../error-codes';
import type { GridBackend } from '../grid-backend';
import type { GridEvent, GridInvalidCell, GridMountOptions, GridRowStructureChange } from '../index';
import type { IntegrationEditor } from '../integration-editor';
import { touchesReadOnlyCell, touchesReadOnlyColumn, touchesReadOnlyRow } from '../readonly-policy';
import { rebaseRowIndex, resolveDeleteTargets } from '../row-operations';
import type { SelectionController } from '../selection-controller';
import type { UndoController, UndoPatch } from '../undo-stack';
import type { CellLock } from './cell-lock';
import { errorMessage } from './constants';
import type { CellValidationSource } from './constants';
import type { ReadOnlySwitch } from './readonly-switch';

export interface EditSubmitDeps {
  readonly diag: DiagnosticSink;
  readonly isStandalone: boolean;
  readonly wrapEnabled: boolean;
  readonly validateCell: GridMountOptions['validateCell'];
  readonly undoCtrl: UndoController;
  readonly selectionCtrl: SelectionController;
  readonly readonlySwitch: Pick<ReadOnlySwitch, 'isReadOnly' | 'isDeferredEditorCommit'>;
  readonly cellLock: Pick<
    CellLock,
    'hasReadOnlyRows' | 'isReadOnlyRowId' | 'hasReadOnlyColumns' | 'isReadOnlyColumnId' | 'hasReadOnlyCellRows' | 'isReadOnlyCellId'
  >;
  emit(event: GridEvent): void;
  isDestroyed(): boolean;
  backend(): GridBackend | undefined;
  editor(): IntegrationEditor | undefined;
  isFirstDataDrawn(): boolean;
}

/** 構造 flush 前に採取する再ベース材料（旧表示行順・再ベース対象の activeCell）。 */
export interface RebaseState {
  readonly oldOrder: string[];
  /** activeCell（Navigation 位相かつ非 composition のときのみ＝編集中は editingTarget placement が追従・I-3）。 */
  readonly active: CellPosition | undefined;
}

export interface EditSubmit {
  /** 確定単位の送信の関所（読み取り専用の破棄 → 確定前の検証 → Undo の捕捉 → submit）。 */
  submitSetCells(op: SetCellsOperation, validationSource?: CellValidationSource): OperationId | void;
  /** 低レベルの送信（元操作・補償操作の両方が使う。読み取り専用の絶対防衛線を持つ）。 */
  submitToBackend(backend: GridBackend, op: SetCellsOperation): OperationId | void;
  /** DD-063: consumer の validateCell で検証する。拒否するセルがあれば true（呼び出し側は submit しない）。 */
  rejectInvalidCells(op: SetCellsOperation, source: CellValidationSource): boolean;
  /** committed のセル lastChangedRevision（未書込=0）。 */
  cellRevision(committed: SheetDocument, rowId: RowId, columnId: ColumnId): number;
  /**
   * RC13: 単独モードの beforeCellCommit フック（submitSetCells が捕捉した逆値を、consumer 通知の前に記録する）。
   * 保留中の逆値は backend の有無にかかわらず消費する（次の submit へ漏らさない）。
   */
  recordPendingStandaloneUndo(backend: GridBackend | undefined): void;
  /** RC4: setRows 由来の再注入を Undo へ記録する（無関係な行の Redo 履歴を破棄しない）。 */
  recordProgrammaticUndo(backend: GridBackend, patches: UndoPatch[]): void;
  /** 行操作の実行前拒否の通知（共同編集モードだけ公開 rejected を出す）。 */
  notifyRowReject(code: GridConflictCode, diagCode: string, detail: string): void;
  performInsertRows(afterRowId: string | null, count: number): void;
  performDeleteRows(requested: readonly string[]): void;
  captureRebaseState(): RebaseState | null;
  applyRebaseState(state: RebaseState | null): void;
}

export function createEditSubmit(deps: EditSubmitDeps): EditSubmit {
  const { diag, isStandalone, undoCtrl, selectionCtrl, readonlySwitch, cellLock } = deps;
  // RC13（DD-052-4）: submitSetCells が捕捉した逆値パッチを、standalone の beforeCellCommit フックへ橋渡しする
  // 一時変数（submitToBackend 呼び出し1回のスコープでのみ有効。フック未消費なら submitSetCells 側で必ず null に戻す）。
  let pendingStandaloneUndoPatches: UndoPatch[] | null = null;

  /**
   * DD-063: consumer の `validateCell` で SetCells を検証する。拒否するセルがあれば true（呼び出し側は submit しない＝
   * 入力を捨てる）。空にする変更は検証しない（Excel の入力規則と同じ）。`validateCell` が例外を投げたセルは通す
   * （診断 error。consumer の不具合で入力そのものを止めない）。`cell-invalid` は確定処理（IME 状態機械の移動・
   * 貼り付け後の選択）が終わった後の microtask で出す: 同期で出すと、購読者が呼んだ setActiveCell 等が後続の移動に
   * 上書きされる（engineering-patterns #14）。
   */
  function rejectInvalidCells(op: SetCellsOperation, source: CellValidationSource): boolean {
    const validate = deps.validateCell;
    if (validate === undefined) {
      return false;
    }
    const invalid: GridInvalidCell[] = [];
    for (const change of op.changes) {
      if (change.value.kind === 'blank') {
        continue;
      }
      const rowId = String(change.rowId);
      const columnId = String(change.columnId);
      const value = cellScalarToDisplay(change.value);
      let message: unknown;
      try {
        message = validate({ rowId, columnId, value });
      } catch (error) {
        diag.emit('error', 'validate-cell-threw', `validateCell が例外を投げたため通します（${rowId}/${columnId}）: ${errorMessage(error)}`);
        continue;
      }
      if (typeof message === 'string') {
        invalid.push({ rowId, columnId, value, message });
      }
    }
    if (invalid.length === 0) {
      return false;
    }
    diag.emit('info', 'cell-invalid', `validateCell が ${invalid.length} 件を拒否（${source}・未 submit・文書無変更）`);
    queueMicrotask(() => {
      if (!deps.isDestroyed()) {
        deps.emit({ type: 'cell-invalid', source, cells: invalid });
      }
    });
    return true;
  }

  /**
   * SetCells を backend へ submit する **確定単位 chokepoint**（DD-020-2 → DD-020-3 引き継ぎ）。
   * DD-020-3（Undo/Redo）は submit 直前にここで committed から逆値を捕捉する hook を挿す（単一記録点）。
   * 単独モードは submitLocalOperation 内で cell-commit を通知する（onCellCommit→emit・DD-024 決定②）。
   * ローカル楽観適用の直後に、変更行の自動行高を再計算する（D5 トリガー②＝ローカル・SetCells のみ）。
   * @param validationSource DD-063: 確定前の検証をする経路（IME/textarea・選択式・日付）。読み取り専用の破棄の**後**・
   * Undo 捕捉の**前**で検証する（読み取り専用が先に効き、拒否した入力は Undo に積まない）。範囲クリア・cut（空にする
   * 変更）と、手前で検証済みの貼り付けは渡さない。
   */
  function submitSetCells(op: SetCellsOperation, validationSource?: CellValidationSource): OperationId | void {
    const backend = deps.backend();
    if (backend === undefined) {
      return;
    }
    // DD-033-1（統合レビュー P2-2）: readOnly は undo 捕捉より前に破棄する。submitToBackend（絶対防衛線）だけだと
    // op は破棄されるのに undo エントリが積まれ canUndo=false（AC2）が破れる（standalone は submit 結果を見ず記録するため）。
    // DD-056 H12: 変換の終わり待ち（readOnlyDeferred）の間に状態機械が出す編集中セルの確定（editorSubmit 経由）だけは通す。
    if (readonlySwitch.isReadOnly() && !readonlySwitch.isDeferredEditorCommit()) {
      diag.emit('warn', 'readonly-blocked', 'readOnly: submitSetCells で SetCells を破棄（undo 記録前）');
      return;
    }
    // DD-036 C3: readOnly 行版の保証層（列版と同型・undo 記録前）。
    if (cellLock.hasReadOnlyRows() && touchesReadOnlyRow(op.changes, cellLock.isReadOnlyRowId)) {
      diag.emit('warn', 'readonly-row-blocked', 'readOnlyRows: submitSetCells で readOnly 行への SetCells を破棄（undo 記録前）');
      return;
    }
    // DD-035 R4: readOnly 列への変更を含む SetCells は op 全体を破棄する（保証層・undo 記録前）。範囲操作は
    // filterReadOnlyCells で事前にスキップ済みのため、ここへ到達するのは入口をすり抜けた経路＝warn。
    if (cellLock.hasReadOnlyColumns() && touchesReadOnlyColumn(op.changes, cellLock.isReadOnlyColumnId)) {
      diag.emit('warn', 'readonly-column-blocked', 'readOnlyColumns: submitSetCells で readOnly 列への SetCells を破棄（undo 記録前）');
      return;
    }
    // RC3（DD-052-3）: 行データ指定のセル単位 readOnly の保証層（列版・行版と同型・undo 記録前・standalone 専用）。
    if (cellLock.hasReadOnlyCellRows() && touchesReadOnlyCell(op.changes, cellLock.isReadOnlyCellId)) {
      diag.emit('warn', 'readonly-cell-blocked', 'readOnly セル: submitSetCells で SetCells を破棄（undo 記録前）');
      return;
    }
    // DD-063: 確定前の検証（入力を捨てて cell-invalid で通知・Undo には積まない）。
    if (validationSource !== undefined && rejectInvalidCells(op, validationSource)) {
      return;
    }
    // DD-020-3: submit 直前に **view（committed＋own pending）** から逆値（前値）を捕捉する（単一記録点＝両モード同一経路）。
    // committed ではなく view を使うのは、直前の未 ACK 楽観編集を飛ばさないため（Codex P1: 連続編集の逆値正しさ）。
    const patches = captureUndoPatches(backend.session.viewDocument, op);
    if (isStandalone) {
      // RC13（DD-052-4）: standalone は submitToBackend の内側（submitLocalOperation）で beforeCellCommit フックが
      // 同期発火し、そこで記録を完了させる（onCellCommit 通知より前＝consumer の同期 setData に壊されない）。
      pendingStandaloneUndoPatches = patches;
    }
    const id = submitToBackend(backend, op);
    if (isStandalone) {
      // フックで消費済みなら既に null。changeSet 空等でフックが記録しなかった場合に備え、次回submitへ漏らさない。
      pendingStandaloneUndoPatches = null;
    } else {
      recordUndoEntry(backend, patches, id);
    }
    return id;
  }

  /** SetCells を backend へ submit し wrap 行高を再計算する低レベル経路（元操作・補償操作の両方が使う）。 */
  function submitToBackend(backend: GridBackend, op: SetCellsOperation): OperationId | void {
    // DD-033-1: 絶対防衛線（chokepoint）。readOnly では SetCells 系（IME 確定・paste・cut・範囲クリア・Undo/Redo
    // 補償）の唯一の submit 点である本関数で op を破棄する＝入口抑止をすり抜けた synthetic 経路や将来の編集入口でも
    // 文書 Operation 送信ゼロを構造的に保証する（共同編集の受信専用化・AC5）。入口ガード（perform*・interceptKeydown）で
    // 通常はここへ到達しないため diag は warn（到達自体が想定外＝障害切り分けの手掛かり）。
    // DD-056 H12: 変換の終わり待ちの間の編集中セルの確定（editorSubmit 経由）だけは通す（submitSetCells と同じ判定）。
    if (readonlySwitch.isReadOnly() && !readonlySwitch.isDeferredEditorCommit()) {
      diag.emit('warn', 'readonly-blocked', 'readOnly: submitToBackend で SetCells を破棄（絶対防衛線・送信ゼロ）');
      return;
    }
    // DD-036 C3: 絶対防衛線の行版（列版と同型・Undo/Redo 補償を含む全 SetCells が通る）。
    if (cellLock.hasReadOnlyRows() && touchesReadOnlyRow(op.changes, cellLock.isReadOnlyRowId)) {
      diag.emit('warn', 'readonly-row-blocked', 'readOnlyRows: submitToBackend で readOnly 行への SetCells を破棄（絶対防衛線）');
      return;
    }
    // DD-035 R4: 絶対防衛線（Undo/Redo 補償を含む全 SetCells）。readOnly 列への変更を含めば op 全体を破棄する。
    if (cellLock.hasReadOnlyColumns() && touchesReadOnlyColumn(op.changes, cellLock.isReadOnlyColumnId)) {
      diag.emit('warn', 'readonly-column-blocked', 'readOnlyColumns: submitToBackend で readOnly 列への SetCells を破棄（絶対防衛線）');
      return;
    }
    // RC3（DD-052-3）: 絶対防衛線のセル版（列版・行版と同型・standalone 専用）。
    if (cellLock.hasReadOnlyCellRows() && touchesReadOnlyCell(op.changes, cellLock.isReadOnlyCellId)) {
      diag.emit('warn', 'readonly-cell-blocked', 'readOnly セル: submitToBackend で SetCells を破棄（絶対防衛線）');
      return;
    }
    const id = backend.session.submitLocalOperation(op);
    if (deps.wrapEnabled) {
      backend.view.recomputeAutoRowHeightsForRows(op.changes.map((c) => c.rowId));
    }
    return id;
  }

  /** op の各対象セルについて submit 直前 view の値を逆値（before）・op の設定値を順値（after）として組む（DD-020-3）。 */
  function captureUndoPatches(source: SheetDocument, op: SetCellsOperation): UndoPatch[] {
    return op.changes.map((change) => ({
      rowId: change.rowId,
      columnId: change.columnId,
      before: cloneCellScalar(getCell(source, change.rowId, change.columnId)?.value ?? { kind: 'blank' }),
      after: cloneCellScalar(change.value),
    }));
  }

  /** committed のセル lastChangedRevision（未書込=0）。standalone 即時確定 revision の読取に使う（DD-020-3）。 */
  function cellRevision(committed: SheetDocument, rowId: RowId, columnId: ColumnId): number {
    return getCell(committed, rowId, columnId)?.lastChangedRevision ?? 0;
  }

  /**
   * 元操作の undo エントリを記録する（collab 専用。standalone は RC13 の beforeCellCommit フック経由で
   * recordStandaloneUndoEntry を使う）。collab は opId で後追い ACK。submit が同期 reject された op
   * （rebuildView が編集開始 revision の stale を submit 中に判定）は pending に残らない →
   * **undo エントリに入れない**（AC5・Codex P2: 誤記録＋redo 誤破棄を防ぐ）。
   */
  function recordUndoEntry(backend: GridBackend, patches: UndoPatch[], id: OperationId | void): void {
    if (patches.length === 0) {
      return;
    }
    if (id !== undefined && backend.session.pendingOperationIds().some((p) => String(p) === String(id))) {
      undoCtrl.recordUserOp(id, patches, null);
    }
  }

  /**
   * RC13（DD-052-4）: standalone の undo エントリを即時確定 revision で記録する。`StandaloneSession` の
   * `beforeCellCommit` フックから、`onCellCommit`（consumer 通知）より**前**に同期で呼ばれる。これにより
   * consumer が `onCellCommit` 内で同期的に `setData` を呼んでも、Undo 記録は既に完了しており、`setData` の
   * Undo 全消去（`undoCtrl.clear()`）が幽霊エントリを残さず正しく効く（従来は notify 後に記録していたため
   * 消去済みスタックへ記録してしまっていた）。
   * @param isProgrammatic RC4（Codex P2）: true なら `setRows` 由来の再注入として記録し、無関係な行の
   * Redo 履歴を破棄しない（`undoCtrl.recordProgrammaticOp`）。既定 false は利用者の手入力確定として扱い、
   * 従来どおり Redo スタック全体を破棄する（`undoCtrl.recordUserOp`）。
   */
  function recordStandaloneUndoEntry(backend: GridBackend, patches: UndoPatch[], isProgrammatic = false): void {
    if (patches.length === 0) {
      return;
    }
    const first = patches[0]!;
    const ackedRevision = cellRevision(backend.session.committedDocument, first.rowId, first.columnId);
    if (isProgrammatic) {
      undoCtrl.recordProgrammaticOp(patches, ackedRevision);
    } else {
      undoCtrl.recordUserOp(null, patches, ackedRevision);
    }
  }

  // ---- 行操作（Insert/Delete）公開層（DD-021-1）----
  /** 行構造変更を利用側へ通知する（両モード共通・standalone の保存材料。cell-commit はセル値専用のまま）。 */
  function emitRowStructureChange(change: GridRowStructureChange): void {
    deps.emit({ type: 'row-structure-change', change });
  }

  /**
   * 行操作の実行前拒否の通知（DD-020 の notifyPreExecutionReject と同型）。診断は常に出す。公開 rejected は
   * **共同編集モードのみ**発火する（standalone は client 実行前拒否を server 競合経路へ混ぜない＝DD-024 契約・
   * consumer が collab 競合と誤認しないため）。operationId は空＝未 submit。
   */
  function notifyRowReject(code: GridConflictCode, diagCode: string, detail: string): void {
    diag.emit('warn', diagCode, detail);
    if (isStandalone) {
      return;
    }
    deps.emit({
      type: 'rejected',
      pendingCount: deps.backend()?.session.pendingCount ?? 0,
      conflict: { operationId: '', reason: 'rejected', code },
    });
  }

  /**
   * 行挿入（公開 API・ショートカット共有）。afterRowId 直後へ count 行を挿入する。新 RowId は crypto.randomUUID。
   * count≦0/非整数・未知アンカーは submit せず実行前拒否（AC8）。楽観適用直後に row-structure-change を発火する。
   */
  function performInsertRows(afterRowId: string | null, count: number): void {
    // DD-033-1: readOnly は行挿入を抑止（公開 API・ショートカット共有＝1箇所で両方止まる・入口＝chokepoint 兼用）。
    if (readonlySwitch.isReadOnly()) {
      diag.emit('info', 'readonly-blocked', 'readOnly: insertRows を抑止（文書無変更）');
      return;
    }
    const backend = deps.backend();
    if (backend === undefined) {
      return; // boot 未完了 → 黙って無視（既存 API 流儀）
    }
    // stopped（再接続窓超過で終端）セッションへの submit は throw する（collab session 契約）。公開 API・
    // ショートカットは「同期 throw しない」契約のため no-op＋診断にする（performUndo/Redo と同型・Fable P2）。
    if (backend.session.isStopped) {
      diag.emit('warn', 'insert-session-stopped', 'insertRows: セッション停止中（stopped）のため無視');
      return;
    }
    // 上限は SetCells のセル数上限と同値を流用（1 op の実行前ガード・R-08 と同型）。上限なしだと
    // count=2^32 で Array.from が同期 RangeError・1e8 程度でも UI フリーズ/巨大 envelope 送信になる（Fable P2）。
    if (!Number.isInteger(count) || count <= 0 || count > SETCELLS_MAX_CELLS) {
      notifyRowReject(
        'row-count-invalid',
        'insert-count-invalid',
        `insertRows: count=${count}（1〜${SETCELLS_MAX_CELLS} の整数が必要）`,
      );
      return;
    }
    const anchor = afterRowId === null ? null : createRowId(afterRowId);
    const rowIds = Array.from({ length: count }, () => crypto.randomUUID());
    const op: InsertRowsOperation = {
      type: 'insertRows',
      afterRowId: anchor,
      rows: rowIds.map((id) => ({ rowId: createRowId(id) })),
    };
    // アンカー検証は view（committed＋own pending）に対して行う（own 楽観挿入直後のアンカーも有効）。
    // UUID 採番ゆえ duplicate-row は起きず、違反は unknown-anchor のみ→公開 row-anchor-unknown へ写す。
    if (validateOperation(backend.session.viewDocument, op).length > 0) {
      notifyRowReject('row-anchor-unknown', 'insert-anchor-unknown', `insertRows: 未知アンカー afterRowId=${afterRowId}`);
      return;
    }
    backend.session.submitLocalOperation(op);
    // 構造 dirty を確実に立てて楽観再描画する（standalone は submit 内で既に立つ・冪等。collab は server echo を待たず即描画）。
    backend.view.noteOperation(op);
    emitRowStructureChange({ kind: 'insert', afterRowId, rowIds });
  }

  /**
   * 行削除（公開 API・ショートカット共有）。実在（非 tombstone）行のみ tombstone 化し row-structure-change を発火する。
   * 対象皆無は実行前拒否（AC8）。削除後、アクティブ行が消えていれば最近傍生存行（下優先→上）へ縮退する（親④・AC5）。
   */
  function performDeleteRows(requested: readonly string[]): void {
    // DD-033-1: readOnly は行削除を抑止（公開 API・ショートカット共有＝入口＝chokepoint 兼用）。
    if (readonlySwitch.isReadOnly()) {
      diag.emit('info', 'readonly-blocked', 'readOnly: deleteRows を抑止（文書無変更）');
      return;
    }
    const backend = deps.backend();
    if (backend === undefined) {
      return;
    }
    if (backend.session.isStopped) {
      diag.emit('warn', 'delete-session-stopped', 'deleteRows: セッション停止中（stopped）のため無視');
      return;
    }
    const oldOrder = displayRowOrder(backend.session.viewDocument).map(String);
    const targets = resolveDeleteTargets(oldOrder, requested);
    if (targets.length === 0) {
      notifyRowReject('row-delete-empty', 'delete-empty', `deleteRows: 削除対象なし（要求 ${requested.length} 件）`);
      return;
    }
    const op: DeleteRowsOperation = { type: 'deleteRows', rowIds: targets.map((id) => createRowId(id)) };
    backend.session.submitLocalOperation(op);
    backend.view.noteOperation(op);
    emitRowStructureChange({ kind: 'delete', rowIds: targets });
    // activeCell / 選択の縮退は masterLoop の構造 flush で一本化して行う（K3 再ベース・親④・DD-021-3）。
    // ローカル/リモート問わず「構造変更前に指していた RowId」を新 Axis へ引き直すため、ここでは個別処理しない。
  }

  // ---- K3 選択・activeCell 再ベース（DD-021-3・案b＝grid 層 hook・状態機械無変更）----
  /** 現在の（再構築前の）表示行 Axis の RowId 列（文字列）。 */
  function currentAxisRowIds(): string[] {
    const sync = deps.backend();
    if (sync === undefined) {
      return [];
    }
    const axis = sync.view.rowAxis;
    const ids: string[] = [];
    const count = axis.count();
    for (let i = 0; i < count; i += 1) {
      ids.push(String(axis.getId(i)));
    }
    return ids;
  }

  /**
   * 構造 flush の**前**に、現在指している RowId を旧 Axis から採取する（K3）。初回 bootstrap 構築（firstDataDrawn=false）
   * や空 Axis は再ベースしない（新規構築であり「指していた行」が無い）。編集中/変換中は activeCell を対象にしない
   * （editingTarget ベースの placement が編集セルを追従・pointerdownCell は commit を誘発するため触らない・I-3）。
   */
  function captureRebaseState(): RebaseState | null {
    if (deps.backend() === undefined || !deps.isFirstDataDrawn()) {
      return null;
    }
    const oldOrder = currentAxisRowIds();
    if (oldOrder.length === 0) {
      return null;
    }
    const editor = deps.editor();
    const eligibleActive = editor !== undefined && !editor.session.isComposing() && editor.session.getPhase() === 'Navigation';
    return { oldOrder, active: eligibleActive ? editor!.session.getActiveCell() : undefined };
  }

  /**
   * 構造 flush の**後**に、採取した RowId を新 Axis の index へ引き直して activeCell/選択レンジを補正する（K3）。
   * activeCell 行が削除されていれば最近傍生存行（下優先→上・親④）へ縮退、生存行皆無なら選択解除。列は不変。
   */
  function applyRebaseState(state: RebaseState | null): void {
    const sync = deps.backend();
    if (state === null || sync === undefined) {
      return;
    }
    const newOrder = currentAxisRowIds();
    // 選択レンジ（明示レンジがあるときだけ効く）。両端を RowId で追従し、生存行皆無なら単一選択へ縮退。
    if (selectionCtrl.rebaseRows((row) => rebaseRowIndex(state.oldOrder, newOrder, row))) {
      sync.view.markViewportDirty();
    }
    const active = state.active;
    const editor = deps.editor();
    if (active === undefined || editor === undefined || active.row >= state.oldOrder.length) {
      return;
    }
    // flush 前後で phase は不変だが防御的に再確認（editing/composing へ遷移していたら触らない・I-3）。
    if (editor.session.isComposing() || editor.session.getPhase() !== 'Navigation') {
      return;
    }
    const newRow = rebaseRowIndex(state.oldOrder, newOrder, active.row);
    if (newRow === null) {
      editor.pointerdownCell(null); // 生存行なし → 選択解除
      return;
    }
    if (newRow === active.row) {
      return; // index 不変（挿入が下・削除が下）→ カーソルを触らない
    }
    diag.emit('info', 'rebase-active-cell', `K3: activeCell 行 ${active.row}→${newRow}（RowId 追従）`);
    editor.pointerdownCell({ row: newRow, col: active.col });
  }

  return {
    submitSetCells,
    submitToBackend,
    rejectInvalidCells,
    cellRevision,
    recordPendingStandaloneUndo(backend) {
      const patches = pendingStandaloneUndoPatches;
      pendingStandaloneUndoPatches = null;
      if (patches !== null && backend !== undefined) {
        recordStandaloneUndoEntry(backend, patches);
      }
    },
    recordProgrammaticUndo(backend, patches) {
      recordStandaloneUndoEntry(backend, patches, true);
    },
    notifyRowReject,
    performInsertRows,
    performDeleteRows,
    captureRebaseState,
    applyRebaseState,
  };
}
