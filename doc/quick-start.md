# Quick Start — @nanairo-sheet Alpha（社内SDK・Stage 1）

新規 consumer が `@nanairo-sheet/grid`（Canvas 描画・共同編集グリッド）と `@nanairo-sheet/server-hono`（同期サーバー）を
組み込み、**serve → mount → 日本語入力**まで到達するための最小手順。実証済み経路は `consumer-app/`（vanilla TS）で、
`bash scripts/consumer-app.sh` が本手順を機械再現する。

> ⚠️ Experimental `0.x`（ADR-0015）。長期後方互換は非保証。破壊的変更は `CHANGELOG.md` に記録する。

## 前提条件

- **Node.js 22 以上**（`engines.node: ">=22"`）。
- **Tier 1 対応環境のみ**: Windows Chrome / Edge（Chromium）。他 OS / ブラウザは対象外・非検証（ADR-0015 D2・CG-4）。
- **TS ビルド環境が必須**: 配布は **TS ソース配布**（`main: ./src/index.ts`）。consumer は TS を透過コンパイルできる
  バンドラ（**vite** 等）を用意すること（dist ビルド配布は Stage 2）。

## 1. 配布成果物の取得（pack tarball closure）

private registry は使わない（決定事項A）。SDK 提供側で配布成果物を生成する:

```bash
bash scripts/release/build-release.sh      # typecheck/lint/test → release/ に 10 tarball＋manifest.json
```

`release/manifest.json` に版数・sha256・生成コミット・channel（`alpha`）と install コマンドが記録される。

## 2. install（配布セット全 10 tarball を同時に）

`@nanairo-sheet/*` は private・未 publish のため、Facade3（grid・react・server-hono）＋内部7（core・types・collab・render・
selection・ime・server）＝**10 tarball を配布セットとして同時 install** する。React Facade は grid の実行時 closure には必須でないが、
松下を含む React consumer が手作業で別 tarball を補わないよう標準セットへ含める（`react ^19` は consumer が用意する peer dependency）。
`manifest.json` の `install` フィールドをそのまま使う:

```bash
cd <your-consumer>
npm install --no-save --install-links \
  nanairo-sheet-grid-0.1.0-alpha.1.tgz nanairo-sheet-react-0.1.0-alpha.1.tgz \
  nanairo-sheet-server-hono-0.1.0-alpha.1.tgz \
  nanairo-sheet-core-0.1.0-alpha.1.tgz nanairo-sheet-types-0.1.0-alpha.1.tgz \
  nanairo-sheet-collab-0.1.0-alpha.1.tgz nanairo-sheet-render-0.1.0-alpha.1.tgz \
  nanairo-sheet-selection-0.1.0-alpha.1.tgz nanairo-sheet-ime-0.1.0-alpha.1.tgz \
  nanairo-sheet-server-0.1.0-alpha.1.tgz
```

配布物はTS製品ソース（`src/**/*.ts`）と実行時必須assetだけを含み、モノレポ専用の `tsconfig*.json` とテストコードは含めない。
dist配布ではないため、consumer側にTSを透過コンパイルできるビルド環境が必要な点は変わらない。

> consumer は**公開 Facade だけ**を import する（内部 package・`@nanairo-sheet/*/test-support`・source path 直接参照は禁止＝S1-3）。

## 3. serve（同期サーバー）

```ts
import { serve } from '@nanairo-sheet/server-hono';

const server = await serve({
  port: 8790,
  // onDiagnostic は opt-in（既定無出力）。障害切り分け時のみ渡す。
  onDiagnostic: (e) => console.debug('[server]', e.code, e.message),
});
// server.url / server.documentId / server.connectionCount() / await server.stop()
```

## 3b. 独自永続化・認証・サーバー起点操作（consumer 統合・DD-026）

`serve()` は既定でファイル永続化（`persistenceDir`）か in-memory で動く。実案件では **利用側の DB と認証**につなぐ 3 つの口を使う
（Experimental 0.x・型は `@nanairo-sheet/server-hono` の `Serve*`）。以下は擬似コード（`db`/`verifyJwtCookie` は利用側の実装）。

