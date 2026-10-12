対象コミットを読み込んだ再現で、撤去後の操作受理と actorId の上書き抜け、再入時の stop の早期完了、close 失敗時の保存先未解放を確認しました。通常経路のテストが green でも、これらの競合・失敗経路は修正が必要です。

Full review comments:

- [P1] 診断コールバック後にも撤去・切断状態を再確認する — C:\repo\spreadjs\packages\server-hono\src\server.ts:333-335
  単一文書構成で `/ws` に接続して正しく join した後、別 documentId を名乗る submit を送り、`document-mismatch` の診断内で `removeDocument` を呼ぶと再現します。入口のチェック後に `normalizeDocument` の診断から撤去へ再入でき、そのまま旧 Room に操作が投入されます。実 WS で、登録削除後の永続化と、接続メタの削除によって認証済み actorId ではなく申告した偽の actorId が記録されることを確認しました。[撤去契約](doc/archived/DD/DD-056/contract.md#L291)を守るため、診断から戻った後、Room 投入前にも撤去状態と接続メタを確認して処理を中断してください。

- [P2] consumer callback を呼ぶ前に追加処理を追跡する — C:\repo\spreadjs\packages\server-hono\src\server.ts:1621-1622
  追加する文書の `snapshotStore.loadLatest()` 内で `server.stop()` を呼び、読込結果を未解決 Promise で保留すると、追加ストアを閉じる前に stop が解決します。async IIFE は同期に復旧処理へ入り、`trackTransition(work)` は callback が戻ってから実行されるため、再入した stop はこの追加を待機対象に含めません。実行で、読込を保留したまま stop が解決し、追加ストアの close が未実行であることを確認しました。[停止の待機契約](doc/archived/DD/DD-056/contract.md#L296)に合わせ、追跡用 Promise を登録してから復旧処理を開始してください。

- [P2] close に失敗した撤去文書を後始末対象に残す — C:\repo\spreadjs\packages\server-hono\src\server.ts:1650-1653
  注入した `oplog.close()` が reject する構成で文書を追加し、removeDocument の拒否後に stop を呼ぶと、`snapshotStore.close()` は一度も呼ばれません。runtime は既に登録簿から削除され、ここで ID 予約も解放されるため、失敗した文書が stop の後始末対象から失われます。同じ ID の再追加も許され、未解放の保存先と新しい runtime が併存できます。両ストアの後始末を独立して試行し、close に失敗した runtime は再試行可能な後始末管理に残してください。