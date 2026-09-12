# DD-049 / alpha.6 引き渡し（広島空港 DD-005-3 向け）

## 配布物

- SDK 版: `0.1.0-alpha.6`、API 版: `0.1.0-experimental`（変更なし）。
- 配布ディレクトリ: `C:/repo/spreadjs/release/0.1.0-alpha.6/`（10 tarball＋`manifest.json`＋`README.md`）。
- 配布用 ZIP: `C:/repo/spreadjs/release/nanairo-sheet-0.1.0-alpha.6.zip`（350,250 bytes / 12 entries）。
  ZIP SHA-256: `e00679c5f8eef8171f52f98203f5ca8ec23a926b26369fec5e41fa0adcd263c2`
- 実装コミット: `0f8cfe9`、配布ソース: `863fa74`（版更新）。tarball の SHA-256・bytes は配布 manifest（[凍結コピー](release-manifest.json)）が正本。
- npm registry への公開・GitHub への push・広島リポへの適用は未実施。

## 広島 要件メモとの対応

| 要件 | 提供した口 |
|---|---|
| H2 受理通知フック | server-hono `serve({ onAccepted(event) })`。受理 1 件ごと・文書ごとに revision 順・前後値付き。DB なしの `serve()` で偽の oplog を渡す必要がなくなる |
| H4 他者の受理済み操作の通知 | grid `remote-change` イベント／React `onRemoteChange`。`origin: 'local' \| 'remote' \| 'server'`・actorId・前後値（表示文字列）。自分の確定もサーバー確定後に `local` で届く |
| H5 参加者一覧 | grid `presence` イベント＋`presences()`／React `onPresenceChange`＋`ref.presences()`。先頭が自分（`self: true`） |
| H8 紹介サイト表記 | 機能カタログ「他ユーザーの編集位置表示」を提供中へ |
| H3 変更者の可視化 | SDK 側は見送り（DD-049-1 をアーカイブ）。「誰が変えたか」は `remote-change` から作る変更履歴で見せる |
| H1 数式 | DD-022（Stage 2）。当面は `onAccepted` → `server.submit({ actorId: 'system' })` の書き戻しで代替 |

## 更新手順（広島メモ「持ち込み後の作業」）

1. `mock/vendor/nanairo-sheet/*.tgz` を alpha.6 の 10 tarball に差し替える（既存 vendor・lockfile は戻せる状態で保存）。
2. `mock/node_modules/@nanairo-sheet` と `mock/package-lock.json` を消して `npm --prefix mock install`。
3. DD-005-2 のつなぎを差し替える: 偽の oplog/snapshotStore → `onAccepted`、サーバー側で組んだ変更履歴配信 → クライアントの `onRemoteChange`（サーバー配信を残す場合は両立可）、接続状態のみの帯 → `onPresenceChange` の参加者名。
4. 型検査・本番 build を通し、2 ブラウザで「相手の確定が変更履歴に並ぶ」「参加者の帯に相手の表示名が出て、閉じると消える」を確認して DD-005-3 に記録する。

## 制約

- `remote-change` は共同編集モード専用で SetCells のみ（行の挿入・削除は含まない）。初回接続と 1,000 revision 超の差分がある再接続で snapshot から読み込んだ区間は届かない（サーバー側 `onAccepted` は全受理を通知する）。
- `onAccepted` は hook の Promise を待たない。throw / reject は診断 `on-accepted-error`（warn）に閉じる。hook 内の `submit` は可だが無限ループ防止は利用側責務。順序保証は文書内のみ。
- `presence` の自分の userId は grid の clientId。`authenticate` で actorId を上書きする構成では他者から見た userId と一致しないため、自分の判定は `self` を使う。切断中は最後の一覧を保持し、再接続直後は同じ利用者が TTL（15 秒）まで二重に載りうる。
- 配信順の修正（Codex P1）: 永続化なしの `server.submit` の配信が後続クライアント op より遅れる順序入れ替わりを解消。公開 API の変更なし。
- Manual Gate M1（実機 2 ブラウザでの目視）は未実施。Playwright 2 コンテキストで自動検証済み。

検証結果は [validation.md](validation.md)、契約は [contract.md](contract.md)、コード例は `release/0.1.0-alpha.6/README.md` と `doc/quick-start.md` §3d・§4・§4c。
