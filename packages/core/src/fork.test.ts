// DD-070-10: 構造共有の複製（CellStore.fork・forkDocument）の隔離と、深い複製の経路との一致。
//
// applyOperation は作業文書を forkDocument で作る（以前は cloneDocument の丸ごとの深い複製）。共有したチャンク・行・
// 行の並び・行の情報に、ある文書への書き込みが漏れて別の文書が変わると、巻き戻し（collab の committed）や
// サーバーの状態が壊れる。ここでは「枝分かれした文書の木」へ無作為に書き、どの文書も深い複製の経路で作った
// 参照と一致し続けることを確かめる。

import { describe, expect, it, vi } from 'vitest';

import { createColumnId, createRowId } from '@nanairo-sheet/types';
import type { ColumnId, RowId } from '@nanairo-sheet/types';

import { applyOperation, replayAcceptedOperations } from './apply';
import { createCellStore } from './cell-store';
import type { CellStore } from './cell-store';
import { cloneDocument, createDocument, forkDocument, getCell, setCell, writableRowMeta, writableRowOrder } from './document';
import type { CellRecord, SheetDocument } from './document';
import { deserializeDocument, serializeDocument } from './document-snapshot';
import type { CellScalar, DocumentOperation } from './operations';

/** 決定論の擬似乱数（mulberry32）。 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const rec = (value: string, revision: number): CellRecord => ({ value: { kind: 'string', value }, lastChangedRevision: revision });

const SLOTS = 40;
const COLS = 6;
const CHUNK_ROWS = 4;

/** 論理の中身と件数（blank のレコードも含む）。approxMemoryBytes は空のチャンクの残り方で深い複製と違いうるので別に見る。 */
function storeContents(store: CellStore): string {
  const out: string[] = [];
  for (let slot = 0; slot < SLOTS; slot += 1) {
    store.forEachInRow(slot, (colIndex, record) => {
      out.push(`${slot}:${colIndex}=${JSON.stringify(record)}`);
    });
  }
  return `${store.nonEmptyCount()}|${out.join(',')}`;
}

/**
 * 文字数の計上が中身と合っている: approxMemoryBytes から件数と文字数の分を引いた残りが、チャンクの分（1 チャンク
 * chunkRows × 8 バイト）の 0 以上の倍数で、チャンクの数の上限以下（係数は cell-store.ts の BYTES_PER_*）。
 */
function expectCharAccounting(store: CellStore, chunkRows: number): void {
  let chars = 0;
  for (let slot = 0; slot < SLOTS; slot += 1) {
    store.forEachInRow(slot, (_colIndex, record) => {
      if (record.value.kind === 'string' || record.value.kind === 'date') {
        chars += record.value.value.length;
      }
    });
  }
  const residual = store.approxMemoryBytes() - store.nonEmptyCount() * (8 + 8 + 32) - chars * 2;
  expect(residual).toBeGreaterThanOrEqual(0);
  expect(residual % (chunkRows * 8)).toBe(0);
  expect(residual).toBeLessThanOrEqual(Math.ceil(SLOTS / chunkRows) * chunkRows * 8);
}

