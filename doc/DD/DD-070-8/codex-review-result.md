行 Axis が更新されても Canvas が旧順のまま残る経路があり、利用者が見ている行と編集先が一致しません。また、未知 ID の後日追加による行の二重表示、起動・IME 保留中の適用順、選択と自動行高の扱いにも決定事項との差があります。

Full review comments:

- [P1] 行ビューだけを変更したときも Canvas を再描画する — C:\repo\spreadjs\packages\grid\src\document-view.ts:712-713
  選択中の先頭行を動かさず、`[a,b,c]` を `[a,c,b]` に並べ替えると、行 Axis は更新されますが、`dirtyRowView` が `needsRedraw` に含まれないため `render.flushStructural()` は再描画しません。他の dirty 要因がなければ、画面の2行目には b が残る一方、クリックや編集は c に作用します。フラグを消す前に再描画判定に含め、Axis の順だけでなく Canvas の表示も確認してください。

- [P1] 指定時に未知だった行 ID を保存する並びから除く — C:\repo\spreadjs\packages\grid\src\document-view.ts:346-346
  文書が `[a]` のとき `setRowView(['x','a'])` を呼び、その後 `setRows` で x を追加すると、`buildViewRowOrder` は実際に `[x,a,x]` を返します。未知の x を warn しても `order` に残すため、指定済みの行と後からできた行の両方として出力され、同じセルが2行に表示されます。保存する `order` は呼び出し時点で既知の ID だけに絞り、重複もそこで除いてください。

