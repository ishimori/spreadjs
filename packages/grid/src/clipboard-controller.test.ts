// clipboard-controller のユニットテスト（DD-020-2 Phase 2）。
// paste フロー（敷き詰め・はみ出し全体拒否・上限・jagged skip・型変換・beforeRevision）／copy/cut 直列化／
// 位相裁定を DOM なしで機械検証する。シナリオ正本: doc/DD/DD-020-2/scenarios.md §3〜§6。

import { describe, expect, it } from 'vitest';

import {
  SETCELLS_MAX_CELLS,
  applyOperation,
  createDocument,
  displayRowOrder,
  getCell,
  validateOperation,
} from '@nanairo-sheet/core';
import type { DocumentOperation, SheetDocument } from '@nanairo-sheet/core';
import { createColumnId, createRowId } from '@nanairo-sheet/types';
import type { CellRange } from '@nanairo-sheet/selection';

import { cellScalarToDisplay } from './document-view';
import {
  buildPaste,
  serializeSelectionToTsv,
  shouldInterceptClipboard,
  type ClipboardDocumentPort,
} from './clipboard-controller';

const COLS = ['c0', 'c1', 'c2', 'c3', 'c4'].map((c) => createColumnId(c));
const ROWS = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'].map((r) => createRowId(r));

function buildDoc(ops: DocumentOperation[]): SheetDocument {
  let doc = createDocument(COLS);
  let revision = 0;
  for (const op of ops) {
    revision += 1;
    doc = applyOperation(doc, op, { revision }).document;
  }
  return doc;
}

const INSERT_ROWS: DocumentOperation = {
  type: 'insertRows',
  afterRowId: null,
  rows: ROWS.map((rowId) => ({ rowId })),
};

const set = (row: number, col: number, value: string): DocumentOperation => ({
  type: 'setCells',
  conflictPolicy: 'reject-overlap',
  changes: [{ rowId: ROWS[row]!, columnId: COLS[col]!, value: { kind: 'string', value } }],
});

/** 8 行 × 5 列の committed 文書（rowCount=8・colCount=5）。 */
function clipPortOf(doc: SheetDocument): ClipboardDocumentPort {
  return {
    getCommittedDocument: () => doc,
    displayText: (rowId, columnId) =>
      cellScalarToDisplay(getCell(doc, rowId, columnId)?.value ?? { kind: 'blank' }),
    rowIdAt: (i) => displayRowOrder(doc)[i],
    colIdAt: (i) => doc.columnOrder[i],
    rowCount: () => displayRowOrder(doc).length,
    colCount: () => doc.columnOrder.length,
  };
}

/** rowStart/rowEnd/colStart/colEnd の半開区間レンジ。 */
function range(rowStart: number, rowEnd: number, colStart: number, colEnd: number): CellRange {
  return { rowStart, rowEnd, colStart, colEnd };
}

// ---- §6. 位相裁定（AC10） --------------------------------------------------------------------

describe('shouldInterceptClipboard: Navigation かつ非 composing のみ true', () => {
  it('Navigation・非 composing → intercept（グリッド copy/cut/paste）', () => {
    expect(shouldInterceptClipboard('Navigation', false)).toBe(true);
  });
  it('Navigation でも composing 中 → none（IME 経路・I-3）', () => {
    expect(shouldInterceptClipboard('Navigation', true)).toBe(false);
  });
  it('編集中・Composing 位相は none（textarea 既定へ委譲）', () => {
    for (const phase of ['EditingReplace', 'EditingExisting', 'EditingAwaitFinalInput', 'Composing'] as const) {
      expect(shouldInterceptClipboard(phase, false), phase).toBe(false);
    }
  });
});

// ---- §5. copy/cut 直列化 ---------------------------------------------------------------------

describe('serializeSelectionToTsv: 選択範囲の表示文字列を TSV 化（copy・CP-1/CP-2）', () => {
  it('CP-1: 範囲 (0,0)〜(1,1) を TSV へ（タブ/改行含みは引用）', () => {
    const doc = buildDoc([INSERT_ROWS, set(0, 0, 'A'), set(0, 1, 'B'), set(1, 0, 'C'), set(1, 1, 'tab\there')]);
    const tsv = serializeSelectionToTsv(clipPortOf(doc), range(0, 2, 0, 2));
    expect(tsv).toBe('A\tB\r\nC\t"tab\there"');
  });

  it('CP-2: 単一セル (0,1) を 1×1 TSV へ（未選択時＝活性セル）', () => {
    const doc = buildDoc([INSERT_ROWS, set(0, 1, 'solo')]);
    expect(serializeSelectionToTsv(clipPortOf(doc), range(0, 1, 1, 2))).toBe('solo');
  });

  it('空セルを含む範囲は空文字列セルとして直列化する', () => {
    const doc = buildDoc([INSERT_ROWS, set(0, 0, 'A')]); // (0,1) は空
    expect(serializeSelectionToTsv(clipPortOf(doc), range(0, 1, 0, 2))).toBe('A\t');
  });
});

