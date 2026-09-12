# Codexレビュー依頼: DD-052（子DD-052-1〜5）＋ DD-053

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製リアルタイム共同編集スプレッドシート型入力基盤（依存ゼロのCanvasグリッドコア＋Hono/wsサーバー）。本レビューは、2つのconsumer駆動DDをまとめて対象にする。

- **DD-052**（アンブレラ）とその子DD-052-1〜5: ReadyCrew（案件DB商談進捗シート）から要望された機能拡張（RC1〜RC14のうち高・中優先の9件）
- **DD-053**: 広島空港モックで発見した不具合（セルを選ばずに参加しただけの利用者が他者の参加者一覧に載らない）

各DDのHuman Spec Gate（設計選択肢の決定）はユーザー承認済みで、本レビューの対象は**実装が決定どおり正しく作られているか**であり、**設計判断そのものの当否は問わない**（後述「対象外」）。

## レビュー対象差分

`git diff e1d6553...HEAD` で取得すること（コミット `e073c1b`〜`3c81459` の7コミット）。

**このレンジには DD-051（Beta移行計画の見直し）の起票コミットも含まれるが、DD-051 は本レビューの対象外**（Human Spec Gate 待ちの計画文書のみで実装なし）。DD-051 関連ファイル（`doc/DD/DD-051*`）への言及は不要。

## 評価基準（この観点で見てほしい）

1. **決定事項との一致**: 各子DDの「決定事項」節に書いた設計（後述）どおりに実装されているか
2. **既存挙動の非破壊**: すべて opt-in の新規オプション/イベントである前提（未指定なら旧挙動と完全一致するはずの箇所）で、実際にそうなっているか
3. **境界条件・エッジケース**: 特に状態機械（IME）・undo/redoスタック・presence protocolなど、既存の不変条件に触れる箇所
4. **テスト不足**: 実装した分岐に対応する単体テスト or E2Eテストが本当に効いているか（アサーションが緩すぎないか）
5. **型安全性・内部型の露出**（R7規約: 公開シグネチャに内部パッケージ由来の型を出さない）

## 対象外（指摘しても採用しない観点）

- 各DDの「検討内容」節で比較済みの設計選択肢の妥当性そのもの（Human Spec Gate済み）
- 命名の好み（既存コードの命名規則との整合が取れていれば良い）
- 本DDの範囲外の機能追加提案

---

## DD-052-1: 長文セル編集（RC1: セル内改行・RC2: 長文編集欄）

**ファイル**: `packages/ime/src/editor-state-machine.ts`（+test）・`packages/grid/src/ime-editing-session.ts`（+test）・`packages/grid/src/integration-editor.ts`・`packages/grid/src/mount-controller.ts`（isWrapColumn配線）・`apps/playground/e2e/wrap-cell-editing.spec.ts`

**決定事項**: `wrapColumns`列でAlt+Enterがセル内改行になる（Enterは従来どおり確定）。非wrap列はAlt+Enterも通常のEnterと同じ確定＋移動。編集中のtextareaは内容に応じて下へ伸び（8行相当を上限）、超えたら内部スクロール。

**設計上の注意点（実装時に発見した制約）**: 当初「Alt+Enterはstate machineが`[]`（Effect無し）を返しtextareaの既定動作〔改行挿入〕に任せる」設計で実装したが、**実ブラウザーE2EでAlt押下中のEnterはブラウザーが改行を挿入しないことが判明**（Windowsのメニューアクセラレータ修飾キーとの衝突と推定）。そのため新規Effect `InsertNewline` を追加し、UIアダプタ（`integration-editor.ts`の`insertNewlineAtCaret`）がcaret位置へ明示的にテキストを挿入し、`ime-editing-session.ts`がその結果を`machine.dispatch({type:'input',...})`へ再入させてdraftへ反映する設計に変更した（`packages/ime/src/editor-state-machine.ts`の`InsertNewline`効果の型コメント・`packages/grid/src/ime-editing-session.ts`の`case 'InsertNewline'`を参照）。

**特に見てほしい点**:
- `ime-editing-session.ts`の`applyEffect`内で`InsertNewline`処理が`applyEffects(machine.dispatch(...))`を再帰呼び出ししている箇所（無限再帰やイベント順序の破綻がないか）
- `integration-editor.ts`の`applyHeight`関数（wrap列判定・scrollHeight計測・上限クランプのロジック）
- 非wrap列の既存Alt+Enter挙動（確定+下移動）が本当に変わっていないか

