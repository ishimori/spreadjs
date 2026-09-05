# DD-047 検証シナリオ

| AC | シナリオ |
|---|---|
| 1 | 未指定と空Recordで同じ表を描き、Canvasのピクセルと文書hashが一致する |
| 2/3 | 月の数量列右、注文合計上、在庫上下の線を設定。空の未来月・行列背景・値背景でも線が残る |
| 4 | DPR 1/1.25/2、固定列0/1/5、固定行ありで縦横スクロールし、列幅・行高変更後も境界位置とピクセルが一致する |
| 5 | 太さ違い・同幅異色・逆キー順で同じ境界を指定。交点は太い線、同幅は横線が勝つ |
| 6 | 長文overflow・左外流入・wrap・背景・選択・Presence・編集中の位置を罫線と併用する |
| 7 | 対象前へ挿入、対象削除、後着IDを再注入。不正な列・色・幅は診断され、直前のstyleを使わない |
| 8 | grid/reactの両モードで同じ線を描画。ReactでRecord/辺のキー順のみ変えて再renderしても選択・draft・mountを保持する |
| 9 | 同じ文書へ設定あり／なしでhash・データを比較。コピーTSVと編集時のcell-commit payloadが一致する。protocol/snapshotは変更しない |
| 10 | 60×200、70×382、50,000×200の同条件でスクロールし、frameP95と差分を保存する |
| 11 | alpha.4の10 tarballのみでconsumerをinstallし公開型・React prop・線の実ピクセル・共同編集・lifecycleを確認する |

unitで設定解決・DPR座標・描画順・overflow・公開型・React lifecycleを先に確認する。ブラウザーE2Eは隔離Chromiumを使用し、画像・計測値をDD添付へ保存する。実IME入力方式の変更はなく、syntheticと実IMEを混同しない。
