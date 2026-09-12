# DD-049 Codex レビュー依頼（共同編集の受理通知・remote-change・Presence 公開）

## 背景・目的

consumer（広島空港 予算管理モック・React `<NanairoSheetView mode="collaboration">` ＋ DB を持たない `serve()`）が共同編集を
成立させるために欠けていた SDK 側の口を追加した。
正本: `doc/DD/DD-049_共同編集の受理通知とPresence公開.md`（決定事項・受け入れ基準）と `doc/DD/DD-049/contract.md`
（公開 API 契約・内部設計の要点・テストシナリオ）。

- **H2** `serve({ onAccepted })` — revision を消費した受理 1 件ごとに、durable 化（永続化あり）と ACK/broadcast の dispatch の**後**に
  fire-and-forget で通知する。前値付き `changes`・複製した `envelope`・`origin: 'client' | 'server'`。失敗は診断 `on-accepted-error`。
- **H4** grid `remote-change` — サーバー確定の SetCells が committed に入るたびに 1 回（自分の op は echo 適用時に `origin: 'local'`）。
  1 サーバーメッセージの処理（SessionSync が Render State の dirty を立てた後）が終わってからまとめて配る。
- **H5** grid `presence` イベント＋`GridInstance.presences()` — 先頭に自分・他者はサーバー到着順。一覧が変わったときだけ発火。
  自分のアクティブセル移動による再計算はマイクロタスクへ遅らせる。
- **React** `onRemoteChange` / `onPresenceChange` / handle `presences()`。

## 対象差分（未コミット・`--uncommitted`）

| 領域 | ファイル |
|---|---|
| H2 | `packages/server-hono/src/server.ts`（RoomBridge の `route` / `submitFromServer` / `notifyAccepted`・`acceptedCellChanges`）／`serve-types.ts`／`index.ts` |
| H4 | `packages/collab/src/session.ts`（`reconcileServerOperation` の `onCommittedOperation` 通知）／`packages/grid/src/remote-change.ts`（純関数）／`session-sync.ts`（`onServerMessageSettled`）／`mount-controller.ts`（キュー・flush） |
| H5 | `packages/grid/src/presence-list.ts`（純関数）／`mount-controller.ts`（`currentPresenceUsers`・`refreshPresence`・`schedulePresenceRefresh`・`presences()`）／`index.ts`（公開型） |
| React | `packages/react/src/index.ts` |
| テスト | `packages/server-hono/src/serve-on-accepted.test.ts`・`packages/collab/src/committed-operation.test.ts`・`packages/grid/src/{remote-change,presence-list}.test.ts`・`packages/react/src/nanairo-sheet-view.dd049.test.ts`・`apps/playground/e2e/remote-change.spec.ts` |
| ハーネス | `apps/playground/src/integration/main.ts`（`?activity=1` のときだけ参加者・確定変更を表示） |
| 記録 | `CHANGELOG.md`・`apps/showcase/src/features.json`・`tests/contract/__snapshots__/facade-surface.test.ts.snap`（追加のみ）・`doc/plan/stage2-backlog.md`・`doc/archived/DD/DD-017/error-codes.md`・DD 本文・contract.md・`doc/DD/DD-049-1_変更者の可視化.md`（起票のみ）・DD-INDEX |

## 評価基準（この観点で指摘してほしい）

1. **H2 の「durable・配信後」と「1 受理＝1 回」**: reject・noop・duplicate・durable 失敗・catch-up/bootstrap の再配布で通知されないことが
   構造的に保証されているか（受理判定＝dispatch 済み Outbound のうち target=all の operations）。永続化あり（PersistentRoom の append 待ち）で
   複数接続の op が並走したとき、**通知順が revision 昇順**になり、**前値が op 適用直前の値**になるか（`room.handleMessage` の直前に捕捉する
   Sequencer 文書の参照が copy-on-write で不変、という前提が崩れる経路は無いか）。
2. **H2 の失敗隔離と再入**: hook の同期 throw・async reject が ACK・配信・永続化・他接続へ波及しないか（特に `route` の `.catch` が接続を
   閉じる経路へ入らないか）。hook 内 `submit()` の再入で Sequencer の clientSequence・通知順が壊れないか。未処理 rejection が出る経路は無いか。
3. **H4 の境界**: rollback/reject された楽観適用が `remote-change` にならないか。bootstrap・再接続の tail catch-up・順不同到着・重複配信での
   通知の有無と順序が contract §3 どおりか。`onCommittedOperation` の追加が rollback/replay の状態遷移や既存 observer のイベント列を変えていないか。
4. **H4/H5 の配信タイミングと再入**: `onServerMessageSettled`（SessionSync observer の末尾）でまとめて配る設計と、自分の presence を
   マイクロタスクへ遅らせる設計が、listener から命令 API（`setActiveCell`・`insertRows`・`destroy` 等）を呼ぶ再入で、editor・IME 状態機械・
   描画の dirty と競合しないか。キューが配られずに残る経路（例: session 側の例外で observer が呼ばれない）は無いか。
5. **H5 の一覧の正しさ**: 自分が載る時期（初回 welcome 後）・切断中の保持・TTL 失効・再接続（presenceSnapshot）で、`presence` イベントと
   `presences()` が矛盾しないか。変化判定（構造比較）の漏れ・過剰発火は無いか。
6. **公開契約・後方互換・R7**: 追加のみで既存シグネチャが不変か。内部型（UserPresence・ChangeSet・ServerOperationEnvelope）が公開面へ
   漏れていないか。新しいオプション・イベントを使わない consumer に挙動差・無視できないコストが無いか。
7. **テスト不足**: 上記 1〜5 のうち unit/E2E で検証できていない箇所。E2E の決定性（直列実行の共有 WS 文書・poll の使い方）。

## 対象外（指摘不要）

- 仕様の選択そのもの（論点 1〜6・fire-and-forget・origin の値・remote-change が行の挿入/削除を含まないこと・presence の項目）は
  Human Spec Gate で確定済み（contract.md §1）。
- H1 数式（DD-022）・H3 変更者の可視化（DD-049-1）・H6/H7（stage2-backlog §3.7）。
- 認証・テナント分離などの本番運用要件、envelope の clientId 詐称など既存の trusted internal 前提（`authenticate` は既存のまま）。
- 実機の Manual Gate（2 ブラウザでの目視）と、playground の `?activity=1` 表示の見た目。
- CHANGELOG・features.json・DD 文書の文言の細部。

## 出力形式

findings を P1（データ破壊・通知の欠落/重複/順序違反・既存挙動の回帰・不変条件違反）／P2（誤動作・境界の漏れ）／P3（保守性・テスト）で
分類し、各 finding に「ファイル:行・再現手順または反例・推奨修正」を付けてほしい。総評は「マージ可／条件付き／要修正」の 1 行。
