実行中の結合追加によるIMEの停止と、既存ポップアップからの読み取り専用の抜けをDOMイベントで再現しました。競合解消後の再判定と不正引数の扱いにも契約違反があります。

Full review comments:

- [P1] 結合の追加後も進行中のIME終了イベントを通す — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:1359-1360
  IME変換中のセルを含む結合を `setMergedCells` で追加すると、この条件が即座に true になり、`integration-editor` が `compositionend` と最終 `input` まで破棄します。DOMイベントで再現すると内部の composing が true のまま残り、Enter・Escape・別セルへの移動でも編集を終了できません。新しい編集開始の抑止と進行中の変換の終了を分け、終了イベントは通すか、ロックの適用を変換終了まで遅延してください。

- [P2] 結合されたセルの既存ポップアップを閉じる — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:602-603
  候補欄を開いた後、その対象セルを `setMergedCells` で結合しても、ここでは既存のポップアップを閉じません。実際に次の描画後も候補欄が残り、ArrowDown→Enter で結合セルの値が更新され、`cell-commit` が発火します。カレンダーの確定処理にも同じ防御がありません。結合変更時に対象ポップアップを閉じ、確定時にも対象が結合内でないことを確認してください（[契約 §2](doc/DD/DD-064/contract.md#L64-L70)）。

- [P2] 競合で張らなかった結合の行IDを固定しない — C:\repo\spreadjs\packages\grid\src\merged-cells.ts:166-170
  固定行境界・重なりの判定より先に `boundIds` を保存するため、一度も張られていない結合まで後で broken になります。例えば固定1行で `r0` から2行の結合を指定し、行順を `[top, r0, middle, r1, …]` にすると、固定境界との競合は解消していますが、古い `[r0, r1]` が非連続になったとして永久に捨てられます。[契約 §1.2](doc/DD/DD-064/contract.md#L51-L54) の「条件が解ければ描く」を満たすよう、初回の行ID固定は競合検査を通過した時点で行ってください。

- [P2] 命令のundefined引数を空配列として適用しない — C:\repo\spreadjs\packages\grid\src\merged-cell-spec.ts:61-62
  JSから `setMergedCells(undefined)` を呼ぶと、mountオプション省略用のこの分岐を通り、警告なしで全結合が解除されます。[契約 §1.1](doc/DD/DD-064/contract.md#L45-L46) では、命令への非配列は警告して既存設定を維持する必要があります。mountでの省略と命令の不正引数を区別してください。