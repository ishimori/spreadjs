// 選択式入力列の候補欄（DD-027-1 ドロップダウン・DD-037 自由入力併存の候補リスト・DD-057 検索付き）。DD-065 区画②。
// 生成は mount 時、backend への結線は attach で行う。結線前の操作は何もしない（従来の「後から代入する関数」が未設定の状態と同じ）。

import type { SetCellsOperation } from '@nanairo-sheet/core';
import type { CellRect, ViewportTransform } from '@nanairo-sheet/render';
import type { ColumnId, OperationId, RowId } from '@nanairo-sheet/types';

import type { CompiledAppearance } from '../appearance';
import type { ColumnTypeRegistry } from '../column-types';
import { captureEditStartRevision, draftToScalar, isRowLive } from '../commit-bridge';
import type { DiagnosticSink } from '../diagnostics';
import { computeEditorPlacement } from '../editor-placement';
import type { PlacementConfig } from '../editor-placement';
import type { GridConflictCode } from '../error-codes';
import type { GridBackend } from '../grid-backend';
import type { IntegrationEditor } from '../integration-editor';
import type { VisibleArea } from '../popup-placement';
import { createSelectDropdown, filterOptionsByPrefix } from '../select-editor';
import type { SelectDropdown } from '../select-editor';
import type { CellLock } from './cell-lock';
import type { CellValidationSource } from './constants';
import type { MountMerges } from './merges';

export interface SelectWiringDeps {
  /** listbox・▼ インジケーターを置く要素（stage）。 */
  readonly host: HTMLElement;
  readonly diag: DiagnosticSink;
  readonly stringColumnStrings: ReadonlySet<string>;
  readonly cellLock: Pick<CellLock, 'isActiveCellReadOnly' | 'readOnlyEntryBlocked'>;
  readonly merges: Pick<MountMerges, 'isMergedCellId'>;
  editor(): IntegrationEditor | undefined;
  registry(): ColumnTypeRegistry | undefined;
  appearance(): CompiledAppearance;
  isReadOnly(): boolean;
  ensureActiveCellVisible(): void;
  currentTransform(): ViewportTransform | undefined;
  placementConfig(): PlacementConfig;
  visibleArea(): VisibleArea;
  submitSetCells(op: SetCellsOperation, source: CellValidationSource): OperationId | void;
  notifyRowReject(code: GridConflictCode, diagCode: string, detail: string): void;
}

export interface SelectWiring {
  /** backend へ結線する（選択式列があるときだけドロップダウンを作る＝無ければ overhead ゼロ）。 */
  attach(backend: GridBackend): void;
  /** ドロップダウンを配線したか（キー入力の裁定に候補欄の段が入るか）。 */
  isAttached(): boolean;
  isOpen(): boolean;
  contains(target: EventTarget | null): boolean;
  /** アクティブセルの候補欄を開く（明示操作。厳格モードの印字文字はその文字で絞り込んで開く）。 */
  open(initialCharacter?: string): void;
  /** 開いている候補欄を閉じる（文書は変えない）。 */
  close(): void;
  /** ハイライト中の候補で確定する（既存の chokepoint へ流す）。 */
  confirm(): void;
  typeCharacter(character: string): void;
  backspace(): void;
  highlightNext(): void;
  highlightPrev(): void;
  /** 毎フレーム: ▼ インジケーターと開いている listbox を scroll・構造 Op に追従させる（候補リストの自動表示もここ）。 */
  refreshPlacement(transform: ViewportTransform): void;
  /** 列 index が候補 UI を出す列か（allowFreeText の値によらない・DD-037 決定①）。 */
  isSelectColumnIndex(colIndex: number): boolean;
  /** 列 index が検索付きの候補欄の列か（DD-057）。 */
  isSearchableSelectColumnIndex(colIndex: number): boolean;
  /** 列 index で自由入力が許可されているか（DD-037・印字文字を textarea 編集へ流すかの判定）。 */
  allowsFreeText(colIndex: number): boolean;
  options(): readonly string[];
  highlightedIndex(): number;
  highlightedValue(): string | null;
  dispose(): void;
}

