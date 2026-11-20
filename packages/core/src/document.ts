// 最小文書モデルと純粋な読み取り/複製ユーティリティ（phase1-design §2）。
// 単一シート・行 Axis = rowOrder（tombstone を保持）＋ RowMeta・列は固定 ColumnId 列・
// CellStore は二段 Map。状態は持たず、関数は新状態を返すかバッファ（clone）を操作する。
// ランタイム依存ゼロ・DOM/Node 非参照。CellScalar は operations.ts が定義（phase1-design §3）。

import type { ColumnId, RowId } from '@nanairo-sheet/types';

import { createCellStore } from './cell-store';
import type { CellStore } from './cell-store';
import type { CellScalar } from './operations';

export interface RowMeta {
  id: RowId;
  slot: number; // 安定整数スロット（§6.3）。CellStore のチャンクキー（DD-010・ADR-0011 A案）
  tombstone: boolean; // DeleteRows で true。rowOrder からは消さない
  lastChangedRevision: number;
}

export interface CellRecord {
  readonly value: CellScalar;
  readonly lastChangedRevision: number; // 正準ハッシュに含める（phase1-design §5）
}

export interface SheetDocument {
  revision: number;
  // rowOrder・rowMeta・RowMeta・CellRecord は適用の前後の文書で共有しうる（forkDocument・DD-070-10）ため読み取り専用の型にする。
  // 書くのは core の適用と巻き戻しだけで、writableRowOrder / writableRowMeta を通し、RowMeta は差し替える。
  rowOrder: readonly RowId[]; // tombstone 含む全行の順序（アンカー解決の基準）
  rowMeta: ReadonlyMap<RowId, Readonly<RowMeta>>;
  columnOrder: ColumnId[]; // 固定 ColumnId 列（PoC は変更しない）
  // 安定 slot キー CellStore（DD-010・CG-2）。RowId→slot は rowMeta、ColumnId→colIndex は columnOrder で
  // 解決する（下記 slotOf / columnIndexOf・getCell / setCell 等の純ヘルパー経由でのみ読み書きする）。
  cells: CellStore;
  // 次に採番する slot の直前値（＝これまで採番した slot の最大・空文書は -1。nextSlot=maxSlot+1）。
  // DD-021-3 P2-1: InsertRows ごとの rowMeta 全走査（Θ(N²)）を避けるため、最大 slot をキャッシュして O(1) で採番する。
  // **単調非減少**（rollback で行が消えても減らさない＝slot 一意性を保ち決定論を壊さない・DD-021-3 📐 決定）。
  // hash には含めない（正準形は slot 非依存・hash.ts）。snapshot round-trip では rowMeta の最大 slot から再計算する。
  maxSlot: number;
}

/** CellScalar を深く複製する（判別ユニオンを網羅・`as` 不使用）。 */
export function cloneCellScalar(value: CellScalar): CellScalar {
  switch (value.kind) {
    case 'blank':
      return { kind: 'blank' };
    case 'string':
      return { kind: 'string', value: value.value };
    case 'number':
      return { kind: 'number', value: value.value };
    case 'date':
      return { kind: 'date', value: value.value };
  }
}

export function createDocument(columns: ColumnId[]): SheetDocument {
  return {
    revision: 0,
    rowOrder: ownRowOrder([]),
    rowMeta: ownRowMeta(new Map()),
    columnOrder: [...columns], // 呼び出し側配列の後続変更から切り離す
    cells: createCellStore(),
    maxSlot: -1, // 空文書は次 slot=0
  };
}

/** RowId → 安定 slot（rowMeta 経由・tombstone 行も slot を保持）。未知行は undefined。 */
export function slotOf(doc: SheetDocument, rowId: RowId): number | undefined {
  return doc.rowMeta.get(rowId)?.slot;
}

/** ColumnId → colIndex（columnOrder 上の位置）。columnOrder 外は -1（get は undefined 扱い）。 */
export function columnIndexOf(doc: SheetDocument, columnId: ColumnId): number {
  return doc.columnOrder.indexOf(columnId);
}

/**
 * 完全な深いコピーを返す（切り離した複製が要る呼び出し側用。core の適用は forkDocument を使う）。
 * rowOrder/columnOrder は新配列、rowMeta/cells は新 Map、RowMeta/CellRecord/CellScalar も
 * すべて別オブジェクトにする。clone のどこを変更しても入力 doc は不変（部分ミューテーション経路の遮断）。
 */
