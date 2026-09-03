// grid Facade の内部レジストリ（test-support 経由の E2E 検査用）。
//
// 公開 GridInstance は最小面（documentId/connectionState/subscribe/focus/destroy）に留め、E2E が必要とする
// 深い introspection（committedHash・pendingCount・editingTarget・行操作 submit・断線注入 等）は本レジストリ経由で
// `@nanairo-sheet/grid/test-support` からのみ取得できる。mount() が debug オブジェクトを構築して登録する。
// 本ファイルは公開エントリ（index.ts）ではないため boundary R7 の対象外（DD-016・check.mjs）。

import type { GridInstance } from './index';

/** E2E 検査用 introspection API（旧 apps/playground の __integrationTestApi 契約を Facade 内へ移設）。 */
export interface GridDebugCellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface GridDebugCellAddress {
  rowId: string;
  columnId: string;
}
export interface GridDebugSelectionRange {
  startRowId: string;
  startColumnId: string;
  endRowId: string;
  endColumnId: string;
}
export interface GridDebugPresenceView {
  displayName: string;
  activeCell: GridDebugCellAddress | null;
  editingCell: GridDebugCellAddress | null;
  selectionRanges: GridDebugSelectionRange[];
}

/** 表示 index の矩形範囲（半開区間・DD-020-1 範囲選択の観測用）。 */
export interface GridDebugCellRange {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

/** grid Facade の深い introspection API（test-support 経由・E2E 専用）。 */
export interface GridDebugApi {
  ready(): boolean;
  online(): boolean;
  connectionState(): 'online' | 'offline' | 'stopped' | 'standalone';
  lastEventType(): string;
  rowCount(): number;
  committedRevision(): number;
  committedHash(): string;
  pendingCount(): number;
  conflictCount(): number;
  divertedCount(): number;
  knownPresenceCount(): number;
  bootstrapRevision(): number;
  appliedServerOpCount(): number;
  presences(): GridDebugPresenceView[];
  isConflicting(): boolean;
  /** K4（DD-021-2）: 編集対象行がリモート削除されたか（draft は破壊せず継続・行消失インジケーター）。 */
  isTargetLost(): boolean;
  isComposing(): boolean;
  draft(): string;
  activeCell(): { row: number; col: number };
  /** 明示的な矩形選択レンジ（DD-020-1。null=単一セル選択のみ）。 */
  selectionRange(): GridDebugCellRange | null;
  /** ドラッグ中のライブ矩形（DD-020-1。null=非ドラッグ）。 */
  dragRange(): GridDebugCellRange | null;
  /** DD-027-1: 選択式ドロップダウンが開いているか。 */
  selectOpen(): boolean;
  /** DD-027-1: 選択式ドロップダウンの候補一覧（未 open は空）。 */
  selectOptions(): string[];
  /** DD-027-1: 選択式ドロップダウンのハイライト index（未 open は -1）。 */
  selectHighlightedIndex(): number;
  /** DD-027-1: 選択式ドロップダウンのハイライト値（未 open は null）。 */
  selectHighlightedValue(): string | null;
  /** DD-020-3: 現在 Undo 可能か（スタック非空・pending 0・非 in-flight）。 */
  canUndo(): boolean;
  /** DD-020-3: 現在 Redo 可能か。 */
  canRedo(): boolean;
  /** DD-020-3: Undo スタック深さ。 */
  undoDepth(): number;
  /** DD-020-3: Redo スタック深さ。 */
  redoDepth(): number;
  editingTarget(): GridDebugCellAddress | null;
  rowIdAt(index: number): string | undefined;
  colIdAt(index: number): string | undefined;
  rowIndexOf(rowId: string): number;
  cellRectAt(row: number, col: number): GridDebugCellRect | null;
  /** 列記号ヘッダーの矩形（DD-012-4 E2E: 境界ドラッグ開始点の算出用）。 */
  columnHeaderRectAt(col: number): GridDebugCellRect | null;
  /** 行番号ヘッダーの矩形（DD-012-4 E2E）。 */
  rowHeaderRectAt(row: number): GridDebugCellRect | null;
  /** 列幅 override のスナップショット（DD-012-4 E2E: layout 内容・復元検証用）。 */
  columnWidthOverrides(): Record<string, number>;
  /** 行高 override のスナップショット（DD-012-4 E2E）。 */
  rowHeightOverrides(): Record<string, number>;
  committedCell(rowId: string, columnId: string): string;
  /** committed セルの CellScalar kind（'blank'|'string'|'number'|'date'）。DD-020-2 paste の型保持検証用。 */
  committedCellKind(rowId: string, columnId: string): string;
  displayCell(rowId: string, columnId: string): string;
  /** DD-033-2: base-layer が描く display テキスト（表示書式適用後）。canvas 文字を読めないための E2E 観測用。 */
  cellRenderText(rowId: string, columnId: string): string;
  /** DD-033-2: 列ヘッダーに描く見出し（キャプション or 列記号）。canvas ヘッダー文字の E2E 観測用。 */
  columnHeaderText(col: number): string;
  submitInsertRowsAfter(afterRowId: string | null, newRowId: string): void;
  submitDeleteRow(rowId: string): void;
  simulateDrop(): void;
  simulateReconnect(): void;
}

/** GridInstance → debug API のレジストリ（WeakMap＝instance 破棄で自動回収）。 */
export const debugRegistry = new WeakMap<GridInstance, GridDebugApi>();
