# DD-056: 広島空港 PoC 向け拡張（consumer 駆動: 広島空港 H11〜H13）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-10-12 | 2026-10-12 | 検討中 | consumer 駆動（広島 DDP-001）。広島のセッションから起票。Human Spec Gate 以降は本リポのセッションで進める |

> アプローチ: 標準（アンブレラ。要件の範囲・API の形・子DD分割を決め、実装は子DDで行う）
> リスク: あり（認可に当たるサーバー側の書込禁止 — H11）
> 起票注記: 広島空港リポ（`C:/repo/hiroshima-airport`）のセッションから、ユーザーの指示で起票した（2026-10-12）

```text
Risk Class: A（起票時の仮判定。H11 は sequencer の検証段に拒否の判定を足し、拒否コード〔protocol の語彙〕を増やす見込み。H13 は serve の文書構成を実行中に変える。子DDで再判定）
Risk Triggers: protocol（拒否コードの追加・拒否時のクライアントの巻き戻し）／永続化（実行中の文書の追加・撤去と保存先）／データ消失の防止（開き直しで未送信の操作が消える経路・外した文書への再送）／公開 API（ServerInstance・grid／React handle）の追加
Human Spec Gate: required（論点1〜5）
Codex: 未定（子DDの実装後にユーザー指示で実行。A の原則は xhigh）
Manual Gate: なし（サーバー単体と 2 クライアント E2E で判定できる見込み）
External Review: なし
Evidence Level: standard
```

## 目的

consumer（広島空港 予算管理システムの PoC。2026-10-22 の商談で見せる）は、各部署が共同編集で予算を入力し、部署の提出・全社の受付締切・予算版の確定のあとにシートを書込禁止にする。
そのために足りない機能（要件メモ H11〜H13）について、扱う範囲・API の形・子DD分割を決め、子DDで実装して alpha 配布する。

## 背景・課題

- 要件の正本: 広島リポ `doc/poc/sdk-requirements.md`（H11〜H13。DD-005 の要件メモ H1〜H10 の続き）。乖離したらメモ側が勝つ（DD-053 と同運用）
- 発見の経緯: 広島 DDP-001（PoC の画面構成・業務シナリオ・状態遷移の設計案。広島 `doc/poc/screen-design.md` §4.5・§7）。
  その Codex レビュー（high）が P1 を2件指摘した — 版の境目で古い操作が再送されて新しい版に入る／読み取り専用へ開き直すと未送信の入力が消える
- consumer の構成: 文書（シート）は「部署×予算版」ごと。提出・締切・確定のあとはシートを読み取り専用にする。新しい版を作るときに文書の構成が変わる
- 現状（alpha.9〔広島 mock の取り込み版〕のソース。HEAD〔alpha.10〕で読み直す）:

| H | 要件 | 優先 | 現状の要点 | 関連 |
|---|------|------|-----------|------|
| H11 | 文書単位の書込禁止をサーバーで強制する（fail-stop しない拒否） | 高 | 読み取り専用3種は表示制御（`packages/grid/src/index.ts` の JSDoc「権限制御ではない」）。`append` の拒否は以降の書込を止める（`packages/server-hono/src/serve-types.ts:80-90`）。sequencer の「検証」段に利用側の判定を差し込む口がない（`packages/server/src/sequencer.ts:92`） | DD-005 要件メモ H7（行の編集権限・stage2-backlog §3.7） |
| H12 | 未送信の操作を失わずに読み取り専用へ切り替える | 高 | `readOnly` は mount 固定。React は props の変化で `destroy()` → 再 mount し（`packages/react/src/index.ts:566`）、未送信の操作は引き継がない。未送信の数・送り切りを知る公開 API がない | — |
| H13 | 実行中に文書を足す・外す（外した文書の再接続・再送を受け付けない） | 中 | 文書の構成は `serve()` 起動時だけ（`packages/server-hono/src/index.ts:146` の `ServerInstance` に追加・撤去がない）。再接続は未 ACK を再送する（`packages/collab/src/session.ts:124-126`） | DD-043（複数文書 serve） |

- consumer のつなぎ（広島 screen-design §7）: H11 は受理直後に元の値へ戻す SetCells を `submit`（system）で送る（行の挿入・削除は戻せない）。
  H12 は「接続中で、最後の入力から数秒たった」を条件にする。H13 は版を作るとき `stop()` → `serve()` で立て直す

## 検討内容（Human Spec Gate）

