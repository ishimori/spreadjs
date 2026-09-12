# DD-049 公開 API 契約（H2 受理通知・H4 remote-change・H5 presence ＋ React 写像）

> 本DDで確定した公開面の正本（DD本文「決定事項」から参照）。実装の JSDoc（`packages/server-hono/src/{index,serve-types}.ts`・
> `packages/grid/src/index.ts`・`packages/react/src/index.ts`）と公開 .d.ts snapshot（`tests/contract/__snapshots__/facade-surface.test.ts.snap`）が
> 機械的な写し。乖離したら本ファイルを直す。すべて Experimental 0.x・**追加のみ**（既存シグネチャの変更・削除なし）。
> sequencer・protocol（wire メッセージ）・永続化形式は**無改変**（Phase 1 実読で確定・§6）。

## 1. 決定（Human Spec Gate 論点 1〜6・推奨案で代行確定 2026-09-12）

| # | 決定 | 補足 |
|---|------|------|
| 1 | H2 は durable 解決＋ACK/broadcast dispatch の**後**に fire-and-forget（案 a） | 受理判定は sequencer の責務のまま（consumer に拒否権なし）。hook の throw / reject は診断 warn `on-accepted-error` に閉じる |
| 2 | H4 は自分の ACK 済み op も含め `origin: 'local' \| 'remote' \| 'server'` で区別（案 b） | committed に入った時点だけ通知。rollback された楽観適用は通知しない |
| 3 | H3（変更者の可視化）は子DD **DD-049-1** へ分離（案 c） | セル単位書式モデル（stage2-backlog §3.5）と Presence 描画の重なり順を別途決める |
| 4 | H5 はイベント＋handle `presences()`（案 b） | React は callback＋handle 直結（React state へ複製しない・DD-025） |
| 5 | H1 数式は DD-022 待ち（案 b） | consumer は H2＋`ServerInstance.submit` でつなぐ |
| 6 | 単一DD（H2/H4/H5/H8）＋H3 は DD-049-1 | レビューゲートは完了後の Codex 1 回（DD-035 前例） |

## 2. H2 受理通知フック（`@nanairo-sheet/server-hono`）

```ts
interface ServeAcceptedCellChange {
  readonly rowId: string;
  readonly columnId: string;
  /** この変更で書き込まれた値。 */
  readonly value: ServeCellScalar;
  /** この変更を適用する直前の値（未書込セルは { kind: 'blank' }）。同じ op 内で同一セルを複数回書くと直前の書込後の値。 */
  readonly previousValue: ServeCellScalar;
}
type ServeAcceptedOrigin = 'client' | 'server';
interface ServeAcceptedEvent {
  readonly documentId: string;
  readonly revision: number;
  readonly actorId: string;
  readonly origin: ServeAcceptedOrigin;
  /** 受理 envelope（oplog へ追記される形と同じ・複製）。 */
  readonly envelope: ServeOperationEnvelope;
  /** SetCells のセル変更（envelope.operation.changes と同順）。insertRows / deleteRows は空配列。 */
  readonly changes: readonly ServeAcceptedCellChange[];
}
type ServeAcceptedHook = (event: ServeAcceptedEvent) => void | Promise<void>;
interface ServeOptions { /* …既存 */ readonly onAccepted?: ServeAcceptedHook }
```

