コミット d98d9f5 のコードで、同期購読者による状態変更時の二重通知と、IME変換中のclipboard操作による対象外通知を確認しました。いずれも通知の決定事項に反するため、修正が必要です。

Full review comments:

- [P2] 同期購読者の状態変更後も打鍵ごとの通知済み状態を保持する — C:\repo\spreadjs\packages\grid\src\mount\keyboard.ts:194-195
  表全体と選択中のセルが両方読み取り専用の場合、印字キーの最初の `edit-blocked` 購読者が同期的に `setReadOnly(false)` を呼ぶと、この条件が成立して同じ打鍵について再度通知します。コミット版のコードで、1回の打鍵から2回通知されることを確認しました。現在の `readOnly` 値だけで重複を避けず、打鍵ごとの通知済み状態を保持する必要があります。

- [P2] clipboard経路でも変換中・非Navigationの通知を除外する — C:\repo\spreadjs\packages\grid\src\mount\edit-blocked.ts:70-75
  IME変換中に `setReadOnly(true)` を呼ぶと、変換終了待ちの間は表全体の読み取り専用判定だけが先に有効になります。この間の貼り付け・切り取りは `clipboardActive()` より前の分岐から通知され、ここにも位相の確認がないため、`Composing` 中でも `edit-blocked` が発火します。これは決定事項6の通知対象外条件に反します。既存の操作抑止は維持し、通知だけを変換中・非Navigationでは出さないようにしてください。