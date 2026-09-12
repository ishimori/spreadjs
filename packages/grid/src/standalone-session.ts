// StandaloneSession（DD-024・内部方式 案B）: 共同編集サーバー無しで動く単独グリッドモードの backend。
//
// ClientSession/transport を一切生成せず、core の SheetDocument を 1 つだけ保持して applyOperation で更新する。
// DocumentView は `getDocument: () => doc` で本ホルダーを読む（描画/IME 資産は共同編集と共有）。
// 確定（SetCells）のたびに before/after の表示文字列を計算し onCellCommit へ渡す（→ mount-controller が
// cell-commit イベントを emit する・決定②「通知のみ」）。setData で文書を丸ごと再注入する（決定③）。
//
// connection/pending/presence/heartbeat を持たないため AC6（共同編集専用面の非発火）は構造的に保証される
// （契約: doc/DD/DD-024/standalone-contract.md §5）。

import { applyOperation, createDocument, displayRowOrder, getCell, parseCellInput } from '@nanairo-sheet/core';
import type { CellScalar, DocumentOperation, InsertRowsOperation, SetCellsChange, SetCellsOperation, SheetDocument } from '@nanairo-sheet/core';
import { createColumnId, createRowId } from '@nanairo-sheet/types';
import type { ColumnId, OperationId } from '@nanairo-sheet/types';
import type { TextMetricsCache } from '@nanairo-sheet/render';

import { DocumentView, cellScalarToDisplay } from './document-view';
import type { GridBackend, GridBackendSession } from './grid-backend';
import type { GridCellCommitChange, GridStandaloneData, GridStandaloneRow } from './index';
import type { UndoPatch } from './undo-stack';

/** RC4: setRows の適用結果。 */
export interface StandaloneRowsResult {
  /** 実際に値が変わったセル（既存行の変更＋新規行の初期値）。UndoPatch そのもの＝呼び出し側がそのまま記録できる。 */
  readonly changes: readonly UndoPatch[];
  /** 新規追加された行数（末尾へ追加・行挿入自体は既存の Undo/Redo 対象外＝行操作と同運用）。 */
  readonly insertedRowCount: number;
}

/** 2つの CellScalar が同値か（kind とその値の完全一致）。 */
function sameCellScalar(a: CellScalar, b: CellScalar): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  return a.kind === 'blank' || a.value === (b as { value: string | number }).value;
}

export interface StandaloneSessionConfig {
  /** 列順（ColumnId 文字列・mount options.columnOrder）。 */
  readonly columnOrder: readonly string[];
  /** mount 時の初期データ（決定③）。 */
  readonly initialData?: GridStandaloneData;
  readonly rowHeight: number;
  readonly colWidth: number;
  readonly columnWidths?: Readonly<Record<string, number>>;
  readonly rowHeights?: Readonly<Record<string, number>>;
  readonly wrapColumns?: readonly string[];
  /** RC12（DD-052-2）: 文字列として保つ列（型変換をスキップ）。 */
  readonly stringColumns?: readonly string[];
  readonly wrapCache?: TextMetricsCache;
  readonly cellFont?: string;
  readonly lineHeight?: number;
  /** 確定値（SetCells）が適用されたら表示文字列の batch を通知する（mount-controller が cell-commit へ写す）。 */
  readonly onCellCommit: (changes: readonly GridCellCommitChange[]) => void;
  /**
   * RC13（DD-052-4）: SetCells 適用直後・`onCellCommit` 通知の**前**に呼ぶ（setCells 系操作なら changeSet が
   * 空でも常に呼ぶ）。mount-controller が Undo 記録をここで完了させる。`onCellCommit` 内で consumer が同期的に
   * `setData` を呼んでも、その時点で Undo 記録は既に終わっている（`setData` の Undo 全消去が正しく効く）。
   */
  readonly beforeCellCommit?: () => void;
}

