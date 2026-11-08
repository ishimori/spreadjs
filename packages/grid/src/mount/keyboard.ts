// キー入力の裁定（常駐 textarea の keydown の前段裁定）。DD-065 区画①。
//
// 判定は段ごとのハンドラにし、優先順位は KEY_HANDLER_ORDER の 1 か所に並べる（DD-065 論点3）。各ハンドラの結果は 3 種類:
//   'consume'  … 消費して止める（true を返し、状態機械へ流さない）
//   'pass'     … 処理したうえで流す（false を返し、状態機械へも流す。例: Escape の範囲解除）
//   'continue' … 該当しない（次のハンドラへ）
// どのハンドラも該当しなければ false（状態機械へ流す）。composition 中・非 Navigation では各段の判定の純関数が
// 必ず該当しない側を返す（IME 経路無改変・I-3）。

import type { CellPosition } from '@nanairo-sheet/ime';
import { EMPTY_MERGE_INDEX, moveAcrossMerges, stepAcrossMerges } from '@nanairo-sheet/selection';
import type { MergeMoveDirection } from '@nanairo-sheet/selection';

import { decideDateKey } from '../date-editor';
import type { DiagnosticSink } from '../diagnostics';
import type { GridBackend } from '../grid-backend';
import type { IntegrationEditor, KeydownInterceptInput } from '../integration-editor';
import { shouldSuppressReadonlyKey } from '../readonly-policy';
import { decideRowStructureKey } from '../row-operations';
import { decideSelectKey } from '../select-editor';
import { decideNavigationIntercept } from '../selection-controller';
import type { SelectionController } from '../selection-controller';
import { decideUndoRedoKey } from '../undo-stack';
import type { CellLock } from './cell-lock';
import type { DateWiring } from './date-wiring';
import type { MountMerges } from './merges';
import type { SelectWiring } from './select-wiring';

export type KeyOutcome = 'consume' | 'pass' | 'continue';

/** キー入力の裁定の優先順位（上ほど先に裁く）。ここを変えると挙動が変わる（順序は単体テストで固定している）。 */
export const KEY_HANDLER_ORDER = [
  'readOnly', // 1. 読み取り専用（グリッド全体）の編集キーの抑止
  'readOnlyCells', // 2. 読み取り専用の列・行・セルと結合範囲の編集キーの抑止（範囲があるときの Delete は 8 へ流す）
  'datePicker', // 3. 日付カレンダー
  'selectDropdown', // 4. 候補欄
  'undoRedo', // 5. Undo / Redo
  'rowStructure', // 6. 行の挿入・削除のショートカット
  'mergeMove', // 7. 結合セルを 1 つのセルとして動く移動
  'rangeOperations', // 8. 範囲の操作（Shift＋矢印の拡張・Escape の解除・範囲の Delete）
] as const;

export type KeyHandlerName = (typeof KEY_HANDLER_ORDER)[number];

export interface KeyboardDeps {
  readonly diag: DiagnosticSink;
  readonly rowOperationsEnabled: boolean;
  readonly selectionCtrl: Pick<SelectionController, 'getRange' | 'clear' | 'selectedRange' | 'extendByArrow'>;
  readonly cellLock: Pick<CellLock, 'hasReadOnlyCells' | 'isActiveCellReadOnly' | 'isReadOnlyRowIndex'>;
  readonly merges: Pick<MountMerges, 'any' | 'isMergedCellIndex' | 'current'>;
  readonly date: Pick<
    DateWiring,
    'isAttached' | 'openOnOf' | 'isOpen' | 'open' | 'moveDays' | 'moveMonths' | 'highlightedValue' | 'confirm' | 'close'
  >;
  readonly select: Pick<
    SelectWiring,
    | 'isAttached'
    | 'isOpen'
    | 'isSelectColumnIndex'
    | 'allowsFreeText'
    | 'open'
    | 'typeCharacter'
    | 'backspace'
    | 'highlightNext'
    | 'highlightPrev'
    | 'confirm'
    | 'close'
  >;
  editor(): IntegrationEditor | undefined;
  backend(): GridBackend | undefined;
  isReadOnly(): boolean;
  performUndo(): void;
  performRedo(): void;
  performInsertRows(afterRowId: string | null, count: number): void;
  performDeleteRows(rowIds: readonly string[]): void;
  performRangeClear(): void;
  ensureCellVisible(cell: CellPosition): void;
}

