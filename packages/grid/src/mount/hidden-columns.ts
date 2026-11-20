// 見せる列の切り替え（DD-070-7）。隠す列を受け取って検査し、DocumentView の列の Axis（幅 0）へ反映する。backend の結線前に
// 受けた指定は覚えておき、結線したとき（editor の結線の後）に反映する。選択中のセルが隠した列に入ったら、最後に横へ動いた向きの
// 次の見えている列へ寄せる（結合の左上へ寄せる normalizeActiveCell の後に editor の onChange から呼ぶ・変換中や編集中は動かさない）。
// 編集中のセルの列を隠すときは、編集中のセルを確定してから隠す（変換中なら変換が終わってから・setReadOnly と同じ考え方）。

import type { CellRange } from '@nanairo-sheet/selection';
import { createColumnId } from '@nanairo-sheet/types';

import type { DiagnosticSink } from '../diagnostics';
import type { GridBackend } from '../grid-backend';
import type { IntegrationEditor } from '../integration-editor';
import type { SelectionController } from '../selection-controller';
import { errorMessage } from './constants';

export interface HiddenColumnsDeps {
  readonly diag: DiagnosticSink;
  readonly selectionCtrl: Pick<SelectionController, 'getRange' | 'extendTo'>;
  backend(): GridBackend | undefined;
  editor(): IntegrationEditor | undefined;
  /** 表示 index のセルを覆う結合範囲（無ければ undefined）。 */
  mergeAt(row: number, col: number): CellRange | undefined;
  /** 列の幅が変わった（scroll の幅を今すぐ合わせる・同じ処理の中の scrollToColumn が新しい幅を使えるように）。 */
  onColumnsChanged(): void;
}

export interface HiddenColumns {
  /** 隠す列を丸ごと置き換える（検査して反映。結線前・変換中なら覚えておく）。反映して変わったら true。 */
  set(raw: unknown, source: string): boolean;
  /** backend と editor の結線の後に、覚えておいた指定を反映する。 */
  attach(backend: GridBackend): void;
  /** 表示 index の列が隠れているか。 */
  isHiddenIndex(colIndex: number): boolean;
  /** editor の状態が変わったら呼ぶ（変換の終わりを待っている指定を、変換が終わっていれば反映する・macrotask で判定）。 */
  scheduleCheck(): void;
  /**
   * 選択中のセルが隠した列にあれば、最後に横へ動いた向きの次の見えている列へ寄せる（無ければ逆の向き）。Navigation で
   * 変換中でないときだけ。見えている列のある結合の中なら寄せない（結合の左上への寄せと往復しない）。寄せたら true。
   */
  normalizeActiveCell(): boolean;
}

