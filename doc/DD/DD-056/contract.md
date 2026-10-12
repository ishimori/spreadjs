# DD-056 公開 API 契約と設計（H11 書込の認可・H12 読み取り専用の実行時切替と送り切り・H13 文書の追加と撤去）

> 状態: **確定（2026-10-12 Human Spec Gate・ユーザー決定。論点1〜5 は推奨どおり＋§4.5 の既存不具合を DD-056-2 で直す）**。
> Codex 設計レビュー（high・P1×2／P2×3・全採用）を反映済み。DD本文「決定事項」から参照する。実装後は JSDoc（`packages/server-hono/src/{index,serve-types}.ts`・`packages/grid/src/index.ts`・
> `packages/react/src/index.ts`）と公開 .d.ts snapshot（`tests/contract/__snapshots__/facade-surface.test.ts.snap`）が機械的な写しになる。
> 乖離したら本ファイルを直す。すべて Experimental 0.x・公開型は**追加のみ**（既存シグネチャの変更・削除なし）。
> 実読は HEAD（`a3f8c80`・配布 alpha.10 と同じソース）で行った。

## 0. 要点

| H | 形（推奨） | 起票時の仮説からの変更 |
|---|---|---|
| H11 | **操作ごとの認可フック** `serve({ authorizeOperation })`。拒否は既存の reject 経路に新しい拒否コード `permission-denied` を足して返す。sequencer の処理順に「認可」段を足す（clientSequence 消費の後・検証の前） | 論点1を (a) 文書単位のフラグ → **(b) 操作ごとのフック**へ変更。広島の画面設計 §4.4 では受付締切の後も経営戦略部は編集できる（拒否するのは部署担当の操作だけ）。文書単位のフラグではこれを表せない。正典（開発計画 §8.7「接続後も Operation ごとに権限・対象文書を検証」・Phase 3「権限フック」・D-21「文書 read／write から開始」）とも一致する |
| H12 | grid `setReadOnly(boolean)`（開き直さずに切り替える）＋`pendingCount()`＋`flush()`（編集中のセルを確定して送り切るまで待つ）。React は `readOnly` が変わっても開き直さない。編集中のセルの確定は、Tier 1 の通常の状態である「変換確定の直後（最終 input が来ない）」も確定させる（§4.2） | 論点3の推奨（(b) を第一に (a) の送り切り通知も）を具体化。(a)(b) の両方を入れる。あわせて、変換確定直後のクリック・グリッド外クリックが確定されない既存の不具合（§4.5）を見つけた。直すかはゲートで決める |
| H13 | `ServerInstance.addDocument(documentId, config)`・`removeDocument(documentId)`。外した文書の接続は切断し、以後の接続・`submit` は拒否（404） | 論点4 (a) のとおり |

配布: H11・H12 を先に alpha.11 で配る（広島の希望 10/19 頃）。H13 は続けて alpha.12。

## 1. 実読の結果（HEAD）

### 1.1 サーバーの受理経路と reject

- `Sequencer.submit`（`packages/server/src/sequencer.ts:94`）の処理順: ① operationId 冪等（既知なら同じ ACK を返す）→ ② clientSequence（欠番・戻りは reject。**通過したら以降の reject でも消費する**＝`:115`）→ ③ baseRevision → ④ 検証（`validateOperation`）→ ⑤ 適用。
- reject は送信元にだけ `operationRejected { code, details }` を返す（`packages/server/src/room.ts:272`）。revision・operationLog・ackCache は進まない。接続は保たれる。
- 永続化の失敗（`append` の reject）は fail-stop（`packages/server/src/persistent-room.ts:269`・`serve-types.ts:80-90`）。H11 の拒否をここに載せると以降の書込が止まる＝使えない。
- `ServerInstance.submit`（サーバー起点）は擬似接続 `'server'`（`SERVER_CONNECTION_ID`）として同じ Room 経路を通る（`packages/server-hono/src/server.ts:261`）。WebSocket の接続 ID はサーバーが払い出す UUID で、クライアントは名乗れない。
- 認証フック（U2）は upgrade 時だけ。受理後は envelope の `actorId` をサーバー確定値で上書きして Room へ渡す（`server.ts:333-334`）。

### 1.2 クライアントの reject 処理

- `ClientSession.handleRejected`（`packages/collab/src/session.ts:599`）: `client-sequence-violation` 以外は pending から外して Conflict Queue へ入れ、view を committed＋残りの pending から作り直す（＝**送った側の画面が元に戻る**）。拒否された操作に依存する後続の pending は再検証で外れる（`revalidation-failed`・`dependency`）。
- protocol の decode は `code` を文字列として受ける（`packages/core/src/message-codec.ts:131`）。grid は未知の拒否コードを公開語彙の `'unknown'` へ落とす（`packages/grid/src/error-codes.ts`）。＝**拒否コードを足しても旧クライアントは壊れない**（通常の巻き戻し＋`unknown`）。
- 再接続の突合せ（DD-015）は、未 ACK の操作を「受理済み／拒否済み（通知喪失）／未処理」に分け、未処理だけを再送する。

