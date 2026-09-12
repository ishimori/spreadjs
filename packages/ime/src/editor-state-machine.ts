// 編集状態機械（DD-002 Phase 3・計画書 §11.2/§11.4/§11.5/§11.6/§11.7）。
//
// 【設計方針】
// - このモジュールは **DOM 型に一切依存しない**。入力は DOM から抽出した素の値
//   （`EditorEvent`）、出力は UI アダプタが適用する副作用（`Effect`）。これにより
//   node 環境の vitest で synthetic なイベント列（実採取トレースの再生を含む）を
//   駆動して状態遷移を機械検証できる（scenarios.md → editor-state-machine.test.ts）。
// - `activeCell` の所有権はこの状態機械に一本化する（DA #2）。UI アダプタ・main は
//   `getActiveCell()` を読むだけで、二重管理しない。
// - 値の正は `input` 後の値（I-1）。`keyCode === 229` を主判定にしない（I-2）。
//   composition 中は textarea を書き換えない（I-3）。IME 確定 Enter を通常 Enter
//   扱いしない（I-4）。フォーカスを別 input へ移さない（I-5）。
//
// 状態機械はロジック（geometry / navigation の純粋関数）だけに依存する。
import type { CellPosition, GridLayout } from './geometry';
import { cellKey } from './geometry';
import type { NavigationDirection } from './navigation';
import { keyToDirection, moveActiveCell } from './navigation';

/** §11.2 の 5 状態。EditingReplace/EditingExisting は初期値が空か既存値かだけが違う。 */
export type EditPhase =
  | 'Navigation'
  | 'EditingReplace'
  | 'EditingExisting'
  | 'Composing'
  | 'EditingAwaitFinalInput';

/**
 * 状態機械への入力イベント（DOM から抽出した素の値。scenarios.md §0）。
 * DOM の Event 型には依存しない（UI アダプタが変換して渡す）。
 */
export type EditorEvent =
  | {
      readonly type: 'keydown';
      readonly key: string;
      readonly code?: string;
      readonly isComposing: boolean;
      readonly shiftKey?: boolean;
      readonly altKey?: boolean;
    }
  | { readonly type: 'keyup'; readonly key: string; readonly isComposing: boolean }
  | { readonly type: 'compositionstart' }
  | { readonly type: 'compositionupdate'; readonly data: string }
  | { readonly type: 'compositionend'; readonly data: string }
  | { readonly type: 'beforeinput'; readonly inputType: string; readonly data: string | null }
  | {
      readonly type: 'input';
      readonly value: string;
      readonly isComposing: boolean;
      readonly inputType?: string;
      readonly selectionStart?: number | null;
      readonly selectionEnd?: number | null;
    }
  | {
      readonly type: 'pointerdown';
      readonly target: 'cell' | 'header' | 'outside';
      readonly cell?: CellPosition;
    }
  | { readonly type: 'f2' }
  | { readonly type: 'doubleClick'; readonly cell: CellPosition }
  // value === null はリモート削除（§11.7）。
  | { readonly type: 'remoteUpdate'; readonly cell: CellPosition; readonly value: string | null }
  | { readonly type: 'blur' }
  | { readonly type: 'focus' };

/**
 * 状態機械の出力エフェクト（UI アダプタが適用。scenarios.md §0）。
 * 空配列 `[]` が `None`（何もしない）を表す。
 */
export type Effect =
  // mode='replace' は既存値を捨てて空から編集（value は書き換えない）。
  // mode='existing' は initialValue を textarea へ載せる（F2 / ダブルクリック）。
  | { readonly type: 'BeginEdit'; readonly mode: 'replace' | 'existing'; readonly cell: CellPosition; readonly initialValue: string }
  | { readonly type: 'UpdateDraft'; readonly value: string }
  | { readonly type: 'Commit'; readonly cell: CellPosition; readonly value: string }
  | { readonly type: 'Move'; readonly direction: NavigationDirection }
  | { readonly type: 'MoveTo'; readonly cell: CellPosition }
  | { readonly type: 'Cancel' }
  | { readonly type: 'MarkConflict'; readonly cell: CellPosition }
  | { readonly type: 'SetPendingNavigation'; readonly cell: CellPosition }
  | { readonly type: 'ClearPendingNavigation' }
  // IME 確定 Enter 等を握りつぶす（UI アダプタは対象キーの preventDefault を行う）。
  | { readonly type: 'SuppressKey' }
  // RC1（DD-052-1）: wrap 列の Alt+Enter。caret 位置に改行を挿入し編集を続ける（確定しない）。
  // textarea の既定動作に頼らない（ブラウザーは Alt 押下中の Enter で改行を挿入しない＝Windows の
  // メニューアクセラレータ修飾キーと衝突するため。実ブラウザー E2E で確認）。UI アダプタが
  // caret 位置へ直接テキストを挿入し、続けて input として draft へ反映する。
  | { readonly type: 'InsertNewline' };

