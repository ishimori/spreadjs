# DD-050 Codex レビュー依頼（厳格な consumer 設定での型検査）

## 背景

- 正本: `doc/DD/DD-050_厳格なconsumer設定での型検査.md`（目的・決定事項 D1〜D5・受け入れ基準）
- SDK は TS ソースのまま配っている（各 package.json の `types: ./src/index.ts`）。consumer の tsc は SDK のソースも consumer の tsconfig で
  型検査する（`skipLibCheck` は .d.ts にしか効かない）。広島空港 consumer は `exactOptionalPropertyTypes`・`noUncheckedIndexedAccess` を
  有効にしており、Facade 3 つ（grid・react・server-hono）の入口から辿れる SDK ソースで 38 件の型エラーが出ていた。
- 本 DD は「ソースのまま厳格設定でも通る」までに絞る（.d.ts 配布は DD-031）。Risk Class B: 型のための修正が中心で、
  **正常系の実行時挙動を変えないこと**が前提。

## 対象差分（未コミット・`--uncommitted`）

- 検査の新設: `tsconfig.consumer-strict.json`（新規）、ルート `package.json` の `typecheck:consumer-strict`、`.github/workflows/ci.yml` の
  checks に 1 ステップ、`AGENTS.md` のコマンド表
- ソース修正: `packages/core/src/protocol.ts`、`packages/collab/src/session.ts`、`packages/grid/src/{border-rules,display-format,ime-editing-session,select-editor}.ts`、
  `packages/ime/src/event-recorder.ts`、`packages/react/src/index.ts`、`packages/server/src/{oplog-store,persistent-room,room,sequencer,snapshot}.ts`、
  `packages/server-hono/src/server.ts`
- 記録: `CHANGELOG.md`（Unreleased）・DD 本文

## 設計意図（直し方の規則・DD 決定事項 D3/D4）

1. **公開型（Facade が export する型）は変えない**。SDK 内の呼び出し側で undefined を落として渡す。
   - react `toMountOptions`: `omitUndefined` で値が undefined のキーを落としてから grid の `GridMountOptions` へ渡す（従来は undefined のキーを持ったまま渡していた）。
   - grid `border-rules.ts`: 解決済みの辺を入れる内部 Map の値型を、公開型 `GridRowBorders`/`GridColumnBorders` から関数ローカルの型へ替えた。
2. **内部型は `?: T | undefined` に広げ、実行時の値の形（キーの有無）を変えない**。対象は core `PresencePayload`、collab `ConflictQueueEntry`/`PresenceUpdate`、
   server `PersistentRoomOptions`、ime `ImeEventTrace`、grid `ImeEditingSessionConfig`/`SelectController.open`、server-hono `StartServerOptions`/`RunningServer.recovery`/
   `createDocumentRuntime` の deps。条件付きスプレッドでキーを省く形にしなかったのは、ime の trace テストが `'key' in trace` でキーの有無を検査しており、
   形を変えずに済む方を選んだため。grid `display-format.ts` はローカル変数の型だけ。
3. **`noUncheckedIndexedAccess`**: `!` は使わない（規約 P03）。次の 3 形で直した。
   - 添字をなくす: `entries()`（oplog-store の行ループ・snapshot の `structuralMatch`・server-hono の `takeDeliverableSubmit`）、`reduceRight`（session の
     `rollbackBaselineHash`）、反転コピー（session の `applyInverseSeed`）。
   - 取り出した値の undefined 判定へ置き換える: session `handleRejected`（`findIndex` の -1 判定）、server-hono `validateDocumentsOptions`（`ids[0]`）。
   - 空なら内部エラーを throw: server `operationsMessage`（room.ts）・`primaryRejectCode`（sequencer.ts）。どちらも呼び出し側が 1 件以上で呼ぶ。

## 評価基準（この観点で指摘してほしい）

1. **実行時挙動の不変**: 正常系で挙動が変わった箇所は無いか。特に次を確認してほしい。
   - react の `omitUndefined` でキーが無くなることで、grid 側の解釈が変わる経路（スプレッド合成で既定値を上書きしていた、`in`・`Object.keys`・
     `hasOwnProperty` で判定していた、props の変更検知・remount 判定に影響する等）が無いか。
   - `reduceRight`・反転コピーの適用順が元のループ（末尾から先頭へ）と等価か。
   - `takeDeliverableSubmit` の `entries()` ループ内で splice してすぐ return する形が、元の添字ループと同じ要素を返すか。
   - oplog-store の末尾行（改行なし＝破棄）の判定、snapshot `structuralMatch` の比較結果、session `handleRejected` の早期 return の条件、
     `validateDocumentsOptions` のエラー条件とメッセージが、既存の入力に対して変わっていないか。
2. **追加した throw の到達性**: `operationsMessage`・`primaryRejectCode` の throw が、正常系や既存の異常系（reject・catch-up・bootstrap・再接続・
   永続化の復旧）で空の配列を渡して発火しうる呼び出し経路が無いか。
3. **公開型**: Facade の公開 .d.ts が変わっていないか。公開型を変えずに済ませた判断（`GridMountOptions`・`GridRowBorders` 等）に漏れが無いか。
   内部型を広げたことで、R7（公開シグネチャへの内部型の漏洩）や package 境界に影響が無いか。
4. **検査の網羅と再発防止**: `tsconfig.consumer-strict.json` の対象（Facade 3 つの入口から辿れるソース）と設定（extends・lib・types・files）が、consumer の実際の
   構成（DD ログ末尾の広島側 tsc 引数）と比べて取りこぼしを生まないか。CI の 1 ステップで違反が確実に落ちるか。
5. **型の正しさ**: `omitUndefined` の戻り値型（mapped type と `as`）が実値と食い違う入力は無いか。`?: T | undefined` へ広げた内部型の読み手に、
   undefined を扱っていない箇所が無いか。

## 対象外（指摘不要）

- `.d.ts` の生成・配布（DD-031）、他の厳格フラグ（`noPropertyAccessFromIndexSignature` 等）への対応（DD の既知の未保証境界）
- テスト・apps・`grid/test-support` を厳格設定に通すこと（論点 2 で対象外と確定）
- 仕様の選択そのもの（論点 1〜4）と、コメント・文言の細部
- alpha 配布の版（ユーザー判断待ち）

## 出力形式

findings を P1（正常系の実行時挙動の回帰・データ破壊・正常系で発火する throw）／P2（型の穴・検査の取りこぼし・境界の漏れ）／P3（保守性・テスト）で
分類し、各 finding に「ファイル:行・反例または再現手順・推奨修正」を付けてほしい。総評は「マージ可／条件付き／要修正」の 1 行。
