# DD-026 公開契約案（U1〜U3）— Phase 1 成果物

> 対象: `@nanairo-sheet/server-hono` の `serve()` / `ServerInstance`（Experimental 0.x）。論点①〜⑥（DD 本文）を**推奨案で確定**した前提で、
> 型・fail-fast 条件・内部設計の要点・テストシナリオを固定する。実装は子 DD 26-1〜26-3。

## 1. 決定（論点①〜⑥・要確認④）

| # | 決定 | 補足 |
|---|------|------|
| ① | `serve({ oplog, snapshotStore })` に実装を渡す（案 a） | 両方同時指定が必須。`persistenceDir` との併用は config error |
| ② | `initialDocument: () => Promise<ServeInitialDocument>`（案 b） | **snapshot も oplog も無いときだけ**呼ぶ。復旧できる状態があれば呼ばない |
| ③ | HTTP upgrade 時に `authenticate(request)`（案 a） | null は 401 で拒否。throw は 500 で拒否（通さない）。受理後は envelope `actorId`・presence `userId`/`displayName` をサーバーが上書き。`clientId` は申告維持 |
| ④ | `ServerInstance.submit(setCells, { actorId })` は通常受理経路（案 a） | `clientId='server'` 固定・`clientSequence` は Sequencer の表から継続・`baseRevision`=現 revision。永続化後に配信 |
| ⑤ | 子 DD 3 分割（26-1 / 26-2 / 26-3） | Codex は全差分まとめて 1 回（26-3 を含むため xhigh） |
| ⑥ | 無限ループ防止は consumer 責務 | envelope `actorId`/`clientId='server'` で再評価を抑止できる。quick-start に注意書き |
| 要確認④ | KPI-4 は採取不能 | consumer は DD-009 で導入済み（初回導入でない）。台帳 §3.1 へ「採取不能・理由」を記録し統合②で採取 |

## 2. 公開型（`packages/server-hono/src/serve-types.ts`・R7 準拠＝内部 package の型を参照しない）

```ts
// ---- 値・操作（wire 形式の公開ミラー。内部 core と構造同一・ID は string）----
type ServeCellScalar = { kind: 'blank' } | { kind: 'string'; value: string } | { kind: 'number'; value: number } | { kind: 'date'; value: string /* YYYY-MM-DD */ };
interface ServeSetCellsChange { rowId: string; columnId: string; beforeRevision?: number; value: ServeCellScalar }
interface ServeSetCellsOperation { type: 'setCells'; changes: readonly ServeSetCellsChange[]; conflictPolicy: 'reject-overlap' }
interface ServeInsertRowsOperation { type: 'insertRows'; afterRowId: string | null; rows: ReadonlyArray<{ rowId: string; height?: number }> }
interface ServeDeleteRowsOperation { type: 'deleteRows'; rowIds: readonly string[] }
type ServeDocumentOperation = ServeSetCellsOperation | ServeInsertRowsOperation | ServeDeleteRowsOperation;
interface ServeOperationEnvelope { protocolVersion; documentId; operationId; transactionId; actorId; clientId; clientSequence; baseRevision; operation; revision; acceptedAt; canonicalOperation }

// ---- U1 ----
interface ServeOpLogStore { append(entries: readonly ServeOperationEnvelope[]): Promise<void>; readAll(): Promise<{ entries: readonly ServeOperationEnvelope[]; discardedTornRecords?: number }>; close(): Promise<void> }
interface ServePersistedSnapshot { formatVersion: number; documentId: string; revision: number; createdAt: string; snapshot: object /* 不透明 */; checksum: string }
interface ServeSnapshotStore { save(s: ServePersistedSnapshot): Promise<void>; loadLatest(): Promise<ServePersistedSnapshot | undefined>; close(): Promise<void> }
interface ServeInitialDocument { rows: ReadonlyArray<{ rowId: string; cells?: Readonly<Record<string, ServeCellScalar>> }> }

// ---- U2 ----
interface ServeAuthRequest { url: string; headers: Readonly<Record<string, string | readonly string[] | undefined>> }
interface ServeIdentity { actorId: string; displayName: string }
type ServeAuthenticate = (request: ServeAuthRequest) => Promise<ServeIdentity | null> | ServeIdentity | null;

// ---- U3 ----
interface ServeSetCellsInput { type: 'setCells'; changes: readonly ServeSetCellsChange[] }
type ServeSubmitResult = { status: 'accepted'; operationId: string; revision: number } | { status: 'rejected'; operationId: string; code: ServeRejectCode };

// ---- ServeOptions 追加 / ServerInstance 追加 ----
interface ServeOptions { …既存; oplog?: ServeOpLogStore; snapshotStore?: ServeSnapshotStore; initialDocument?: () => Promise<ServeInitialDocument> | ServeInitialDocument; authenticate?: ServeAuthenticate }
interface ServerInstance { …既存; submit(operation: ServeSetCellsInput, options: { actorId: string }): Promise<ServeSubmitResult> }
```

