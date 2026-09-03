// serve() の公開型（DD-026・Experimental 0.x）。consumer 統合の 3 つの口 — U1 永続化ストアの差し替え／U2 認証フック／
// U3 サーバー起点操作 — が使う型を **内部 package（core/server/types）を参照せずに** Facade 自身で定義する（R7）。
// 値・操作・envelope は wire 形式（protocol-subset §2）の公開ミラーで、内部型と構造同一（ID は brand なしの string）。
// 内部→公開は構造的に代入可能、公開→内部は serve-adapters.ts が brand ファクトリで組み直す。

// ---- 値・操作・envelope（wire 形式の公開ミラー）----

/**
 * セル値（計画書 §6.4 の PoC サブセット）。number は**有限数のみ**（NaN/±Infinity は JSON で null になり収束を壊すため
 * 起動/submit 時エラー）。date は**正準 LocalDate** `YYYY-MM-DD`（実在暦日・ADR-0012）のみ（`2026/9/3` 等は事前に正準化すること）。
 */
export type ServeCellScalar =
  | { readonly kind: 'blank' }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'date'; readonly value: string };

/** SetCells の 1 件。`beforeRevision` 指定時はセルの現在 revision と一致しなければ全体 reject（OCC・stale-cell-revision）。 */
export interface ServeSetCellsChange {
  readonly rowId: string;
  readonly columnId: string;
  readonly beforeRevision?: number;
  readonly value: ServeCellScalar;
}

/** SetCells: 全件適用または全件拒否の原子的 Operation。 */
export interface ServeSetCellsOperation {
  readonly type: 'setCells';
  readonly changes: readonly ServeSetCellsChange[];
  readonly conflictPolicy: 'reject-overlap';
}

/** InsertRows: `afterRowId` 直後へ挿入（null=先頭）。新 RowId は rows に同梱。 */
export interface ServeInsertRowsOperation {
  readonly type: 'insertRows';
  readonly afterRowId: string | null;
  readonly rows: ReadonlyArray<{ readonly rowId: string; readonly height?: number }>;
}

/** DeleteRows: rowIds を tombstone 化（再 Delete は冪等）。 */
export interface ServeDeleteRowsOperation {
  readonly type: 'deleteRows';
  readonly rowIds: readonly string[];
}

export type ServeDocumentOperation = ServeSetCellsOperation | ServeInsertRowsOperation | ServeDeleteRowsOperation;

/**
 * 受理済み Operation Envelope（サーバー付与の revision/acceptedAt を含む）。oplog に追記される単位で、consumer は
 * `operation`（`setCells`/`insertRows`/`deleteRows`）から業務表へ投影できる。`actorId` は認証フック（U2）指定時は
 * サーバーが確定した利用者 ID、サーバー起点操作（U3）は `clientId: 'server'`。
 */
export interface ServeOperationEnvelope {
  readonly protocolVersion: number;
  readonly documentId: string;
  readonly operationId: string;
  readonly transactionId: string;
  readonly actorId: string;
  readonly clientId: string;
  readonly clientSequence: number;
  readonly baseRevision: number;
  readonly operation: ServeDocumentOperation;
  /** サーバー付与の全順序 revision（1 から連番）。 */
  readonly revision: number;
  /** ISO 文字列（監査用）。 */
  readonly acceptedAt: string;
  readonly canonicalOperation: ServeDocumentOperation;
}

// ---- U1: 永続化ストアの差し替え口 ----

/** `readAll` の結果。`discardedTornRecords` はファイル実装向け（末尾の途中書き破棄件数）。DB 実装は省略（0 扱い）でよい。 */
export interface ServeOpLogReadResult {
  readonly entries: readonly ServeOperationEnvelope[];
  readonly discardedTornRecords?: number;
}

