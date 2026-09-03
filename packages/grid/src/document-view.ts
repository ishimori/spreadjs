// DocumentView（DD-005 Phase 2・最重要 #1/#2）。ClientSession の committed＋pending 文書（SheetDocument）を
// Canvas 描画層（pocb base/overlay-layer）が読むための **派生 Adapter**。
//
// 【最重要原則】ClientSession だけが Document State の唯一の正本。DocumentView は**セル状態を一切保持しない**
// 純粋な読み取りアダプター（第二の CellStore にしない・#2）。描画に必要なとき ClientSession の文書を
// RowId/ColumnId キーで直接読む（getCell）。書き込み（store.set/bulkLoad）は throw で禁止し、編集は必ず
// ClientSession.submitLocalOperation へ流す（三重管理＝ClientSession文書/Canvas独自文書/IME旧cell-store を構造的に排除）。
//
// 保持するのは Render State のみ:
//   - rowAxis（RowId 列・displayRowOrder から構築）／colAxis（ColumnId 列・列は固定）
//   - dirty flag（cell / row-structure / viewport の 3 種別）
// これらは **いつでも ClientSession 文書から再構築可能**（rowAxis は flush で displayRowOrder から作り直す）。
//
// 更新コスト分離（#5）:
//   - SetCells 受信 → `cell` dirty のみ。rowAxis/colAxis は不変。次フレームで**可視範囲のみ**文書を読み直す
//     （50,000行 Axis・10万セルの全再構築をしない）。
//   - InsertRows/DeleteRows → `row-structure` dirty。flush で rowAxis を displayRowOrder から再構築
//     （構造Op時の Axis 全再構築は PoC 許容）。scroll anchor 補正は DOM を持つ呼び出し側（main）が行う。

import { displayRowOrder, getCell, slotOf } from '@nanairo-sheet/core';
import type { CellScalar, DocumentOperation, SheetDocument } from '@nanairo-sheet/core';
import { createColumnId, createRowId } from '@nanairo-sheet/types';
import type { ColumnId, RowId } from '@nanairo-sheet/types';

import {
  CELL_TEXT_LINE_HEIGHT,
  CELL_TEXT_PADDING,
  createAxis,
  isNumericCell,
  type Axis,
  type TextMetricsCache,
} from '@nanairo-sheet/render';
import type { ChunkStore, RangeVisitor } from '@nanairo-sheet/render';

import { autoRowHeight } from './auto-row-height';
import { clampColumnWidth, clampRowHeight } from './resize-interaction';

/** dirty の種別（#5 更新コスト分離のための分類）。 */
export type DirtyKind = 'cell' | 'row-structure' | 'viewport';

export interface DocumentViewConfig {
  /** ClientSession の描画対象文書（committed＋pending view）を返す。唯一の正本への参照。 */
  getDocument: () => SheetDocument;
  rowHeight: number;
  colWidth: number;
  /** 初期の列幅 override（ColumnId 文字列→px・DD-012-4 D2）。利用側が保存した設定の復元に使う。 */
  columnWidths?: Readonly<Record<string, number>>;
  /** 初期の行高 override（RowId 文字列→px・DD-012-4 D2）。 */
  rowHeights?: Readonly<Record<string, number>>;
  /** 折り返し（wrap）列（ColumnId 文字列・DD-012-5 D1）。指定列は自動行高の対象になる。 */
  wrapColumns?: readonly string[];
  /** 行分割キャッシュ（DD-012-5 D4・base-layer と共有し描画/行高の line 数を一致させる）。wrap 有効時に必須。 */
  wrapCache?: TextMetricsCache;
  /** セル文字フォント（wrapLines の測定に使う・base-layer と一致させる）。 */
  cellFont?: string;
  /** wrap 折り返し行の行高（px・base-layer の lineHeight と一致・既定 CELL_TEXT_LINE_HEIGHT）。 */
  lineHeight?: number;
}

export interface FlushResult {
  /** 再描画が必要か（いずれかの dirty が立っていた）。 */
  needsRedraw: boolean;
  /** rowAxis を再構築したか（構造Op）。scroll anchor 補正の要否判定に使う。 */
  structuralRebuilt: boolean;
  /** 立っていた dirty 種別（消費前のスナップショット）。 */
  dirty: Record<DirtyKind, boolean>;
}

