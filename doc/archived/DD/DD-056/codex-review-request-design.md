# Codex レビュー依頼（DD-056 設計レビュー）

## 依頼の趣旨

DD-056（広島空港 PoC 向け拡張 H11〜H13）の**実装前の設計**をレビューしてほしい。対象は未コミットの 2 ファイル:

- `doc/archived/DD/DD-056/contract.md` — 設計案（公開 API 契約・処理順・状態遷移・内部の変更点・テスト計画）
- `doc/archived/DD/DD-056_広島空港PoC向け拡張.md` — DD 本文（論点1〜5 と「設計後の推奨」・受け入れ基準）

コードはまだ書いていない。設計の主張（特に contract.md §1 の実読結果と、§3〜§5 の契約）を **実際のソースで裏付けたうえで**、
この設計どおりに実装したときに壊れる所を探してほしい。

## 背景（consumer の要件・要約）

consumer は広島空港の予算管理 PoC（2026-10-22 の商談で見せる）。文書（シート）は「部署×予算版」ごと。各部署の担当者が共同編集で入力し、
部署の提出・全社の受付締切・予算版の確定でシートの編集可否が変わる。要件の正本は別リポ（このサンドボックスからは読めない）なので要点を写す:

- **H11（高）**: 文書単位の書込禁止をサーバーで強制する（または操作ごとの認可フック）。禁止中の文書への SetCells・行の挿入削除を、
  fail-stop せずに拒否コード付きで拒否する。禁止は解除もできる。
- **H12（高）**: 未送信の操作を失わずに読み取り専用へ切り替える。(a) 未送信の数／送り切った通知と、編集中のセルを確定させる API、
  または (b) 開き直さずに `readOnly` を切り替える。
- **H13（中）**: 実行中に文書を足す・外す。外した文書の接続は切断し、再接続・再送を受け付けない。
- consumer の画面設計の状態表（§4.4）:

| 版 | 受付 | その部署の提出 | 部署担当 | 経営戦略部 |
|---|---|---|---|---|
| draft | 受付中 | editing | 編集可 | 編集可（調整） |
| draft | 受付中 | submitted | 読み取り専用 | 編集可（調整・履歴） |
| draft | 締切中 | どちらでも | 読み取り専用 | 編集可（点検後の調整） |
| confirmed | — | — | 読み取り専用 | 読み取り専用 |

- consumer の決まり（§4.5 抜粋）: ①自分の操作で状態を変えるとき（提出・締切・確定）は、編集中のセルを確定させ、送り切っていない入力が
  なくなってから受け付ける。②他人の操作で自分のシートが読み取り専用になるときも入力を失わない。③提出のあとに部署担当の入力が届いたら
  （受付中）入力は受け付けて提出を自動で取り消す。④締切・確定のあとに部署担当の入力が届いたらサーバーで拒否する。⑤新しい版は別の文書。
- consumer の構成: `serve()` を自前のアプリサーバーに同居させ、PostgreSQL に操作ログ・snapshot・業務表を持つ（`ServeOpLogStore` の `append` と
  業務表への投影を同じトランザクションにする）。認証は `authenticate`（U2）で actorId を確定する想定。

## 設計の要点（詳細は contract.md）

- H11: `serve({ authorizeOperation })`（同期・`true` で通す・それ以外と throw は拒否＝fail-closed）。sequencer の処理順
  「① operationId 冪等 → ② clientSequence（通過したら消費）→ ③ baseRevision → **③' 認可** → ④ 検証 → ⑤ 適用」。拒否は新しい
  `RejectCode` `permission-denied` を既存の reject 経路で送信元にだけ返す。サーバー起点（`ServerInstance.submit`＝擬似接続 `'server'`）は判定しない。
  起票時の仮説（文書単位のフラグ `setWritable`）から変えた理由は、上の表で締切後も経営戦略部が編集できるため。
- H12: grid `setReadOnly(boolean)`（開き直さない。編集中のセルは状態機械へ `blur` を渡して確定してから切り替える。IME 変換中は文書を変える
  他の入口をすぐ止め、変換の確定を待ってから textarea を読み取り専用にする。その間の編集中セルの確定だけ送信の関所を通す）・`pendingCount()`・
  `flush({ timeoutMs })`（編集中のセルを確定し pending が 0 になるまで待つ。`flushed`／`timeout`／`stopped`）。React は `readOnly` を識別系から外し、
  変化時に `setReadOnly` を呼ぶ。
- H13: `ServerInstance.addDocument(documentId, config)`・`removeDocument(documentId)`。撤去は「登録から外す → 接続を切る → 受理済みの配信
  （durable 化・ACK・onAccepted）を待つ → 保存先を閉じる」。保存先は消さない。`documentIds`・`quarantined` を getter にする。

## 読んでほしいソース（設計の前提）