/** 単独モードの backend（GridBackend）＋ 再注入 API。 */
export interface StandaloneSession extends GridBackend {
  /** 文書を丸ごと再注入する（決定③・setData）。Render を全再構築する。 */
  setData(data: GridStandaloneData): void;
  /** RC3（DD-052-3）: このセルは行データ（`GridStandaloneRow.readOnlyColumns`）で読み取り専用に指定されているか。 */
  isCellReadOnly(rowId: string, columnId: string): boolean;
  /** RC3: 1件でも行単位の読み取り専用セルが指定されているか（呼び出し側の早期リターン用）。 */
  hasAnyCellReadOnly(): boolean;
  /**
   * RC4（DD-052-4）: 行単位の部分更新（`setData` と違い、渡した行だけを置換・追加し他の行はそのまま）。
   * 既存行は `cells` に含まれる列だけを診断（値が変わらないセルは触れない＝Undo 対象に入れない）。
   * 未知の RowId は新規行として末尾へ追加する。`readOnlyColumns` は明示指定した行だけ置き換える
   * （未指定ならその行の既存指定を保つ）。readOnly（列/行/セル）は `setData` と同様に無視して適用する
   * （プログラム的な再注入は利用者編集の抑止対象ではない）。未知列は静かにスキップする。
   * 削除済み（`deleteRows` 済み）の RowId が再度渡された場合は再利用不可として静かに無視する
   * （core の insertRows は既存 RowId の再利用に対応しない）。
   */
  setRows(rows: readonly GridStandaloneRow[]): StandaloneRowsResult;
}

/** CellScalar | undefined を表示文字列へ（undefined=未書込セル=空）。 */
function displayOf(value: CellScalar | undefined): string {
  return value === undefined ? '' : cellScalarToDisplay(value);
}