### 1.3 readOnly と mount

- grid の `readOnly` は mount 時の定数（`packages/grid/src/mount-controller.ts:259` の `const`）。入口（キー・ダブルクリック・貼り付け・行操作・Undo/Redo・候補欄）と送信の関所（`submitSetCells`・`submitToBackend`）の約 25 箇所が実行時に参照する。常駐 textarea の `readOnly` 属性と編集 DOM イベントの遮断は editor 生成時の定数（`packages/grid/src/integration-editor.ts:134`）。
- React は `readOnly` を識別系（`mountKeyOf`・`packages/react/src/index.ts:283`）に入れており、変わると `destroy()` → 再 mount する。未送信の操作・編集中のセルは捨てられる。

### 1.4 未送信の扱い

- `ClientSession.pendingCount` は自分の未確定の操作の数（ACK 済みで echo 待ちも含む。echo・reject・突合せで減る）。grid は `pending` イベントで変化を通知している（`mount-controller.ts:299`）が、値を引く API と「送り切るまで待つ」API はない。
- 編集中のセル（textarea の下書き）は pending に入っていない。blur で確定する（Excel 準拠・`packages/ime/src/editor-state-machine.ts:548`）。IME 変換中の blur は確定しない（`:534`）。

### 1.5 文書構成と保存先

- 文書の登録簿は `startServer` 内の `runtimes: Map<string, DocumentRuntime>`（`server.ts:1080`）。起動時に作って以後変えない。upgrade・`/config`・`/snapshot`・`submit` はこの Map を引く（無ければ 404・reject）。
- 文書の後始末は `DocumentRuntime.close()`（PersistentRoom → oplog・snapshot の close）。consumer ストアの adapter の `close` は直列化キューの完了を待たない（`packages/server-hono/src/serve-adapters.ts`）。

## 2. 論点の結論案

| # | 論点 | 推奨 | 理由 |
|---|---|---|---|
| 1 | H11 の形 | **(b) 操作ごとの認可フック** `authorizeOperation`（同期・true で通す） | §0 のとおり。文書単位の禁止は `(req) => !locked.has(req.documentId)` の 1 行で書ける。役割で分ける締切（部署担当だけ拒否）や将来の行の権限（H7）も同じ口で書ける。状態は consumer が持つ（再起動のたびに SDK へ設定し直す必要がない＝起動直後の取りこぼしがない） |
| 2 | 拒否の伝え方 | **(a) 既存の reject 経路に拒否コード `permission-denied` を足す** | 送った側だけが巻き戻る既存の経路をそのまま使う。読み取り専用への切替通知は consumer が自分の通知経路で配り、H12 の `setReadOnly` で切り替える（SDK に新しい通知メッセージを足さない） |
| 3 | H12 の形 | **(c) 両方**: `setReadOnly`（開き直さない）＋`pendingCount()`＋`flush()` | 他人の操作で読み取り専用になる場合は `setReadOnly` で入力を失わない。自分の操作（提出・締切・確定）の前は `flush()` で送り切りを待つ |
| 4 | H13 の形 | **(a) `addDocument`・`removeDocument`** | 版ごとに別の文書にする consumer の設計に合う。撤去しても保存先（oplog・snapshot）は消さない |
| 5 | 優先と時期 | **H11・H12 → alpha.11（先に配る）、H13 → alpha.12** | 広島の希望（H11・H12 を 10/19 頃）に合わせる。H13 はつなぎ（立て直し）があるため後でよい |

## 3. H11 操作ごとの書込の認可（子DD DD-056-1）

### 3.1 公開 API（`@nanairo-sheet/server-hono`）

```ts
/** authorizeOperation に渡る判定材料（DD-056 H11）。 */
interface ServeOperationAuthorizationRequest {
  /** 操作の宛先文書（複数文書 serve では接続先の文書。クライアントの申告値ではない）。 */
  readonly documentId: string;
  /** 操作者。authenticate 指定時はサーバーが確定した actorId（申告値は使わない）。未指定ならクライアント申告値。 */
  readonly actorId: string;
  /** 送信元クライアントの clientId（再接続で不変）。 */
  readonly clientId: string;
  /** 操作 ID（拒否された側の grid の rejected イベントの conflict.operationId と同じ値）。 */
  readonly operationId: string;
  /** 文書操作（setCells / insertRows / deleteRows）。複製（書き換えても受理される操作に影響しない）。 */
  readonly operation: ServeDocumentOperation;
}

/** true を返した操作だけを受理段へ進める。true 以外（false・undefined・Promise 等）と throw は拒否する（fail-closed）。 */
type ServeAuthorizeOperation = (request: ServeOperationAuthorizationRequest) => boolean;

interface ServeOptions { /* …既存 */ readonly authorizeOperation?: ServeAuthorizeOperation }

type ServeRejectCode = /* …既存 */ | 'permission-denied';
```

consumer の書き方（広島の例）:

```ts
const closedForDepartments = new Set<string>(); // 受付締切中の版の文書
const confirmed = new Set<string>();            // 確定済みの版の文書
await serve({
  documents,
  authenticate,                                   // actorId = 利用者 ID
  authorizeOperation: ({ documentId, actorId }) => {
    if (confirmed.has(documentId)) return false;                                  // 確定後は全員拒否
    if (closedForDepartments.has(documentId) && !isStrategy(actorId)) return false; // 締切後は部署担当だけ拒否
    return true;                                  // 提出後は受理（画面設計 §4.5 の 3: 提出を自動で取り消す）
  },
});
```

### 3.2 契約

| 項目 | 契約 |
|---|---|
| 呼ばれる時点 | WebSocket 接続から届いた文書操作 1 件につき高々 1 回、sequencer の**認可段**で同期に呼ばれる。処理順は ① operationId 冪等 → ② clientSequence → ③ baseRevision → **③' 認可** → ④ 検証 → ⑤ 適用（protocol-subset §5 に③'を足す） |
| 呼ばれない | 受理済み操作の再送（① で同じ ACK を返す＝**禁止の前に受理した操作は禁止後に再送されても受理のまま**）／clientSequence 違反・baseRevision 違反（② ③ で reject）／`ServerInstance.submit`（サーバー起点は判定しない）／seed・`initialDocument`／presence・heartbeat・catch-up（文書操作ではない） |
| 拒否 | `operationRejected { code: 'permission-denied' }` を送信元へ返す。clientSequence は消費する（次の操作は通常どおり処理される）。revision・operationLog・ackCache・永続化・`onAccepted` は動かない。**接続は切らず、サーバーも止まらない**（fail-stop しない） |
| 送った側の画面 | 既存の reject と同じく元に戻る（view を committed＋残りの pending で作り直す）。grid は `rejected` イベント（`conflict.reason: 'rejected'`・`conflict.code: 'permission-denied'`）を出す。拒否された行挿入に依存する後続の操作は再検証で外れ、`revalidation-failed`／`dependency` として通知される（既存） |
| Undo／Redo の拒否 | 補償操作（Undo／Redo）が認可で拒否されたときも、Undo 状態の後始末（エントリの除去）は従来どおり行い、**通知のコードは `permission-denied` を優先する**（従来は拒否理由によらず `undo-blocked`／`redo-blocked` に置き換えていた＝`mount-controller.ts:1686-1698`。Codex 設計レビュー P2-3） |
| 他の接続 | 何も届かない（拒否は配信されない） |
| 戻り値 | `true`（厳密一致）だけを許可とする。それ以外は拒否し、`true`／`false` 以外なら診断 `authorize-invalid-result`（error）を出す |
| throw | 拒否として扱い、診断 `authorize-error`（error・例外の name と message・documentId・operationId）を出す。接続は切らない |
| Promise・thenable | 待たずに拒否する（`true` ではない）。**返された Promise／thenable の失敗は捕捉して**診断 `authorize-invalid-result` に含める（未捕捉の rejection で Node のプロセスが落ちるのを防ぐ・Codex 設計レビュー P1-1・coding-standards の rejection 捕捉規約） |
| 同期 | **判定は同期で速く**（メモリ上の状態を引くだけ）。DB を引く必要がある状態は consumer がメモリに持つ |
| 再入の禁止 | フックの中から `ServerInstance` の `submit`・`addDocument`・`removeDocument`・`stop` を呼ぶと、何もせず Promise reject する。フックは sequencer の処理の途中（clientSequence 消費の後・適用の前）で呼ばれるため、そこで同じ文書へ投入すると同じ受理を二重に永続化しうる（PersistentRoom は呼び出し前後の revision 差で永続化対象を決める） |
| 操作者の信頼性 | `actorId` が信頼できるのは `authenticate` を指定したときだけ（未指定ならクライアントの申告値＝なりすませる）。役割で分ける判定に使うなら `authenticate` が必須 |
| 拒否の記録 | 拒否した操作の内容（例: 締切後に届いた入力の値）を consumer が残したいときは、フックの中で false を返すときに記録する（同期にキューへ積み、書込は非同期で）。受理済み操作の再送ではフックが呼ばれないため、通常の運用で同じ操作の拒否が二重に記録されることはない |
| 判定の切り替え | 判定を変えた後に③'へ到達した操作から効く。変えた時点で既に受理済み（永続化待ち）の操作は有効なまま永続化・配信・`onAccepted` される |
| 診断 | 拒否のたびに `operation-denied`（info・documentId・actorId・operationId・操作の種別）。`onDiagnostic` 未指定なら出さない |
| 複製 | `operation` は参照されたときに複製する（判定に使わない consumer には複製のコストがかからない） |
| 未指定 | 従来どおり（認可段は素通り・追加コストなし） |
| 複数文書 | serve 全体で 1 つ。`documentId` で文書を見分ける |

### 3.3 内部の変更