export interface Keyboard {
  /** editor の interceptKeydown（true＝消費して状態機械へ流さない）。 */
  intercept(input: KeydownInterceptInput): boolean;
  /** 裁定の中身（どの段が・どの結果で裁いたか。どの段も該当しなければ handler は null）。 */
  dispatch(input: KeydownInterceptInput): { readonly handler: KeyHandlerName | null; readonly outcome: KeyOutcome };
}

/** DD-064: キー → 結合を 1 セルとして動く方向（状態機械の keyToDirection と同じ対応。Shift＋矢印は範囲の拡張なので対象外）。 */
export function mergeMoveDirectionOf(key: string, shiftKey: boolean): MergeMoveDirection | null {
  switch (key) {
    case 'ArrowUp':
      return shiftKey ? null : 'up';
    case 'ArrowDown':
      return shiftKey ? null : 'down';
    case 'ArrowLeft':
      return shiftKey ? null : 'left';
    case 'ArrowRight':
      return shiftKey ? null : 'right';
    case 'Enter':
      return shiftKey ? 'up' : 'down';
    case 'Tab':
      return shiftKey ? 'left' : 'right';
    default:
      return null;
  }
}

interface KeyEnv {
  readonly input: KeydownInterceptInput;
  readonly editor: IntegrationEditor;
  readonly backend: GridBackend;
}