| 項目 | 契約 |
|---|---|
| 呼ばれる条件 | revision を消費した受理 1 件につき 1 回。WebSocket 接続の op（`origin: 'client'`）と `ServerInstance.submit`（`origin: 'server'`）の両方。insertRows / deleteRows も通知する（`changes` は空） |
| タイミング | 永続化あり: `append` 解決（durable）→ ACK/operations の配信 → hook。永続化なし: 受理 → 配信 → hook。`submit()` 起点は hook の後に `submit` の Promise が解決する（永続化なしでは `submit` の呼び出し中に配信・通知が済む。hook の中から呼んだ場合は実行中の通知が終わった後） |
| 順序 | 文書ごとに revision 昇順。受理（revision 消費）の配信（ACK/operations）と通知は Room へ投入した順で行う（接続の op・`submit` 起点・hook 内の `submit`・同じ data チャンクで届いた連続フレームが混ざっても revision 順・Codex P1）。revision を消費しない応答（OCC reject・noop・再送の duplicate ACK）は先行 op の durable 化を待たずに返す（従来どおり・Codex 第 2 回 P1）。複数文書 serve では `documentId` が文書ごとに正しい（文書をまたぐ順序は規定しない） |
| 呼ばれない | reject（OCC 等）／noop（revision 非消費）／再送の duplicate ACK／seed・`initialDocument`（listen 前）／durable 失敗（`append` reject）／catch-up・bootstrap による再配布 |
| `actorId` | `authenticate` 指定時はサーバーが確定した利用者 ID（申告値ではない）。`submit` は `options.actorId` |
| 前値 | op 適用直前の権威文書から算出する（文書は copy-on-write のため submit 直前の参照を保持するだけ）。同一 op 内の同一セル複数書込は逐次（core `applyOperation` の ChangeSet と同じ意味） |
| 複製 | `envelope` は受理 envelope の複製。hook 内で書き換えても SDK の operationLog・配信・永続化に影響しない |
| 待たない | hook の戻り値（Promise）は await しない（遅い hook が後続の受理を遅らせない） |
| 失敗 | 同期 throw・返した Promise の reject とも診断 `on-accepted-error`（warn・メッセージに revision と例外の name/message）。`onDiagnostic` 未指定なら `console.error`。受理・配信・永続化・他接続・後続の通知には影響しない。文字列化できない値（null prototype 等）を throw/reject しても診断の組み立て自体は throw しない（Codex P2） |
| 再入 | hook 内で `ServerInstance.submit` を呼んでよい（別 revision として受理され、実行中の hook が戻った後に `origin: 'server'` で通知される＝hook が入れ子に呼ばれることはない。複数文書 serve で別文書へ submit しても同じ＝配信ループは serve 全体で 1 本・Codex 第 2 回 P2）。**無限ループ防止は consumer 責務**（`origin === 'server'` や自分の `actorId` を無視する・DD-026 論点⑥と同じ） |
| 未指定 | 受理経路に追加コストなし（前値の参照捕捉も行わない） |
| stop | `stop()` 実行中に durable 化を終えた受理は通知されうる |

診断コード追加（`ServeDiagnostic.code`）: `on-accepted-error`（warn）。

## 3. H4 他者変更イベント（`@nanairo-sheet/grid`）

```ts
type GridRemoteChangeOrigin = 'local' | 'remote' | 'server';
interface GridRemoteChange {
  readonly origin: GridRemoteChangeOrigin;
  /** サーバー付与の revision（文書内で一意・昇順）。 */
  readonly revision: number;
  /** 受理 envelope の actorId（authenticate 指定時はサーバー確定値）。 */
  readonly actorId: string;
  /** cell-commit と同じ形（表示文字列の前後値・op の changes 順）。 */
  readonly changes: readonly GridCellCommitChange[];
}
type GridEvent = /* …既存 */ | { readonly type: 'remote-change'; readonly change: GridRemoteChange };
```