## DD-052-2: 文字列として保つ列（RC12）

**ファイル**: `packages/core/src/cell-input.ts`（`parseCellInput`に`forceString`オプション追加・+test）・`packages/grid/src/commit-bridge.ts`・`packages/grid/src/clipboard-controller.ts`・`packages/grid/src/standalone-session.ts`・`packages/grid/src/ime-editing-session.ts`・`packages/grid/src/mount-controller.ts`・`packages/grid/src/index.ts`（`stringColumns`オプション追加）

**決定事項**: 新規mountオプション`stringColumns`で指定した列は、入力確定・貼り付け・`setData`のいずれの経路でも標準の型変換（date→number→string）をスキップし、空文字以外は常にstringとして保持する。

**特に見てほしい点**:
- `forceString`が3つの独立した経路（`draftToScalar`・`buildPaste`・`standalone-session.ts`の`buildDocument`）すべてに一貫適用されているか（漏れている経路がないか）
- 空文字の扱い（`forceString`でもblankになるか）
- `columnTypes`（select/link/date）との相互作用が「直交」という決定と矛盾しないか

## DD-052-3: 編集の制限（RC3: セル単位読み取り専用・RC14: 行操作の無効化）

**ファイル**: `packages/grid/src/readonly-policy.ts`（`partitionReadOnlyCellChanges`/`touchesReadOnlyCell`追加・+test）・`packages/grid/src/standalone-session.ts`（`isCellReadOnly`/`hasAnyCellReadOnly`/`setRows`との連携）・`packages/grid/src/row-operations.ts`（`rowOperationsEnabled`追加・+test）・`packages/grid/src/mount-controller.ts`・`packages/grid/src/index.ts`（`GridStandaloneRow.readOnlyColumns`・`rowOperations`オプション追加）

**決定事項**: RC3は`GridStandaloneRow`に`readOnlyColumns?: string[]`を追加し、行データ側からその行だけを対象に列を読み取り専用にできる（standalone専用・`setData`のたびに再評価）。既存の列単位`readOnlyColumns`・行単位`readOnlyRows`（mountオプション）とは別軸で、3つの論理和として判定する。RC14は`rowOperations?: boolean`（既定true）でCtrl+Shift+'+'/Ctrl+'-'のショートカットのみを無効化し、公開API`insertRows`/`deleteRows`は対象外。

**特に見てほしい点**:
- `mount-controller.ts`の`hasReadOnlyCells()`/`isActiveCellReadOnly()`（既存の列版・行版と共有する判定関数）を拡張する形でRC3を実装した結果、入口ガード・textareaロック・chokepoint（`submitSetCells`/`submitToBackend`）・範囲フィルタ（`filterReadOnlyCells`）の**全箇所に個別修正なしで波及**させている設計が正しく機能しているか（既存の列/行版の呼び出し箇所を全て確認してほしい）
- `standalone-session.ts`の`setRows`（DD-052-4由来）との相互作用（`readOnlyColumns`を明示した行だけ置き換え、省略した行は既存指定を保つロジック）
- 共同編集モードでRC3が正しく無効化されている（`isStandalone`ガード）か

## DD-052-4: 再注入と元に戻す履歴（RC4: setRows・RC13: Undo記録タイミング修正）

**ファイル**: `packages/grid/src/standalone-session.ts`（`setRows`・`beforeCellCommit`フック追加・+test）・`packages/grid/src/mount-controller.ts`（`pendingStandaloneUndoPatches`・`recordStandaloneUndoEntry`・`applyStandaloneSetRows`）・`packages/grid/src/index.ts`（`GridInstance.setRows`追加）・`apps/playground/e2e/set-rows.spec.ts`・`apps/playground/e2e/undo-setdata-ordering.spec.ts`

**決定事項（RC4）**: `setRows(rows)`は`setData`と違い、渡した行だけを置換・追加し、言及しなかった行・既存のUndo/Redo履歴には触れない。既存行は値が実際に変わったセルだけをdiffし、未知のRowIdは新規行として**末尾へ**追加する。readOnlyは`setData`と同様にバイパスする。`cell-commit`は発火しない（consumer自身が渡したデータへの通知エコーを避けるため）。

**決定事項（RC13）**: standaloneモードは`submitLocalOperation`内でconsumerのonCellCommitを同期発火するため、consumerがそのハンドラ内で同期的に`setData`を呼ぶと、`setData`の`undoCtrl.clear()`より**後**にUndo記録が実行され、消去済みスタックへ「幽霊エントリ」が残っていた（`canUndo()`が誤って`true`のまま）。`StandaloneSession`に`beforeCellCommit`フックを追加し、`onCellCommit`通知より**前**にUndo記録を完了させるよう修正した。