/** CellScalar を描画文字列へ変換する（blank=''・number は文字列化して数値右寄せ判定に載せる）。 */
export function cellScalarToDisplay(value: CellScalar): string {
  switch (value.kind) {
    case 'blank':
      return '';
    case 'string':
      return value.value;
    case 'number':
      return String(value.value);
    case 'date':
      // LocalDate は正準文字列（YYYY-MM-DD）をそのまま表示する（表示整形は R-18 で別途）。
      return value.value;
  }
}

/** Operation を描画更新の dirty 種別へ分類する（setCells=cell / insertRows・deleteRows=row-structure）。 */
export function operationDirtyKind(op: DocumentOperation): 'cell' | 'row-structure' {
  return op.type === 'setCells' ? 'cell' : 'row-structure';
}

export class DocumentView {
  private readonly getDocument: () => SheetDocument;
  private readonly rowHeight: number;
  private readonly colWidth: number;
  private currentRowAxis: Axis<RowId>;
  private currentColAxis: Axis<ColumnId>;
  /**
   * 列幅・行高の override（Id キーで保持・DD-012-4）。Axis と別に DocumentView 側でも保持し、構造Op で Axis を
   * 作り直しても override を失わない（AC4・DD-012-4 の「構造再構築時に override が失われない」不変を成立させる）。
   */
  private readonly colWidthOverrides: Map<ColumnId, number>;
  private readonly rowHeightOverrides: Map<RowId, number>;
  /**
   * 自動行高の別レイヤ（DD-012-5 D5）。手動 override（rowHeightOverrides）とは別に保持し、手動があれば手動を優先する。
   * layout イベントには含めない（D7・自動高は環境・フォントで再現される導出値）。
   */
  private readonly rowAutoHeights = new Map<RowId, number>();
  /** wrap（折り返し）列の集合（DD-012-5 D1・mount 時固定）。 */
  private readonly wrapColumnSet: Set<ColumnId>;
  private readonly wrapCache: TextMetricsCache | undefined;
  private readonly cellFont: string;
  private readonly lineHeight: number;
  private readonly wrapEnabled: boolean;
  /** 直近の自動行高一括計算の所要（ms・D6 予算判定・perf 記録用）。 */
  private lastAutoHeightBatchMs = 0;
  /** base/overlay-layer が束縛する read-through ストア（安定参照・内部で最新 Axis と文書を読む）。 */
  readonly store: ChunkStore;

  private dirtyCell = false;
  private dirtyStructure = false;
  private dirtyViewport = false;
  private structuralRebuilds = 0;

  constructor(config: DocumentViewConfig) {
    this.getDocument = config.getDocument;
    this.rowHeight = config.rowHeight;
    this.colWidth = config.colWidth;
    // 初期 override は無検証で Axis に入れると prefix sum の単調性が壊れる（負値/0/非有限）ため、有限数へ絞り
    // D3 のクランプを適用する。既定値と一致するものは override として保持しない（layout の override-only 契約）。
    this.colWidthOverrides = new Map();
    for (const [id, px] of Object.entries(config.columnWidths ?? {})) {
      if (Number.isFinite(px)) {
        const clamped = clampColumnWidth(px);
        if (clamped !== this.colWidth) {
          this.colWidthOverrides.set(createColumnId(id), clamped);
        }
      }
    }
    this.rowHeightOverrides = new Map();
    for (const [id, px] of Object.entries(config.rowHeights ?? {})) {
      if (Number.isFinite(px)) {
        const clamped = clampRowHeight(px);
        if (clamped !== this.rowHeight) {
          this.rowHeightOverrides.set(createRowId(id), clamped);
        }
      }
    }
    this.wrapColumnSet = new Set((config.wrapColumns ?? []).map((id) => createColumnId(id)));
    this.wrapCache = config.wrapCache;
    this.cellFont = config.cellFont ?? '13px system-ui, sans-serif';
    this.lineHeight = config.lineHeight ?? CELL_TEXT_LINE_HEIGHT;
    this.wrapEnabled = this.wrapColumnSet.size > 0 && this.wrapCache !== undefined;
    this.currentColAxis = createAxis({
      ids: this.getDocument().columnOrder,
      defaultSize: this.colWidth,
      overrides: this.colWidthOverrides,
    });
    this.currentRowAxis = createAxis({
      ids: displayRowOrder(this.getDocument()),
      defaultSize: this.rowHeight,
      // 手動 override と自動高を合成して渡す（手動優先・D5）。
      overrides: this.combinedRowOverrides(),
    });
    this.store = this.createReadThroughStore();
  }