export function cloneDocument(doc: SheetDocument): SheetDocument {
  const rowMeta = new Map<RowId, Readonly<RowMeta>>();
  for (const [rowId, meta] of doc.rowMeta) {
    rowMeta.set(rowId, { ...meta });
  }
  return {
    revision: doc.revision,
    rowOrder: ownRowOrder([...doc.rowOrder]),
    rowMeta: ownRowMeta(rowMeta),
    columnOrder: [...doc.columnOrder],
    cells: doc.cells.clone(), // CellRecord/CellScalar まで別オブジェクト（隔離は cell-store.clone が担保）
    maxSlot: doc.maxSlot, // 採番カーソルを引き継ぐ（clone 後の InsertRows で slot が衝突しない・単調維持）
  };
}

// その場で書いてよい rowOrder 配列・rowMeta Map（作った・写した入れ物で、どの文書とも共有していない）。キーと値は同じ
// オブジェクトで、値は書ける型で持つ。ここに無い入れ物は共有しうるものとして、書く前に写す（DD-070-10）。
// 記録は globalThis に 1 つだけ置き、core のモジュールが二重に読み込まれても同じ記録を見る（片方の fork が外した印を
// もう片方が知らずにその場で書く、を防ぐ・Codex P2）。
interface OwnedRowAxis {
  readonly rowOrders: WeakMap<readonly RowId[], RowId[]>;
  readonly rowMetas: WeakMap<ReadonlyMap<RowId, Readonly<RowMeta>>, Map<RowId, Readonly<RowMeta>>>;
}

const OWNED_ROW_AXIS_KEY = Symbol.for('@nanairo-sheet/core.ownedRowAxis.v1');

function isOwnedRowAxis(value: unknown): value is OwnedRowAxis {
  return (
    typeof value === 'object' &&
    value !== null &&
    'rowOrders' in value &&
    value.rowOrders instanceof WeakMap &&
    'rowMetas' in value &&
    value.rowMetas instanceof WeakMap
  );
}

function loadOwnedRowAxis(): OwnedRowAxis {
  const existing: unknown = Reflect.get(globalThis, OWNED_ROW_AXIS_KEY);
  if (isOwnedRowAxis(existing)) {
    return existing;
  }
  const created: OwnedRowAxis = { rowOrders: new WeakMap(), rowMetas: new WeakMap() };
  Object.defineProperty(globalThis, OWNED_ROW_AXIS_KEY, { value: created, enumerable: false, configurable: false, writable: false });
  return created;
}

const ownedRowAxis = loadOwnedRowAxis();

function ownRowOrder(rowOrder: RowId[]): RowId[] {
  ownedRowAxis.rowOrders.set(rowOrder, rowOrder);
  return rowOrder;
}

function ownRowMeta(rowMeta: Map<RowId, Readonly<RowMeta>>): Map<RowId, Readonly<RowMeta>> {
  ownedRowAxis.rowMetas.set(rowMeta, rowMeta);
  return rowMeta;
}

/**
 * 構造を共有する複製（二相適用の作業用の文書・DD-070-10）。費用は表の大きさに比例しない。
 * - cells は `CellStore.fork`（書くチャンクと行だけを写す）。rowOrder・rowMeta は共有し、行の挿入・削除で
 *   書く前に writableRowOrder / writableRowMeta が写す。columnOrder は小さいので写す。
 * - 共有するため **RowMeta・CellRecord・CellScalar のオブジェクトはその場で書き換えない**（差し替える。型も読み取り専用）。
 *   rowOrder・rowMeta を書くときは必ず writableRowOrder / writableRowMeta を通す（戻り値を持ち続けて後で書かない）。
 * fork のどちら側をこの約束どおりに書き換えても、もう片方は変わらない。
 */
export function forkDocument(doc: SheetDocument): SheetDocument {
  // 共有にするので、どちらの側もその場では書けない（次に書く側が写す）。
  ownedRowAxis.rowOrders.delete(doc.rowOrder);
  ownedRowAxis.rowMetas.delete(doc.rowMeta);
  return {
    revision: doc.revision,
    rowOrder: doc.rowOrder,
    rowMeta: doc.rowMeta,
    columnOrder: [...doc.columnOrder],
    cells: doc.cells.fork(),
    maxSlot: doc.maxSlot,
  };
}

/** 書いてよい rowOrder（共有しうるなら写して差し替える）。 */
export function writableRowOrder(doc: SheetDocument): RowId[] {
  const owned = ownedRowAxis.rowOrders.get(doc.rowOrder);
  if (owned !== undefined) {
    return owned;
  }
  const copy = ownRowOrder([...doc.rowOrder]);
  doc.rowOrder = copy;
  return copy;
}