| 項目 | 契約 |
|---|---|
| 発火 | 共同編集モードで、サーバー確定（受理済み）の **SetCells** が committed に入るたび 1 op＝1 回・revision 昇順 |
| origin | 自分の clientId の op＝`'local'`（自分の確定は ACK 後の echo で届く）／予約 clientId `'server'`（`ServerInstance.submit`）＝`'server'`／それ以外＝`'remote'`（同じ利用者の別タブも `'remote'`） |
| 値 | `value`/`previousValue` は表示文字列（`cell-commit` と同じ・内部 CellScalar は出さない＝R7）。前値は committed 上の適用直前の値 |
| タイミング | 1 サーバーメッセージの処理（committed 適用・rollback/replay・Render State の dirty 立て）が**終わった後**にまとめて配る。listener から命令 API（`setActiveCell` 等）を呼んでも整合した状態を読む。同じメッセージの処理中に同期で発火する `rejected`・`pending` より後に届く |
| 発火しない | 単独グリッドモード（`cell-commit` は従来どおり）／楽観適用のまま rollback・reject された op／snapshot bootstrap で確立した状態（fresh join・1,000 revision 超の差分がある再接続）／insertRows・deleteRows（行構造は対象外） |
| 既存イベント | `cell-commit`・`row-structure-change`・`connection`・`pending`・`rejected`・`divergence` の発火条件は不変 |

## 4. H5 参加者一覧（`@nanairo-sheet/grid`）

```ts
interface GridCellAddress { readonly rowId: string; readonly columnId: string }
interface GridPresenceUser {
  /** 利用者 ID。他者は presence の userId（authenticate 指定時はサーバー確定の actorId）。自分は grid の clientId。 */
  readonly userId: string;
  readonly displayName: string;
  /** アクティブセル（編集中は編集セル）。presence 未送信なら null。 */
  readonly activeCell: GridCellAddress | null;
  /** この grid インスタンス自身なら true。 */
  readonly self: boolean;
}
type GridEvent = /* …既存 */ | { readonly type: 'presence'; readonly users: readonly GridPresenceUser[] };
interface GridInstance { /* …既存 */ presences(): readonly GridPresenceUser[] }
```

| 項目 | 契約 |
|---|---|
| 構成 | 先頭に自分（`self: true`）、続いて他者をサーバーから届いた順に 1 接続 1 件（同じ利用者の複数タブは別エントリ） |
| 自分が載る時期 | 最初の join 完了（welcome 受信）以降。それ以前は `[]` |
| 変化時のみ発火 | 一覧（順序・userId・displayName・activeCell・self）が直前に配った一覧と異なるときだけ `presence` を発火する。契機: 他者の presence 受信（参加・移動・切断・TTL 失効）／自分のアクティブセル移動／join |
| タイミング・現在値 | 他者の変化はサーバーメッセージの処理後に、自分のアクティブセル移動は editor の処理が終わった直後（マイクロタスク・同じタスク内の連続移動は 1 回にまとめる）に発火する。`presences()` は呼び出し時点の一覧で、イベントを受け取った時点では直近の `users` と一致する |
| 他者の除外 | サーバーの presence 管理に従う（切断は即時、無通信は TTL 15 秒で除外）。**自分が切断中は最後に知っていた一覧を保持する**（グリッド上の他者の枠と同じ扱い。オンライン判定は `connection` と併用する） |
| 単独モード | 常に `[]`・`presence` は発火しない |
| boot 前・destroy 後 | `[]` |

## 5. React 写像（`@nanairo-sheet/react`）

```ts
interface NanairoSheetViewCommonProps {
  /** GridEvent 'remote-change' の写像（callback 系＝差し替えで remount しない）。 */
  readonly onRemoteChange?: (change: GridRemoteChange) => void;
  /** GridEvent 'presence' の写像（callback 系）。 */
  readonly onPresenceChange?: (users: readonly GridPresenceUser[]) => void;
}
interface NanairoSheetViewHandle {
  /** GridInstance.presences 直結。未 mount 時は []（connectionState と同じく warn しない）。 */
  presences(): readonly GridPresenceUser[];
}
```

`onEvent` には従来どおり全種別（`remote-change`・`presence` を含む）が素通しで届く。

## 6. 内部設計の要点（Phase 1 実読の結果・実装者判断）

