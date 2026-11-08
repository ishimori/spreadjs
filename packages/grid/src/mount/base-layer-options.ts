// base-layer（セル・見出し・罫線の描画層）を backend と mount 時に解釈した設定へ束縛して作る。DD-065 区画⑨の一部。
// 各フックは該当する設定があるときだけ束縛する（無ければ描画コスト増ゼロ＝従来と同じ条件）。

import { CELL_TEXT_LINE_HEIGHT, DEFAULT_BASE_COLORS, columnLabel, createBaseLayer } from '@nanairo-sheet/render';
import type { CellStatusMark, TextMetricsCache } from '@nanairo-sheet/render';
import type { MergeIndex } from '@nanairo-sheet/selection';
import { createColumnId } from '@nanairo-sheet/types';

import type { CompiledAppearance } from '../appearance';
import type { CompiledBorders } from '../border-rules';
import type { CellStatusStore } from '../cell-status';
import type { CompiledColumnGroup } from '../column-groups';
import type { CompiledColumnDisplay } from '../display-format';
import type { CompiledColumnBackgrounds, CompiledColumnFormats, CompiledRowBackgrounds } from '../format-rules';
import type { GridBackend } from '../grid-backend';
import type { GridCellStatusColors } from '../index';
import { HEADER_WIDTH } from './constants';

export type MountBaseLayer = ReturnType<typeof createBaseLayer>;

export interface BaseLayerConfig {
  readonly ctx: CanvasRenderingContext2D;
  readonly headerHeight: number;
  /** DD-064 K4: 2段の見出しの上の段の高さ（1 段なら 0）。 */
  readonly groupBandHeight: number;
  readonly frozenColCount: number;
  readonly wrapEnabled: boolean;
  readonly wrapColumnStrings: ReadonlySet<string>;
  readonly cellTextCache: TextMetricsCache;
  readonly cellStatusStore: CellStatusStore;
  /** 直前の描画の前に張った結合範囲。 */
  currentMerges(): MergeIndex;
  isLinkColumnIndex(colIndex: number): boolean;
  appearance(): CompiledAppearance;
  formats(): CompiledColumnFormats | undefined;
  backgrounds(): CompiledColumnBackgrounds | undefined;
  rowBackgrounds(): CompiledRowBackgrounds | undefined;
  statusColors(): GridCellStatusColors | undefined;
  borders(): CompiledBorders | undefined;
  display(): CompiledColumnDisplay | undefined;
  columnGroups(): readonly CompiledColumnGroup[];
}

/**
 * DD-060: 行 index → その行の状態表示セル（base-layer の cellStatusesInRow フック）。状態が 0 件なら RowId の解決もせず
 * 即 undefined（状態を使わない画面の描画コストを増やさない）。列が見つからない状態は描かない。
 */
export function cellStatusMarksAt(store: CellStatusStore, backend: GridBackend, rowIndex: number): readonly CellStatusMark[] | undefined {
  if (!store.hasAny()) {
    return undefined;
  }
  const rowId = backend.view.rowIdAt(rowIndex);
  const statuses = rowId === undefined ? undefined : store.row(String(rowId));
  if (statuses === undefined) {
    return undefined;
  }
  const marks: CellStatusMark[] = [];
  for (const [columnId, status] of statuses) {
    const colIndex = backend.view.colIndexOf(createColumnId(columnId));
    if (colIndex >= 0) {
      marks.push({ colIndex, level: status.level });
    }
  }
  return marks;
}

