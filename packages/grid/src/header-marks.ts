// 見出しの印の置き場（DD-070-6）。列の見出しの印（並べ替えの向き・絞り込みのボタン）と、列のまとまりの開閉の印を ID で持つ。
// view-local（文書・Operation・サーバーへ送らない）。mount オプションと命令（setColumnHeaderMarks・setColumnGroupMarks）が
// 同じ置き場を使い、丸ごと置き換える（`{}` で全部消す）。描画のたびに ID から表示 index へ解決する（未知の ID は描かない）。
// 不正な項目はその項目だけ捨てて診断 warn（column-header-mark-invalid）。全体を例外にしない。

import type { DiagnosticSink } from './diagnostics';

/** 列の見出しの印（DD-070-6・Experimental 0.x）。 */
export interface GridColumnHeaderMark {
  /** 並べ替えの向き（▲ 昇順・▼ 降順を見出しの右端に描く）。 */
  readonly sort?: 'asc' | 'desc';
  /** 絞り込みのボタン（`available`＝枠と ▼・`active`＝絞り込み中の塗り）。押すと `header-click` の `target` が `'filter'`。 */
  readonly filter?: 'available' | 'active';
}

/** 列のまとまりの開閉の印（DD-070-6・Experimental 0.x）。上の段の名前の左に ▾（開いている）／▸（閉じている）を描く。 */
export interface GridColumnGroupMark {
  readonly collapsed: boolean;
}

export interface HeaderMarkStore {
  /** 列の見出しの印を丸ごと置き換える（不正な項目は捨てて warn）。 */
  setColumnMarks(raw: unknown, source: string): void;
  /** まとまりの印を丸ごと置き換える（不正な項目は捨てて warn）。 */
  setGroupMarks(raw: unknown, source: string): void;
  columnMark(columnId: string): GridColumnHeaderMark | undefined;
  groupMark(groupId: string): GridColumnGroupMark | undefined;
  /** 置き換えのたびに増える版（描き直しの要否の判定に使う）。 */
  revision(): number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 1 列の印の検査（正しければ写し・不正なら undefined）。空の印（sort も filter も無い）は「印なし」として捨てる。 */
function parseColumnMark(value: unknown): GridColumnHeaderMark | null | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const sort = value['sort'];
  const filter = value['filter'];
  if (sort !== undefined && sort !== 'asc' && sort !== 'desc') {
    return undefined;
  }
  if (filter !== undefined && filter !== 'available' && filter !== 'active') {
    return undefined;
  }
  if (sort === undefined && filter === undefined) {
    return null;
  }
  return { ...(sort !== undefined ? { sort } : {}), ...(filter !== undefined ? { filter } : {}) };
}

export function createHeaderMarkStore(
  diag: DiagnosticSink,
  /** 今わかっている列（ColumnId）。boot 前で列の並びが分からなければ undefined（未知の列の検査をしない）。 */
  knownColumns: () => ReadonlySet<string> | undefined,
): HeaderMarkStore {
  let columnMarks = new Map<string, GridColumnHeaderMark>();
  let groupMarks = new Map<string, GridColumnGroupMark>();
  let rev = 0;

  const warn = (source: string, detail: string): void => {
    diag.emit('warn', 'column-header-mark-invalid', `${source}: ${detail}（その項目だけ捨てる）`);
  };

  return {
    setColumnMarks(raw, source) {
      const next = new Map<string, GridColumnHeaderMark>();
      if (!isPlainRecord(raw)) {
        warn(source, 'ColumnId → 印のオブジェクトが必要');
      } else {
        const known = knownColumns();
        for (const [columnId, value] of Object.entries(raw)) {
          const mark = parseColumnMark(value);
          if (mark === undefined) {
            warn(source, `列 "${columnId}" の印は { sort?: 'asc' | 'desc', filter?: 'available' | 'active' } が必要`);
            continue;
          }
          if (known !== undefined && !known.has(columnId)) {
            warn(source, `未知の列 "${columnId}"`);
            continue;
          }
          if (mark !== null) {
            next.set(columnId, mark);
          }
        }
      }
      columnMarks = next;
      rev += 1;
    },
    setGroupMarks(raw, source) {
      const next = new Map<string, GridColumnGroupMark>();
      if (!isPlainRecord(raw)) {
        warn(source, 'まとまりの id → 印のオブジェクトが必要');
      } else {
        for (const [groupId, value] of Object.entries(raw)) {
          if (!isPlainRecord(value) || typeof value['collapsed'] !== 'boolean') {
            warn(source, `まとまり "${groupId}" の印は { collapsed: boolean } が必要`);
            continue;
          }
          next.set(groupId, { collapsed: value['collapsed'] });
        }
      }
      groupMarks = next;
      rev += 1;
    },
    columnMark: (columnId) => columnMarks.get(columnId),
    groupMark: (groupId) => groupMarks.get(groupId),
    revision: () => rev,
  };
}
