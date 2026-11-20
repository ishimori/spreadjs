初回状態の受理と描画フレームの間で、保存済みの並びが効かない、新しい指定が古い予約に戻される、直後の挿入行が隠れる経路があります。再接続 E2E は差分取得しか通らず、後片付けには共有シード行を削除し得る競合もあります。

Full review comments:

- [P1] revision 0 の非空文書では bootstrap の受理まで待つ — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:396-396
  `hasInitialState` だけでは初回文書の到着を判定できません。`Room.shouldBootstrap()` は非空の `initialDocument` に `welcome@0`、`bootstrap@0` の順で送りますが、`ClientSession.handleWelcome()` は revision 0 の welcome だけでフラグを立てます。2 通の間に列の準備が済んで drain が走ると、保存済みの並びを空文書に対して組み立て、bootstrap の全行が「後からできた行」として表示されます。空文書で同期完了した場合と snapshot 待ちを区別し、2 通の間に描画フレームを挟む回帰テストを追加してください（[AGENTS.md:38](./AGENTS.md#L38)）。

- [P2] 初回同期後の新しい setRowView を古い予約で上書きしない — C:\repo\spreadjs\packages\grid\src\mount\row-view-switch.ts:144-145
  初回同期前に指定 A を予約し、同期後かつ次の rAF 前に指定 B または `null` を渡すと、B は即時反映されますが、後からキュー内の A が実行されて元に戻ります。初回待ちの指定に世代を持たせるなど、後続の有効な指定で古い予約を失効させ、この順序を部品単体でも確認してください（[AGENTS.md:38](./AGENTS.md#L38)）。

- [P2] 初回文書の行集合を次の描画までに届いた操作と分ける — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:400-404
  bootstrap の直後、次の rAF より先に他の参加者の挿入が届くと、`run()` が `createRowViewSpec()` を呼ぶ時点の文書には挿入行まで含まれます。その行は `known` に入って隠れ、決定 2 の位置に表示されません。初回状態を適用した時点で `known` を確定し、描画だけを後に回してください。これなら、非表示のコンテナ内の空文書で行・列どちらの drain 条件も成立せず、最初の挿入まで指定を組み立てられない場合も扱えます。

- [P2] 行ビューを反映した Axis で後続の保留命令を実行する — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:402-407
  初回待ちで `setRowView`、`setActiveCell` の順に予約しても、`commands.drain()` は各命令の前提を再確認せず続けて実行します。同期前に列だけ準備できれば選択命令は未知行として消え、同期後にまとめて実行されても `setRowView` は dirty を立てるだけなので、後続命令は旧 Axis で隠すはずのセルを選択できます。行を使う命令は初回状態と先行する並びの構造 flush の両方を待たせ、`scrollToRow`・`setActiveCell` まで連続して呼ぶ実 mount テストで確認してください（[AGENTS.md:38](./AGENTS.md#L38)）。

- [P2] 初回状態の前は楽観挿入があっても visibleRowIds を空にする — C:\repo\spreadjs\doc\quick-start.md:729-729
  backend の結線後、welcome の前でも `insertRows({ afterRowId: null })` は許可され、`submitLocalOperation()` が楽観行を `viewDocument` に追加します。`visibleRowIds()` は `pendingRowOrder()` をそのまま返すため、このタイミングでは新しく保証した `[]` ではなくその行 ID が返ります。`getRows` と同様に初回状態を確認してから行を読み、楽観挿入のあるケースもテストしてください。

- [P2] テストの後片付けでは挿入イベントが返した行 ID だけを消す — C:\repo\spreadjs\apps\playground\e2e\row-view-collab.spec.ts:177-179
  `pendingCount === 0` は B の行 Axis が再構築済みであることを保証しません。AC5 で ACK が描画より先に届くと、`f3` の次として既存のシード行を取得して `cleanup` に入れ、検証失敗後の `finally` がその行を削除します。AC2 も検証対象である A の表示結果から削除対象を推測しています。B の `row-structure-change` が通知する `change.rowIds` を挿入直後に記録し、期待値と後片付けの両方に使ってください。

- [P2] AC5 で再接続時の snapshot bootstrap を実際に通す — C:\repo\spreadjs\apps\playground\e2e\row-view-collab.spec.ts:180-182
  A は準備用の挿入を受信済みで revision が正、切断中の差分は 1 操作だけなので、`Room.shouldBootstrap()` は必ず tail を選びます。このテストは catch-up の確認にはなりますが、文書の丸ごと入れ替えで並びを失う回帰があっても成功します。現ケースは残し、snapshot を選ぶ条件を作ったケースで `bootstrapRevision` が切断前から進んだことと復帰後の並びを両方確認してください。

- [P2] AC4 でサーバー拒否と描画順の巻き戻しを区別して確認する — C:\repo\spreadjs\apps\playground\e2e\row-view-collab.spec.ts:236-238
  `rejectedCount` はクライアントの実行前拒否でも増えます。また `visibleRowIds()` は描画済み Axis ではなく文書から並びを計算するため、楽観操作が一度も画面に出ていない場合や、拒否後に Axis が古いままの場合も現在の判定は通ります。拒否応答を一時保留して楽観時の `rowIdAt`／行数を観測し、応答解放後に `permission-denied` と描画済みの並びの復元を確認してください。

- [P2] AC6 の比較基準を他者の枠がない状態で取得する — C:\repo\spreadjs\apps\playground\e2e\row-view-collab.spec.ts:198-200
  `hiddenCount` は隠れた行を選んだ後に採っているため、そこで名前タグだけが誤描画されても、可視行で画素が増え、隠れた行に戻ると元の画素数になれば成功します。さらに `presences.length > 0` は B が `f2` に移動したことを示さず、300 ms 待っても受信・描画の保証にはなりません。A の選択を固定して B の枠がない基準画像を先に採り、B の `activeCell.rowId` の受信と描画を待って、隠れた状態が基準と一致することを確認してください。

- [P3] AC1 の Undo 深さを並べ替え前に記録する — C:\repo\spreadjs\apps\playground\e2e\row-view-collab.spec.ts:104-104
  `bUndo` を取得するのは A が `setRowView` を呼んだ後なので、並べ替え自体が B の Undo 履歴を変更しても検出できません。B の Undo 深さと表示順を操作前に保存し、A の並べ替え直後に同じ値であることを確認してから、後半の編集・Undo の検証に進んでください。