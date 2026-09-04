// @nanairo-sheet/server-hono — 同期サーバーの唯一の公開面（Facade・Experimental 0.x・ADR-0015）。
//
// Hono + @hono/node-server + ws による実 WS サーバー（Room/Sequencer/PersistentRoom を配線）を serve() で起動する。
// 内部実装（startServer/RunningServer・StartServerOptions・SnapshotData/RecoveryReport）は ./server が持ち、本 index は
// consumer 向けに **最小の公開契約**へ整形する（R7: SnapshotData/RecoveryReport・restoreFrom・integrationDataset 等の
// 内部型/デモ専用オプションは露出しない）。
// DD-026: consumer 統合の 3 つの口（U1 永続化ストアの差し替え・U2 認証フック・U3 サーバー起点操作）を公開型
// （./serve-types・内部 package 非参照）で追加した。

import { adaptOpLogStore, adaptSnapshotStore } from './serve-adapters';
import { startServer } from './server';
// 内部の文書構成型（adapter の戻り値にだけ使う局所型）。**公開面へは出さない**（非 export の関数シグネチャのみで使い、
// index.d.ts に現れない＝R7 型漏洩 0 を維持する）。
import type { StartDocumentConfig, StartDocumentsOptions } from './server';
import type {
  ServeAuthenticate,
  ServeDocumentConfig,
  ServeDocuments,
  ServeInitialDocument,
  ServeOpLogStore,
  ServeQuarantinedDocument,
  ServeSetCellsInput,
  ServeSnapshotStore,
  ServeSubmitOptions,
  ServeSubmitResult,
} from './serve-types';

export type {
  ServeAuthRequest,
  ServeAuthenticate,
  ServeCellScalar,
  ServeDeleteRowsOperation,
  ServeDocumentConfig,
  ServeDocumentOperation,
  ServeDocumentResolver,
  ServeDocuments,
  ServeIdentity,
  ServeInitialDocument,
  ServeInitialRow,
  ServeInsertRowsOperation,
  ServeOpLogReadResult,
  ServeOpLogStore,
  ServeOperationEnvelope,
  ServePersistedSnapshot,
  ServeQuarantinedDocument,
  ServeRejectCode,
  ServeSetCellsChange,
  ServeSetCellsInput,
  ServeSetCellsOperation,
  ServeSnapshotStore,
  ServeSubmitOptions,
  ServeSubmitResult,
} from './serve-types';

/** 診断エントリの重大度（server-hono 診断 hook）。 */
export type ServeDiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

/** serve 診断エントリ（onDiagnostic opt-in 時のみ生成）。 */
export interface ServeDiagnostic {
  readonly level: ServeDiagnosticLevel;
  /**
   * 安定した診断イベント識別子。
   * 'serve-started' / 'serve-stopped'（起動・停止）／'auth-rejected'（authenticate が null＝401 拒否・warn）／
   * 'auth-error'（authenticate が throw＝500 拒否・error）／'document-quarantined'（起動時の復旧失敗で文書を serve から
   * 外した・error・DD-043）／'document-unknown'（serve していない documentId への接続・/config を 404 で拒否・warn）／
   * 'document-mismatch'（join の申告 documentId が接続先の文書と不一致・warn）。Cookie・トークン等の値は載せない。
   */
  readonly code: string;
  readonly message: string;
  /** epoch ms。 */
  readonly timestamp: number;
}

/** 診断ログ hook（opt-in・既定無出力）。 */
export type ServeDiagnosticHook = (entry: ServeDiagnostic) => void;

