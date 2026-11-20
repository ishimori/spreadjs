import { describe, expect, it } from 'vitest';

import { createRowId, type RowId } from '@nanairo-sheet/types';

import { createAxis } from './axis';

/** テスト用に r0, r1, ... の RowId 列を作る。 */
function rowIds(count: number, prefix = 'r'): RowId[] {
  return Array.from({ length: count }, (_v, i) => createRowId(`${prefix}${i}`));
}

describe('Axis: 標準サイズのみ（offset・indexAt の基本）', () => {
  const axis = createAxis({ ids: rowIds(5), defaultSize: 20 });

  it('offsetOf は累積オフセット・offsetOf(count)=totalSize', () => {
    expect(axis.offsetOf(0)).toBe(0);
    expect(axis.offsetOf(3)).toBe(60);
    expect(axis.offsetOf(5)).toBe(100);
    expect(axis.totalSize()).toBe(100);
  });

  it('indexAt は境界を次セルの内側に含める', () => {
    expect(axis.indexAt(0)).toBe(0);
    expect(axis.indexAt(59)).toBe(2);
    expect(axis.indexAt(60)).toBe(3); // 境界ちょうどは次セル
  });

  it('indexAt は先頭・末尾でクランプする', () => {
    expect(axis.indexAt(-5)).toBe(0);
    expect(axis.indexAt(1e9)).toBe(4); // count-1
  });
});

describe('Axis: override 混在（サイズ変更は Id override で保持）', () => {
  it('index2 を 50 にすると以降の offset がずれ、default は不変', () => {
    const axis = createAxis({ ids: rowIds(5), defaultSize: 20 });
    axis.setSize(2, 50);
    expect(axis.size(2)).toBe(50);
    expect(axis.size(1)).toBe(20); // default 不変
    expect(axis.offsetOf(2)).toBe(40);
    expect(axis.offsetOf(3)).toBe(90);
    expect(axis.totalSize()).toBe(130);
    expect(axis.indexAt(45)).toBe(2);
    expect(axis.indexAt(90)).toBe(3);
  });

  it('resetSize で override を解除して標準へ戻す', () => {
    const axis = createAxis({ ids: rowIds(5), defaultSize: 20 });
    axis.setSize(2, 50);
    axis.resetSize(2);
    expect(axis.size(2)).toBe(20);
    expect(axis.totalSize()).toBe(100);
  });

  it('初期 overrides を受け取れる', () => {
    const ids = rowIds(3);
    const targetId = ids[1];
    if (targetId === undefined) {
      throw new Error('テスト前提: ids[1] が存在する');
    }
    const axis = createAxis({ ids, defaultSize: 20, overrides: [[targetId, 40]] });
    expect(axis.size(1)).toBe(40);
    expect(axis.totalSize()).toBe(80);
  });
});

describe('Axis: ID↔index の往復', () => {
  const ids = rowIds(5);
  const axis = createAxis({ ids, defaultSize: 20 });

  it('getIndex(getId(i))===i・getId(getIndex(id))===id', () => {
    expect(axis.getIndex(axis.getId(3))).toBe(3);
    const id3 = ids[3];
    if (id3 === undefined) {
      throw new Error('テスト前提: ids[3] が存在する');
    }
    expect(axis.getId(axis.getIndex(id3))).toBe(id3);
  });

  it('存在しない Id は getIndex=-1・hasId=false', () => {
    const ghost = createRowId('ghost');
    expect(axis.getIndex(ghost)).toBe(-1);
    expect(axis.hasId(ghost)).toBe(false);
  });
});

