# Codexレビュー依頼: DD-061〜063（セルの状態表示の色・共同編集モード対応・確定前の検証）

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製リアルタイム共同編集スプレッドシート型入力基盤（依存ゼロのCanvasグリッドコア＋Hono/wsサーバー）。直前の DD-060（コミット `dae8d11`）で、単独モードの行データ `cellStatus` によるセルの状態表示（error/warning の枠と背景・`cell-hover` の `status`）を入れた。本依頼はその範囲外とした3つの対応:

- **DD-061** 状態表示の色を mount オプション `cellStatusColors` で変える
- **DD-062** 両モード共通の `GridInstance.setCellStatus` を足し、共同編集モードでも状態を付け外しできるようにする（状態は view-local）
- **DD-063** mount オプション `validateCell` で規則に合わない値の確定を止める（入力を捨てて `cell-invalid` で通知）

DD 本文: `doc/DD/DD-061_セルの状態表示の色の設定.md`・`doc/DD/DD-062_セルの状態表示の共同編集モード対応.md`・`doc/DD/DD-063_確定前のセル入力の検証.md`（決定事項・受け入れ基準）。仕様はユーザー承認／委任済みで、本レビューの対象は**実装が決定どおり正しく作られているか**であり、**設計判断そのものの当否は問わない**（後述「対象外」）。

## レビュー対象差分

未コミット変更すべて（`git status`・`git diff HEAD`）。untracked の新規ファイル:

- `packages/grid/src/cell-status.ts`・`packages/grid/src/cell-status.test.ts`
- `packages/react/src/nanairo-sheet-view.dd061.test.ts`
- `apps/playground/e2e/cell-status-collab.spec.ts`・`apps/playground/e2e/validate-cell.spec.ts`
- `apps/playground/src/integration/validate-options.ts`

DD 文書と本依頼書は対象外。版上げ（10 package・package-lock を alpha.16）は機械的な置換。

## 決定事項（この実装の正）

DD-061:
1. `cellStatusColors?: { error?: { frame?; background? }; warning?: {…} }`（両モード・mount 時固定）。省略は既定色。不正（オブジェクトでない・未知のキー・空の色）は mount 時に `column-types-invalid`。CSS の色の妥当性は検査せず、不正な色は既定色で描く（直前の色を引き継がない）。React は同名 props（値が変われば開き直す）

DD-062:
2. `setCellStatus(rows: { rowId; cellStatus }[])`（両モード）。行を丸ごと置き換え、`{}` で消す。view-local（サーバーへ送らない・他の参加者に出ない・Undo/cell-commit の対象外）
3. 単独モードは `setRows`／`setData`／`initialData` の `cellStatus` と同じ置き場（`setData` は作り直す）。boot 前でも呼べ、単独モードは `setData`/`setRows` と呼んだ順に適用する
4. 未知の RowId も受け付ける。単独モードは未知列を入力時に落とし、共同編集モードは描画時に解決できない列を描かない。`cell-hover` の `status` と出し直しは両モード

DD-063:
5. `validateCell?: ({ rowId; columnId; value }) => string | null`（両モード・同期）。`value` は cell-commit の value と同じ表示文字列。文字列を返すと拒否
6. 拒否したら入力を捨てる（文書・サーバー・Undo は変わらない）。編集は閉じる。`cell-invalid`（`source`・`cells`）を確定処理の後（microtask）に両モードで出す
7. 検証する経路: IME/textarea（`edit`）・選択式の候補（`select`）・日付のカレンダー（`date`）・貼り付け（`paste`。1 件でも不正なら全体を拒否し、不正なセルを全部載せる）
8. 検証しない経路: 空にする確定（Delete・範囲クリア・cut・空のまま確定）・Undo/Redo・`setRows`/`setData`・リモートの変更
9. 例外を投げたら通す（診断 `validate-cell-threw`）。読み取り専用・選択式の候補検証が先に効く
10. React の `validateCell` props は関数を差し替えても開き直さず最新を呼ぶ。有無が変わったときだけ開き直す

## 実装の要点

