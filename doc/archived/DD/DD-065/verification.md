# DD-065 検証記録（2026-11-08）

## 対象と再利用条件

- 比較元: `6968e66`（DD-064 の完了後）。初期の mount-controller.ts は 4,567 行
- Claude からの引き継ぎ時点: `767fa9a`。最後の区画⑥の `config.ts`・`lifecycle.ts` と組み立て側の変更は未コミットで、未使用 import による型エラーが残っていた
- 最終の SDK 本体: `5600374`。引き継いだ変更を整理し、`lifecycle.test.ts` の 9 件を追加。レビュー後の `389d304` は開発用ガードとそのテストだけの修正（SDK 本体・依存・lockfile・設定は同一）
- 実行環境: Windows・Node.js 24.22.1・npm 11.19.1。ブラウザーは Playwright Chromium。実 IME は使用していない
- ログ・画面: ルートの `test-results/dd-evidence/DD-065/`（git 管理外）。再利用時は対象ソース・依存・設定・環境が同じことを確認する

## 機械検証

| コマンド | 結果 |
|---|---|
| `npx vitest run packages/grid packages/react` | 引き継いだ区画の import 整理後、58 ファイル・700 件成功（新規 lifecycle テスト追加前） |
| `npx vitest run packages/grid/src/mount/lifecycle.test.ts` | 9 件成功 |
| `npx tsc -p packages/grid --noEmit` | 成功 |
| `npm run lint:size -- --update-baseline` | mount-controller.ts を baseline から削除。残りは対象外のファイル 3・関数 1 |
| `npm run lint` | 成功。新規境界違反 0、サイズのガードも成功 |
| `npm run typecheck` | 全 workspace 成功 |
| `npm run typecheck:consumer-strict` | 成功 |
| `npm test` | 区画⑥完了時は 160 ファイル・1,665 件成功。ガード修正後の最終結果を下記に記録（contract・invariants を含む） |
| `npm run build` | 成功 |
| `npm run test:e2e` | 290 件成功（4.9 分）。flush 中 destroy・単独／共同編集・キー入力・描画・性能を含む |
| `npm run test:e2e:showcase` | 5 件成功（15.8 秒）。両設定は WS :8801 を使うため playground 完了後に直列実行 |

### レビュー修正後の検証と再利用

- `npx vitest run tests/tooling/size-guard.test.ts tests/tooling/size-guard-base-ref.test.ts`: 28 件成功
- CLI の再現: `SIZE_GUARD_BASE_REF` を存在しない 40 桁 SHA にした場合は exit 1、導入前の `6968e66` は exit 0（導入前の不在だけを許容）
- `389d304` に対する最終の `npm run lint`・`npm test`: ともに成功。161 ファイル・1,673 件成功（29.41 秒）。結果ログは `lint-final.log`・`unit-final.log`
- 修正は `scripts/size-guard/` と `tests/tooling/` だけ。型検査・build・SDK／React の E2E が参照するソースと設定は `5600374` と同一なので、上表の成功結果を再利用する。文書だけの完了処理後は文書整合と差分だけを検査する

## ブラウザー操作確認（Playwright MCP）

実物の standalone.html を開き、初回描画まで待ってから操作した。別のブラウザーコンテキストで独立した単独文書を使い、共同編集の E2E 用データは変更していない。

| 操作 | 観測した結果・証跡 |
|---|---|
| ダブルクリック → 合成 compositionstart/update/end/input → Enter | `引き継ぎ確認` が r2/col-a に確定し、次の行へ移動。実 Microsoft IME の検証には数えない |
| 選択式セルで F2 → ↓ → Enter | A/B の候補欄が開き、B を確定して閉じた（`select.png`） |
| 日付セルで F2 → → → Enter | カレンダーを開き、2026-11-08 から 2026-11-09 を確定（`date.png`） |
| Ctrl+Z → Ctrl+Y | 日付が 11-08 に戻り、11-09 を再適用 |
| 3 行×3 列のドラッグ → Escape | 範囲が rowStart=3,rowEnd=6,colStart=0,colEnd=3 となり、Escape で解除 |
| 見出しの右端をドラッグ | 列幅が 80px → 約139px に増加 |
| Ctrl+C → 別セルで Ctrl+V | `引き継ぎ確認` を r2/col-a から r3/col-d へ貼り付け（`edit-range-resize-clipboard.png`） |
| 読み取り専用の列と行で F2・文字・Delete | committedHash が変化しない |
| 2 行の結合セルの下側をクリック → ↓ | 左上の row=3,col=2 へ正規化し、↓で row=5,col=2 へ移動（`readonly-merged.png`） |

