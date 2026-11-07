// selection-controller（DD-020-1・案X）: 矩形範囲選択の状態所有者（DOM 非依存）。
//
// 【activeCell 所有権との整合（DA #2 と共存）】activeCell の所有は editor-state-machine（packages/ime）のまま
// 変えない（遷移追加なし・CG-1 資産無変更）。本 controller は「anchor（拡張開始時の activeCell）〜 focus（拡張端）」
// の矩形レンジと、ドラッグ中のライブ矩形だけを所有する。editor-state-machine へは書き込まず、activeCell/phase は
// 呼び出し側（mount-controller）が読み取り値を引数で渡す。Shift+矢印・ドラッグ・範囲 Delete は状態機械の**前段**
// （integration-editor の keydown / mount-controller の pointerdown）で裁定し、消費したイベントは状態機械へ流さない。
// 裁定は decideNavigationIntercept（純粋関数）に集約し、composition 中は必ず不消費＝IME 経路を一切変えない（I-3）。
//
// 【不変条件】明示レンジは「anchor === activeCell（値一致）かつ phase === 'Navigation'」の間だけ存在する。
// activeCell が動く操作（通常矢印・Enter/Tab・クリック確定）や編集開始（printable/F2/ダブルクリック/composition）では
// syncWithEditor が解除する（AC4）。解除は controller 内部状態の変更のみで textarea には触れない。

import {
  EMPTY_MERGE_INDEX,
  expandRangeToMerges,
  isSingleMergeRange,
  rangeFromAnchorFocus,
  singleCell,
  stepAcrossMerges,
} from '@nanairo-sheet/selection';
import type { CellPos, CellRange, MergeIndex } from '@nanairo-sheet/selection';
import type { EditPhase, NavigationDirection } from '@nanairo-sheet/ime';

/**
 * 選択コントローラの設定（DD-064）。`merges` は直前に描いた結合範囲を返す（毎回呼ぶ）。指定があると、範囲は交わる結合を
 * 全部含むまで広がり、1 つの結合そのものの範囲は単一選択として扱い、Shift＋矢印は焦点の結合の端から外へ動く。
 * 未指定なら結合なし（DD-064 以前と完全に同じ動き）。
 */
export interface SelectionControllerOptions {
  readonly merges?: () => MergeIndex;
}

/** 拡張のクランプ境界（現在の表示 Axis の行数・列数）。 */
export interface SelectionBounds {
  readonly rowCount: number;
  readonly colCount: number;
}

export interface SelectionController {
  /** 確定済みの明示レンジ（null=単一セル選択のみ）。常に 2 セル以上（1×1 は null に正規化）。 */
  getRange(): CellRange | null;
  /** ドラッグ中のライブ矩形（null=非ドラッグ）。pointerup の endDrag で確定レンジへ昇格する。 */
  getDragRange(): CellRange | null;
  isDragging(): boolean;
  /** DD-020-2 引き継ぎ: 現在の選択（明示レンジ or activeCell の単一セル）。copy/cut/paste の対象範囲。 */
  selectedRange(active: CellPos): CellRange;
  /** ドラッグ開始（pointerdown 済みのセル＝anchor）。既存の明示レンジは呼び出し側が clear 済みであること。 */
  beginDrag(anchor: CellPos): void;
  /** ドラッグ中の focus 更新（pointermove の hitTest セル）。 */
  updateDrag(focus: CellPos): void;
  /** ドラッグ確定（pointerup）。anchor≠focus なら明示レンジへ昇格して返す。同一セルは null（単一選択）。 */
  endDrag(): CellRange | null;
  /** ドラッグ取消（pointercancel/capture 喪失）。確定レンジは変更しない。 */
  cancelDrag(): void;
  /** Shift+クリック: anchor（=activeCell）〜 focus の矩形へ置き換える（AC2）。同一セルは解除。 */
  extendTo(anchor: CellPos, focus: CellPos): void;
  /**
   * Shift+矢印: focus 端のみ 1 セル移動する（AC3・anchor は不変）。レンジが無ければ active を anchor に据える。
   * bounds でクランプする。戻り値=新しい focus（呼び出し側の scroll-follow 用）。
   */
  extendByArrow(active: CellPos, direction: NavigationDirection, bounds: SelectionBounds): CellPos;
  /** 明示レンジを解除する（ドラッグ中ならドラッグも破棄）。戻り値=状態が変わったか（再描画要否）。 */
  clear(): boolean;
  /**
   * 行構造変更後に明示レンジの行 index を再ベースする（K3・DD-021-3）。resolveRow は旧表示 index → 新表示 index
   * （削除で生存行が無ければ null）。両端いずれかが null なら単一選択へ縮退（clear）。列は不変（列は固定）。
   * 明示レンジが無ければ no-op。戻り値=状態が変わったか（再描画要否）。
   */
  rebaseRows(resolveRow: (row: number) => number | null): boolean;
  /**
   * 状態機械の観測値と同期する（editor onChange から毎回呼ぶ）。不変条件（anchor===activeCell かつ
   * Navigation）が破れていたら解除する（AC4: 通常移動・編集開始で単一選択へ戻る）。戻り値=解除したか。
   */
  syncWithEditor(active: CellPos, phase: EditPhase): boolean;
}