- `packages/grid/src/cell-status.ts`（新規）: `validateCellStatusColors`（DD-061）、状態の置き場 `createCellStatusStore(isKnownColumn?)`・`replaceRow`/`clear`/`statusOf`/`row`/`hasAny`（DD-062。DD-060 で standalone-session にあった正規化をここへ移した）
- `packages/grid/src/standalone-session.ts`: 置き場を config で受ける（省略時は自前で作る）。`setData` で `clear`、`setRows` は明示した行だけ `replaceRow`
- `packages/render/src/base-layer.ts`: `cellStatusColors` を受け、`setStatusFill` で既定色を入れてから上書きする
- `packages/grid/src/mount-controller.ts`:
  - 置き場を controller が持ち（単独モードは columnOrder で未知列を落とす）、描画フック `cellStatusesInRow` を両モードで束縛（0 件なら即 undefined）。`cell-hover` の `status` も置き場から引く
  - `setCellStatus`: 単独モードの boot 前は `pendingStandaloneCalls`（setData/setRows と同じ queue）へ積む。それ以外は `applyCellStatus`（置き場へ書き、`view.markCellDirty()` とホバーの出し直し）
  - `rejectInvalidCells(op, source)`（controller 直下）: blank を飛ばして `validateCell` を呼び、拒否があれば診断と microtask の `cell-invalid`
  - `submitSetCells(op, validationSource?)`: 読み取り専用の破棄の**後**・Undo 捕捉の**前**で、`validationSource` があるときだけ検証。`editorSubmit` は `'edit'`、選択式は `'select'`、日付は `'date'` を渡す。範囲クリア・cut は渡さない
  - 貼り付けは、読み取り専用の除外（`filterReadOnlyCells`）の後・選択の移動（`selectPastedRect`）の前で `rejectInvalidCells(op, 'paste')`、`submitSetCells` には渡さない（二重に検証しない）
- `packages/react/src/index.ts`: `cellStatusColors` props（識別系）、handle の `setCellStatus`、`validateCell` props（`onDiagnostic` と同じく mount 時にあれば最新 ref を読む安定ラッパー。識別系には有無だけ）
- playground: `?statuscolors=`（JSON）・`?validate=<列>:<規則>`・`?prebootstatus=1`（E2E 用）

検証済み: unit 1526件・typecheck・consumer-strict・lint・E2E（cell-status 8件・cell-status-collab 1件・validate-cell 6件・関連既存）green。

## 評価基準（この観点で見てほしい）

1. **決定事項との一致**: 上記 1〜10 のとおりに動くか
2. **確定経路（DD-063・最重要）**: 検証を挟んだことで、IME の確定（composition 終了直後の Enter・blur・クリック）、DD-056 H12 の変換の終わり待ち（`readOnlyDeferred`・`inDeferredLockCommit`）、Undo 記録（拒否した入力が Undo に積まれない・`pendingStandaloneUndoPatches` が残らない）、OCC（`beforeRevision`）、選択式のドロップダウン・日付のポップオーバーの閉じ方が壊れていないか。拒否の後に編集状態・アクティブセル・draft が不整合にならないか。`cell-invalid` を microtask にしたことで、destroy・連続確定・購読者からの公開 API 呼び出しで問題が起きないか
3. **貼り付け**: 全成功/全失敗、選択を動かさないこと、`too-large`/`out-of-bounds`/読み取り専用の除外との順序
4. **置き場の共有（DD-062）**: 単独モードの boot 前の呼び出し順（setData→setCellStatus／setCellStatus→setData）、`setData` の作り直し、共同編集モードで行が後から届く・削除される・列が解決できない場合の描画と `cell-hover`
5. **既存挙動の非破壊**: 状態・検証・色を使わない画面が従来と同一か（描画コスト・確定経路）。DD-060 の単独モードの挙動
6. **型と公開面**: `exactOptionalPropertyTypes` 下でキーを `undefined` で作っていないか。JS の consumer から来る不正値（`validateCell` が関数でない・`setCellStatus` の rows が壊れている）で例外にならないか
7. **テストの効き**: 追加した unit・E2E が上記を本当に検出できるか（アサーションが緩すぎないか）

## 対象外（指摘しても採用しない観点）

- 決定事項の設計選択そのものの当否（例: 拒否したら編集を続けさせる案・状態を他の参加者と共有する案・色以外の見た目の設定）
- 命名の好み（既存コードの命名規則と整合していればよい）
- 本DDの範囲外の改善提案・既存コードの別件の不具合（見つけたら「別件」として1行で挙げるのは歓迎）
- CHANGELOG・quick-start・DD 文書の文体