```ts
import { serve } from '@nanairo-sheet/server-hono';
import type { ServeOpLogStore, ServeSnapshotStore } from '@nanairo-sheet/server-hono';

// U1: 永続化ストアの差し替え（例: Postgres）。**append の解決＝durable** が契約（解決後にクライアントへ ACK が出る）。
const oplog: ServeOpLogStore = {
  async append(entries) {
    // 1 トランザクションで「操作ログ INSERT」と「業務表への投影」を行い、commit してから resolve する。
    await db.transaction(async (tx) => {
      for (const e of entries) {
        await tx.insert('sheet_oplog', { document_id: e.documentId, revision: e.revision, envelope: e });
        await project(tx, e); // e.operation（setCells / insertRows / deleteRows）を業務表へ
      }
    });
  },
  async readAll() {
    return { entries: await db.select('sheet_oplog', { orderBy: 'revision' }) }; // revision 昇順・1..N 連番
  },
  async close() {},
};
const snapshotStore: ServeSnapshotStore = {
  // s.snapshot は SDK 内部形式（不透明）。JSON として保存し、そのまま返す。jsonb 可（checksum はキー順非依存）。
  async save(s) { await db.upsert('sheet_snapshots', { document_id: s.documentId, revision: s.revision, data: s }); },
  async loadLatest() { return db.selectLatest('sheet_snapshots'); },
  async close() {},
};

const server = await serve({
  port: 9689,
  documentId: 'production-orders',
  columnOrder: ['order_no', 'item_code', 'item_name', 'unit_price'],
  oplog,
  snapshotStore,
  // snapshot も操作ログも無い初回だけ呼ばれる。DB の現状から document@0 を組む（oplog には載らない・seedRows と併用不可）。
  initialDocument: async () => ({
    rows: (await db.select('raw_production_orders')).map((r) => ({
      rowId: String(r.id),
      cells: { item_code: { kind: 'string', value: r.item_code }, unit_price: { kind: 'number', value: r.unit_price } },
    })),
  }),
  // U2: 認証。Cookie の JWT を検証し身元を返す。null は 401・throw は 500（どちらも接続拒否）。
  authenticate: async ({ headers }) => {
    const user = await verifyJwtCookie(headers.cookie);
    return user === null ? null : { actorId: user.id, displayName: user.name };
  },
});

// U3: サーバー起点の操作（補完・算出列）。通常の受理経路を通り、永続化後に全接続へ配信される。
const result = await server.submit(
  { type: 'setCells', changes: [{ rowId: '42', columnId: 'item_name', value: { kind: 'string', value: '丸棒 φ12' } }] },
  { actorId: 'system' },
);
if (result.status === 'rejected') {
  // result.code（例: 'stale-cell-revision'＝beforeRevision 指定時の OCC 競合）
}
```

- **durable ACK**: `append` が resolve するまでクライアントに ACK は出ない。`append` が reject（投影失敗）した操作は受理されず、
  以降の書込は停止する（fail-stop・接続は切断される）。復旧は再起動（snapshot＋tail）。**SDK は `append` を直列に呼ぶ**（前の呼び出しが
  resolve するまで次を呼ばない）ので、トランザクションは revision 順に commit できる。渡される `entries` は複製（変更しても SDK 内部に影響しない）。
- **初期文書**: `initialDocument` の結果は document@0（revision 0）。ストア指定時は snapshot@0 を保存してから listen する。
  行 ID の重複・`columnOrder` 外の列は起動時エラー。**セル値は number が有限数のみ・date が正準 `YYYY-MM-DD`（実在日）のみ**
  （NaN/Infinity・`2026/9/3` は起動時エラー／`submit` では reject。JSON で null になる値は共同編集の収束を壊すため）。
- **身元**: `authenticate` 指定時、クライアント申告の `actorId`/`displayName` は無視され、受理 envelope の `actorId` と presence の表示名は
  認証結果になる。`clientId` は再接続の同一性のため申告のまま（trusted internal の境界＝別ユーザーの `clientId` 乗っ取りは防がない）。
  Cookie はポートを区別しないため、同期サーバーは API と同一ホスト（本番は同一オリジンのリバースプロキシ配下）に置く。
  hook が throw したときの診断（`auth-error`）には **error message を載せない**（Cookie/トークンの混入防止・種別のみ）。詳細は hook 側で記録する。
  ブラウザーの WebSocket は 401 を判別できない（`close 1006`＝grid は `connect-failed` を通知）ため、認証状態は mount 前に自 API で確認する。