- `packages/core/src/protocol.ts`: `RejectCode` に `'permission-denied'` を足す（wire の型。protocolVersion は 1 のまま＝decode は任意の文字列を受けるため追加は互換）。
- `packages/server/src/sequencer.ts`: `submit(env, authorize?: (env: ClientOperationEnvelope) => boolean)`。③' で `authorize` が false を返したら `permission-denied` で reject（details なし）。`primaryRejectCode` は検証違反専用のまま。
- `packages/server/src/room.ts`: `Room` の deps に `authorize?: (envelope, connectionId) => boolean` を足し、`handleSubmit` で接続 ID を束縛して sequencer へ渡す。`PersistentRoom` は無改変（`room.handleMessage` に委譲するだけ）。
- `packages/server-hono/src/server.ts`: `createDocumentRuntime` が consumer のフックを包んで Room へ渡す。包みの責務: 擬似接続 `'server'` は判定しない／`true` 厳密判定／throw・不正値の捕捉と診断／返された thenable への rejection ハンドラの取り付け／`operation` の遅延複製／`operation-denied` 診断／フック実行中の目印（serve 全体で共有。`submit`・`addDocument`・`removeDocument`・`stop` がこれを見て reject する）。
- `packages/server-hono/src/{index,serve-types}.ts`: 公開型と `ServeOptions.authorizeOperation`・`ServeRejectCode` の追加。
- `packages/grid/src/error-codes.ts`: `GRID_CONFLICT_CODES` と写像表に `permission-denied` を足す。
- `packages/grid/src/mount-controller.ts`: 補償操作（Undo／Redo）の reject の写像で、拒否コードが `permission-denied` ならそれを優先して通知する（Undo 状態の後始末は従来どおり）。

### 3.4 互換

- 旧クライアント（alpha.10 以前）が新サーバーに繋いで拒否されると、通常の巻き戻し＋`conflict.code: 'unknown'` になる（壊れない）。
- フックを指定しなければ新サーバーの挙動は従来と同じ。

### 3.5 既知の未保証境界（案）

- 判定を切り替えた瞬間に永続化待ちだった受理済みの操作は、切り替えの後に永続化・`onAccepted` される（ミリ秒単位の窓）。「確定の直前に受理した操作」を確定処理より先に確実に永続化させる待ち合わせ（barrier）API は今回入れない。広島の確定は締切中（部署担当は拒否済み）に経営戦略部が `flush()` してから行うため、窓に入るのは別の経営戦略部員の同時入力だけ。
- 判定は同期。DB を引く判定は consumer がメモリへ写してから使う。
- 拒否の通知が切断で届かず、その後サーバーが再起動すると、拒否で消費した clientSequence は永続化されていないため、再接続の突合せでその操作は「未処理」に分かれて再送される。再送の時点で許可されていれば受理される（拒否を知らなかったクライアントから見ると「遅れて受理」）。既存の「再起動で reject・noop の clientSequence 消費が戻る」（DD-015 D27）と同じ類型。確定のように解除しない禁止では起きない。
- envelope の `clientId` が join の `clientId` と違っても照合しない（既存の仕様）。認可の回避には使えない（判定の対象外にするのは擬似接続 `'server'` だけで、接続 ID はサーバーが払い出す）。

### 3.6 テスト計画

- **sequencer unit**: 処理順（受理済み操作の再送は判定せず同じ ACK／clientSequence 違反・baseRevision 違反は判定より先）／拒否で clientSequence を消費し、同じクライアントの次の操作（seq+1）が許可されれば受理される／拒否で revision・operationLog・ackCache が動かない／`authorize` に envelope が渡る。
- **Room unit**: `authorize` に接続 ID が渡る。
- **server-hono（実 WS・ClientSession 2 つ）**: A の SetCells が拒否されると A の view が元に戻り Conflict Queue に `permission-denied`、B には何も届かず、サーバーの revision・oplog は進まない／続けて許可に戻すと A・B とも受理／行の挿入・削除も拒否／`ServerInstance.submit` は判定されない／throw・`true` 以外の戻り値は拒否＋診断で接続は保たれる／**`Promise.reject` を返すフックでもプロセスが落ちず（未捕捉 rejection なし）、診断が出る**／**フック内の `submit`・`addDocument`・`removeDocument`・`stop` は reject され、oplog の revision は連番のまま**／`authenticate` の actorId が渡る／複数文書で `documentId` が文書ごとに正しい／`operation` を書き換えても受理される操作は変わらない／永続化あり（PersistentRoom）でも拒否は oplog に入らず、再起動後も続きの clientSequence で受理される。
- **grid unit**: `toGridConflictCode('rejected', 'permission-denied') === 'permission-denied'`。補償操作（Undo／Redo）の reject の写像関数を切り出し、`permission-denied` が `undo-blocked`／`redo-blocked` より優先されることを検証する。
- **E2E（実ブラウザー 2 つ）**: 開発用サーバー（認可フック＋禁止の切り替え口を持つ dev スクリプト）で、禁止中に A が入力 → A の画面が元に戻り `rejected`（`permission-denied`）、B は変わらない → 禁止を解くと A・B とも入力できる。

## 4. H12 読み取り専用の実行時切替と送り切り（子DD DD-056-2）

