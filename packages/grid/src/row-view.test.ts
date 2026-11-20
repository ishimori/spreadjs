// DD-070-8: 見せる並びの組み立て（並べ替え・絞り込み・後からできた行・消えた行）。
import { describe, expect, it } from 'vitest';

import { createRowId } from '@nanairo-sheet/types';
import type { RowId } from '@nanairo-sheet/types';

import { buildViewRowOrder } from './row-view';

const ids = (...names: string[]): RowId[] => names.map((n) => createRowId(n));
const spec = (order: string[], known: string[]) => ({ order: ids(...order), known: new Set(ids(...known)) });

describe('DD-070-8 buildViewRowOrder', () => {
  it('指定が無ければ文書の並び。並べ替えは渡した順、絞り込みは渡した行だけ', () => {
    const base = ids('a', 'b', 'c', 'd');
    expect(buildViewRowOrder(base, null)).toEqual(base);
    expect(buildViewRowOrder(base, spec(['d', 'b', 'a', 'c'], ['a', 'b', 'c', 'd']))).toEqual(ids('d', 'b', 'a', 'c'));
    expect(buildViewRowOrder(base, spec(['c', 'a'], ['a', 'b', 'c', 'd']))).toEqual(ids('c', 'a'));
  });

  it('後からできた行は、文書の並びで一つ前の見えている行のすぐ後（無ければ先頭）。続けてできた行は文書の並び', () => {
    // a の下に n1・n2 を挿した（文書は a n1 n2 b c）。見せる並びは c a b。
    const base = ids('a', 'n1', 'n2', 'b', 'c');
    expect(buildViewRowOrder(base, spec(['c', 'a', 'b'], ['a', 'b', 'c']))).toEqual(ids('c', 'a', 'n1', 'n2', 'b'));
    // 先頭に挿した行は先頭。
    expect(buildViewRowOrder(ids('n0', 'a', 'b'), spec(['b', 'a'], ['a', 'b']))).toEqual(ids('n0', 'b', 'a'));
    // 隠した行の下に挿した行は、その前の見えている行の後（隠した行は飛ばす）。
    expect(buildViewRowOrder(ids('a', 'h', 'n', 'b'), spec(['b', 'a'], ['a', 'h', 'b']))).toEqual(ids('b', 'a', 'n'));
  });

  it('文書から消えた行は抜け、文書に無い ID と重複は無視する', () => {
    expect(buildViewRowOrder(ids('a', 'c'), spec(['c', 'b', 'a', 'c', 'zz'], ['a', 'b', 'c']))).toEqual(ids('c', 'a'));
  });

  it('全部の行を入れ直した（setData）後は、全部が後からできた行＝文書の並び', () => {
    expect(buildViewRowOrder(ids('x', 'y'), spec(['b', 'a'], ['a', 'b']))).toEqual(ids('x', 'y'));
  });

  it('5 万行でも線形に組み立てる（全部を逆順に並べ替えて 200ms 未満）', () => {
    const base = Array.from({ length: 50_000 }, (_v, i) => createRowId(`r${i}`));
    const reversed = [...base].reverse();
    const t0 = performance.now();
    const out = buildViewRowOrder([...base, createRowId('new')], { order: reversed, known: new Set(base) });
    expect(performance.now() - t0).toBeLessThan(200);
    expect(out[0]).toBe(base[49_999]);
    expect(out[1]).toBe(createRowId('new')); // 文書の並びで一つ前（r49999）の後＝見せる並びでは先頭の r49999 のすぐ後
    expect(out).toHaveLength(50_001);
  });
});

describe('DD-070-8 buildViewRowOrder（Codex P2）', () => {
  it('同じ行の後ろに新しい行が十数万件あっても落ちない（展開構文を使わない）', () => {
    const base = [createRowId('a'), ...Array.from({ length: 150_000 }, (_v, i) => createRowId(`n${i}`))];
    const out = buildViewRowOrder(base, { order: [createRowId('a')], known: new Set([createRowId('a')]) });
    expect(out.length).toBe(150_001);
    expect(out[0]).toBe('a');
  });
});
