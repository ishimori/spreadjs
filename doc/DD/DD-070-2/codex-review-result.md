表の余白から未クリックの行の詳細を開けてしまうことと、`setData` 直後の `selection()` が削除済みの行を返すことは、確定した公開 API の契約に反します。また、通知先の例外が描画ループ全体を停止させます。

Full review comments:

- [P1] 表の余白のダブルクリックを最終行・最終列の通知から除外する — C:\repo\spreadjs\packages\grid\src\mount\pointer.ts:598-600
  行数や列数が少なく、表が表示領域を埋めていない場合、`hitTest` は表の下や右の余白でも `area: 'cell'` を返します。`Axis.indexAt` が末端の index に丸めるため、そこでダブルクリックすると、実際には押していない最終行の詳細を consumer が開きます。既定動作は変えず、`cell-dblclick` を出す条件に、クリック座標がヒットしたセルの `cellRect` 内にあることを加えてください。

- [P2] setData 直後の selection() を新しい行構造から解決する — C:\repo\spreadjs\packages\grid\src\mount\selection-notify.ts:54-57
  単独モードで選択中に `setData({ rows: [] })` を呼び、同じ処理内で `selection()` を読むと、削除済みの行 ID が返ります。`setData` は文書を差し替えますが、`rowIdAt` が読む行軸は通常、次の rAF の構造 flush まで古いままです。`selection()` の同期読み取りにも保留中の構造変更と再ベースの結果を反映し、通知を待たずに空データなら両方 `null`、行を差し替えたなら新しい ID を返してください。実物を mount した E2E で、`setData` と読み取りを同じタスク内に置くと回帰を確認できます（[AGENTS.md:38](./AGENTS.md#L38)）。

- [P2] selection-change 購読者の例外で描画ループを止めない — C:\repo\spreadjs\packages\grid\src\mount\render.ts:393-396
  `afterFrame()` は `events.emit` を通して consumer の購読者を同期実行します。初回通知や選択変更の処理で購読者が一度でも例外を投げると、後続の `requestAnimationFrame(masterLoop)` に到達せず、そのグリッドでは以後の再描画も選択通知も止まります。例外を握りつぶさず、`finally` などで destroy 済みでない限り次のフレームを予約してください。

- [P2] 選択が変わらないフレームで結合範囲を再走査しない — C:\repo\spreadjs\packages\grid\src\mount\selection-notify.ts:72-74
  `check()` は再描画が不要なフレームでも `current()` を呼びます。結合が多数ある表で広い範囲を選ぶと、`selectedRange` が毎回 `expandRangeToMerges` を実行し、範囲と交わる結合をすべて配列に集め直します。選択を確定して操作を止めても、この走査と割り当てが毎フレーム続きます。選択・ドラッグ・行軸・結合の変更時にだけ範囲を再計算し、通知自体は従来どおりフレーム末尾にまとめてください。これは[数万行の Canvas 描画を優先する方針](./AGENTS.md#L7)にも関わります。

- [P3] 選択の重複判定では行・列 ID を個別に比較する — C:\repo\spreadjs\packages\grid\src\mount\selection-notify.ts:36-39
  行・列 ID には任意の文字列を渡せるため、区切り文字を含む ID では別セルが同じキーになります。例えば単一セルの `(rowId, columnId)` が `('a\u0000b', 'c')` から `('a', 'b\u0000c')` に変わると、`activeCell` と `range` の連結結果がどちらも一致し、必要な通知が落ちます。前回の各 ID を個別に比較するか、区切り位置を一意に復元できる形式で比較してください。

- [P3] ダブルクリックの E2E で編集状態への遷移を検証する — C:\repo\spreadjs\apps\playground\e2e\selection-dblclick.spec.ts:81-84
  可視セルでは Navigation 中も `integration-editor.ts` が textarea を `display: block` に配置するため、この検証は `editor.doubleClickCell()` を呼ばなくなっても通ります。既定の編集開始が通知より先に起きることを守るには、`cell-dblclick` の購読時点で、編集時だけ `auto` になる textarea の `pointerEvents` などを記録して検証してください。これで[実物を mount して部品間の結線を確認する方針](./AGENTS.md#L38)どおり、通知だけが届く回帰も検出できます。