- **無限ループ防止**: `submit` の envelope は `clientId: 'server'`（予約語）・`actorId` は指定値。`append` で投影→再評価する利用側は、
  この `actorId`/`clientId` を見て再評価を抑止する（SDK 側は関知しない）。
- **Undo**: サーバー起点の操作は利用者の Undo 対象にならない（Undo は自クライアントの操作のみ）。
- **排他**: `oplog`/`snapshotStore` は同時指定が必須。`persistenceDir` との併用、`initialDocument` と `seedRows` の併用は起動時エラー。

## 3c. 複数文書を 1 プロセスで serve（DD-043・ADR-0025）

年度別の board のように**列構成が違う複数の文書**を 1 プロセスで持てる（v1 は起動時に決めた N 枚固定）。

```ts
const DOCUMENTS = {
  'plan-2026': { columnOrder: ['2026-04-01', '2026-04-02'], oplog: db.oplog('plan-2026'), snapshotStore: db.snapshots('plan-2026'), initialDocument: () => db.initialRows('plan-2026') },
  'plan-2027': { columnOrder: ['2027-04-01', '2027-04-02'], oplog: db.oplog('plan-2027'), snapshotStore: db.snapshots('plan-2027'), initialDocument: () => db.initialRows('plan-2027') },
};
const server = await serve({
  port: 8790,
  documents: {
    documentIds: Object.keys(DOCUMENTS),      // v1: 起動時に serve する集合（固定）
    resolve: (id) => DOCUMENTS[id] ?? null,   // documentId → 文書構成（null=未知＝拒否）
    // defaultDocumentId: 'plan-2026',        // 省略時は documentIds[0]
  },
});
// server.documentIds … 実際に serve 中の文書／server.quarantined … 起動時の復旧失敗で外した文書
await server.submit(op, { actorId: 'system', documentId: 'plan-2027' }); // 宛先文書を指定
```

クライアント側は `mount({ serverUrl, documentId: 'plan-2027' })` と名乗る（`/config?documentId=`・`/ws?documentId=` が付く）。

- **未知 ID は拒否**: serve していない `documentId` への `/config`・WS 接続は 404（grid は config phase のエラーで止まる）。
  接続先と違う文書を名乗る join / 操作は切断される（単一文書構成の従来接続だけは受理し、サーバー値へ正規化して記録する）。
- **起動時の検疫**: 復旧に失敗した文書だけを外し、残りの文書で立ち上がる（診断 `document-quarantined`・error／`server.quarantined` に載る）。
  1 文書のデータ破損で全文書が起動できなくなる再起動ループを防ぐための挙動で、**単一文書構成（`documents` 未指定）の復旧失敗は
  従来どおり `serve()` が reject する**（0 文書での起動成功を装わない）。
- **排他**: `documents` と単一文書オプション（`documentId`/`columnOrder`/`seedRows`/`persistenceDir`/`oplog`/`snapshotStore`/
  `initialDocument`）は併用できない。文書ごとの排他規則は単一文書と同じ。
- **v1 の範囲**: 文書集合の変更はプロセス再起動で行う（動的な作成・後片付け・実行時の文書単位隔離は未提供）。実行時の恒久失敗は
  従来どおりプロセス単位の fail-stop。将来の無限 Book・複数台への振り分けは `resolve` の差し替えと前段の routing で到達する（ADR-0025）。

## 4. mount（グリッド）と日本語入力

**size 済みの container**（幅・高さを持つ要素）へ mount する。`serverUrl` は必須。