// ---- §4. paste フロー（C-1〜C-10） -----------------------------------------------------------

describe('buildPaste: アンカー貼り付け・敷き詰め・はみ出し・上限・jagged・型変換', () => {
  it('C-1: 単一セル選択 (2,2) → 2×2 matrix を左上アンカーから貼り付け（4 changes・型変換）', () => {
    const doc = buildDoc([INSERT_ROWS]);
    const outcome = buildPaste(clipPortOf(doc), [
      ['x', 'y'],
      ['z', 'w'],
    ], range(2, 3, 2, 3));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    expect(outcome.cellCount).toBe(4);
    expect(outcome.operation.conflictPolicy).toBe('reject-overlap');
    expect(outcome.operation.changes.map((c) => [String(c.rowId), String(c.columnId)])).toEqual([
      ['r2', 'c2'],
      ['r2', 'c3'],
      ['r3', 'c2'],
      ['r3', 'c3'],
    ]);
  });

  it('C-2: 1×1 matrix ×複数セル選択 (1,1)〜(3,3) → 選択範囲 9 セルへ敷き詰め（AC7）', () => {
    const doc = buildDoc([INSERT_ROWS]);
    const outcome = buildPaste(clipPortOf(doc), [['v']], range(1, 4, 1, 4));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    expect(outcome.cellCount).toBe(9);
    expect(outcome.operation.changes).toHaveLength(9);
    // 全セルへ同一値 v（string）。
    for (const change of outcome.operation.changes) {
      expect(change.value).toEqual({ kind: 'string', value: 'v' });
    }
  });

  it('C-3: 1×1 matrix ×単一セル選択 → 敷き詰めせず 1 セルのみ', () => {
    const doc = buildDoc([INSERT_ROWS]);
    const outcome = buildPaste(clipPortOf(doc), [['v']], range(0, 1, 0, 1));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    expect(outcome.operation.changes).toHaveLength(1);
  });

  it('C-4: 下端はみ出し（(7,0) から 2×1）→ 全体拒否（out-of-bounds・submit なし）', () => {
    const doc = buildDoc([INSERT_ROWS]); // rowCount=8（index 0..7）
    const outcome = buildPaste(clipPortOf(doc), [['a'], ['b']], range(7, 8, 0, 1));
    expect(outcome.kind).toBe('out-of-bounds');
  });

  it('C-5: 右端はみ出し（(0,4) から 1×2）→ 全体拒否', () => {
    const doc = buildDoc([INSERT_ROWS]); // colCount=5（index 0..4）
    const outcome = buildPaste(clipPortOf(doc), [['a', 'b']], range(0, 1, 4, 5));
    expect(outcome.kind).toBe('out-of-bounds');
  });

  it('C-6: 上限超過（100,001 セル）→ 実行前拒否（too-large・走査なし・submit なし）', () => {
    // rowCount/colCount を読む前に too-large で返す（面積判定が先）。port は最小。
    const port: ClipboardDocumentPort = {
      getCommittedDocument: () => {
        throw new Error('上限超過で committed を読んではならない');
      },
      displayText: () => '',
      rowIdAt: () => {
        throw new Error('上限超過で走査してはならない');
      },
      colIdAt: () => undefined,
      rowCount: () => {
        throw new Error('上限超過で bounds を読んではならない');
      },
      colCount: () => 1,
    };
    const matrix = Array.from({ length: 100_001 }, () => ['a']);
    const outcome = buildPaste(port, matrix, range(0, 1, 0, 1));
    expect(outcome).toEqual({ kind: 'too-large', cellCount: 100_001, limit: SETCELLS_MAX_CELLS });
  });

  it('C-7: jagged matrix の欠けセルは skip（決定(d)・空文字上書きしない）', () => {
    const doc = buildDoc([INSERT_ROWS]);
    // (3,1)=a (3,2)=b / (4,1)=c (4,2)=欠け（行 1 は 1 列のみ）。
    const outcome = buildPaste(clipPortOf(doc), [['a', 'b'], ['c']], range(3, 4, 1, 2));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    expect(outcome.cellCount).toBe(4); // 上限判定は bounding box（2×2）
    expect(outcome.operation.changes.map((c) => [String(c.rowId), String(c.columnId), c.value])).toEqual([
      ['r3', 'c1', { kind: 'string', value: 'a' }],
      ['r3', 'c2', { kind: 'string', value: 'b' }],
      ['r4', 'c1', { kind: 'string', value: 'c' }],
      // (r4,c2) は欠け → 含まれない
    ]);
  });

  it('C-8: present な空セルは blank 上書き（欠けセルと区別＝skip しない）', () => {
    const doc = buildDoc([INSERT_ROWS, set(3, 3, '既存')]);
    const outcome = buildPaste(clipPortOf(doc), [['', 'x']], range(3, 4, 3, 4));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    expect(outcome.operation.changes).toEqual([
      { rowId: ROWS[3], columnId: COLS[3], beforeRevision: 2, value: { kind: 'blank' } },
      { rowId: ROWS[3], columnId: COLS[4], beforeRevision: 0, value: { kind: 'string', value: 'x' } },
    ]);
  });

  it('C-9: 空 matrix は noop（submit なし）', () => {
    const doc = buildDoc([INSERT_ROWS]);
    expect(buildPaste(clipPortOf(doc), [], range(2, 3, 2, 3))).toEqual({ kind: 'noop' });
  });

  it('C-10: 型混在（number/date/string）を parseCellInput で正しく変換', () => {
    const doc = buildDoc([INSERT_ROWS]);
    const outcome = buildPaste(clipPortOf(doc), [['123', '2026-07-16', '090-1234-5678']], range(0, 1, 0, 1));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    expect(outcome.operation.changes.map((c) => c.value)).toEqual([
      { kind: 'number', value: 123 },
      { kind: 'date', value: '2026-07-16' },
      { kind: 'string', value: '090-1234-5678' }, // 電話番号は偽陽性防止で string
    ]);
  });

  it('beforeRevision は実行時点の committed lastChangedRevision（未書込=0）', () => {
    const doc = buildDoc([INSERT_ROWS, set(2, 2, 'old')]); // (2,2) は rev2
    const outcome = buildPaste(clipPortOf(doc), [['new', 'fresh']], range(2, 3, 2, 3));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    expect(outcome.operation.changes).toEqual([
      { rowId: ROWS[2], columnId: COLS[2], beforeRevision: 2, value: { kind: 'string', value: 'new' } },
      { rowId: ROWS[2], columnId: COLS[3], beforeRevision: 0, value: { kind: 'string', value: 'fresh' } },
    ]);
  });

  it('敷き詰めの単一値も parseCellInput で変換される（数値の敷き詰め）', () => {
    const doc = buildDoc([INSERT_ROWS]);
    const outcome = buildPaste(clipPortOf(doc), [['42']], range(0, 2, 0, 2));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    expect(outcome.operation.changes).toHaveLength(4);
    for (const change of outcome.operation.changes) {
      expect(change.value).toEqual({ kind: 'number', value: 42 });
    }
  });
});