  /**
   * 列幅を override 設定する（DD-012-4 リサイズ）。Axis へ即時反映（ライブ再描画）し、override マップにも保持して
   * 構造Op 後の Axis 再構築でも維持する。呼び出し側（mount-controller）が px をクランプ済みで渡す。
   */
  setColumnWidth(columnId: ColumnId, width: number): void {
    if (width === this.colWidth) {
      // 既定値へ戻した → override を解除する（layout の override-only 契約・Codex[P2]）。
      if (this.colWidthOverrides.delete(columnId)) {
        const idx = this.currentColAxis.getIndex(columnId);
        if (idx >= 0) {
          this.currentColAxis.resetSize(idx);
        }
        this.markViewportDirty();
      }
      return;
    }
    this.colWidthOverrides.set(columnId, width);
    this.currentColAxis.setSizeById(columnId, width);
    this.markViewportDirty();
  }

  /** 行高を override 設定する（DD-012-4 リサイズ）。既定値へ戻したときは手動 override を解除し自動高を復帰する。 */
  setRowHeight(rowId: RowId, height: number): void {
    if (height === this.rowHeight) {
      if (this.rowHeightOverrides.delete(rowId)) {
        // 手動を外したら自動高（あれば）を適用する（D5・手動解除で自動 fit へ戻る）。
        this.applyEffectiveRowHeight(rowId);
        this.markViewportDirty();
      }
      return;
    }
    // 手動リサイズは自動高より優先（D5）。手動値を Axis へ即時反映する。
    this.rowHeightOverrides.set(rowId, height);
    this.currentRowAxis.setSizeById(rowId, height);
    this.markViewportDirty();
  }

  /**
   * リサイズ取消（pointercancel/capture 喪失）で行高を開始時の**手動 override 状態**へ戻す（DD-012-5 Codex P2）。
   * manual=undefined は「開始時に手動 override が無かった」＝手動を外し自動高/既定へ戻す（自動 fit を殺さない）。
   * manual=数値は開始時の手動値を復元する。ドラッグ開始時の実効 px をそのまま setRowHeight すると、自動高を
   * 誤って手動 override として記録してしまい以後の自動縮小が止まるため、状態で復元する。
   */
  restoreRowHeight(rowId: RowId, manual: number | undefined): void {
    if (manual === undefined) {
      this.rowHeightOverrides.delete(rowId);
      this.applyEffectiveRowHeight(rowId); // 自動高（あれば）or 既定へ
    } else {
      this.rowHeightOverrides.set(rowId, manual);
      this.currentRowAxis.setSizeById(rowId, manual);
    }
    this.markViewportDirty();
  }