export interface EditorStateMachineOptions {
  readonly layout: GridLayout;
  /** 初期アクティブセル（省略時は左上）。 */
  readonly initialCell?: CellPosition;
  /** 既存値編集（F2 / ダブルクリック）で初期値を得るための参照（cell-store など）。 */
  readonly getCellValue: (cell: CellPosition) => string;
  /**
   * RC1（DD-052-1）: true を返すセルでは編集中の Alt+Enter がセル内改行になる（確定・移動しない＝textarea の
   * 既定動作に任せるため Effect を返さない）。false/未指定のセルでは Alt+Enter も通常の Enter と同じ確定＋移動。
   * 未指定なら常に false（既存 consumer の挙動を完全に保つ）。
   */
  readonly isWrapColumn?: (cell: CellPosition) => boolean;
}

export interface EditorStateMachine {
  /** 1 イベントを処理し、UI アダプタが適用すべきエフェクト列を返す。 */
  dispatch(event: EditorEvent): readonly Effect[];
  getPhase(): EditPhase;
  /** 現在のアクティブセル（コピーを返す。外部から変更させない・DA #2）。 */
  getActiveCell(): CellPosition;
  /** 現在の編集中ドラフト（未編集時は空）。 */
  getDraft(): string;
  /** IME 変換中か（内部 composing フラグ・I-2）。 */
  isComposing(): boolean;
  /** 変換中クリックで保持したナビ先（§11.6）。 */
  getPendingNavigation(): CellPosition | null;
  /** 競合インジケーターを出すセルのキー集合（§11.7・描画用）。 */
  getConflictCells(): ReadonlySet<string>;
}

/** セル位置の同値判定。 */
function sameCell(a: CellPosition, b: CellPosition): boolean {
  return a.row === b.row && a.col === b.col;
}

/** 編集セル（非 composing の editing）状態か。 */
function isEditingPhase(phase: EditPhase): boolean {
  return phase === 'EditingReplace' || phase === 'EditingExisting';
}

const EMPTY_CONFLICTS: ReadonlySet<string> = new Set<string>();

/**
 * 編集状態機械を生成する。
 */