操作中の公開 error イベントは 0 件。最初のナビゲーションでは favicon 404 の console error が 1 件あり、再ナビゲーション後の操作時点では console error は 0 件。SDK の runtime error は無い。画面も確認した。操作後、E2E 終了で Vite :5199 が停止すると、開いたままの MCP タブで Vite HMR の接続拒否が繰り返し記録された（`@vite/client`）。確認を終えたタブは閉じた。

## 差分とセルフレビュー

- `git diff 6968e66` で Facade の入口（grid/react/server-hono）と `tests/contract/` に変更がないことを照合。既存テストの期待値は変更していない。E2E の変更は flush 中 destroy の 1 件追加
- 状態を共有 state オブジェクトへまとめず、機能ごとに所有。共有する backend・editor・設定・描画座標は getter で読み、初期化中の値を固定しない
- `attachBackendRendering()` に結線と開始の順番を残した。ポインターの listener 登録後に ResizeObserver を開始する順、初回の描画準備 → rAF → 単独 microtask／共同編集の boot の順を維持
- `destroy()` は flush の解決から購読解除まで元の解放順を維持。部品の dispose・タイマー停止・abort を組み立てから呼ぶ
- 再注入キューの順序・config 失敗・起動前 destroy/abort のテストを追加。既存の実物 E2E で再 mount・WS・rAF・interval の解放を確認する
- 公開 API・画面仕様・DB・protocol の変更なし。機能カタログの提供範囲・status は変わらないため `features.json` の更新対象はない。ガードとテストの置き場所は AGENTS.md に反映
- 単独の pack・版上げ・配布は行わず、CHANGELOG の Unreleased に次回配布向けの記録を追加

## 受け入れ基準の照合

| DD の基準 | 結果 |
|---|---|
| 1 公開 API | Facade の入口と contract に差分なし、contract のテスト成功 |
| 2 既存の振る舞い | 単体・E2E 全体が成功、既存期待値の変更なし |
| 3 1,000 行以下 | 605 行、baseline から削除 |
| 4 状態の所有 | diagnosis §12 の一覧と各部品の実装を照合。関数の入れ物 0 |
| 5 複雑度 30 以下 | 配線の最大 20、grid 配線の baseline 0 |
| 6 キー入力の配列 | 8 段の順序と 3 種の結果を単体で固定 |
| 7 mount 不要の単体テスト | 配線の部品 59 件（候補欄・日付・抑止・キー入力を含む） |
| 8 未保護だった経路 | flush 中 destroy の E2E・単体、キュー上限の単体を追加 |
| 9 ガード | 28 件のテストと CLI の成功／失敗を確認。P2 の取得失敗も修正 |
| 10 ブラウザー操作 | 上記の全操作を確認。実 IME とは区別 |
| 11 恒久ルール | AGENTS.md にガード・失敗時の対応・テストの置き場所を記載 |

## 既知の未保証境界

- T1 実 Microsoft IME（S1〜S5）は未実施。Playwright の合成 composition と実 IME を区別する。リポジトリの Manual Gate 規則によりクローズはブロックしない
- 実装レビューは `5600374` までの差分を照合。P2 1 件を採用し `389d304` で修正。別プロセスの修正後再レビューは未実施（実装側で回帰・CLI を確認）。結果と採否は `implementation-review-result.md`