/** 書いてよい rowMeta（共有しうるなら写して差し替える）。中の RowMeta は差し替えて書く。 */
export function writableRowMeta(doc: SheetDocument): Map<RowId, Readonly<RowMeta>> {
  const owned = ownedRowAxis.rowMetas.get(doc.rowMeta);
  if (owned !== undefined) {
    return owned;
  }
  const copy = ownRowMeta(new Map(doc.rowMeta));
  doc.rowMeta = copy;
  return copy;
}

/** rowMeta 全体の最大 slot（空なら -1）。snapshot 復元時に maxSlot キャッシュを再計算する（DD-021-3）。 */
export function computeMaxSlot(rowMeta: ReadonlyMap<RowId, Readonly<RowMeta>>): number {
  let max = -1;
  for (const meta of rowMeta.values()) {
    if (meta.slot > max) {
      max = meta.slot;
    }
  }
  return max;
}

export function getCell(
  doc: SheetDocument,
  rowId: RowId,
  columnId: ColumnId,
): CellRecord | undefined {
  const slot = slotOf(doc, rowId);
  if (slot === undefined) {
    return undefined; // 未知行
  }
  return doc.cells.get(slot, columnIndexOf(doc, columnId));
}

/**
 * セルを書き込む（doc.cells を破壊的に更新）。行は既存であること（slot 解決可能）が前提。
 * columnId は columnOrder 内であること（PoC は列固定）。前提違反は fail-fast（サイレント破損を防ぐ・CG-2）。
 */
export function setCell(
  doc: SheetDocument,
  rowId: RowId,
  columnId: ColumnId,
  record: CellRecord,
): void {
  const slot = slotOf(doc, rowId);
  if (slot === undefined) {
    throw new Error(`setCell: 未知の行 ${String(rowId)}（slot 未解決）`);
  }
  const colIndex = columnIndexOf(doc, columnId);
  if (colIndex < 0) {
    throw new Error(`setCell: columnOrder 外の列 ${String(columnId)}（PoC は列固定）`);
  }
  doc.cells.set(slot, colIndex, record);
}

/** セルを削除する（存在しなければ no-op）。行/列が未知でも no-op（rollback の前値=空 → 不在化に使う）。 */
export function deleteCell(doc: SheetDocument, rowId: RowId, columnId: ColumnId): void {
  const slot = slotOf(doc, rowId);
  if (slot === undefined) {
    return;
  }
  doc.cells.delete(slot, columnIndexOf(doc, columnId));
}

/** 行のセルを丸ごと除去する（挿入 rollback で行ごと消す経路・rowMeta 削除より前に呼ぶこと）。 */
export function deleteRowCells(doc: SheetDocument, rowId: RowId): void {
  const slot = slotOf(doc, rowId);
  if (slot === undefined) {
    return;
  }
  doc.cells.deleteRow(slot);
}

/** 行内の非空セルを colIndex 昇順で列挙する（columnId を解決して visit・serialize/構造比較用）。 */
export function forEachCellInRow(
  doc: SheetDocument,
  rowId: RowId,
  visit: (columnId: ColumnId, record: CellRecord) => void,
): void {
  const slot = slotOf(doc, rowId);
  if (slot === undefined) {
    return;
  }
  doc.cells.forEachInRow(slot, (colIndex, record) => {
    const columnId = doc.columnOrder[colIndex];
    if (columnId !== undefined) {
      visit(columnId, record);
    }
  });
}

/** rowOrder から tombstone を除いた表示順（hash/描画用）。 */
export function displayRowOrder(doc: SheetDocument): RowId[] {
  const result: RowId[] = [];
  for (const rowId of doc.rowOrder) {
    const meta = doc.rowMeta.get(rowId);
    if (meta !== undefined && !meta.tombstone) {
      result.push(rowId);
    }
  }
  return result;
}

/**
 * afterRowId の rowOrder 上インデックスを返す（null=先頭=-1）。未知IDは undefined。
 * tombstone 行も順序参照点として有効（削除済みアンカーへの InsertRows・S-D2 / protocol-subset §4-2）。
 */
export function resolveAnchorIndex(doc: SheetDocument, afterRowId: RowId | null): number | undefined {
  if (afterRowId === null) {
    return -1;
  }
  const index = doc.rowOrder.indexOf(afterRowId);
  return index === -1 ? undefined : index;
}

export function isTombstoned(doc: SheetDocument, rowId: RowId): boolean {
  return doc.rowMeta.get(rowId)?.tombstone ?? false;
}
