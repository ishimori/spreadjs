# grid Facade エラーコード語彙（Experimental 0.x・DD-017 Phase 2）

`@nanairo-sheet/grid` は consumer の障害切り分けのため、`GridEvent` の `error` / `rejected` に**安定した公開コード**を付与する。
内部 protocol の `RejectCode` や内部文字列は素通しせず、公開語彙へ写像する（境界文書 R7）。未知/未写像は `unknown`
にフォールバックし、内部コードの追加で consumer の分岐が壊れないようにする。破壊的変更は CHANGELOG に記録する
（ADR-0015 D1・S1-5）。値の配列は `GRID_ERROR_CODES` / `GRID_CONFLICT_CODES` として import できる。

## error イベント（`GridEvent` type=`error`）

`{ type: 'error', phase, code, message }`。`phase` は障害の局面、`code` は安定コード。

| code | phase | 意味 | consumer の対応目安 |
|------|-------|------|------------------|
| `config-unavailable` | `config` | `/config` の取得に失敗（ネットワーク/HTTP エラー） | serverUrl・サーバー起動・到達性を確認 |
| `config-invalid` | `config` | `/config` の応答形式が不正（documentId/columnOrder 欠落等） | server-hono の版・応答を確認 |
| `connect-failed` | `connect` | 初回 WS 接続の確立に失敗（接続確立前のトランスポートエラー） | ws 到達性・ポート・プロキシを確認 |
| `runtime-fault` | `runtime` | boot 配線後の予期しない実行時例外 | 診断ログ（onDiagnostic）で詳細を採取 |
| `standalone-options-conflict` | `config` | 単独グリッドモード（DD-024）に server 系 options（serverUrl/displayName/clientId）を混在指定 | 単独モードでは server 系 options を渡さない（認証・保存は利用側の責務） |
| `standalone-options-invalid` | `config` | 単独グリッドモード（DD-024）で columnOrder が未指定/空 | `mode:'standalone'` では columnOrder を必須で渡す |
| `column-types-invalid` | `config` | `columnTypes`/`columnFormats` mount オプションが不正（未知列・候補0件・重複候補・候補が非 round-trip・未対応 type〔DD-027-1〕／リンク列と `wrapColumns` の同一列併用〔wrap-link-conflict・DD-027-2〕／`columnFormats` の空ルール配列・空 match〔空配列/空文字〕・同一列内の match 重複〔DD-027-3〕）→ fail-fast | `columnTypes` のキーを columnOrder 内の列に限定し、選択式の options を 1 件以上・重複なし・parseCellInput で自己 round-trip する値にする。リンク列は `wrapColumns` と併用しない。`columnFormats` のキーを columnOrder 内に限定し、各列のルール配列を 1 件以上・各 match を非空・同一列内で match 値を重複させない |
| `column-display-invalid` | `config` | `columnCaptions`/`columnDisplayFormats` mount オプションが不正（未知列・空/空白キャプション・未対応 type・`decimals` 非整数/0〜20 外・date pattern 空/既知トークン皆無／`wrapColumns`・リンク列との同一列併用〔DD-033-2〕）→ fail-fast | キャプション/表示書式のキーを columnOrder 内の列に限定し、キャプションを非空に、number の `decimals` を 0〜20 の整数に、date pattern に `YYYY`/`MM`/`DD`/`HH`/`mm`/`ss` のいずれかを含める。表示書式列は `wrapColumns`・リンク列と併用しない |

> 接続確立**後**の一時切断は `error` ではなく `connection`（state=`offline`）で表現する（reconnect の一部）。
> 単独グリッドモード（DD-024）では `connection`/`pending`/`rejected`/`divergence` は発火せず、`connectionState()` は `'standalone'` を返す。

## rejected イベント（`GridEvent` type=`rejected`）

`{ type: 'rejected', pendingCount, conflict: { operationId, reason, code } }`。`code` は内部 `RejectCode`/`ConflictReason`
を写像した公開コード。