```ts
import { mount, GRID_API_VERSION } from '@nanairo-sheet/grid';
import type { GridEvent } from '@nanairo-sheet/grid';

const container = document.getElementById('app') as HTMLElement; // 幅・高さを CSS で確保しておく

const grid = mount(
  { container },
  {
    serverUrl: 'http://127.0.0.1:8790',
    displayName: 'alice',
    onEvent: (event: GridEvent) => {
      // connection / pending / rejected / divergence / error
      if (event.type === 'error') {
        console.error(`[grid] ${event.code} (${event.phase}): ${event.message}`);
      }
    },
    // debug logging hook（opt-in・既定無出力）
    onDiagnostic: (d) => console.debug('[grid]', d.level, d.code, d.message),
  },
);
grid.focus(); // 常駐 textarea へフォーカス → セルをクリック/ダブルクリックし日本語 IME で入力
// 破棄: grid.destroy();（route 遷移・再表示。再 mount で leak しない）
```

- **セル編集**: セルをクリック（アクティブ化）またはダブルクリック（編集開始）し、日本語 IME で変換・確定。
- **共同編集**: 同じ `serverUrl` へ別 client を mount すると変更が相互反映される。
- **接続状態**: `grid.connectionState()`（`online`/`offline`/`stopped`）または `onEvent` の `connection` イベント。

## 4b. 単独グリッドモード（サーバー不要・DD-024）

共同編集サーバーを立てられない場合（バックエンドが Node 以外・単独入力画面）は **単独グリッドモード**で mount する。
`mode: 'standalone'` を渡すと同期サーバー無しで動作し、**確定値の保存は利用側アプリの責務**（認証・保存・DB 書き込みは全面的に利用側）。
SDK は確定通知（`cell-commit` イベント）と再注入（`setData`）の契約だけを提供する。

```ts
import { mount } from '@nanairo-sheet/grid';
import type { GridEvent, GridStandaloneData } from '@nanairo-sheet/grid';

const container = document.getElementById('app') as HTMLElement;

// 初期データ（例: 利用側 API から取得した行）。値は文字列で渡す（数値/日付は自動解釈）。
const initialData: GridStandaloneData = {
  rows: [
    { rowId: 'r1', cells: { 'col-a': '田中', 'col-b': '120000' } },
    { rowId: 'r2', cells: { 'col-a': '鈴木' } },
  ],
};

const grid = mount(
  { container },
  {
    mode: 'standalone',
    columnOrder: ['col-a', 'col-b', 'col-c'], // 単独モードは /config が無いので必須
    initialData,
    onEvent: (event: GridEvent) => {
      if (event.type === 'cell-commit') {
        // 確定値を利用側 API へ保存する（通知のみ＝grid は書き戻さない）。
        for (const c of event.changes) {
          void fetch('/api/cells', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rowId: c.rowId, columnId: c.columnId, value: c.value }),
          });
          // 保存失敗時は grid.setData(...) で見た目を元へ戻す（利用側の判断）。
        }
      }
    },
  },
);
grid.focus();

// 非同期取得（react-query 等）でデータが届いたら再注入する。
async function reload(): Promise<void> {
  const rows = await fetch('/api/rows').then((r) => r.json());
  grid.setData({ rows });
}
```

- **保存の責務境界**: cell-commit は**通知のみ**。認証・保存・失敗時のロールバック表示は利用側が持つ（`grid.setData` で再注入して復元）。
- **接続状態**: 単独モードの `grid.connectionState()` は `'standalone'` を返す（`connection`/`pending`/`rejected`/`divergence` は発火しない）。
- **fail-fast**: `mode:'standalone'` に `serverUrl`/`displayName`/`clientId` を混在させると `error`（`standalone-options-conflict`）、`columnOrder` 未指定/空は `standalone-options-invalid`。
- **F5 復元**: cell-commit を利用側で保存し、次回 mount の `initialData` として戻せばリロードで値が復元される。

## 4c. React 組み込み（`<NanairoSheetView>`・DD-025）

React アプリには `@nanairo-sheet/react` の **`<NanairoSheetView>`** コンポーネントで組み込む。Facade は lifecycle と
props/イベント変換だけを担い、**グリッドの内部状態を React state へ複製しない**（憲章 §11.2）。文書データは grid が唯一の
真実源で、非同期取得の反映は **ref（`setData`）** で流す（react-query 等）。

