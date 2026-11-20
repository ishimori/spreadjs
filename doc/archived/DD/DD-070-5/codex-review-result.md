通常の確定値・文書順・削除行の除外は決定どおりですが、拒否通知中と初回同期前には不整合な行を返し得ます。また、数値と一部の列 ID で往復保証が崩れ、列を絞った場合にも不要な走査が残っています。

Full review comments:

- [P2] 拒否された変更を view から除いてから購読者に通知する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:594-594
  共同編集でサーバーが編集を拒否すると、`ClientSession.handleRejected` は pending から操作を除いた後、`rebuildView()` より先に `pushConflict()` で同期通知します。そのため `rejected` の購読者がその場で `getRows()` を呼ぶと、拒否された値がまだ返り、画面側の一覧や CSV に残ります。残りの pending を再適用した view が確定してから拒否を通知し、購読者内の同期読み取りで確認してください。

- [P2] 初回 snapshot の受信前は部分的な行を返さない — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:593-594
  共同編集では初回 snapshot より先に `lifecycle.backend()` が設定されます。この間に `insertRows({ afterRowId: null })` を呼ぶと、`performInsertRows` は空文書への楽観挿入を受け付け、`getRows()` はサーバーの既存行を欠いた挿入行だけを返します。初回同期が済むまでは `[]` とし、一度同期した後の再接続中は従来どおり view を読めるよう、接続状態ではなく初回読み込みの完了を判定してください。

- [P2] 指数表記になる数値を setData でも数値として復元する — C:\repo\spreadjs\packages\grid\src\mount\read-rows.ts:50-50
  通常列に `0.0000001` を入力すると数値として確定しますが、`cellScalarToDisplay` は `'1e-7'` を返し、`setData` 側の `parseCellInput` は指数表記を文字列として取り込みます。往復前後の `getRows()` の文字列は同じなので、追加された E2E の比較では型の変化を検出できません。`cell-commit` と共通の数値出力をパーサーが受理する十進表記にそろえるなど、既存の文字列入力の意味を変えずに往復させ、復元後のセル型も検証してください。

- [P2] 任意の列 ID を安全に保持できる辞書で cells を返す — C:\repo\spreadjs\packages\grid\src\mount\read-rows.ts:41-41
  `__proto__` は有効な列 ID ですが、通常の `{}` への文字列代入では自身のプロパティになりません。その列に値があっても `Object.entries(cells)` には現れず、`setData({ rows: grid.getRows() })` で値が消えます。また、列 ID が `toString` の空セルは `cells[columnId]` で関数が返ります。各行の `cells` をプロトタイプのない辞書として生成してください。

- [P2] 列インデックスを行ループの外で一度だけ解決する — C:\repo\spreadjs\packages\grid\src\mount\read-rows.ts:45-46
  `getCell` は呼ぶたびに `columnOrder.indexOf(columnId)` を実行します。180 列目だけを指定しても、値を持つ行が 5 万行あれば同じ列を探すために約 900 万回の比較が発生します。同期 API なのでこの処理は呼び出し元の画面を止めます。列選択時に列 ID とインデックスの組を作り、行ループでは取得済みの `slot` と列インデックスで `doc.cells.get` を呼んでください。

- [P2] setData に戻すと失われる行設定を手引きに明記する — C:\repo\spreadjs\doc\quick-start.md:652-652
  「同じ表」という例はセル値だけでなく行設定も復元できるように読めます。実際は `getRows()` に `readOnlyColumns`・`cellStatus`・`cellBackgrounds` は含まれず、単独モードの `setData` はそれらを作り直すため、この例を実行すると行単位でロックされていたセルが編集可能になります。保証対象は行 ID とセル値だけであること、行設定を使う場合は consumer が再注入前に合成する必要があることを手引きと公開 API の説明に明記してください。

- [P3] 絞り込みの ID は文字列だけを受け付ける — C:\repo\spreadjs\packages\grid\src\mount\read-rows.ts:20-20
  `columnIds` と `rowIds` は配列かどうかだけを検査し、各要素に `String(id)` を適用しています。JS から `[null]` を渡すと実在する `'null'` 列に一致し、`[{ toString: null }]` を渡すと同期的に `TypeError` になります。どちらも `typeof id === 'string'` の要素だけを集合に入れれば、不正な要素を無視しつつ有効な ID はそのまま使えます。

- [P3] 自分の pending を読めることを共同編集 E2E で確認する — C:\repo\spreadjs\apps\playground\e2e\read-rows.spec.ts:53-55
  このテストは別クライアントに確定値が届くまで待つため、読み取り元を誤って `committedDocument` に変えても成功します。単独モードでも committed と view は同一です。初回同期後に送信または応答を保留し、編集した本人の `pendingCount()` が正の間に `getRows()` が新しい値を返すことを確認してください。この違いは[実物を mount して結線を確認する規約](AGENTS.md#L38)の対象です。