**特に見てほしい点**:
- `standalone-session.ts`の`setRows`実装（新規行の挿入位置決定で`afterRowId: null`が実際には「先頭挿入」を意味することに実装中に気づき、既存行の最終RowIdを明示アンカーにする修正を入れた＝`displayRowOrder(doc)`の末尾を使う箇所。この理解が正しいか、core側の`applyInsertRows`の実装と突き合わせてほしい）
- RC13の`pendingStandaloneUndoPatches`（`mount-controller.ts`の一時変数）のライフサイクル: readOnlyガードで`submitToBackend`に到達しなかった場合に確実にクリアされているか（次回submitへ漏れないか）
- `submitCompensation`（Undo/Redo補償パス）が`beforeCellCommit`フックの対象になるが`pendingStandaloneUndoPatches`を設定しないため無害、という判断の妥当性
- **回帰調査で発見した既存の潜在バグ**（`tests/invariants/collab/reconnect-fault.invariant.test.ts`のコメント参照）: 本DDの変更はこのバグの原因ではないと確認済みだが、念のため`session.ts`の`maybeFinalizeSync`の変更（DD-053）と`handleRejected`（`client-sequence-violation`分岐）の相互作用について、見落としがないか確認してほしい

## DD-052-5: 見出しクリックとホバーの通知（RC5・RC6）

**ファイル**: `packages/grid/src/mount-controller.ts`（`updateCellHover`・`header-click`/`cell-hover`発火）・`packages/grid/src/index.ts`（`GridEvent`に`header-click`/`cell-hover`追加・`GridCellRect`型追加）・`apps/playground/e2e/header-click-cell-hover.spec.ts`

**決定事項**: `header-click{columnId}`は列見出しクリックの通知のみ（並べ替えはconsumer実装）。`cell-hover{rowId,columnId,rect}`はポインタの位置するセルが変わったときだけ発火（同一セル内では再発火しない）。グリッド外・見出し領域・ドラッグ中は全フィールドnullのイベントで通知。**元のDD論点では列見出しの「並べ替え中インジケータ表示オプション」も検討していたが、実装時にスコープを絞り込みRC5のクリック通知のみに限定した**（理由はDD-052-5本文「範囲の見直し」節）。

**特に見てほしい点**:
- `updateCellHover`のセル変化検知ロジック（`hoveredCell`のnullを含む比較）
- 既存のlink列カーソル判定と`hitTest`呼び出しを共有させた結果、既存のカーソル切り替え挙動が変わっていないか
- pointerleaveハンドラの追加が既存のリサイズ/選択ドラッグの後始末と衝突しないか

## DD-053: 参加しただけの利用者を参加者一覧に載せる

**ファイル**: `packages/collab/src/session.ts`（`maybeFinalizeSync`の1箇所変更）・`packages/collab/src/session.test.ts`・`packages/server-hono/src/server.smoke.test.ts`・`apps/playground/e2e/remote-change.spec.ts`

**決定事項**: `ClientSession.maybeFinalizeSync()`が、welcome（join完了）のたびに必ずpresenceを送るよう変更（直前のpresenceがあればそれを再送、無ければ`{selectionRanges:[]}`を送る）。wireメッセージの種別・payload形は変更なし（`activeCell`は元々optional）。

**特に見てほしい点**:
- この1行変更（`this.sendPresence(this.lastPresence ?? { selectionRanges: [] });`）が、再接続時の重複送信・presence sequenceの単調性を壊していないか
- **本セッションが発見した既存の潜在バグ**: 本変更はメッセージ量をわずかに増やすため、`tests/invariants/collab/reconnect-fault.invariant.test.ts`の固定seed（1,234,567）で偶然「message storm」（`client-sequence-violation`受信時の再送が収束しないケース）を誘発するようになった。調査の結果、**本DDの変更とは無関係の既存バグ**と判断した（変更前のコードでも同一configでseedを1〜40振ると40件中10件が同じ症状で失敗＝25%の確率で元から収束保証がなかった）。この診断（`session.ts`の`handleRejected`のclient-sequence-violation分岐が原因、というテスト内コメントの記述）が妥当か、独立した視点で確認してほしい。対応は該当テストのseed差し替えのみに留め、`doc/plan/stage2-backlog.md`のK5として根本修正を別DD送りにした（本DDでは修正しない）