- サーバー: `packages/server/src/sequencer.ts`・`room.ts`・`persistent-room.ts`・`oplog-store.ts`、`packages/server-hono/src/server.ts`（RoomBridge・
  SubmitDeliveryLoop・createDocumentRuntime・startServer・closeServer）・`index.ts`・`serve-types.ts`・`serve-adapters.ts`
- protocol: `packages/core/src/protocol.ts`・`message-codec.ts`
- クライアント: `packages/collab/src/session.ts`（handleRejected・rebuildView・applyReconcile・pending）、`packages/grid/src/mount-controller.ts`
  （readOnly の参照箇所・submitSetCells・submitToBackend・editorSubmit・observer の写像）・`integration-editor.ts`・`ime-editing-session.ts`・
  `error-codes.ts`・`index.ts`、`packages/ime/src/editor-state-machine.ts`（handleBlur・composition）
- React: `packages/react/src/index.ts`（mountKeyOf・effect の順序・handle の型レベル網羅性チェック）

## 重点的に見てほしい観点

1. **H11 の処理順と exactly-once**: ③' の位置で、受理済み操作の再送・通知喪失後の再接続突合せ（DD-015 reconcile）・clientSequence の再整列
   （rebaselinePendingSequence）・永続化あり（PersistentRoom の durable frontier）と矛盾しないか。拒否が別の操作の誤拒否・二重適用・
   黙った喪失・`client-sequence-violation` のループを生む経路はないか。
2. **H11 の認可の穴**: クライアントが判定を回避できる経路（擬似接続 `'server'` の名乗り、`clientId: 'server'`/`'system'`、申告 documentId の
   正規化経路、presence 等）はないか。fail-closed の扱い（throw・Promise・undefined）は妥当か。`operation` の遅延複製で consumer が受理される
   操作を書き換えられないか。
3. **H12 の状態遷移**: 編集中・IME 変換中（compositionend → blur → input 等の順序の違いを含む）・候補欄（選択式・日付）を開いている間・
   K4（編集対象行の削除）・Undo/Redo の記録と `setReadOnly` が絡んだとき、入力の喪失・誤ったセルへの確定・読み取り専用のはずの送信・
   状態機械の不整合が起きないか。`blur` を状態機械へ渡す確定の流用に穴はないか。
4. **H12 の flush**: 完了条件（`pendingCount === 0`）が「送り切った」の意味として正しいか（ACK と echo の関係・reject・再検証での除去・
   突合せ）。マイクロタスクでの判定が ClientSession / editor へ再入しないか。timeout・stopped・destroy の扱い。
5. **React**: `readOnly` を識別系から外したときの effect の順序（初回 mount・他の識別系と同時に変わる・StrictMode）で取りこぼしや二重適用がないか。
6. **H13 の close 順序**: 撤去中・停止中に durable 化待ちの操作・受理通知・`ServerInstance.submit`・新しい接続・同じ ID の再追加が重なったとき、
   保存先のハンドル漏れ・欠番・durable でない ACK・閉じた保存先への append・serve 全体の配信ループの停止が起きないか。
7. **論点の結論**: 論点1を (a)→(b) に変えた判断、論点2（拒否コード 1 つ・汎用名）、論点3（setReadOnly＋flush の両方）が consumer の決まり
   ①〜⑤ を満たすか。足りない・過剰な API はないか。
8. **受け入れ基準とテスト計画**: 受け入れ基準（DD 本文）が契約を検証可能な形で覆っているか。テスト計画に抜けている危険な場面はないか。

## 評価基準（指摘の重さ）

- **P1**: この設計どおりに実装すると、データの黙った喪失・誤ったセル／文書への書込・収束しない状態・認可の回避・サーバー全体の停止
  （fail-stop）・保存先の破損や欠番が起きる。必ず再現手順（操作の順序）を書くこと。
- **P2**: 契約の穴（未定義の振る舞い・矛盾）、実装時に高確率で不具合になる曖昧さ、受け入れ基準・テスト計画の重要な抜け。
- **P3**: 表現・軽微な改善。

各指摘に、重さ・場所（contract.md の節、または `file:line`）・壊れる場面・直し方の案を書くこと。根拠のない推測は書かない
（ソースで確かめたことと推測を分ける）。指摘がなければ「指摘なし」と書くこと。回答は日本語で。

## 対象外（指摘不要）

- 名前の好み（誤解を招く場合を除く）・文体・Markdown の体裁
- consumer の業務ルール（§4.4・§4.5）そのものの是非
- H11〜H13 以外の機能（数式・行の権限モデルそのもの〔H7〕・オフライン編集など）、Stage ロードマップ
- 判定を切り替えた瞬間に永続化待ちだった受理済み操作のための待ち合わせ API（barrier）は**意図的に入れていない**（contract.md §3.5）。
  入れないことで consumer の決まり①〜⑤が具体的に破れる場面がある場合だけ指摘すること
- 実 IME（OS の IME）での手動確認の要否（このリポジトリでは synthetic composition の E2E と実機ゲートを分けている）