// ---- 貼り付け矩形（DD-038・貼り付け後の選択レンジの根拠） --------------------------------------
//
// rect は「書いたセルの集合」ではなく「どこへ貼ろうとしたか」の矩形（DD-038 決定②③）。jagged の欠けセルも
// 含み、readOnly スキップ（mount-controller の後段）にも影響されない。呼び出し側はこれを選択レンジにする。

describe('buildPaste: 貼り付け矩形 rect（DD-038）', () => {
  it('R-1: 単一セル選択 (2,2) → 2×2 matrix の rect は左上アンカー(2,2)・2×2', () => {
    const doc = buildDoc([INSERT_ROWS]);
    const outcome = buildPaste(clipPortOf(doc), [
      ['x', 'y'],
      ['z', 'w'],
    ], range(2, 3, 2, 3));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    expect(outcome.rect).toEqual({ anchorRow: 2, anchorCol: 2, targetRows: 2, targetCols: 2 });
  });

  it('R-2: 敷き詰め（1×1 matrix ×選択(1,1)〜(3,3)）→ rect は選択範囲そのもの（3×3・AC5）', () => {
    const doc = buildDoc([INSERT_ROWS]);
    const outcome = buildPaste(clipPortOf(doc), [['v']], range(1, 4, 1, 4));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    expect(outcome.rect).toEqual({ anchorRow: 1, anchorCol: 1, targetRows: 3, targetCols: 3 });
  });

  it('R-3: 1×1 貼り付けの rect は 1×1（呼び出し側で単一選択へ正規化される・AC3）', () => {
    const doc = buildDoc([INSERT_ROWS]);
    const outcome = buildPaste(clipPortOf(doc), [['v']], range(0, 1, 0, 1));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    expect(outcome.rect).toEqual({ anchorRow: 0, anchorCol: 0, targetRows: 1, targetCols: 1 });
  });

  it('R-4: jagged（2行目が短い）でも rect は bounding box＝最大列数（欠けセルは書かないが矩形には含む・AC9）', () => {
    const doc = buildDoc([INSERT_ROWS]);
    const outcome = buildPaste(clipPortOf(doc), [['a', 'b'], ['c']], range(3, 4, 1, 2));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    // 書かれるのは 3 セル（(3,1)(3,2)(4,1)）だが、矩形は 2×2。
    expect(outcome.operation.changes).toHaveLength(3);
    expect(outcome.rect).toEqual({ anchorRow: 3, anchorCol: 1, targetRows: 2, targetCols: 2 });
  });

  it('R-5: 右下から左上へドラッグした選択でも rect のアンカーは矩形の左上（activeCell 側ではない）', () => {
    const doc = buildDoc([INSERT_ROWS]);
    // range は正規化済み（rowStart<rowEnd）で渡る。左上 (1,1)・activeCell は呼び出し側では (3,3) でありうる。
    const outcome = buildPaste(clipPortOf(doc), [['v']], range(1, 4, 1, 4));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    expect(outcome.rect.anchorRow).toBe(1);
    expect(outcome.rect.anchorCol).toBe(1);
  });

  it('R-6: rect は表示 Axis 内に収まる（out-of-bounds が先に全体拒否するため・クランプ不要の根拠）', () => {
    const doc = buildDoc([INSERT_ROWS]); // rowCount=8 / colCount=5
    const outcome = buildPaste(clipPortOf(doc), [['a', 'b'], ['c', 'd']], range(6, 7, 3, 4));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    const { anchorRow, anchorCol, targetRows, targetCols } = outcome.rect;
    expect(anchorRow + targetRows).toBeLessThanOrEqual(8);
    expect(anchorCol + targetCols).toBeLessThanOrEqual(5);
  });
});