describe('Axis: 挿入後の offset・再採番・override 追従', () => {
  it('index1 に 2 件挿入すると count・offset・ID→index が整合する', () => {
    const axis = createAxis({ ids: rowIds(5), defaultSize: 20 });
    // 挿入前に既存 index3 の Id へ override を設定しておく。
    const keepId = axis.getId(3);
    axis.setSizeById(keepId, 30);

    const inserted = [createRowId('ins-a'), createRowId('ins-b')];
    axis.insert(1, inserted, 20);

    expect(axis.count()).toBe(7);
    // 挿入した Id は新しい index で引ける。
    expect(axis.getIndex(inserted[0])).toBe(1);
    expect(axis.getIndex(inserted[1])).toBe(2);
    // 元 index3 の Id は 2 つ後ろへずれ、override(30) が追従する。
    expect(axis.getIndex(keepId)).toBe(5);
    expect(axis.size(5)).toBe(30);
    // 元 5 行のうち 4 行が default(20)・1 行が override(30)、挿入 2 行が 20。
    expect(axis.totalSize()).toBe(4 * 20 + 30 + 2 * 20); // = 150
  });
});

describe('Axis: 削除後の offset・消えた Id', () => {
  it('index2 から 2 件削除すると後続が詰まり、削除 Id は getIndex=-1', () => {
    const axis = createAxis({ ids: rowIds(6), defaultSize: 20 });
    const removedId = axis.getId(2);
    axis.remove(2, 2);
    expect(axis.count()).toBe(4);
    expect(axis.getIndex(removedId)).toBe(-1);
    expect(axis.hasId(removedId)).toBe(false);
    expect(axis.totalSize()).toBe(80);
    // 元 index4 → 新 index2 へ詰まる。
    expect(axis.offsetOf(2)).toBe(40);
  });
});

describe('Axis: 再構築時間の計測フック', () => {
  it('サイズ変更・挿入で rebuildCount が増え lastRebuildMs>=0', () => {
    const axis = createAxis({ ids: rowIds(100), defaultSize: 20 });
    axis.totalSize(); // 初回ビルド
    const first = axis.rebuildStats().rebuildCount;
    expect(first).toBeGreaterThanOrEqual(1);

    axis.setSize(10, 40);
    axis.totalSize(); // 再ビルド
    const second = axis.rebuildStats().rebuildCount;
    expect(second).toBe(first + 1);
    expect(axis.rebuildStats().lastRebuildMs).toBeGreaterThanOrEqual(0);

    axis.forceRebuild();
    expect(axis.rebuildStats().rebuildCount).toBe(second + 1);
    expect(axis.rebuildStats().totalRebuildMs).toBeGreaterThanOrEqual(0);
  });
});

describe('Axis: 大規模健全性（50,000行・二分探索）', () => {
  it('offsetOf(50000)=1,100,000・indexAt(550000)=25000', () => {
    const axis = createAxis({ ids: rowIds(50000), defaultSize: 22 });
    expect(axis.totalSize()).toBe(50000 * 22);
    expect(axis.offsetOf(50000)).toBe(1_100_000);
    expect(axis.indexAt(550_000)).toBe(25_000);
    // 末尾セルの内側
    expect(axis.indexAt(50000 * 22 - 1)).toBe(49_999);
  });
});

describe('DD-070-7 大きさ 0 の項目（隠した列）の当たり判定', () => {
  const ids = ['a', 'b', 'c', 'd'] as const;
  it('間の 0 は飛ばし、先頭・末尾の 0 は見えている項目へ寄せる。0 が無ければ従来どおり', () => {
    const axis = createAxis<string>({ ids: [...ids], defaultSize: 80, overrides: [['a', 0], ['c', 0], ['d', 0]] });
    expect(axis.indexAt(0)).toBe(1); // a は 0 → b
    expect(axis.indexAt(-5)).toBe(1);
    expect(axis.indexAt(10)).toBe(1);
    expect(axis.indexAt(79)).toBe(1);
    expect(axis.indexAt(80)).toBe(1); // 末尾（total=80）→ 末尾から戻って b
    expect(axis.indexAt(500)).toBe(1);
    const plain = createAxis<string>({ ids: [...ids], defaultSize: 80 });
    expect([plain.indexAt(0), plain.indexAt(80), plain.indexAt(500)]).toEqual([0, 1, 3]);
  });

  it('全部 0 なら元の index を返す（例外にしない）', () => {
    const axis = createAxis<string>({ ids: ['a', 'b'], defaultSize: 80, overrides: [['a', 0], ['b', 0]] });
    expect(axis.indexAt(0)).toBe(0);
    expect(axis.totalSize()).toBe(0);
  });
});