export function createKeyboard(deps: KeyboardDeps): Keyboard {
  const { diag, selectionCtrl, cellLock, merges, date, select } = deps;

  /** 読み取り専用の裁定（readonly-policy の純関数）へ渡す入力。 */
  function policyInput({ input, editor }: KeyEnv) {
    return {
      key: input.key,
      ctrlKey: input.ctrlKey,
      metaKey: input.metaKey,
      altKey: input.altKey,
      shiftKey: input.shiftKey,
      eventComposing: input.isComposing,
      sessionComposing: editor.session.isComposing(),
      phase: editor.session.getPhase(),
    };
  }

  const handlers: Record<KeyHandlerName, (env: KeyEnv) => KeyOutcome> = {
    // DD-033-1: readOnly の入口抑止（最優先）。編集開始/セルクリアを起こすキー（F2/Delete/Backspace）を消費する。
    // 閲覧系（矢印・Shift+矢印・Ctrl+C・Escape・PageUp/Down）と composition/非 Navigation は素通し（純関数裁定・AC7）。
    readOnly(env) {
      if (deps.isReadOnly() && shouldSuppressReadonlyKey(policyInput(env))) {
        diag.emit('info', 'readonly-blocked', `readOnly: 編集キー「${env.input.key}」を抑止（閲覧専用）`);
        return 'consume';
      }
      return 'continue';
    },

    // DD-035 R4: readOnly 列の入口抑止（グリッド readOnly と同じ裁定・アクティブセルの列条件付き）。印字文字は
    // keydown では編集を起こさない（BeginEdit は input 経路）ため pass し、integration-editor の列ロック
    // （readOnly 属性＋dispatch 抑止）が編集開始を遮断する。
    // Codex P2: 明示レンジがあるときの Delete は範囲クリア（readOnly 列だけスキップして他列へ適用）へ流す。
    // アンカーが readOnly 列でも可編集列を含むレンジのクリアは契約どおり成立させる。
    readOnlyCells(env) {
      const { input, editor } = env;
      const rangeDelete = input.key === 'Delete' && selectionCtrl.getRange() !== null;
      if (
        (cellLock.hasReadOnlyCells() || merges.any()) &&
        !rangeDelete &&
        cellLock.isActiveCellReadOnly() &&
        shouldSuppressReadonlyKey(policyInput(env))
      ) {
        const active = editor.session.getActiveCell();
        // DD-064: 結合範囲（読むだけ）は専用の診断 code で区別する。
        if (merges.isMergedCellIndex(active.row, active.col)) {
          diag.emit('info', 'merged-cell-blocked', `mergedCells: 結合範囲で編集キー「${input.key}」を抑止`);
          return 'consume';
        }
        diag.emit(
          'info',
          cellLock.isReadOnlyRowIndex(active.row) ? 'readonly-row-blocked' : 'readonly-column-blocked',
          `readOnlyColumns/readOnlyRows: 編集キー「${input.key}」を抑止`,
        );
        return 'consume';
      }
      return 'continue';
    },

    // DD-035 R2: 日付カレンダーの前段裁定。open 中は矢印/PageUp/Down/Enter/Esc/Tab を消費し他キーを握り潰す。
    // 閉じている日付セルでは Alt+↓（常時）・F2/Enter（openOn='dblclick'）で開く。印字文字は 'none'＝手入力併存。
    // composition 中・非 Navigation では decideDateKey が必ず 'none'（I-3）。readOnly/列 readOnly は open 側で抑止。
    datePicker({ input, editor }) {
      if (!date.isAttached()) {
        return 'continue';
      }
      const active = editor.session.getActiveCell();
      const openOn = date.openOnOf(active.col);
      const decision = decideDateKey({
        key: input.key,
        ctrlKey: input.ctrlKey,
        metaKey: input.metaKey,
        altKey: input.altKey,
        shiftKey: input.shiftKey,
        eventComposing: input.isComposing,
        sessionComposing: editor.session.isComposing(),
        phase: editor.session.getPhase(),
        isOpen: date.isOpen(),
        isDateCell: openOn !== undefined && !deps.isReadOnly() && !cellLock.isActiveCellReadOnly(),
        openOn: openOn ?? 'dblclick',
      });
      switch (decision) {
        case 'open':
          date.open();
          return 'consume';
        case 'move-left':
          date.moveDays(-1);
          return 'consume';
        case 'move-right':
          date.moveDays(1);
          return 'consume';
        case 'move-up':
          date.moveDays(-7);
          return 'consume';
        case 'move-down':
          date.moveDays(7);
          return 'consume';
        case 'prev-month':
          date.moveMonths(-1);
          return 'consume';
        case 'next-month':
          date.moveMonths(1);
          return 'consume';
        case 'confirm': {
          const value = date.highlightedValue();
          if (value === null) {
            date.close();
          } else {
            date.confirm(value);
          }
          return 'consume';
        }
        case 'cancel':
          date.close();
          return 'consume';
        case 'consume':
          return 'consume';
        case 'none':
          return 'continue';
      }
      return 'continue';
    },

    // DD-027-1/057: 選択式ドロップダウンの前段裁定。厳格モードは文字/Backspace で候補を選ぶ。
    // 閉じている選択式セルでは編集開始キー（F2/Enter/Alt+↓）でドロップダウンを開く。印字文字も開くのは
    // 厳格モード（allowFreeText:false）だけで、自由入力併存列では textarea 編集へ流す（DD-037 決定①）。
    // composition 中・非 Navigation では decideSelectKey が必ず 'none'＝IME 経路無改変（I-3）。
    selectDropdown({ input, editor, backend }) {
      if (!select.isAttached()) {
        return 'continue';
      }
      const active = editor.session.getActiveCell();
      const decision = decideSelectKey({
        key: input.key,
        ctrlKey: input.ctrlKey,
        metaKey: input.metaKey,
        altKey: input.altKey,
        shiftKey: input.shiftKey,
        eventComposing: input.isComposing,
        sessionComposing: editor.session.isComposing(),
        phase: editor.session.getPhase(),
        isOpen: select.isOpen(),
        // DD-035 R4: readOnly 列の選択式セルは「非選択式」として裁定する（Enter=下移動等の閲覧系キーを奪わない。
        // 編集開始キーは readonly 裁定/列ロックが遮断済み）。
        isSelectCell: select.isSelectColumnIndex(active.col) && !cellLock.isActiveCellReadOnly(),
        // DD-037 決定①: 自由入力併存列では印字文字を奪わない（textarea 編集を開始させる）。
        allowsFreeText: select.allowsFreeText(active.col),
      });
      switch (decision) {
        case 'open':
          select.open(input.key.length === 1 ? input.key : undefined);
          return 'consume';
        case 'type':
          select.typeCharacter(input.key);
          backend.view.markViewportDirty();
          return 'consume';
        case 'backspace':
          select.backspace();
          backend.view.markViewportDirty();
          return 'consume';
        case 'move-down':
          select.highlightNext();
          backend.view.markViewportDirty();
          return 'consume';
        case 'move-up':
          select.highlightPrev();
          backend.view.markViewportDirty();
          return 'consume';
        case 'confirm':
          select.confirm();
          return 'consume';
        case 'cancel':
          select.close();
          return 'consume';
        case 'consume':
          return 'consume';
        case 'none':
          return 'continue';
      }
      return 'continue';
    },

    // DD-020-3: Ctrl/Cmd+Z=Undo・Ctrl+Y/Ctrl+Shift+Z=Redo（Navigation 位相かつ非 composing のみ・親 (b)）。
    // Editing/Composing 中は decideUndoRedoKey が 'none' を返しブラウザ既定（textarea 内テキスト undo）へ委譲する（I-3）。
    undoRedo({ input, editor }) {
      const undoRedo = decideUndoRedoKey({
        key: input.key,
        ctrlKey: input.ctrlKey,
        metaKey: input.metaKey,
        shiftKey: input.shiftKey,
        altKey: input.altKey,
        eventComposing: input.isComposing,
        sessionComposing: editor.session.isComposing(),
        phase: editor.session.getPhase(),
      });
      if (undoRedo === 'undo') {
        deps.performUndo();
        return 'consume'; // Navigation の Ctrl+Z は消費（空でも textarea 既定 undo にしない）
      }
      if (undoRedo === 'redo') {
        deps.performRedo();
        return 'consume';
      }
      return 'continue';
    },

    // DD-021-1: Ctrl+Shift+'+'=アクティブ行の上へ挿入・Ctrl+'-'=選択行削除（Navigation 位相かつ非 composing のみ・親⑦）。
    // Editing/Composing 中は decideRowStructureKey が 'none' を返しブラウザ既定へ委譲する（IME 不変条件・I-3）。
    rowStructure({ input, editor, backend }) {
      const rowKey = decideRowStructureKey({
        key: input.key,
        ctrlKey: input.ctrlKey,
        metaKey: input.metaKey,
        shiftKey: input.shiftKey,
        altKey: input.altKey,
        eventComposing: input.isComposing,
        sessionComposing: editor.session.isComposing(),
        phase: editor.session.getPhase(),
        rowOperationsEnabled: deps.rowOperationsEnabled,
      });
      if (rowKey === 'insert') {
        // アクティブ行の**上**へ挿入 → afterRowId=直上行（先頭行なら null）。消費（ブラウザのズームを止める）。
        const active = editor.session.getActiveCell();
        const prevId = active.row <= 0 ? undefined : backend.view.rowIdAt(active.row - 1);
        deps.performInsertRows(prevId === undefined ? null : String(prevId), 1);
        return 'consume';
      }
      if (rowKey === 'delete') {
        // 選択範囲（無ければ activeCell）の行帯 [rowStart,rowEnd) を RowId 列へ解決して削除。消費。
        const range = selectionCtrl.selectedRange(editor.session.getActiveCell());
        const rowIds: string[] = [];
        for (let r = range.rowStart; r < range.rowEnd; r += 1) {
          const id = backend.view.rowIdAt(r);
          if (id !== undefined) {
            rowIds.push(String(id));
          }
        }
        deps.performDeleteRows(rowIds);
        return 'consume';
      }
      return 'continue';
    },

    // DD-064: 結合を 1 つのセルとして動く（Navigation の矢印・Tab・Enter。Shift＋矢印は範囲の拡張）。状態機械が動かす先
    // （1 セル先）と違うときだけ消費して、その先へ移す（結合の左上から下・右は範囲の外へ・結合の中へ入ったら左上）。
    // 同じなら状態機械へ流す（結合が無ければ常に同じ＝従来経路のまま）。変換中・編集中は対象外（I-3・編集中の確定と
    // 移動の先は onChange の正規化が左上へ寄せる）。
    mergeMove({ input, editor, backend }) {
      if (!(merges.any() && !input.isComposing && !editor.session.isComposing() && editor.session.getPhase() === 'Navigation')) {
        return 'continue';
      }
      const direction = mergeMoveDirectionOf(input.key, input.shiftKey);
      if (direction === null) {
        return 'continue';
      }
      const active = editor.session.getActiveCell();
      const bounds = { rowCount: backend.view.rowAxis.count(), colCount: backend.view.colAxis.count() };
      const target = moveAcrossMerges(merges.current(), active, direction, bounds);
      const plain = stepAcrossMerges(EMPTY_MERGE_INDEX, active, direction, bounds);
      if (target.row === plain.row && target.col === plain.col) {
        return 'continue';
      }
      // 動くときだけ明示レンジを解く（グリッドの端で結合の外へ出られないときは、端での通常の矢印と同じく何も変えない）。
      if (target.row !== active.row || target.col !== active.col) {
        selectionCtrl.clear();
        editor.pointerdownCell(target);
      }
      backend.view.markViewportDirty();
      return 'consume';
    },

    // keydown 前段裁定（DD-020-1 案X）: Navigation 位相の Shift+矢印をレンジ拡張として消費する。
    // composition 中・編集中は decideNavigationIntercept が必ず 'none' を返し従来経路のまま（CG-1 資産無変更）。
    rangeOperations({ input, editor, backend }) {
      const decision = decideNavigationIntercept({
        key: input.key,
        shiftKey: input.shiftKey,
        eventComposing: input.isComposing,
        sessionComposing: editor.session.isComposing(),
        phase: editor.session.getPhase(),
        hasRange: selectionCtrl.getRange() !== null,
      });
      switch (decision.action) {
        case 'none':
          return 'continue';
        case 'clear-range':
          // Escape: レンジ解除のみ。キー自体は状態機械へも流す（Navigation の Escape は no-op＝挙動保存）。
          selectionCtrl.clear();
          backend.view.markViewportDirty();
          return 'pass';
        case 'delete-range':
          // Delete（レンジあり）: 範囲クリア＝原子 SetCells（AC5/AC6）。消費して状態機械の単一セル
          // Delete（S-A4）にしない。レンジ無しの Delete は 'none' で従来経路のまま。
          deps.performRangeClear();
          return 'consume';
        case 'extend': {
          const focus = selectionCtrl.extendByArrow(editor.session.getActiveCell(), decision.direction, {
            rowCount: backend.view.rowAxis.count(),
            colCount: backend.view.colAxis.count(),
          });
          deps.ensureCellVisible(focus); // focus 端を可視域へ（Excel 準拠の scroll-follow）
          backend.view.markViewportDirty();
          return 'consume'; // 消費（状態機械の Move にしない）
        }
      }
      return 'continue';
    },
  };

  function dispatch(input: KeydownInterceptInput): { readonly handler: KeyHandlerName | null; readonly outcome: KeyOutcome } {
    const editor = deps.editor();
    const backend = deps.backend();
    if (editor === undefined || backend === undefined) {
      return { handler: null, outcome: 'pass' };
    }
    const env: KeyEnv = { input, editor, backend };
    for (const name of KEY_HANDLER_ORDER) {
      const outcome = handlers[name](env);
      if (outcome !== 'continue') {
        return { handler: name, outcome };
      }
    }
    return { handler: null, outcome: 'continue' };
  }

  return {
    intercept: (input) => dispatch(input).outcome === 'consume',
    dispatch,
  };
}
