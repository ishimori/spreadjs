# DD-056: 広島空港 PoC 向け拡張（consumer 駆動: 広島空港 H11〜H13）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-10-12 | 2026-10-12 | 進行中 | consumer 駆動（広島 DDP-001）。設計（`DD-056/contract.md`）を Codex 設計レビュー（5件採用）後に Human Spec Gate で確定。子DD-056-1〜3 で実装中 |

> アプローチ: 標準（アンブレラ。要件の範囲・API の形・子DD分割を決め、実装は子DDで行う）
> リスク: あり（認可に当たるサーバー側の書込禁止 — H11）
> 起票注記: 広島空港リポ（`C:/repo/hiroshima-airport`）のセッションから、ユーザーの指示で起票した（2026-10-12）

```text
Risk Class: A（H11 は sequencer の処理順に認可段を足し、拒否コード〔protocol の語彙〕を増やす。H12 は編集中・変換中の確定と読み取り専用の切替〔IME 状態機械は改変しない〕。H13 は serve の文書構成を実行中に変える。子DDごとの判定は contract.md §6）
Risk Triggers: protocol（拒否コードの追加・拒否時のクライアントの巻き戻し）／永続化（実行中の文書の追加・撤去と保存先の close 順序）／データ消失の防止（開き直しで未送信の操作が消える経路・外した文書への再送）／公開 API（ServerInstance・grid／React handle）の追加
Human Spec Gate: done（2026-10-12 ユーザー決定。論点1〜5 は推奨どおり＋既存不具合〔contract.md §4.5〕を DD-056-2 で直す。決定事項参照）
Codex: 2026-10-12 ユーザー指示「設計・実装が終わる都度 Codex レビュー、指摘は妥当性を判断して Claude が修正」。設計 high（P1×2・P2×3 全採用）→ 実装は子DDごとに xhigh（2026-10-12 ユーザー決定）
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
- HEAD（`a3f8c80`＝alpha.10 と同じソース）で読み直した結果は `DD-056/contract.md` §1。要件メモの「現状」との差分:
  未送信の数は grid の `pending` イベント（`connection` イベントの `pendingCount` も）で既に通知している。足りないのは値を引く API・送り切りを待つ API・編集中セルの確定
- 広島の画面設計 §4.4 では、受付締切の後も**経営戦略部は編集できる**（拒否するのは部署担当の操作だけ）。§4.5 の 3 では提出後の部署担当の入力を**受け付けて提出を取り消す**。
  ＝サーバーで止めたいのは「文書×操作者」の組で、文書単位のフラグだけでは足りない（論点1の推奨を変えた理由）

## 検討内容（Human Spec Gate）

| # | 論点 | 選択肢 | 推奨と理由（起票時の仮説） |
|---|------|--------|------------------------|
| 1 | H11 の形 | (a) 文書単位の書込禁止フラグ（例 `ServerInstance.setWritable(documentId, boolean)`）／(b) 操作ごとの認可フック（例 `serve({ authorize(envelope, identity) })` → 許可または拒否コード）／(c) 両方 | **(a)**。consumer に要るのは文書単位で、判定が単純でテストしやすい。H7（行の権限）まで見据えるなら (b) が有力。H7 を同時に扱うかとあわせて決める |
| 2 | H11 の拒否の伝え方 | (a) 既存の reject 経路に拒否コードを足す（例 `document-read-only`）／(b) 文書ごと受信専用に切り替える通知をサーバーから送る | **(a)**。既存の reject と同じく送った側が巻き戻る。protocol の語彙が増えるので A。(b) は H12 と重なるので論点3と一緒に決める |
| 3 | H12 の形 | (a) 未送信の操作の数（例 `pendingCount()`）・送り切りの通知・編集中のセルの確定（例 `commitEdit()`）を公開／(b) `readOnly` を開き直さずに切り替える（セッションを保つ）／(c) 両方 | **(b) を第一**。consumer の目的は「切り替えで入力を失わない」で、(b) なら開き直し自体がなくなる。提出の直前に送り切りを待つには (a) の送り切りの通知も要るので、あわせて検討 |
| 4 | H13 の形 | (a) `ServerInstance.addDocument(config)`・`removeDocument(id)`。外した文書の接続は切断し、再接続・再送は拒否／(b) 文書の世代（generation）を上げ、古い世代の接続と操作を拒否 | **(a)**。consumer は版ごとに別の文書にする設計で、文書の追加・撤去で足りる。保存先（oplog／snapshot）の扱いを決める |
| 5 | 優先と時期 | — | consumer の希望: H11・H12 を 2026-10-19 頃までに alpha で。H13 は consumer のつなぎ（立て直し）が当面使えるので後でよい。間に合わない場合は consumer がつなぎで見せる |

### 設計後の推奨（2026-10-12・詳細は `DD-056/contract.md` §2〜§5）

| # | 推奨 | 起票時の仮説との差 |
|---|------|------------------|
| 1 | **(b) 操作ごとの認可フック** `serve({ authorizeOperation })`（同期・`true` で通す・それ以外と throw は拒否）。sequencer の処理順に認可段を足す（clientSequence 消費の後・検証の前）。サーバー起点の `submit` は判定しない | (a) → (b)。締切後も経営戦略部は編集できる（§4.4）ため、文書単位のフラグでは表せない。正典（開発計画 §8.7「接続後も Operation ごとに権限を検証」・Phase 3「権限フック」・D-21）とも一致。H7（行の権限）も同じ口で書ける |
| 2 | **(a)** 既存の reject 経路に拒否コード **`permission-denied`** を足す（grid の公開競合コードにも同名で写す） | 仮説どおり（コード名だけ一般化。文書単位でない拒否にも使うため） |
| 3 | **(c) 両方**: grid `setReadOnly`（開き直さない・編集中のセルは確定してから切り替える・IME 変換中は変換が終わるのを待つ）＋`pendingCount()`＋`flush()`（編集中のセルを確定して送り切るまで待つ）。React の `readOnly` は変わっても開き直さない。「変換確定の直後」（Tier 1 では最終 input が来ず確定待ちに留まる）も確定させる | 仮説どおり（(b) に (a) を足す）。追加の判断: 変換確定直後のクリック・グリッド外クリックが確定されない既存の不具合（contract.md §4.5）を一緒に直すか |
| 4 | **(a)** `addDocument`・`removeDocument`。撤去は接続を切り、受理済みの操作の永続化を待ってから保存先を閉じる。保存先は消さない | 仮説どおり |
| 5 | H11・H12 を子DD-056-1・056-2 で先に alpha.11 として配る。H13 は子DD-056-3 で続けて alpha.12 | 仮説どおり |

## 決定事項

2026-10-12 ユーザー決定（Human Spec Gate・推奨案どおり）。契約の正本は `DD-056/contract.md`（同日「確定」に改めた）。

- 論点1: **(b) 操作ごとの認可フック** `serve({ authorizeOperation })`。同期・`true` で通す・それ以外と throw は拒否（fail-closed）。sequencer の処理順に認可段（③'）を足す。サーバー起点の `submit` は判定しない（contract.md §3）
- 論点2: **(a)** 既存の reject 経路に拒否コード `permission-denied` を足す（grid の公開競合コードも同名）
- 論点3: **(c)** grid `setReadOnly`・`pendingCount()`・`flush()`。React の `readOnly` は変わっても開き直さない（contract.md §4）
- 論点4: **(a)** `ServerInstance.addDocument`・`removeDocument`（contract.md §5）
- 論点5: H11・H12 を先に alpha.11 で配る。H13 は続けて実装して alpha.12
- 追加: Tier 1 で変換確定の直後に別セル・グリッド外をクリックしても確定されない既存の不具合（contract.md §4.5）を **DD-056-2 で一緒に直す**
- 実装の Codex レビューは子DDごとに **xhigh**
- 子DD分割（確定）: DD-056-1 操作ごとの書込の認可（H11）／DD-056-2 読み取り専用の実行時切替と送り切り（H12＋§4.5 の修正）／DD-056-3 実行中の文書の追加と撤去（H13）

## 受け入れ基準

設計（contract.md）に合わせて起票時の 1〜7 を分けて具体化し、2026-10-12 の Human Spec Gate で確定した。子DDの受け入れ基準はこの表の該当行を細かくしたもの（1〜4 → DD-056-1、5〜7 → DD-056-2、8 → DD-056-3、9・10 は各子DD）。

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | `authorizeOperation` が A の操作を拒否する間に A が SetCells を送る → A に `permission-denied` が返り、A の画面が元に戻る（grid の `rejected`・`code: 'permission-denied'`）。サーバーの revision・操作ログは進まず、接続とサーバーは止まらない。B の画面は変わらない | sequencer unit・server-hono（実 WS・2 クライアント）・E2E（実ブラウザー 2 つ） |
| 2 | 拒否中は行の挿入・削除も同様に拒否される | server-hono |
| 3 | 許可に戻すと A・B とも入力できる | server-hono・E2E |
| 4 | `ServerInstance.submit` は判定されない。フックの throw・`true` 以外の戻り値は拒否になり、接続は保たれる（診断が出る）。受理済み操作の再送は拒否されない | sequencer unit・server-hono |
| 5 | 未送信の操作がある状態で `setReadOnly(true)` → 開き直さず、未送信の操作はサーバーへ届く（受理、または拒否が `rejected` で分かる）。編集中のセルは確定して送られる。IME 変換中は変換の確定を待ってから切り替わる | E2E |
| 6 | `flush()` は編集中のセルを確定し、送り切ると `flushed`、オフラインで上限を過ぎると `timeout`、接続終端・destroy で `stopped` を返す | E2E・grid unit |
| 7 | React の `readOnly` prop を変えても開き直さない（未送信の操作が残る）。他の識別系 props の変更では従来どおり開き直す | React unit・E2E |
| 8 | 実行中に `addDocument` した文書へ参加・編集でき、`removeDocument` するとその文書の接続が切れ、再接続と `submit` は受け付けられない。撤去の前に受理した操作は永続化され `onAccepted` が届いてから解決する | server-hono（実 WS） |
| 9 | 既存の unit・invariants・E2E が green。公開 .d.ts の差分は追加だけ（React の `readOnly` が開き直さなくなる挙動の変化は CHANGELOG の Changed に書く） | 全回帰 ＋ contract test |
| 10 | 契約（JSDoc）・CHANGELOG・`apps/showcase/src/features.json`・`doc/plan/stage2-backlog.md` §3.7・公開コード一覧（`doc/archived/DD/DD-017/error-codes.md`）・quick-start が更新されている | 目視 |

## タスク一覧

### Phase 1: 仕様確認（Human Spec Gate）

- [x] 📐 実読（HEAD・alpha.10）: sequencer の検証段と reject 経路、拒否時のクライアントの巻き戻し、collab session の未送信の扱いと再送、grid／React の readOnly と mount、serve の文書構成と保存先（結果は contract.md §1）
- [x] 設計案（`DD-056/contract.md`）を書き、論点1〜5 の推奨を改める
- [x] Codex 設計レビュー（high）→ 指摘を仕分けて contract.md へ反映（5 件すべて採用・ログ参照）
- [x] 論点1〜5 をユーザーへ提示して決め、子DD（DD-056-1〜3）に分ける。H7 は同じフックで consumer が書ける（SDK に行の権限モデルは足さない）（2026-10-12・推奨どおり）
- [x] 🔬 機械検証: `bash scripts/dd-health.sh --dd DD-056` → ⚠️なし

### Phase 2: 子DDで実装・配布

- [x] 子DD（DD-056-1 H11・DD-056-2 H12＋§4.5・DD-056-3 H13）を起票する（2026-10-12）
- [ ] DD-056-1 の全Phase完了確認（実装・Codex xhigh の反映）
- [ ] DD-056-2 の全Phase完了確認（実装・Codex xhigh の反映）
- [ ] alpha.11 を配布する（DD-056-1・056-2）
- [ ] DD-056-3 の全Phase完了確認（実装・Codex xhigh の反映）
- [ ] alpha.12 を配布する（DD-056-3）
- [ ] 広島へ配布版を伝える（要件メモの「取り込み結果」列は広島側で更新する）
- [ ] 🔬 機械検証: 子DDごとの対象テスト → green

### 完了前チェック

- [ ] 受け入れ基準を1項目ずつ照合（未達成があれば理由をログへ）
- [ ] 😈 セルフレビュー1巡（「どこが壊れるか」を探す。読み返す価値のある所見のみログへ。深掘りが要る場合の手法: doc/da-method.md）
- [ ] 🔬 全回帰1回

## ログ

### 2026-10-12
- DD作成（広島空港リポのセッションから、ユーザーの指示で起票。要件の正本は広島 `doc/poc/sdk-requirements.md`）
- 本リポのセッションで開始（ユーザー指示「設計・実装が終わる都度 Codex レビュー、指摘は妥当性を判断して Claude が修正」）。HEAD を実読し、設計案 `DD-056/contract.md` を作成。
  広島の画面設計 §4.4（締切後も経営戦略部は編集可）を読み、論点1の推奨を (a) 文書単位のフラグ → (b) 操作ごとの認可フックへ改めた（拒否コードは `permission-denied`）
- **Codex 設計レビュー（high）**: 依頼書 `DD-056/codex-review-request-design.md`・結果 `DD-056/codex-review-result-design.md`。指摘 5 件（P1×2・P2×3）を**すべて妥当と判断し採用**、contract.md へ反映した。各指摘はソースで裏付けた:
  1. [P1] 認可フックが返した Promise の reject が未捕捉になりプロセスが落ちる → thenable に rejection ハンドラを付けて診断へ（§3.2）
  2. [P1] 変換確定の直後（`EditingAwaitFinalInput`）は blur を渡しても確定しない → **Tier 1 では通常の状態**であることを実機トレース（DD-035 `manual-gate-t1-ime-trace.json`：compositionend の後に非変換の input が 1 件も来ない）と状態機械の再現で確認。textarea の値を最終 input の代わりに渡して確定する（§4.2。状態機械は改変しない）
  3. [P2] 撤去の切断だけでは、切断中に届いた join で旧 Room へ再参加できる → RoomBridge に撤去の印を立てて以後のフレームを捨てる。既存の `closeSocket` も同じ穴なので直す（§5.2・§5.3）
  4. [P2] 撤去が実行中の snapshot 生成を待たない → `PersistentRoom.close()` が生成の終了を待ち、新しい生成を止める（§5.3。`stop()` にも効く既存の穴）
  5. [P2] Undo／Redo の補償操作の認可拒否が `undo-blocked`／`redo-blocked` に置き換わる → `permission-denied` を優先して通知（§3.2）
- 並行して自分でも穴を探し、次を設計へ足した: 認可フックの中から `submit` 等を呼ぶと sequencer の処理中に再入し、同じ受理を二重に永続化しうる → フック内からの `submit`・`addDocument`・`removeDocument`・`stop` は reject（§3.2）／`authenticate` 未指定の `actorId` は申告値（§3.2）／撤去と upgrade の handshake の競合（§5.2）／拒否の通知喪失＋再起動で「遅れて受理」になりうる境界（§3.5）／広島 DDP-004 の受け入れ基準5（締切後の入力を「未反映」として履歴に残す）はフックの中で記録できる（§3.2）
- 設計の過程で、DD-056 より前からある不具合を見つけた: Tier 1 で変換確定の直後に別セル・グリッド外をクリックしても確定されない（§4.5。状態機械だけで決定的に再現。E2E の synthetic IME が順序A のため自動テストに出ていなかった）。H11〜H13 の外なので扱いをゲートで決める
- **Human Spec Gate（ユーザー決定）**: 論点1〜5 は推奨どおり。既存の不具合（§4.5）は DD-056-2 で一緒に直す。H13 は H11・H12 の配布（alpha.11）に続けて実装する（alpha.12）。実装の Codex レビューは子DDごとに xhigh。決定事項へ記録し、contract.md を「確定」に改め、子DD DD-056-1〜3 を起票した