// ---- 原子性・OCC（AC5・生成物がサーバー検証と整合すること） ------------------------------------

describe('buildPaste: 原子性と OCC（生成 SetCells がサーバー検証と整合）', () => {
  it('生成 SetCells は 1 revision で全セル適用（部分適用なし）', () => {
    const doc = buildDoc([INSERT_ROWS]);
    const outcome = buildPaste(clipPortOf(doc), [['p', 'q'], ['r', 's']], range(0, 1, 0, 1));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    const applied = applyOperation(doc, outcome.operation, { revision: 2 }).document;
    expect(cellScalarToDisplay(getCell(applied, ROWS[0]!, COLS[0]!)?.value ?? { kind: 'blank' })).toBe('p');
    expect(cellScalarToDisplay(getCell(applied, ROWS[1]!, COLS[1]!)?.value ?? { kind: 'blank' })).toBe('s');
    expect(getCell(applied, ROWS[0]!, COLS[0]!)?.lastChangedRevision).toBe(2);
    expect(getCell(applied, ROWS[1]!, COLS[1]!)?.lastChangedRevision).toBe(2);
  });

  it('OCC: paste 後に範囲内 1 セルが先行変更されたら stale-cell-revision（サーバーは全体 reject＝I-5・AC5）', () => {
    // 他クライアント先行変更のシミュレーション（operation レベル OCC。transport レベル 2 クライアント収束は E2E で検証）。
    const doc = buildDoc([INSERT_ROWS, set(0, 0, 'seed')]); // (0,0)=rev2
    const outcome = buildPaste(clipPortOf(doc), [['p', 'q'], ['r', 's']], range(0, 1, 0, 1));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    // 別クライアントが (0,0) を先に確定（revision 3）→ paste の beforeRevision(2) が stale になる。
    const advanced = applyOperation(
      doc,
      {
        type: 'setCells',
        conflictPolicy: 'reject-overlap',
        changes: [{ rowId: ROWS[0]!, columnId: COLS[0]!, value: { kind: 'string', value: '他者' } }],
      },
      { revision: 3 },
    ).document;
    const violations = validateOperation(advanced, outcome.operation);
    // (0,0) が stale（他 3 セルは valid）。1 件でも違反があれば Room は SetCells 全体を reject する（部分適用なし）。
    expect(violations).toEqual([
      {
        code: 'stale-cell-revision',
        rowId: ROWS[0],
        columnId: COLS[0],
        currentValue: { kind: 'string', value: '他者' },
        currentRevision: 3,
      },
    ]);
  });

  it('OCC: 範囲外セルを他者が変更しても paste は競合しない（セル単位 beforeRevision）', () => {
    const doc = buildDoc([INSERT_ROWS]);
    const outcome = buildPaste(clipPortOf(doc), [['p', 'q']], range(0, 1, 0, 1)); // (0,0)(0,1)
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    // 範囲外 (5,4) を他者が変更 → paste 対象セルの beforeRevision には影響しない。
    const advanced = applyOperation(doc, set(5, 4, '無関係'), { revision: 2 }).document;
    expect(validateOperation(advanced, outcome.operation)).toEqual([]); // 競合なし=受理
  });
});