/** backend の store と設定へ束縛した base-layer を作る（boot で設定を解釈した後・backend の結線時に 1 回）。 */
export function createMountBaseLayer(backend: GridBackend, cfg: BaseLayerConfig): MountBaseLayer {
  const appearance = cfg.appearance();
  const compiledColumnGroups = cfg.columnGroups();
  const compiledFormats = cfg.formats();
  const compiledBackgrounds = cfg.backgrounds();
  const compiledBorders = cfg.borders();
  const compiledRowBackgrounds = cfg.rowBackgrounds();
  const compiledStatusColors = cfg.statusColors();
  const compiledDisplay = cfg.display();
  return createBaseLayer({
    ctx: cfg.ctx,
    store: backend.view.store,
    headerWidth: HEADER_WIDTH,
    headerHeight: cfg.headerHeight,
    // DD-064: 結合範囲（直前の描画の前に張ったもの）と 2段の見出し。どちらも無ければ追加の描画ゼロ。
    mergedRanges: cfg.currentMerges,
    ...(compiledColumnGroups.length > 0
      ? { columnGroupBand: { height: cfg.groupBandHeight, groups: compiledColumnGroups } }
      : {}),
    // DD-012-5: 共有キャッシュ・wrap 判定・pane 境界・折り返し行高を渡す（オーバーフロー／折り返し描画）。
    cellFont: appearance.cellFont,
    headerFont: appearance.headerFont,
    columnFont: (index) => appearance.fontFor(String(backend.view.columnIdAt(index))),
    colors: { ...DEFAULT_BASE_COLORS, gridLine: appearance.gridLineColor ?? DEFAULT_BASE_COLORS.gridLine },
    textCache: cfg.cellTextCache,
    frozenColCount: cfg.frozenColCount,
    lineHeight: CELL_TEXT_LINE_HEIGHT,
    isWrapColumn: (colIndex) => {
      if (!cfg.wrapEnabled) {
        return false;
      }
      const id = backend.view.columnIdAt(colIndex);
      return id !== undefined && cfg.wrapColumnStrings.has(String(id));
    },
    // DD-027-2: リンク列はリンク色＋下線・自セル内クリップで描く（列単位・registry 判定）。リンク列が無ければ常に false。
    isLinkColumn: (colIndex) => cfg.isLinkColumnIndex(colIndex),
    // DD-027-3: セル書式の解決フック。書式が 1 つも無ければ束縛せず描画コスト増ゼロ（可視非空セルの O(1) lookup）。
    ...(compiledFormats?.hasAny() === true
      ? {
          getCellStyle: (colIndex: number, value: string) => {
            const id = backend.view.columnIdAt(colIndex);
            return id === undefined ? undefined : compiledFormats.getStyle(String(id), value);
          },
        }
      : {}),
    // DD-036 C2: 静的列背景のフック（列単位・値を見ない）。指定が 1 列も無ければ束縛せず列バンド描画を行わない。
    ...(compiledBackgrounds?.hasAny() === true
      ? {
          columnBackground: (colIndex: number) => {
            const id = backend.view.columnIdAt(colIndex);
            return id === undefined ? undefined : compiledBackgrounds.getBackground(String(id));
          },
        }
      : {}),
    // DD-045: row index から現在の RowId を毎描画時に解決し、行挿入・削除後も同じ行実体へ追従する。
    ...(compiledBorders?.hasRows === true
      ? {
          rowBorder: (index: number) =>
            compiledBorders.row(index > 0 ? backend.view.rowIdAt(index - 1) : undefined, backend.view.rowIdAt(index)),
        }
      : {}),
    ...(compiledBorders?.hasColumns === true
      ? {
          columnBorder: (index: number) =>
            compiledBorders.column(index > 0 ? backend.view.columnIdAt(index - 1) : undefined, backend.view.columnIdAt(index)),
        }
      : {}),
    ...(compiledRowBackgrounds?.hasAny() === true
      ? {
          rowBackground: (rowIndex: number) => {
            const id = backend.view.rowIdAt(rowIndex);
            return id === undefined ? undefined : compiledRowBackgrounds.getBackground(String(id));
          },
        }
      : {}),
    // DD-060/062: セルの状態表示。後から付くため両モードで常に束縛し、0 件なら即 undefined を返す。
    // RowId→ColumnId を描画のたびに index へ解決する（行の挿入・削除・列の並びに追従。解決できない列は描かない）。
    cellStatusesInRow: (rowIndex: number) => cellStatusMarksAt(cfg.cellStatusStore, backend, rowIndex),
    ...(compiledStatusColors !== undefined ? { cellStatusColors: compiledStatusColors } : {}),
    // DD-033-2: 列見出しキャプション＋表示書式のフック。両オプション未指定（hasAny()=false）なら束縛せず現行描画と
    // 完全一致（AC9）。判定は raw・描画は display（columnHeaderLabel=ヘッダー・formatCellText=セル）。
    ...(compiledDisplay?.hasAny() === true
      ? {
          columnHeaderLabel: (colIndex: number) => {
            const id = backend.view.columnIdAt(colIndex);
            const caption = id === undefined ? undefined : compiledDisplay.captionFor(String(id));
            return caption ?? columnLabel(colIndex);
          },
          formatCellText: (colIndex: number, rawValue: string) => {
            const id = backend.view.columnIdAt(colIndex);
            return id === undefined ? rawValue : (compiledDisplay.formatText(String(id), rawValue) ?? rawValue);
          },
        }
      : {}),
    // DD-059: 負の数の色・括弧表記の右余白のフック。該当する列が無ければ束縛せず描画コスト増ゼロ（判定は raw）。
    ...(compiledDisplay?.hasDecorations() === true
      ? {
          cellTextDecoration: (colIndex: number, rawValue: string) => {
            const id = backend.view.columnIdAt(colIndex);
            return id === undefined ? undefined : compiledDisplay.decorationFor(String(id), rawValue);
          },
        }
      : {}),
  });
}
