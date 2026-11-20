// 見せる行と並び（DD-070-8）。consumer が渡した「見せる行を見せる順」と文書の並びから、行の Axis に載せる並びを組み立てる
// 純粋関数。並べ替え・絞り込みは一度きり（Excel と同じ）: 値が変わっても並び直さない。
//
// - 渡した時点にあった行（known）で渡さなかった行は隠す
// - 渡した後にできた行（known に無い）は、文書の並びで一つ前の見えている行のすぐ後に見せる（無ければ先頭）
// - 文書から消えた行は並びから抜ける
// 計算量は O(文書の行数)（5 万行で setRowView のたびに作り直してよい）。

import type { RowId } from '@nanairo-sheet/types';

export interface RowViewSpec {
  /** 見せる行を見せる順（重複は最初の 1 つ・文書に無い行は無視）。 */
  readonly order: readonly RowId[];
  /** 渡した時点に文書にあった行（これに無い行は「後からできた行」として見せる）。 */
  readonly known: ReadonlySet<RowId>;
}

/** 文書の並び（displayRowOrder）と指定から、見せる並びを組み立てる。指定が無ければ文書の並びのまま。 */
export function buildViewRowOrder(base: readonly RowId[], spec: RowViewSpec | null): readonly RowId[] {
  if (spec === null) {
    return base;
  }
  const live = new Set(base);
  const visible: RowId[] = [];
  const visibleSet = new Set<RowId>();
  for (const id of spec.order) {
    if (live.has(id) && !visibleSet.has(id)) {
      visible.push(id);
      visibleSet.add(id);
    }
  }
  // 後からできた行を、文書の並びで一つ前の見えている行（無ければ先頭＝null）ごとにまとめる（文書の並びを保つ）。
  const after = new Map<RowId | null, RowId[]>();
  let anchor: RowId | null = null;
  for (const id of base) {
    if (!spec.known.has(id)) {
      const group = after.get(anchor);
      if (group === undefined) {
        after.set(anchor, [id]);
      } else {
        group.push(id);
      }
      continue;
    }
    if (visibleSet.has(id)) {
      anchor = id;
    }
  }
  if (after.size === 0) {
    return visible;
  }
  const out: RowId[] = (after.get(null) ?? []).slice();
  for (const id of visible) {
    out.push(id);
    const group = after.get(id);
    if (group !== undefined) {
      // Codex P2: 展開構文（push(...group)）は引数の数の上限（十数万件）で落ちるので 1 件ずつ足す。
      for (const added of group) {
        out.push(added);
      }
    }
  }
  return out;
}
