// ハイパーリンク列のクリック（DD-027-2・候補追跡方式・📐）。DD-065 区画④の一部。
// pointerdown で武装（arm）→ ドラッグで開始セルを離れたら破棄 → pointerup で生存していれば link-open を発火する。
// 既存経路（activeCell 移動・ドラッグ選択・編集確定）は無変更のまま上乗せする（T1 非該当）。

import type { CellPosition } from '@nanairo-sheet/ime';
import type { ColumnId, RowId } from '@nanairo-sheet/types';

import { isAbsoluteHttpUrl } from '../column-types';
import type { ColumnTypeRegistry } from '../column-types';
import type { DiagnosticSink } from '../diagnostics';
import type { GridBackend } from '../grid-backend';
import type { GridEvent } from '../index';
import type { IntegrationEditor } from '../integration-editor';
import { shouldArmLinkCandidate } from '../link-column';
import { LINK_DBLCLICK_MS } from './constants';

/** 武装した候補（value は pointerdown 時点で捕捉。pointerup 時に行が消えていてもその値で発火してよい）。 */
export interface LinkCandidate {
  readonly pointerId: number;
  readonly rowId: RowId;
  readonly columnId: ColumnId;
  readonly value: string;
  readonly cell: CellPosition;
}

export interface LinkClickDeps {
  readonly diag: DiagnosticSink;
  emit(event: GridEvent): void;
  backend(): GridBackend | undefined;
  editor(): IntegrationEditor | undefined;
  registry(): ColumnTypeRegistry | undefined;
}

export interface LinkClick {
  /** 列 index がリンク列か（列単位・hover cursor と候補武装・リンクの描画で共有）。registry 未生成/列消失は false。 */
  isLinkColumnIndex(colIndex: number): boolean;
  /** pointerdown 時点で武装できるか判定して候補を組む（**pointerdownCell を呼ぶ前の位相**で呼ぶ）。 */
  computeArm(cell: CellPosition, event: PointerEvent): LinkCandidate | null;
  /** pointerdown の最後に候補を記録する（既存処理の後に上乗せする。編集中クリックは null）。 */
  setCandidate(candidate: LinkCandidate | null): void;
  /** ドラッグで pointer が候補のセルの外（別セル・ヘッダー・viewport 外＝null）へ動いたら破棄する。 */
  dropIfLeft(hitCell: CellPosition | null): void;
  /** pointercancel/capture 喪失で候補を破棄する（同一 pointer のときだけ）。 */
  discard(pointerId: number): void;
  /** pointerup（選択ドラッグの確定の直後）で候補が生きていれば link-open を発火する。 */
  fire(pointerId: number): void;
}

