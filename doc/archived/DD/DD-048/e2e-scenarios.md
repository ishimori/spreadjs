# DD-048 確定契約と検証シナリオ

2026-09-06。実装開始・一気通貫のユーザー指示に基づき本文の論点1〜8を全て採用。

- `GridBorder.style?: 'solid' | 'dotted' | 'dashed'`、省略はsolid。同値のReact再renderは省略とsolidを同一視する。不正styleはborder-config-invalid。
- `defaultRowBorder?: GridBorder`は現在の全データ行の下端（最終行を含む）へ適用。0行・先頭行上端・見出し・データ外は対象外。明示top/bottomを既存規則で解決してからfallbackする（細い明示線も優先）。
- device線幅w=max(1, round(width×DPR))。dottedは四角w×w、隙間2w。dashedは4w×w、隙間2w。例: 幅1/DPR1は1on+2offと4on+2off、幅1/DPR2は2on+4offと8on+4off。
- 長軸の開始位置はround(headerWidth×DPR)（横）、round(headerHeight×DPR)（縦）。viewportに固定した共通原点なのでpane間で周期を再開せず、同じ座標への再描画は同じ点になる。固定境界は一度だけ合成する。
- pattern境界の既定実線を描かない。値背景の当該上端/左端insetも外す。背景を消去しない。無指定/solidの描画は従来どおり。
- mount時固定・表示専用。文書、保存、protocol、コピー値は不変。可視境界のみO(1)で解決する。

| シナリオ | 操作と判定 |
|---|---|
| S1 | 24列、共通点線、列/行/値背景と空セル。画素でon/offを検査しoffに背景が残る。省略とsolidのCanvasを比較 |
| S2 | dotted/dashed、個別線（同幅/太い/細い）、固定0/複数、DPR1/1.25/2。縦横scroll、列幅/行高resize、wrap後の境界・周期・見出しclipを確認。0/1行と非連続IDのsetDataで終端を確認 |
| S3 | 2クライアントで公開insert/deleteとセル編集のUndo/Redo。追加行の点線・双方のhash一致、編集/コピー値・選択/Presence、装飾だけでcommitなし。Reactの同値再renderでdraft/DOM/接続を保持 |
| S4 | 配布10tarballのみでgrid/React×standalone/collaborationを型解決・build・lifecycle・実描画。standalone setDataと追加行、共同編集の追加行にも共通点線。配布manifest・内容検査 |
| 性能 | DD-047と同じChromium/Windows/DPR1、1280×800、50,000×200・40万非空セル。基準とpattern設定を比較、frameP95<33msかつ増分≤3ms。生値と環境を保存 |

実機での点線の見やすさはManual Gate。未実施なら本文の既知の未保証境界へ移す。

既存UndoスタックはSetCellsのみ。行追加・削除自体のUndo/Redoを本DDで追加しない。外周の1device px罫線はclip消失を防ぐため内側へ最低1device px残す。