1. **H2 は `RoomBridge`（server-hono）だけで閉じる。** 受理経路は `route()`（接続の submitOperation）と `submitFromServer()`（`submit`）の 2 つで、
   どちらも `room.handleMessage` → `dispatch` を通る。受理は Room が返す Outbound の「target=all の operations」でだけ判定できる
   （reject/noop/duplicate は送信元宛ての ACK/reject のみ）。PersistentRoom は `append` 解決後に Outbound を返すため、dispatch の直後に
   hook を呼べば「durable・配信後」が構造的に成立する。Room / Sequencer / PersistentRoom は無改変。
   **配信順（Codex P1 で追加）**: 両経路の submitOperation の Outbound は RoomBridge の FIFO（Room へ投入した順）で dispatch → 受理通知する。
   同期の Room（永続化なし）は投入直後に、PersistentRoom は durable 化後に settle し、先頭から順に配る。当初の `submitFromServer` は同期 Room の
   結果にも `await` していたため、同じ data チャンクで続いたクライアント op が先に配信・通知され、revision 順が崩れていた
   （hook 内の submit では 2→4→3）。
   **第 2 回で精緻化**: 先行の未 settle 件を越えないのは**受理（target=all の operations）を含む件だけ**で、revision を消費しない応答
   （reject・noop・duplicate ACK）と失敗は settle しだい配る（当初の FIFO は先行 op の append 待ちで reject 応答まで止めていた＝従来挙動からの
   退行・Codex 第 2 回 P1）。配信ループは serve 全体で 1 本（`SubmitDeliveryLoop`）で、各文書の RoomBridge は「配れる 1 件を配る」手順を登録する。
   どの文書の hook 実行中に積まれた配信も実行中のループが続けて配るため、別文書への submit でも hook は入れ子にならない（第 2 回 P2）。
2. **前値**: Sequencer は `applyOperation`（入力を clone して新文書を返す）で `state.document` を差し替える＝copy-on-write。
   `room.handleMessage` の直前に `sequencer.document` の参照を捕捉すれば O(1) で op 適用前の文書が得られる（async の PersistentRoom でも
   submit は最初の await より前に同期実行される）。hook 未指定なら捕捉しない。
3. **H4 は `ClientSession.reconcileServerOperation`（committed へのサーバー op 適用の唯一の地点）で通知する。** 既存の `SessionEvent`
   ではなく**専用の opt-in callback** `onCommittedOperation` にする（`SessionEvent` へ足すと grid の `toGridEvent` 網羅と
   `lastEventType` の意味が変わり、既存の observer 利用者へ波及するため）。`applyOperation` の ChangeSet（before/after）をそのまま渡す＝
   追加の文書走査なし。rollback/replay のアルゴリズムは無改変（通知の 1 行追加のみ）。bootstrap は committed を丸ごと差し替えるため
   op 単位の差分が無い＝通知しない（境界）。
4. **配るタイミング**: grid は `onCommittedOperation` をキューに積み、SessionSync の observer が Render State の dirty を立て終えた直後
   （`onServerMessageSettled`）に `remote-change` として配る。presence の再計算も同じ地点で行う。
5. **H5** は `ClientSession.knownPresences()`（他者）＋ grid が送った自分の presence（editor の `onPresenceChange`）から組み立て、
   直前に配った一覧と構造比較して変化時だけ発火する（純関数 `presence-list.ts`）。自分の移動による再計算は IME 状態機械のイベント処理や
   サーバー更新の反映の途中から呼ばれるため、マイクロタスクへ遅らせて listener の命令 API 呼び出しと editor の処理を競合させない。
6. **R7**: 公開型（`GridRemoteChange`・`GridPresenceUser`・`GridCellAddress`・`ServeAccepted*`）は Facade 自身で定義し、内部の
   `UserPresence`/`ChangeSet`/`ServerOperationEnvelope` は出さない。

## 7. テストシナリオ（TDD・自然言語）

