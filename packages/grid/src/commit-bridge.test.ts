import { describe, expect, it } from 'vitest';

import { applyOperation, createDocument, getCell, validateOperation } from '@nanairo-sheet/core';
import type { DocumentOperation, SheetDocument } from '@nanairo-sheet/core';
import { col, insertRows, num, row, setCells, str } from '@nanairo-sheet/collab/test-support';

import {
  captureEditStartRevision,
  draftToScalar,
  isEditTargetStale,
  isRowLive,
  isTargetLive,
  resolveCommit,
  type EditTarget,
} from './commit-bridge';

const COLS = [col('col-0'), col('col-1'), col('col-2')];

/** Operation を順に適用して committed を進める（server 付与 revision を模す）。 */
function build(ops: DocumentOperation[]): SheetDocument {
  let doc = createDocument(COLS);
  let revision = 0;
  for (const op of ops) {
    revision += 1;
    doc = applyOperation(doc, op, { revision }).document;
  }
  return doc;
}

describe('draftToScalar（ドラフト→CellScalar）', () => {
  it('空文字は blank', () => {
    expect(draftToScalar('')).toEqual({ kind: 'blank' });
  });
  it('数値文字列は number', () => {
    expect(draftToScalar('42')).toEqual({ kind: 'number', value: 42 });
    expect(draftToScalar('-3.5')).toEqual({ kind: 'number', value: -3.5 });
  });
  it('その他は string（日本語含む）', () => {
    expect(draftToScalar('漢字')).toEqual({ kind: 'string', value: '漢字' });
    expect(draftToScalar('12a')).toEqual({ kind: 'string', value: '12a' });
  });
  it('標準セット（core parseCellInput 委譲）: 全角/桁区切り→number・西暦→date・電話番号→string', () => {
    expect(draftToScalar('１２３')).toEqual({ kind: 'number', value: 123 });
    expect(draftToScalar('1,234.5')).toEqual({ kind: 'number', value: 1234.5 });
    expect(draftToScalar('2026-07-13')).toEqual({ kind: 'date', value: '2026-07-13' });
    expect(draftToScalar('2026/7/3')).toEqual({ kind: 'date', value: '2026-07-03' });
    expect(draftToScalar('090-1234-5678')).toEqual({ kind: 'string', value: '090-1234-5678' });
  });
  it('RC12（DD-052-2）: isStringColumn=true では数値/日付に見えても string のまま', () => {
    expect(draftToScalar('09012345678', true)).toEqual({ kind: 'string', value: '09012345678' });
    expect(draftToScalar('2026-07-13', true)).toEqual({ kind: 'string', value: '2026-07-13' });
    expect(draftToScalar('', true)).toEqual({ kind: 'blank' }); // 空文字は isStringColumn でも blank
  });
});

describe('captureEditStartRevision（#3 セル単位 beforeRevision の取得）', () => {
  it('未書込セルは 0（server validate の `?? 0` と一致）', () => {
    const doc = build([insertRows(null, ['r0', 'r1'])]);
    expect(captureEditStartRevision(doc, row('r1'), col('col-0'))).toBe(0);
  });
  it('書込済みセルはその lastChangedRevision', () => {
    // rev1=insert, rev2=set(r1,col-0)
    const doc = build([
      insertRows(null, ['r0', 'r1']),
      setCells([{ rowId: row('r1'), columnId: col('col-0'), value: str('X') }]),
    ]);
    expect(getCell(doc, row('r1'), col('col-0'))?.lastChangedRevision).toBe(2);
    expect(captureEditStartRevision(doc, row('r1'), col('col-0'))).toBe(2);
  });
});

describe('生存判定（#4 削除判定は tombstone で行う）', () => {
  it('isRowLive: 通常行=true・tombstone=false・未知=false', () => {
    const doc = build([insertRows(null, ['r0', 'r1']), { type: 'deleteRows', rowIds: [row('r1')] }]);
    expect(isRowLive(doc, row('r0'))).toBe(true);
    expect(isRowLive(doc, row('r1'))).toBe(false); // tombstone
    expect(isRowLive(doc, row('rX'))).toBe(false); // 未知
  });
  it('isTargetLive: 列が列順に無ければ false', () => {
    const doc = build([insertRows(null, ['r0'])]);
    expect(isTargetLive(doc, { rowId: row('r0'), columnId: col('col-0'), startRevision: 0 })).toBe(true);
    expect(isTargetLive(doc, { rowId: row('r0'), columnId: col('col-x'), startRevision: 0 })).toBe(false);
  });
});

