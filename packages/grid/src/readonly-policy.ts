// readonly-policy（DD-033-1）: 表示専用モード（readOnly）の keydown 前段裁定（純粋関数・DOM 非依存）。
//
// readOnly では「文書を変更する編集入口」を UX 層で開かせない。keydown で編集を開始/セルをクリアするキー
// （F2＝既存値編集開始・Delete＝クリア・Backspace＝クリア開始）だけを消費（suppress）し、閲覧系のキー
// （矢印・Shift+矢印＝範囲選択・Ctrl+C＝コピー・Escape・PageUp/Down・Enter/Tab＝移動）は素通し（pass）する。
// 印字文字は keydown では編集を起こさない（BeginEdit は input 経路・§11.9）ため pass し、integration-editor 側の
// readOnly 分岐（textarea readOnly 属性＋input/composition dispatch 抑止）が編集開始を物理/論理に遮断する（2層抑止）。
//
// composition 中（DOM/内部いずれか）と非 Navigation 位相では必ず pass する（IME・編集中のキー処理は状態機械へ
// 委ねる＝editor-state-machine 無改変・I-3）。readOnly ではこれらの位相へ到達しないのが設計だが、防御的に不消費とする。

import type { SetCellsChange } from '@nanairo-sheet/core';
import type { EditPhase } from '@nanairo-sheet/ime';

/** readOnly keydown 裁定へ渡す素の値（DOM 非依存・integration-editor の KeydownInterceptInput と同項目）。 */
export interface ReadonlyPolicyInput {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  /** DOM の KeyboardEvent.isComposing。 */
  readonly eventComposing: boolean;
  /** 状態機械の内部 composing フラグ（I-2: DOM と内部の両方を見る）。 */
  readonly sessionComposing: boolean;
  readonly phase: EditPhase;
}

/** readOnly で編集開始/セルクリアを起こすキー（Navigation 位相で修飾の有無によらず抑止する）。 */
const EDIT_ENTRY_KEYS: ReadonlySet<string> = new Set(['F2', 'Delete', 'Backspace']);

/**
 * readOnly 時の keydown 前段裁定。true=抑止（消費し状態機械の編集開始/クリアを起こさない）。false=素通し。
 * composition 中・非 Navigation は常に false（閲覧系・IME 経路は変えない）。
 * F2/Delete/Backspace は**修飾キーの有無によらず抑止**する: 状態機械の Navigation 判定は修飾を見ないため、
 * Ctrl+Backspace（単語削除）等が素の編集開始として届き編集 UI が開いてしまう（統合レビュー P2-1）。
 * これらのキーは修飾付きでも閲覧系操作にならない（Ctrl+C 等の閲覧系はキー自体が別＝影響なし）。
 */
export function shouldSuppressReadonlyKey(input: ReadonlyPolicyInput): boolean {
  if (input.eventComposing || input.sessionComposing || input.phase !== 'Navigation') {
    return false;
  }
  return EDIT_ENTRY_KEYS.has(input.key);
}

// ---- DD-035 R4: 列単位 readOnly（readOnlyColumns）の SetCells フィルタ（純関数・DOM 非依存） ----

/** readOnly 列フィルタの結果。`kept` が空なら呼び出し側は no-op（submit しない）。 */
export interface ReadOnlyColumnPartition {
  /** readOnly 列以外への変更（順序維持）。 */
  readonly kept: readonly SetCellsChange[];
  /** スキップした readOnly 列への変更件数。 */
  readonly skipped: number;
}

/**
 * SetCells の changes から readOnly 列（`isReadOnlyColumn(columnId)===true`）への変更を除く（DD-035 R4・論点4）。
 * 範囲貼り付け・範囲クリア・cut のクリアが共有する: 「readOnly 列のセルだけスキップし他列へ適用・TSV の列位置は
 * ずらさない・全セルがスキップなら no-op」。上限/はみ出し検査は矩形全体で**先に**行われている前提（本関数は事後フィルタ）。
 * columnId は内部 ColumnId（branded string）だが判定は文字列化して行う（registry は文字列キー）。
 */
export function partitionReadOnlyColumnChanges(
  changes: readonly SetCellsChange[],
  isReadOnlyColumn: (columnId: string) => boolean,
): ReadOnlyColumnPartition {
  const kept: SetCellsChange[] = [];
  let skipped = 0;
  for (const change of changes) {
    if (isReadOnlyColumn(String(change.columnId))) {
      skipped += 1;
    } else {
      kept.push(change);
    }
  }
  return { kept, skipped };
}

/** SetCells が readOnly 列への変更を 1 件でも含むか（chokepoint の保証層＝含めば op 全体を破棄する）。 */
export function touchesReadOnlyColumn(
  changes: readonly SetCellsChange[],
  isReadOnlyColumn: (columnId: string) => boolean,
): boolean {
  return changes.some((change) => isReadOnlyColumn(String(change.columnId)));
}
