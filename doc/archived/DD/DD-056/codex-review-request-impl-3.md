# Codex レビュー依頼（DD-056-3: 実行中の文書の追加と撤去・H13）

## 対象

DD-056-3 の実装コミットをレビューする。対象 SHA は起動時のレビュー範囲指定で渡す。未コミット変更は対象外。周辺コードも対象コミットから読む。
設計の正本は `doc/archived/DD/DD-056/contract.md` §5、受け入れ基準は `doc/archived/DD/DD-056-3_実行中の文書の追加と撤去.md`。
H11・H12 は別途レビュー済みであり、対象は H13 と既存の close／受信停止の修正。

## 背景と契約

広島空港 consumer は予算版ごとに異なる文書 ID を使う。サーバーを止めずに新版を追加・旧版を撤去し、旧版への遅い入力を受け付けない。

- `addDocument(id, config)` は起動時と同じ検証・復旧・初期生成を行う。空・重複・処理中・停止後は reject。復旧失敗時は開いた保存先を閉じる。
- `removeDocument(id)` は登録削除→RoomBridge の受信停止→全接続1001→受理済み操作の永続化・配信・onAcceptedを待つ→実行中の snapshot 生成を待ってストア close→解決。
- 保存先は消さない。同じ ID・保存先で足し直すと履歴の続きから復旧し、旧クライアントの再送も受け付ける（別版は別 ID）。
- 同じ ID への並行処理を拒否し、stop は追加・撤去を待つ。停止後に復旧を終えた追加は登録せず閉じる。
- `documentIds`・`quarantined` は読むたびに最新。検疫した ID の追加成功で検疫一覧から外す。
- upgrade の認証待ち・handshake と撤去が競合しても、旧 Room へ接続を付けない。切断済み接続からの後続フレームも捨てる。

## 重点観点

1. 永続化・snapshot・配信・onAccepted・ストア close の順序。撤去解決後の書込、受理済み操作の喪失・重複、永遠に解決しない経路。
2. upgrade／join／submit と撤去・同一 ID の足し直しの競合。既定文書の撤去、単一文書構成への追加、未 join 接続。
3. add/remove/stop の並行と失敗経路で、登録簿・処理中 ID・ストアハンドル・タイマー・ソケットが取り残されないか。
4. consumer callback（authorizeOperation・onAccepted・diagnostic・ストア）からの再入。既存の認可再入ガードを破らないか。
5. テストが上記を実際に検知するか。公開面の追加と既存契約の互換性、Quick Start・ADR との整合性。

## 検証と出力

実 WS の `serve.lifecycle.test.ts` 8件、RoomBridge/adapter の `serve.lifecycle-bridge.test.ts` 6件、PersistentRoom の追加1件は green。
全 unit・invariants・contract は1436件 green（このWindows環境の最初のlistenは約10秒のため `--testTimeout=40000 --hookTimeout=40000`）。
公開型 snapshot の変更はメソッド2つの追加とJSDoc・import。全 workspace typecheck・consumer-strict・lint green。

P1=受理済み操作の喪失・重複／永続化破壊／不正な文書への受理、P2=契約違反・実装の穴・重要なテスト不足。
各指摘は重さ・file:line・具体的な再現手順・修正案を日本語で書く。ソースで裏付けられない推測や命名の好みは省く。指摘なしなら明記する。
