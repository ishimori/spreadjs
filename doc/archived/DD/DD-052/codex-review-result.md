readOnly解除、setRowsの行ID・適用順・履歴保持などに再現可能な不具合があります。consumer-strict型検査と境界lintは通過しました。DD-053のmessage stormはpresence変更を戻した状態でも再現し、既存不具合という診断と整合しています。

Full review comments:

- [P1] readOnlyを全解除した場合もtextareaロックを解除する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:871-872
  mount側の列・行readOnlyがなく、セル単位readOnlyのセルを選択した状態で最後の指定を`setData`または`setRows`で外すと、textareaがロックされたままになります。`hasReadOnlyCells()`がfalseになるため、既存の`syncCellLock()`が`setInputLock(false)`を呼ばず、別の可編集セルへ移動しても入力できません。追加E2Eは解除前に可編集セルへ移動しているため、このケースを検出できません。

- [P1] 削除済みRowIdを未使用RowIdとして挿入しない — C:\repo\spreadjs\packages\grid\src\standalone-session.ts:242-246
  `deleteRows(['r1'])`後に同じIDを`setRows`へ渡すと、tombstone行を既存IDから除外しているため、新規挿入へ流れます。coreの`applyInsertRows`は未使用IDを前提としており、残っている旧rowOrder要素を除去せず、同じIDのメタデータを再有効化します。実際に`[r1,r2]`から削除・再注入すると表示順が`[r1,r2,r1]`となり、行の一意性とindex解決が壊れます。削除済みIDと未知IDを区別して処理する必要があります。

- [P2] 選択式・日付ピッカーの確定にもstringColumnsを適用する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:2894-2895
  `stringColumns`と`columnTypes`を併用すると、textarea経由ではstringになりますが、`confirmSelect`と`confirmDate`は依然として`draftToScalar(value)`をオプションなしで呼んでいます。指定列で候補`'123'`を選ぶとnumber、カレンダーで日付を選ぶとdateとして保存されることを確認しました。「編集UIと直交し、空文字以外は常にstring」という契約を満たすよう、この2つの確定経路にも列判定を渡してください。

- [P2] 起動前のsetDataとsetRowsの呼び出し順を保持する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:3247-3250
  mount直後、bootのmicrotaskより前に`setRows(旧値)`→`setData(新値)`を同期実行すると、ここでは常にsetDataを先に適用するため、最終値が古いsetRowsの値へ戻り、setDataで消えるべきUndoエントリも残ります。両APIを同じ順序付きキューで扱うか、後続setDataで先行setRowsを破棄し、起動後と同じ呼び出し順の意味を保つ必要があります。

- [P2] setRowsで無関係な行のRedo履歴を消さない — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:3295-3297
  行Aの編集をUndoしてRedo可能にした後、別の行Bだけを`setRows`で更新すると、`canRedo()`がfalseになります。`recordStandaloneUndoEntry`が呼ぶ`recordUserOp`は通常のユーザー編集用で、Redoスタックを全消去するためです。既存のUndo/Redo履歴に触れない再注入の契約に合わせ、setRowsの記録では少なくとも無関係な行のRedoエントリを保持する必要があります。

- [P2] セル単位readOnlyをダブルクリック入口でも判定する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:858-864
  行データでreadOnlyにした通常セルをダブルクリックすると、編集セッションが開始され、既存値入りの編集textareaが表示されます。既存のscrollerの`dblclick`ハンドラは`isReadOnlyRowIndex`と`isReadOnlyColumnIndex`だけを直接検査し、この新しいセル判定も`isActiveCellReadOnly`も使っていません。確定時の保証層は値変更を防ぎますが、列・行readOnlyと同じ編集入口抑止にはなっていないため、クリック対象セルの判定を追加してください。

- [P2] ドラッグ開始時にホバー終了を通知する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:1279-1282
  セル上でhoverを発火させ、そのまま押下して範囲選択ドラッグを始めても、全フィールドnullのイベントが発火しません。既存の`selectionDrag`分岐がこの呼び出しより前にreturnし、ドラッグ開始処理にも`updateCellHover(null)`がないためです。consumerのツールチップがドラッグ中も開始セルに残るので、ドラッグ状態へ入る際にホバーを明示的に終了させてください。