### 4.1 公開 API（`@nanairo-sheet/grid`）

```ts
interface GridFlushOptions {
  /** 待つ上限（ミリ秒・既定 10,000）。正の有限数以外は既定値。 */
  readonly timeoutMs?: number;
}
type GridFlushResult =
  /** 編集中のセルは確定済みで、自分の操作はすべてサーバーで受理または拒否された（拒否は rejected イベントで通知済み）。 */
  | { readonly status: 'flushed' }
  /** 上限まで待っても送り切れなかった。editing=true は IME 変換中などで編集中のセルを確定できていない。 */
  | { readonly status: 'timeout'; readonly pendingCount: number; readonly editing: boolean }
  /** 接続が終端した（切断上限超過・divergence）か、待つ間に destroy された。未送信の操作は送られない。 */
  | { readonly status: 'stopped'; readonly pendingCount: number };

interface GridInstance {
  /* …既存 */
  /** 読み取り専用を実行中に切り替える（開き直さない）。 */
  setReadOnly(readOnly: boolean): void;
  /** 自分の未確定の操作の数（サーバーで受理も拒否もまだされていないもの）。単独モード・boot 前は 0。 */
  pendingCount(): number;
  /** 編集中のセルを確定し、自分の操作を送り切るまで待つ。 */
  flush(options?: GridFlushOptions): Promise<GridFlushResult>;
}
```

React（`@nanairo-sheet/react`）:

- `readOnly` prop は識別系から外す。値が変わったら同じ instance の `setReadOnly` を呼ぶ（開き直さない）。他の識別系 props が同時に変わって開き直す場合は、新しい mount が現在の `readOnly` で作られる。
- ref handle に `pendingCount()`・`flush(options)` を足す（mount 前は `0`／`{ status: 'flushed' }`）。`setReadOnly` は handle に出さない（`readOnly` prop で写す。handle で切り替えると prop と食い違うため）。React の型レベル網羅性チェックの除外リストに理由付きで加える。

### 4.2 編集中のセルの確定（`setReadOnly`・`flush` が共有する「確定して移動しない」）

状態機械（`packages/ime/src/editor-state-machine.ts`）は改変しない。grid 層（integration-editor）が状態に応じて既存のイベントを渡す:

| 状態機械の位相 | 確定のしかた |
|---|---|
| `EditingReplace`／`EditingExisting`（変換していない編集） | 状態機械へ `blur` を渡す（Q-4「確定して移動しない」。grid は `remoteUpdate` を流さないため競合マークは立たず、必ず Commit が出る）。続けて実際の blur と同じく候補欄（選択式・日付）を閉じる |
| `EditingAwaitFinalInput`（**変換を確定した直後**） | **Tier 1（Chromium）の通常の状態**。実機（`doc/archived/DD/DD-035/manual-gate-t1-ime-trace.json`）では compositionend の後に非変換の input が来ず、次の Enter か打鍵までこの位相に留まる。ここでの `blur` は「最終 input を待つ」保留になるだけで確定しない（`:538-542`・Codex 設計レビュー P1-2）。そこで **textarea の現在値（変換確定後の実値）を最終 input（`isComposing: false`）として状態機械へ渡し**、続けて `blur` を渡す。保留中のクリック（`pendingNavigation`）があれば、元のセルへ確定してクリック先へ移る（状態機械の既存の遷移） |
| `Composing`（変換中） | 何もしない（textarea に触れない・I-3）。変換が終わるのを待つ（下の「待つ」） |
| `Navigation` | 確定するものはない。候補欄だけ閉じる |

- 最終 input の代わりを渡すのは、**IME イベントとは別のタスク**（consumer の API 呼び出し、または IME イベント後の macrotask）に限る。ブラウザーが compositionend と最終 input を続けて送る順序（順序A・blur が割り込む順序）では、両者は同じタスクで届くため、別タスクの時点で `EditingAwaitFinalInput` に留まっていれば最終 input は来ないと判断できる。
- 「待つ」: 変換中に確定を求められたら、editor の状態が変わるたびに **macrotask（`setTimeout(0)`）で**判定し直す。変換が終わり（`EditingAwaitFinalInput` を含む）変換中でなくなった時点で上の表のとおり確定する（同じタスク内の最終 input を先に処理させる）。

### 4.3 `setReadOnly` の契約