/** serve 時オプション（Experimental 0.x・内部 StartServerOptions の公開最小サブセット）。 */
export interface ServeOptions {
  /** listen ポート（既定 8787。0=OS 任せのランダムポート＝テスト）。 */
  readonly port?: number;
  /** listen ホスト（既定 '127.0.0.1'）。 */
  readonly host?: string;
  /** ドキュメント ID（既定 'demo-doc'）。 */
  readonly documentId?: string;
  /** 列順（既定 ['col-a','col-b','col-c']）。 */
  readonly columnOrder?: readonly string[];
  /** 初期グリッド行数（既定 5）。`initialDocument` とは併用不可。 */
  readonly seedRows?: number;
  /** 指定でファイル永続化（oplog＋snapshot）を有効化する。再起動で snapshot＋tail から復旧する。`oplog`/`snapshotStore` とは併用不可。 */
  readonly persistenceDir?: string;
  /**
   * 独自の operation log ストア（DD-026 U1・例: Postgres）。`snapshotStore` と**同時指定が必須**。`append` 解決＝durable の
   * 契約はファイル永続化と同じ（consumer が業務表への投影を同じトランザクションへ入れれば操作ログと業務表が常に一致する）。
   */
  readonly oplog?: ServeOpLogStore;
  /** 独自の snapshot ストア（DD-026 U1）。`oplog` と同時指定が必須。中身は不透明（JSON として保存し、そのまま返す）。 */
  readonly snapshotStore?: ServeSnapshotStore;
  /**
   * 初期文書の供給元（DD-026 U1）。**snapshot も操作ログも無いときだけ**呼ばれ、結果が document@0（revision 0）になる。
   * ストア指定時は snapshot@0 を保存してから listen する（oplog は consumer の操作だけを記録する）。`seedRows` とは併用不可。
   */
  readonly initialDocument?: () => Promise<ServeInitialDocument> | ServeInitialDocument;
  /**
   * 認証フック（DD-026 U2）。WebSocket upgrade 時に呼ばれ、null で 401 拒否・throw で 500 拒否。受理後は envelope の
   * `actorId`・presence の `userId`/`displayName` をこの結果でサーバーが上書きする（クライアント申告は無視。`clientId` は
   * 再接続の同一性のため申告を維持）。未指定なら従来どおり申告値（trusted internal）。
   */
  readonly authenticate?: ServeAuthenticate;
  /**
   * 診断ログ hook（opt-in・既定無出力・最小）。指定すると serve 起動/停止・認証拒否の診断エントリが配信される。
   * 未指定なら診断は生成されない。汎用テレメトリ基盤は Stage 2（接続単位の診断は現状 connectionCount() で代替）。
   */
  readonly onDiagnostic?: ServeDiagnosticHook;
  /**
   * 複数文書 serve（DD-043・ADR-0025・v1 は起動時に決めた N 枚固定）。1 プロセスで複数の文書（Book / board）を持てる。
   * 指定した場合、単一文書オプション（`documentId` / `columnOrder` / `seedRows` / `persistenceDir` / `oplog` /
   * `snapshotStore` / `initialDocument`）とは**併用できない**（文書構成の供給元は 1 つ）。
   * - 接続は `/ws?documentId=...`・`/config?documentId=...` で文書を名乗る（無指定は `defaultDocumentId`）。
   *   serve していない ID は 404 で拒否する。
   * - 起動時の検疫（D3）: 復旧に失敗した文書だけを外し、残りの文書で立ち上がる（診断 `document-quarantined`・error）。
   *   外れた文書は `ServerInstance.quarantined` に載り、その文書への接続は 404 になる。
   */
  readonly documents?: ServeDocuments;
}

/** serve が返すハンドル（consumer lifecycle 契約）。 */
export interface ServerInstance {
  readonly port: number;
  readonly url: string;
  /** 既定文書の ID（`documentId` 無指定の接続が繋がる先。単一文書構成では唯一の文書）。 */
  readonly documentId: string;
  /**
   * 実際に serve 中の文書 ID（DD-043）。起動時の検疫で外れた文書は含まない。単一文書構成では `[documentId]`。
   */
  readonly documentIds: readonly string[];
  /**
   * 起動時の復旧に失敗して serve から外した文書（DD-043 D3・複数文書構成のみ）。単一文書構成の復旧失敗は
   * 従来どおり `serve()` 自体が reject する（0 文書での起動成功を装わない）。
   */
  readonly quarantined: readonly ServeQuarantinedDocument[];
  /** 現在の接続数（診断用）。`documentId` 指定でその文書のみ、未指定は全文書の合計。 */
  connectionCount(documentId?: string): number;
  /**
   * サーバー起点の操作（DD-026 U3）。通常の受理経路（revision 付与・全接続へ配信・永続化）を通り、受理は durable 化後に
   * 解決する。envelope は `clientId: 'server'`（予約）・`actorId: options.actorId`。利用者の Undo 対象にならない。
   * reject（OCC 等）は結果で返す。`changes` 空・`actorId` 空・durable 失敗・stop 後は Promise reject（同期 throw しない）。
   * DD-043: `options.documentId` で投入先の文書を指定する（未指定は既定文書・serve していない ID は Promise reject）。
   */
  submit(operation: ServeSetCellsInput, options: ServeSubmitOptions): Promise<ServeSubmitResult>;
  /** サーバーを停止し接続・永続化ハンドルを解放する。 */
  stop(): Promise<void>;
}