| # | 論点 | 選択肢 | 推奨と理由（起票時の仮説） |
|---|------|--------|------------------------|
| 1 | H11 の形 | (a) 文書単位の書込禁止フラグ（例 `ServerInstance.setWritable(documentId, boolean)`）／(b) 操作ごとの認可フック（例 `serve({ authorize(envelope, identity) })` → 許可または拒否コード）／(c) 両方 | **(a)**。consumer に要るのは文書単位で、判定が単純でテストしやすい。H7（行の権限）まで見据えるなら (b) が有力。H7 を同時に扱うかとあわせて決める |
| 2 | H11 の拒否の伝え方 | (a) 既存の reject 経路に拒否コードを足す（例 `document-read-only`）／(b) 文書ごと受信専用に切り替える通知をサーバーから送る | **(a)**。既存の reject と同じく送った側が巻き戻る。protocol の語彙が増えるので A。(b) は H12 と重なるので論点3と一緒に決める |
| 3 | H12 の形 | (a) 未送信の操作の数（例 `pendingCount()`）・送り切りの通知・編集中のセルの確定（例 `commitEdit()`）を公開／(b) `readOnly` を開き直さずに切り替える（セッションを保つ）／(c) 両方 | **(b) を第一**。consumer の目的は「切り替えで入力を失わない」で、(b) なら開き直し自体がなくなる。提出の直前に送り切りを待つには (a) の送り切りの通知も要るので、あわせて検討 |
| 4 | H13 の形 | (a) `ServerInstance.addDocument(config)`・`removeDocument(id)`。外した文書の接続は切断し、再接続・再送は拒否／(b) 文書の世代（generation）を上げ、古い世代の接続と操作を拒否 | **(a)**。consumer は版ごとに別の文書にする設計で、文書の追加・撤去で足りる。保存先（oplog／snapshot）の扱いを決める |
| 5 | 優先と時期 | — | consumer の希望: H11・H12 を 2026-10-19 頃までに alpha で。H13 は consumer のつなぎ（立て直し）が当面使えるので後でよい。間に合わない場合は consumer がつなぎで見せる |

## 決定事項

Human Spec Gate で決める（本リポのセッション）。

## 受け入れ基準

起票時の案。Human Spec Gate で確定する。

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | 書込禁止にした文書へ A が SetCells を送る → A に拒否コードが返り、A の画面が元に戻る。サーバーの revision・操作ログは進まず、サーバーは止まらない。B の画面も変わらない | server unit ＋ 2 クライアント E2E |
| 2 | 書込禁止中の文書への行の挿入・削除も同様に拒否される | 同上 |
| 3 | 書込禁止を解くと、A・B とも入力できる | 同上 |
| 4 | 未送信の操作がある状態で読み取り専用へ切り替える → 未送信の操作は失われず、サーバーに届くか、拒否されたことが利用側に分かる | collab／grid unit ＋ E2E |
| 5 | 実行中に文書を足すと参加でき、外すとその文書の接続が切れ、再接続・再送は受け付けられない | server unit ＋ E2E |
| 6 | 既存の unit・invariants・E2E が green。公開 .d.ts の差分は追加だけ | 全回帰 ＋ contract test |
| 7 | 契約（JSDoc）・CHANGELOG・`apps/showcase/src/features.json`・`doc/plan/stage2-backlog.md` §3.7 が更新されている | 目視 |

## タスク一覧

### Phase 1: 仕様確認（Human Spec Gate）

- [ ] 📐 実読（HEAD・alpha.10）: sequencer の検証段と reject 経路、拒否時のクライアントの巻き戻し、collab session の未送信の扱いと再送、grid／React の readOnly と mount、serve の文書構成と保存先
- [ ] 論点1〜5 を決め、子DD（H ごと）に分ける。H7 を同時に扱うかも決める
- [ ] 🔬 機械検証: `bash scripts/dd-health.sh --dd DD-056` → ⚠️なし

### Phase 2: 子DDで実装・配布

- [ ] 子DD（H11・H12・H13）を起票して実装し、alpha で配布する
- [ ] 広島へ配布版を伝える（要件メモの「取り込み結果」列は広島側で更新する）
- [ ] 🔬 機械検証: 子DDごとの対象テスト → green

### 完了前チェック

- [ ] 受け入れ基準を1項目ずつ照合（未達成があれば理由をログへ）
- [ ] 😈 セルフレビュー1巡（「どこが壊れるか」を探す。読み返す価値のある所見のみログへ。深掘りが要る場合の手法: doc/da-method.md）
- [ ] 🔬 全回帰1回

## ログ

### 2026-10-12
- DD作成（広島空港リポのセッションから、ユーザーの指示で起票。要件の正本は広島 `doc/poc/sdk-requirements.md`）