describe('DD-070-10: CellStore.fork', () => {
  it('fork の後、どちらに書いても（set・delete・deleteRow）もう片方は変わらない', () => {
    const base = createCellStore({ chunkRows: 4 });
    base.set(0, 0, rec('a', 1));
    base.set(1, 2, rec('b', 1));
    base.set(5, 1, rec('c', 1));
    const before = storeContents(base);
    const forked = base.fork();
    expect(storeContents(forked)).toBe(before);

    forked.set(0, 0, rec('A', 2));
    forked.set(0, 3, rec('new', 2));
    forked.delete(1, 2);
    forked.deleteRow(5);
    forked.set(9, 0, rec('far', 2));
    expect(storeContents(base)).toBe(before);

    const forkedAfter = storeContents(forked);
    base.set(0, 0, rec('base-side', 3));
    base.deleteRow(1);
    expect(storeContents(forked)).toBe(forkedAfter);
  });

  it('レコードは共有する（get の結果が同じオブジェクト）＝その場で書き換えない約束の前提', () => {
    const base = createCellStore();
    base.set(0, 0, rec('a', 1));
    const forked = base.fork();
    expect(forked.get(0, 0)).toBe(base.get(0, 0));
  });

  it('無いセルの delete・無い行の deleteRow は何も写さず何も変えない', () => {
    const base = createCellStore({ chunkRows: 4 });
    base.set(0, 0, rec('a', 1));
    const forked = base.fork();
    forked.delete(0, 5);
    forked.delete(3, 0);
    forked.deleteRow(7);
    expect(storeContents(forked)).toBe(storeContents(base));
  });

  for (const seed of [1, 7, 42, 2026]) {
    it(`無作為な fork の木（seed=${seed}）: どのストアも深い複製の参照と一致し続ける`, () => {
      const rand = prng(seed);
      const stores: Array<{ store: CellStore; ref: CellStore }> = [
        { store: createCellStore({ chunkRows: CHUNK_ROWS }), ref: createCellStore({ chunkRows: CHUNK_ROWS }) },
      ];
      for (let step = 0; step < 2_000; step += 1) {
        const entry = pick(rand, stores);
        const r = rand();
        const slot = Math.floor(rand() * SLOTS);
        const colIndex = Math.floor(rand() * COLS);
        if (r < 0.1 && stores.length < 30) {
          stores.push({ store: entry.store.fork(), ref: entry.ref.clone() });
        } else if (r < 0.65) {
          const value = `v${step}-${'x'.repeat(step % 5)}`;
          entry.store.set(slot, colIndex, rec(value, step));
          entry.ref.set(slot, colIndex, rec(value, step));
        } else if (r < 0.9) {
          entry.store.delete(slot, colIndex);
          entry.ref.delete(slot, colIndex);
        } else {
          entry.store.deleteRow(slot);
          entry.ref.deleteRow(slot);
        }
        // 毎回すべてのストアを照合する（漏れが後の上書きで消える前に見つける）。
        for (const { store, ref } of stores) {
          expect(storeContents(store)).toBe(storeContents(ref));
        }
      }
      expect(stores.length).toBeGreaterThan(5);
      for (const { store } of stores) {
        expectCharAccounting(store, CHUNK_ROWS);
      }
    });
  }
});

// ---- 文書 ----

const columns: ColumnId[] = ['c0', 'c1', 'c2', 'c3'].map((c) => createColumnId(c));

/**
 * 比べるための文書の中身。保存の形（serializeDocument: blank のレコード・削除した行のセル・行の情報まで全部）と、
 * slot・maxSlot（正準形の hash には入らない）。
 */
function docContents(doc: SheetDocument): string {
  const slots = [...doc.rowMeta.values()].map((m) => `${String(m.id)}:${m.slot}`);
  return JSON.stringify([serializeDocument(doc), slots, doc.maxSlot]);
}

/** 深い複製の経路（以前の applyOperation と同じ: 丸ごと複製して in-place で適用）。 */
function applyByDeepClone(doc: SheetDocument, op: DocumentOperation, revision: number): SheetDocument {
  return replayAcceptedOperations(cloneDocument(doc), [{ operation: op, revision }]);
}

function randomOperation(rand: () => number, doc: SheetDocument, nextId: () => RowId): DocumentOperation {
  const live = doc.rowOrder.filter((id) => doc.rowMeta.get(id)?.tombstone === false);
  const r = rand();
  if (live.length === 0 || r < 0.25) {
    const anchor = doc.rowOrder.length === 0 || rand() < 0.2 ? null : pick(rand, doc.rowOrder);
    const count = 1 + Math.floor(rand() * 3);
    return { type: 'insertRows', afterRowId: anchor, rows: Array.from({ length: count }, () => ({ rowId: nextId() })) };
  }
  if (r < 0.4) {
    const ids = Array.from({ length: 1 + Math.floor(rand() * 2) }, () => pick(rand, doc.rowOrder));
    return { type: 'deleteRows', rowIds: ids };
  }
  const changes = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => {
    const value: CellScalar = rand() < 0.2 ? { kind: 'blank' } : { kind: 'string', value: `s${Math.floor(rand() * 1000)}` };
    return { rowId: pick(rand, live), columnId: pick(rand, columns), value };
  });
  return { type: 'setCells', conflictPolicy: 'reject-overlap', changes };
}

