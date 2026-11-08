// editor（常駐 textarea＋IME の編集状態機械）の結線。DD-065 区画①の一部（キー入力の裁定は keyboard.ts）。
// editor の状態の持ち主はこの部品だけで、ほかの部品は get() で読む。生成は backend の結線時（attach。候補欄・日付の後）。

import type { ClientSession, PresenceUpdate } from '@nanairo-sheet/collab';
import type { SetCellsOperation } from '@nanairo-sheet/core';
import type { CellPosition, GridLayout } from '@nanairo-sheet/ime';
import type { ViewportTransform } from '@nanairo-sheet/render';
import type { OperationId } from '@nanairo-sheet/types';

import type { CompiledAppearance } from '../appearance';
import type { ColumnTypeRegistry } from '../column-types';
import type { DiagnosticSink } from '../diagnostics';
import { cellScalarToDisplay } from '../document-view';
import type { PlacementConfig } from '../editor-placement';
import type { GridBackend } from '../grid-backend';
import type { GridEvent } from '../index';
import { createIntegrationEditor } from '../integration-editor';
import type { IntegrationEditor } from '../integration-editor';
import type { VisibleArea } from '../popup-placement';
import type { SelectionController } from '../selection-controller';
import type { CellLock } from './cell-lock';
import { COL_WIDTH, HEADER_WIDTH, ROW_HEIGHT } from './constants';
import type { CellValidationSource } from './constants';
import type { DateWiring } from './date-wiring';
import type { EditCommands } from './edit-commands';
import type { GridEvents } from './events';
import type { Keyboard } from './keyboard';
import type { MountMerges } from './merges';
import type { ReadOnlySwitch } from './readonly-switch';
import type { SelectWiring } from './select-wiring';

export interface EditorWiringDeps {
  /** 常駐 textarea・バッジを置く要素（stage）。 */
  readonly host: HTMLElement;
  readonly diag: DiagnosticSink;
  readonly isStandalone: boolean;
  readonly headerHeight: number;
  readonly wrapColumnStrings: ReadonlySet<string>;
  readonly stringColumnStrings: ReadonlySet<string>;
  readonly selectionCtrl: Pick<SelectionController, 'syncWithEditor'>;
  readonly keyboard: Pick<Keyboard, 'intercept'>;
  readonly editCommands: Pick<EditCommands, 'documentPort' | 'notifyPreExecutionReject' | 'performCopy' | 'performCut' | 'performPaste'>;
  readonly select: Pick<SelectWiring, 'contains' | 'close'>;
  readonly date: Pick<DateWiring, 'close'>;
  readonly events: Pick<GridEvents, 'noteSelfActiveCell' | 'schedulePresenceRefresh'>;
  readonly readonlySwitch: Pick<ReadOnlySwitch, 'isReadOnly' | 'isDeferred' | 'isDeferredLockIdle' | 'scheduleEditStateCheck' | 'runEditorCommit'>;
  readonly cellLock: Pick<CellLock, 'isActiveCellReadOnly' | 'syncCellLock'>;
  readonly merges: Pick<MountMerges, 'normalizeActiveCell' | 'current'>;
  emit(event: GridEvent): void;
  registry(): ColumnTypeRegistry | undefined;
  appearance(): CompiledAppearance;
  /** DD-049 H5: 共同編集モードの ClientSession（単独モードは undefined＝参加者一覧は常に空）。 */
  collabSession(): ClientSession | undefined;
  /** 命令 API が保留中か（初回描画前で保留中の間は入力を論理遮断する）。 */
  hasPendingCommands(): boolean;
  submitSetCells(op: SetCellsOperation, validationSource?: CellValidationSource): OperationId | void;
  ensureActiveCellVisible(): void;
  currentTransform(): ViewportTransform | undefined;
  placementConfig(): PlacementConfig;
  visibleArea(): VisibleArea;
  /** 明示レンジが無いときに描くアクティブセルの単一セル（shadow）を更新する。 */
  setActiveShadow(cell: CellPosition): void;
}

export interface EditorWiring {
  get(): IntegrationEditor | undefined;
  /** backend へ結線して editor を作る（候補欄・日付カレンダーの結線の後に呼ぶ＝DOM の順は従来どおり）。 */
  attach(backend: GridBackend): void;
  /** destroy: 常駐 textarea/badge・editor の listener を解放する。 */
  dispose(): void;
}