describe('resolveCommit（#7 生存確認→beforeRevision→SetCells 生成）', () => {
  it('生存セルは submit（changes[].beforeRevision=startRevision・セル単位）', () => {
    const doc = build([insertRows(null, ['r0', 'r1'])]);
    const target: EditTarget = { rowId: row('r1'), columnId: col('col-0'), startRevision: 0 };
    const outcome = resolveCommit(doc, target, str('こんにちは'));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    expect(outcome.operation).toEqual({
      type: 'setCells',
      conflictPolicy: 'reject-overlap',
      changes: [
        { rowId: row('r1'), columnId: col('col-0'), beforeRevision: 0, value: str('こんにちは') },
      ],
    });
  });

  it('編集対象行が削除済みなら target-deleted（無効 RowId へ Commit しない・#4）', () => {
    const doc = build([insertRows(null, ['r0', 'r1']), { type: 'deleteRows', rowIds: [row('r1')] }]);
    const target: EditTarget = { rowId: row('r1'), columnId: col('col-0'), startRevision: 0 };
    expect(resolveCommit(doc, target, str('x')).kind).toBe('target-deleted');
  });

  // ★ #3 の核心テスト: 別セルの更新だけでは同一セル競合（stale-cell-revision）にならないこと。
  //   server の validateOperation（クライアントと同一関数）で SetCells を検証し、違反ゼロを確認する。
  it('別セルの更新だけでは同一セル競合にならない（server validateOperation で違反0・#3）', () => {
    // rev1=insert / rev2=set(r1,col-0)@rev2 / rev3=set(r1,col-1)@rev3（別セル col-1 の更新で doc.revision=3）。
    const doc = build([
      insertRows(null, ['r0', 'r1']),
      setCells([{ rowId: row('r1'), columnId: col('col-0'), value: str('A') }]),
      setCells([{ rowId: row('r1'), columnId: col('col-1'), value: str('B') }]),
    ]);
    // col-0 はまだ rev2 のまま（別セル col-1 の更新で doc.revision は 3 へ進んだが col-0 は不変）。
    expect(getCell(doc, row('r1'), col('col-0'))?.lastChangedRevision).toBe(2);
    expect(doc.revision).toBe(3);

    // A は col-0 を rev2 の時点で編集開始 → startRevision=2（セル単位）。
    const target: EditTarget = { rowId: row('r1'), columnId: col('col-0'), startRevision: 2 };
    const outcome = resolveCommit(doc, target, str('A2'));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;

    // server の判定（= クライアント共有の validateOperation）で stale-cell-revision が出ないこと。
    expect(validateOperation(doc, outcome.operation)).toEqual([]);

    // 対比: 文書全体 revision（3）を beforeRevision に使う誤実装なら stale になる（セル単位の必要性）。
    const wrong = resolveCommit(doc, { ...target, startRevision: 3 }, str('A2'));
    expect(wrong.kind).toBe('submit');
    if (wrong.kind !== 'submit') return;
    const violations = validateOperation(doc, wrong.operation);
    expect(violations).toEqual([
      {
        code: 'stale-cell-revision',
        rowId: row('r1'),
        columnId: col('col-0'),
        currentValue: str('A'),
        currentRevision: 2,
      },
    ]);
  });

  it('同一セルが別クライアントに更新されると stale になる（server validateOperation・AC2 の server 判定）', () => {
    // A が col-0 を rev2 で編集開始。B が同 col-0 を rev3 へ更新 → server は A の beforeRevision=2 を stale と判定。
    const doc = build([
      insertRows(null, ['r0', 'r1']),
      setCells([{ rowId: row('r1'), columnId: col('col-0'), value: str('A') }]),
      setCells([{ rowId: row('r1'), columnId: col('col-0'), value: str('B-wins') }]),
    ]);
    const outcome = resolveCommit(doc, { rowId: row('r1'), columnId: col('col-0'), startRevision: 2 }, str('A-late'));
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    const violations = validateOperation(doc, outcome.operation);
    expect(violations.map((v) => v.code)).toEqual(['stale-cell-revision']);
  });
});

describe('isEditTargetStale（#9 編集中の競合検知・committed に対して）', () => {
  it('編集開始 revision と現在 committed セル revision が一致なら false', () => {
    const doc = build([
      insertRows(null, ['r0', 'r1']),
      setCells([{ rowId: row('r1'), columnId: col('col-0'), value: num(1) }]),
    ]);
    expect(isEditTargetStale(doc, { rowId: row('r1'), columnId: col('col-0'), startRevision: 2 })).toBe(false);
  });
  it('別クライアント確定で乖離したら true（B の確定が編集中に来た）', () => {
    const doc = build([
      insertRows(null, ['r0', 'r1']),
      setCells([{ rowId: row('r1'), columnId: col('col-0'), value: num(1) }]),
      setCells([{ rowId: row('r1'), columnId: col('col-0'), value: num(2) }]),
    ]);
    // A は rev2 で編集開始したが committed は rev3 になった。
    expect(isEditTargetStale(doc, { rowId: row('r1'), columnId: col('col-0'), startRevision: 2 })).toBe(true);
  });
  it('未書込セル（startRevision=0）は書込があるまで false', () => {
    const doc = build([insertRows(null, ['r0', 'r1'])]);
    expect(isEditTargetStale(doc, { rowId: row('r1'), columnId: col('col-0'), startRevision: 0 })).toBe(false);
  });
});