/**
 * append-only operation log ストア（consumer 実装・例: Postgres）。
 * - `append` は**解決した時点で durable** であることが契約（ACK はその後に出る）。consumer が業務表への投影を同じ
 *   トランザクションへ入れれば「操作ログと業務表が常に一致」する。reject（例外）は当該 op を破棄し以降の書込を停止する。
 * - SDK は `append` を**直列に呼ぶ**（前の呼び出しが解決するまで次を呼ばない＝revision 順に commit できる）。1 度 reject
 *   すると以降の `append` は SDK 側で呼ばずに reject する（fail-stop・欠番を作らない）。渡される `entries` は複製で、
 *   consumer が変更しても SDK の内部状態に影響しない。
 * - `readAll` は revision 昇順・1..N 連番で返す（連番違反は起動時 fail-fast）。
 */
export interface ServeOpLogStore {
  append(entries: readonly ServeOperationEnvelope[]): Promise<void>;
  readAll(): Promise<ServeOpLogReadResult>;
  close(): Promise<void>;
}

/**
 * 永続化 snapshot（封筒）。`snapshot` は SDK 内部形式で**不透明**: consumer は JSON として保存し、`loadLatest` で
 * そのまま返す（中身を読み書きしない）。キー順は保持しなくてよい（checksum は正準化済み・jsonb 可）。
 */
export interface ServePersistedSnapshot {
  readonly formatVersion: number;
  readonly documentId: string;
  /** この snapshot が表す確定 revision R。初期文書のみの状態は 0。 */
  readonly revision: number;
  readonly createdAt: string;
  readonly snapshot: object;
  readonly checksum: string;
}

/** snapshot ストア（consumer 実装）。`loadLatest` は最大 revision の snapshot を返す（無ければ undefined）。 */
export interface ServeSnapshotStore {
  save(snapshot: ServePersistedSnapshot): Promise<void>;
  loadLatest(): Promise<ServePersistedSnapshot | undefined>;
  close(): Promise<void>;
}

/** 初期文書の 1 行。`cells` のキーは `columnOrder` の列 ID（columnOrder 外は起動時 fail-fast）。 */
export interface ServeInitialRow {
  readonly rowId: string;
  readonly cells?: Readonly<Record<string, ServeCellScalar>>;
}

/**
 * 初期文書（U1）。snapshot も操作ログも無いときだけ `initialDocument()` が呼ばれ、この内容が document@0（revision 0）
 * になる。以降の操作は revision 1 から。ストア指定時は snapshot@0 を保存してから listen する。
 */
export interface ServeInitialDocument {
  readonly rows: readonly ServeInitialRow[];
}

// ---- U2: 認証フック ----

/** WebSocket upgrade 要求の最小形（Cookie は `headers.cookie`）。 */
export interface ServeAuthRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/** 認証で確定した身元。envelope の `actorId`・presence の `userId`/`displayName` をサーバーがこれで上書きする。 */
export interface ServeIdentity {
  readonly actorId: string;
  readonly displayName: string;
}

/**
 * 認証フック（U2）。null を返すと upgrade を 401 で拒否する。throw は 500 で拒否する（通さない）。
 * 未指定なら従来どおりクライアント申告の actorId/displayName を使う（trusted internal）。
 */
export type ServeAuthenticate = (request: ServeAuthRequest) => Promise<ServeIdentity | null> | ServeIdentity | null;

// ---- U3: サーバー起点操作 ----

/** `ServerInstance.submit` に渡す SetCells（`conflictPolicy` はサーバーが付与）。 */
export interface ServeSetCellsInput {
  readonly type: 'setCells';
  readonly changes: readonly ServeSetCellsChange[];
}

export interface ServeSubmitOptions {
  /** 受理 envelope の `actorId`（例: 'system'）。consumer は投影時にこれを見て再評価を抑止できる。 */
  readonly actorId: string;
}

/** reject コード（protocol-subset §3 と同一語彙）。 */
export type ServeRejectCode =
  | 'stale-cell-revision'
  | 'target-row-deleted'
  | 'unknown-anchor'
  | 'unknown-row'
  | 'unknown-column'
  | 'invalid-base-revision'
  | 'client-sequence-violation'
  | 'duplicate-row';

/** `submit` の結果。reject は例外にせず結果で返す（durable 失敗・stop 後は Promise reject）。 */
export type ServeSubmitResult =
  | { readonly status: 'accepted'; readonly operationId: string; readonly revision: number }
  | { readonly status: 'rejected'; readonly operationId: string; readonly code: ServeRejectCode };
