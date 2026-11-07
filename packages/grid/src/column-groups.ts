// DD-064 K4: 2段の見出し（列のまとまり・mount 時固定・表示だけ）。公開型 GridColumnGroup は grid 自身が定義する（R7）。
// 契約の正本は doc/DD/DD-064/contract.md §6。形の誤りは DisplayConfigError（公開 code=`column-display-invalid`・
// columnCaptions と同じ経路）で fail-fast する。

import { DisplayConfigError } from './display-format';

/** 列のまとまり（2段の見出しの上の段・DD-064・Experimental 0.x）。 */
export interface GridColumnGroup {
  /** 上の段に出す名前（空・空白だけは不可）。 */
  readonly caption: string;
  /** まとめる列（columnOrder の中で隣り合う 1 列以上。並べる順は問わない）。 */
  readonly columnIds: readonly string[];
}

/** 列 index に解決したまとまり（半開区間・render の ColumnGroupSpan と同じ形）。 */
export interface CompiledColumnGroup {
  readonly colStart: number;
  readonly colEnd: number;
  readonly caption: string;
}

function fail(columnId: string, message: string): never {
  throw new DisplayConfigError('invalid-column-group', columnId, `columnGroups: ${message}`);
}

/**
 * 形の検査と列 index への解決（contract §6）。未指定・空の配列は [] を返す（見出しは 1 段のまま）。
 * 列は columnOrder で隣り合うこと・まとまり同士が同じ列を持たないこと・固定列の境界をまたがないこと。
 */
export function compileColumnGroups(
  raw: unknown,
  columnOrder: readonly string[],
  frozenColCount: number,
): readonly CompiledColumnGroup[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    fail('', '{ caption, columnIds } の配列が必要');
  }
  const columnIndex = new Map<string, number>();
  columnOrder.forEach((columnId, index) => {
    if (!columnIndex.has(columnId)) {
      columnIndex.set(columnId, index);
    }
  });
  const frozen = Math.min(Math.max(frozenColCount, 0), columnOrder.length);
  const owner = new Map<number, number>(); // 列 index → まとまりの番号（重なりの判定）
  const groups: CompiledColumnGroup[] = [];
  (raw as readonly unknown[]).forEach((entry: unknown, position) => {
    if (typeof entry !== 'object' || entry === null) {
      fail('', `[${position}] が { caption, columnIds } のオブジェクトではない`);
    }
    const record = entry as { caption?: unknown; columnIds?: unknown };
    if (typeof record.caption !== 'string' || record.caption.trim() === '') {
      fail('', `[${position}] の caption が空・空白だけ・文字列でない`);
    }
    const columnIds = record.columnIds;
    if (!Array.isArray(columnIds) || columnIds.length === 0 || columnIds.some((id) => typeof id !== 'string')) {
      fail('', `[${position}]「${record.caption}」の columnIds は 1 列以上の文字列の配列が必要`);
    }
    const indices: number[] = [];
    for (const columnId of columnIds as readonly string[]) {
      const index = columnIndex.get(columnId);
      if (index === undefined) {
        fail(columnId, `[${position}]「${record.caption}」に未知の列 ${columnId}`);
      }
      if (indices.includes(index)) {
        fail(columnId, `[${position}]「${record.caption}」で列 ${columnId} が重複`);
      }
      indices.push(index);
    }
    indices.sort((a, b) => a - b);
    const colStart = indices[0]!;
    const colEnd = indices[indices.length - 1]! + 1;
    if (colEnd - colStart !== indices.length) {
      fail(String(columnIds[0]), `[${position}]「${record.caption}」の列が columnOrder で隣り合っていない`);
    }
    if (colStart < frozen && colEnd > frozen) {
      fail(String(columnIds[0]), `[${position}]「${record.caption}」が固定列（frozenColumnCount=${frozen}）の境界をまたぐ`);
    }
    for (let col = colStart; col < colEnd; col += 1) {
      const other = owner.get(col);
      if (other !== undefined) {
        fail(columnOrder[col] ?? '', `[${position}]「${record.caption}」が [${other}] と同じ列 ${columnOrder[col]} を持つ`);
      }
      owner.set(col, position);
    }
    groups.push({ colStart, colEnd, caption: record.caption });
  });
  return groups;
}
