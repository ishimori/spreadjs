停止時の例外、deferred 中の余分な確定・入力喪失、flush の編集対象追跡に問題があります。コミット時点のソースと in-memory の synthetic 検証で確認しました。未コミット変更は対象外で、実 OS IME の挙動は検証していません。

Full review comments:

- [P1] 編集を確定する前に接続の stopped を判定する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:752-758
  未確定の編集を残す→切断が上限を超えて `stopped` になる→`flush()` を呼ぶ、という順序で、停止判定より先に `commitInProgressEdit()` が実行されます。確定先の `ClientSession.submitLocalOperation()` は停止時に throw するため、`stopped` を返す代わりに Promise が reject します。後続のタイマー判定で同じ状態になれば未捕捉例外になります。停止を先に判定して編集を保持したまま待ち合わせを解決し、同じ確定経路を使う deferred readOnly の判定も保護してください（[契約 §4.4](doc/DD/DD-056/contract.md#L225-L231)）。

- [P1] deferred の送信許可を切替時の編集だけに限定する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:653-655
  変換中に `setReadOnly(true)` を呼んだ後、ロック判定タイマーより先に synthetic の `compositionend`→非変換 input→keyup→Enter→移動先セルへの input→Enter を同じタスクで流すと、移動先の新しい編集まで確定されます。editor 側はまだ編集可能で、ここも編集対象を確認せず、すべての `editorSubmit` を許可するためです。単独モードで二つの `cell-commit` が発生することを再現しました。切替時の編集世代を保持して許可を一度だけ消費し、以後の編集開始を遮断してください（[契約 §4.3](doc/DD/DD-056/contract.md#L210)）。

- [P1] deferred に入る時点で選択式候補の確定を遮断する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:704-708
  `allowFreeText:true` の選択式列で変換中の候補欄を表示→`setReadOnly(true)`→変換終了→ロック判定より先に候補の `pointerdown`、という synthetic 順序で入力が失われます。この分岐は候補欄を残すため、`confirmSelect()` が編集中の draft を Escape で取り消した後、候補値の送信だけが readOnly の関所で拒否されます。再現では元のセル値が残り、draft も消えました。deferred に入る際に候補欄を閉じるか、取消処理より前に候補確定を拒否してください（[契約 §4.3](doc/DD/DD-056/contract.md#L210)）。

- [P2] flush が待つ編集の世代を呼び出し時に保持する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:793-794
  変換中のセル A で `flush()`→判定タイマーより先に変換終了・Escape で A の編集を取消→セル B で新しい編集を開始、という synthetic 順序で、古い flush が B の draft を勝手に確定します。waiter は `editPending` の真偽しか保持せず、再判定時に現在の編集を確定するためです。再現でも B が保存され、編集が終了しました。呼び出し時の編集世代を保存し、その編集が確定・取消済みなら後続の編集には触れず、pending の待ち合わせだけを続けてください（[公開契約](packages/grid/src/index.ts#L587-L588)）。

- [P2] deferred 中の cut でブラウザーの既定動作も止める — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:705-707
  変換中に `setReadOnly(true)` を呼んでから `cut` を受けると、`performCut()` は readOnly を理由に `null` を返しますが、textarea はまだ書込み可能です。integration-editor は `null` の場合に `preventDefault()` しないため、ネイティブの切り取りが draft とクリップボードを変更できてしまいます。synthetic 検証でも `readOnly:false`・`defaultPrevented:false` を確認しました。textarea 属性には触れず、deferred 中の cut を消費するフラグを editor に渡して既定動作を止めてください（[契約 §4.3](doc/DD/DD-056/contract.md#L207)）。