// Axis: 1 次元（行 or 列）のサイズ構造（計画書 §13.2）。
// DOM 非依存の純粋データ構造で、PoC-B の座標計算の土台。
//
// 初期実装（要確認3 で確定）:
//   - 順序配列（Id[]）＋ ID→index Map
//   - 標準サイズ ＋ 疎 override（Id キーで保持し、挿入・削除の再採番に自然追従）
//   - index↔pixel offset は累積オフセット（prefix sum）キャッシュ＋二分探索
// 構造変更（サイズ変更・挿入・削除）は prefix sum を再構築し、再構築時間を計測フックへ記録する。
// ボトルネックが出たら Fenwick Tree へ切替（本 PoC では計測して判断）。
// Axis API を抽象化し、上位層へ内部配列を露出しない（§13.2）。

/** prefix sum 再構築の計測フック（Fenwick 切替判断の材料）。 */
export interface AxisRebuildStats {
  /** 再構築回数。 */
  readonly rebuildCount: number;
  /** 直近の再構築所要（ms）。 */
  readonly lastRebuildMs: number;
  /** 累積再構築時間（ms）。 */
  readonly totalRebuildMs: number;
}

/** 1 次元のサイズ・位置構造。上位は index / Id / pixel offset のみを扱う。 */
export interface Axis<Id extends string> {
  /** 要素数。 */
  count(): number;
  /** 全体サイズ（px）。 */
  totalSize(): number;
  /** 標準サイズ（px）。 */
  defaultSize(): number;
  /** index のサイズ（override があればそれ、なければ標準）。 */
  size(index: number): number;
  /** index の開始 pixel offset。offsetOf(count) === totalSize。範囲外は端へクランプ。 */
  offsetOf(index: number): number;
  /** pixel offset を含む index（[0, count-1] にクランプ）。 */
  indexAt(pixel: number): number;
  /** index の Id。 */
  getId(index: number): Id;
  /** Id の index（無ければ -1）。 */
  getIndex(id: Id): number;
  /** Id が存在するか。 */
  hasId(id: Id): boolean;
  /** index のサイズを override 設定する。 */
  setSize(index: number, size: number): void;
  /** Id のサイズを override 設定する。 */
  setSizeById(id: Id, size: number): void;
  /** index の override を解除して標準サイズへ戻す。 */
  resetSize(index: number): void;
  /** atIndex の位置に ids を挿入する（size 省略時は標準サイズ）。 */
  insert(atIndex: number, ids: readonly Id[], size?: number): void;
  /** atIndex から removeCount 件を削除する。 */
  remove(atIndex: number, removeCount: number): void;
  /** prefix sum 再構築の計測値。 */
  rebuildStats(): AxisRebuildStats;
  /** prefix sum を明示的に再構築する（再構築時間の直接計測用）。 */
  forceRebuild(): void;
}

/** Axis 構築設定。 */
export interface AxisConfig<Id extends string> {
  /** 順序付き Id 配列（この配列は複製されるため呼び出し側で再利用してよい）。 */
  readonly ids: readonly Id[];
  /** 標準サイズ（px）。 */
  readonly defaultSize: number;
  /** 疎 override（Id → サイズ）。 */
  readonly overrides?: Iterable<readonly [Id, number]>;
}