- **peer 依存**: `react ^19`（consumer が用意する。`react-dom` は不要＝Facade は render を行わない）。install 時は
  配布 closure に `@nanairo-sheet/react` を加える（`react` は consumer 自身の依存）。

```tsx
import { useRef, useEffect } from 'react';
import { NanairoSheetView } from '@nanairo-sheet/react';
import type { NanairoSheetViewHandle } from '@nanairo-sheet/react';
import type { GridCellCommitChange, GridStandaloneData } from '@nanairo-sheet/grid';

export function OrderGrid() {
  const ref = useRef<NanairoSheetViewHandle>(null);

  // 非同期取得（例: react-query の結果）を effect から再注入する（React state に文書を持たせない）。
  useEffect(() => {
    void fetch('/api/rows')
      .then((r) => r.json() as Promise<GridStandaloneData>)
      .then((data) => ref.current?.setData(data));
  }, []);

  const handleCommit = (changes: readonly GridCellCommitChange[]) => {
    for (const c of changes) {
      void fetch('/api/cells', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rowId: c.rowId, columnId: c.columnId, value: c.value }),
      });
      // 保存失敗時は ref.current?.setData(...) で見た目を戻す（利用側の判断）。
    }
  };

  // 親（#nsheet-host）は幅・高さを CSS で確保しておく（style で container を埋める）。
  return (
    <div id="nsheet-host" style={{ position: 'relative', width: '100%', height: '600px' }}>
      <NanairoSheetView
        ref={ref}
        mode="standalone"
        columnOrder={['col-a', 'col-b', 'col-c']}
        onCellCommit={handleCommit}
        style={{ position: 'absolute', inset: 0 }}
      />
    </div>
  );
}
```

- **props の変更契約（3 分類）**:
  - **識別系**（`mode`/`serverUrl`/`columnOrder`/`wrapColumns`/`documentId`/`displayName`/`clientId`）の変更は
    **自動 remount**（destroy→mount）。配列（`columnOrder` 等）は**値**で比較するので、毎 render 新しい配列リテラルを
    渡しても内容が同じなら remount しない（安定参照が理想だが Facade が吸収する）。
  - **初期値系**（`initialData`/`initialColumnWidths`/`initialRowHeights`）は**初回 mount のみ**有効。mount 後の変更は
    無視され診断 warn が出る。**データ再注入は `ref.setData`**、レイアウト保存は `onLayout`→次回 mount の初期値へ。
  - **callback 系**（`onCellCommit`/`onLayout`/`onConnectionChange`/`onError`/`onEvent`/`onDiagnostic`）は
    remount せず最新参照へ差し替わる（毎 render 新しい関数を渡してよい）。
- **命令 API（ref）**: `setData(data)`（standalone 再注入）／`focus()`／`connectionState()`。`GridInstance` 本体は出さない。
- **共同編集モード**: `mode="collaboration"`（省略時の既定）＋`serverUrl` を渡す。standalone props に `serverUrl` を
  書くと**型エラー**（型で排他）。
- **StrictMode**: `<StrictMode>` 配下の二重 mount/cleanup でもリークしない（内部で mount↔destroy が対で走る）。
- **診断 hook の注意**: `onDiagnostic` は**mount 時に渡していれば**後から差し替え可（最新が呼ばれる）。mount 時に未指定で
  後から付ける場合のみ再 mount（識別系変更）が要る（既定無出力＝性能影響ゼロを保つための仕様）。

## 5. エラーコード・診断

- `GridEvent` の `error` / `rejected` は**安定した公開コード**を持つ（`GRID_ERROR_CODES` / `GRID_CONFLICT_CODES`）。
  一覧と意味は **`doc/DD/DD-017/error-codes.md`**。
- `onDiagnostic`（grid・server-hono とも opt-in・既定無出力）で boot/接続/競合/起動停止の診断ログを採取できる。

## 参考

- 実証アプリ: `consumer-app/`（`consumer-app/README.md`）と `bash scripts/consumer-app.sh`。
- 版・破壊的変更: `CHANGELOG.md`。成熟度・対応環境: `doc/adr/0015-stage1-api-maturity-and-tier1-support.md`。
