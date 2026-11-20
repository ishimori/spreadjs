結合で隠れた値を別セルに書き出す経路と、型変換前の比較により書き込みの要否を誤る経路があり、決定事項の「コピーして貼り付けたのと同じ結果」「同じ値は書かない」を満たしていません。また、検索付き候補欄にフォーカスがある間は再読み込みの抑止が効きません。

Full review comments:

- [P1] 結合セルのコピー元は通常のコピーと同じポートで読む — C:\repo\spreadjs\packages\grid\src\mount\edit-commands.ts:313-313
  A1:B1 を結合し、結合前の値が B1 に残っている状態で A2:B2 を選んで Ctrl+D を押すと、画面に出ていない B1 の値が B2 に書かれます。通常のコピーでは `copyPort.displayText` が結合の左上以外を空にしますが、`performFill` が渡す `docPort` は生の値を返します。コピー元は `copyPort` と同じ規則で読み、B2 には非表示の値ではなく空を写してください。

- [P2] 同値判定では変換後の値とコピー先の型付き値を比較する — C:\repo\spreadjs\packages\grid\src\fill-ops.ts:101-104
  `stringColumns` の A1 が文字列 `"007"`、通常列の B1 が数値 `7` のとき、Ctrl+R の結果は既存の数値 `7` と同じです。しかし表示文字列 `"007"` と `"7"` を比較するため書き込みが発生し、不要な Undo・`cell-commit` が生じます。逆に、コピー先に文字列 `"7"` が残っていれば、数値 `7` に変えるべきでも表示一致で飛ばします。先にコピー先の列設定で `parseCellInput` し、その結果の `kind` と値を、own pending を含む view 上のコピー先と比較してください。

- [P2] 検索付き候補欄でも Ctrl+D・Ctrl+R の既定動作を止める — C:\repo\spreadjs\packages\grid\src\mount\keyboard.ts:363-364
  `searchable: true` の候補欄を開くと、フォーカスは常駐 textarea から検索用 input に移ります。`select-editor.ts` の検索欄は `keydown` の伝播を止めますが、Ctrl+D・Ctrl+R を `preventDefault()` しないため、この `fill` 段には届かず、Ctrl+R でページを再読み込みできます。検索欄でも非変換中の該当キーだけを消費し、fill も検索文字列の変更も起きないことを実物の mount E2E で確認してください（[AGENTS.md:38](AGENTS.md#L38)）。

- [P2] 全体拒否の E2E に検証を通るコピー先も含める — C:\repo\spreadjs\apps\playground\e2e\fill-keys.spec.ts:93-95
  この選択では col-b がコピー元、col-c が唯一のコピー先です。そのため、不正なセルだけを除外して残りを部分適用する実装でもテストが通ります。選択を col-d まで広げ、col-c の拒否時に有効な col-d も元の値のままで、fill による `cell-commit` が増えないことを確認してください（[AGENTS.md:38](AGENTS.md#L38)）。

- [P3] 選択維持の E2E ではアクティブセルだけでなく矩形も確認する — C:\repo\spreadjs\apps\playground\e2e\fill-keys.spec.ts:32-33
  Ctrl+D の後に範囲選択が解除されて先頭セルだけになっても、`activeCell` は同じなのでこの検査は通ります。既存の `selectionRange()` を使って、操作前後で選択矩形が一致することも検査してください（[AGENTS.md:37](AGENTS.md#L37)）。