export function createAxis<Id extends string>(config: AxisConfig<Id>): Axis<Id> {
  if (config.defaultSize <= 0) {
    throw new Error(`Axis: defaultSize は正の数（受領: ${config.defaultSize}）`);
  }
  const defaultSize = config.defaultSize;
  const ids: Id[] = [...config.ids];
  // override は Id キーで保持する。index キーだと挿入・削除で全件シフトが必要になるため。
  const overrideById = new Map<Id, number>(config.overrides ?? []);

  // Id→index Map（構造変更でのみ再構築）。
  let idToIndex = new Map<Id, number>();
  let structuralDirty = true;

  // prefix sum キャッシュ（サイズ変更・構造変更で無効化）。prefix[i]=index i の開始 offset。
  let prefix: Float64Array | null = null;
  // DD-070-7: 大きさ 0 の項目（隠した列）の数。prefix と一緒に数える（0 なら当たり判定は従来と同一）。
  let zeroCount = 0;

  let rebuildCount = 0;
  let lastRebuildMs = 0;
  let totalRebuildMs = 0;

  const ensureStructural = (): void => {
    if (!structuralDirty) {
      return;
    }
    idToIndex = new Map<Id, number>();
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      if (id !== undefined) {
        idToIndex.set(id, i);
      }
    }
    structuralDirty = false;
  };

  const sizeAt = (index: number): number => {
    const id = ids[index];
    if (id === undefined) {
      return defaultSize;
    }
    return overrideById.get(id) ?? defaultSize;
  };

  const ensurePrefix = (): Float64Array => {
    const cached = prefix;
    if (cached !== null) {
      return cached;
    }
    const start = performance.now();
    const built = new Float64Array(ids.length + 1);
    let acc = 0;
    let zeros = 0;
    for (let i = 0; i < ids.length; i += 1) {
      built[i] = acc;
      const size = sizeAt(i);
      if (size === 0) {
        zeros += 1;
      }
      acc += size;
    }
    zeroCount = zeros;
    built[ids.length] = acc;
    prefix = built;
    const elapsed = performance.now() - start;
    rebuildCount += 1;
    lastRebuildMs = elapsed;
    totalRebuildMs += elapsed;
    return built;
  };

  const invalidatePrefix = (): void => {
    prefix = null;
  };

  /**
   * DD-070-7: 当たり判定が大きさ 0 の項目（隠した列）に当たったら、見えている項目へ寄せる。二分探索は「開始 offset が pixel 以下の
   * 最大の index」を返すので、間の 0 の項目は自然に飛ばす。寄せが要るのは先頭（pixel<=0）と末尾（pixel>=total）だけ。
   * `prefer` の向きに見えている項目が無ければ逆の向き。全部 0 なら元の index。
   */
  const visibleNear = (index: number, prefer: 1 | -1): number => {
    if (zeroCount === 0 || sizeAt(index) !== 0) {
      return index;
    }
    for (let i = index + prefer; i >= 0 && i < ids.length; i += prefer) {
      if (sizeAt(i) !== 0) {
        return i;
      }
    }
    for (let i = index - prefer; i >= 0 && i < ids.length; i -= prefer) {
      if (sizeAt(i) !== 0) {
        return i;
      }
    }
    return index;
  };

  const axis: Axis<Id> = {
    count() {
      return ids.length;
    },
    totalSize() {
      const p = ensurePrefix();
      return p[ids.length] ?? 0;
    },
    defaultSize() {
      return defaultSize;
    },
    size(index) {
      return sizeAt(index);
    },
    offsetOf(index) {
      const p = ensurePrefix();
      const clamped = index < 0 ? 0 : index > ids.length ? ids.length : Math.floor(index);
      return p[clamped] ?? 0;
    },
    indexAt(pixel) {
      const p = ensurePrefix();
      const n = ids.length;
      if (n === 0) {
        return 0;
      }
      const total = p[n] ?? 0;
      if (pixel <= 0) {
        return visibleNear(0, 1);
      }
      if (pixel >= total) {
        return visibleNear(n - 1, -1);
      }
      // prefix は昇順。prefix[i] <= pixel を満たす最大の i を二分探索する。
      let lo = 0;
      let hi = n; // [lo, hi)
      while (lo + 1 < hi) {
        const mid = (lo + hi) >>> 1;
        const midOffset = p[mid] ?? 0;
        if (midOffset <= pixel) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      return visibleNear(lo, 1);
    },
    getId(index) {
      const id = ids[index];
      if (id === undefined) {
        throw new Error(`Axis.getId: 範囲外 index=${index}（count=${ids.length}）`);
      }
      return id;
    },
    getIndex(id) {
      ensureStructural();
      return idToIndex.get(id) ?? -1;
    },
    hasId(id) {
      ensureStructural();
      return idToIndex.has(id);
    },
    setSize(index, size) {
      const id = ids[index];
      if (id === undefined) {
        throw new Error(`Axis.setSize: 範囲外 index=${index}`);
      }
      if (size <= 0) {
        throw new Error(`Axis.setSize: size は正の数（受領: ${size}）`);
      }
      overrideById.set(id, size);
      invalidatePrefix();
    },
    setSizeById(id, size) {
      if (size <= 0) {
        throw new Error(`Axis.setSizeById: size は正の数（受領: ${size}）`);
      }
      overrideById.set(id, size);
      invalidatePrefix();
    },
    resetSize(index) {
      const id = ids[index];
      if (id === undefined) {
        throw new Error(`Axis.resetSize: 範囲外 index=${index}`);
      }
      if (overrideById.delete(id)) {
        invalidatePrefix();
      }
    },
    insert(atIndex, insertIds, size) {
      const at = Math.min(Math.max(atIndex, 0), ids.length);
      ids.splice(at, 0, ...insertIds);
      if (size !== undefined) {
        if (size <= 0) {
          throw new Error(`Axis.insert: size は正の数（受領: ${size}）`);
        }
        for (const id of insertIds) {
          overrideById.set(id, size);
        }
      }
      structuralDirty = true;
      invalidatePrefix();
    },
    remove(atIndex, removeCount) {
      if (removeCount <= 0) {
        return;
      }
      const at = Math.min(Math.max(atIndex, 0), ids.length);
      const removed = ids.splice(at, removeCount);
      for (const id of removed) {
        overrideById.delete(id);
      }
      structuralDirty = true;
      invalidatePrefix();
    },
    rebuildStats() {
      return { rebuildCount, lastRebuildMs, totalRebuildMs };
    },
    forceRebuild() {
      invalidatePrefix();
      ensurePrefix();
      // Id→index も構造再構築時間の計測対象にしたい場合に備え、ここで揃える。
      structuralDirty = true;
      ensureStructural();
    },
  };
  return axis;
}
