import { describe, expect, it } from 'vitest';

import { documentHash, getCell } from '@nanairo-sheet/core';
import type { ClientOperationEnvelope } from '@nanairo-sheet/core';

import { Sequencer, freshSequencerState } from './sequencer';
import type { SequencerOutcome } from './sequencer';
import {
  COLUMNS,
  col,
  createManualClock,
  deleteRows,
  envelope,
  insertRows,
  row,
  setCells,
  str,
} from './test-support';

function freshSequencer(): Sequencer {
  return new Sequencer(freshSequencerState(COLUMNS), createManualClock());
}

// row-1, row-2 を挿入した Sequencer（currentRevision=2・clientId='setup' が seq=2 まで）。
function setup2Rows(): Sequencer {
  const seq = freshSequencer();
  seq.submit(envelope({ clientId: 'setup', clientSequence: 1, operationId: 'setup-1', operation: insertRows(null, ['row-1']) }));
  seq.submit(envelope({ clientId: 'setup', clientSequence: 2, operationId: 'setup-2', operation: insertRows(row('row-1'), ['row-2']) }));
  return seq;
}

// outcome から reject を取り出す（instanceof narrow で as 不使用）。
function expectRejected(outcome: SequencerOutcome): Extract<SequencerOutcome, { status: 'rejected' }> {
  expect(outcome.status).toBe('rejected');
  if (outcome.status !== 'rejected') {
    throw new Error(`expected rejected, got ${outcome.status}`);
  }
  return outcome;
}

describe('F. サーバー: revision・冪等・clientSequence — AC2', () => {
  it('S-F1: 有効な submit は revision を +1 付与し ACK・ログ追記', () => {
    const seq = setup2Rows(); // currentRevision=2
    const outcome = seq.submit(
      envelope({ clientId: 'cA', clientSequence: 1, operationId: 'x', baseRevision: 2, operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('v') }]) }),
    );
    expect(outcome.status).toBe('accepted');
    if (outcome.status !== 'accepted') throw new Error('unreachable');
    expect(outcome.ack).toEqual({ type: 'operationAck', operationId: 'x', revision: 3 });
    expect(outcome.envelope.revision).toBe(3);
    expect(seq.currentRevision).toBe(3);
    expect(seq.operationsSince(2).map((e) => e.revision)).toEqual([3]); // ログに 1 件追記
  });

  it('S-F2: 重複送信（同一 operationId・同一 clientSequence）は二重適用せず同一 ACK 再返却（I-3・AC2）', () => {
    const seq = setup2Rows();
    const first = seq.submit(
      envelope({ clientId: 'cA', clientSequence: 1, operationId: 'dup', baseRevision: 2, operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('v') }]) }),
    );
    expect(first.status).toBe('accepted');
    const hashAfterFirst = documentHash(seq.document);
    const logLenAfterFirst = seq.operationsSince(0).length;

    const dup = seq.submit(
      envelope({ clientId: 'cA', clientSequence: 1, operationId: 'dup', baseRevision: 2, operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('v') }]) }),
    );
    expect(dup.status).toBe('duplicate');
    if (dup.status !== 'duplicate') throw new Error('unreachable');
    expect(dup.ack).toEqual({ type: 'operationAck', operationId: 'dup', revision: 3 }); // 同一 ACK
    expect(documentHash(seq.document)).toBe(hashAfterFirst); // 二重適用なし
    expect(seq.operationsSince(0).length).toBe(logLenAfterFirst); // ログ長不変
  });

  it('S-F3: clientSequence の欠番は client-sequence-violation（advance しない）', () => {
    const seq = setup2Rows();
    seq.submit(envelope({ clientId: 'cA', clientSequence: 1, operationId: 'a', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('a') }]) }));
    const gap = seq.submit(
      envelope({ clientId: 'cA', clientSequence: 3, operationId: 'c', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('c') }]) }),
    );
    const rejected = expectRejected(gap);
    expect(rejected.rejection.code).toBe('client-sequence-violation');
    expect(rejected.rejection.details).toMatchObject({ expectedSequence: 2, receivedSequence: 3 });
    // advance していないので seq=2 は正常受理される
    const recover = seq.submit(
      envelope({ clientId: 'cA', clientSequence: 2, operationId: 'b', operation: setCells([{ rowId: row('row-1'), columnId: col('col-b'), value: str('b') }]) }),
    );
    expect(recover.status).toBe('accepted');
  });

  it('S-F4: clientId=cA と cB は別列（cB の seq=1 は cA の履歴と無関係に受理）', () => {
    const seq = setup2Rows();
    seq.submit(envelope({ clientId: 'cA', clientSequence: 1, operationId: 'a1', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('a') }]) }));
    const cB = seq.submit(
      envelope({ clientId: 'cB', clientSequence: 1, operationId: 'b1', operation: setCells([{ rowId: row('row-2'), columnId: col('col-a'), value: str('b') }]) }),
    );
    expect(cB.status).toBe('accepted');
  });

  it('S-F5: 同一 userId の2接続（別 clientId）は独立検査（片方の遅れが他方に影響しない）', () => {
    const seq = setup2Rows();
    // 同一 actorId(user-1)・別 clientId
    seq.submit(envelope({ clientId: 'tabA', clientSequence: 1, operationId: 'ta1', actorId: 'user-1', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('a') }]) }));
    const tabB = seq.submit(
      envelope({ clientId: 'tabB', clientSequence: 1, operationId: 'tb1', actorId: 'user-1', operation: setCells([{ rowId: row('row-2'), columnId: col('col-a'), value: str('b') }]) }),
    );
    expect(tabB.status).toBe('accepted'); // tabB の seq=1 は tabA と無関係
  });

  it('S-F6: baseRevision が現在より未来 → invalid-base-revision', () => {
    const seq = setup2Rows(); // currentRevision=2
    const outcome = seq.submit(
      envelope({ clientId: 'cA', clientSequence: 1, operationId: 'x', baseRevision: 150, operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('v') }]) }),
    );
    const rejected = expectRejected(outcome);
    expect(rejected.rejection.code).toBe('invalid-base-revision');
    expect(rejected.rejection.details).toMatchObject({ currentRevision: 2 });
  });
});