### H2（`packages/server-hono/src/serve-on-accepted.test.ts`）
- S1 永続化あり・append を保留中はクライアントの ACK も hook も出ない。解放すると ACK 後に hook が 1 回、documentId/revision/actorId/origin=client/changes（前後値）付きで届き、envelope は oplog の entry と一致する。
- S2 保留中に同じセルへ 2 op（'1' → '2'）→ 解放後の 2 回の通知で previousValue が blank → '1'（op ごとの適用直前の値）。同一 op 内の同一セル複数書込は逐次。数値・日付の kind を保つ。
- S3 `submit()` は origin=server・actorId=options.actorId で、hook の後に submit の Promise が解決する。
- S4 hook の同期 throw・async reject は診断 `on-accepted-error`（warn）になり、ACK・配信・次の受理と通知は継続する（未処理 rejection を出さない）。
- S5 複数文書 serve で文書ごとに正しい documentId。OCC reject（submit・クライアント op）は通知されない。
- S6 insertRows / deleteRows は changes 空で通知。既に削除済み行の再 delete（noop）と同一 operationId の再送（duplicate）は通知されない。
- S7 hook 内の `submit`（origin=client のときだけ）は別 revision で受理され origin=server で通知される（ループしない）。
- S8 hook が envelope を書き換えても、切断中に進んだ op を再接続の tail catch-up で受け取るクライアントの値は元のまま。
- S9 onAccepted 未指定の既存 serve は挙動不変（既存スイート無修正 green）。
- S9（Codex P1）同じ data チャンクで届いた連続 2 フレームの 1 件目の hook から `submit` → 通知と operations 配信がともに revision 順（2 client → 3 server → 4 client）。前提（2 フレームが同じ同期区間で処理された）を 1 件目の hook で積んだマイクロタスクが 2 件目の hook 時点で未実行であることで確かめ、成立しない試行はやり直す（偽 green を防ぐ・第 2 回 P3）。
- S10（Codex P2）hook が null prototype の値を throw／reject → 診断 `on-accepted-error` に閉じ、`submit` は受理で解決し、未処理 rejection を出さない。
- S11（第 2 回 P1）永続化ありで先行 op の append を保留中でも、OCC reject（サーバー起点・クライアント op）は解放前に返る（onAccepted 未指定でも）。
- S12（第 2 回 P2）複数文書 serve で文書 A の hook から文書 B へ submit → `start:A → end:A → start:B → end:B → B の submit 解決` の順（hook は入れ子にならない）。

### H4
- C1（collab）他クライアントの SetCells → `onCommittedOperation` が 1 回、callback 内で committed は当該 revision・ChangeSet に before/after。
- C2（collab）自分の op は楽観適用中は届かず、echo で committed に入った時点で届く。reject・revalidation-failed で消えた op は届かない。
- C3（collab）bootstrap（fresh join）では届かず、その後の tail op は届く。重複配信は 1 回・順不同到着は revision 昇順。再接続 tail catch-up の op は届く。
- G1（grid 純関数）SetCells → `GridRemoteChange`（表示文字列・origin local/remote/server）、insertRows/deleteRows → 対象外。
- G2（grid SessionSync）`onServerMessageSettled` は session 適用・dirty 立ての後に呼ばれる。
- E1（E2E・2 クライアント）B の確定 → A に origin=remote・actorId=B・値は A の committed と一致。B 自身には origin=local。
- E2（E2E・単独ページ）確定で cell-commit は出るが remote-change / presence は出ず、`presences()` は `[]`。

### H5
- P1（grid 純関数）自分先頭・他者は順序保持・activeCell 無しは null。一覧の比較は順序・各フィールドの差を検出する。
- E3（E2E）B の参加・セル移動・切断が A の presence イベントに順に反映され、`presences()` と最後のイベントが一致。自分は self=true。

### React（`packages/react/src/nanairo-sheet-view.dd049.test.ts`）
- R1 `remote-change` → onRemoteChange(change)、`presence` → onPresenceChange(users)、onEvent には全種別。
- R2 callback 差し替えで remount しない。
- R3 handle.presences は GridInstance へ直結、未 mount 時は [] で warn しない。