| 項目 | 契約 |
|---|---|
| 対象 | mount オプション `readOnly` の実行時版。抑止する入口・維持する閲覧系は mount オプションと同じ（`readOnlyColumns`・`readOnlyRows`・行データのセル単位 readOnly とは独立に重なる） |
| 開き直さない | 共同編集セッション・未送信の操作・スクロール位置・選択・列幅を保つ。**未送信の操作は通常どおりサーバーへ届く**（拒否されれば `rejected`） |
| true（変換中でない） | §4.2 のとおり編集中のセルを確定し（変換確定直後の `EditingAwaitFinalInput` を含む）、候補欄を閉じてから読み取り専用にする。確定した値は通常の送信経路に乗る（選択式の候補外の値は従来どおり送らずに `value-not-allowed`） |
| true（IME 変換中） | textarea には触れない（I-3）。文書を変える他の入口（貼り付け・行操作・Undo/Redo・候補欄・API の `insertRows` 等）は**すぐに止める**。変換が終わるのを §4.2 の「待つ」で待ち、編集中のセルを確定してから textarea を読み取り専用にする。その間の編集中セルの確定（状態機械が出す Commit）だけは送信の関所を通す |
| false | すぐに編集可能へ戻す（変換の終わり待ちだった切り替えは取り消す）。アクティブセルの `readOnlyColumns`・`readOnlyRows` は従来どおり効く |
| 同値 | 何もしない |
| 診断 | 切り替えごとに `readonly-mode`（info）。変換の終わり待ちに入ったら `readonly-deferred`（info） |
| destroy 後 | 何もしない |
| 両モード | 単独モードでも同じ（pending は常に 0） |
| 注意 | 権限制御ではない（サーバーで止めるのは H11 の `authorizeOperation`） |

### 4.4 `flush` の契約

| 項目 | 契約 |
|---|---|
| 手順 | ① 編集中のセルがあれば §4.2 のとおり確定する（変換確定直後の `EditingAwaitFinalInput` を含む。変換中なら変換が終わるのを待つ）② 自分の未確定の操作が 0 になるのを待つ |
| `flushed` | 編集中のセルがなく（確定済み）、`pendingCount() === 0` になった時点。拒否された操作は `rejected` イベントで通知済み（flush の結果には含めない） |
| `timeout` | `timeoutMs`（既定 10,000）を過ぎた。`pendingCount` はその時点の値、`editing` は確定できていない編集中のセルがあるか |
| `stopped` | 接続が `stopped` になった（切断の上限超過・divergence）か、待つ間に `destroy` された |
| オフライン | 再接続して送り切るのを待つ（上限まで）。切断の上限を超えれば `stopped` |
| 待つ間の入力 | 待つ間に自分が入力を続けると pending が 0 にならず待ち続ける（`timeout` で打ち切る）。提出ボタン等から呼ぶ想定 |
| 単独モード | 編集中のセルを確定してすぐ `flushed` |
| boot 前 | 送るものがないのですぐ `flushed` |
| 並行 | 複数回呼んでよい（それぞれ独立に判定して解決する） |
| reject しない | Promise は reject しない（結果で返す） |
| 判定の実行 | 呼び出し時に 1 回判定し、以後は状態の変化（pending・接続・編集）を受けて macrotask で判定し直す（ClientSession のメッセージ処理中・editor のイベント処理中に確定を走らせない＝再入しない。同じタスクで続く IME イベントを先に処理させる＝§4.2） |

`pendingCount()`: 共同編集モードは `ClientSession.pendingCount`（ACK 済みで echo 待ちを含む）。単独モード・boot 前・destroy 後は 0。

### 4.5 既存の不具合（ゲートで DD-056-2 で直すと決定）: 変換確定の直後のクリック・グリッド外クリックが確定されない

§4.2 の実読で見つけた、DD-056 より前からある不具合。Tier 1（Chromium）で日本語を変換して Enter で確定した直後（`EditingAwaitFinalInput`）に:

- **別のセルをクリック**すると、状態機械は `pendingNavigation` を立てるだけで確定も移動もしない（次の打鍵か Enter まで、編集欄が元のセルに残る）。
- **グリッドの外をクリック**（提出ボタン等）すると、`blur` は保留になるだけで確定しない。consumer がそのまま状態を変える（提出する）と、確定していない入力は送られない。

再現は状態機械だけで決定的に起きる（compositionstart → input(isComposing) → compositionend → pointerdown/blur → 何も確定しない。最終 input の代わりを渡すと Commit＋MoveTo が出る）。
E2E の synthetic IME は順序A（compositionend → 非変換の input）を流すため、これまで自動テストに現れなかった。

H12 の `flush`・`setReadOnly` は §4.2 で自前に確定させるため、この不具合の影響を受けない（提出ボタン→`flush()` の流れは守られる）。
クリックそのものの不具合は H11〜H13 の外だが、ゲートで **DD-056-2 で直す**と決めた。直し方: 実際の `pointerdown`・`blur` を
`EditingAwaitFinalInput` で受けたら macrotask を予約し、その時点でもまだ同じ位相なら §4.2 と同じ「最終 input の代わり」を渡す
（同じタスクで最終 input が届く順序では何もしない）。IME の経路（クリック・blur 時の確定）を変えるため、実 IME の確認（T1・推奨）の対象になる。
修正後の期待: 変換確定の直後に別セルをクリック → 元のセルへ確定してクリック先へ移る／グリッド外をクリック → 確定して移動しない（Excel 準拠・Q-4）。

### 4.6 内部の変更