describe('DD-070-10: forkDocument と applyOperation の入力の不変', () => {
  it('forkDocument のどちらを書いても（約束どおりの書き方で）もう片方は変わらない', () => {
    let base = createDocument(columns);
    base = applyOperation(base, { type: 'insertRows', afterRowId: null, rows: [{ rowId: createRowId('r1') }, { rowId: createRowId('r2') }] }, { revision: 1 }).document;
    setCell(base, createRowId('r1'), columns[0]!, rec('x', 1));
    const before = docContents(base);
    const forked = forkDocument(base);

    writableRowOrder(forked).push(createRowId('r3'));
    writableRowMeta(forked).set(createRowId('r3'), { id: createRowId('r3'), slot: 9, tombstone: false, lastChangedRevision: 5 });
    writableRowMeta(forked).set(createRowId('r1'), { ...forked.rowMeta.get(createRowId('r1'))!, tombstone: true });
    setCell(forked, createRowId('r1'), columns[0]!, rec('changed', 5));
    forked.revision = 5;
    expect(docContents(base)).toBe(before);

    const forkedAfter = docContents(forked);
    writableRowOrder(base).reverse();
    setCell(base, createRowId('r2'), columns[1]!, rec('base-side', 6));
    expect(docContents(forked)).toBe(forkedAfter);
  });

  it('setCells・insertRows・deleteRows のどれでも入力の文書は変わらない', () => {
    let doc = createDocument(columns);
    doc = applyOperation(doc, { type: 'insertRows', afterRowId: null, rows: [{ rowId: createRowId('a') }, { rowId: createRowId('b') }] }, { revision: 1 }).document;
    doc = applyOperation(doc, { type: 'setCells', conflictPolicy: 'reject-overlap', changes: [{ rowId: createRowId('a'), columnId: columns[0]!, value: { kind: 'number', value: 1 } }] }, { revision: 2 }).document;
    const before = docContents(doc);
    const ops: DocumentOperation[] = [
      { type: 'setCells', conflictPolicy: 'reject-overlap', changes: [{ rowId: createRowId('a'), columnId: columns[0]!, value: { kind: 'number', value: 2 } }] },
      { type: 'insertRows', afterRowId: createRowId('a'), rows: [{ rowId: createRowId('c') }] },
      { type: 'deleteRows', rowIds: [createRowId('a')] },
    ];
    for (const op of ops) {
      const result = applyOperation(doc, op, { revision: 3 });
      expect(docContents(result.document)).toBe(docContents(applyByDeepClone(doc, op, 3)));
      expect(docContents(doc)).toBe(before);
    }
    expect(getCell(doc, createRowId('a'), columns[0]!)?.value).toEqual({ kind: 'number', value: 1 });
  });

  for (const seed of [3, 11, 99, 20261120]) {
    it(`無作為な文書の木（seed=${seed}）: どの文書も深い複製の経路と一致し続ける（replay の in-place も混ぜる）`, () => {
      const rand = prng(seed);
      let idCounter = 0;
      const nextId = (): RowId => createRowId(`row-${idCounter++}`);
      const docs: Array<{ doc: SheetDocument; ref: SheetDocument }> = [
        { doc: createDocument(columns), ref: createDocument(columns) },
      ];
      for (let step = 1; step <= 600; step += 1) {
        const entry = pick(rand, docs);
        const op = randomOperation(rand, entry.doc, nextId);
        const r = rand();
        if (r < 0.15) {
          // 枝の先へ in-place で replay（その文書は自分のもの。共有している他の文書へ漏れてはいけない）。
          entry.doc = replayAcceptedOperations(entry.doc, [{ operation: op, revision: step }]);
          entry.ref = replayAcceptedOperations(entry.ref, [{ operation: op, revision: step }]);
        } else if (r < 0.55 && docs.length < 40) {
          docs.push({ doc: applyOperation(entry.doc, op, { revision: step }).document, ref: applyByDeepClone(entry.ref, op, step) });
        } else {
          entry.doc = applyOperation(entry.doc, op, { revision: step }).document;
          entry.ref = applyByDeepClone(entry.ref, op, step);
        }
        // 毎回すべての文書を照合する（漏れが後の上書きで消える前に見つける）。
        for (const { doc, ref } of docs) {
          expect(docContents(doc)).toBe(docContents(ref));
        }
      }
      expect(docs.length).toBeGreaterThan(10);
    });
  }
});

