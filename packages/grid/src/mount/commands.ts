// 命令 API（DD-035 R6 の scrollToRow・scrollToColumn・setActiveCell）と、その保留キュー。DD-065 で mount-controller.ts から分けた。
// boot 未完了・初回描画前・構造 dirty 中（setData／行挿入削除の直後で rowAxis が未再構築）は RowId→index が旧 Axis を指し、
// しかも masterLoop の scroll anchor 補正が直後に scrollTop を上書きするため、次の構造 flush（補正の後）まで保留して適用する。
// これにより `setData(...)` → 直後の `scrollToRow(newId)` が成立する（松下 DD-012-1 の実測課題）。

import type { CellPosition } from '@nanairo-sheet/ime';
import { mergeAnchorOf } from '@nanairo-sheet/selection';
import type { MergeIndex } from '@nanairo-sheet/selection';
import { createColumnId, createRowId } from '@nanairo-sheet/types';

import type { DiagnosticSink } from '../diagnostics';
import type { GridBackend } from '../grid-backend';
import type { IntegrationEditor } from '../integration-editor';
import type { SelectionController } from '../selection-controller';
import { PENDING_COMMANDS_MAX } from './constants';

export interface CommandsDeps {
  readonly diag: DiagnosticSink;
  readonly selectionCtrl: Pick<SelectionController, 'clear'>;
  isDestroyed(): boolean;
  backend(): GridBackend | undefined;
  editor(): IntegrationEditor | undefined;
  isFirstDataDrawn(): boolean;
  viewportWidth(): number;
  currentMerges(): MergeIndex;
  /** 開いている候補欄・日付カレンダーを閉じる（セルクリックと同じ経路）。 */
  closePopups(): void;
  /** 構造 Op の flush（scroll anchor 補正・再ベース込み）。構造 dirty 中の命令は同期でこれを走らせてから適用する。 */
  flushStructural(view: GridBackend['view']): void;
  ensureCellVisible(cell: CellPosition, axes?: 'both' | 'vertical' | 'horizontal'): void;
}

export interface MountCommands {
  /**
   * 命令を即時実行するか、次の構造 flush 後まで保留する（保留中の複数命令は呼び出し順に適用する）。
   * 保留は上限（PENDING_COMMANDS_MAX）で古い順に捨てる: 空文書（初回描画が起きない）や boot 失敗のまま利用側が
   * 呼び続けても無限に溜めない（最後の要求だけ意味を持つ操作なので古いものは安全に捨てられる）。
   */
  runOrDefer(command: () => void, canRunNow?: () => boolean): void;
  /** masterLoop が構造 flush の後に呼ぶ: 保留命令を新 Axis で適用する。 */
  drain(): void;
  /** 保留中の命令があるか（初回描画前の打鍵を旧セルへ確定させないよう、editor の入力を論理遮断する条件）。 */
  hasPending(): boolean;
  scrollToRow(rowId: string): void;
  scrollToColumn(columnId: string): void;
  setActiveCell(rowId: string, columnId: string): void;
  /** destroy: 保留中の命令を捨てる（rAF ループ停止後に走らせない）。 */
  discard(): void;
}

