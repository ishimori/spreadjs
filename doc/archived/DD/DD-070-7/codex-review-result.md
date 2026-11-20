幅 0 を Axis に反映するだけでは、Canvas の文字描画やポインター操作から非表示列を除外できていません。特に、隠した文字が隣の列に表示されること、結合セルの選択補正が再帰すること、編集中の表示切り替えが暗黙の確定を起こすことは、配布前に修正が必要です。判定は指定コミットの差分と呼び出し先のコード確認に基づき、テストは再実行していません。

Full review comments:

- [P1] 非表示列の文字を隣の空セルへ描画しない — C:\repo\spreadjs\packages\grid\src\document-view.ts:277-277
  A・B・C が同じペインにあり、B に文字列、C に空セルがある場合、B を隠してもその文字列が C の位置に表示されます。幅を 0 にしても `drawPaneValues` は B を走査し、`drawOverflowCell` は右の空セルへ文字を描くためです。通常描画と可視範囲の左外からの流入描画の両方で、非表示列を文字の描画元から外してください。コピー用のデータ走査からは外さないでください。

- [P1] 結合の左上への移動と非表示列のスキップを一度に解決する — C:\repo\spreadjs\packages\grid\src\mount\editor-wiring.ts:184-186
  `frozenColumnCount: 0` で A:B を結合し、左上の A を選んだ状態で A を隠すと、非表示列の補正は B へ、結合の補正は A へ戻します。どちらも `pointerdownCell` から同期的に `onChange` を呼ぶため、スタックが尽きるまで往復します。部分的に見えている結合を一つの移動先として扱い、両方の条件を解決してから一度だけ移動してください。この組み合わせは実物を mount した E2E で確認できます（[AGENTS.md:38](./AGENTS.md#L38)）。

- [P1] 編集中の列を隠しても未確定の入力を暗黙に確定しない — C:\repo\spreadjs\packages\grid\src\mount\hidden-columns.ts:84-85
  フォーカスを保ったまま React の更新などで編集中の列を隠すと、この判定はセル移動を止めますが、列幅は既に 0 です。次の `refreshPlacement` で非変換中の textarea が `display:none` になり、blur により `handleBlur` が下書きを確定します。変換中は逆に編集欄が元の位置に残り、詰めて表示された別の列に重なります。編集対象を隠す変更だけは、編集中のセルと textarea の対応を保ったまま安全な確定・取消後に適用し、通常入力と IME の両方で確認してください（[AGENTS.md:37](./AGENTS.md#L37)）。

- [P1] 初期表示で先頭列を隠した場合も選択を補正する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:554-554
  単独モードで `hiddenColumns` に先頭列を指定すると、`hiddenColumns.attach` の時点では editor が未生成なので、幅だけが変わり初期選択は `(0,0)` に残ります。以降の初回描画でも補正されず、`selection()` は隠れた列を返し、`focus()` の対象の textarea も表示されません。初期値と boot 前の setter のどちらでも、editor の結線後、初回の選択通知より前に補正してください。現在の E2E は途中の列だけを初期指定しており、この結線順を検証していません（[AGENTS.md:38](./AGENTS.md#L38)）。

- [P1] 見える列がない領域のクリックをセルやリサイズ境界にしない — C:\repo\spreadjs\packages\render\src\axis.ts:162-162
  全列を隠すと `visibleNear` は元の index を返すので、空白の本体をクリックすると非表示セルが選ばれ、ダブルクリックはそのセルの編集経路に入ります。固定列だけが見えている場合も、`hitTest` の `Math.max(..., frozenColCount)` が固定帯の右側を最初の非表示列に戻すため、その境界で隠した列のリサイズや自動調整ができます。「全列非表示なら現在の選択を寄せない」と、新しいポインター操作を受け付けることは別です。対象ペインに幅のある列がなければセルの hit を返さず、幅 0 の列をリサイズ対象にも入れないでください。

- [P2] 自動的な選択補正でグリッド外のフォーカスを奪わない — C:\repo\spreadjs\packages\grid\src\mount\hidden-columns.ts:93-93
  列を切り替えるチェックボックスや検索欄にフォーカスがある状態で現在列を隠すと、`pointerdownCell` の既定動作が textarea にフォーカスを移します。続けて入力すると、外側のコントロールではなくグリッドが打鍵を受け取ります。結合の自動補正と同じく `{ focus: false }` で移動し、外部コントロールの `document.activeElement` が変わらないことをブラウザーで確認してください（[AGENTS.md:37](./AGENTS.md#L37)）。

- [P2] 現在列を隠すときは最後に横移動した向きを使う — C:\repo\spreadjs\packages\grid\src\mount\hidden-columns.ts:88-88
  C から左へ B に移動した後に B を隠すと、左に A が見えていても C に戻ります。移動時の `onChange` で `lastActiveCol` は既に B なので、setter からの補正では `active.col >= previous` が常に同値で右向きになるためです。列番号と最後の非ゼロの横移動方向を別々に記録し、現在列を隠す場合はその方向を使ってください。

- [P2] Shift＋矢印では範囲の端を次の見えている列まで動かす — C:\repo\spreadjs\packages\grid\src\mount\editor-wiring.ts:185-187
  B を隠して A から Shift＋右を押すと、選択枠は見た目上 A のままなのに、コピーや Delete は A:B に作用します。`keyboard.rangeOperations` は `selectionCtrl.extendByArrow` で範囲端だけを 1 列動かしてキーを消費するため、editor の `onChange` に置いた補正を通りません。範囲端の横移動でも非表示列を飛ばし、結果の範囲 A:C の内部には仕様どおり B を含めてください。

- [P2] 選択範囲の起点を隠しても範囲全体を解除しない — C:\repo\spreadjs\packages\grid\src\mount\hidden-columns.ts:56-59
  B を起点として B:D を選択した状態で B を隠すと、選択は C の単一セルに変わり、続くコピーは B:D を取得できません。自動補正で `pointerdownCell` を呼ぶと、入れ子の `onChange` から `selectionCtrl.syncWithEditor` が「起点と active が違う通常移動」と判断して明示範囲を消すためです。列の表示変更に伴う移動では、アクティブセルの補正と既存の範囲の保持を一緒に処理してください。

- [P2] 列を再表示した直後のスクロールに新しい総幅を使う — C:\repo\spreadjs\packages\grid\src\mount\render.ts:384-386
  横スクロールが不要な幅まで列を畳んだ後、同じイベント内で `setHiddenColumns([])` と `scrollToColumn(末尾列)` を順に呼ぶと、末尾に移動できません。Axis は同期更新されますが、DOM の spacer が広がるのは次のフレームなので、`ensureCellVisible` の `scrollLeft` が古い上限に丸められ、その後も再試行されません。列幅の変更をスクロール命令より先に spacer へ反映するか、同期完了後に保留したスクロールを適用してください。

- [P2] 折り返し列の再表示時に自動行高を計算し直す — C:\repo\spreadjs\packages\grid\src\document-view.ts:300-301
  長文を含む `wrapColumns` の列を初めから隠すと、初期の自動行高計算は幅 0 で行われ、明示改行のない文章は 1 行扱いになります。その列を再表示しても `markViewportDirty()` だけなので、Canvas は元の幅で折り返した複数行を 1 行分の高さにクリップします。表示状態が変わった折り返し列を行高計算に反映し、必要な行だけ再計測して spacer の高さも同期してください。

- [P2] 幅がゼロになった列見出しとグループ印を描かない — C:\repo\spreadjs\packages\grid\src\document-view.ts:275-278
  既定の列記号を使う表で中間の B を隠すと、`drawColHeader` は幅を確認せず `fillText` するため、A と C の境目に「B」が残ります。同様に、可視列に挟まれたグループの全列を隠しても、`drawColumnGroups` は幅 0 の位置に開閉の三角を描き、右隣のグループの印に見えます。個別の見出しと上段のグループそれぞれで、実際の幅が 0 ならラベル・印の描画を省いてください。

- [P2] ローカルで隠した列の参加者枠と名前タグを描かない — C:\repo\spreadjs\packages\grid\src\document-view.ts:277-277
  他の参加者が B を選択中に自分だけ中間列 B を隠すと、`rangePiecesAcrossPanes` は幅 0 の矩形を返します。`drawPresence` はそれにも線と固定幅の名前タグを描くので、参加者が隣の C にいるように表示されます。ペインとの交差をピクセル矩形に変換した後、幅または高さが 0 の断片は選択・Presence の描画対象から外してください。これなら一部が見えている範囲や結合の枠は残せます。

- [P2] 折りたたんだグループの右端で列幅を調整できるようにする — C:\repo\spreadjs\packages\grid\src\resize-interaction.ts:83-85
  上段のグループが B:D で C・D を隠すと、グループ右端でリサイズやダブルクリックの自動調整ができません。ここでは正しく B が対象になりますが、呼び出し元の `mount/pointer.ts` の `resizeHit` は `target.index + 1 < group.colEnd` を見て、まだグループ内部の境界だと判定します。上段の境界判定でも物理的な次の番号ではなく、右隣の見えている列が同じグループかを調べてください。

- [P3] React で null を全列表示の指定に変換しない — C:\repo\spreadjs\packages\react\src\index.ts:760-760
  JavaScript の consumer が表示切り替え後に `hiddenColumns={null}` を渡すと、`?? []` により警告なしに全列が再表示されます。同じ `null` は mount 時や grid の setter では「配列でないので変更しない」扱いです。prop を外した `undefined` だけを `[]` に変換し、それ以外は setter の検証に渡してください。