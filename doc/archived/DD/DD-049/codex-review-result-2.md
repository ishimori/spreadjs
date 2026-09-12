要修正。元の2件の再現条件は解消しましたが、reject応答の停滞と別文書hookの再入を実行確認しました。Vitestは権限制約で実行できず、書き込み不要の独自スクリプトで検証しました。

Full review comments:

- [P1] 確定済みのreject応答を先行append待ちで止めない — C:/repo/spreadjs/packages/server-hono/src/server.ts:490-492
  onAccepted未指定でも、先行操作のappendを保留してから確実に競合する操作（保存済みセルに古いbeforeRevisionを指定）をsubmitすると、確定済みの`stale-cell-revision`応答までFIFO先頭で止まります。実行比較ではHEADはappend解放前にrejectedで解決しますが、修正後は解放まで未解決でした。ストアがsettleしなければ、永続化を必要としない競合応答も永久に返りません。revisionを消費しないreject結果は受理配信の順序待ちから分離し、append保留中に応答できる回帰テストを追加してください。

- [P2] 別文書へのsubmitでもhookの再入を抑止する — C:/repo/spreadjs/packages/server-hono/src/server.ts:483-487
  永続化なしの複数文書構成で、文書Aのhookから文書Bへsubmitすると、実行順が`A開始→B開始→B終了→A終了`になります（実行確認済み）。フラグがRoomBridge単位なので、B側では配信ループが即座に開始され、[hookを入れ子にしない契約](doc/DD/DD-049/contract.md#L56)に反してconsumerの処理途中へ再入します。serve単位でhookの実行状態を共有し、別文書へのsubmitも実行中hookの終了後に通知・解決するようにして、このケースを回帰テストへ追加してください。

- [P3] S9で同一dataチャンクという再現条件を検証する — C:/repo/spreadjs/packages/server-hono/src/serve-on-accepted.test.ts:108-112
  `cork/uncork`は送信側の書き込みをまとめますが、TCPの受信側で同じdataチャンクになる保証はありません。2フレームが別イベントとして処理されると、修正前でも間のマイクロタスクでserver操作が配信され、現在の`[2,3,4]`検査が通ります。受信側で両フレームが同一チャンクだったことを検証するか、同一同期区間に2フレームを投入する決定的なテストを追加し、再現条件が成立しないままgreenになる余地をなくしてください。