export function createCommands(deps: CommandsDeps): MountCommands {
  const { diag } = deps;
  let pendingCommands: Array<() => void> = [];

  /** 命令を即時実行できる状態か（backend 配線済み・初回描画済み・構造 dirty なし）。 */
  function canRunCommandsNow(): boolean {
    const sync = deps.backend();
    return sync !== undefined && deps.isFirstDataDrawn() && !sync.view.hasStructuralDirty();
  }

  /**
   * 列方向の命令（scrollToColumn）を即時実行できる状態か（DD-036・Codex P2）。
   * 行方向と違い**初回描画（firstDataDrawn）を条件にしない**: 行が 0 件の文書では初回描画が永遠に
   * 立たず、列だけを持つ空シートで `scrollToColumn` がキューに残り続けるため。列 Axis と viewport の寸法が
   * 揃っていれば横スクロールは成立する。
   */
  function canRunColumnCommandsNow(): boolean {
    const sync = deps.backend();
    return sync !== undefined && !sync.view.hasStructuralDirty() && sync.view.colAxis.count() > 0 && deps.viewportWidth() > 0;
  }

  function runOrDefer(command: () => void, canRunNow: () => boolean = canRunCommandsNow): void {
    if (deps.isDestroyed()) {
      return;
    }
    // Codex P1: 構造 dirty（setData／行挿入削除の直後）なら次 rAF を待たず**同期的に**構造 flush してから適用する。
    // 保留のままだと、その間に届いた利用者入力（ボタン→insertRows→setActiveCell 直後の打鍵）が旧アクティブセルで
    // BeginEdit し、保留命令の pointerdownCell がそれを旧セルへ確定してしまう（誤セル確定）。
    const sync = deps.backend();
    if (sync !== undefined && deps.isFirstDataDrawn() && sync.view.hasStructuralDirty()) {
      deps.flushStructural(sync.view);
    }
    if (canRunNow()) {
      command();
      return;
    }
    if (pendingCommands.length >= PENDING_COMMANDS_MAX) {
      pendingCommands.shift();
      diag.emit('warn', 'command-queue-overflow', `命令 API の保留が上限 ${PENDING_COMMANDS_MAX} を超えたため最古の要求を破棄`);
    }
    pendingCommands.push(command);
  }

  /**
   * DD-036（Codex P2）: 行が 0 件のままでも列命令は成立するため、行 ready・列 ready のどちらかで drain する
   * （個々の命令は自分の前提が崩れていれば内部で no-op＋診断する）。
   */
  function drain(): void {
    if (pendingCommands.length === 0 || !(canRunCommandsNow() || canRunColumnCommandsNow())) {
      return;
    }
    const commands = pendingCommands;
    pendingCommands = [];
    for (const command of commands) {
      command();
    }
  }

  /**
   * scrollToRow の実体（可視化のみ・横スクロールは動かさない）。
   * DD-036 C4: 軸指定 'vertical' で明示する（従来の「col: 0 は固定列だから横が動かない」という暗黙前提を廃止＝
   * `frozenColumnCount: 0` でも横スクロールが動かない）。
   */
  function performScrollToRow(rowId: string): void {
    const backend = deps.backend();
    if (backend === undefined) {
      return;
    }
    const row = backend.view.rowIndexOf(createRowId(rowId));
    if (row < 0) {
      diag.emit('warn', 'scroll-row-unknown', `scrollToRow: 未知の行 rowId=${rowId}（tombstone/未注入）→ 無視`);
      return;
    }
    deps.ensureCellVisible({ row, col: 0 }, 'vertical');
    backend.view.markViewportDirty();
    diag.emit('info', 'scroll-to-row', `scrollToRow: rowId=${rowId} index=${row}`);
  }

  /** scrollToColumn の実体（DD-036 C4・performScrollToRow の鏡像。縦スクロールは動かさない）。 */
  function performScrollToColumn(columnId: string): void {
    const backend = deps.backend();
    if (backend === undefined) {
      return;
    }
    const col = backend.view.colIndexOf(createColumnId(columnId));
    if (col < 0) {
      diag.emit('warn', 'scroll-column-unknown', `scrollToColumn: 未知の列 columnId=${columnId} → 無視`);
      return;
    }
    deps.ensureCellVisible({ row: 0, col }, 'horizontal');
    backend.view.markViewportDirty();
    diag.emit('info', 'scroll-to-column', `scrollToColumn: columnId=${columnId} index=${col}`);
  }

  /**
   * setActiveCell の実体。セルクリック（scroller pointerdown）と同じ経路: 開いている選択式/日付ポップアップを閉じ、
   * 明示レンジを解除し、editor.pointerdownCell（編集中は確定して移動・composition 中は pendingNavigation・常駐 textarea へ
   * focus）→ 可視化。activeCell の所有は editor-state-machine のまま（無改変・I-3）。
   */
  function performSetActiveCell(rowId: string, columnId: string): void {
    const backend = deps.backend();
    const editor = deps.editor();
    if (backend === undefined || editor === undefined) {
      return;
    }
    const row = backend.view.rowIndexOf(createRowId(rowId));
    const col = backend.view.colIndexOf(createColumnId(columnId));
    if (row < 0 || col < 0) {
      diag.emit(
        'warn',
        'active-cell-unknown',
        `setActiveCell: 未知のセル rowId=${rowId} columnId=${columnId}（row=${row} col=${col}）→ 無視`,
      );
      return;
    }
    deps.closePopups();
    deps.selectionCtrl.clear();
    // DD-064: 結合範囲の中を指したら左上へ（範囲の中は左上のセルとして選ぶ）。
    const target = mergeAnchorOf(deps.currentMerges(), { row, col });
    editor.pointerdownCell(target);
    deps.ensureCellVisible(target); // composition 中は activeCell が動かない（pendingNavigation）が可視化はしておく
    backend.view.markViewportDirty();
    diag.emit('info', 'set-active-cell', `setActiveCell: rowId=${rowId} columnId=${columnId} → (${target.row},${target.col})`);
  }

  return {
    runOrDefer,
    drain,
    hasPending: () => pendingCommands.length > 0,
    scrollToRow: (rowId) => runOrDefer(() => performScrollToRow(rowId)),
    // DD-036（Codex P2）: 行 0 件でも成立するよう列用の ready 条件で判定する（保留キューは行命令と共有）。
    scrollToColumn: (columnId) => runOrDefer(() => performScrollToColumn(columnId), canRunColumnCommandsNow),
    setActiveCell: (rowId, columnId) => runOrDefer(() => performSetActiveCell(rowId, columnId)),
    discard() {
      pendingCommands = [];
    },
  };
}
