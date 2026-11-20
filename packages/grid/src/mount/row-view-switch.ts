// 見せる行と並びの切り替え（setRowView・DD-070-8）。consumer が渡した見せる行を検査し、DocumentView の行の Axis へ反映する。
// 編集中に呼ばれたら、編集中のセルを確定（移動しない）してから並びを変える。IME の変換中なら、変換が終わってから確定して変える
// （setReadOnly と同じ考え方・I-3: 変換中の textarea に触れない）。
//
// 「呼んだ時点にあった行」は呼んだ時に決める（Codex P2: 変換の終わりまで待つ間にできた行を隠さない）。backend の結線前に
// 受けた指定は、単独モードなら setData と同じ boot 前の queue に呼ばれた順で積み（Codex P2: 保留した setData より先に
// 反映すると、注入した行が全部「後からできた行」になる）、それ以外は覚えておいて結線の時に反映する。

import { createRowId } from '@nanairo-sheet/types';
import type { RowId } from '@nanairo-sheet/types';

import type { DiagnosticSink } from '../diagnostics';
import type { GridBackend } from '../grid-backend';
import type { IntegrationEditor } from '../integration-editor';
import type { RowViewSpec } from '../row-view';
import { errorMessage } from './constants';

export interface RowViewSwitchDeps {
  readonly diag: DiagnosticSink;
  isDestroyed(): boolean;
  backend(): GridBackend | undefined;
  editor(): IntegrationEditor | undefined;
  /** 開いている候補欄・日付カレンダーを閉じる（並びが変わると開いているセルの位置が変わる）。 */
  closePopups(): void;
  /**
   * 単独モードの boot 前なら、setData・setRows と同じ queue に呼ばれた順で積む（積んだら true）。単独モードでない・boot 済みなら
   * false（積まない）。
   */
  deferUntilStandaloneBoot(run: () => void): boolean;
}

export interface RowViewSwitch {
  /** setRowView の実体。不正な値は何も変えずに warn。 */
  set(raw: unknown): void;
  /** backend の結線時に、結線前に受けた指定を反映する。 */
  attach(backend: GridBackend): void;
  /** editor の状態が変わったら呼ぶ（変換の終わりを待っている指定を、変換が終わっていれば反映する・macrotask で判定）。 */
  scheduleCheck(): void;
  /** 今見せている行（見せる順・保留中の構造変更を含む）。boot 前・destroy 後は []。 */
  visibleRowIds(): readonly string[];
}

/**
 * 渡された値の検査。null は「文書の並びへ戻す」。配列でも null でもない・文字列でない要素を含むなら undefined（何も変えない・
 * Codex P2: 文字列でない要素だけを除いて反映すると、`[null]` で全部の行が消える）。
 */
function parse(raw: unknown, diag: DiagnosticSink): readonly RowId[] | null | undefined {
  if (raw === null) {
    return null;
  }
  if (!Array.isArray(raw)) {
    diag.emit('warn', 'row-view-invalid', 'setRowView: 行 ID の配列か null が必要（何も変えない）');
    return undefined;
  }
  const out: RowId[] = [];
  for (const id of raw as readonly unknown[]) {
    if (typeof id !== 'string') {
      diag.emit('warn', 'row-view-invalid', 'setRowView: 文字列でない行 ID を含む（何も変えない）');
      return undefined;
    }
    out.push(createRowId(id));
  }
  return out;
}

export function createRowViewSwitch(deps: RowViewSwitchDeps): RowViewSwitch {
  const { diag } = deps;
  /** 結線前に受けた指定（単独モードの boot 前は queue に積むので使わない）。undefined なら無い。 */
  let beforeAttach: { readonly order: readonly RowId[] | null } | undefined;
  /** 変換の終わりを待っている、組み立て済みの指定。undefined なら待っていない。 */
  let waiting: { readonly spec: RowViewSpec | null } | undefined;
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

  /** 今の文書で指定を組み立てる（呼んだ時点の行を決める）。文書に無い行 ID は warn。 */
  function build(backend: GridBackend, order: readonly RowId[] | null): RowViewSpec | null {
    if (order === null) {
      return null;
    }
    const { spec, unknown } = backend.view.createRowViewSpec(order);
    if (unknown > 0) {
      diag.emit('warn', 'row-view-invalid', `setRowView: 文書に無い行 ID ${unknown} 件を無視`);
    }
    return spec;
  }

  function apply(backend: GridBackend, spec: RowViewSpec | null): void {
    const editor = deps.editor();
    if (isComposingNow(editor) || !commitEditing(editor, backend)) {
      waiting = { spec };
      diag.emit('info', 'row-view-deferred', 'setRowView: IME 変換中のため、変換が終わってから編集中のセルを確定して並びを変える');
      return;
    }
    waiting = undefined;
    deps.closePopups();
    backend.view.setRowView(spec);
  }

  function applyNow(order: readonly RowId[] | null): void {
    const backend = deps.backend();
    if (deps.isDestroyed() || backend === undefined) {
      return;
    }
    apply(backend, build(backend, order));
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
      if (deps.backend() !== undefined) {
        applyNow(order);
        return;
      }
      if (deps.deferUntilStandaloneBoot(() => applyNow(order))) {
        return;
      }
      beforeAttach = { order };
    },
    attach(backend) {
      if (beforeAttach !== undefined) {
        const { order } = beforeAttach;
        beforeAttach = undefined;
        apply(backend, build(backend, order));
      }
    },
    scheduleCheck() {
      if (waiting === undefined || checkScheduled) {
        return;
      }
      checkScheduled = true;
      // 変換の確定は IME のイベントの処理の途中で届くので、その処理が終わった次のタスクで判定する（setReadOnly と同じ）。
      setTimeout(() => {
        checkScheduled = false;
        const backend = deps.backend();
        if (waiting === undefined || deps.isDestroyed() || backend === undefined) {
          return;
        }
        if (!isComposingNow(deps.editor())) {
          apply(backend, waiting.spec);
        }
      }, 0);
    },
    visibleRowIds() {
      const view = deps.backend()?.view;
      if (deps.isDestroyed() || view === undefined) {
        return [];
      }
      // Codex P2: 初回の描画の前でも、保留中の構造変更・見せる並びを反映した並びを返す（flush を待たない）。
      return view.pendingRowOrder().map(String);
    },
  };
}