- [P1] 絞り込みによる選択の移動で外部入力欄のフォーカスを奪わない — C:\repo\spreadjs\packages\grid\src\document-view.ts:663-664
  consumer の検索欄で入力のたびに `setRowView` を呼ぶと、選択行の表示 index が変わったところで `applyRebaseState()` が `editor.pointerdownCell()` を既定のフォーカス動作付きで呼びます。その結果、次の文字は検索欄でなくグリッドのセルに入り得ます。行ビューによる再ベースでは `{ focus: false }` で選択だけを移し、外部入力欄への連続打鍵を実ブラウザーで確認してください（[AGENTS.md:37](./AGENTS.md#L37)）。

- [P2] 起動前の setRowView をデータ注入と同じ順に再生する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:580-580
  初期データなしの単独グリッドを mount した直後に `setData([a,b])`、`setRowView(['b'])` の順に呼ぶと、`bootStandalone()` は保留中の `setData` より先に `rowViewSwitch.attach()` を実行します。空の文書で b を未知と判定し、注入後は a まで「後からできた行」として見せてしまいます。単独モードでは両命令を同じ順序付きキューで再生し、この呼び順を実物の mount で確認してください（[AGENTS.md:38](./AGENTS.md#L38)）。

- [P2] IME 保留中も呼び出し時点の行集合を保持する — C:\repo\spreadjs\packages\grid\src\mount\row-view-switch.ts:89-91
  変換中に `setRowView(['a'])` を呼んだ後、変換が終わる前に `insertRows` または他の参加者の操作で n が追加されると、n は非表示になります。保留しているのは `order` だけで、`known` を作るのが変換終了時だからです。backend がある場合は呼び出し時に対象の ID と既知行集合を確定し、編集の確定と Axis への反映だけを遅らせてください。変換待ちの間に行を挿すケースも回帰確認の対象です（[AGENTS.md:37-38](./AGENTS.md#L37-L38)）。

- [P2] 共通行のない絞り込み先でも選択を有効な行に移す — C:\repo\spreadjs\apps\playground\e2e\row-view.spec.ts:124-125
  表示 `[a,b,c]` の c を選択して、文書内の別の行だけを含む `[d]` に切り替えると、`rebaseRowIndex()` は共通 ID がないため `null` を返します。`applyRebaseState()` の `pointerdownCell(null)` は状態機械では範囲外クリックとして無視され、旧 index 2 が残るため、d が見えていても `selection().activeCell` は `null` で打鍵先がありません。新 Axis が空でなければ有効な index に寄せ、E2E でも「旧 ID ではない」だけでなく移動先 ID を検証してください（[AGENTS.md:37](./AGENTS.md#L37)）。

- [P2] 非表示中に計測条件が変わった行の自動高を無効化する — C:\repo\spreadjs\packages\grid\src\document-view.ts:552-554
  折り返しで高くなった行を隠し、その間に折り返し列を広げてから再表示すると、以前の行高が残ります。`recomputeAllAutoRowHeights()` は隠れた行の既存値を残して可視行だけを測り、再表示時も既存値がある行は測りません。同じ ID の値を `setData` で差し替えた場合も同様です。単なる並べ替えではキャッシュを使い、列幅・フォント・文書などの計測条件が変わった場合は非表示行も無効化してください。

- [P2] 既定の高さに収まった行も計測済みとして扱う — C:\repo\spreadjs\packages\grid\src\document-view.ts:532-535
  `rowAutoHeights` に入るのは既定高を超えた行だけです。折り返し列があり、5万行すべてが1行に収まる表では、逆順にするだけで全行が `missing` に入り、全行の折り返しと必要高を再計算します。これは決定事項10で避けるべき経路です。高さの override の有無と計測済みかどうかを分け、並べ替え前後で有効な計測結果は既定高も再利用してください。

- [P2] 行を一時的に隠しても横方向だけの結合を解除しない — C:\repo\spreadjs\packages\grid\src\document-view.ts:688-690
  a の2列にまたがる結合を一度描画し、b だけに絞ってから `setRowView(null)` で戻すと、a の結合は復元されません。フィルター済み Axis を受けた `MergeRegistry.resolve()` が、a の不在を文書からの削除と区別せず `entry.broken = true` にするためです。行をまたがない結合は、行が文書に残っていれば非表示の間だけ描画対象から外し、再表示時に張り直してください。

- [P2] 文字列でない要素を含む指定は全体を無視する — C:\repo\spreadjs\packages\grid\src\mount\row-view-switch.ts:53-56
  JavaScript の consumer が `setRowView([null])` を呼ぶと、warn の後に空配列が適用され、全行が消えます。`['a', 1]` なら a だけに絞られます。決定事項9では文字列でない ID は「何も変えずに warn」で、未知の文字列 ID だけを無視する場合と異なります。型の不正を検出したら指定全体を不適用として返し、直前のビューと保留中の有効な指定を残してください。

- [P2] 初回描画前でも visibleRowIds を最新の構造から返す — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:377-380
  backend の起動後、最初の rAF より前に `setRowView(['b'])` と `visibleRowIds()` を続けて呼ぶと、`isFirstDataDrawn()` が偽なので同期 flush が省略され、フィルター前の Axis が返ります。初期ビューが空なら初回データ描画のフラグはさらに長く偽のままです。backend がない場合だけ `[]` とし、起動済みなら初回描画フラグに依存せず、保留中の構造を反映した順を返してください。

- [P2] 行番号が同じでも選択 ID が変わったら Presence を更新する — C:\repo\spreadjs\packages\grid\src\document-view.ts:663-664
  共同編集中に `[a,b]` の先頭 a を選択している状態で a を隠すと、自分の選択は同じ index 0 の b になります。しかし `applyRebaseState()` は `newRow === active.row` で戻り、editor の `emitPresenceIfChanged()` が呼ばれません。a は他の参加者の文書には残るので、相手の画面では次の操作まで a に自分の枠が表示されます。構造 flush の前後で選択の行 ID を比較し、番号が同じでも ID が変われば Presence を更新してください。

- [P2] 同じ位置に続く新規行を関数引数に展開しない — C:\repo\spreadjs\packages\grid\src\row-view.ts:57-57
  ビュー指定後に同じ可視行の後ろへ新規行が蓄積すると、`out.push(...group)` がエンジンの引数個数上限に達し、構造 flush が例外で止まります。`buildViewRowOrder` に既知の a と後続の新規15万行を渡すと、Node 24 で `RangeError: Maximum call stack size exceeded` を確認できました。グループをループで追加すれば、線形時間のまま件数上限を避けられます。