describe('C. SetCells 原子性（サーバー判定）', () => {
  it('S-C1/C4: 複数の正常 change を単一 revision・単一 ACK で原子適用', () => {
    const seq = setup2Rows();
    const outcome = seq.submit(
      envelope({ clientId: 'cA', clientSequence: 1, operationId: 'x', operation: setCells([
        { rowId: row('row-1'), columnId: col('col-a'), value: str('x') },
        { rowId: row('row-2'), columnId: col('col-b'), value: str('y') },
        { rowId: row('row-1'), columnId: col('col-c'), value: str('z') },
      ]) }),
    );
    expect(outcome.status).toBe('accepted');
    if (outcome.status !== 'accepted') throw new Error('unreachable');
    expect(outcome.ack.revision).toBe(3);
    expect(getCell(seq.document, row('row-1'), col('col-a'))?.lastChangedRevision).toBe(3);
    expect(getCell(seq.document, row('row-2'), col('col-b'))?.lastChangedRevision).toBe(3);
  });

  it('S-C2: 1件でも stale なら全体 reject（stale-cell-revision）・部分適用なし・文書 hash 不変（I-5）', () => {
    const seq = setup2Rows();
    // (row-1,col-a) を rev=3 にする（現在セル revision=3）
    seq.submit(envelope({ clientId: 'cA', clientSequence: 1, operationId: 'a', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('server') }]) }));
    const hashBefore = documentHash(seq.document);
    // 2件目 (row-1,col-a) が stale（beforeRevision:0 だが現在 3）。1件目 (row-2,col-b) は正常
    const outcome = seq.submit(
      envelope({ clientId: 'cB', clientSequence: 1, operationId: 'x', operation: setCells([
        { rowId: row('row-2'), columnId: col('col-b'), beforeRevision: 0, value: str('ok') },
        { rowId: row('row-1'), columnId: col('col-a'), beforeRevision: 0, value: str('mine') },
      ]) }),
    );
    const rejected = expectRejected(outcome);
    expect(rejected.rejection.code).toBe('stale-cell-revision');
    expect(rejected.rejection.details?.violations).toEqual([
      { code: 'stale-cell-revision', rowId: row('row-1'), columnId: col('col-a'), currentValue: str('server'), currentRevision: 3 },
    ]);
    expect(documentHash(seq.document)).toBe(hashBefore); // 部分適用なし（row-2 も未適用）
    expect(getCell(seq.document, row('row-2'), col('col-b'))).toBeUndefined();
  });

  it('S-C3: 1件でも tombstone 行を含む SetCells は全体 reject（target-row-deleted）', () => {
    const seq = setup2Rows();
    seq.submit(envelope({ clientId: 'cA', clientSequence: 1, operationId: 'del', operation: deleteRows([row('row-2')]) }));
    const hashBefore = documentHash(seq.document);
    const outcome = seq.submit(
      envelope({ clientId: 'cB', clientSequence: 1, operationId: 'x', operation: setCells([
        { rowId: row('row-1'), columnId: col('col-a'), value: str('ok') },
        { rowId: row('row-2'), columnId: col('col-a'), value: str('bad') },
      ]) }),
    );
    expect(expectRejected(outcome).rejection.code).toBe('target-row-deleted');
    expect(documentHash(seq.document)).toBe(hashBefore);
    expect(getCell(seq.document, row('row-1'), col('col-a'))).toBeUndefined();
  });
});

