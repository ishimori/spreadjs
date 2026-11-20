// 見せる列の切り替え（DD-070-7）。隠す列を受け取って検査し、DocumentView の列の Axis（幅 0）へ反映する。backend の結線前に
// 受けた指定は覚えておき、結線したときに反映する。選択中のセルが隠した列に入ったら、動いてきた向きの次の見えている列へ寄せる
// （結合の左上へ寄せる normalizeActiveCell と同じく editor の onChange から呼ぶ・変換中や編集中は動かさない）。

import { createColumnId } from '@nanairo-sheet/types';

import type { DiagnosticSink } from '../diagnostics';
import type { GridBackend } from '../grid-backend';
import type { IntegrationEditor } from '../integration-editor';

export interface HiddenColumnsDeps {
  readonly diag: DiagnosticSink;
  backend(): GridBackend | undefined;
  editor(): IntegrationEditor | undefined;
}

export interface HiddenColumns {
  /** 隠す列を丸ごと置き換える（検査して反映。結線前なら覚えておく）。反映して変わったら true。 */
  set(raw: unknown, source: string): boolean;
  /** backend の結線時に、覚えておいた指定を反映する。 */
  attach(backend: GridBackend): void;
  /** 表示 index の列が隠れているか。 */
  isHiddenIndex(colIndex: number): boolean;
  /**
   * 選択中のセルが隠した列にあれば、前の列から動いてきた向きの次の見えている列へ寄せる（無ければ逆の向き）。Navigation で
   * 変換中でないときだけ。寄せたら true（寄せた先の onChange が後の処理を済ませる）。
   */
  normalizeActiveCell(): boolean;
}

export function createHiddenColumns(deps: HiddenColumnsDeps): HiddenColumns {
  const { diag } = deps;
  /** 結線前に受けた指定（結線したら反映して捨てる）。 */
  let pending: readonly string[] | undefined;
  /** 直前の選択中の列（寄せる向きの判定に使う）。 */
  let lastActiveCol = 0;

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

  function apply(backend: GridBackend, columnIds: readonly string[]): boolean {
    const changed = backend.view.setHiddenColumns(columnIds.map((id) => createColumnId(id)));
    if (changed) {
      normalizeActiveCell();
    }
    return changed;
  }

  function isHiddenIndex(colIndex: number): boolean {
    const view = deps.backend()?.view;
    if (view === undefined || !view.hasHiddenColumns()) {
      return false;
    }
    const id = view.columnIdAt(colIndex);
    return id !== undefined && view.isColumnHidden(id);
  }

  function normalizeActiveCell(): boolean {
    const view = deps.backend()?.view;
    const editor = deps.editor();
    if (view === undefined || editor === undefined) {
      return false;
    }
    const active = editor.session.getActiveCell();
    const previous = lastActiveCol;
    lastActiveCol = active.col;
    if (!view.hasHiddenColumns() || !isHiddenIndex(active.col)) {
      return false;
    }
    if (editor.session.isComposing() || editor.session.getPhase() !== 'Navigation') {
      return false;
    }
    const count = view.colAxis.count();
    const prefer = active.col >= previous ? 1 : -1;
    for (const dir of [prefer, -prefer]) {
      for (let col = active.col + dir; col >= 0 && col < count; col += dir) {
        if (!isHiddenIndex(col)) {
          lastActiveCol = col;
          editor.pointerdownCell({ row: active.row, col });
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
      if (backend === undefined) {
        pending = columnIds;
        return false;
      }
      return apply(backend, columnIds);
    },
    attach(backend) {
      if (pending === undefined) {
        return;
      }
      // 結線前に覚えた指定は、列の並びが分かった今もう一度検査してから反映する。
      const columnIds = validate(pending, 'hiddenColumns', backend);
      pending = undefined;
      if (columnIds !== undefined) {
        apply(backend, columnIds);
      }
    },
    isHiddenIndex,
    normalizeActiveCell,
  };
}