  /** 列幅 override のスナップショット（既定値の列は含まない＝override のみ・DD-012-4 layout イベント用）。 */
  columnWidthOverrideRecord(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, px] of this.colWidthOverrides) {
      out[String(id)] = px;
    }
    return out;
  }

  /** 行高 override のスナップショット（既定値の行は含まない）。自動高は含めない（D7）。 */
  rowHeightOverrideRecord(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, px] of this.rowHeightOverrides) {
      out[String(id)] = px;
    }
    return out;
  }

  /** wrap（折り返し・自動行高）機能が有効か（wrap 列指定＋キャッシュあり）。 */
  get autoRowHeightEnabled(): boolean {
    return this.wrapEnabled;
  }

  /** 直近の自動行高一括計算の所要（ms・D6 予算判定・perf 記録用）。 */
  get lastAutoRowHeightBatchMs(): number {
    return this.lastAutoHeightBatchMs;
  }

  /** 自動高スナップショット（検証用・layout には含めない＝D7）。 */
  autoRowHeightRecord(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, px] of this.rowAutoHeights) {
      out[String(id)] = px;
    }
    return out;
  }

  /** 手動 override（優先）と自動高を合成した Axis 用 override マップ（D5 手動優先）。 */
  private combinedRowOverrides(): Map<RowId, number> {
    const merged = new Map<RowId, number>(this.rowAutoHeights);
    for (const [id, px] of this.rowHeightOverrides) {
      merged.set(id, px); // 手動が自動を上書き（手動優先・D5）
    }
    return merged;
  }

  /** rowId の実効行高（手動 ?? 自動 ?? 既定）を Axis へ反映する。手動があれば手動を尊重して触らない。 */
  private applyEffectiveRowHeight(rowId: RowId): void {
    if (this.rowHeightOverrides.has(rowId)) {
      return; // 手動優先（D5）: Axis は手動値のまま
    }
    const idx = this.currentRowAxis.getIndex(rowId);
    if (idx < 0) {
      return;
    }
    const auto = this.rowAutoHeights.get(rowId);
    if (auto !== undefined) {
      this.currentRowAxis.setSizeById(rowId, auto);
    } else {
      this.currentRowAxis.resetSize(idx);
    }
  }

  /** 1 行の自動行高を算出する（wrap 列の非空セルの折り返し行数の最大から。拡張不要なら undefined）。 */
  private computeAutoHeightForRow(rowId: RowId): number | undefined {
    const cache = this.wrapCache;
    if (!this.wrapEnabled || cache === undefined) {
      return undefined;
    }
    const doc = this.getDocument();
    const lineCounts: number[] = [];
    for (const columnId of this.wrapColumnSet) {
      const record = getCell(doc, rowId, columnId);
      if (record === undefined) {
        continue;
      }
      const text = cellScalarToDisplay(record.value);
      if (text === '') {
        continue;
      }
      if (isNumericCell(text)) {
        lineCounts.push(1); // 数値は折り返さない（右寄せ・単一行）
        continue;
      }
      const colIdx = this.currentColAxis.getIndex(columnId);
      if (colIdx < 0) {
        continue;
      }
      const maxWidth = this.currentColAxis.size(colIdx) - CELL_TEXT_PADDING * 2;
      lineCounts.push(cache.wrapLines(text, this.cellFont, maxWidth).length);
    }
    return autoRowHeight({
      lineCounts,
      lineHeight: this.lineHeight,
      padding: CELL_TEXT_PADDING,
      defaultHeight: this.rowHeight,
    });
  }

  /** rowId の自動高を再算出し、変化があれば rowAutoHeights と Axis を更新する（内部・戻り値=変化したか）。 */
  private updateAutoHeightForRow(rowId: RowId): boolean {
    const next = this.computeAutoHeightForRow(rowId);
    const prev = this.rowAutoHeights.get(rowId);
    if (next === prev) {
      return false;
    }
    if (next === undefined) {
      this.rowAutoHeights.delete(rowId);
    } else {
      this.rowAutoHeights.set(rowId, next);
    }
    this.applyEffectiveRowHeight(rowId);
    return true;
  }

  /**
   * 指定行だけ自動行高を再計算する（D5 トリガー②＝セル値変更: ローカル楽観適用・リモート適用）。
   * wrap 無効時・存在しない行は no-op。変化があれば viewport dirty を立て再描画させる。
   */
  recomputeAutoRowHeightsForRows(rowIds: Iterable<RowId>): void {
    if (!this.wrapEnabled) {
      return;
    }
    let changed = false;
    const seen = new Set<RowId>();
    for (const rowId of rowIds) {
      if (seen.has(rowId)) {
        continue;
      }
      seen.add(rowId);
      if (this.updateAutoHeightForRow(rowId)) {
        changed = true;
      }
    }
    if (changed) {
      this.markViewportDirty();
    }
  }

  /**
   * 全行の自動行高を一括計算する（D5 トリガー①bootstrap／③列幅変更／DPR・font 変更）。
   * 空行は文書スロット有無で早期スキップし O(非空行) に抑える。所要を lastAutoHeightBatchMs へ記録（D6 予算判定）。
   */
  recomputeAllAutoRowHeights(): void {
    if (!this.wrapEnabled) {
      return;
    }
    const start = performance.now();
    const doc = this.getDocument();
    const axis = this.currentRowAxis;
    const count = axis.count();
    let changed = false;
    // 削除・bootstrap 差し替えで軸から消えた行の自動高を掃除する（stale 導出状態を溜めない・Codex P2）。
    for (const rowId of [...this.rowAutoHeights.keys()]) {
      if (axis.getIndex(rowId) < 0) {
        this.rowAutoHeights.delete(rowId);
        changed = true;
      }
    }
    for (let i = 0; i < count; i += 1) {
      const rowId = axis.getId(i);
      const slot = slotOf(doc, rowId);
      const hasContent = slot !== undefined && doc.cells.hasRow(slot);
      // 内容が無い行は自動高を持たない（値削除で自動縮小・D5）。内容がある行だけ算出する。
      const next = hasContent ? this.computeAutoHeightForRow(rowId) : undefined;
      const prev = this.rowAutoHeights.get(rowId);
      if (next === prev) {
        continue;
      }
      if (next === undefined) {
        this.rowAutoHeights.delete(rowId);
      } else {
        this.rowAutoHeights.set(rowId, next);
      }
      this.applyEffectiveRowHeight(rowId);
      changed = true;
    }
    this.lastAutoHeightBatchMs = performance.now() - start;
    if (changed) {
      this.markViewportDirty();
    }
  }

  /** DPR・Web font 変更で行分割キャッシュが無効化されたときの再計算（③相当・base-layer.clear と同期）。 */
  onTextMetricsChanged(): void {
    this.recomputeAllAutoRowHeights();
  }

  /** 現在の行 Axis（RowId 列。構造Op で再構築される。呼び出し側は毎フレーム getter で取得すること）。 */
  get rowAxis(): Axis<RowId> {
    return this.currentRowAxis;
  }

  /** 現在の列 Axis（ColumnId 列・固定）。 */
  get colAxis(): Axis<ColumnId> {
    return this.currentColAxis;
  }

  /** rowAxis を再構築した回数（#5 検証: SetCells で増えない／構造Op で増える）。 */
  get structuralRebuildCount(): number {
    return this.structuralRebuilds;
  }

  /** RowId → 現在の表示 index（tombstone/未知は -1）。表示直前に解決する（#4 RowId 安定）。 */
  rowIndexOf(rowId: RowId): number {
    return this.currentRowAxis.getIndex(rowId);
  }

  /** ColumnId → 表示 index（未知は -1）。 */
  colIndexOf(columnId: ColumnId): number {
    return this.currentColAxis.getIndex(columnId);
  }

  /** RowId が現在表示に存在するか（削除＝tombstone/displayRowOrder 消失の判定に使う・#4）。 */
  hasRow(rowId: RowId): boolean {
    return this.currentRowAxis.hasId(rowId);
  }

  /** RowId/ColumnId のセル表示文字列（ClientSession 文書を直接読む。無ければ ''）。 */
  cellDisplay(rowId: RowId, columnId: ColumnId): string {
    const record = getCell(this.getDocument(), rowId, columnId);
    return record === undefined ? '' : cellScalarToDisplay(record.value);
  }

  /** SetCells 受信 → 可視セルのみ読み直す（Axis 不変）。 */
  markCellDirty(): void {
    this.dirtyCell = true;
  }

  /** 構造Op 受信 → 次 flush で rowAxis を再構築する。 */
  markStructureDirty(): void {
    this.dirtyStructure = true;
  }

  /** スクロール・リサイズ → viewport 再計算・可視再描画（Axis/文書は不変）。 */
  markViewportDirty(): void {
    this.dirtyViewport = true;
  }

  /** 再接続後の全再構築（Render State を Document State から作り直す・#10 再接続経路）。 */
  markFullRebuild(): void {
    this.dirtyStructure = true;
    this.dirtyCell = true;
  }

  /** Operation の種別に応じて dirty を立てる（observer が operations 受信ごとに呼ぶ）。 */
  noteOperation(op: DocumentOperation): void {
    if (operationDirtyKind(op) === 'row-structure') {
      this.markStructureDirty();
    } else {
      this.markCellDirty();
    }
  }

  /** 構造 dirty が立っているか（scroll anchor 補正を bracket する main が flush 前に覗く）。 */
  hasStructuralDirty(): boolean {
    return this.dirtyStructure;
  }

  /** いずれかの dirty が立っているか。 */
  isDirty(): boolean {
    return this.dirtyCell || this.dirtyStructure || this.dirtyViewport;
  }

  /**
   * dirty を消費して Render State を Document State に整合させる（構造Op なら rowAxis 再構築）。
   * SetCells だけのときは Axis を触らない（#5・全再構築しない）。描画自体は呼び出し側が行う。
   */
  flush(): FlushResult {
    const dirty: Record<DirtyKind, boolean> = {
      cell: this.dirtyCell,
      'row-structure': this.dirtyStructure,
      viewport: this.dirtyViewport,
    };
    let structuralRebuilt = false;
    if (this.dirtyStructure) {
      const doc = this.getDocument();
      // override を渡して再構築する。渡さないとリサイズ済みの列幅・行高が構造Op で失われる（DD-012-4 AC4）。
      // 手動 override と自動高を合成する（手動優先・DD-012-5 D5）。
      this.currentRowAxis = createAxis({
        ids: displayRowOrder(doc),
        defaultSize: this.rowHeight,
        overrides: this.combinedRowOverrides(),
      });
      if (doc.columnOrder.length !== this.currentColAxis.count()) {
        // 列 Operation は PoC に無いが、列数変化があれば防御的に再構築（通常は通らない）。
        this.currentColAxis = createAxis({
          ids: doc.columnOrder,
          defaultSize: this.colWidth,
          overrides: this.colWidthOverrides,
        });
      }
      this.structuralRebuilds += 1;
      structuralRebuilt = true;
      // ① bootstrap 直後／再接続の全再構築で自動行高を一括計算する（D5 トリガー①・D6 予算計測）。
      this.recomputeAllAutoRowHeights();
    }
    const needsRedraw = this.dirtyCell || this.dirtyStructure || this.dirtyViewport;
    this.dirtyCell = false;
    this.dirtyStructure = false;
    this.dirtyViewport = false;
    return { needsRedraw, structuralRebuilt, dirty };
  }

  /** 表示 index → RowId（範囲外は undefined）。Phase 3 の editingTarget 解決に使う（#4）。 */
  rowIdAt(index: number): RowId | undefined {
    if (index < 0 || index >= this.currentRowAxis.count()) {
      return undefined;
    }
    return this.currentRowAxis.getId(index);
  }

  /** 表示 index → ColumnId（範囲外は undefined）。 */
  columnIdAt(index: number): ColumnId | undefined {
    if (index < 0 || index >= this.currentColAxis.count()) {
      return undefined;
    }
    return this.currentColAxis.getId(index);
  }

  /** 可視 display-index 範囲の非空セルだけを ClientSession 文書から読んで visit する（O(可視セル)）。 */
  private queryRange(
    rowStart: number,
    rowEnd: number,
    colStart: number,
    colEnd: number,
    visit: RangeVisitor,
  ): number {
    const doc = this.getDocument();
    const rowAxis = this.currentRowAxis;
    const colAxis = this.currentColAxis;
    const rStart = Math.max(rowStart, 0);
    const rEnd = Math.min(rowEnd, rowAxis.count());
    const cStart = Math.max(colStart, 0);
    const cEnd = Math.min(colEnd, colAxis.count());
    let visited = 0;
    for (let ri = rStart; ri < rEnd; ri += 1) {
      const rowId = rowAxis.getId(ri);
      // 空行は列走査前にスキップ（疎な業務表で O(行×列) 回帰を避ける・DD-010 Codex[P2]）。
      const slot = slotOf(doc, rowId);
      if (slot === undefined || !doc.cells.hasRow(slot)) {
        continue;
      }
      for (let ci = cStart; ci < cEnd; ci += 1) {
        const record = getCell(doc, rowId, colAxis.getId(ci));
        if (record === undefined) {
          continue;
        }
        const text = cellScalarToDisplay(record.value);
        if (text === '') {
          continue; // blank は描画しない（chunk-store と同挙動）
        }
        const stop = visit(ri, ci, text);
        visited += 1;
        if (stop === false) {
          return visited; // 訪問関数が中断を要求（DD-027-3・予算保護・Fable P2）
        }
      }
    }
    return visited;
  }

  /** ClientSession 文書を読むだけの ChunkStore（書き込みは禁止＝第二 CellStore を作らない・#2）。 */
  private createReadThroughStore(): ChunkStore {
    const readOnly = (): never => {
      throw new Error(
        'DocumentView.store は読み取り専用アダプター。編集は ClientSession.submitLocalOperation へ流すこと（第二の CellStore を作らない・DD-005 #2）。',
      );
    };
    return {
      get: (row, col) => {
        const rowId = this.rowIdAt(row);
        const columnId = this.columnIdAt(col);
        if (rowId === undefined || columnId === undefined) {
          return '';
        }
        return this.cellDisplay(rowId, columnId);
      },
      set: readOnly,
      bulkLoad: readOnly,
      queryRange: (rowStart, rowEnd, colStart, colEnd, visit) =>
        this.queryRange(rowStart, rowEnd, colStart, colEnd, visit),
      nonEmptyCount: () => this.getDocument().cells.nonEmptyCount(),
      approxMemoryBytes: () => 0, // アダプターは文書を複製しない（メモリは ClientSession 側が保持）
    };
  }
}
