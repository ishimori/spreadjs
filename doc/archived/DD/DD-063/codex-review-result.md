JS consumer の不正入力で例外になる問題を2件確認しました。consumer-strict の型検査と、入力拒否後の通知・Undo・次回確定の簡易実行確認は通っています。

Full review comments:

- [P2] setCellStatus の行配列を検証してから適用する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:3802-3803
  JS consumer が `setCellStatus(null)`、`setCellStatus({})`、`setCellStatus([null])` を呼ぶと、配列や各要素の検証がないため TypeError が発生します。単独モードの boot 前では、この例外がキューの再生を中断し、後続の正しい setData/setRows も適用されなくなります。cellStatus 自体だけでなく、rows と各行の形も検証し、不正な入力を診断してスキップしてください。

- [P2] columnOrder の検証前に Set を構築しない — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:209-211
  JS consumer が単独モードに `columnOrder: {}` や `columnOrder: 42` を渡すと、追加された `new Set(options.columnOrder)` が同期的に例外を投げます。HEAD では同じ入力を `validateStandaloneOptions` が処理し、`standalone-options-invalid` の config イベントで通知していました。今回の変更ではその経路に届かず、ハンドルも返らないため生成済みDOMを destroy できません。集合の構築は既存の検証後に行うか、配列であることを先に確認してください。