// 読むだけのセルへの編集を止めたときの consumer への通知（DD-069）。`edit-blocked`（選択中のセル・ダブルクリックしたセル）と
// `cells-skipped`（範囲の操作で飛ばしたセル）を組み立てて GridEvent として出す。止める判断そのものは従来どおり keyboard・
// pointer・edit-commands・cell-lock が持ち、ここは「どのセルを・何の操作で・なぜ」を公開の形にするだけ（DOM 非依存）。

import { mergeAnchorOf } from '@nanairo-sheet/selection';

import type { GridBackend } from '../grid-backend';
import type { GridCellRef, GridEditBlockedInput, GridEditBlockedReason, GridEvent } from '../index';
import type { IntegrationEditor } from '../integration-editor';
import type { CellLock } from './cell-lock';
import type { MountMerges } from './merges';

/**
 * 選択中のセルで編集を始めるキーを、通知の操作へ写す（編集を始めないキーは undefined）。F2・Delete・Backspace は修飾の有無に
 * よらない（readonly-policy の抑止と同じ）。印字キーは修飾なしの 1 文字と、日本語入力オンの打鍵（key が `Process`）。
 */
export function blockedKeyInput(input: { readonly key: string; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly altKey: boolean }):
  | GridEditBlockedInput
  | undefined {
  if (input.key === 'F2') {
    return 'f2';
  }
  if (input.key === 'Delete' || input.key === 'Backspace') {
    return 'delete';
  }
  if (input.ctrlKey || input.metaKey || input.altKey) {
    return undefined;
  }
  return input.key === 'Process' || input.key.length === 1 ? 'key' : undefined;
}

export interface EditBlockedDeps {
  emit(event: GridEvent): void;
  backend(): GridBackend | undefined;
  editor(): IntegrationEditor | undefined;
  readonly cellLock: Pick<CellLock, 'isReadOnlyColumnIndex' | 'isReadOnlyRowIndex' | 'isReadOnlyCellIndex'>;
  readonly merges: Pick<MountMerges, 'isMergedCellIndex' | 'current'>;
  isReadOnly(): boolean;
  /** 打鍵の処理が済んだ後に控えを出す（既定は setTimeout 0。テストで差し替える）。 */
  defer?: (run: () => void) => void;
}

export interface EditBlocked {
  /** 選択中のセルで止めた（キー・表全体が読み取り専用のときの貼り付け・切り取り・範囲の消去）。読むだけでなければ出さない。 */
  atActive(input: GridEditBlockedInput): void;
  /**
   * 素通しする印字キー（textarea の readOnly で止まる）を選択中のセルで止めた。位置と理由は今決め、出すのは打鍵の処理
   * （後段のハンドラ・状態機械・textarea の既定動作）が済んだ後。購読者がその場で setActiveCell などを呼んでも、
   * 同じ打鍵が移った先のセルに入らない（消費するキー・ダブルクリック・貼り付けは通知の直後に処理を終えるので即時でよい）。
   * 控えに積み、タイマー・次のキーやポインタの処理の始め（`flushPending`）・その場で出す通知の前の、いちばん早い時に出す。
   */
  atActiveAfterKeystroke(input: GridEditBlockedInput): void;
  /**
   * 控えの通知を届いた順に出す。キー・ポインタの処理の始めに呼ぶ（前の打鍵の通知を、この操作の判断より先に届ける。
   * Chrome はキー入力をタイマーより先に処理するので、タイマーだけだと次の打鍵の通知と順が入れ替わる）。
   */
  flushPending(): void;
  /** 表示 index のセルで止めた（ダブルクリック）。結合範囲の中なら左上のセルとして知らせる。読むだけでなければ出さない。 */
  atCell(row: number, col: number, input: GridEditBlockedInput): void;
  /** 範囲の操作で飛ばしたセル（0 件なら出さない）。 */
  skipped(operation: 'paste' | 'cut' | 'clear', cells: readonly GridCellRef[]): void;
}

export function createEditBlocked(deps: EditBlockedDeps): EditBlocked {
  const { cellLock, merges } = deps;

  /** 止めた理由。重なるときは 表全体 → 結合範囲 → 行 → 列 → 行データのセル の順で先のものを選ぶ。 */
  function reasonAt(row: number, col: number): GridEditBlockedReason | undefined {
    if (deps.isReadOnly()) {
      return 'grid-readonly';
    }
    if (merges.isMergedCellIndex(row, col)) {
      return 'merged';
    }
    if (cellLock.isReadOnlyRowIndex(row)) {
      return 'readonly-row';
    }
    if (cellLock.isReadOnlyColumnIndex(col)) {
      return 'readonly-column';
    }
    return cellLock.isReadOnlyCellIndex(row, col) ? 'readonly-cell' : undefined;
  }

  /** 表示 index のセルで止めた通知を組み立てる（読むだけでない・行や列の ID が引けないなら undefined）。 */
  function eventAt(row: number, col: number, input: GridEditBlockedInput): GridEvent | undefined {
    const backend = deps.backend();
    const reason = reasonAt(row, col);
    if (backend === undefined || reason === undefined) {
      return undefined;
    }
    const anchor = mergeAnchorOf(merges.current(), { row, col });
    const rowId = backend.view.rowIdAt(anchor.row);
    const columnId = backend.view.columnIdAt(anchor.col);
    if (rowId === undefined || columnId === undefined) {
      return undefined;
    }
    return { type: 'edit-blocked', rowId: String(rowId), columnId: String(columnId), input, reason };
  }

  const defer = deps.defer ?? ((run: () => void) => void setTimeout(run, 0));
  // 素通しする印字キーの通知の控え（届いた順）。破棄の後に出しても購読者が空なので届かない。
  let pending: GridEvent[] = [];

  function flushPending(): void {
    if (pending.length === 0) {
      return;
    }
    const queued = pending;
    pending = [];
    for (const event of queued) {
      deps.emit(event);
    }
  }

  /** その場で出す（控えがあれば先に出して、届く順を操作の順にそろえる）。 */
  function emitNow(event: GridEvent | undefined): void {
    if (event !== undefined) {
      flushPending();
      deps.emit(event);
    }
  }

  function notify(row: number, col: number, input: GridEditBlockedInput): void {
    emitNow(eventAt(row, col, input));
  }

  /**
   * 選択中のセルで止めた通知を組み立てる。変換中・Navigation でない位相では出さない（キーは keyboard でも確かめる。
   * 変換中に setReadOnly(true) を呼ぶと変換の終わりを待つ間も表全体の判定が先に効き、貼り付け・切り取りがここへ来る・Codex P2）。
   */
  function activeEvent(input: GridEditBlockedInput): GridEvent | undefined {
    const editor = deps.editor();
    if (editor === undefined || editor.session.isComposing() || editor.session.getPhase() !== 'Navigation') {
      return undefined;
    }
    const active = editor.session.getActiveCell();
    return eventAt(active.row, active.col, input);
  }

  return {
    atActive(input) {
      emitNow(activeEvent(input));
    },
    atActiveAfterKeystroke(input) {
      const event = activeEvent(input);
      if (event !== undefined) {
        pending.push(event);
        if (pending.length === 1) {
          defer(flushPending);
        }
      }
    },
    flushPending,
    atCell: notify,
    skipped(operation, cells) {
      if (cells.length > 0) {
        emitNow({ type: 'cells-skipped', operation, cells: [...cells] });
      }
    },
  };
}
