# @nanairo-sheet（spreadjs）への要件メモ — 松下 生産納期を consumer とする上流 DD の入力

> 出所: 本リポ DD-012（生産納期の共同編集化）。§A は段 2（DD-012-2）の前提となる共同編集の接続要件、§B は段 3 の列タイプ要件。
> 持ち込み先: `C:/repo/spreadjs`。§A は「consumer 統合（保存 Adapter・認証境界）」= ロードマップの DD-026 に相当、§B は DD-027「列タイプ体系」。
> 現状の公開 API（2026-09-03 実測）: standalone は `columnOrder` / `initialData` / `setData` / `insertRows` / `deleteRows` / `onEvent`（cell-commit・row-structure-change 等）。共同編集は `serve({ port, host, documentId, columnOrder, seedRows, persistenceDir, onDiagnostic })` と `<NanairoSheetView mode="collaboration" serverUrl documentId clientId displayName>`。

## consumer の構成（決定済み）

- 業務データの正本は consumer の Postgres（`raw_production_orders`・1 行 1 レコード）。シート同期サーバーの操作ログとスナップショットも同じ Postgres に置き、**受理した操作を同一トランザクションで業務表へ投影**する
- シート同期サーバーは consumer 側の別プロセス（`serve()` を呼ぶ薄いエントリ）。認証は consumer の JWT Cookie
- 文書は当面 1 つ（生産納期）。管理表②③の編集化で複数文書が要る

## §A 共同編集を consumer の Postgres と認証につなぐ（DD-026 相当）

| # | 要件 | 現状 | 欲しい形 | 優先 |
|---|------|------|---------|------|
| U1 | **永続化ストアの差し替え口** | `serve()` は `persistenceDir` でファイル固定。内部の `OpLogStore`（append / readAll / close）と `SnapshotStore` は差し替え可能な interface | `serve({ oplog, snapshotStore })` で実装を渡せる。加えて**初期文書の供給元**（操作ログが空のとき consumer が組み立てた `SnapshotData` から開始する。現 `restoreFrom` の公開で足りる可能性あり）。`append` の解決 = durable の契約はそのまま（consumer は投影を同じトランザクションに入れる） | 高 |
| U2 | **認証フック** | WebSocket upgrade に検証口が無く、`actorId` / `clientId` / `displayName` はクライアント申告 | `serve({ authenticate: (req) => Promise<{ actorId, displayName } \| null> })`。null は接続拒否（401 相当で close）。受理した envelope の `actorId` をフックの結果で**サーバーが上書き**する（クライアント申告を信用しない） | 高 |
| U3 | **サーバー起点の操作** | サーバーから文書へ操作を差し込む口が無い。共同編集モードでは `cell-commit` も発火しない | `ServerInstance.submit(operation: SetCellsOperation, { actorId })` のように、consumer がサーバー側から `setCells` を流せる。通常の受理経路（revision 付与・全接続へ配信・永続化）を通る。用途: 品番からの品名・単重・単価の補完、出来高からの歩留り・在庫の算出列 | 高 |
| U4 | **複数文書** | 1 サーバー 1 文書 | `documentId` ごとの room を 1 プロセスで持つ。②③の編集化で必要。本件では後回し可 | 低 |
| U5 | （任意）**受理通知フック** | なし | `onAccepted(envelope)`。U1 の `append` で代替できるため任意 | 低 |

### consumer 側で確認すること

- U1: 操作ログを先頭から再生した文書と、consumer の投影（DB）が一致する
- U2: Cookie はポートを区別しないので、consumer の API（:3902）と同期サーバー（:9689）が同じホストなら同じ JWT Cookie が upgrade 要求に載る。本番は同一オリジンのリバースプロキシ配下に置く前提
- U3: サーバー起点の操作が、書いた本人を含む全接続へ配信され、Undo の対象にならない（利用者の Undo は自分の操作だけ）
- 公開型スナップショット（DD-028）に U1〜U3 の型が載る

## §B 列タイプ（DD-027）

| # | 要件 | 使う列 | 利用側で決めたいこと | 優先 |
|---|------|--------|---------------------|------|
| R1 | **選択式入力列**（Excel の入力規則「リスト」相当）。**自由入力と併存** | 取引先名・品番・品名 | 選択肢の供給: 静的配列に加えて利用側の関数（同期/非同期）。IME 入力中の前方一致で絞り込み、Enter/Tab で確定。確定値は表示文字列のまま | 高 |
| R2 | **日付列**: カレンダーのポップオーバーで選べる。**手入力と併存**（現状の `2026/7/31` → LocalDate 正準化はそのまま） | 発行日・納期 | 開き方（ダブルクリック / F2 / セル右端のアイコン）。表示書式（`YYYY-MM-DD` / `YYYY/M/D`）を列で指定。値は ADR-0012 の LocalDate | 高 |
| R3 | **数値列の書式**: 右寄せ、桁区切り、小数桁。表示と値の分離 | 指示数量・単価・単重・残材・出来高・加工実績・算出列 | 列単位で `{ align, thousands, decimals }`。セル単位の背景色・赤字（DD-027-3）は②③の編集化で必要になるが本件では不要 | 中 |
| R4 | **読み取り専用列**: 編集開始を拒否し、範囲貼り付け時はその列をスキップ | No・歩留り・在庫・見出し行 | 列単位フラグ。共同編集ではサーバー側でも拒否したい（U2 の identity と組み合わせて列権限に育つ余地） | 中 |
| R5 | （任意）アクティブセル変更イベントの公開 | 全列 | 利用側で補完候補やヒントを出す用途。R1/R2 が SDK 内で完結するなら不要 | 低 |

### consumer 側で確認すること

- R1/R2 のエディタが IME の不変条件（先頭文字欠落なし）を壊さない
- 列タイプ指定は `columnOrder` と同じく mount オプション（React facade では props）で渡せ、未指定の列は現状どおり自由入力テキスト

## 持ち込み後の作業（本リポ側）

SDK 更新（`vendor/nanairo-sheet/*.tgz` 差し替え + `node_modules/@nanairo-sheet` と package-lock を消して `npm install`。engineering-patterns #3）→ §A は DD-012-2、§B は列型 `kind` から SDK の列タイプ指定へ写像する後続 DD。
