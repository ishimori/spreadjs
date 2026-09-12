# DD-049 Codex レビュー依頼（第 2 回・第 1 回 findings の修正確認）

## 背景

第 1 回（`doc/DD/DD-049/codex-review-request.md` → `codex-review-result.md`・総評「要修正」）の findings 2 件を両方採用して修正した。
本依頼は**修正差分の確認**に絞る（第 1 回で指摘の無かった範囲の再レビューは不要）。正本: `doc/DD/DD-049/contract.md` §2（順序・再入・失敗）・§6-1。

- **P1（通知・配信の revision 順違反）への修正**: `packages/server-hono/src/server.ts` の `RoomBridge` に submitOperation の配信待ち FIFO を追加した
  （`deliverSubmitInOrder` / `drainSubmitDeliveries` / `deliverSubmit`・型 `SubmitDelivery`）。`route()`（接続の submitOperation）と
  `submitFromServer()`（`ServerInstance.submit`）の両方が、Room へ投入した直後にこの FIFO へ積み、settle 済みの先頭から
  dispatch → 受理通知 → `onDelivered`（submit の解決）を行う。同期の Room は即座に、PersistentRoom は durable 化後に settle する。
  配信ループ中に積まれた op（hook 内の submit）は実行中のループが続けて配る。`submitFromServer` は `async` をやめ、常に Promise を返す。
  submitOperation 以外（presence・heartbeat・requestCatchup）は従来どおり FIFO を通さない。
- **P2（失敗診断の文字列化が throw）への修正**: `errorMessage` を throw しない実装にし、`describeThrown` を追加、`reportAcceptedFailure` を例外隔離した。
- 回帰テスト: `packages/server-hono/src/serve-on-accepted.test.ts` の S9（ws クライアントの下層 socket を cork して連続 2 フレームを 1 回の write に
  まとめ、1 件目の hook 内 submit と混在させて通知・配信の順を検査）・S10（null prototype の throw/reject）。どちらも修正前に red を確認済み。

## 対象差分（未コミット・`--uncommitted`）

修正は `packages/server-hono/src/server.ts`（RoomBridge・`errorMessage` / `describeThrown`）と `packages/server-hono/src/index.ts`（onAccepted の JSDoc）、
テストは `serve-on-accepted.test.ts` の S9/S10。記録は `CHANGELOG.md`（Fixed）・`doc/DD/DD-049/contract.md`・DD 本文ログ。その他の差分は第 1 回と同じ（参照のみ）。

## 評価基準（この観点で指摘してほしい）

1. **FIFO の順序保証**: 接続の op・`submit`・hook 内の `submit`・同じ data チャンクで届いた連続フレーム・永続化あり（append 待ち）が混在しても、
   dispatch と受理通知が必ず revision 順になるか。FIFO へ積む順が Room への投入順（＝sequencer の revision 付与順）とずれる経路は無いか。
2. **既存の durable ACK 契約・後方互換**: 永続化ありで ACK/broadcast が append 解決前に出る経路、あるいは FIFO の先頭待ちで配信が不必要に遅れる・
   止まる経路（head-of-line blocking: append の失敗・poison、settle しない Promise、`stop()` 中）は無いか。onAccepted 未指定の consumer にとって、
   配信タイミング・ACK/reject・duplicate/noop の扱いが従来と同じか。
3. **失敗経路**: durable 失敗時の接続切断（`failConnection`）、`submit` の reject（`submitResultOf` の throw を含む）、dispatch の例外が該当する 1 件だけに
   閉じ、後続の配信・通知を止めないか。`drainingSubmitDeliveries` のフラグが戻らない経路は無いか。
4. **再入**: hook から `submit`・`stop()`・別文書への `submit` を呼ぶ、配信中に接続が閉じる（`closeSocket` → `onClose` → dispatch）といったケースで、
   ループ・フラグ・FIFO が壊れないか。「hook は入れ子に呼ばれない」という契約が成立しているか。
5. **P2**: `errorMessage` / `describeThrown` / `reportAcceptedFailure` が任意の値（null prototype・getter が throw する Error・Proxy 等）で throw しないか。
   変更した `errorMessage` を使う既存の呼び出し箇所（起動時の後始末ログ・durable 失敗ログ等）の挙動が変わっていないか。
6. **テスト**: S9 が「2 フレームが同じ data チャンクで同期に処理される」状況を十分に作れているか（修正後に偽 green になる余地）。S9/S10 以外に
   足りない回帰テスト。

## 対象外（指摘不要）

- 第 1 回で指摘が無かった範囲（grid の remote-change/presence・collab の onCommittedOperation・React 写像・文書類）と、仕様の選択そのもの（contract.md §1）。
- 第 1 回の依頼書に記載した対象外（本番運用要件・既存の trusted internal 前提・実機 Manual Gate・文言の細部）。

## 出力形式

findings を P1（データ破壊・通知/配信の欠落・重複・順序違反・既存挙動の回帰）／P2（誤動作・境界の漏れ）／P3（保守性・テスト）で分類し、
各 finding に「ファイル:行・再現手順または反例・推奨修正」を付けてほしい。総評は「マージ可／条件付き／要修正」の 1 行。
