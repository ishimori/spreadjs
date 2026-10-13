# DD-058 自己レビュー（2026-10-14）

対象: dpi純関数、Canvas scaffold/layout、mountのresize/rAF配線、画素E2E、配布版の差分。基準は `doc/templates/coding-standards.md`。外部モデルのレビューは実施していない。

| 観点・所見 | 処置・根拠 |
|---|---|
| 端数の補正量だけをキャッシュすると、同じ端数のまま整数px移動したとき原点相殺を更新できない | 絶対left/topもキャッシュキーへ含めた。各DPRで位置移動後さらに(4,4)px移動し、最大画素差0をE2E確認 |
| 全面平均 ≤1 ではDPR1.5の補間を見逃す。空のCanvas同士も差0になる | 最大差 ≤2とbitmap内の文字画素の存在を追加。修正後は実際に平均/最大とも0 |
| Canvasだけ移すと入力・選択の座標が分岐しないか | base/overlay同原点、補正は最大0.5 device px。stage/ViewportTransform/editor-placement/textarea/hitTestは変更なし。既存IME・選択・presence・select/date回帰で確認 |
| 位置の読み取りが描画を重くしないか | 既存rAFに1回のrect読みのみ追加、同位置ではCSSを書かない。120frameの読み取り平均0.0092/0.0117ms。既存50k行・wide-grid・罫線・背景の性能ゲートを通過 |
| DPR変更と破棄の処理 | DPR単独変化で両Canvas再確保・textCache clear・dirty更新。追加のlistener/observer/rAFなし。destroyが既存rAFとResizeObserverを解放する経路を維持 |
| Facade/互換性 | 内部renderの純関数とgrid内部のcontrollerのみ追加。公開シグネチャ/API版・IME/protocol/schemaを変更しない。consumer-strict・boundary lintはgreen |

最終差分に未対応の重大所見はない。認可・DB・データ変更へ波及しない Risk B。実機Chrome/GPU・Windows表示スケール125%・広島の実取り込み/商談受入は、この自己レビューとheadless試験からは保証しない。

全回帰の初回に既存 `openClient()` がtextarea生成をAPI公開完了とみなし、未初期化APIをsnapshotしthrowする起動待ちの競合が1件出た。対象シナリオに入る前の失敗で、既存の行操作15件をコード変更なしで再実行して全green。DD-058の画素6件も最終再実行でgreen。既存E2Eの内容は変更していない。
