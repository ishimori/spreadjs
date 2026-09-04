文書選択後の operation envelope を検証していないため、oplog 汚染と次回起動時の検疫を引き起こせます。また、一文書の close 失敗で残りの runtime と HTTP/WS server の後始末が中断します。

Full review comments:

- [P1] Validate every operation envelope's document ID — C:/repo/spreadjs/packages/server-hono/src/server.ts:287-289
  厳格接続でも検証されるのは最初の join だけです。`/ws?documentId=doc-a` へ正しく join したクライアントが、その後 `envelope.documentId = doc-b` の `submitOperation` を送ると、ここから doc-a の Room へそのまま渡され、Sequencer は documentId を検証しないため doc-a に適用しつつ doc-b として oplog に保存します。次回復旧では全 entry の ID 照合に失敗して doc-a が検疫されるため、各 submit でも担当 runtime と envelope の ID を照合または上書きしてください。

- [P1] Continue teardown after a runtime close failure — C:/repo/spreadjs/packages/server-hono/src/server.ts:623-626
  複数文書のうち一つの consumer 注入ストアで `close()` が reject すると、このループはそこで中断して後続文書のストアを閉じません。通常の `stop()` では `closeServer` もその例外で中断するため、認証待ち socket、WebSocket、HTTP server まで残り、起動時の resolver/spec/listen 失敗時にも後続 runtime がリークします。close エラーを収集しつつ全文書と外側の server teardown を完遂してから reject する必要があります。

- [P2] Wait for M7's connection before asserting rejection — C:/repo/spreadjs/packages/server-hono/src/serve.documents.test.ts:275-277
  `createSessionClient()` の直後は `session.isOnline` が false かつ `connectionCount()` が 0 なので、この `waitFor` は upgrade/join が処理される前に即成功します。そのため不一致 join をサーバーが受理する実装でも M7 は通り、直後の cleanup が接続を閉じます。実際の open 後に close code 1008 を観測するなど、接続試行が完了したことを確認してから拒否を検証してください。

- [P2] Make the isolation assertion observe the full delay — C:/repo/spreadjs/apps/playground/e2e/multi-document.spec.ts:65-67
  `expect.poll(...).toBe(beforeRevision)` は最初の一致で終了し、`timeout` の間値が不変であることは確認しません。doc-b は初回サンプルでは必ず未変更なので、doc-a の ACK 後に遅れて別文書フレームが届く不具合でも、続く即時の cell/hash 検査より後なら E2E が成功します。指定期間を通して revision、cell、hash が不変であることを監視する形にしてください。