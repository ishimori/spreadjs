印のない見出しでは、列記号・キャプション、2段見出し、固定帯の clip、行番号・境界線の描画順と Canvas 状態に差は見当たりませんでした。一方、公開した初期オプションで mount 自体が失敗することを再現しており、未知 ID の診断と、狭い列や余白での描画・クリック判定にも修正が必要です。

Full review comments:

- [P1] 列の初期印は lifecycle の初期化後に適用する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:154-159
  `columnHeaderMarks` を mount 時に渡すと、`setColumnMarks()` が同期的に `knownColumns()` を呼び、まだ宣言前の `lifecycle` を参照します。単独モードで正しい印 `{ a: { sort: 'asc' } }` を渡して `ReferenceError: Cannot access 'lifecycle' before initialization` を再現しました。`{}` でも同じ経路を通り、React の初期 prop にも影響します。初期値の適用を `lifecycle` の生成後に移し、setter だけでなく初期印付きの実 mount を回帰テストしてください（[AGENTS.md:38](./AGENTS.md#L38)）。

- [P2] boot 前に受け取った列の印を列順確定時に検査する — C:\repo\spreadjs\packages\grid\src\header-marks.ts:81-86
  初期印なしで mount し、直後に `setColumnHeaderMarks({ typo: { sort: 'asc' } })` を呼ぶと、backend がまだ無いため未知列の検査を通過します。単独モードでも起き、共同編集で `/config` が返った後にも再検査されないため、決定事項7の warn と破棄が行われません。列順が既知ならその場で、未知なら最後の指定を保留して `config.build(columnOrder)` の時点で検査してください。起動前の保留は[AGENTS.md:38](./AGENTS.md#L38)の部品テスト対象です。

- [P2] 登録されていないまとまり ID の印を警告して捨てる — C:\repo\spreadjs\packages\grid\src\header-marks.ts:98-103
  `columnGroups` に `id: 'sup'` しかない場合でも、`setColumnGroupMarks({ typo: { collapsed: true } })` は値の型だけを検査して保存します。印が出ないのに診断もなく、呼び出し側は ID の指定ミスに気付けません。解決済みのまとまり ID（省略時は caption）と照合し、決定事項7どおり未知の項目だけ `column-header-mark-invalid` で除外してください。

- [P2] 狭い列では印を列内の操作可能な幅に収める — C:\repo\spreadjs\packages\render\src\header-layer.ts:59-66
  最小列幅20pxで `filter` と `sort` を併用すると、列左端を0としてボタンは x=1〜15、並べ替えの三角は x=-10〜-2 に配置されます。同じ pane 内では三角が左隣の見出しに描かれ、ボタンの左側も隣列境界の4pxのリサイズ判定に取られて `filter` が通知されません。共有レイアウトで左右のリサイズ領域を除いた幅を予算にし、入り切らない印は縮小または省略してください。

- [P2] 省略記号も収まらない場合は印付き見出しの名前を描かない — C:\repo\spreadjs\packages\render\src\header-layer.ts:225-228
  `textCache.fitText()` は残り幅が正なら、省略記号自体が収まらない場合にも `…` を返します。例えば幅28pxで filter のみなら `labelMaxWidth` は1pxです。そこに標準フォントの `…` をクリップせず中央描画するため、絞り込みボタンと重なります。印付きの列・まとまりでは、省略記号の測定幅を下回ったら空文字にするか、名前の領域で描画をクリップしてください。

- [P2] 最終列より右の余白ではまとまりのクリックを通知しない — C:\repo\spreadjs\packages\grid\src\mount\pointer.ts:488-492
  列の総幅が viewport より小さく、最終列がまとまりに属する場合、上段の右側の空白を押してもそのまとまりの `column-group-click` が発火します。`hitTest()` 内の `Axis.indexAt()` が範囲外の x を最終列に丸め、ここでは実際の矩形内か確認していないためです。consumer が通知で折りたたみを切り替えると、何もない場所で列が閉じます。通知前に押下点が上段のまとまりの矩形内にあることを確認してください。

- [P2] 列幅の自動調整に見出しの印の幅を含める — C:\repo\spreadjs\packages\render\src\header-layer.ts:223-225
  印付きの列で列境界をダブルクリックすると、`performAutoFitColumn()` は従来どおり見出し文字列と左右余白だけを測ります。一方、描画時にはさらに印と間隔を差し引くため、セル内容より見出しの方が長い列では、自動調整した直後にも見出しが省略されます。共有レイアウトから印の占有幅を求め、auto-fit の見出し幅にも加えてください。

- [P3] available ボタンの枠を当たり判定の矩形内に描く — C:\repo\spreadjs\packages\render\src\header-layer.ts:186-188
  DPR=1で整数座標のボタンを描くと、`snapToDevice()` が左上を各0.5px進めた位置から元の幅・高さで stroke するため、右辺・下辺の1pxは `pointer.ts` が使う半開矩形の外に出ます。例えば下枠を押すと、見えているボタン上なのに `target: 'caption'` が届きます。外周を共有矩形に合わせ、線幅の半分だけ内側に各辺を配置してください。

- [P3] 手引きの例では同じ列の sort と filter を合成する — C:\repo\spreadjs\doc\quick-start.md:657-657
  サンプルのまま `price` または `name` の名前を押すと、`[sort.columnId]` に設定した `{ sort }` が後続の同名キーの `{ filter }` で上書きされます。データは並べ替わっても、その列に三角は表示されません。列ごとに filter と sort を一つの印へ合成してから、完成したマップを setter に渡す例にしてください。