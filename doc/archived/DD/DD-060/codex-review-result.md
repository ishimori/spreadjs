太い罫線による状態枠の消失、不正入力による部分更新、保留ホバー通知の重複を再現しました。通常経路の既存テストが通っていても、これらの条件では要求を満たしません。

Full review comments:

- [P2] 指定罫線の内端に合わせて状態枠を配置してください — C:\repo\spreadjs\packages\render\src\base-layer.ts:653-656
  `rowBorders`／`columnBorders` に太い罫線を指定すると、後段の `drawBorders` が状態枠を上書きします。DPR 1・四辺の罫線幅 8px では、描いた赤枠の4本すべてが消えることを再現しました。固定の1 device pxではなく、各辺の実際の罫線帯の内端から配置しないと、「罫線の内側に2pxの状態枠」という決定を満たせません。

- [P2] cellStatus 自体の null を列挙前に検査してください — C:\repo\spreadjs\packages\grid\src\standalone-session.ts:42-43
  JS consumer が `setRows([{ rowId: 'r2', cellStatus: null }])` を渡すと、`Object.entries(input)` が例外になります。新規行の場合は既に文書へ挿入された後なので、再描画要求やUndo記録に到達せず部分更新だけが残ります。セルごとの状態値だけでなく、`cellStatus` 自体も列挙前に検査してください。

- [P2] 保留したホバー通知の実行時にも状態を比較してください — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:1063-1067
  boot完了後・初回rAF前にホバーし、そのセルへ `setRows` を続けて呼ぶと、比較時点では `hoveredStatus` が更新されないため通知が複数保留されます。drain時にはすべてが最新状態を読み、同じ `cell-hover` を重複発火することを再現しました。保留要求をまとめるか、コールバック実行時にも直近の通知状態と比較してください。