// cell-status（DD-060〜062）: セルの状態表示（GridCellStatus）の正規化と設定の検証（DOM 非依存の純関数）。
//
// 状態は文書のデータではなく view-local（値・Undo・cell-commit・protocol に入れない）。描画は render の
// base-layer（cellStatusesInRow フック）、置き場と注入の決まりは本モジュールと呼び出し側が持つ。

import { FormatRuleConfigError } from './format-rules';
import type { GridCellStatus, GridCellStatusColor, GridCellStatusColors } from './index';

const STATUS_LEVELS = new Set(['error', 'warning']);
const COLOR_FIELDS = new Set(['frame', 'background']);

/** 列挙できる Record か（JS の consumer から来る null・文字列・配列で例外にしない・DD-060 Codex P2）。 */
function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * セルの状態表示の置き場（DD-062・view-local）。RowId → ColumnId → 状態。単独モードの `setRows`／`setData`／
 * `initialData` の `cellStatus`（DD-060）と、両モード共通の `setCellStatus` が同じ置き場を使う。
 */
export interface CellStatusStore {
  /**
   * 1 行の状態を丸ごと置き換える（`{}` で消す）。Record でない値はその行を変えずに RowId を `invalid` へ積み、
   * `level` が不正なセルは落として `RowId/ColumnId` を積む。置き換えたら true。
   */
  replaceRow(rowId: string, cellStatus: unknown, invalid: string[]): boolean;
  /** 全部消す（単独モードの `setData`＝文書の丸ごと差し替え）。 */
  clear(): void;
  statusOf(rowId: string, columnId: string): GridCellStatus | undefined;
  /** この行で状態を持つセル（ColumnId → 状態）。無ければ undefined（描画フックが行ごとに引く）。 */
  row(rowId: string): ReadonlyMap<string, GridCellStatus> | undefined;
  /** 1 件でも状態があるか（描画フックの早期リターン用）。 */
  hasAny(): boolean;
}

/**
 * 状態の置き場を作る。`isKnownColumn` があれば未知の列を入力時に静かに落とす（単独モード＝列が mount 時に確定）。
 * 無ければ列をそのまま持ち、描画側で解決できない列を描かない（共同編集モード＝列はサーバーの文書から来る）。
 * 渡されたオブジェクトは保持せず写しを作る（consumer が後から書き換えても表示が変わらない）。
 */
export function createCellStatusStore(isKnownColumn: ((columnId: string) => boolean) | undefined): CellStatusStore {
  const byRow = new Map<string, ReadonlyMap<string, GridCellStatus>>();
  return {
    replaceRow(rowId, cellStatus, invalid) {
      if (!isPlainRecord(cellStatus)) {
        invalid.push(rowId);
        return false;
      }
      const statuses = new Map<string, GridCellStatus>();
      for (const [columnId, status] of Object.entries(cellStatus)) {
        if (isKnownColumn !== undefined && !isKnownColumn(columnId)) {
          continue;
        }
        const level: unknown = isPlainRecord(status) ? status.level : undefined;
        if (level !== 'error' && level !== 'warning') {
          invalid.push(`${rowId}/${columnId}`);
          continue;
        }
        const message: unknown = (status as { message?: unknown }).message;
        statuses.set(columnId, typeof message === 'string' ? { level, message } : { level });
      }
      if (statuses.size > 0) {
        byRow.set(rowId, statuses);
      } else {
        byRow.delete(rowId);
      }
      return true;
    },
    clear() {
      byRow.clear();
    },
    statusOf: (rowId, columnId) => byRow.get(rowId)?.get(columnId),
    row: (rowId) => byRow.get(rowId),
    hasAny: () => byRow.size > 0,
  };
}

/** 無視した不正な指定（`replaceRow` が積んだもの）を1件の診断メッセージにまとめる。 */
export function cellStatusInvalidMessage(invalid: readonly string[]): string {
  return (
    `cellStatus: 不正な指定 ${invalid.join(', ')} を無視しました（RowId/ColumnId は level が 'error'/'warning' でないセル、` +
    'RowId だけのものは cellStatus がオブジェクトでない行）'
  );
}

function invalidColors(detail: string): FormatRuleConfigError {
  return new FormatRuleConfigError('invalid-status-colors', '', `cellStatusColors: ${detail}`);
}

/**
 * DD-061: mount オプション `cellStatusColors` を検証し、既知の水準・項目だけの写しを返す（未指定は undefined）。
 * 不正（オブジェクトでない・未知のキー・空の色）は FormatRuleConfigError（公開 code=column-types-invalid）で
 * fail-fast する。CSS の色としての妥当性は他の色オプションと同じく検査しない（描画側で既定色へ落ちる）。
 */
export function validateCellStatusColors(value: unknown): GridCellStatusColors | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw invalidColors('{ error?, warning? } のオブジェクトが必要');
  }
  const result: { error?: GridCellStatusColor; warning?: GridCellStatusColor } = {};
  for (const [level, colors] of Object.entries(value)) {
    if (!STATUS_LEVELS.has(level)) {
      throw invalidColors(`未知の水準 "${level}"（error / warning のみ）`);
    }
    if (!isPlainRecord(colors)) {
      throw invalidColors(`${level} は { frame?, background? } のオブジェクトが必要`);
    }
    const resolved: { frame?: string; background?: string } = {};
    for (const [field, color] of Object.entries(colors)) {
      if (!COLOR_FIELDS.has(field)) {
        throw invalidColors(`${level} の未知の項目 "${field}"（frame / background のみ）`);
      }
      if (typeof color !== 'string' || color.trim() === '') {
        throw invalidColors(`${level}.${field} の色が空（CSS color 文字列が必要）`);
      }
      resolved[field as 'frame' | 'background'] = color;
    }
    result[level as 'error' | 'warning'] = resolved;
  }
  return result;
}