describe('D. InsertRows 境界（サーバー判定）', () => {
  it('S-D5: 同一アンカーへの同時 Insert は受付順で逐次適用・両方受理・決定的順序（全クライアント同順の基盤）', () => {
    const seq = setup2Rows(); // rowOrder=[row-1,row-2]
    const first = seq.submit(envelope({ clientId: 'cA', clientSequence: 1, operationId: 'ia', operation: insertRows(row('row-1'), ['row-A']) }));
    const second = seq.submit(envelope({ clientId: 'cB', clientSequence: 1, operationId: 'ib', operation: insertRows(row('row-1'), ['row-B']) }));
    expect(first.status).toBe('accepted');
    expect(second.status).toBe('accepted');
    // 各 op は anchor 直後へ挿入。後着(row-B)が anchor 直後、先着(row-A)がその後 → 受付順に決定的
    expect(seq.document.rowOrder).toEqual([row('row-1'), row('row-B'), row('row-A'), row('row-2')]);
  });

  it('S-D6: 既存行と重複する rowId の InsertRows は duplicate-row で reject（指示 3・DA D11 の Room 境界）', () => {
    const seq = setup2Rows();
    const outcome = seq.submit(envelope({ clientId: 'cA', clientSequence: 1, operationId: 'x', operation: insertRows(row('row-1'), ['row-2']) }));
    const rejected = expectRejected(outcome);
    expect(rejected.rejection.code).toBe('duplicate-row');
    expect(rejected.rejection.details?.violations).toEqual([{ code: 'duplicate-row', rowId: row('row-2') }]);
  });
});

describe('E. DeleteRows 冪等・no-op（Q-1・指示 4）', () => {
  it('S-E3: 全件 tombstone 済み DeleteRows は no-op（revision 非消費・ログ非追記・ACK は現在 revision・冪等キャッシュ/seq 前進）', () => {
    const seq = setup2Rows();
    seq.submit(envelope({ clientId: 'cA', clientSequence: 1, operationId: 'del1', operation: deleteRows([row('row-1')]) })); // accepted rev=3
    const revBefore = seq.currentRevision;
    const logLenBefore = seq.operationsSince(0).length;

    const noop = seq.submit(envelope({ clientId: 'cA', clientSequence: 2, operationId: 'del2', operation: deleteRows([row('row-1')]) }));
    expect(noop.status).toBe('noop');
    if (noop.status !== 'noop') throw new Error('unreachable');
    expect(noop.ack).toEqual({ type: 'operationAck', operationId: 'del2', revision: revBefore }); // 現在 revision
    expect(seq.currentRevision).toBe(revBefore); // revision 非消費
    expect(seq.operationsSince(0).length).toBe(logLenBefore); // ログ非追記

    // 冪等キャッシュ登録: 同一 opId 再送で同一 no-op ACK
    const resend = seq.submit(envelope({ clientId: 'cA', clientSequence: 2, operationId: 'del2', operation: deleteRows([row('row-1')]) }));
    expect(resend.status).toBe('duplicate');
    if (resend.status !== 'duplicate') throw new Error('unreachable');
    expect(resend.ack.revision).toBe(revBefore);

    // clientSequence 前進: 次 op（seq=3）は正常受理（no-op が seq を消費した）
    const next = seq.submit(envelope({ clientId: 'cA', clientSequence: 3, operationId: 'del3', operation: deleteRows([row('row-2')]) }));
    expect(next.status).toBe('accepted');
  });

  it('S-E4: 同一行を2クライアントが Delete → 後着は冪等 no-op（二重適用0）', () => {
    const seq = setup2Rows();
    const first = seq.submit(envelope({ clientId: 'cA', clientSequence: 1, operationId: 'da', operation: deleteRows([row('row-1')]) }));
    expect(first.status).toBe('accepted');
    const revAfterFirst = seq.currentRevision;
    const second = seq.submit(envelope({ clientId: 'cB', clientSequence: 1, operationId: 'db', operation: deleteRows([row('row-1')]) }));
    expect(second.status).toBe('noop'); // 後着は既 tombstone → no-op
    expect(seq.currentRevision).toBe(revAfterFirst); // 二重適用なし
  });
});