export function createEditorWiring(deps: EditorWiringDeps): EditorWiring {
  const { diag, selectionCtrl, editCommands, select, date, events, readonlySwitch, cellLock, merges } = deps;
  let editor: IntegrationEditor | undefined;

  /**
   * editor 経路（IME/textarea 確定）の commit を validator でラップする（DD-027-1 決定②・📐）。非候補（allowFreeText:false
   * 選択式列）は **未 submit**（文書無変更）＋ `value-not-allowed` 通知（共同編集のみ・standalone は診断のみ）＋
   * 診断（拒否値を含む＝サイレント失敗なし・AC4）。paste/範囲クリア/リモートは submitSetCells を直接呼ぶため
   * 本ラップを通らない＝保持される（AC6）。ドロップダウン確定は候補一致が保証されるため素通しする。
   */
  function editorSubmit(op: SetCellsOperation): OperationId | void {
    const registry = deps.registry();
    if (registry !== undefined) {
      for (const change of op.changes) {
        const columnId = String(change.columnId);
        const text = cellScalarToDisplay(change.value);
        if (!registry.validateEditorCommit(columnId, text).allowed) {
          // 既存の実行前拒否経路へ集約する（Fable 5 P3-8）: 診断＋公開 rejected（共同編集のみ・standalone は診断のみ）。
          editCommands.notifyPreExecutionReject(
            'value-not-allowed',
            'value-not-allowed',
            `選択式列 ${columnId} に非候補値「${text}」が入力されました（未 submit・文書無変更・DD-027-1）`,
          );
          return; // 未 submit（op を捨てる・ドラフト復元はしない＝📐）
        }
      }
    }
    // DD-056 H12: 変換の終わり待ちの間は「切り替えを頼まれた時点の編集」の確定だけを送信の関所で通す（1 回で消費する）。
    return readonlySwitch.runEditorCommit(() => deps.submitSetCells(op, 'edit'));
  }

  return {
    get: () => editor,
    attach(backend) {
      const editorLayout: GridLayout = {
        get rowCount() {
          return backend.view.rowAxis.count();
        },
        get columnCount() {
          return backend.view.colAxis.count();
        },
        rowHeaderWidth: HEADER_WIDTH,
        columnHeaderHeight: deps.headerHeight,
        cellWidth: COL_WIDTH,
        cellHeight: ROW_HEIGHT,
      };
      editor = createIntegrationEditor({
        fontForColumn: deps.appearance().fontFor,
        mergedRangeAt: (row, col) => merges.current().at(row, col),
        host: deps.host,
        document: editCommands.documentPort(),
        submit: editorSubmit,
        // DD-033-1: 表示専用モードは常駐 textarea へ readOnly 属性＋編集 DOM イベントの dispatch 抑止（分岐追加のみ）。
        readOnly: readonlySwitch.isReadOnly(),
        // DD-035 R4: アクティブセルが readOnly 列にある間、編集 DOM イベントの dispatch を論理遮断する（物理遮断＝readOnly 属性は
        // onChange の syncCellLock が同期）。DD-035 R6（Codex P1）: 命令 API が初回描画前で保留中の間も入力を遮断する
        // （保留の適用先が確定する前の打鍵を旧セルへ確定させない）。readOnlyColumns 未指定かつ保留なしなら常に false。
        // DD-056 H12（Codex 実装レビュー P1）: 変換の終わり待ちの間、切り替えを頼まれた時点の編集が終わったら新しい編集を始めさせない
        // （textarea の readOnly 属性は次の判定で付く。それまでの論理遮断）。
        isInputLocked: () => deps.hasPendingCommands() || cellLock.isActiveCellReadOnly() || readonlySwitch.isDeferredLockIdle(),
        // DD-056 H12（Codex 実装レビュー P2）: 変換の終わり待ちの間は textarea の既定の cut も止める（readOnly 属性をまだ付けられないため）。
        isNativeEditBlocked: () => readonlySwitch.isDeferred(),
        // RC1・RC2（DD-052-1）: 折り返し（wrap）列は Alt+Enter でセル内改行・textarea が内容に応じて伸びる。
        isWrapColumn: (columnId) => deps.wrapColumnStrings.has(columnId),
        // RC12（DD-052-2）: 文字列として保つ列は編集確定時の型変換をスキップする。
        isStringColumn: (columnId) => deps.stringColumnStrings.has(columnId),
        // DD-055（RC17）: wrap 列の編集欄を可視域（スクロールバーを除く）の下端で縮める。
        visibleArea: deps.visibleArea,
        // DD-027-1（Fable 5 P3-9）: grid 外クリック等で常駐 textarea が blur したら選択式ドロップダウンを閉じる。
        // 候補クリックは listbox の pointerdown preventDefault で focus を保持するため blur せず、確定を妨げない。
        // DD-035 R2: 日付カレンダーも同様に閉じる。
        onBlur: (target) => {
          if (!select.contains(target)) select.close();
          date.close();
        },
        layout: editorLayout,
        onPresenceChange: (update: PresenceUpdate) => {
          backend.session.sendPresence(update);
          // DD-049 H5: 自分のエントリは送った presence の activeCell を映す（単独モードは collabSession 無し＝一覧は常に空）。
          // 発火は editor の処理が終わった後（マイクロタスク）に遅らせる（理由は schedulePresenceRefresh を参照）。
          events.noteSelfActiveCell(update.activeCell);
          if (deps.collabSession() !== undefined) {
            events.schedulePresenceRefresh();
          }
        },
        // K4（DD-021-2・Fable P2）: 削除行への commit で draft を退避したことを利用側へ可視化する。
        // 公開語彙は既存 row-unavailable（=target-row-deleted の写像・error-codes.md）を使い、未 submit ゆえ
        // operationId は空文字（DD-020 実行前拒否と同規約）。standalone は診断のみ（DD-024 契約＝実行前拒否と同型）。
        onDivert: (draft) => {
          diag.emit('warn', 'draft-diverted', `commit 対象行が削除済みのため draft を退避: row=${draft.rowId} col=${draft.columnId}`);
          if (!deps.isStandalone) {
            deps.emit({
              type: 'rejected',
              pendingCount: backend.session.pendingCount,
              conflict: { operationId: '', reason: 'rejected', code: 'row-unavailable' },
            });
          }
        },
        onChange: () => {
          const current = editor;
          if (current === undefined) {
            return;
          }
          // DD-064: 移動の結果（編集中の Enter・Tab・矢印での確定と移動を含む）が結合範囲の中なら左上へ寄せる。寄せた先の
          // onChange（入れ子）が以下を済ませるので、ここでは何もしない。
          if (merges.normalizeActiveCell()) {
            return;
          }
          cellLock.syncCellLock(); // DD-035 R4 / DD-036 C3: activeCell の列・行に応じて textarea の readOnly 属性を同期（非 composing 時のみ）
          deps.ensureActiveCellVisible(); // アクティブセルを可視域へ（scrollTop/Left を同期更新しうる）
          // DD-020-1 AC4: activeCell 移動・編集開始で明示レンジを単一選択へ戻す（不変条件は controller が判定）。
          selectionCtrl.syncWithEditor(current.session.getActiveCell(), current.session.getPhase());
          deps.setActiveShadow(current.session.getActiveCell());
          const transform = deps.currentTransform(); // 上の scroll 反映後の transform で配置する
          if (transform !== undefined) {
            current.refreshPlacement(transform, deps.placementConfig());
          }
          backend.view.markViewportDirty();
          // DD-056 H12: 変換の終わり待ちの切り替え・flush の待ち合わせを、編集の変化を受けて macrotask で判定し直す（無ければ無コスト）。
          readonlySwitch.scheduleEditStateCheck();
        },
        // keydown の前段裁定（優先順位は mount/keyboard.ts の KEY_HANDLER_ORDER）。
        interceptKeydown: (input) => deps.keyboard.intercept(input),
        // DD-020-2 clipboard 裁定（Navigation 位相のみ）。composition/編集中は各 perform が null/false を返す。
        onClipboardCopy: () => editCommands.performCopy(),
        onClipboardCut: () => editCommands.performCut(),
        onClipboardPaste: (text) => editCommands.performPaste(text),
      });
    },
    dispose() {
      editor?.destroy();
    },
  };
}