export function createLinkClick(deps: LinkClickDeps): LinkClick {
  const { diag } = deps;
  let linkCandidate: LinkCandidate | null = null;
  // dblclick 2打目の抑止（📐「detail===1」の実ブラウザー/synthetic 両対応）。直近 link-open 発火の論理セル（rowId/columnId）と
  // 時刻を記録し、同一セルで既定間隔内の連打は「2打目」と見なして武装しない。実ブラウザーは detail>=2 が主判定で、
  // 本 time-guard は detail 非供給（synthetic）環境の補完に**限定**する（Fable P2: detail>=1 の正当な2回目クリックを握り潰さない）。
  // キーは行 index でなく rowId/columnId（Fable P2: 発火直後のリモート行挿入/削除で index がずれても別セルを誤抑止しない）。
  let lastLinkFire: { rowId: RowId; columnId: ColumnId; time: number } | null = null;

  /**
   * 単クリック/連打の1打目か（dblclick の2打目以降を除外・📐 の detail===1 相当）。実ブラウザーは
   * `PointerEvent.detail`（1打目=1・2打目=2+）が権威判定＝そのまま通す。`detail===0`（synthetic・Playwright は
   * detail 非供給）のときだけ直近 link-open 発火セル（rowId/columnId）＋既定間隔（LINK_DBLCLICK_MS）で dblclick 2打目を
   * 補完判定する（Fable P2: detail>=1 の正当な2回目クリックを time-guard で握り潰さない）。
   */
  function isPrimaryClickPress(rowId: RowId, columnId: ColumnId, event: PointerEvent): boolean {
    if (event.detail >= 2) {
      return false; // 実ブラウザーの dblclick 2打目
    }
    if (
      event.detail === 0 &&
      lastLinkFire !== null &&
      lastLinkFire.rowId === rowId &&
      lastLinkFire.columnId === columnId &&
      performance.now() - lastLinkFire.time < LINK_DBLCLICK_MS
    ) {
      return false; // detail 非供給環境（synthetic）の連打2打目（同一論理セル・既定間隔内）
    }
    return true;
  }

  return {
    isLinkColumnIndex(colIndex) {
      const registry = deps.registry();
      const sync = deps.backend();
      if (registry === undefined || sync === undefined) {
        return false;
      }
      const colId = sync.view.columnIdAt(colIndex);
      return colId !== undefined && registry.isLinkColumn(String(colId));
    },
    computeArm(cell, event) {
      const registry = deps.registry();
      const sync = deps.backend();
      const editor = deps.editor();
      if (registry === undefined || sync === undefined || editor === undefined) {
        return null;
      }
      const rowId = sync.view.rowIdAt(cell.row);
      const columnId = sync.view.columnIdAt(cell.col);
      if (rowId === undefined || columnId === undefined) {
        return null;
      }
      const value = sync.view.cellDisplay(rowId, columnId);
      const armed = shouldArmLinkCandidate({
        button: event.button,
        pointerType: event.pointerType,
        isPrimaryClick: isPrimaryClickPress(rowId, columnId, event),
        isLinkColumn: registry.isLinkColumn(String(columnId)),
        valueNonEmpty: value !== '',
        phase: editor.session.getPhase(),
        composing: editor.session.isComposing(),
        shiftKey: event.shiftKey,
      });
      return armed ? { pointerId: event.pointerId, rowId, columnId, value, cell } : null;
    },
    setCandidate(candidate) {
      linkCandidate = candidate;
    },
    dropIfLeft(hitCell) {
      // DD-027-2[Fable P1]: selection の viewport 境界ガードより前で判定するため、ヘッダーへの離脱や高速フリックでの
      // 格子外離脱でも確実に破棄される。
      if (
        linkCandidate !== null &&
        (hitCell === null || hitCell.row !== linkCandidate.cell.row || hitCell.col !== linkCandidate.cell.col)
      ) {
        linkCandidate = null;
      }
    },
    discard(pointerId) {
      if (linkCandidate !== null && linkCandidate.pointerId === pointerId) {
        linkCandidate = null;
      }
    },
    /**
     * SDK は navigate しない（通知のみ）。列 `defaultOpen:true` のときだけ絶対 http/https URL を window.open で開く
     * （不正 URL は open せず診断 warn・link-open は常に発火）。
     */
    fire(pointerId) {
      if (linkCandidate === null || linkCandidate.pointerId !== pointerId) {
        return;
      }
      const candidate = linkCandidate;
      linkCandidate = null;
      lastLinkFire = { rowId: candidate.rowId, columnId: candidate.columnId, time: performance.now() }; // dblclick 2打目抑止の基準（📐・Fable P2）
      const rowId = String(candidate.rowId);
      const columnId = String(candidate.columnId);
      diag.emit('info', 'link-open', `link-open row=${rowId} col=${columnId}`);
      deps.emit({ type: 'link-open', rowId, columnId, value: candidate.value });
      const linkType = deps.registry()?.getLinkType(columnId);
      if (linkType?.defaultOpen === true) {
        if (isAbsoluteHttpUrl(candidate.value)) {
          window.open(candidate.value, '_blank', 'noopener,noreferrer');
        } else {
          diag.emit(
            'warn',
            'link-open-blocked',
            `defaultOpen: http/https の絶対 URL でないため open しない（link-open は発火済み）: 「${candidate.value}」`,
          );
        }
      }
    },
  };
}