function sameCell(a: CellPos, b: CellPos): boolean {
  return a.row === b.row && a.col === b.col;
}

export function createSelectionController(options: SelectionControllerOptions = {}): SelectionController {
  const merges = options.merges ?? ((): MergeIndex => EMPTY_MERGE_INDEX);
  /** DD-064: 交わる結合を全部含むまで広げる（結合が無ければそのまま）。 */
  const expand = (range: CellRange): CellRange => expandRangeToMerges(merges(), range);
  // 明示レンジ（anchor/focus）。anchor は常に「レンジ開始時の activeCell」（不変条件は syncWithEditor が維持）。
  let anchor: CellPos | null = null;
  let focus: CellPos | null = null;
  // ドラッグ中のライブ状態（確定レンジとは独立。pointerup で昇格）。
  let dragAnchor: CellPos | null = null;
  let dragFocus: CellPos | null = null;

  /** anchor/focus を設定する。同一セルは「単一選択」へ正規化（明示レンジは常に 2 セル以上）。 */
  function setRange(a: CellPos, f: CellPos): void {
    if (sameCell(a, f)) {
      anchor = null;
      focus = null;
      return;
    }
    anchor = { row: a.row, col: a.col };
    focus = { row: f.row, col: f.col };
  }

  function currentRange(): CellRange | null {
    if (anchor === null || focus === null) {
      return null;
    }
    // DD-064: 結合を含むまで広げる。広げた結果が 1 つの結合そのものなら単一選択（明示レンジ無し）として扱う
    // （anchor/focus は保持＝続く Shift＋矢印はその焦点から動く）。
    const range = expand(rangeFromAnchorFocus(anchor, focus));
    return isSingleMergeRange(merges(), range) ? null : range;
  }

  /** 明示レンジ・ドラッグの全状態を破棄する。戻り値=状態が変わったか。 */
  function clearAll(): boolean {
    const changed = anchor !== null || dragAnchor !== null;
    anchor = null;
    focus = null;
    dragAnchor = null;
    dragFocus = null;
    return changed;
  }

  return {
    getRange: currentRange,
    getDragRange: () =>
      dragAnchor !== null && dragFocus !== null ? expand(rangeFromAnchorFocus(dragAnchor, dragFocus)) : null,
    isDragging: () => dragAnchor !== null,
    selectedRange(active) {
      // DD-064: 単一選択が結合の左上なら結合範囲全体（copy/cut/paste/行の削除の対象）。
      return currentRange() ?? expand(singleCell(active));
    },
    beginDrag(a) {
      dragAnchor = { row: a.row, col: a.col };
      dragFocus = { row: a.row, col: a.col };
    },
    updateDrag(f) {
      if (dragAnchor === null) {
        return;
      }
      dragFocus = { row: f.row, col: f.col };
    },
    endDrag() {
      if (dragAnchor === null || dragFocus === null) {
        return null;
      }
      const a = dragAnchor;
      const f = dragFocus;
      dragAnchor = null;
      dragFocus = null;
      setRange(a, f); // 同一セル（クリック）は単一選択のまま（AC1: 移動していれば確定）
      return currentRange();
    },
    cancelDrag() {
      dragAnchor = null;
      dragFocus = null;
    },
    extendTo(a, f) {
      setRange(a, f);
    },
    extendByArrow(active, direction, bounds) {
      // レンジ未形成なら activeCell を anchor に据え、focus を 1 セル動かすところから始める（Excel 準拠）。
      const base = anchor !== null && focus !== null ? focus : active;
      // DD-064: focus が結合の中なら、その結合の端から 1 つ外へ動く（押すたびに見える範囲が変わる）。結合が無ければ ±1 で
      // 境界クランプ（従来どおり）。
      const nextFocus = stepAcrossMerges(merges(), base, direction, bounds);
      setRange(anchor ?? active, nextFocus);
      return nextFocus;
    },
    clear: clearAll,
    rebaseRows(resolveRow) {
      let changed = false;
      // ドラッグ中のライブ状態も再ベースする（Fable レビュー P2: ドラッグ中にリモート構造 Op が flush されると
      // dragAnchor/dragFocus の index が旧 Axis のまま残り、pointerup でずれた行範囲が確定する。リサイズドラッグの
      // Id 保持修正〔Codex P2〕と同型）。いずれかの行が消えていればドラッグを取消す（確定レンジは別途下で補正）。
      if (dragAnchor !== null && dragFocus !== null) {
        const da = resolveRow(dragAnchor.row);
        const df = resolveRow(dragFocus.row);
        if (da === null || df === null) {
          dragAnchor = null;
          dragFocus = null;
          changed = true;
        } else if (da !== dragAnchor.row || df !== dragFocus.row) {
          dragAnchor = { row: da, col: dragAnchor.col };
          dragFocus = { row: df, col: dragFocus.col };
          changed = true;
        }
      }
      if (anchor === null || focus === null) {
        return changed; // 明示レンジ無し（単一セルは activeCell 再ベース側が担う）
      }
      const na = resolveRow(anchor.row);
      const nf = resolveRow(focus.row);
      if (na === null || nf === null) {
        return clearAll() || changed; // 生存行皆無 → 単一選択へ縮退
      }
      if (na === anchor.row && nf === focus.row) {
        return changed; // index 不変（Insert が下・Delete が下など）→ 触らない
      }
      setRange({ row: na, col: anchor.col }, { row: nf, col: focus.col }); // 同一セルは単一選択へ正規化
      return true;
    },
    syncWithEditor(active, phase) {
      if (anchor === null && dragAnchor === null) {
        return false;
      }
      if (phase === 'Navigation') {
        // 不変条件: anchor===activeCell。破れ＝activeCell が動いた（通常移動/クリック確定）→ 解除（AC4）。
        // anchor 未形成（ドラッグ中の pointerdown 直後）はドラッグ継続＝解除しない。
        if (anchor === null || sameCell(anchor, active)) {
          return false;
        }
        return clearAll();
      }
      // 編集開始（printable/F2/ダブルクリック/composition）→ 単一選択へ戻す（AC4）。textarea には触れない。
      return clearAll();
    },
  };
}

