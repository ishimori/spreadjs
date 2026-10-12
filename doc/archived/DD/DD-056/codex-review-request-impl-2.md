# Codex レビュー依頼（DD-056-2 実装レビュー: 読み取り専用の実行時切替・送り切り・変換確定直後の確定漏れの修正）

## 依頼の趣旨

DD-056-2（広島空港 PoC 向け H12）の**実装コミット `37287d5`** をレビューしてほしい。設計は `doc/archived/DD/DD-056/contract.md` §4（確定済み・
Codex 設計レビューの指摘を反映済み）。設計どおりに実装できているか、実装で壊れる所がないかを、ソースとテストを読んで確かめてほしい。

- レビュー対象の差分: `git show 37287d5`
- 作業ツリーに未コミットの変更があれば対象外（次の子DD の作業途中の可能性がある）。周辺コードは `git show 37287d5:<path>` で読むこと
- 同コミットには DD-056-1 のテストの lint 修正（`serve.authorize.test.ts` の prefer-const）が含まれる（対象外でよい）

## 背景（要約）

consumer（広島空港の予算管理 PoC）は、部署の提出・受付締切・版の確定でシートを読み取り専用にする。これまでは React の `readOnly` の変化で
grid を destroy→mount し、未送信の操作・編集中のセルが失われた。自分の操作（提出等）の前に送り切りを待つ手段もなかった。

## 実装の要点

- `packages/grid/src/ime-editing-session.ts`: `settleAwaitingFinalInput()`（変換確定の直後＝`EditingAwaitFinalInput` に留まっていれば、
  textarea の値を最終 input〔`isComposing: false`〕の代わりに状態機械へ渡す）・`commitEdit()`（変換中は何もしない／確定直後は settle →
  変換していない編集なら状態機械へ `blur`〔Q-4「確定して移動しない」〕）。**IME 状態機械（packages/ime）は改変していない**
- 根拠: Tier 1（Chromium＋MS-IME）の実機トレース（`doc/archived/DD/DD-035/manual-gate-t1-ime-trace.json`）では compositionend の後に
  非変換の input が 1 件も来ず、変換確定の後は次の Enter か打鍵まで `EditingAwaitFinalInput` に留まる。そこでの blur・クリックは
  「最終 input を待つ」保留になるだけで確定しない（既存の不具合）
- `packages/grid/src/integration-editor.ts`: readOnly を可変に（`setReadOnly`）・textarea の readOnly 属性は「表示専用 || 列ロック」の和・
  `commitEdit`・**実際の blur と `pointerdownCell` の後、位相が `EditingAwaitFinalInput` なら `setTimeout(0)` で settle を予約**（既存不具合の
  修正。同じタスクで最終 input が届く順序では、その input が先に処理されて Navigation になっているため何もしない）
- `packages/grid/src/mount-controller.ts`: `readOnly` を `let` に。`setReadOnly`（変換中なら `readOnly=true`＋`readOnlyDeferred=true` で
  他の入口をすぐ止め、textarea は変換が終わってから。待つ間は **editorSubmit 経由の確定だけ**送信の関所〔`submitSetCells`・`submitToBackend`〕で
  通す）・`pendingCount`・`flush`（待ち合わせは `flushWaiters`、判定は `scheduleEditStateCheck` が `setTimeout(0)` で coalesce、完了判定は
  純関数 `flush-state.ts`。呼んだ時点の編集中セルだけを確定する）・destroy で待ち合わせを解決
- `packages/grid/src/index.ts`: `GridFlushOptions`・`GridFlushResult`・`GridInstance.setReadOnly/pendingCount/flush`・readOnly の JSDoc
- `packages/react/src/index.ts`: `readOnly` を mountKey から外し、instance が持つ値と違うときだけ `setReadOnly` を呼ぶ effect・handle の
  `pendingCount`・`flush`・型の網羅性チェックの除外（`setReadOnly`）
- テスト: `ime-editing-session.test.ts`（7 件）・`flush-state.test.ts`（6 件）・`nanairo-sheet-view.dd056.test.ts`（5 件）・E2E
  `readonly-switch-flush.spec.ts`（統合ページ・6 件）・`react-facade-readonly.spec.ts`（1 件）

## 重点的に見てほしい観点

1. **入力の喪失・誤ったセルへの確定**: `commitEdit`・`settleAwaitingFinalInput`・macrotask の判定が、IME の各順序（順序A／B・blur が割り込む順序・
   Escape での取消・F2 の既存値編集・Alt+Enter の改行〔wrap 列〕・K4〔編集対象行の削除〕・選択式／日付の候補欄・Undo/Redo の記録）と組み合わさった
   ときに、値を失う・別のセルへ確定する・二重に確定する・ゴースト編集（新しい編集が勝手に始まる）経路はないか
2. **読み取り専用の穴**: `readOnly` を可変にしたことで、表示専用の間に文書 Operation が送られる経路（入口・関所の判定漏れ、`readOnlyDeferred` の間の
   `isDeferredEditorCommit` の許可が広すぎる、`inEditorSubmit` の取り残し等）や、解除したのに編集できない経路はないか。textarea の readOnly 属性と
   列ロック（`setInputLock`）の同期
3. **変換の終わり待ち**: `readOnlyDeferred` の間の振る舞い（`setReadOnly(false)` での取り消し・destroy・変換が終わらない場合・変換中の別セルの
   クリック〔pendingNavigation〕）と、終わったときの確定・ロックの順序
4. **flush**: 完了条件・timeout・stopped・destroy・並行呼び出し・編集中セルの扱い（呼んだ時点の編集だけを確定する）の正しさ。判定の予約
   （`setTimeout(0)`・coalesce）が ClientSession／editor へ再入しないか、取りこぼし（イベントが来ずに永遠に待つ）がないか
5. **React**: effect の順序（初回 mount・他の識別系と同時の変化・StrictMode の二重 mount）での取りこぼし・二重適用、handle の直結
6. **既存挙動の退行**: 既存の readOnly（mount 時固定の使い方）・列／行の読み取り専用・IME 経路・クリックの挙動が変わっていないか（変わったのは
   変換確定直後のクリック・blur だけのはず）
7. **テストの妥当性**: テストが実際の不具合を捕まえるか（偽陽性・待ち方の甘さ・タイミング依存）。抜けている危険な場面

## 評価基準（指摘の重さ）

- **P1**: 入力の黙った喪失・誤ったセルへの確定・表示専用なのに送られる・収束しない状態・例外でグリッドが止まる。必ず再現手順（操作の順序）を書くこと
- **P2**: 契約（contract.md §4）との食い違い、実装の穴、重要なテストの抜け
- **P3**: 表現・軽微な改善

各指摘に、重さ・`file:line`・壊れる場面・直し方の案を書くこと。根拠のない推測は書かない（ソースで確かめたことと推測を分ける）。
指摘がなければ「指摘なし」と書くこと。回答は日本語で。

## 対象外（指摘不要）

- 作業ツリーの未コミット変更
- 名前の好み・文体・Markdown の体裁
- 設計の判断そのもの（setReadOnly＋flush の両方を入れたこと・状態機械を改変しないこと・変換確定直後に最終 input の代わりを渡すこと）。
  ただし、その判断で consumer の入力が失われる具体的な場面があれば指摘してよい
- H11（DD-056-1・`d39ceed` までで別途レビュー済み）・H13（DD-056-3）の範囲
- 実 IME（OS の IME）での手動確認の要否（synthetic と実機ゲートは分けている）