export function createSelectWiring(deps: SelectWiringDeps): SelectWiring {
  const { diag, cellLock, merges, stringColumnStrings } = deps;
  let backend: GridBackend | undefined;
  let selectDropdown: SelectDropdown | undefined;
  // ドロップダウンを開いた時点の対象セル（beforeRevision 凍結・確定で OCC 裁定に使う・📐）。
  let selectOpenTarget:
    | { readonly rowId: RowId; readonly columnId: ColumnId; readonly beforeRevision: number; readonly currentValue: string }
    | null = null;
  /**
   * 開いているドロップダウンの種類（DD-037 決定①③）。
   * - `'picker'`: Navigation で明示操作（F2 / Enter / Alt+↓ / ダブルクリック）から開いた従来のドロップダウン。
   *   ↑↓/Enter/Esc/Tab を奪う。候補のみの列では印字文字/Backspace で候補を選ぶ（DD-057）。
   * - `'suggest'`: 自由入力併存列（allowFreeText:true）の**編集中**に draft の前方一致で自動表示する候補リスト。
   *   **キーを一切奪わない**（decideSelectKey は非 Navigation 位相で必ず 'none'）＝印字・IME・キャレット移動・
   *   Enter/Tab の確定はすべて従来の editor 経路のまま流れる。表示だけの passive なオーバーレイ。
   */
  let selectOpenMode: 'picker' | 'suggest' | null = null;
  /**
   * suggest モードで最後に適用した絞り込みの識別子（`columnId\u0000draft`）。`refreshPlacement` は毎フレーム
   * 走るため、これが同じ間は listbox の DOM 再構築（`setOptions`→`replaceChildren`）を省く（60fps の無駄な
   * 再構築＝ちらつき・hover/スクロール状態のリセットを避ける）。閉じるたびに null へ戻す。
   */
  let suggestFilterKey: string | null = null;

  // 候補 UI の対象セル判定（アクティブセルの前段裁定・dblclick 分岐・▼ 表示で共有）。
  // DD-037 決定①: `allowFreeText` の値によらず選択式列なら候補 UI を出す（候補 UI の可否と commit 検証の
  // 厳格さを分離した）。キー裁定での差（印字文字を奪うか）は allowsFreeText 側で表現する。
  function isSelectCellIndex(colIndex: number): boolean {
    const registry = deps.registry();
    if (backend === undefined || registry === undefined) {
      return false;
    }
    const colId = backend.view.columnIdAt(colIndex);
    return colId !== undefined && registry.showsSuggestions(String(colId));
  }

  function allowsFreeTextIndex(colIndex: number): boolean {
    const registry = deps.registry();
    if (backend === undefined || registry === undefined) {
      return true;
    }
    const colId = backend.view.columnIdAt(colIndex);
    return colId === undefined || registry.allowsFreeText(String(colId));
  }

  function openSelect(initialCharacter?: string): void {
    if (backend === undefined) {
      return; // 結線前（従来の「後から代入する関数」が未設定のとき）は何もしない
    }
    if (deps.isReadOnly()) {
      // 選択式列のドロップダウンは開かない（要確認2・文書変更経路の入口）。
      diag.emit('info', 'readonly-blocked', 'readOnly: 選択式ドロップダウンを抑止');
      return;
    }
    if (cellLock.isActiveCellReadOnly()) {
      diag.emit(...cellLock.readOnlyEntryBlocked('選択式ドロップダウン'));
      return;
    }
    const editor = deps.editor();
    const registry = deps.registry();
    if (editor === undefined || selectDropdown === undefined || registry === undefined) {
      return;
    }
    // composition 中・非 Navigation は開かない（IME 経路無改変・I-3）。
    if (editor.session.isComposing() || editor.session.getPhase() !== 'Navigation') {
      return;
    }
    const active = editor.session.getActiveCell();
    const rowId = backend.view.rowIdAt(active.row);
    const columnId = backend.view.columnIdAt(active.col);
    if (rowId === undefined || columnId === undefined) {
      return;
    }
    const options = registry.getSelectOptions(String(columnId));
    if (options === undefined) {
      return;
    }
    const currentValue = backend.view.cellDisplay(rowId, columnId);
    const beforeRevision = captureEditStartRevision(backend.session.committedDocument, rowId, columnId);
    selectOpenTarget = { rowId, columnId, beforeRevision, currentValue };
    // 画面外セルで F2 等を押したとき、まず可視域へスクロールしてから配置する（1フレームのちらつき解消・Fable 5 P3-7）。
    deps.ensureActiveCellVisible();
    const transform = deps.currentTransform();
    const placement = transform === undefined ? null : computeEditorPlacement(transform, active.row, active.col, deps.placementConfig());
    selectOpenMode = 'picker';
    selectDropdown.open({
      searchable: registry.isSearchableSelect(String(columnId)),
      rect: placement !== null && placement.visible ? placement.rect : null,
      options,
      currentValue,
    });
    if (initialCharacter !== undefined) {
      selectDropdown.typeCharacter(initialCharacter);
    }
    selectOpenMode = 'picker';
    backend.view.markViewportDirty();
  }

  function cancelSelect(): void {
    if (backend === undefined || selectDropdown === undefined || !selectDropdown.isOpen()) {
      return;
    }
    selectDropdown.close();
    selectOpenTarget = null;
    selectOpenMode = null;
    suggestFilterKey = null;
    backend.view.markViewportDirty();
  }

  function confirmSelect(): void {
    if (backend === undefined || selectDropdown === undefined || !selectDropdown.isOpen() || selectOpenTarget === null) {
      return;
    }
    // DD-056 H12（Codex 実装レビュー P1）: 表示専用（変換の終わり待ちを含む）では候補の確定を、下の編集の取り消しより前に断る
    // （取り消してから送信の関所で断ると、編集中の値も候補も残らない）。候補欄は閉じ、編集中の値はそのまま残す。
    if (deps.isReadOnly()) {
      diag.emit('info', 'readonly-blocked', 'readOnly: 選択式の候補の確定を抑止（編集中の値はそのまま）');
      cancelSelect();
      return;
    }
    // DD-064（Codex P2）: 開いている間に対象セルが結合範囲になったら確定しない（結合範囲は読むだけ）。候補欄は閉じ、
    // 編集中の値はそのまま残す（readOnly と同じ扱い）。
    if (merges.isMergedCellId(selectOpenTarget.rowId, selectOpenTarget.columnId)) {
      diag.emit('info', 'merged-cell-blocked', 'mergedCells: 結合範囲になったセルへの候補の確定を抑止');
      cancelSelect();
      return;
    }
    const target = selectOpenTarget; // Escape 投入より前に確保する（以降の副作用で null 化されても安全）
    // DD-037: suggest モード（編集中の候補リスト）から候補をクリックで確定するときは、先に編集セッションを
    // 取り消す。そうしないと編集中の draft が後から commit されて候補の確定を上書きしてしまう。
    // 状態機械の公開入口（handleEvent）へ Escape を投げるだけ＝editor-state-machine・IME は無改変（I-3）。
    // 変換中は IME を最優先して何もしない（確定は変換確定後の操作で行う）。
    const editor = deps.editor();
    if (selectOpenMode === 'suggest' && editor !== undefined) {
      if (editor.session.isComposing()) {
        return;
      }
      if (editor.session.getPhase() !== 'Navigation') {
        editor.session.handleEvent({ type: 'keydown', key: 'Escape', isComposing: false, shiftKey: false });
      }
    }
    const value = selectDropdown.confirmValue(); // 内部で close 済み
    selectOpenTarget = null;
    selectOpenMode = null;
    backend.view.markViewportDirty();
    // 無変更判定は open 時スナップショットでなく**確定時点**の表示値と比較する（Fable 5 P2-4）: open 中に
    // リモート/ローカルで値が変わった後に「元の値」を選ぶとサイレント no-op になる事故を防ぐ。
    const currentNow = backend.view.cellDisplay(target.rowId, target.columnId);
    if (value === null || value === currentNow) {
      return; // 候補なし or 確定時点で既に同値 → 文書を触らない
    }
    // 確定前に対象行の生存を確認する（表示中にリモート/ローカルで削除された場合の実行前拒否・📐）。
    if (!isRowLive(backend.session.committedDocument, target.rowId)) {
      deps.notifyRowReject('row-unavailable', 'select-row-deleted', `選択確定対象の行が削除済み: row=${String(target.rowId)}`);
      return;
    }
    const op: SetCellsOperation = {
      type: 'setCells',
      conflictPolicy: 'reject-overlap',
      changes: [
        {
          rowId: target.rowId,
          columnId: target.columnId,
          beforeRevision: target.beforeRevision, // 開いた時点で凍結（OCC は既存 reject 経路が裁く）
          // RC12（DD-052-2・Codex P2）: stringColumns 指定列は選択式でも型変換をスキップする
          // （textarea 経由の確定と同じ契約＝編集 UI に依存せず「空文字以外は常に string」）。
          value: draftToScalar(value, stringColumnStrings.has(String(target.columnId))),
        },
      ],
    };
    deps.submitSetCells(op, 'select'); // 既存 chokepoint（Undo 記録・cell-commit 通知・自動行高が既存経路で成立）・DD-063 の検証
    backend.view.markCellDirty();
  }

  /**
   * DD-037 決定③: 自由入力併存列（allowFreeText:true）の**編集中**に、draft の前方一致で候補リストを自動表示する
   * （suggest モード）。候補 0 件になったら閉じる＝自由入力の邪魔をしない。
   *
   * **キーを一切奪わない**のが本モードの契約: `decideSelectKey` は非 Navigation 位相で必ず 'none' を返すため、
   * 印字・IME 変換・キャレット移動・Enter/Tab の確定はすべて従来の editor 経路のまま流れる。ゆえに変換中
   * （composition）に出したままでも状態不整合が起きない（picker と違い入力の所有権を持たないため）。
   * ハイライトは付けずに開く＝Enter は候補でなく入力文字列を確定する（決定④）。候補の選択はクリック
   * （listbox の pointerdown → confirmSelect）で行う。
   */
  function syncSuggestList(): void {
    const editor = deps.editor();
    const registry = deps.registry();
    if (backend === undefined || selectDropdown === undefined || editor === undefined || registry === undefined) {
      return;
    }
    const active = editor.session.getActiveCell();
    const eligible =
      editor.session.getPhase() !== 'Navigation' && // 編集中だけ（Navigation の候補は picker が担当）
      !deps.isReadOnly() &&
      isSelectCellIndex(active.col) &&
      allowsFreeTextIndex(active.col) && // 厳格モードは picker が開くため suggest は出さない
      !cellLock.isActiveCellReadOnly();
    if (!eligible) {
      if (selectOpenMode === 'suggest') {
        cancelSelect(); // 編集終了・対象外セルへ移動 → 候補リストを畳む
      }
      return;
    }
    if (selectOpenMode === 'picker') {
      return; // 明示操作で開いた picker を優先（編集中に picker は開かないが防御）
    }
    const rowId = backend.view.rowIdAt(active.row);
    const columnId = backend.view.columnIdAt(active.col);
    if (rowId === undefined || columnId === undefined) {
      return;
    }
    const options = registry.getSelectOptions(String(columnId));
    if (options === undefined) {
      return;
    }
    const draft = editor.session.getDraft();
    const filterKey = `${String(columnId)}\u0000${draft}`;
    if (selectOpenMode === 'suggest' && filterKey === suggestFilterKey) {
      return; // draft も対象列も変わっていない → listbox の再構築は不要（毎フレーム呼ばれるため必須の間引き）
    }
    const filtered = filterOptionsByPrefix(options, draft);
    if (filtered.length === 0) {
      if (selectOpenMode === 'suggest') {
        cancelSelect(); // 候補 0 件 → 閉じる（決定③・suggestFilterKey も null へ戻る）
      }
      return;
    }
    if (selectOpenMode === 'suggest') {
      selectDropdown.setOptions(filtered); // 開いたまま絞り込み（ハイライトは解除される）
      suggestFilterKey = filterKey;
      return;
    }
    // 初回表示: 対象セルを凍結して開く（rect は本フレームの placement 更新で入る）。
    selectOpenTarget = {
      rowId,
      columnId,
      beforeRevision: captureEditStartRevision(backend.session.committedDocument, rowId, columnId),
      currentValue: backend.view.cellDisplay(rowId, columnId),
    };
    selectOpenMode = 'suggest';
    suggestFilterKey = filterKey;
    selectDropdown.open({ rect: null, options: filtered, currentValue: '', highlight: false });
    backend.view.markViewportDirty();
  }

  function refreshPlacement(transform: ViewportTransform): void {
    const editor = deps.editor();
    if (backend === undefined || selectDropdown === undefined || editor === undefined) {
      return;
    }
    // Fable 5 P2-2: open 中に IME composition が始まる/非 Navigation へ遷移したら閉じる（keydown consume では
    // compositionstart は止められない＝状態不整合→自傷 cell-conflict を防ぐ）。毎フレームの防御。
    // DD-037: 対象は picker（入力の所有権を持つドロップダウン）だけ。suggest は編集中/変換中に出ているのが
    // 正常な状態で、キーを奪わないため同じ不整合は起こらない。
    if (
      selectOpenMode === 'picker' &&
      selectDropdown.isOpen() &&
      (editor.session.isComposing() || editor.session.getPhase() !== 'Navigation')
    ) {
      cancelSelect();
    }
    syncSuggestList();
    // ▼ インジケーター: アクティブセルが選択式列 & Navigation & 非 composition のとき（発見性・in-scope 小）。
    const active = editor.session.getActiveCell();
    const showIndicator =
      isSelectCellIndex(active.col) &&
      !cellLock.isActiveCellReadOnly() && // DD-035 R4 / DD-036 C3: readOnly 列・行では開けないため affordance も出さない
      !editor.session.isComposing() &&
      editor.session.getPhase() === 'Navigation';
    let indicatorRect: CellRect | null = null;
    if (showIndicator) {
      const ip = computeEditorPlacement(transform, active.row, active.col, deps.placementConfig());
      indicatorRect = ip.visible ? ip.rect : null;
    }
    // open 中の listbox 位置: 開いた対象セルの現在 index を引き直す。対象行/列が消えたら閉じて診断、
    // 画面外へスクロールしたら閉じる（📐 エッジ・Fable 5 P2-2 の同経路）。
    let openRect: CellRect | null = null;
    if (selectDropdown.isOpen() && selectOpenTarget !== null) {
      const r = backend.view.rowIndexOf(selectOpenTarget.rowId);
      const c = backend.view.colIndexOf(selectOpenTarget.columnId);
      if (r < 0 || c < 0) {
        // 対象行/列が削除された → 閉じて診断（📐「閉じて診断」）。確定は起きない
        // （confirmSelect の isRowLive はサブフレーム race に対する残余防御）。
        diag.emit('warn', 'select-target-removed', `選択式ドロップダウンの対象セルが消失したため閉じる: row=${String(selectOpenTarget.rowId)} col=${String(selectOpenTarget.columnId)}`);
        cancelSelect();
      } else {
        const op = computeEditorPlacement(transform, r, c, deps.placementConfig());
        if (op.visible) {
          openRect = op.rect;
        } else {
          cancelSelect(); // 画面外スクロール → 閉じる（composition 不在ゆえ textarea の I-3 問題なし）
        }
      }
    }
    selectDropdown.refresh({ openRect, indicatorRect });
  }

  return {
    attach(next) {
      backend = next;
      // 選択式ドロップダウンは選択式列があるときだけ配線する（無ければ overhead ゼロ）。
      if (deps.registry()?.hasAnySelectColumn() === true) {
        selectDropdown = createSelectDropdown({
          host: deps.host,
          font: deps.appearance().cellFont,
          visibleArea: deps.visibleArea,
          onConfirm: () => {
            confirmSelect();
            deps.editor()?.focus();
          },
          onDismiss: (restoreFocus) => {
            cancelSelect();
            if (restoreFocus) deps.editor()?.focus();
          },
        });
      }
    },
    isAttached: () => selectDropdown !== undefined,
    isOpen: () => selectDropdown?.isOpen() === true,
    contains: (target) => selectDropdown?.contains(target) === true,
    open: openSelect,
    close: cancelSelect,
    confirm: confirmSelect,
    typeCharacter: (character) => selectDropdown?.typeCharacter(character),
    backspace: () => selectDropdown?.backspace(),
    highlightNext: () => selectDropdown?.highlightNext(),
    highlightPrev: () => selectDropdown?.highlightPrev(),
    refreshPlacement,
    isSelectColumnIndex: isSelectCellIndex,
    isSearchableSelectColumnIndex(index) {
      if (backend === undefined) {
        return false;
      }
      const id = backend.view.columnIdAt(index);
      return id !== undefined && deps.registry()?.isSearchableSelect(String(id)) === true;
    },
    allowsFreeText: allowsFreeTextIndex,
    options: () => selectDropdown?.options() ?? [],
    highlightedIndex: () => selectDropdown?.highlightedIndex() ?? -1,
    highlightedValue: () => selectDropdown?.highlightedValue() ?? null,
    dispose() {
      selectDropdown?.destroy();
    },
  };
}