| code | 由来（内部） | 意味 |
|------|------------|------|
| `cell-conflict` | `stale-cell-revision` | 同一セルの同時編集競合 |
| `row-unavailable` | `target-row-deleted` / `unknown-row` / `unknown-anchor`／K4 draft 退避（DD-021-2・クライアント判定） | 対象行が存在しない/削除済み。**K4**: IME/編集中に対象行が削除され利用者が確定した場合の draft 退避通知にも使う（submit なし＝`operationId` 空文字・診断 `draft-diverted` 併発・単独モードは診断のみ） |
| `column-unavailable` | `unknown-column` | 対象列が存在しない |
| `revision-stale` | `invalid-base-revision` | ベースリビジョン不整合 |
| `sequence-violation` | `client-sequence-violation` | クライアント送信連番違反 |
| `duplicate-row` | `duplicate-row` | 行 ID 重複 |
| `revalidation-failed` | reason=`revalidation-failed` | ローカル再検証に失敗 |
| `dependency` | reason=`dependency` | 依存 Op の失敗に連鎖して不成立 |
| `range-too-large` | クライアント実行前検査（DD-020-1） | 範囲操作（範囲クリア・cut のクリア等）のセル数が SetCells 上限（100,000）超過。submit 前に拒否され `operationId` は空文字 |
| `paste-too-large` | クライアント実行前検査（DD-020-2） | 貼り付け矩形のセル数が SetCells 上限（100,000）超過。submit 前に拒否され `operationId` は空文字 |
| `paste-out-of-bounds` | クライアント実行前検査（DD-020-2） | 貼り付け矩形が行/列端を越える（切り捨てず全体拒否）。submit 前に拒否され `operationId` は空文字 |
| `undo-blocked` | `stale-cell-revision`（補償 op・DD-020-3） | Undo の補償 SetCells が OCC で全体 reject（対象セルが他者に後続変更された）。強制 Undo せず通知（`operationId` は補償 op の ID） |
| `redo-blocked` | `stale-cell-revision`（補償 op・DD-020-3） | Redo の補償 SetCells が OCC で全体 reject（対象セルがさらに変更された）。通知のみ |
| `row-anchor-unknown` | クライアント実行前検査（DD-021-1） | `insertRows` の `afterRowId` が未知アンカー。submit 前に拒否され `operationId` は空文字。単独モードは診断のみ |
| `row-count-invalid` | クライアント実行前検査（DD-021-1・上限は Fable レビュー反映） | `insertRows` の `count` が **1〜100,000 の整数でない**（上限=SetCells セル数上限と同値の実行前ガード）。submit 前に拒否され `operationId` は空文字。単独モードは診断のみ |
| `row-delete-empty` | クライアント実行前検査（DD-021-1） | `deleteRows` の対象が空/全て非現存（削除対象なし）。submit 前に拒否され `operationId` は空文字。単独モードは診断のみ |
| `value-not-allowed` | クライアント editor 経路検査（DD-027-1） | 選択式列（`allowFreeText:false`）へ IME/textarea 確定経路で候補外の値を確定した。**未 submit**（文書無変更）で拒否され `operationId` は空文字。拒否値は診断（code=`value-not-allowed`）に含む。単独モードは診断のみ。paste/setData/リモート由来の非候補値は本検査を通らず保持される |
| `unknown` | 未写像/未知 | 上記いずれにも該当しない（前方互換フォールバック） |

## debug logging hook（`GridMountOptions.onDiagnostic`）

opt-in・既定無出力。指定すると boot/接続/競合/破棄の診断エントリ `{ level, code, message, timestamp }` が配信される
（`level`: `debug`/`info`/`warn`/`error`）。未指定なら診断エントリは生成されない（性能影響なし）。`onDiagnostic` の例外は
mount 本体へ波及しない。診断コード例: `boot-start` / `config-resolved` / `config-error` / `transport` / `connection` /
`rejected` / `divergence` / `runtime-error` / `destroy`。

`@nanairo-sheet/server-hono` の `ServeOptions.onDiagnostic` も同形（opt-in・既定無出力）で `serve-started` / `serve-stopped`
を配信する。接続単位の診断・汎用テレメトリ基盤は Stage 2（現状は `ServerInstance.connectionCount()` で代替）。
