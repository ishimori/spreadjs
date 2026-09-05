# DD-047 行列罫線の公開契約

## APIと境界

gridの`GridCommonMountOptions`、Reactの`NanairoSheetViewProps`へ`rowBorders`と`columnBorders`を追加する。
`GridBorder = { readonly color: string; readonly width: number }`、`GridRowBorders = { top?: GridBorder; bottom?: GridBorder }`、`GridColumnBorders = { left?: GridBorder; right?: GridBorder }`をgridから公開する。
RowId/ColumnIdをキーにしたReadonly Record。mount時固定・設定をコピーし、呼出元の後続mutationの影響を受けない。Reactはキー順を再帰的に正準化し、同値ならremountしない。

実線のみ。幅はCSS pxで有限の`0 < width <= 8`。描画時に`max(1, round(width * DPR))` device pxへ丸め、両端をdevice pixelに合わせる。境界中心から外側へ出る部分はデータ領域でclipする。罫線はデータセルの空セルにも適用し、列見出し・行番号へは延長しない。

## 解決・合成

- 同じ境界の両側を現在の隣接IDで解決する。太い指定を優先、同幅なら下側行のtop／右側列のleftを優先する。キー挿入順に依存しない。
- 行挿入後も元IDに追従、新規行へはコピーしない。削除されたIDの線は消える。未知RowIdは初期データ描画時に`row-border-unknown` warnをmount当たり1回（全未知IDをまとめる）。後から到着すれば適用する。
- 既定格子線・列背景・行背景・値ベース背景・文字を描いた後に罫線を描く。交点は太い線が上、同幅なら横線が上。overlayの選択枠・Presence・DOM編集層はさらに上。
- 指定した縦境界では通常テキストのoverflowを停止し省略する。左外からの流入も境界で停止。折返し・数値・リンク・バッジ・ヘッダーは従来のセル内表示を維持する。最大8pxは左右5pxの文字padding内に収まる。
- 固定境界は固定末尾と最初の非固定IDの指定を解決した1本を固定位置に描く。スクロールしても固定帯との仕切りを維持する。その他の線は所属する固定／スクロール領域でclipする。

## 不正設定と既定互換

未知ColumnId、空色、Canvasが解釈できないCSS色、非数／無限／範囲外幅、不正な辺オブジェクトは`error`イベント（phase=config、code=`border-config-invalid`）を通知しmountを失敗させる。色は実Canvasで検証し正規化する。前に指定した色を使い回さない。CSS変数はCanvas色として未対応。色構文の対応範囲は実行ブラウザーに従う。

未指定／空Record／辺なしは描画フックを束縛しない。文書の値・CellScalar・protocol・snapshot・hash・cell-commit・コピーTSVは不変。書式の保存・共同編集・セル範囲囲み・動的setter・Excel罫線入出力は対象外。

## 性能と配布

描画は可視行列（既存overscan込み）の境界だけを列挙し、全指定IDの走査はmount時だけ。追加コストは可視境界数に依存し、交点合成のため境界を幅順に並べる。60×200、70×382、50,000×200の設定なし／ありを同条件で計測する。既存consumer性能gateと同じframeP95 < 33ms、増分 <= 3msを基準とする。計測環境と生値を記録する。

10 packageを`0.1.0-alpha.4`としてpackし、内容・manifestと独立consumerの公開型／React prop／描画／共同編集／lifecycleを検証する。