export function createStandaloneSession(config: StandaloneSessionConfig): StandaloneSession {
  const columnIds: ColumnId[] = config.columnOrder.map((c) => createColumnId(c));
  const knownColumns = new Set<string>(config.columnOrder);
  const stringColumns = new Set<string>(config.stringColumns ?? []);
  // RC3（DD-052-3）: 行単位の読み取り専用列（RowId 文字列→ColumnId 文字列集合）。setData のたびに丸ごと再構築する
  // （決定③「文書を丸ごと再注入」と同じ扱い＝古い行の指定を引きずらない）。
  let cellReadOnly = new Map<string, ReadonlySet<string>>();
  // 適用ごとに単調増加する revision（cell 単位 lastChangedRevision の源。共同編集の server revision に相当）。
  let revision = 0;
  let doc: SheetDocument = buildDocument(config.initialData);

  const view = new DocumentView({
    getDocument: () => doc,
    rowHeight: config.rowHeight,
    colWidth: config.colWidth,
    ...(config.columnWidths !== undefined ? { columnWidths: config.columnWidths } : {}),
    ...(config.rowHeights !== undefined ? { rowHeights: config.rowHeights } : {}),
    ...(config.wrapColumns !== undefined ? { wrapColumns: config.wrapColumns } : {}),
    ...(config.wrapCache !== undefined ? { wrapCache: config.wrapCache } : {}),
    ...(config.cellFont !== undefined ? { cellFont: config.cellFont } : {}),
    ...(config.lineHeight !== undefined ? { lineHeight: config.lineHeight } : {}),
  });

  /** GridStandaloneData → SheetDocument（行を順に挿入し、既知列のセル値を parseCellInput で設定する）。 */
  function buildDocument(data: GridStandaloneData | undefined): SheetDocument {
    // revision は文書差し替えでも必ず前進させる（Codex[P2]: 空注入で revision が 0 へ後退すると contract §5 の
    // 単調増加不変を破り、staleness 判定〔lastChangedRevision 比較〕が誤動作しうる）。
    revision += 1;
    let next = createDocument(columnIds);
    next.revision = revision;
    // RC3: 文書を丸ごと差し替えるたびに行単位 readOnly も丸ごと再構築する（古い行の指定を引きずらない）。
    cellReadOnly = new Map<string, ReadonlySet<string>>();
    const rows = data?.rows ?? [];
    if (rows.length === 0) {
      return next;
    }
    // rowId 重複は rowOrder を壊すため先着で dedupe する（consumer データ事故に対する防御・Experimental）。
    const seenRows = new Set<string>();
    const uniqueRows = rows.filter((r) => {
      if (seenRows.has(r.rowId)) {
        return false;
      }
      seenRows.add(r.rowId);
      return true;
    });
    revision += 1;
    const insertOp: InsertRowsOperation = {
      type: 'insertRows',
      afterRowId: null,
      rows: uniqueRows.map((r) => ({ rowId: createRowId(r.rowId) })),
    };
    next = applyOperation(next, insertOp, { revision }).document;

    const changes: SetCellsChange[] = [];
    for (const row of uniqueRows) {
      // RC3: 行単位の読み取り専用列（未知列は静かにスキップ・cells と同じ扱い）。
      if (row.readOnlyColumns !== undefined && row.readOnlyColumns.length > 0) {
        const known = row.readOnlyColumns.filter((c) => knownColumns.has(c));
        if (known.length > 0) {
          cellReadOnly.set(row.rowId, new Set(known));
        }
      }
      if (row.cells === undefined) {
        continue;
      }
      for (const [columnId, value] of Object.entries(row.cells)) {
        // 未知列（columnOrder 外）は静かにスキップする（applyOperation の ApplyError で全体を落とさない）。
        if (!knownColumns.has(columnId)) {
          continue;
        }
        changes.push({
          rowId: createRowId(row.rowId),
          columnId: createColumnId(columnId),
          value: parseCellInput(value, { forceString: stringColumns.has(columnId) }),
        });
      }
    }
    if (changes.length > 0) {
      revision += 1;
      next = applyOperation(next, { type: 'setCells', conflictPolicy: 'reject-overlap', changes }, { revision }).document;
    }
    return next;
  }

  const session: GridBackendSession = {
    submitLocalOperation(operation: DocumentOperation): OperationId | void {
      revision += 1;
      const result = applyOperation(doc, operation, { revision });
      doc = result.document;
      // Render State を Document State へ追従させる（setCells=cell dirty / insert・delete=structure dirty）。
      // 共同編集の observer が server message で行う dirty 立てを、単独モードはローカル適用時に行う。
      view.noteOperation(operation);
      if (operation.type === 'setCells') {
        // RC13: changeSet が空（実質 no-op）でも Undo 記録のタイミングは維持する（onCellCommit の通知条件とは独立）。
        config.beforeCellCommit?.();
        if (result.changeSet.cells.length > 0) {
          const changes: GridCellCommitChange[] = result.changeSet.cells.map((change) => ({
            rowId: String(change.rowId),
            columnId: String(change.columnId),
            value: displayOf(change.after),
            previousValue: displayOf(change.before),
          }));
          config.onCellCommit(changes);
        }
      }
      // 構造Op（insert/delete）は cell-commit 対象外。Render 追従は呼び出し側（editor onChange / recompute）が担う。
      return undefined;
    },
    get committedDocument(): SheetDocument {
      return doc;
    },
    // 単独モードは楽観 pending が無く、committed が唯一の文書＝view と同一（DD-020-3 Undo の逆値捕捉元）。
    get viewDocument(): SheetDocument {
      return doc;
    },
    // 単独モードは pending を持たない（即時確定）＝常に空（DD-020-3 Undo の同期 reject 検出は collab のみ意味を持つ）。
    pendingOperationIds: () => [],
    knownPresences: () => [],
    sendPresence: () => {
      // 単独モードは presence 無し（no-op）。
    },
    tick: () => {
      // 単独モードは再送/catch-up 無し（no-op）。
    },
    sendHeartbeat: () => {
      // 単独モードは生存通知無し（no-op）。
    },
    isOnline: false,
    isStopped: false,
    pendingCount: 0,
    conflictQueue: [],
    bootstrapRevision: 0,
    appliedServerOpCount: 0,
  };

  return {
    view,
    session,
    start(): void {
      // 初期データは buildDocument で既に確定済み。Render は最初の flush（structural dirty）で構築される。
      view.markFullRebuild();
    },
    setData(data: GridStandaloneData): void {
      doc = buildDocument(data);
      // 文書差し替え → 行順・全セルが変わりうるため Render を全再構築する（決定③）。
      view.markFullRebuild();
    },
    isCellReadOnly(rowId: string, columnId: string): boolean {
      return cellReadOnly.get(rowId)?.has(columnId) === true;
    },
    hasAnyCellReadOnly(): boolean {
      return cellReadOnly.size > 0;
    },
    setRows(rows: readonly GridStandaloneRow[]): StandaloneRowsResult {
      const existingRowIds = new Set<string>();
      // DD-052-4（Codex P1）: tombstone 済み（削除済み）の RowId は「未知」ではない。core の insertRows は
      // 既存 RowId の再利用を前提としておらず（rowOrder に重複が入る）、渡すと displayRowOrder が同一行を
      // 二重に返す実害があった。deletedRowIds として別集合に分け、新規行の判定にもセル diff にも使わない
      // （＝削除済み RowId の再利用は静かに無視する。未知列と同じ「呼び出し側データ事故への防御」扱い）。
      const deletedRowIds = new Set<string>();
      for (const rowId of doc.rowMeta.keys()) {
        if (doc.rowMeta.get(rowId)?.tombstone === true) {
          deletedRowIds.add(String(rowId));
        } else {
          existingRowIds.add(String(rowId));
        }
      }
      const newRows = rows.filter((r) => !existingRowIds.has(r.rowId) && !deletedRowIds.has(r.rowId));
      // 重複 RowId は先着で dedupe する（buildDocument と同じ防御・consumer データ事故対策）。
      const seenNew = new Set<string>();
      const uniqueNewRows = newRows.filter((r) => (seenNew.has(r.rowId) ? false : (seenNew.add(r.rowId), true)));

      if (uniqueNewRows.length > 0) {
        revision += 1;
        // 末尾へ追加する: afterRowId=null は「先頭（index 0）」の意味（core の規約）なので、既存の最終行を
        // 明示的にアンカーにする（文書が空なら null=先頭のままで問題ない）。
        const order = displayRowOrder(doc);
        const anchor = order.length > 0 ? order[order.length - 1]! : null;
        const insertOp: InsertRowsOperation = {
          type: 'insertRows',
          afterRowId: anchor,
          rows: uniqueNewRows.map((r) => ({ rowId: createRowId(r.rowId) })),
        };
        doc = applyOperation(doc, insertOp, { revision }).document;
      }

      const changes: UndoPatch[] = [];
      const setCellsChanges: SetCellsChange[] = [];
      for (const row of rows) {
        if (deletedRowIds.has(row.rowId)) {
          continue; // 削除済み RowId の再利用（上記参照）: readOnlyColumns 更新もセル diff も行わない
        }
        // RC3: 明示指定した行だけ readOnlyColumns を置き換える（未指定は既存指定を保つ）。
        if (row.readOnlyColumns !== undefined) {
          const known = row.readOnlyColumns.filter((c) => knownColumns.has(c));
          if (known.length > 0) {
            cellReadOnly.set(row.rowId, new Set(known));
          } else {
            cellReadOnly.delete(row.rowId);
          }
        }
        if (row.cells === undefined) {
          continue;
        }
        const rowId = createRowId(row.rowId);
        for (const [columnId, value] of Object.entries(row.cells)) {
          if (!knownColumns.has(columnId)) {
            continue; // 未知列は静かにスキップ（buildDocument と同じ扱い）
          }
          const colId = createColumnId(columnId);
          const before = getCell(doc, rowId, colId)?.value ?? { kind: 'blank' };
          const after = parseCellInput(value, { forceString: stringColumns.has(columnId) });
          if (sameCellScalar(before, after)) {
            continue; // RC4: 値が変わらないセルには触れない（Undo 対象に入れない）
          }
          changes.push({ rowId, columnId: colId, before, after });
          setCellsChanges.push({ rowId, columnId: colId, beforeRevision: 0, value: after });
        }
      }

      if (setCellsChanges.length > 0) {
        revision += 1;
        const op: SetCellsOperation = { type: 'setCells', conflictPolicy: 'reject-overlap', changes: setCellsChanges };
        doc = applyOperation(doc, op, { revision }).document;
      }
      if (uniqueNewRows.length > 0 || setCellsChanges.length > 0) {
        view.markFullRebuild(); // 行の追加・値の変更をまとめて反映（部分 dirty より単純・呼び出し頻度は低い想定）
      }
      return { changes, insertedRowCount: uniqueNewRows.length };
    },
  };
}