- `mount-controller.ts`: `readOnly` を可変にする。`setReadOnly`・`pendingCount`・`flush` を実装する。変換の終わり待ち（deferred）の状態と、その間に状態機械が出す編集中セルの確定だけを送信の関所で通す許可（`editorSubmit` 経由の呼び出しに限る）を持つ。描画（▼・📅 の表示条件）とセルロックの同期を切り替え時にやり直す。判定の予約（macrotask）は destroy で取り消す。
- `integration-editor.ts`: `setReadOnly(boolean)`（textarea の `readOnly` 属性＝`readOnly || 列ロック` と、編集 DOM イベントの遮断を可変にする。変換中は呼ばない）と `commitEdit()`（§4.2 の表。**IME 状態機械は改変しない**）を足す。
- `index.ts`: 公開型（`GridFlushOptions`・`GridFlushResult`）と `GridInstance` のメソッド、`readOnly` の JSDoc を「実行時は `setReadOnly`」に更新。
- `packages/react/src/index.ts`: §4.1 の写像。`readOnly` の JSDoc を「変わっても開き直さない」に更新。

### 4.7 テスト計画

- **grid unit（node）**: `ime-editing-session`＋状態機械を使い、§4.2 の各位相（変換していない編集・**順序B の変換確定直後**・保留中のクリックあり・変換中）で `commitEdit` 相当が正しい値とセルで確定する（変換中は確定しない）ことを検証する。flush の判定関数を切り出して状態ごとの結果を検証する。
- **E2E（実ブラウザー・統合ページ）**: `setReadOnly(true)` で編集中の値が確定・送信され、以後は入力・貼り付け・Delete・行操作が効かない／`setReadOnly(false)` で戻る／**順序B の synthetic composition**（compositionend の後に非変換の input を流さない）の直後に `setReadOnly(true)`・`flush()` → 確定値が送られる／変換中（compositionend 前）に `setReadOnly(true)` → 変換が終わるまで textarea は触られず、終わった後に値が送られて読み取り専用になる／オフラインで入力 → `setReadOnly(true)` → 再接続で届く（開き直していない）／`flush()` が ACK 後に `flushed`、オフライン中は `timeout`／React: `readOnly` prop を変えても instance が変わらず未送信が残る（React E2E）。
- **React unit（jsdom・grid を mock）**: `readOnly` の変更で remount せず `setReadOnly` が呼ばれる／他の識別系の変更では従来どおり remount し新しい mount に現在の `readOnly` が渡る／handle の `pendingCount`・`flush` が直結し、mount 前は `0`・`flushed`。既存の「`readOnly` 変更で remount」を前提にした DD-035 のテストは本DDの変更として更新する。
- **実 IME（T1・推奨・クローズ非ブロック）**: 変換確定の直後に `flush()`／`setReadOnly(true)` → 確定値が送られる（Microsoft IME・Chrome）。§4.5 を直す場合は、変換確定直後のセルクリック・グリッド外クリックの確定も見る。

## 5. H13 実行中の文書の追加と撤去（子DD DD-056-3）

### 5.1 公開 API（`@nanairo-sheet/server-hono`）

```ts
interface ServerInstance {
  /* …既存 */
  /** 実際に serve 中の文書 ID（**読むたびに最新**。addDocument / removeDocument を反映する）。 */
  readonly documentIds: readonly string[];
  /** 起動時の復旧に失敗して外した文書（読むたびに最新。addDocument で同じ ID を足し直せたら外れる）。 */
  readonly quarantined: readonly ServeQuarantinedDocument[];
  /** 実行中に文書を足す。復旧（保存先に履歴があれば続きから）・初期文書の作成まで済んだら解決する。 */
  addDocument(documentId: string, config: ServeDocumentConfig): Promise<void>;
  /** 実行中に文書を外す。接続を切り、受理済みの操作の永続化・配信を待ってから保存先を閉じて解決する。 */
  removeDocument(documentId: string): Promise<void>;
}
```

### 5.2 契約

| 項目 | 契約 |
|---|---|
| addDocument | 構成の検証・保存先の復旧・初期文書（`initialDocument`／`seedRows`）は起動時の文書と同じ。解決後は `?documentId=` で接続でき、`submit({ documentId })` が使える。単一文書・複数文書のどちらの構成でも使える（足した文書への接続は `?documentId=` 必須＝申告の documentId を厳格に照合） |
| addDocument の拒否 | 空の ID／serve 中の ID／追加・撤去の処理中の ID／`stop()` 後は Promise reject。復旧の失敗も reject（検疫には入れない・開いた保存先は閉じる） |
| removeDocument の手順 | ① 登録から外す（以後の upgrade・`/config`・`/snapshot` は 404、`submit` は reject）② その文書の RoomBridge に**撤去の印を立て、以後に届くフレームをすべて捨てる**（未 join の接続・切断ハンドシェイク中に届いた join・submitOperation を含む。印を立てずに切るだけでは、切断中に届いていた join で旧 Room へ再参加・投入できる＝Codex 設計レビュー P2-1）③ その文書の接続をすべて切る（close code 1001）④ その文書の受理済みの操作の永続化・配信・`onAccepted` が済むのを待つ ⑤ 保存先を閉じる（**実行中の snapshot 生成の終了を待ち、新しい生成を始めさせない**＝P2-2）⑥ 解決 |
| upgrade との競合 | 認証の待ちや WebSocket の handshake の途中で撤去された接続は、handshake の完了時に登録簿を引き直し、外れていれば 1001 で閉じる（撤去した文書の RoomBridge へ接続を付けない） |
| 撤去後のクライアント | 再接続は 404 で失敗し続け、未送信の操作は送られない（切断の上限を超えると `stopped`）。**外した文書への再送は受け付けない** |
| 保存先 | 消さない。同じ保存先で `addDocument` し直すと続きから復旧する（同じ ID で足し直せば古い接続の再送も受け付ける＝別の版は別の ID にする） |
| removeDocument の拒否 | serve していない ID／追加・撤去の処理中の ID／`stop()` 後は Promise reject。既定文書も外せる（外した後の documentId なしの接続は 404・起動時の検疫と同じ） |
| stop との競合 | `stop()` は処理中の追加・撤去が終わるのを待ってから閉じる。`stop()` の後に復旧を終えた追加は、作った文書を閉じて reject する |
| 診断 | `document-added`・`document-removed`（info） |

