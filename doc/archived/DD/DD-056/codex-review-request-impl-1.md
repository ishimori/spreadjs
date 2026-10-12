# Codex レビュー依頼（DD-056-1 実装レビュー: 操作ごとの書込の認可 authorizeOperation）

## 依頼の趣旨

DD-056-1（広島空港 PoC 向け H11: サーバーで書込を拒否する）の**実装コミット `b387427`** をレビューしてほしい。
設計は `doc/archived/DD/DD-056/contract.md` §3（確定済み・前回の Codex 設計レビューの指摘 5 件を反映済み）。設計どおりに実装できているか、
実装で壊れる所がないかを、ソースとテストを読んで確かめてほしい。

- レビュー対象の差分: `git show b387427`
- **作業ツリーには次の子DD（DD-056-2・grid の読み取り専用の実行時切替）の作業途中の未コミット変更がある**。対象外なので無視すること。
  周辺コードを読むときは、作業ツリーではなく `git show b387427:<path>` でこのコミット時点の内容を読むこと

## 背景（要約）

consumer（広島空港の予算管理 PoC）は、受付締切・版の確定のあとに届いた書込をサーバーで拒否したい。締切後も経営戦略部は編集できる
（部署担当だけ拒否）ため、文書単位のフラグでなく**操作ごとの同期フック**にした。拒否してもサーバーは止まらず（既存の永続化の失敗は
fail-stop）、送った側だけが巻き戻る。

## 実装の要点

- `packages/core/src/protocol.ts`: `RejectCode` に `'permission-denied'`（protocolVersion 据え置き。decode は任意の文字列を受ける）
- `packages/server/src/sequencer.ts`: `submit(env, authorize?)`。処理順「① operationId 冪等 → ② clientSequence（通過したら消費）→
  ③ baseRevision → **③' 認可** → ④ 検証 → ⑤ 適用」。拒否は `permission-denied`（details `{}`）で revision・operationLog・ackCache を動かさない
- `packages/server/src/room.ts`: deps に `authorize?: (envelope, connectionId) => boolean`。`handleSubmit` が接続 ID を束縛して sequencer へ
- `packages/server-hono/src/server.ts`: `createOperationAuthorizer`（擬似接続 `'server'`＝`ServerInstance.submit` は判定しない／`true` 厳密一致／
  throw は `authorize-error`／非 boolean・thenable は `authorize-invalid-result`（thenable の reject も捕捉）／拒否ごとに `operation-denied`／
  `operation` の遅延複製）。serve 全体で共有する `AuthorizationGuard`（フック実行中の深さ）で、フックの中からの `submit`・`stop` を
  **reject（空の rejection ハンドラ付き・診断 `authorize-reentry`）**。停止の診断 `serve-stopped` を `startServer` の close へ移し、
  `serve()` の `stop` は内側の Promise をそのまま返す（async で包むと新しい未捕捉 Promise ができるため）
- `packages/server-hono/src/{index,serve-types}.ts`: `ServeOptions.authorizeOperation`・`ServeOperationAuthorizationRequest`・
  `ServeAuthorizeOperation`・`ServeRejectCode` への追加・JSDoc
- `packages/grid/src/error-codes.ts`: `GRID_CONFLICT_CODES`・写像表へ `permission-denied`。`toCompensationConflictCode`（Undo/Redo の補償
  op の拒否で `permission-denied` を `undo-blocked`/`redo-blocked` より優先）。`mount-controller.ts` の observer で使う
- テスト: `sequencer.test.ts`（6 件）・`room.test.ts`（1 件）・`serve.authorize.test.ts`（実 WS・ClientSession 2 体・7 件）・
  `error-codes.test.ts`・E2E `apps/playground/e2e/authorize-operation.spec.ts`（dev サーバー `dev-authorize.ts`＋制御口）
- 検証: typecheck・consumer-strict・lint・unit 1401 件 green（このマシンは Node プロセスの最初の listen が約 10 秒かかる環境のため
  `--testTimeout=40000` で流した）・新しい E2E green

## 重点的に見てほしい観点

1. **exactly-once と処理順**: ③' の位置が、受理済み操作の再送（duplicate ACK）・通知喪失後の再接続突合せ（`Room.computeReconcile`・
   `ClientSession.applyReconcile`）・clientSequence の再整列（`rebaselinePendingSequence`）・永続化あり（`PersistentRoom` の durable frontier・
   `inFlightOperationIds`）と矛盾しないか。拒否が誤拒否・二重適用・黙った喪失・`client-sequence-violation` のループを生む経路はないか
2. **認可の回避**: クライアントが判定を回避できる経路（擬似接続の名乗り、`clientId: 'server'`、申告 documentId の正規化、join 前の
   メッセージ、presence 等）がないか。`SERVER_CONNECTION_ID` と Room の接続 ID 払い出しの関係
3. **fail-closed と封じ込め**: throw・非 boolean・Promise／thenable（`then` が throw する不正な thenable を含む）・診断 sink の例外で、
   拒否以外の振る舞い（受理・接続断・プロセス終了・未捕捉 rejection）が起きないか
4. **再入の禁止**: `AuthorizationGuard` の深さ管理（try/finally）・フックの中から呼ばれうる他の API（`connectionCount` 等は可）・
   別文書の submit・ガードが外れたあとの通常の submit。`onAccepted` の中の `submit`（従来どおり許可）と取り違えていないか
5. **判定材料**: `actorId`（`authenticate` 指定時は上書き済みか）・`documentId`（接続先の文書か）・`operation` の遅延複製で受理される操作を
   書き換えられないか
6. **grid**: `permission-denied` の写像と、Undo/Redo の補償 op の拒否で Undo 状態の後始末が従来どおり行われるか
7. **互換**: フック未指定時に挙動・コストが変わらないか。`serve-stopped` の移動で既存の振る舞いが変わらないか。旧クライアントの扱い
8. **テストの妥当性**: テストが実際の不具合を捕まえるか（偽陽性・待ち方の甘さ・タイミング依存）。抜けている危険な場面

## 評価基準（指摘の重さ）

- **P1**: データの黙った喪失・誤った受理（拒否すべき操作が受理される／受理済みが拒否される）・収束しない状態・認可の回避・サーバー全体の
  停止（未捕捉例外・fail-stop）・操作ログの破損。必ず再現手順（操作の順序）を書くこと
- **P2**: 契約（contract.md §3）との食い違い、実装の穴、重要なテストの抜け
- **P3**: 表現・軽微な改善

各指摘に、重さ・`file:line`・壊れる場面・直し方の案を書くこと。根拠のない推測は書かない（ソースで確かめたことと推測を分ける）。
指摘がなければ「指摘なし」と書くこと。回答は日本語で。

## 対象外（指摘不要）

- 作業ツリーの未コミット変更（DD-056-2 の作業途中）
- 名前の好み・文体・Markdown の体裁
- 設計の判断そのもの（操作ごとのフックにしたこと・拒否コードを 1 つにしたこと・barrier API を入れないこと〔contract.md §3.5〕）。
  ただし実装して初めて分かった、consumer の決まりを破る具体的な場面があれば指摘してよい
- H12（DD-056-2）・H13（DD-056-3）の範囲
- テスト環境の「最初の listen が遅い」問題そのもの
