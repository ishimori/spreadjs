# Codex レビュー依頼: DD-020-3 Undo/Redo（effort high）

## 目的・スコープ

確定単位（1 利用者操作＝1 SetCells＝セル確定/貼り付け/cut/範囲クリア）の **Undo/Redo** を、**クライアント主導・補償 SetCells**（protocol 変更なし・ADR-0024）で実装した。単独グリッドモード（DD-024・サーバー無し）と共同編集の両方で同一機構が動く。

対象差分は**本 DD の全 uncommitted 変更**。主な新規/変更:

- `packages/grid/src/undo-stack.ts`（新規・純ロジック）: Undo/Redo スタック・ownedRevision・補償 op 生成・キーバインド裁定 `decideUndoRedoKey`。
- `packages/grid/src/mount-controller.ts`: 確定単位 chokepoint `submitSetCells` で submit 直前に committed から逆値捕捉／`submitCompensation`・`performUndo/Redo`／keydown 配線／observer の rejected→undo-blocked 写像／standalone 即時確定／debug API。
- `packages/grid/src/session-sync.ts`: 自分の SetCells の own echo 検出 → `onOwnSetCellsCommitted(operationId, serverRevision)`（ownedRevision を正確な revision で更新）。
- `packages/grid/src/integration-editor.ts`: `KeydownInterceptInput` に ctrl/meta/alt 追加。
- `packages/grid/src/error-codes.ts`: 公開語彙 `undo-blocked`/`redo-blocked` 追加。
- テスト: `undo-stack.test.ts`（unit 18）・`apps/playground/e2e/undo-redo.spec.ts`（standalone 4）・`undo-redo-collab.spec.ts`（collab 2）・`tests/invariants/ime/undo.invariant.test.ts`（3）。

## 設計意図（正しさの要）

- **beforeRevision の正しさ（R-07 サイレント上書き対策）**: 補償 op の beforeRevision は「元操作確定時 revision の凍結」ではなく **ownedRevision マップ（＝自分の最後の確定操作がそのセルへ付与した revision）** を使う。ownedRevision は**自分の op の正確な ACK revision**（own echo が運ぶ `envelope.revision`）で更新する。committed の事後読取を使わないのは、同一 echo batch に他者 op が混ざると committed が foreign revision を指し、それを owned と誤認すると補償が他者変更をサイレント上書きしうるため。
- **連続同一セル編集の Undo**: ownedRevision を自分の補償 ACK で追従させることで「同一セルを 2 回編集→2 回 Undo」の自傷 reject を回避しつつ、他者変更は依然 OCC で弾く。
- **pending/直列化**: `pendingCount===0` を Undo/Redo の必要条件にして「pending op は Undo 対象外」と「in-flight 補償の直列化」を同時に満たす。
- **拒否時**: 補償 op が OCC で reject されたらスタックから除去＋`undo-blocked`/`redo-blocked` 通知（強制 Undo なし）。元 op（未 ACK）の reject はスタックから除去（AC5）。

## 制約

- protocol / server / 永続化 / IME 状態機械の遷移追加はゼロ（xhigh 非該当）。
- IME 不変（I-3・CG-1）: Undo/Redo は Navigation 位相かつ非 composing のみ。Editing/Composing 中はブラウザ既定へ委譲。
- standalone は DD-024 契約（connection/pending/rejected/divergence 非発火）を守る。

## 重点的に見てほしい点（findings 優先）

1. **サイレント上書き経路の有無（R-07）**: ownedRevision の更新タイミング・own echo 検出（clientId 一致）・reconnect reconcile 経由で accepted された op の扱いに、他者変更を revision 不一致で検知できず補償が上書きする経路がないか。
2. **revision 捕捉の正しさ**: `onOwnSetCellsCommitted` が渡す revision が「元操作が付与した revision」であること・同一 batch の他者 op と混同しないこと。standalone 即時確定 revision の読取（committed 事後読取）が単独モードで安全（他者不在）であること。
3. **Undo 条件マトリクスの網羅性**: 単独/共同 × 確定種別 × 競合有無 × pending/ACK × Undo/Redo・in-flight 直列化・redo 破棄・深さ100 に抜けがないか。
4. **権限・境界**: 公開語彙追加が R7（内部型非露出）を守るか。debug API 追加が公開契約を汚さないか。
5. **回帰・テスト不足**: IME/clipboard/range-selection への回帰・拾えていないエッジ（in-flight 中の新規操作 race・補償 op が noop になる経路・abort 経路）。