### 5.3 内部の変更

- `server.ts`: 登録簿（`runtimes`）を実行中に変える。`addDocument`・`removeDocument`・処理中の ID の予約・`stop()` との待ち合わせ。`RoomBridge` に「撤去の印（以後のフレームを捨てる）」「全接続を切る」「受理済みの配信が済むのを待つ」を足す。upgrade の handshake 完了時に登録簿を引き直す。
- `packages/server/src/persistent-room.ts`: `close()` で新しい snapshot 生成を止め、実行中の生成（`writeSnapshot`）の終了を待ってからストアを閉じる（`stop()` にも効く既存の穴の修正）。
- `index.ts`: `documentIds`・`quarantined` を getter にし、`addDocument`・`removeDocument` を写す。
- consumer ストアの adapter（`serve-adapters.ts`）の `close` が直列化キューの完了を待つようにする（撤去・停止で append の途中に close しない）。
- 既存の `RoomBridge.closeSocket`（不正 JSON・文書不一致などでの切断）も、切った接続から後で届いたフレームを捨てるようにする（②と同じ穴。切断ハンドシェイク中の join で再参加できる）。

### 5.4 テスト計画

- **server-hono（実 WS・ClientSession）**: 実行中に足した文書へ 2 クライアントが参加して収束する／外すと接続が切れ、再接続は 404・`submit` は reject／外す前に受理した操作は oplog に入り `onAccepted` が届いてから解決する／同じ保存先で足し直すと続きの revision から復旧する／ID の重複・処理中・stop 後の拒否／stop と追加・撤去の競合で保存先のハンドルが残らない／`documentIds` が追加・撤去を反映する。
- **撤去の受信停止（P2-1）**: 撤去と同時に届いた join・submitOperation（未 join の接続・切断ハンドシェイク中のフレーム）が旧 Room に入らない（RoomBridge を直接駆動する unit で、撤去の後にフレームを流して確かめる）。
- **snapshot との競合（P2-2）**: snapshot の保存を遅らせた状態で撤去 → 撤去は保存の終了を待ってから解決し、解決の後にストアへの書込が起きない／同じ ID・同じ保存先での再追加が成功する。
- ブラウザー E2E は足さない（クライアント側の新しいコードがない。接続の拒否は既存の DD-043 E2E が見ている）。

## 6. 子DD分割と配布

| 子DD | 内容 | Risk | 配布 |
|---|---|---|---|
| DD-056-1 | H11 操作ごとの書込の認可 | A（sequencer の処理順・protocol の拒否コード・公開 API） | alpha.11 |
| DD-056-2 | H12 読み取り専用の実行時切替と送り切り（ゲートで決めれば §4.5 の既存不具合の修正も） | A（編集中・変換中の確定と読み取り専用の切替。IME 状態機械は改変しない。実 IME の T1 は推奨・クローズ非ブロック） | alpha.11 |
| DD-056-3 | H13 実行中の文書の追加と撤去 | A（永続化の close 順序・接続の切断） | alpha.12 |

## 7. 製品化6観点

1. 公開 API: server-hono・grid・react への追加のみ（Experimental）。protocol は拒否コードの追加のみ（protocolVersion 据え置き）。
2. 境界: Facade（server-hono・grid・react）経由のみ。公開型は Facade 自身で定義する（R7）。
3. 再利用性: 認可は consumer のフックで、SDK は役割・権限のモデルを持たない（広島固有の型を入れない）。
4. 拡張性: 行・列の権限（H7）も同じ `authorizeOperation` で書ける。
5. DX: CHANGELOG・`features.json`・quick-start（認可フックと読み取り専用の切替の例）・公開コード一覧（`doc/archived/DD/DD-017/error-codes.md`）を更新する。
6. 互換: 公開型は追加のみ。React の `readOnly` が開き直さなくなる挙動の変化を CHANGELOG の Changed に書く。
