// mount オプションの設定の解釈（列タイプ・見た目・書式・背景・状態表示の色・罫線・表示書式・2段の見出し・結合）。DD-065 区画⑥の一部。
// boot で列の並びが決まった後に 1 回だけ解釈する（不正は fail-fast＝公開 error phase=config を出して配線しない・AC8）。
// 解釈した結果の持ち主はこの部品だけで、ほかの部品は getter で読む。

import { createRowId } from '@nanairo-sheet/types';

import { compileAppearance } from '../appearance';
import type { CompiledAppearance } from '../appearance';
import { BorderConfigError, compileBorders, normalizeCanvasBorderColor } from '../border-rules';
import type { CompiledBorders } from '../border-rules';
import { validateCellStatusColors } from '../cell-status';
import { compileColumnGroups } from '../column-groups';
import type { CompiledColumnGroup } from '../column-groups';
import { ColumnTypeConfigError, createColumnTypeRegistry } from '../column-types';
import type { ColumnTypeRegistry } from '../column-types';
import type { DiagnosticSink } from '../diagnostics';
import { DisplayConfigError, compileDisplayFormats } from '../display-format';
import type { CompiledColumnDisplay } from '../display-format';
import { FormatRuleConfigError, compileColumnBackgrounds, compileFormatRules, compileRowBackgrounds } from '../format-rules';
import type { CompiledColumnBackgrounds, CompiledColumnFormats, CompiledRowBackgrounds } from '../format-rules';
import type { GridBackend } from '../grid-backend';
import type { GridCellStatusColors, GridEvent, GridMountOptions } from '../index';
import { MergedCellsConfigError } from '../merged-cell-spec';
import type { MountMerges } from './merges';

export interface MountConfigDeps {
  readonly options: GridMountOptions;
  readonly wrapColumnStrings: ReadonlySet<string>;
  readonly frozenColCount: number;
  /** 色の正規化（canvas の strokeStyle で読み直す）に使う base canvas の 2D context。 */
  readonly baseCtx: CanvasRenderingContext2D;
  readonly diag: DiagnosticSink;
  readonly merges: Pick<MountMerges, 'applyMountOption'>;
  emit(event: GridEvent): void;
  backend(): GridBackend | undefined;
}

export interface MountConfig {
  /**
   * 列の並びが決まった後に設定を解釈する（両モード共通）。成功=true。不正設定は catch して公開 error（phase=config・
   * code は種類ごと）＋診断で通知して false を返す（fail-fast・配線しない・AC8）。
   */
  build(columnOrder: readonly string[]): boolean;
  appearance(): CompiledAppearance;
  registry(): ColumnTypeRegistry | undefined;
  formats(): CompiledColumnFormats | undefined;
  backgrounds(): CompiledColumnBackgrounds | undefined;
  rowBackgrounds(): CompiledRowBackgrounds | undefined;
  statusColors(): GridCellStatusColors | undefined;
  borders(): CompiledBorders | undefined;
  display(): CompiledColumnDisplay | undefined;
  columnGroups(): readonly CompiledColumnGroup[];
  /** DD-045: 初回描画の後に 1 回だけ、rowBackgrounds の未知の RowId を診断する（行 ID は初期データ到着前に検証できない）。 */
  validateRowBackgroundsOnce(): void;
  /** DD-045: 初回描画の後に 1 回だけ、rowBorders の未知の RowId を診断する。 */
  validateRowBordersOnce(): void;
}

