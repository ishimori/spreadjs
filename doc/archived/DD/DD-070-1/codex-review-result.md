入力確定の計測は実際の submit を通っておらず、現状の結果から「確定 50ms 未満」とは判断できません。入力データを evaluate の外へ返さず GC 後にヒープを読む順序と、ケースごとのページ分離は妥当ですが、欠測時の合格と過去の証跡の混在も防ぐ必要があります。

Full review comments:

- [P1] IME の確定キーを解放してからセル確定を計測する — C:\repo\spreadjs\apps\playground\e2e\zz-rm-database-perf.spec.ts:197-201
  `compositionend` は `editor-state-machine.ts` の `suppressCommitUntilKeyup` を立て、直後の `input` はこれを解除しません。そのため、ここで計時している最初の Enter は `SuppressKey` で終わり、セルを確定しません。記録された 0.4〜0.7ms は submit の所要時間ではありません。`standalone-helpers.ts` の `composeCommitAtCell` と同じく計時前に Enter の `keyup` を送り、計時後に対象セルの `cell-commit` が値 `12.5` で1件発生したことを確認してください（[AGENTS.md:38](AGENTS.md#L38)）。

- [P2] フレーム標本がない場合は 0ms ではなく計測不能にする — C:\repo\spreadjs\apps\playground\e2e\zz-rm-database-perf.spec.ts:183-185
  最初のスクロール描画で 1,500ms 以上停止すると、2回目の rAF で計測が終了し、`slice(2)` 後の標本は空になります。現状は p50・p95・最悪値をすべて 0ms とし、重いケースほど合格し得ます。ウォームアップ後に計測時間を開始し、有効な間隔が得られなければ例外として扱ってください。

- [P2] 縦・横それぞれで実際にスクロールしたことを確認する — C:\repo\spreadjs\apps\playground\e2e\zz-rm-database-perf.spec.ts:152-153
  行数・列数は正しくても、スペーサーのサイズが反映されず `max` が 0 なら、毎フレーム同じ位置に 0 を代入するだけです。`scroll` イベントによる再描画が起きないまま、アイドル時の約 16.7ms をスクロール性能として記録します。各軸で正の可動範囲と実際の位置変化を確認し、動かなかった軸は計測不能にしてください。

- [P2] JSHeapUsedSize が取得できなければ計測エラーにする — C:\repo\spreadjs\apps\playground\e2e\zz-rm-database-perf.spec.ts:95-96
  `Performance.getMetrics` が成功しても応答に `JSHeapUsedSize` がない場合、`?? 0` により 0MB が証跡に残り、300MB 未満の判定も通ります。GC を待つ順序は正しいので、取得値が有限の正数であることを確認し、欠測は既存の例外記録経路へ渡してください。

- [P2] 行数反映の待機をテスト本体より短い期限で打ち切る — C:\repo\spreadjs\apps\playground\e2e\zz-rm-database-perf.spec.ts:133-139
  再注入後に行数が期待値に届かないと、`tick` は例外を出さず rAF を予約し続けます。最初に効く期限は Playwright のテストタイムアウトなので、記録専用の 50,000 行でもテストが失敗し、`catch` で正常終了させられません。テスト期限より短い計測期限を設け、超過時はコンテキストを閉じて計測エラーを JSON に記録してください。

- [P2] 列数不一致も記録専用ケースのエラー経路で扱う — C:\repo\spreadjs\apps\playground\e2e\zz-rm-database-perf.spec.ts:243-247
  `expect(result.columns)` は `judged` の分岐より前、かつ計測の `try` の外にあります。180 列でなかった場合、50,000 行のケースでも通常の測定値を保存してからテストが失敗し、JSON に失敗理由が残りません。列数は計測の前提なので、列 ID を列挙した時点で検証し、不一致は `measure` の例外として既存のケース別処理に渡してください。

- [P2] 証跡 JSON を実行単位で分離する — C:\repo\spreadjs\apps\playground\e2e\zz-rm-database-perf.spec.ts:73-79
  `saveResult` は Playwright の `outputDir` の外にある前回の JSON を読み、今回実行したケースだけを上書きします。全件実行の後に `--grep` で1件だけ再計測した場合や途中で中断した場合、未実行のケースも以前の値で埋まり、今回の4件分の証跡と区別できません。実行ごとに空の結果から始めるか、実行 ID ごとに保存して今回の結果だけを集約してください（[AGENTS.md:40](AGENTS.md#L40)）。

- [P3] 計測用 API の型は SDK の定義を参照する — C:\repo\spreadjs\apps\playground\e2e\zz-rm-database-perf.spec.ts:103-104
  `window as unknown as ...` で `rowCount` と `colIdAt` の型を手書きすると、SDK 側で観測 API を変更してもこの宣言に反映されず、実行時まで不一致が分かりません。standalone が公開する `GridDebugApi` の型を参照し、API が未初期化なら明示的に例外にしてください。ダブルキャストは[コーディング基準 P19](doc/templates/coding-standards.md#L366)でも禁止されています。