describe('DD-070-10: 共有の境界（Codex の指摘）', () => {
  it('スナップショットの値を書き換えても文書は変わらない（serializeDocument・deserializeDocument が値を写す）', () => {
    let doc = createDocument(columns);
    doc = applyOperation(doc, { type: 'insertRows', afterRowId: null, rows: [{ rowId: createRowId('a') }] }, { revision: 1 }).document;
    doc = applyOperation(doc, { type: 'setCells', conflictPolicy: 'reject-overlap', changes: [{ rowId: createRowId('a'), columnId: columns[0]!, value: { kind: 'string', value: 'x' } }] }, { revision: 2 }).document;
    const snapshot = serializeDocument(doc);
    const next = applyOperation(doc, { type: 'setCells', conflictPolicy: 'reject-overlap', changes: [{ rowId: createRowId('a'), columnId: columns[1]!, value: { kind: 'string', value: 'y' } }] }, { revision: 3 }).document;
    // 型は読み取り専用だが、スナップショットは外へ渡す JSON の形なので、書き換えられても文書が変わらないことを見る。
    Object.assign(snapshot.cells[0]!.columns[0]!.value, { value: 'MUTATED' });
    expect(getCell(doc, createRowId('a'), columns[0]!)?.value).toEqual({ kind: 'string', value: 'x' });
    expect(getCell(next, createRowId('a'), columns[0]!)?.value).toEqual({ kind: 'string', value: 'x' });

    const restored = deserializeDocument(serializeDocument(next));
    const wire = serializeDocument(next);
    const fromWire = deserializeDocument(wire);
    Object.assign(wire.cells[0]!.columns[0]!.value, { value: 'MUTATED' });
    expect(getCell(fromWire, createRowId('a'), columns[0]!)?.value).toEqual({ kind: 'string', value: 'x' });
    expect(docContents(restored)).toBe(docContents(fromWire));
  });

  it('core のモジュールが二重に読み込まれても、片方の適用の結果をもう片方が in-place で replay して元の文書を壊さない', async () => {
    vi.resetModules();
    const other = await import('./apply');
    const otherDocument = await import('./document');
    const insert = (id: string, after: string | null): DocumentOperation => ({ type: 'insertRows', afterRowId: after === null ? null : createRowId(after), rows: [{ rowId: createRowId(id) }] });
    const setX: DocumentOperation = { type: 'setCells', conflictPolicy: 'reject-overlap', changes: [{ rowId: createRowId('a'), columnId: columns[0]!, value: { kind: 'string', value: 'x' } }] };
    expect(other.applyOperation).not.toBe(applyOperation); // 別のモジュールの写しになっている

    // こちらで作った文書を向こうが fork（適用）し、こちらが元の文書を in-place で replay する（記録がモジュールごとだと、
    // こちらの記録は「書いてよい」のままなので、向こうの結果の行の並びまで変わる）
    const mine = applyOperation(createDocument(columns), insert('a', null), { revision: 1 }).document;
    replayAcceptedOperations(mine, [{ operation: insert('m', 'a'), revision: 2 }]); // 自分の入れ物にしておく
    const theirs = other.applyOperation(mine, setX, { revision: 3 }).document;
    const theirsBefore = docContents(theirs);
    replayAcceptedOperations(mine, [{ operation: insert('n', 'a'), revision: 4 }]);
    expect(docContents(theirs)).toBe(theirsBefore);

    // こちらで作って適用 → もう片方で replay
    const base = applyOperation(createDocument(columns), insert('a', null), { revision: 1 }).document;
    const before = docContents(base);
    const forked = applyOperation(base, setX, { revision: 2 }).document;
    other.replayAcceptedOperations(forked, [{ operation: insert('b', 'a'), revision: 3 }]);
    expect(docContents(base)).toBe(before);

    // もう片方で作って適用 → こちらで replay
    const otherBase = other.applyOperation(otherDocument.createDocument(columns), insert('a', null), { revision: 1 }).document;
    const otherBefore = docContents(otherBase);
    const otherForked = other.applyOperation(otherBase, setX, { revision: 2 }).document;
    replayAcceptedOperations(otherForked, [{ operation: insert('b', 'a'), revision: 3 }]);
    expect(docContents(otherBase)).toBe(otherBefore);
    // 元の文書を in-place で replay しても、fork の結果は変わらない
    const forkedBefore = docContents(otherForked);
    replayAcceptedOperations(otherBase, [{ operation: insert('c', null), revision: 4 }]);
    expect(docContents(otherForked)).toBe(forkedBefore);
  });
});

