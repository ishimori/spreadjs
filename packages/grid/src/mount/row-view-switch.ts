// 見せる行と並びの切り替え（setRowView・DD-070-8）。consumer が渡した見せる行を検査し、DocumentView の行の Axis へ反映する。
// 編集中に呼ばれたら、編集中のセルを確定（移動しない）してから並びを変える。IME の変換中なら、変換が終わってから確定して変える
// （setReadOnly と同じ考え方・I-3: 変換中の textarea に触れない）。backend の結線前に受けた指定は覚えておき、結線の時に反映する。

import { createRowId } from '@nanairo-sheet/types';
import type { RowId } from '@nanairo-sheet/types';

import type { DiagnosticSink } from '../diagnostics';
import type { GridBackend } from '../grid-backend';
import type { IntegrationEditor } from '../integration-editor';
import { errorMessage } from './constants';

export interface RowViewSwitchDeps {
  readonly diag: DiagnosticSink;
  isDestroyed(): boolean;
  backend(): GridBackend | undefined;
  editor(): IntegrationEditor | undefined;
  /** 開いている候補欄・日付カレンダーを閉じる（並びが変わると開いているセルの位置が変わる）。 */
  closePopups(): void;
  /** 保留中の構造変更（見せる並びを含む）を今すぐ行の Axis へ反映する（visibleRowIds の同期の読み取り用）。 */
  flushPendingStructure(): void;
}

export interface RowViewSwitch {
  /** setRowView の実体。不正な値は何も変えずに warn。 */
  set(raw: unknown): void;
  /** backend の結線時に、結線前に受けた指定を反映する。 */
  attach(backend: GridBackend): void;
  /** editor の状態が変わったら呼ぶ（変換の終わりを待っている指定を、変換が終わっていれば反映する・macrotask で判定）。 */
  scheduleCheck(): void;
  /** 今見せている行（見せる順）。boot 前・destroy 後は []。 */
  visibleRowIds(): readonly string[];
}

/** 渡された値の検査。null は「文書の並びへ戻す」。配列でも null でもなければ undefined（何も変えない）。 */
function parse(raw: unknown, diag: DiagnosticSink): readonly RowId[] | null | undefined {
  if (raw === null) {
    return null;
  }
  if (!Array.isArray(raw)) {
    diag.emit('warn', 'row-view-invalid', 'setRowView: 行 ID の配列か null が必要（何も変えない）');
    return undefined;
  }
  const out: RowId[] = [];
  let skipped = 0;
  for (const id of raw as readonly unknown[]) {
    if (typeof id !== 'string') {
      skipped += 1;
      continue;
    }
    out.push(createRowId(id));
  }
  if (skipped > 0) {
    diag.emit('warn', 'row-view-invalid', `setRowView: 文字列でない行 ID ${skipped} 件を無視`);
  }
  return out;
}

export function createRowViewSwitch(deps: RowViewSwitchDeps): RowViewSwitch {
  const { diag } = deps;
  /** 反映を待っている指定（結線前・変換中）。undefined なら待っていない。 */
  let pending: { readonly order: readonly RowId[] | null } | undefined;
  let checkScheduled = false;

  function isComposingNow(editor: IntegrationEditor | undefined): boolean {
    return editor !== undefined && (editor.session.isComposing() || editor.session.getPhase() === 'Composing');
  }

  /** 編集中のセルを確定（移動しない）する。変換中なら false（確定できない）。 */
  function commitEditing(editor: IntegrationEditor | undefined, backend: GridBackend): boolean {
    if (editor === undefined || editor.session.getPhase() === 'Navigation') {
      return true;
    }
    if (backend.session.isStopped) {
      return true; // 接続が終端した後は確定しない（送れない）。並びだけを変える
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

  function apply(backend: GridBackend, order: readonly RowId[] | null): void {
    const editor = deps.editor();
    if (isComposingNow(editor) || !commitEditing(editor, backend)) {
      pending = { order };
      diag.emit('info', 'row-view-deferred', 'setRowView: IME 変換中のため、変換が終わってから編集中のセルを確定して並びを変える');
      return;
    }
    pending = undefined;
    deps.closePopups();
    const unknown = backend.view.setRowView(order);
    if (unknown > 0) {
      diag.emit('warn', 'row-view-invalid', `setRowView: 文書に無い行 ID ${unknown} 件を無視`);
    }
  }

  return {
    set(raw) {
      if (deps.isDestroyed()) {
        return;
      }
      const order = parse(raw, diag);
      if (order === undefined) {
        return;
      }
      const backend = deps.backend();
      if (backend === undefined) {
        pending = { order };
        return;
      }
      apply(backend, order);
    },
    attach(backend) {
      if (pending !== undefined) {
        apply(backend, pending.order);
      }
    },
    scheduleCheck() {
      if (pending === undefined || checkScheduled) {
        return;
      }
      checkScheduled = true;
      // 変換の確定は IME のイベントの処理の途中で届くので、その処理が終わった次のタスクで判定する（setReadOnly と同じ）。
      setTimeout(() => {
        checkScheduled = false;
        const backend = deps.backend();
        if (pending === undefined || deps.isDestroyed() || backend === undefined) {
          return;
        }
        if (!isComposingNow(deps.editor())) {
          apply(backend, pending.order);
        }
      }, 0);
    },
    visibleRowIds() {
      const view = deps.backend()?.view;
      if (deps.isDestroyed() || view === undefined) {
        return [];
      }
      deps.flushPendingStructure();
      const axis = view.rowAxis;
      const out: string[] = [];
      const count = axis.count();
      for (let i = 0; i < count; i += 1) {
        out.push(String(axis.getId(i)));
      }
      return out;
    },
  };
}