export function createMountConfig(deps: MountConfigDeps): MountConfig {
  const { options, wrapColumnStrings, baseCtx, diag } = deps;
  let appearance = compileAppearance(undefined, [], () => true, () => undefined);
  // DD-027-1: 列タイプメタの Internal registry（columnOrder 解決後に生成・fail-fast）。
  let columnTypeRegistry: ColumnTypeRegistry | undefined;
  // DD-027-3: セル書式のプリコンパイル済み解決器。書式なしなら hasAny()=false で base-layer への束縛を省き描画コスト増をゼロにする。
  let compiledFormats: CompiledColumnFormats | undefined;
  // DD-036 C2: 静的列背景。hasAny()=false なら base-layer への columnBackground 束縛を省き列バンド描画そのものを行わない。
  let compiledBackgrounds: CompiledColumnBackgrounds | undefined;
  // DD-045: 静的行背景。hasAny()=false なら rowBackground フックを束縛せず、描画コスト増ゼロ。
  let compiledRowBackgrounds: CompiledRowBackgrounds | undefined;
  // DD-061: 状態表示の色の上書き（検証済みの写し・未指定なら undefined＝既定色）。
  let compiledStatusColors: GridCellStatusColors | undefined;
  let compiledBorders: CompiledBorders | undefined;
  let rowBordersChecked = false;
  // DD-033-2: 列見出しキャプション＋表示書式。hasAny()=false（両オプション未指定）なら base-layer へのフック束縛を省く。
  let compiledDisplay: CompiledColumnDisplay | undefined;
  // DD-064 K4: 2段の見出しのまとまり（列 index に解決済み）。空なら 1 段。
  let compiledColumnGroups: readonly CompiledColumnGroup[] = [];
  // DD-045: 行 ID は初期データ到着前に検証できないため、初回描画後に一度だけ未知 RowId を診断する。
  const rowBackgroundRowSet = new Set<string>(Object.keys(options.rowBackgrounds ?? {}));
  let rowBackgroundsChecked = false;

  function build(columnOrder: readonly string[]): boolean {
    try {
      // DD-027-2: wrapColumns を渡してリンク列×折り返しの併用を fail-fast（wrap-link-conflict→column-types-invalid）。
      // DD-035 R4: readOnlyColumns も同じ registry で検証（未知列・重複 → column-types-invalid）・参照する（列タイプと直交）。
      columnTypeRegistry = createColumnTypeRegistry(options.columnTypes, columnOrder, wrapColumnStrings, options.readOnlyColumns);
      // DD-027-3: セル書式ルールをプリコンパイル（fail-fast）。不正は columnTypes と同じ column-types-invalid へ写像する。
      appearance = compileAppearance(options.appearance, columnOrder, (font) => {
        const probe = document.createElement('span');
        probe.style.font = font;
        return probe.style.font !== '';
      }, (color) => normalizeCanvasBorderColor(baseCtx, color));
      compiledFormats = compileFormatRules(options.columnFormats, columnOrder);
      // DD-036 C2: 静的列背景をプリコンパイル（fail-fast・未知列/空色 → column-types-invalid＝columnFormats と同経路）。
      compiledBackgrounds = compileColumnBackgrounds(options.columnBackgrounds, columnOrder);
      // DD-045: 静的行背景をプリコンパイル（空色は fail-fast、RowId の存在は初回描画後に warn）。
      compiledRowBackgrounds = compileRowBackgrounds(options.rowBackgrounds);
      // DD-061: 状態表示の色（未知のキー・空の色 → column-types-invalid＝rowBackgrounds と同経路）。
      compiledStatusColors = validateCellStatusColors(options.cellStatusColors);
      compiledBorders = compileBorders(options.rowBorders, options.columnBorders, columnOrder, (color) => normalizeCanvasBorderColor(baseCtx, color), options.defaultRowBorder);
      // DD-033-2: 列見出しキャプション＋表示書式をプリコンパイル（fail-fast）。wrap/link 併用検査は wrapColumnStrings と
      // 直前に生成した columnTypeRegistry を渡して同所で実施する。不正は column-display-invalid へ写像する（別 code）。
      compiledDisplay = compileDisplayFormats(options.columnDisplayFormats, options.columnCaptions, columnOrder, {
        isWrapColumn: (columnId) => wrapColumnStrings.has(columnId),
        isLinkColumn: (columnId) => columnTypeRegistry?.isLinkColumn(columnId) === true,
      });
      // DD-064 K4: 2段の見出しのまとまり（形の誤りは DisplayConfigError → column-display-invalid）。
      compiledColumnGroups = compileColumnGroups(options.columnGroups, columnOrder, deps.frozenColCount);
      // DD-064: mount オプションの結合（形の誤りは 1 件でも fail-fast → merged-cells-invalid）。行に張るのは最初の描画の時。
      // boot 前に呼ばれた setMergedCells（最後の 1 回）は、この後に適用する（呼んだ側の指定が勝つ）。
      deps.merges.applyMountOption(options.mergedCells, columnOrder);
      return true;
    } catch (error) {
      // DD-027-1/2: columnTypes 不正 ／ DD-027-3: columnFormats 不正 は column-types-invalid へ、
      // DD-033-2: columnCaptions/columnDisplayFormats 不正 は column-display-invalid へ（意味を分けて障害切り分けを濁さない）。
      if (error instanceof MergedCellsConfigError) {
        diag.emit('error', 'config-error', `merged-cells-invalid: ${error.message}`);
        deps.emit({ type: 'error', phase: 'config', code: 'merged-cells-invalid', message: error.message });
        return false;
      }
      if (error instanceof BorderConfigError) {
        diag.emit('error', 'config-error', `border-config-invalid: ${error.message}`);
        deps.emit({ type: 'error', phase: 'config', code: 'border-config-invalid', message: error.message });
        return false;
      }
      if (error instanceof ColumnTypeConfigError || error instanceof FormatRuleConfigError) {
        diag.emit('error', 'config-error', `column-types-invalid: ${error.message}`);
        deps.emit({ type: 'error', phase: 'config', code: 'column-types-invalid', message: error.message });
        return false;
      }
      if (error instanceof DisplayConfigError) {
        diag.emit('error', 'config-error', `column-display-invalid: ${error.message}`);
        deps.emit({ type: 'error', phase: 'config', code: 'column-display-invalid', message: error.message });
        return false;
      }
      throw error;
    }
  }

  return {
    build,
    appearance: () => appearance,
    registry: () => columnTypeRegistry,
    formats: () => compiledFormats,
    backgrounds: () => compiledBackgrounds,
    rowBackgrounds: () => compiledRowBackgrounds,
    statusColors: () => compiledStatusColors,
    borders: () => compiledBorders,
    display: () => compiledDisplay,
    columnGroups: () => compiledColumnGroups,
    validateRowBackgroundsOnce() {
      const backend = deps.backend();
      if (rowBackgroundsChecked || rowBackgroundRowSet.size === 0 || backend === undefined) {
        return;
      }
      rowBackgroundsChecked = true;
      const unknown = [...rowBackgroundRowSet].filter((rowId) => backend.view.rowIndexOf(createRowId(rowId)) < 0);
      if (unknown.length > 0) {
        diag.emit(
          'warn',
          'row-background-unknown',
          `rowBackgrounds: 未知の行 ${unknown.join(', ')}（初回描画時点の文書に存在しない）→ 該当 RowId が現れれば背景色を適用`,
        );
      }
    },
    validateRowBordersOnce() {
      const sync = deps.backend();
      const borders = compiledBorders;
      if (!rowBordersChecked && borders !== undefined && sync !== undefined) {
        rowBordersChecked = true;
        const unknown = borders.rowIds.filter((id) => sync.view.rowIndexOf(createRowId(id)) === -1);
        if (unknown.length > 0) diag.emit('warn', 'row-border-unknown', `rowBorders: 未知の行 ${unknown.join(', ')} → 到着後に適用`);
      }
    },
  };
}