describe('DD-070-10: 1 回の適用の費用が表の大きさに比例しない（緩い時間ガード）', () => {
  it('50,000 行 × 20 列（100 万セル）で 1 セルの setCells・1 行の挿入・削除が各 20ms 未満（中央値）', () => {
    const wide = Array.from({ length: 20 }, (_, i) => createColumnId(`w${i}`));
    const rowIds = Array.from({ length: 50_000 }, (_, i) => createRowId(`big-${i}`));
    let doc = replayAcceptedOperations(createDocument(wide), [
      { operation: { type: 'insertRows', afterRowId: null, rows: rowIds.map((rowId) => ({ rowId })) }, revision: 1 },
      {
        operation: {
          type: 'setCells',
          conflictPolicy: 'reject-overlap',
          changes: rowIds.flatMap((rowId, r) => wide.map((columnId, c) => ({ rowId, columnId, value: { kind: 'string' as const, value: `${r}-${c}` } }))),
        },
        revision: 2,
      },
    ]);
    expect(doc.cells.nonEmptyCount()).toBe(1_000_000);

    const median = (samples: number[]): number => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
    const time = (run: (i: number) => void): number => {
      const samples: number[] = [];
      for (let i = 0; i < 15; i += 1) {
        const t0 = performance.now();
        run(i);
        samples.push(performance.now() - t0);
      }
      return median(samples);
    };
    let revision = 3;
    const setMs = time((i) => {
      doc = applyOperation(doc, { type: 'setCells', conflictPolicy: 'reject-overlap', changes: [{ rowId: rowIds[i * 3000]!, columnId: wide[i]!, value: { kind: 'string', value: `edit-${i}` } }] }, { revision: revision++ }).document;
    });
    const insertMs = time((i) => {
      doc = applyOperation(doc, { type: 'insertRows', afterRowId: rowIds[i * 3000]!, rows: [{ rowId: createRowId(`ins-${i}`) }] }, { revision: revision++ }).document;
    });
    const deleteMs = time((i) => {
      doc = applyOperation(doc, { type: 'deleteRows', rowIds: [rowIds[i * 3000 + 1]!] }, { revision: revision++ }).document;
    });
    console.log(`[DD-070-10] 100 万セルで setCells ${setMs.toFixed(2)}ms・insertRows ${insertMs.toFixed(2)}ms・deleteRows ${deleteMs.toFixed(2)}ms（中央値）`);
    expect(setMs).toBeLessThan(20);
    expect(insertMs).toBeLessThan(20);
    expect(deleteMs).toBeLessThan(20);
  }, 60_000);
});