/** 公開 API バージョン（Experimental 0.x・ADR-0015）。 */
export const SERVER_HONO_API_VERSION = '0.1.0-experimental' as const;

/** 同期サーバーを起動する（listening 後に解決＝port 0 対応で async）。 */
export async function serve(options: ServeOptions = {}): Promise<ServerInstance> {
  // 診断 hook（opt-in・既定無出力）。hook の例外は本体へ波及させない（副次機能）。
  const onDiagnostic = options.onDiagnostic;
  const diag = (level: ServeDiagnosticLevel, code: string, message: string): void => {
    if (onDiagnostic === undefined) {
      return;
    }
    try {
      onDiagnostic({ level, code, message, timestamp: Date.now() });
    } catch {
      // 診断 hook の失敗は無視する。
    }
  };
  // U1 ストア注入は oplog と snapshotStore の同時指定が必須（片方だけでは復旧が成立しない・fail-fast）。
  if ((options.oplog === undefined) !== (options.snapshotStore === undefined)) {
    throw new Error('serve: oplog と snapshotStore は両方指定してください（片方だけでは再起動復旧が成立しません・DD-026-1）');
  }
  const running = await startServer({
    port: options.port,
    host: options.host,
    documentId: options.documentId,
    columnOrder: options.columnOrder !== undefined ? [...options.columnOrder] : undefined,
    seedRows: options.seedRows,
    persistenceDir: options.persistenceDir,
    oplog: options.oplog !== undefined ? adaptOpLogStore(options.oplog) : undefined,
    snapshotStore: options.snapshotStore !== undefined ? adaptSnapshotStore(options.snapshotStore) : undefined,
    initialDocument: options.initialDocument,
    authenticate: options.authenticate,
    diagnostics: onDiagnostic !== undefined ? diag : undefined,
    documents: options.documents !== undefined ? adaptDocuments(options.documents) : undefined,
  });
  diag('info', 'serve-started', `listening ${running.url} (documentId=${running.documentId})`);
  return {
    port: running.port,
    url: running.url,
    documentId: running.documentId,
    documentIds: running.documentIds,
    quarantined: running.quarantined,
    connectionCount: (documentId) => running.connectionCount(documentId),
    submit: (operation, submitOptions) => running.submit(operation, submitOptions.actorId, submitOptions.documentId),
    stop: async () => {
      await running.close();
      diag('info', 'serve-stopped', `stopped ${running.url}`);
    },
  };
}

/**
 * 公開 `ServeDocuments`（consumer 実装のストア）を内部 startServer の形へ写す（DD-043）。
 * resolver の呼び出しは startServer 側（起動時に documentIds ぶんだけ）で、ここでは 1 件ぶんの構成に adapter を掛ける。
 */
function adaptDocuments(documents: ServeDocuments): StartDocumentsOptions {
  return {
    documentIds: documents.documentIds,
    resolve: async (documentId: string) => {
      const config = await documents.resolve(documentId);
      return config === null ? null : adaptDocumentConfig(config);
    },
    ...(documents.defaultDocumentId !== undefined ? { defaultDocumentId: documents.defaultDocumentId } : {}),
  };
}

function adaptDocumentConfig(config: ServeDocumentConfig): StartDocumentConfig {
  return {
    columnOrder: [...config.columnOrder],
    ...(config.seedRows !== undefined ? { seedRows: config.seedRows } : {}),
    ...(config.persistenceDir !== undefined ? { persistenceDir: config.persistenceDir } : {}),
    ...(config.oplog !== undefined ? { oplog: adaptOpLogStore(config.oplog) } : {}),
    ...(config.snapshotStore !== undefined ? { snapshotStore: adaptSnapshotStore(config.snapshotStore) } : {}),
    ...(config.initialDocument !== undefined ? { initialDocument: config.initialDocument } : {}),
  };
}
