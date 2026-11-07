// 結合（DD-064・view-local）。結合の指定の検査、描画の時の行への張り付け、アクティブセルの左上への寄せ。
// DD-065 で mount-controller.ts から分けた。張れない・壊れた理由は診断 warn（1 つの指定につき 1 回）。

import { mergeAnchorOf } from '@nanairo-sheet/selection';
import type { MergeIndex } from '@nanairo-sheet/selection';
import type { ColumnId, RowId } from '@nanairo-sheet/types';

import type { DiagnosticSink } from '../diagnostics';
import type { GridBackend } from '../grid-backend';
import type { IntegrationEditor } from '../integration-editor';
import { MergedCellsConfigError, describeMergeIssues, validateMergedCells } from '../merged-cell-spec';
import { createMergeRegistry } from '../merged-cells';

export interface MergesDeps {
  readonly diag: DiagnosticSink;
  backend(): GridBackend | undefined;
  editor(): IntegrationEditor | undefined;
  frozenRowCount(): number;
  frozenColCount(): number;
}

export interface MountMerges {
  /** 直前の描画で張った結合（クリック・キー・コピー・描画はすべてこれで判定する＝画面と食い違わない）。 */
  current(): MergeIndex;
  /** 張った結合が 1 つ以上あるか（無ければ結合の分岐は一切コストを持たない）。 */
  any(): boolean;
  /** 行・列 index が結合範囲のセルか（左上を含む）。 */
  isMergedCellIndex(rowIndex: number, colIndex: number): boolean;
  /** RowId・ColumnId が結合範囲のセルか（SetCells の変更の判定用。今の行 Axis で index へ引く）。 */
  isMergedCellId(rowId: RowId, columnId: ColumnId): boolean;
  /** 結合を今の行 Axis に張り直すだけ（副作用なし）。張った結合が変わったら true。 */
  resolve(): boolean;
  /**
   * mount オプションの結合を検査して置く（形の誤りが 1 件でもあれば MergedCellsConfigError を投げる＝fail-fast）。
   * 列の並びが決まるので、boot 前に保留した setMergedCells（最後の 1 回）をこの後に適用する（呼んだ側の指定が勝つ）。
   */
  applyMountOption(raw: unknown, columnOrder: readonly string[]): void;
  /** setMergedCells の実体。列の並びが分かる前（boot 前）は最後の 1 回だけ保留する。 */
  setFromCommand(raw: unknown): void;
  /**
   * アクティブセルが結合範囲の中（左上以外）なら左上へ移す（Navigation かつ変換中でないときだけ・I-3）。
   * 常駐 textarea へフォーカスは移さない（ページの他の入力欄からフォーカスを奪わない）。移したら true。
   */
  normalizeActiveCell(): boolean;
}

export function createMerges(deps: MergesDeps): MountMerges {
  const { diag } = deps;
  const registry = createMergeRegistry((code, message) => diag.emit('warn', code, message));
  // 結合の形の検査に使う列の並び（boot で確定）。未確定の間に呼ばれた setMergedCells は最後の 1 回だけ保留する。
  let columnOrderForCommands: readonly string[] | undefined;
  let pendingCommand: { readonly raw: unknown } | undefined;

  const current = (): MergeIndex => registry.index();
  const any = (): boolean => registry.index().size > 0;

  function isMergedCellIndex(rowIndex: number, colIndex: number): boolean {
    return any() && current().at(rowIndex, colIndex) !== undefined;
  }

  function isMergedCellId(rowId: RowId, columnId: ColumnId): boolean {
    const sync = deps.backend();
    if (!any() || sync === undefined) {
      return false;
    }
    const row = sync.view.rowIndexOf(rowId);
    const col = sync.view.colIndexOf(columnId);
    return row >= 0 && col >= 0 && current().at(row, col) !== undefined;
  }

  /**
   * 結合の指定を形の検査をして置き換える（setMergedCells・boot 前の保留の適用）。throw しない: 形の誤りの指定だけ捨てて
   * 診断 warn（merged-cells-invalid）を出し、残りは張る。配列でなければ何も変えない。張るのは次の描画の時（contract §1.2）。
   */
  function applyCommand(raw: unknown, columnOrder: readonly string[]): void {
    // 命令の引数は配列だけを受ける（Codex P2: undefined を mount オプションの「省略」と同じに扱うと、警告なしで全部外れる）。
    const result = Array.isArray(raw)
      ? validateMergedCells(raw, columnOrder, deps.frozenColCount())
      : { notArray: true, specs: [], issues: [] };
    if (result.notArray) {
      diag.emit('warn', 'merged-cells-invalid', 'setMergedCells: { rowId, columnId, rowSpan?, columnSpan? } の配列が必要（無視）');
      return;
    }
    if (result.issues.length > 0) {
      diag.emit('warn', 'merged-cells-invalid', `setMergedCells: 形の誤りの指定を捨てた（${describeMergeIssues(result.issues)}）`);
    }
    registry.replace(result.specs);
    deps.backend()?.view.markViewportDirty(); // 次の描画で張る（呼ぶ順によらず、その時の行の並びで張る）
  }

  return {
    current,
    any,
    isMergedCellIndex,
    isMergedCellId,
    resolve() {
      const backend = deps.backend();
      return backend !== undefined && registry.resolve(backend.view.rowAxis, deps.frozenRowCount());
    },
    applyMountOption(raw, columnOrder) {
      const mountMerges = validateMergedCells(raw, columnOrder, deps.frozenColCount());
      if (mountMerges.notArray) {
        throw new MergedCellsConfigError('mergedCells: { rowId, columnId, rowSpan?, columnSpan? } の配列が必要');
      }
      if (mountMerges.issues.length > 0) {
        throw new MergedCellsConfigError(describeMergeIssues(mountMerges.issues));
      }
      registry.replace(mountMerges.specs);
      columnOrderForCommands = columnOrder;
      if (pendingCommand !== undefined) {
        const pending = pendingCommand;
        pendingCommand = undefined;
        applyCommand(pending.raw, columnOrder);
      }
    },
    setFromCommand(raw) {
      if (columnOrderForCommands === undefined) {
        pendingCommand = { raw };
        return;
      }
      applyCommand(raw, columnOrderForCommands);
    },
    normalizeActiveCell() {
      const editor = deps.editor();
      if (editor === undefined || !any() || editor.session.isComposing() || editor.session.getPhase() !== 'Navigation') {
        return false;
      }
      const active = editor.session.getActiveCell();
      const anchor = mergeAnchorOf(current(), active);
      if (anchor.row === active.row && anchor.col === active.col) {
        return false;
      }
      editor.pointerdownCell(anchor, { focus: false });
      return true;
    },
  };
}