export function createEditorStateMachine(options: EditorStateMachineOptions): EditorStateMachine {
  const { layout, getCellValue, isWrapColumn } = options;
  const wrapColumnAt = (cell: CellPosition): boolean => isWrapColumn?.(cell) ?? false;

  let phase: EditPhase = 'Navigation';
  let activeCell: CellPosition = options.initialCell ?? { row: 0, col: 0 };
  let draft = '';
  // 内部 composing フラグ（I-2: isComposing だけに頼らず内部状態も併用）。
  let composing = false;
  // §11.5 互換層: compositionend 直後の確定 Enter を keyup まで抑止（順序B・S-D5）。
  let suppressCommitUntilKeyup = false;
  // §11.6: 変換中に別セルをクリックしたときの移動先。
  let pendingNavigation: CellPosition | null = null;
  // 編集中セルへのリモート競合（§11.7）。1 編集につき対象は activeCell のみ。
  let conflictCell: CellPosition | null = null;
  // composition 復帰先（EditingReplace / EditingExisting）。
  let editBaseMode: 'replace' | 'existing' = 'replace';
  // composition 開始時点の draft（変換文字列を base+data で組み立てる。caret 末尾前提）。
  let compositionBase = '';
  // 今回の composition 中に実 textarea 値を運ぶ input（isComposing=true）を受けたか（DD-012-3）。
  // 受けていれば draft は実値（caret 位置を含む）を保持しており、compositionend の base+data 近似
  // （caret 末尾前提）で上書きしてはならない。F2 既存値編集で caret を先頭へ移して変換確定すると
  // 挿入文字が末尾へ送られるバグの真因（順序B では compositionend 後に確定 input が来ない）。
  let sawCompositionInput = false;
  // 変換中に Escape が押されたか。compositionend が「確定」か「取消」かの判別に使う
  // （§11.4: 変換中 Escape は IME 取消優先・S-D10/11/E4）。
  let escapePressedDuringComposition = false;
  // EditingAwaitFinalInput 中に blur が来たら、暫定値でなく最終 input の確定値で commit する
  // ため commit を保留するフラグ（Codex 指摘: compositionend→blur→input のイベント順で I-1 を守る）。
  let blurPendingCommit = false;

  const enterNavigation = (): void => {
    phase = 'Navigation';
    draft = '';
    composing = false;
    suppressCommitUntilKeyup = false;
    pendingNavigation = null;
    conflictCell = null;
    compositionBase = '';
    escapePressedDuringComposition = false;
    blurPendingCommit = false;
    sawCompositionInput = false;
  };

  const beginExisting = (cell: CellPosition): void => {
    activeCell = { row: cell.row, col: cell.col };
    phase = 'EditingExisting';
    editBaseMode = 'existing';
    draft = getCellValue(cell);
    composing = false;
    suppressCommitUntilKeyup = false;
    pendingNavigation = null;
    conflictCell = null;
    compositionBase = draft;
  };

  const commitAndMove = (direction: NavigationDirection): Effect[] => {
    const from = activeCell;
    const value = draft;
    activeCell = moveActiveCell(layout, activeCell, direction);
    enterNavigation();
    return [
      { type: 'Commit', cell: from, value },
      { type: 'Move', direction },
    ];
  };

  const commitAndMoveTo = (target: CellPosition): Effect[] => {
    const from = activeCell;
    const value = draft;
    activeCell = { row: target.row, col: target.col };
    enterNavigation();
    return [
      { type: 'Commit', cell: from, value },
      { type: 'MoveTo', cell: { row: target.row, col: target.col } },
    ];
  };

  const cancel = (): Effect[] => {
    enterNavigation();
    return [{ type: 'Cancel' }];
  };

  const beginExistingEffects = (cell: CellPosition): Effect[] => {
    beginExisting(cell);
    return [{ type: 'BeginEdit', mode: 'existing', cell: activeCell, initialValue: draft }];
  };

  // --- イベントハンドラ（scenarios.md の各シナリオに対応） ---

  const handleKeydown = (event: {
    key: string;
    isComposing: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  }): Effect[] => {
    const { key } = event;
    const shiftKey = event.shiftKey ?? false;
    const altKey = event.altKey ?? false;

    // I-2: 'Process'（keyCode 229 相当の IME 由来キー）を主判定にしない（S-D6）。
    if (key === 'Process') {
      return [];
    }

    // 変換中: 確定 Enter・Tab・矢印を抑止し、Escape は IME 取消を優先する（§11.4・S-D3/8/9/10）。
    // I-2: 内部 composing フラグと DOM の event.isComposing の**両方**を見る。ブラウザーの
    // イベント順差で内部フラグ未設定でも isComposing:true なら変換中として扱う（Codex 指摘）。
    if (composing || phase === 'Composing' || event.isComposing) {
      if (key === 'Escape') {
        // IME 側の取消を優先。preventDefault しない（compositionend{""} で composition だけ取消）。
        // 次の compositionend を「確定」でなく「取消」として扱うため印を付ける（S-D10/11/E4）。
        escapePressedDuringComposition = true;
        return [];
      }
      if (key === 'Enter' || key === 'Tab' || key.startsWith('Arrow')) {
        return [{ type: 'SuppressKey' }];
      }
      return [];
    }

    // 順序B（S-D5）: compositionend 後の確定 Enter を 1 回だけ抑止する。抑止したら即解除し
    // （self-clear）、後続の独立 Enter は commit させる。keyup/pointerdown/blur/focus でも解除する
    // （Codex 指摘: マウス確定やフォーカス変更で正規の Enter を飲まないよう抑止窓を最小化）。
    if (suppressCommitUntilKeyup && key === 'Enter') {
      suppressCommitUntilKeyup = false;
      return [{ type: 'SuppressKey' }];
    }
    // 確定 Enter 以外のキーが来た時点で抑止窓を閉じる（Enter を伴わない確定の後始末）。
    suppressCommitUntilKeyup = false;

    if (phase === 'Navigation') {
      const direction = keyToDirection({ key, shiftKey });
      if (direction !== null) {
        activeCell = moveActiveCell(layout, activeCell, direction);
        return [{ type: 'Move', direction }];
      }
      if (key === 'F2') {
        return beginExistingEffects(activeCell);
      }
      if (key === 'Delete') {
        // Navigation の Delete はクリアのみ・移動しない（S-A4）。
        return [{ type: 'Commit', cell: activeCell, value: '' }];
      }
      if (key === 'Backspace') {
        // Q-1: Backspace は選択セルをクリアして空の EditingReplace に入る（Escape で元値復帰）。
        phase = 'EditingReplace';
        editBaseMode = 'replace';
        draft = '';
        compositionBase = '';
        conflictCell = null;
        pendingNavigation = null;
        suppressCommitUntilKeyup = false;
        return [{ type: 'BeginEdit', mode: 'replace', cell: activeCell, initialValue: '' }];
      }
      // Escape / 印字可能キー等は編集を起こさない（印字は input で開始・§11.9）。
      return [];
    }

    // 編集セル（非 composing。EditingReplace / EditingExisting / EditingAwaitFinalInput）。
    if (isEditingPhase(phase) || phase === 'EditingAwaitFinalInput') {
      if (key === 'Enter' || key === 'Tab') {
        // 競合未解決なら commit を保留（サイレント上書きしない・S-F5・Q-2）。
        if (conflictCell !== null) {
          return [{ type: 'SuppressKey' }];
        }
        // RC1（DD-052-1）: wrap 列の Alt+Enter はセル内改行（確定・移動しない）。wrap 列でない場合は
        // Alt+Enter も通常の Enter と同じ確定＋移動のまま変えない。
        if (key === 'Enter' && altKey && wrapColumnAt(activeCell)) {
          return [{ type: 'InsertNewline' }];
        }
        const direction: NavigationDirection =
          key === 'Enter' ? (shiftKey ? 'up' : 'down') : shiftKey ? 'left' : 'right';
        return commitAndMove(direction);
      }
      if (key === 'Escape') {
        return cancel();
      }
      // 矢印はキャレット移動・F2 は無視・印字/Delete/Backspace は textarea に委ね input で反映。
      return [];
    }

    return [];
  };

  const handleKeyup = (): Effect[] => {
    // どのキーの keyup でも抑止フラグを解除する（S-D5・順序B）。確定 Enter の keyup で確実に
    // 解除しつつ、Enter を伴わない確定の後に正規 Enter を飲まないよう窓を最小化する（Codex 指摘）。
    suppressCommitUntilKeyup = false;
    return [];
  };

  const handleCompositionStart = (): Effect[] => {
    escapePressedDuringComposition = false;
    sawCompositionInput = false;
    if (phase === 'Navigation') {
      // Navigation → EditingReplace（空開始）→ Composing（§11.2・S-D1）。
      editBaseMode = 'replace';
      draft = '';
      compositionBase = '';
      conflictCell = null;
      pendingNavigation = null;
      suppressCommitUntilKeyup = false;
      composing = true;
      phase = 'Composing';
      return [{ type: 'BeginEdit', mode: 'replace', cell: activeCell, initialValue: '' }];
    }
    if (phase === 'EditingReplace' || phase === 'EditingExisting') {
      // 既存編集からの変換開始（既存文字列に追記）。BeginEdit は不要。
      editBaseMode = phase === 'EditingExisting' ? 'existing' : 'replace';
      compositionBase = draft;
      composing = true;
      phase = 'Composing';
      return [];
    }
    // 既に Composing / AwaitFinalInput の場合は composing を維持（防御的）。
    composing = true;
    return [];
  };

  const handleCompositionUpdate = (data: string): Effect[] => {
    // LocalDraftOnly（§11.2）。変換文字列は base+data で近似し、input.value が来れば上書きされる（I-1）。
    const value = compositionBase + data;
    draft = value;
    return [{ type: 'UpdateDraft', value }];
  };

  const handleCompositionEnd = (data: string): Effect[] => {
    composing = false;
    if (escapePressedDuringComposition) {
      // Escape による composition 取消（§11.4・S-D10/11/E4）。確定せず base へ戻し編集を続ける
      // （pendingNavigation は保持 = 次の Escape で編集取消＋ClearPendingNavigation）。
      escapePressedDuringComposition = false;
      suppressCommitUntilKeyup = false;
      sawCompositionInput = false;
      if (blurPendingCommit) {
        // 取消中に blur が来ていたら編集を畳んで Navigation へ（誤 commit しない）。
        enterNavigation();
        return [];
      }
      draft = compositionBase;
      phase = editBaseMode === 'existing' ? 'EditingExisting' : 'EditingReplace';
      return [];
    }
    phase = 'EditingAwaitFinalInput';
    // 順序B（S-D5）: 確定 Enter を keyup まで抑止する互換フラグを立てる。
    suppressCommitUntilKeyup = true;
    // 確定値は後続 input.value が正（I-1）。変換中 input を受けていれば draft は既に実 textarea 値
    // （caret 位置を含む）を保持しているため base+data 近似（caret 末尾前提）で上書きしない（DD-012-3・
    // S-C6: F2 既存値編集×caret 先頭挿入で挿入文字が末尾へ送られる）。input が一度も来ない環境
    // （synthetic 等）だけ従来どおり暫定確定する（S-C7）。
    if (!sawCompositionInput) {
      draft = compositionBase + data;
    }
    sawCompositionInput = false;
    return [];
  };

  const handleInput = (value: string, isComposing: boolean): Effect[] => {
    if (isComposing) {
      // 変換中の input（insertCompositionText）。value を正としてドラフトへ（I-1）。
      // 実値を受けた印を立て、compositionend の base+data 近似上書きを抑止する（DD-012-3）。
      sawCompositionInput = true;
      draft = value;
      return [{ type: 'UpdateDraft', value }];
    }

    if (phase === 'Navigation') {
      // compositionstart を伴わない直接入力（ASCII 等）で置換編集を開始（§11.9・S-B1/B7）。
      phase = 'EditingReplace';
      editBaseMode = 'replace';
      draft = value;
      compositionBase = '';
      conflictCell = null;
      pendingNavigation = null;
      suppressCommitUntilKeyup = false;
      return [
        { type: 'BeginEdit', mode: 'replace', cell: activeCell, initialValue: '' },
        { type: 'UpdateDraft', value },
      ];
    }

    if (phase === 'Composing' || phase === 'EditingAwaitFinalInput') {
      // compositionend 後の確定 input（I-1: 確定値を採用）。
      composing = false;
      draft = value;
      const basePhase: EditPhase = editBaseMode === 'existing' ? 'EditingExisting' : 'EditingReplace';

      if (pendingNavigation !== null) {
        // §11.6: 最終 input 後に commit を試み、競合なければクリック先へ移動。
        if (conflictCell === null) {
          const from = activeCell;
          const target = pendingNavigation;
          activeCell = { row: target.row, col: target.col };
          enterNavigation();
          return [
            { type: 'UpdateDraft', value },
            { type: 'Commit', cell: from, value },
            { type: 'MoveTo', cell: { row: target.row, col: target.col } },
            { type: 'ClearPendingNavigation' },
          ];
        }
        // 競合あり: pendingNavigation を破棄し現在セルに留まる（Q-3・S-E3）。draft と競合を保持。
        pendingNavigation = null;
        phase = basePhase;
        return [
          { type: 'UpdateDraft', value },
          { type: 'ClearPendingNavigation' },
        ];
      }

      if (blurPendingCommit && conflictCell === null) {
        // AwaitFinalInput 中に来ていた blur を、最終 input の確定値で commit する（I-1・Codex 指摘）。
        const from = activeCell;
        enterNavigation();
        return [
          { type: 'UpdateDraft', value },
          { type: 'Commit', cell: from, value },
        ];
      }

      phase = basePhase;
      return [{ type: 'UpdateDraft', value }];
    }

    // 既に編集中（EditingReplace / EditingExisting）: 継続入力（S-B2）。
    draft = value;
    return [{ type: 'UpdateDraft', value }];
  };

  const handlePointerdown = (target: 'cell' | 'header' | 'outside', cell?: CellPosition): Effect[] => {
    // マウス操作は確定 Enter 抑止窓を閉じる（Enter を伴わない確定の後始末・Codex 指摘）。
    suppressCommitUntilKeyup = false;
    if (target !== 'cell' || cell === undefined) {
      // ヘッダー / 範囲外は選択を変えない（S-A6）。
      return [];
    }

    if (composing || phase === 'Composing' || phase === 'EditingAwaitFinalInput') {
      // §11.6: 変換中クリックは pendingNavigation として保持（composition を壊さない・S-E1）。
      pendingNavigation = { row: cell.row, col: cell.col };
      return [{ type: 'SetPendingNavigation', cell: { row: cell.row, col: cell.col } }];
    }

    if (isEditingPhase(phase)) {
      if (conflictCell !== null) {
        // 競合未解決のまま別セルクリックは commit を保留（サイレント上書きしない）。
        return [];
      }
      return commitAndMoveTo(cell);
    }

    // Navigation: クリック先を選択（S-A5）。
    activeCell = { row: cell.row, col: cell.col };
    return [{ type: 'MoveTo', cell: { row: cell.row, col: cell.col } }];
  };

  const handleF2 = (): Effect[] => {
    if (composing || phase === 'Composing' || isEditingPhase(phase) || phase === 'EditingAwaitFinalInput') {
      // 既に編集中なら何もしない。
      return [];
    }
    return beginExistingEffects(activeCell);
  };

  const handleDoubleClick = (cell: CellPosition): Effect[] => {
    if (composing || phase === 'Composing') {
      // 変換中のダブルクリックは無視（composition を壊さない）。
      return [];
    }
    if (conflictCell !== null) {
      // 競合未解決中はダブルクリックでも draft を破棄しない（サイレント上書き/破棄防止・S-F5）。
      // Codex 指摘: ここで beginExisting すると競合フラグと draft が黙って消える。
      return [];
    }
    const effects: Effect[] = [];
    if (isEditingPhase(phase)) {
      // 別セル編集中なら現在ドラフトを確定してから既存値編集へ。
      effects.push({ type: 'Commit', cell: activeCell, value: draft });
    }
    effects.push(...beginExistingEffects(cell));
    return effects;
  };

  const handleRemoteUpdate = (cell: CellPosition): Effect[] => {
    const editing =
      composing || phase === 'Composing' || phase === 'EditingAwaitFinalInput' || isEditingPhase(phase);
    if (editing && sameCell(cell, activeCell)) {
      // MarkConflictOnly（§11.7）: textarea/draft は書き換えず、競合マークだけ立てる（S-F2/F3）。
      conflictCell = { row: activeCell.row, col: activeCell.col };
      return [{ type: 'MarkConflict', cell: { row: activeCell.row, col: activeCell.col } }];
    }
    // 他セル or Navigation はストア更新（外部）に委ね、machine は何もしない（S-F1/F4）。
    return [];
  };

  const handleBlur = (): Effect[] => {
    // フォーカス変更は確定 Enter 抑止窓を閉じる（Codex 指摘）。
    suppressCommitUntilKeyup = false;
    if (composing || phase === 'Composing') {
      // §11.6・S-H2: composition 中の強制確定を machine から誘発しない。
      return [];
    }
    if (phase === 'EditingAwaitFinalInput') {
      // compositionend→blur→input のイベント順では、暫定値でなく最終 input の確定値で commit する
      // ため保留する（I-1・Codex 指摘）。最終 input 到着時に handleInput が commit する。
      blurPendingCommit = true;
      return [];
    }
    if (isEditingPhase(phase)) {
      if (conflictCell !== null) {
        return [];
      }
      // Q-4: 非 composing 編集中の blur は commit（Excel 準拠・S-H1）。移動はしない。
      const from = activeCell;
      const value = draft;
      enterNavigation();
      return [{ type: 'Commit', cell: from, value }];
    }
    return [];
  };

  return {
    dispatch(event) {
      switch (event.type) {
        case 'keydown':
          return handleKeydown(event);
        case 'keyup':
          return handleKeyup();
        case 'compositionstart':
          return handleCompositionStart();
        case 'compositionupdate':
          return handleCompositionUpdate(event.data);
        case 'compositionend':
          return handleCompositionEnd(event.data);
        case 'beforeinput':
          // 値の正は input（I-1）。beforeinput では状態を変えない。
          return [];
        case 'input':
          return handleInput(event.value, event.isComposing);
        case 'pointerdown':
          return handlePointerdown(event.target, event.cell);
        case 'f2':
          return handleF2();
        case 'doubleClick':
          return handleDoubleClick(event.cell);
        case 'remoteUpdate':
          return handleRemoteUpdate(event.cell);
        case 'blur':
          return handleBlur();
        case 'focus':
          // 常駐 textarea の再フォーカスは状態不変（I-5・S-H3）。フォーカス変更で抑止窓を閉じる。
          suppressCommitUntilKeyup = false;
          return [];
      }
    },
    getPhase: () => phase,
    getActiveCell: () => ({ row: activeCell.row, col: activeCell.col }),
    getDraft: () => draft,
    isComposing: () => composing,
    getPendingNavigation: () =>
      pendingNavigation === null ? null : { row: pendingNavigation.row, col: pendingNavigation.col },
    getConflictCells: () =>
      conflictCell === null ? EMPTY_CONFLICTS : new Set<string>([cellKey(conflictCell)]),
  };
}
