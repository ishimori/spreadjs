要修正。通知順序違反と失敗隔離の破れを実行で確認しました。Vitestは一時ディレクトリ作成権限の制約で実行できませんでした。

Full review comments:

- [P1] 再入した submit とクライアント操作の通知順を統一する — C:\repo\spreadjs\packages\server-hono\src\server.ts:252-255
  永続化なしで、連続する2つのWSフレームの最初の受理hookから `server.submit()` を呼ぶと、通知が `2(client) → 4(client) → 3(server)` になります（実行で再現）。`submitFromServer` は同期Roomにも `await` する一方、`route` は次フレームを同期で配信・通知するためです。[契約のrevision昇順保証](doc/DD/DD-049/contract.md#L49)に反し、履歴や差分集計が順不同になります。両経路の配信・通知を同じ順序管理に統一し、連続フレーム＋hook内submitの回帰テストを追加してください。

- [P2] hook失敗の診断処理自体も例外隔離する — C:\repo\spreadjs\packages\server-hono\src\server.ts:458-462
  hookが `Object.create(null)` をthrowまたはrejectすると、`errorMessage(error)` の文字列化がTypeErrorを投げます。同期throwでは受理済みの `submit()` がrejectし、async rejectでは戻り値を監視していない `.then()` から未処理rejectionが発生することを再現しました。標準設定のNodeでは後者がプロセス終了につながり、[失敗隔離契約](doc/DD/DD-049/contract.md#L55)を破ります。診断用の文字列化にも安全なフォールバックを設け、`reportAcceptedFailure` が例外を外へ出さないようにしてください。