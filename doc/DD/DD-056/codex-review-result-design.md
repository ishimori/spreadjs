認可フック方式と既存の冪等・再送処理の組合せは妥当ですが、Promise の失敗処理と IME の確定経路に実装前に解消すべき問題があります。文書撤去の受信停止・snapshot 終了境界と、Undo／Redo の拒否通知契約にも補完が必要です。

Full review comments:

- [P1] 認可フックが返した Promise の rejection も捕捉する — C:\repo\spreadjs\doc\DD\DD-056\contract.md:114-114
  §3.2 の Promise を厳密比較だけで拒否する契約では、①フックが `Promise.reject(...)` を返す、②操作を `permission-denied` にする、③未捕捉 rejection が発生する、という順序で Node.js の既定設定ではサーバープロセス全体が終了します。Node 22.20.0 でこの挙動を再現しました。同期認可・即時拒否は維持しつつ、返された Promise／thenable の失敗を捕捉して診断へ送る契約とテストを追加してください。これは [coding-standards.md:197](../../../templates/coding-standards.md#L197) の rejection 捕捉規約にも対応します。

- [P1] 最終 input が来ない IME 順序にも確定経路を設ける — C:\repo\spreadjs\doc\DD\DD-056\contract.md:218-218
  §4.4 の `blur` 流用だけでは、①変換中に input を受信、②compositionend、③最終 input は来ない、④setReadOnly／flush が blur を渡す、という順序で確定できません。`editor-state-machine.ts:538-542` は `EditingAwaitFinalInput` の blur を保留し、繰り返しても Commit を出さないことを再現しました。最終 input が来ない順序は既存テストの `editor-state-machine.test.ts:251-268` にも記録されています。この場合、flush はタイムアウトし、切替も編集を終了できません。逆にここで入力を遮断すると後続の最終 input を失います。AwaitFinalInput の扱いと、最終 input が来ない場合に textarea の確定値から安全に編集を終了する経路を設計・テストへ追加してください。

- [P2] 文書撤去時は切断より先に Bridge の受信を無効化する — C:\repo\spreadjs\doc\DD\DD-056\contract.md:252-252
  §5.2 には、撤去した RoomBridge 自体の受信停止がありません。既存の `server.ts:424-426` の切断処理ではマップ削除後も message listener が残り、`route` はソケットの CLOSING 状態を検査しません。①撤去で接続を閉じる、②既に到着していた join、③submitOperation の順では、登録簿にない旧 Room へ再参加・投入できます。この既存メソッドの挙動を再現しました。登録簿からの削除だけではこの経路を防げないため、Bridge に撤去フラグを立てて全受信を拒否してから切断・drain してください。未 join 接続と切断ハンドシェイク中のフレームもテスト対象に含める必要があります。

- [P2] 撤去の待機対象に非同期 snapshot 生成も含める — C:\repo\spreadjs\doc\DD\DD-056\contract.md:261-263
  §5.3 の配信 drain と adapter のキュー待ちだけでは、snapshot 生成の終了を保証できません。`PersistentRoom.maybeSnapshot` は生成を fire-and-forget で開始し、完了後にも再生成を予約します（`persistent-room.ts:326-332`）。一方、既存の close はストアを閉じるだけで、この生成処理を待ちません（同:374-376）。①snapshot 保存を保留、②受理済み配信を完了、③文書撤去、という順で snapshot 完了前に close が解決することを再現しました。撤去後も旧ランタイムが保存先へ書き込み得るため、生成停止フラグと生成 Promise の待機を PersistentRoom の終了手順へ追加し、保存を遅延させた撤去・同じ ID の再追加を検証してください。

- [P2] Undo／Redo の認可拒否を公開イベントへ写す方針を決める — C:\repo\spreadjs\doc\DD\DD-056\contract.md:110-110
  §3.2 は認可拒否を grid の `permission-denied` として通知するとしていますが、§3.3 のコード表追加だけでは Undo／Redo に適用されません。①編集を受理、②サーバー側で書込禁止、③読み取り専用通知が届く前に Undo を送ると、`mount-controller.ts:1686-1698` が拒否理由によらず `undo-blocked`／`redo-blocked` に置き換えて return します（`undo-stack.ts:258-262`）。consumer は権限拒否を通常の補償競合と区別できません。Undo 状態の後始末は維持しつつ認可拒否コードを優先して通知するか、この例外を公開契約に明記し、両操作のテストを追加してください。