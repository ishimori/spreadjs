通常の編集・貼り付け・Ctrl+D／Ctrl+R は共通の検証経路を通り、数値判定と `validateCell` の順序も決定どおりです。ただし、mount 直後に設定配列が変更されると、競合検査と実際の型変換が食い違い、数値列が正当な入力まで拒否します。

Full review comments:

- [P2] stringColumns の競合検査と型変換で同じ列集合を使う — C:\repo\spreadjs\packages\grid\src\mount\config.ts:92-92
  `mount-controller.ts` は `mount()` の同期処理で `stringColumnStrings` を作りますが、競合検査は非同期の起動時に元の `options.stringColumns` を読み直します。たとえば数値列 `wt` を含む配列を渡し、`mount()` の直後にその配列を空にすると、競合検査を通過する一方、編集・貼り付けは `wt` を文字列に変換し続けるため、正当な `12.5` まで拒否されます。競合検査にも型変換用の `stringColumnStrings` を渡してください。

- [P3] 数値列による拒否を validateCell の拒否として記録しない — C:\repo\spreadjs\packages\grid\src\mount\edit-submit.ts:107-109
  数値列に `ND` を入力すると、`validateCell` が未指定でも `onDiagnostic` に「validateCell が 1 件を拒否」と届きます。数値列の拒否を同じ `invalid` 配列に加えたことで、実際には呼んでいないコールバックが原因として報告されます。診断文を「確定前の検証で N 件を拒否」のように両方に当てはまる表現に変更してください。

- [P3] 範囲操作の全体拒否を複数の書き込み先で検証する — C:\repo\spreadjs\apps\playground\e2e\number-column.spec.ts:61-67
  この AC2 の E2E は A→B の Ctrl+R で書き込み先が B の 1 セルしかないため、「不正セルだけ飛ばして正常セルは書く」という回帰でも成功します。追加された貼り付けの単体テストも、不正セルは 1 件だけです。正常な書き込み先と不正な書き込み先を少なくとも 2 件含む範囲を用意し、正常セルも元の値のままで、`cell-invalid.cells` に不正セルがすべて載ることを確認してください。これは[実物を mount して結線を確認する規約](AGENTS.md#L38)で確かめるべき振る舞いです。

- [P3] cell-invalid の E2E は公開イベント型から絞り込む — C:\repo\spreadjs\apps\playground\e2e\number-column.spec.ts:20-20
  `as unknown as InvalidEvent[]` は、テストが参照する `cells` や `source` と SDK の公開型との対応を型検査から外しています。playground が保持しているイベントは既に `GridEvent[]` なので、その型のまま読み取り、`type === 'cell-invalid'` で絞り込めばローカルの型定義も二重キャストも不要です。[コーディング基準 P19](doc/templates/coding-standards.md#L366) でもこのキャストは禁止されています。