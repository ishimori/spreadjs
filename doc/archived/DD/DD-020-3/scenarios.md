# DD-020-3 テスト設計（Undo/Redo 条件マトリクス・Red）

> 正本は本ファイル。`packages/grid/src/undo-stack.test.ts`（unit）・`apps/playground/e2e/undo-redo.spec.ts`（E2E）・
> `tests/invariants/ime/undo.invariant.test.ts`（不変条件）がここを参照して実装される。
> フル委譲モード（オーケストレータ確認）でシナリオ合意扱い（DD ログ 2026-07-17）。

## 0. 用語・前提

- **確定単位**: 1 利用者操作 = 1 SetCells。対象=セル確定（IME commit / Delete）・貼り付け（paste）・cut/範囲クリア。
- **逆値（before）**: submit 直前の committed 値（未書込=blank）。**順値（after）**: op が設定する値。
- **ownedRevision[cell]**: 「我々の最後の確定操作がそのセルへ付与した revision」。ACK（collab）／即時（standalone）で更新。
  補償 SetCells の `beforeRevision` はこれを使う（他者の後続変更は revision 不一致で OCC が弾く＝R-07 対策）。
- **pending 中は Undo 不可**（親⑥）: 本実装では `pendingCount===0`（自分の全 op が確定）を undo/redo の必要条件とする
  （＝pending 中の op は undo 対象外・in-flight 補償の直列化も同時に満たす）。
- **拒否時（a）**: OCC で補償が弾かれたら **スタックから除去＋通知**（同条件再試行は同結果）。
- **キーバインド（b）**: Ctrl/Cmd+Z=Undo・Ctrl+Y/Ctrl+Shift+Z/Cmd+Shift+Z=Redo。**Navigation 位相かつ非 composing のみ**。
  Editing/Composing 中はブラウザ既定（textarea 内テキスト undo）へ委譲＝グリッド Undo を発火しない（I-3）。

## 1. undo-stack 純ロジック（unit・`undo-stack.test.ts`）

### U-1 記録と逆値/順値（AC1）
- 単一セル commit（blank→"x"）を記録 → beginUndo の補償 op は `value=before(blank)`・`beforeRevision=ownedRevision`。
- beginRedo の補償 op は `value=after("x")`。型（number/date/string）も before/after で往復する。

### U-2 範囲（paste/cut/clear）の原子補償（AC2）
- 3 セル paste を記録 → beginUndo は **1 SetCells に 3 changes**（全成功/全失敗）。
- 逆値=各セルの submit 前 committed 値（既存値上書きは旧値へ・空セルへの書込は blank へ）。

### U-3 変化なしセルは記録しない（最小化）
- before===after のセルは patch に含めない。全セル before===after の op は **エントリを積まない**（noop op の補償ハング防止）。

### U-4 深さ100・古い順破棄（AC6）
- 101 個の commit を記録 → undoDepth()===100・最古エントリは破棄。

### U-5 新規操作で redo 破棄（AC4）
- commit → undo（redoDepth 1）→ 新規 commit → redoDepth()===0。

### U-6 pending 中は undo 不可・ACK 後可（AC5・collab）
- recordUserOp(opId, ackedRevision=null)（未 ACK）→ `canUndo(pendingCount=1)===false`。
- onCommitted(opId, R) 後 `canUndo(pendingCount=0)===true`。

### U-7 reject された操作はスタックに入らない（AC5）
- recordUserOp(opId) → onRejected(opId) → undoDepth()===0（除去）・`onRejected` 戻り値 undefined（元op reject＝block通知ではない）。

### U-8 補償の OCC 生成物（AC3・生成 op がサーバー検証と整合）
- commit を ACK（ownedRevision=R）→ beginUndo の補償 op を、対象セルが他者により R→R+1 へ進んだ doc に対して
  `validateOperation` → `stale-cell-revision` を返す（＝サーバーが全体 reject）。範囲外セルの他者変更では競合しない。

### U-9 連続同一セル編集の undo（自傷 reject 回避・ownedRevision 追従）
- op1: A=blank→"x" ACK@R1（ownedRevision[A]=R1）／op2: A="x"→"y" ACK@R2（ownedRevision[A]=R2）。
- beginUndo(op2) 補償 `beforeRevision=R2` → ACK@R3（ownedRevision[A]=R3）。
- beginUndo(op1) 補償 `beforeRevision=R3`（R1 ではない）→ committed A@R3 なら OCC 通過（自分の undo で bump した revision を追従）。

### U-10 補償 reject でエントリ除去＋通知（a）
- beginUndo → setCompensationOperationId(c1) → onRejected(c1) → 戻り値 `'undo-blocked'`・redoDepth()===0（エントリ破棄）。
- beginRedo 側は `'redo-blocked'`。

### U-11 in-flight 中は undo/redo 不可（直列化）
- beginUndo 後（limbo 有）は `canUndo/canRedo`===false。resolveCompensationImmediate/onCommitted で解除。

### U-12 キーバインド裁定（decideUndoRedoKey・AC8）
- Navigation×非 composing: Ctrl+Z→undo・Ctrl+Shift+Z→redo・Ctrl+Y→redo・Cmd+Z→undo。
- 全位相×composing の掃引: Editing/Composing・composing=true・alt=true・修飾なしは全て `'none'`。

## 2. E2E（`undo-redo.spec.ts`）

### UE-1 standalone: commit→Ctrl+Z→前値・Ctrl+Y→再適用（AC1/AC4/AC7）
- (r,c) に IME 確定 "abc" → Ctrl+Z で表示が前値（空）へ・**cell-commit（after=''・previousValue='abc'）発火**。
- Ctrl+Y で "abc" 再適用・cell-commit 発火。server 系イベント（connection/pending/rejected）0 件（DD-024）。

### UE-2 standalone: paste→Ctrl+Z→範囲全体が前値（AC2/AC7）
- 2 セルへ synthetic paste → Ctrl+Z → 両セルが前値・1 回の cell-commit batch（原子）。

### UE-3 standalone: 新規操作で redo 破棄（AC4）
- commit→Ctrl+Z→（別セルへ）commit→Ctrl+Y は無効（redo されない・値不変）。

### UE-4 IME 干渉なし（AC8）
- composition 中に Ctrl+Z → グリッド undo が発火しない（committed 不変・draft 維持）・確定後は commit 成立。

### UE-5 collab: 2 クライアント OCC で undo 全体拒否（AC3）
- A が (r,*) を commit（ACK）→ 切断 → B が同セルを変更（committed 前進）→ A 再接続 → Ctrl+Z。
- A の補償 SetCells は stale-cell-revision で全体 reject・**undo-blocked 通知**・文書は B の値のまま（強制 undo なし）。

## 3. 不変条件（`undo.invariant.test.ts`）

### IV-1 composition 中 Ctrl+Z は none（全位相×composing 掃引・decideUndoRedoKey）
### IV-2 実セッションで composition 中は decideUndoRedoKey が none（draft 非破壊・commit 経路無変更）

## 4. AC ⇔ シナリオ対応

| AC | シナリオ |
|----|---------|
| 1 | U-1・UE-1 |
| 2 | U-2・UE-2 |
| 3 | U-8・UE-5 |
| 4 | U-5・UE-1（redo）・UE-3 |
| 5 | U-6・U-7 |
| 6 | U-4 |
| 7 | UE-1・UE-2（cell-commit） |
| 8 | U-12・UE-4・IV-1・IV-2 |
