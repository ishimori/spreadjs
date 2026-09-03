総評: 要修正。全列固定という有効な設定で描画ループが例外停止するほか、構造変更後の行ロック、空文書の列移動、不正色の描画に再現可能な不具合があります。

Full review comments:

- [P2] 全列固定時のアンカー捕捉を安全化してください — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:246-246
  `packages/grid/src/mount-controller.ts:246` で `frozenColumnCount >= columnOrder.length` が有効になった結果、body 行がある状態で collaboration bootstrap、`setData`、行挿入削除を行うと `flushStructural` が `captureAnchor` を呼びます。このとき列 index が列数以上になり、`Axis.getId: 範囲外 index=3（count=3）` のような例外で描画ループが停止します。推奨: アンカー側で固定数をクランプし、スクロール可能な列がない軸を個別に扱うか、全列固定時は列アンカーを捕捉しないでください。

- [P2] 構造変更後に行ロックを再同期してください — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:739-742
  `packages/grid/src/mount-controller.ts:741` の物理ロックは editor の変更時にしか同期されません。例えば active な readOnly 行を削除して編集可能な次行が同じ index へ移ると、`applyRebaseState` は index 不変として editor 更新を省略するため、textarea が `readOnly=true` のまま残り編集可能行へ入力できません。逆方向や非同期 bootstrap でも属性が未設定になり得ます。推奨: 初回データ描画後および各構造 flush 後に、index が変わらなくても `syncCellLock()` を実行してください。

- [P2] 空文書でも scrollToColumn を実行してください — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:2843-2845
  `packages/grid/src/mount-controller.ts:2844` は行向けの `runOrDefer` をそのまま共有していますが、`firstDataDrawn` は行数が 0 の間は永遠に true になりません。したがって、列を持つ `initialData.rows=[]` のシートで既知列へ `scrollToColumn` を呼んでも命令がキューに残り、列ヘッダーを含め横スクロールされません。推奨: 横方向命令は backend と列 Axis の準備完了を基準に実行するか、空文書の初回描画も ready として扱ってください。

- [P2] 不正色を直前列の色で描画しないでください — C:\repo\spreadjs\packages\render\src\base-layer.ts:484-486
  `packages/render/src/base-layer.ts:485` で Canvas の `fillStyle` に不正な色を代入すると、例外ではなく代入が無視されて直前の色が保持されます。そのため、連続する列に `{ a: '#ff0000', b: 'not-a-color' }` を指定すると b 列まで赤く塗られ、「不正色は Canvas が無視して安全」という契約と異なります。推奨: 各列で既知の pane 背景へ一度戻してから候補色を設定するなど、前列の `fillStyle` を継承しないようにしてください。