export function createHiddenColumns(deps: HiddenColumnsDeps): HiddenColumns {
  const { diag } = deps;
  /** 反映を待っている指定（結線前・変換中）。 */
  let pending: readonly string[] | undefined;
  let checkScheduled = false;
  /** 直前の選択中の列と、最後に横へ動いた向き（Codex P2: 隠したときの寄せる向きに使う）。 */
  let lastActiveCol = 0;
  let lastDirection: 1 | -1 = 1;

  function validate(raw: unknown, source: string, backend: GridBackend | undefined): readonly string[] | undefined {
    if (!Array.isArray(raw)) {
      diag.emit('warn', 'hidden-columns-invalid', `${source}: 列 ID の配列が必要（何も変えない）`);
      return undefined;
    }
    const known = backend === undefined ? undefined : new Set(backend.session.committedDocument.columnOrder.map((id) => String(id)));
    const out: string[] = [];
    for (const id of raw as readonly unknown[]) {
      if (typeof id !== 'string' || (known !== undefined && !known.has(id))) {
        diag.emit('warn', 'hidden-columns-invalid', `${source}: 未知の列 ${String(id)} を無視`);
        continue;
      }
      out.push(id);
    }
    return out;
  }

  function isComposingNow(editor: IntegrationEditor | undefined): boolean {
    return editor !== undefined && (editor.session.isComposing() || editor.session.getPhase() === 'Composing');
  }

  /**
   * Codex P1: 編集中のセルの列を隠すときは、先に確定する（移動しない）。変換中は確定できないので false（変換の終わりを待つ）。
   * 編集中のセルが隠す列に無ければ何もしない。
   */
  function commitIfEditingHidden(backend: GridBackend, columnIds: readonly string[]): boolean {
    const editor = deps.editor();
    if (editor === undefined || editor.session.getPhase() === 'Navigation') {
      return true;
    }
    const activeColumn = backend.view.columnIdAt(editor.session.getActiveCell().col);
    if (activeColumn === undefined || !columnIds.includes(String(activeColumn))) {
      return true;
    }
    if (isComposingNow(editor)) {
      return false;
    }
    if (backend.session.isStopped) {
      return true;
    }
    try {
      if (editor.commitEdit() === 'composing') {
        return false;
      }
    } catch (error) {
      diag.emit('error', 'commit-edit-failed', `編集中のセルの確定に失敗しました: ${errorMessage(error)}`);
    }
    return true;
  }

  function apply(backend: GridBackend, columnIds: readonly string[]): boolean {
    if (!commitIfEditingHidden(backend, columnIds)) {
      pending = columnIds;
      diag.emit('info', 'hidden-columns-deferred', '隠す列: IME 変換中のため、変換が終わってから編集中のセルを確定して隠す');
      return false;
    }
    pending = undefined;
    const before = new Set(columnIds);
    const wasHidden = backend.session.committedDocument.columnOrder.filter((id) => backend.view.isColumnHidden(id)).map(String);
    const changed = backend.view.setHiddenColumns(columnIds.map((id) => createColumnId(id)));
    if (!changed) {
      return false;
    }
    // Codex P2: 隠す・見せるが変わった折り返し列があれば、自動の行高を測り直す（幅 0 の間は数えていない）。
    const flipped = [...wasHidden.filter((id) => !before.has(id)), ...columnIds.filter((id) => !wasHidden.includes(id))];
    if (flipped.some((id) => backend.view.isWrapColumn(createColumnId(id)))) {
      backend.view.recomputeAllAutoRowHeights();
    }
    deps.onColumnsChanged();
    moveOffHidden(true);
    return true;
  }

  function isHiddenIndex(colIndex: number): boolean {
    const view = deps.backend()?.view;
    if (view === undefined || !view.hasHiddenColumns()) {
      return false;
    }
    const id = view.columnIdAt(colIndex);
    return id !== undefined && view.isColumnHidden(id);
  }

  /** 見えている列を含む結合の中か（その結合は 1 つのセルとして見えている）。 */
  function inVisibleMerge(row: number, col: number): boolean {
    const merge = deps.mergeAt(row, col);
    if (merge === undefined) {
      return false;
    }
    for (let c = merge.colStart; c < merge.colEnd; c += 1) {
      if (!isHiddenIndex(c)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 選択中のセルを隠した列から寄せる。`fromHide` は隠したことによる寄せ（最後に横へ動いた向きを使い、範囲は保つ）。
   * フォーカスは移さない（Codex P2: 列を切り替える外のコントロールのフォーカスを奪わない）。
   */
  function moveOffHidden(fromHide: boolean): boolean {
    const view = deps.backend()?.view;
    const editor = deps.editor();
    if (view === undefined || editor === undefined) {
      return false;
    }
    const active = editor.session.getActiveCell();
    if (!fromHide && active.col !== lastActiveCol) {
      lastDirection = active.col > lastActiveCol ? 1 : -1;
    }
    lastActiveCol = active.col;
    if (!view.hasHiddenColumns() || !isHiddenIndex(active.col) || inVisibleMerge(active.row, active.col)) {
      return false;
    }
    if (isComposingNow(editor) || editor.session.getPhase() !== 'Navigation') {
      return false;
    }
    const count = view.colAxis.count();
    // Codex P2: 範囲の起点を隠したときは、範囲の他方の端（focus）を保つ（範囲全体を解除しない）。
    const range = fromHide ? deps.selectionCtrl.getRange() : null;
    const focus =
      range === null
        ? null
        : {
            row: active.row === range.rowStart ? range.rowEnd - 1 : range.rowStart,
            col: active.col === range.colStart ? range.colEnd - 1 : range.colStart,
          };
    for (const dir of [lastDirection, -lastDirection]) {
      for (let col = active.col + dir; col >= 0 && col < count; col += dir) {
        if (!isHiddenIndex(col)) {
          lastActiveCol = col;
          const target = { row: active.row, col };
          editor.pointerdownCell(target, { focus: false });
          if (focus !== null && (focus.row !== target.row || focus.col !== target.col)) {
            deps.selectionCtrl.extendTo(target, focus);
          }
          return true;
        }
      }
    }
    return false; // 全部の列を隠した（寄せない）
  }

  return {
    set(raw, source) {
      const backend = deps.backend();
      const columnIds = validate(raw, source, backend);
      if (columnIds === undefined) {
        return false;
      }
      if (backend === undefined || deps.editor() === undefined) {
        pending = columnIds;
        return false;
      }
      return apply(backend, columnIds);
    },
    attach(backend) {
      if (pending === undefined) {
        return;
      }
      // 結線前に覚えた指定は、列の並びが分かった今もう一度検査してから反映する（editor の結線の後に呼ぶ＝寄せられる）。
      const columnIds = validate(pending, 'hiddenColumns', backend);
      pending = undefined;
      if (columnIds !== undefined) {
        apply(backend, columnIds);
      }
    },
    isHiddenIndex,
    scheduleCheck() {
      if (pending === undefined || checkScheduled) {
        return;
      }
      checkScheduled = true;
      setTimeout(() => {
        checkScheduled = false;
        const backend = deps.backend();
        if (pending !== undefined && backend !== undefined && deps.editor() !== undefined && !isComposingNow(deps.editor())) {
          apply(backend, pending);
        }
      }, 0);
    },
    normalizeActiveCell: () => moveOffHidden(false),
  };
}
