// 行操作（Insert/Delete）公開層の純粋ロジック（DD-021-1）。DOM/backend 非依存で単体検証可能に保つ。
//
// ここに置くのは「キー裁定」「削除対象の解決」「行構造変更後の index 再ベース」の 3 純関数。
// mount-controller はこれらを使って公開 API（insertRows/deleteRows）・Excel 準拠ショートカットを配線する。
// IME 状態機械へは一切書き込まない（前段裁定＝decideUndoRedoKey と同型・Navigation 位相かつ非 composing のみ）。

import type { EditPhase } from '@nanairo-sheet/ime';

/** 行操作ショートカットの裁定結果。 */
export type RowStructureKeyDecision = 'insert' | 'delete' | 'none';

export interface RowStructureKeyInput {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** DOM の KeyboardEvent.isComposing。 */
  readonly eventComposing: boolean;
  /** 状態機械の内部 composing（I-2: DOM と内部の両方を見る）。 */
  readonly sessionComposing: boolean;
  readonly phase: EditPhase;
  /**
   * RC14（DD-052-3）: 行操作ショートカット自体が有効か（mount オプション `rowOperations`・既定 true）。
   * false なら常に 'none'（他の編集は従来どおり可能。公開 API `insertRows`/`deleteRows` は対象外＝consumer の
   * 明示呼び出しまでは止めない）。未指定時は true 扱い（既存呼び出し元の後方互換）。
   */
  readonly rowOperationsEnabled?: boolean;
}

/**
 * Excel 準拠の行操作ショートカット裁定（Ctrl+Shift+'+'=挿入 / Ctrl+'-'=削除・親⑦）。
 * **Navigation 位相かつ非 composing のみ**グリッド裁定し、Editing/Composing・composing 中は必ず 'none'
 * （ブラウザ既定へ委譲＝IME 不変条件維持・I-3）。alt 併用・修飾なしも 'none'。
 * '+' は主要レイアウトで Shift+'=' により生成される（numpad は Shift 不要）ため shift 有無は問わない。
 */
export function decideRowStructureKey(input: RowStructureKeyInput): RowStructureKeyDecision {
  if (
    input.rowOperationsEnabled === false ||
    input.eventComposing ||
    input.sessionComposing ||
    input.phase !== 'Navigation' ||
    input.altKey
  ) {
    return 'none';
  }
  if (!(input.ctrlKey || input.metaKey)) {
    return 'none';
  }
  if (input.key === '+') {
    return 'insert';
  }
  if (input.key === '-') {
    return 'delete';
  }
  return 'none';
}

/**
 * 削除対象の解決（重複除去・生存行のみ）。requested のうち displayRowIds に現存する ID を requested 順で返す。
 * 全て非現存/空なら [] を返す（呼び出し側が実行前拒否＝row-delete-empty にする）。DeleteRows 自体は冪等 no-op だが、
 * 「削除対象なし」を公開エラーで返す契約（AC8）のため、submit 前にここで生存フィルタする。
 */
export function resolveDeleteTargets(displayRowIds: readonly string[], requested: readonly string[]): string[] {
  const live = new Set(displayRowIds);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of requested) {
    if (live.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/**
 * 選択再ベース（K3・DD-021-3）の中核純関数。行構造変更（リモート/ローカルの Insert/Delete）の**前**の表示行 ID 列
 * `oldOrder` と**後**の `newOrder`、および変更前の表示 index `oldRow` を受け、変更後に**同じ行実体（RowId）が来る
 * 新 index** を返す。
 * - 生存: その RowId の新 index（Insert で下方シフトしても RowId を追従）。
 * - 削除: 最近傍生存行（下優先→上・親④）の新 index へ縮退。
 * - 生存行皆無: `null`（呼び出し側が選択解除/単一化する）。
 * DD-021-1 の削除限定縮退（reduceActiveRowTarget）を Insert 併合・index 再解決込みへ一般化し、activeCell と
 * 選択レンジ両端で共有する（実装一本化。旧関数は本一般化で置換され削除済み＝Fable P3）。
 */
export function rebaseRowIndex(
  oldOrder: readonly string[],
  newOrder: readonly string[],
  oldRow: number,
): number | null {
  const rowId = oldOrder[oldRow];
  if (rowId === undefined) {
    return null;
  }
  const survives = new Set(newOrder);
  if (survives.has(rowId)) {
    return newOrder.indexOf(rowId); // 生存（挿入で index がずれても同一 RowId を追う）
  }
  for (let i = oldRow + 1; i < oldOrder.length; i += 1) {
    const id = oldOrder[i]!;
    if (survives.has(id)) {
      return newOrder.indexOf(id); // 下方の最近傍生存行
    }
  }
  for (let i = oldRow - 1; i >= 0; i -= 1) {
    const id = oldOrder[i]!;
    if (survives.has(id)) {
      return newOrder.indexOf(id); // 上方の最近傍生存行
    }
  }
  return null; // 生存行なし
}
