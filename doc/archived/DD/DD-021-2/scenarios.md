# DD-021-2 収束シナリオ一覧（Phase 0 🧪・オーケストレータ確認で合意扱い）

親 DD-021 の要確認③④確定値（同一アンカー同時 Insert=サーバー受付順・両方保持／K4=ドラフト保持・commit 時 reject）を前提に、
検討内容①〜⑥を体系化する。各シナリオは AC・検証コード・保証境界（既知の未保証）を明記する。

> 収束 assert の共通形（既存資産＝convergence.test.ts / collab.invariant.test.ts の流儀を踏襲）:
> (a) 全 client `committedHash` == server hash、(b) 構造 deep-equal（`normalizeDocument`＝tombstone/rowOrder/slot/全セル・hash 独立）、
> (c) 二重適用0（server ログ operationId 重複0・revision 連番・各 client `nextExpectedRevision`==serverRev+1・pending 0）。

## シナリオ表

| # | 名前 | 検討内容 | AC | 操作列 | 期待（収束後） | 保証境界（未保証） | 検証コード |
|---|------|---------|----|--------|----------------|-------------------|-----------|
| S1 | 同一アンカー同時 Insert ×2 | ① | AC1 | A/B が同一 anchor へ Insert（楽観適用）→ 同時配送 | 両 rowId が live で保持・全 client が server 受付順の同一並びへ収束 | 並び順（意図順）は保証しない＝受付順で決まる | row-convergence.test.ts S1 |
| S2 | 同一アンカー同時 Insert ×N（3体） | ① | AC1 | 3 client が同一 anchor へ Insert | 3 rowId 全保持・同一並び収束 | 同上 | row-convergence.test.ts S2 |
| S3 | Insert × Delete 交錯（tombstone 済みアンカー） | ② | AC5 | A が anchor 行を Delete・B が同 anchor へ Insert | tombstone 済みアンカーは順序参照点として有効（S-D2）＝Insert 成立・削除は tombstone で保持・収束 | — | row-convergence.test.ts S3 |
| S4 | SetCells × DeleteRows（delete 先） | ③ | AC3 | A が行 Delete → B が同行へ SetCells（beforeRevision 付き） | B の SetCells は `target-row-deleted` で server reject＝公開 rejected 経路（Conflict Queue）へ・文書は削除値のみ | reject 後の再試行 UX は本子DD対象外 | row-convergence.test.ts S4 |
| S5 | SetCells × DeleteRows（setcells 先） | ③ | AC4 | A が行へ SetCells → B が同行を後から Delete | 両方適用（値確定後に行 tombstone）・収束 | — | row-convergence.test.ts S5 |
| S6 | 再 Delete 冪等（S-E4・公開経路） | ④ | AC5 | A/B が同一行を並行 Delete（敗者は tombstone 済みへの再 Delete） | 敗者 Delete は server noop・acked-noop を rebuildView が除去（DA D33）・収束・二重適用0 | — | row-convergence.test.ts S6 |
| S7 | 自分の楽観 Insert が reject → rollback | — | AC8 | A が未知アンカーへ Insert（実行前は grid 層が弾くが、collab 層では revalidation-failed 経路）／server reject | 楽観適用が Conflict Queue へ・view から挿入行が消え・収束・クラッシュなし | 選択/描画の詳細再ベースは DD-021-3 | row-convergence.test.ts S7 |
| S8 | offline 中の行操作 → reconnect catch-up | ⑤ | AC6 | A offline 中に Insert/Delete・B online で行操作 → A 再接続 | reconcile＋catch-up 後に全 client 収束・二重適用0・入力喪失0 | — | reconnect-fault.invariant（既存・DD-015 由来。insert/delete は genOp に既在＝**本DDでの比率強化はしていない**〔Fable P3 是正: 当初の「delete 比率強化」記載は誤り〕）＋reconnect-headed E2E（**本DDで delete 追加**） |
| S9 | randomized ミックス（行操作比率強化） | ⑥ | AC2 | setCells/insert/delete 混合＋同一アンカー衝突バイアス・3〜5 体 | hash 一致・二重適用0・insert/delete 実適用≥1・seed 再現性 | — | collab.invariant（row-heavy seed 追加） |
| K4 | IME 変換中に対象行がリモート削除 | K4/親④ | AC7 | (r,c) で composition 中に他 client が行 r を Delete | ドラフト・textarea・composition 非破壊・編集継続・行消失インジケータ表示・commit 時に target-deleted で divert（ドラフト保持＝reject 通知）・状態機械無変更 | 数式参照維持は DD-022 送り／実 IME は親 Phase 4 M1 | ime-editing-session.test.ts（K4）＋ime row-structure invariant＋row-operations E2E（synthetic） |

## §2.3 不変条件との対応（既存 INV-1〜6 の再利用）

- S1〜S9 は INV-1（hash 一致）・INV-2（rollback/replay 収束）・INV-5（idempotency）・INV-6（RowId 安定・構造 deep-equal）を再利用する。
- S4/S6 は INV-3（サイレント上書きなし・reject 値が committed に載らない）・INV-4（reject 時に元 operation 保持）を行操作競合へ拡張する。
- K4 は IME 不変条件（#8 サーバー更新で IME 状態不変／I-3 composition 非破壊）を「対象行削除」ケースへ拡張する。

## 同時 Insert 並び規則（受付順）の文書化（引き継ぎ物）

同一アンカー `A` への Insert が複数 client から同時発行された場合、**server が submitOperation を受理した順**（Sequencer の revision 付与順）で
`A` の直後へ順に挿入される。後着ほど `A` に近い位置（`A+1`）へ入り、先着を押し下げる（`applyInsertRows` が anchorIndex+1 固定挿入のため）。
クライアント発行時刻・意図順は保証しない。全 client は server の operationLog を同順で replay するため同一並びへ収束する。