describe('G. 競合 reject（stale beforeRevision）— AC4・§10.2', () => {
  it('S-G1: stale beforeRevision の SetCells は stale-cell-revision・details に現在値/現在 revision', () => {
    const seq = setup2Rows();
    seq.submit(envelope({ clientId: 'cA', clientSequence: 1, operationId: 'srv', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('server') }]) })); // rev=3
    const outcome = seq.submit(
      envelope({ clientId: 'cB', clientSequence: 1, operationId: 'mine', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), beforeRevision: 1, value: str('mine') }]) }),
    );
    const rejected = expectRejected(outcome);
    expect(rejected.rejection.code).toBe('stale-cell-revision');
    expect(rejected.rejection.details?.violations?.[0]).toEqual({
      code: 'stale-cell-revision', rowId: row('row-1'), columnId: col('col-a'), currentValue: str('server'), currentRevision: 3,
    });
  });

  it('S-G4: 同一セルを同一 beforeRevision で同時 Commit → 先着受理・後着 stale reject（収束）', () => {
    const seq = setup2Rows(); // (row-1,col-a) は未書込（rev=0）
    const first = seq.submit(
      envelope({ clientId: 'cA', clientSequence: 1, operationId: 'a', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), beforeRevision: 0, value: str('A') }]) }),
    );
    expect(first.status).toBe('accepted');
    const second = seq.submit(
      envelope({ clientId: 'cB', clientSequence: 1, operationId: 'b', operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), beforeRevision: 0, value: str('B') }]) }),
    );
    expect(expectRejected(second).rejection.code).toBe('stale-cell-revision'); // 後着は現在 rev != 0 で stale
    expect(getCell(seq.document, row('row-1'), col('col-a'))?.value).toEqual(str('A')); // 先着が確定
  });
});

// ---- 処理順の回帰防止（DA D3・§5 注記）: operationId 冪等を clientSequence 検査より先にする ----

// 「間違った順序」（clientSequence 検査を operationId 冪等より先）を模した純関数。重複再送で reject するはず。
function wrongOrderRejectsDuplicate(lastSequence: number, cachedOperationIds: Set<string>, env: ClientOperationEnvelope): boolean {
  // 誤: 先に単調 sequence を要求すると、重複再送（seq == lastSequence）は「単調でない」と判定される
  if (env.clientSequence !== lastSequence + 1) {
    return true; // client-sequence-violation（重複でも誤って reject）
  }
  return !cachedOperationIds.has(env.operationId);
}

describe('処理順の回帰防止（DA D3）— 順序入れ替えで F2/F3 が壊れることの実証', () => {
  it('正しい順序（冪等が先）: 重複再送は duplicate ACK。誤順序（seq が先）なら同入力が誤 reject される', () => {
    const seq = setup2Rows();
    const dupEnv = envelope({ clientId: 'cA', clientSequence: 1, operationId: 'dup', baseRevision: 2, operation: setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str('v') }]) });
    expect(seq.submit(dupEnv).status).toBe('accepted'); // 1通目

    // 正しい実装: 冪等が先 → 重複は duplicate（F2 維持）
    expect(seq.submit(dupEnv).status).toBe('duplicate');

    // 誤順序の実証: clientSequence 検査を先にすると、同じ重複入力（seq=1, 直近処理=1）は単調違反で reject される
    const cached = new Set<string>(['dup']);
    expect(wrongOrderRejectsDuplicate(1, cached, dupEnv)).toBe(true); // 誤順序なら reject（AC2 破綻）
  });
});

// ---- DD-056 H11: 認可段（③'）— 処理順・clientSequence の消費・拒否で状態を動かさない ----