- `append` の契約: **解決＝durable**（consumer は投影を同じトランザクションへ入れる）。reject（例外）は当該 op を破棄し、以降の write を停止する（既存 PersistentRoom の poisoning）。
- `readAll` は revision 昇順・1..N 連番であること（既存 fail-fast がそのまま検査する）。
- `ServePersistedSnapshot.snapshot` は SDK 内部形式で**不透明**（consumer は JSON として保存し、そのまま返す。中身を読み書きしない）。
- 診断コード追加（`onDiagnostic`）: `auth-rejected`（warn・null 返却）/ `auth-error`（error・hook の throw）。Cookie 等の値は載せない。

## 3. fail-fast 条件（`serve()` の reject）

| 条件 | メッセージ要旨 |
|------|---------------|
| `oplog` と `snapshotStore` の片方だけ | 両方指定が必要 |
| `persistenceDir` と `oplog`/`snapshotStore` の併用 | 併用不可（保存先は 1 つ） |
| `initialDocument` と `seedRows` の併用 | 併用不可（初期内容の供給元は 1 つ） |
| `initialDocument` の行 ID 重複・空 / `columnOrder` 外の列 | 初期文書が不正（黙って捨てない） |
| 初期文書の snapshot@0 保存に失敗 | 起動失敗（保存できない状態で受け付けない） |
| `submit` の `changes` 空 / `actorId` 空 | Promise reject（同期 throw しない＝常に Promise 契約） |
| `stop()` 後の `submit` | reject（server stopped） |
| `clientId: 'server'`（予約語）で join | 1008 で切断（サーバー起点操作の clientSequence 表を共有させない） |

## 4. 内部設計の要点（実装者判断・DD ログへ転記）

1. **初期文書は document@0**（revision 0・cell `lastChangedRevision` 0・oplog 空）として保持し、ストアがあれば **snapshot@0 を durable 化してから listen** する。再起動は snapshot@0 ＋ tail で復旧（oplog は消費者の操作だけを含む＝「操作ログを汚さない」）。
2. **bootstrap 経路の拡張**（protocol 挙動・server/collab 両側）: 従来「frontier 0 ＝ 空文書」を前提に fresh join は bootstrap を送らなかった。初期文書があると frontier 0 でも非空になるため、**fresh join は文書が非空なら bootstrap@0 を送り、クライアントは committed 0 かつ未 bootstrap のとき受理**する。空文書の挙動は不変（既存テスト維持）。
3. **persisted snapshot format v2**: checksum の正準化を**深いキー順ソート**へ変更する。理由: Postgres `jsonb` はキー順を保持しないため、v1（挿入順 `JSON.stringify`）では consumer の snapshot が再起動時に必ず「checksum 不一致」で fail-fast する。v1 ファイルは旧算法で検証し読める（既存 dev 永続化ディレクトリを壊さない）。
4. **`recoverSequencerState` の「復旧あり」判定**は `totalOps > 0 || snapshot あり`（snapshot@0 のみの状態＝初期文書起動直後の再起動を fresh と誤判定しない）。
5. **identity 上書き**は RoomBridge（transport 層）で行う: 接続ごとに `ServeIdentity` を保持し、`submitOperation.envelope.actorId`・`presence.payload.userId/displayName` を書き換えてから Room へ渡す。`authenticate` 未指定なら従来どおり申告値（trusted internal）。
6. **サーバー起点 submit** は `Room.handleMessage('server', submitOperation)` を通す（PersistentRoom の durable 境界・poisoning・snapshot 生成をそのまま利用）。ACK は擬似接続宛てのため破棄し、`operations` は全接続へ配信。結果は Outbound の ack/reject から組む。
7. **Undo 非対象の根拠**: grid の Undo 記録点は自クライアントの `submitSetCells` のみ（`recordUndoEntry`）。サーバー起点 op は `clientId='server'` の echo として届き own-echo 判定（`envelope.clientId === ownClientId`）を通らない。unit（session-sync own-echo）で固定。