// ---- keydown 前段裁定（純粋関数・integration-editor の keydown から状態機械の前で評価する） ----

export interface NavigationInterceptInput {
  readonly key: string;
  readonly shiftKey: boolean;
  /** DOM の KeyboardEvent.isComposing。 */
  readonly eventComposing: boolean;
  /** 状態機械の内部 composing フラグ（I-2: DOM と内部の両方を見る）。 */
  readonly sessionComposing: boolean;
  readonly phase: EditPhase;
  /** 明示レンジが存在するか。 */
  readonly hasRange: boolean;
}

export type NavigationInterceptDecision =
  /** 前段消費しない（状態機械へそのまま流す）。 */
  | { readonly action: 'none' }
  /** Shift+矢印: レンジ拡張（消費＝状態機械の Move にしない）。 */
  | { readonly action: 'extend'; readonly direction: NavigationDirection }
  /** Escape: レンジ解除のみ（キー自体は状態機械へも流す＝既存の抑止窓処理を保存）。 */
  | { readonly action: 'clear-range' }
  /** Delete（レンジあり）: 範囲クリア＝原子 SetCells（消費＝状態機械の単一セル Delete=S-A4 にしない）。 */
  | { readonly action: 'delete-range' };

function arrowDirection(key: string): NavigationDirection | null {
  switch (key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    default:
      return null;
  }
}

/**
 * Navigation 位相の keydown 前段裁定（案X）。composition 中（DOM/内部いずれか）と非 Navigation 位相では
 * 必ず 'none'（IME・編集中のキー処理は従来どおり状態機械が裁く＝挙動保存・AC7）。
 */
export function decideNavigationIntercept(input: NavigationInterceptInput): NavigationInterceptDecision {
  if (input.eventComposing || input.sessionComposing || input.phase !== 'Navigation') {
    return { action: 'none' };
  }
  if (input.shiftKey) {
    const direction = arrowDirection(input.key);
    if (direction !== null) {
      return { action: 'extend', direction };
    }
  }
  if (input.key === 'Escape' && input.hasRange) {
    return { action: 'clear-range' };
  }
  // レンジがあるときの Delete は範囲クリア（AC5）。shift 有無は見ない（状態機械の S-A4 と整合）。
  // レンジが無ければ従来どおり状態機械の単一セル Delete（S-A4）へ流す。
  if (input.key === 'Delete' && input.hasRange) {
    return { action: 'delete-range' };
  }
  return { action: 'none' };
}