describe("DD-056 H11: 認可段（③'）", () => {
  const cellA = (value: string) => setCells([{ rowId: row('row-1'), columnId: col('col-a'), value: str(value) }]);
  const deny = (): boolean => false;
  const allow = (): boolean => true;

  it('拒否は permission-denied（details なし）。revision・operationLog・ackCache・文書は動かない', () => {
    const seq = setup2Rows(); // currentRevision=2
    const hashBefore = documentHash(seq.document);
    const env = envelope({ clientId: 'cA', clientSequence: 1, operationId: 'denied', baseRevision: 2, operation: cellA('x') });
    const rejected = expectRejected(seq.submit(env, deny));
    expect(rejected.rejection).toEqual({ type: 'operationRejected', operationId: 'denied', code: 'permission-denied', details: {} });
    expect(seq.currentRevision).toBe(2);
    expect(seq.operationsSince(0).length).toBe(2);
    expect(seq.ackedRevisionOf(env.operationId)).toBeUndefined(); // ackCache 非登録（reject と同じ＝再接続の突合せで「拒否済み」に分かれる）
    expect(documentHash(seq.document)).toBe(hashBefore);
  });

  it('拒否でも clientSequence は消費する: 同じクライアントの次の操作（seq+1）は許可されれば受理される（sequence-violation にならない）', () => {
    const seq = setup2Rows();
    expectRejected(seq.submit(envelope({ clientId: 'cA', clientSequence: 1, operationId: 'd1', baseRevision: 2, operation: cellA('x') }), deny));
    expect(seq.clientSequenceTable.get('cA')).toBe(1);
    const next = seq.submit(envelope({ clientId: 'cA', clientSequence: 2, operationId: 'a2', baseRevision: 2, operation: cellA('y') }), allow);
    expect(next.status).toBe('accepted');
    expect(getCell(seq.document, row('row-1'), col('col-a'))?.value).toEqual(str('y'));
  });

  it('受理済み操作の再送は認可を呼ばずに同じ ACK を返す（禁止の前に受理した操作は禁止の後に再送されても受理のまま）', () => {
    const seq = setup2Rows();
    const env = envelope({ clientId: 'cA', clientSequence: 1, operationId: 'early', baseRevision: 2, operation: cellA('x') });
    expect(seq.submit(env, allow).status).toBe('accepted'); // 禁止の前に受理
    let called = 0;
    const counting = (): boolean => {
      called += 1;
      return false; // 禁止の後
    };
    const resent = seq.submit(env, counting);
    expect(resent.status).toBe('duplicate');
    if (resent.status !== 'duplicate') throw new Error('unreachable');
    expect(resent.ack).toEqual({ type: 'operationAck', operationId: 'early', revision: 3 });
    expect(called).toBe(0);
  });

  it('clientSequence 違反・baseRevision 違反は認可より先に判定する（認可は呼ばれない）', () => {
    const seq = setup2Rows();
    let called = 0;
    const counting = (): boolean => {
      called += 1;
      return false;
    };
    const gap = seq.submit(envelope({ clientId: 'cA', clientSequence: 2, operationId: 'gap', baseRevision: 2, operation: cellA('x') }), counting);
    expect(expectRejected(gap).rejection.code).toBe('client-sequence-violation');
    const ahead = seq.submit(envelope({ clientId: 'cA', clientSequence: 1, operationId: 'ahead', baseRevision: 99, operation: cellA('x') }), counting);
    expect(expectRejected(ahead).rejection.code).toBe('invalid-base-revision');
    expect(called).toBe(0);
  });

  it('認可は検証より先: 拒否中は検証違反（unknown-row）の操作も permission-denied になる。認可には envelope がそのまま渡る', () => {
    const seq = setup2Rows();
    const seen: ClientOperationEnvelope[] = [];
    const recording = (env: ClientOperationEnvelope): boolean => {
      seen.push(env);
      return false;
    };
    const env = envelope({ clientId: 'cA', clientSequence: 1, operationId: 'ghost', baseRevision: 2, operation: setCells([{ rowId: row('no-such-row'), columnId: col('col-a'), value: str('x') }]) });
    expect(expectRejected(seq.submit(env, recording)).rejection.code).toBe('permission-denied');
    expect(seen).toEqual([env]);
  });

  it('許可なら従来どおり検証・適用へ進む（行の挿入・削除も同じ段を通る）', () => {
    const seq = setup2Rows();
    const kinds: string[] = [];
    const recording = (env: ClientOperationEnvelope): boolean => {
      kinds.push(env.operation.type);
      return true;
    };
    expect(seq.submit(envelope({ clientId: 'cA', clientSequence: 1, operationId: 'i', baseRevision: 2, operation: insertRows(row('row-2'), ['row-3']) }), recording).status).toBe('accepted');
    expect(seq.submit(envelope({ clientId: 'cA', clientSequence: 2, operationId: 'd', baseRevision: 3, operation: deleteRows([row('row-3')]) }), recording).status).toBe('accepted');
    expect(kinds).toEqual(['insertRows', 'deleteRows']);
  });
});