## 5. テストシナリオ（TDD・自然言語）

### 26-1 ストア注入と初期文書
- S1 メモリ実装の `oplog`/`snapshotStore` を `serve()` に渡し、クライアント編集 → `append` に公開形の envelope（`actorId`・`operation.changes[].rowId` が string）が届く。`append` が解決するまでクライアントの ACK（pending 0）が出ない（durable ACK）。
- S2 `stop()` → 同じストアで再 `serve()` → revision・hash が継続し、再接続クライアントが同じ値を受け取る。
- S3 保存した snapshot の JSON キー順を入れ替えて返すストア（jsonb 模倣）でも S2 が成立する。
- S4 空ストア＋`initialDocument` → 1 回だけ呼ばれ、fresh join クライアントが初期行を受け取る（revision 0 のまま）。編集後に再起動 → `initialDocument` は呼ばれず snapshot@0＋tail から復旧。
- S5 `persistenceDir`（ファイル）＋`initialDocument` でも S4 が成立（ファイル永続化の既存経路と整合）。
- S6 fail-fast: 片方だけのストア／`persistenceDir` 併用／`seedRows` 併用／行 ID 重複／未知列。
- S7（server 単体）非空 document@0 への fresh join は bootstrap@0 を返す。空文書は返さない（既存）。（collab 単体）bootstrap@0 を committed 0 のとき受理し、以後の重複 bootstrap@0 は無視。
- S8（snapshot-store 単体）v2 checksum はキー順非依存。v1 ファイルは旧算法で読める。改竄は引き続き検知。

### 26-2 認証フック
- A1 `authenticate` が null → upgrade は 401 で拒否（ws クライアントは `unexpected-response` 401）。接続数 0。診断 `auth-rejected`。
- A2 `authenticate` が `{ actorId: 'u-42', displayName: 'Bob' }` → クライアントが `actorId: 'spoof'` で送った op の受理 envelope（oplog・他クライアントへの配信）は `actorId: 'u-42'`。presence の displayName は 'Bob' として他接続へ届く。
- A3 hook が throw → 500 で拒否・診断 `auth-error`・サーバーは継続稼働。
- A4 `authenticate` 未指定 → 従来どおり申告値（回帰）。Cookie ヘッダが `request.headers.cookie` として hook に渡る。

### 26-3 サーバー起点操作
- B1 `submit(setCells, { actorId: 'system' })` → `accepted` と revision。接続中の 2 クライアント両方に届き committed hash がサーバーと一致、pending 0。oplog の envelope は `clientId: 'server'`・`actorId: 'system'`。
- B2 `beforeRevision` が古い → `rejected` / `stale-cell-revision`。文書は不変。
- B3 stop → submit は reject。submit → stop → 同ストアで再 serve → submit が受理される（`clientSequence` 継続・violation なし）。
- B4（grid 単体）`clientId: 'server'` の echo は own-echo 通知（Undo の ownedRevision 更新）を起こさない。自 clientId の echo は起こす。
- B5 durable 失敗（append reject）→ submit は reject し、以後の submit も拒否（poisoning・既存契約）。
