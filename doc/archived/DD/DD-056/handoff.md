# 広島空港向け DD-056 引き渡し（H11〜H13）

広島空港 H11〜H13を取り込む場合は**0.1.0-alpha.12**を使用する。
H11・H12だけを含むalpha.11も、予定どおり別の配布物として保存している。

## 配布先

- 最新: `C:/repo/spreadjs/release/0.1.0-alpha.12/`（10tarball＋manifest＋README）。
- ZIP: `C:/repo/spreadjs/release/nanairo-sheet-0.1.0-alpha.12.zip`。
- H11・H12: `C:/repo/spreadjs/release/0.1.0-alpha.11/`・`release/nanairo-sheet-0.1.0-alpha.11.zip`。
- API版は`0.1.0-experimental`。10packageは同じ版で一括installする（README・manifest参照）。

## consumerで行うこと

| 要件 | SDKの提供 | 広島側の取り込み・確認 |
|---|---|---|
| H11 操作の認可 | serveのauthorizeOperation、permission-denied、送信元の巻戻し | authenticateで操作者を確定し、部署・予算版・受付状態に応じてフックを判定する。提出後の再入力や締切後の経営戦略部の編集など、広島の業務ルールを実装する |
| H12 切替・送り切り | setReadOnly、pendingCount、flush、React readOnlyの同一instanceへの写像 | 読み取り専用への開き直しを廃止する。提出前は呼出時の編集の確定とflushを待ち、rejectedイベントで拒否の有無も扱う。timeout・stoppedで成功扱いしない |
| H13 予算版の切替 | addDocument・removeDocument、文書一覧の更新 | 新版を別IDで追加し、旧版を撤去する。版と文書IDの対応・保存先・クライアントへの新版案内をconsumerが管理する |

- flushのflushedは自分のpendingが0になったことを表し、全操作の受理を保証しない（拒否もpendingを減らす）。拒否された値の通知・履歴はconsumerで扱う。
- 読み取り専用は表示制御。別クライアントや遅い再送をサーバーで止めるのはauthorizeOperation。
- 認可フックは同期でtrueだけを許可する。返したPromise・throwは拒否。認可フック内からsubmit・stop・addDocument・removeDocumentを呼ばない。
- removeDocumentは受理済みの保存・配信・onAcceptedとsnapshotを待つ。保存先を消さない。同じIDで追加し直すと旧クライアントの再送も受け付けるため、別版は必ず別IDを使う。
- SDKの変更をconsumerに取り込んだ後、広島`doc/poc/sdk-requirements.md`の「取り込み結果」を更新する。SDK側では広島リポを変更していない。

## 検証と残る確認

詳細はverification.md、契約はcontract.md、APIは公開JSDocと型snapshot。
自動検証は型検査・consumer-strict・lint・unit/invariants/contract1441件・全playground E2E249件がgreen。
実OS IMEのT1、広島PoCの取り込みと業務シナリオ、実画面・商談受入は未実施。
Git push・registry publishは行っていない。
