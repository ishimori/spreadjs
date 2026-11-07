# DD-065 診断: grid の mount 配線の計測（2026-11-08）

> 計測対象: コミット 85018dc（DD-064 の実装コミット直後）。`packages/*/src` のテスト以外のファイル。
> 計測方法: TypeScript コンパイラ API で関数単位に測った。循環的複雑度は if・for・while・do・case・catch・三項演算子・`&&`・`||`・`??` を1つずつ数え、入れ子の関数は別に数える（ESLint の `complexity` に近い数え方）。Phase 1 のガードが同じ計測を常設する。
> 行番号は 85018dc のもの。並行する変更でずれるので、着手時に取り直す。
> 2026-11-08 の Codex 計画レビュー（`codex-review-result.md`）で §2 のキー入力の順序・§5 の区画・§7 のテストの安全網を訂正した。

## 1. SDK 全体（健全な指標）

| 指標 | 値 |
|---|---|
| SDK のソース（テスト以外） | 約 2.9 万行・11 パッケージ |
| パッケージ間の依存方向 | lint で強制（`eslint.config.js` の R2/R3・`scripts/boundary/check.mjs` の R1/R4/R7） |
| パッケージ内の循環 import（値の import） | 11 パッケージすべてで 0 |
| `any`・`@ts-ignore`・`as unknown as`・TODO/FIXME | すべて 0 |
| `eslint-disable` | 2 |
| テスト | 単体 約 2.5 万行（vitest 全件で約 1 分）・E2E 53 本（playground 52・showcase 1） |
| 重複コード（正規化した 8 行の一致） | SDK 本体ではわずか |

負債はパッケージの骨格ではなく、次の 1 ファイルに集中している。

## 2. mount-controller.ts の指標

| 指標 | 値 |
|---|---|
| 行数 | 4,533（7/14 の作成時は 623） |
| `createGridController` の行数 | 4,317（ファイルの 95%） |
| その中の `attachBackendRendering` | 1,292（DD-024 で同じクロージャの中に抜き出したもの） |
| `createGridController` 直下の `let` | 62。ほかに const の可変コンテナ（`listeners`・`flushWaiters`・`pendingStandaloneCalls`） |
| 後から代入する関数の入れ物 | 9（`openSelectForActive`・`closeSelectDropdown`・`refreshSelectPlacement`・`isSelectColumnIndex`・`isSearchableSelectColumnIndex`・`openDateForActive`・`closeDatePicker`・`refreshDatePlacement`・`isDblclickDateColumnIndex`） |
| import | grid 内 41 モジュール・SDK 6 パッケージ（grid 内で次に多い `index.ts` は 10） |
| 循環的複雑度 30 超の関数 | `interceptKeydown` 62（278 行）・`pointermove` ハンドラ 38（95 行）・`pointerdown` ハンドラ 31（107 行） |
| 変更の集中 | 7/14 以降に SDK のソースを変えたコミット 72 件のうち 53 件がこのファイルを触る |
| Codex の指摘番号つきコメント | 41 か所 |
| 実物を通すテスト | E2E だけ。vitest には実物の mount-controller を実行するテストが無い（§7） |

Codex の指摘番号つきの修正は、boot 前の呼び出しの順序・提出前の選択遷移・ドラッグ中に届いたリモート変更・範囲選択中のホバー・3 経路での `stringColumns` の契約など、タイミングと機能間の干渉が中心。DD-064 の Codex 指摘 4 件のうち 2 件（変換中の結合・開いた候補欄）も同じ種類。

**キー入力の裁定（`interceptKeydown`・3718–3995）の今の順序**:

1. 読み取り専用（グリッド全体）の編集キーの抑止
2. 読み取り専用の列・行・セルと結合範囲の編集キーの抑止（範囲があるときの Delete は抑止せず 8 へ流す）
3. 日付カレンダー
4. 候補欄
5. Undo / Redo
6. 行の挿入・削除のショートカット
7. 結合セルを 1 つのセルとして動く移動
8. 範囲の操作（`decideNavigationIntercept`・3964–3994）: Shift＋矢印の範囲拡張（消費）・範囲があるときの Delete の範囲クリア（消費）・Escape の範囲解除（**範囲を解除したうえで `false` を返し、状態機械へも流す**）

各段の結果は「消費して止める（`true`）」「処理したうえで流す（`false`）」「該当しない」の 3 種類がある。日付と候補欄のコメントがどちらも「最優先」と書いていて、優先順位がコメント同士で食い違っている。

## 3. 成長の経過

| 日付 | コミット | 行数 | DD |
|---|---|---|---|
| 07-14 | f7420e2 | 623 | DD-016-1（playground から抽出） |
| 07-17 | 21e313f | 1,678 | DD-021-1（行操作） |
| 07-21 | 6bf016d | 2,358 | DD-033-1（表示専用モード） |
| 09-03 | b0ff57c | 3,205 | DD-037（選択式列） |
| 09-12 | 42477ce | 3,540 | DD-052-4（再注入と Undo） |
| 10-12 | b4db4f7 | 3,925 | DD-056-2（読み取り専用の実行時切替） |
| 10-26 | 6b0490b | 4,219 | DD-243-10（検索入力付きの候補選択） |
| 11-08 | 85018dc | 4,533 | DD-064（セルの結合） |

DD-064 だけで +314 行、`interceptKeydown` の複雑度 51→62、直下の `let` 59→62。

## 4. 共有状態の使われ方

`createGridController` 直下の `let` 62 個が、見出しコメント（`// ---- … ----`）で区切った 22 区画のうちいくつから参照されるか。見出しは構造を追い切れていない（例: 「日付列」の見出しの下に editor のフックとキー入力の裁定が続く）ので目安として使う。const の可変コンテナ 3 個はこの表に入っていない。

| 参照する区画の数 | 個数 | 例 |
|---|---|---|
| 1 | 14 | `resizeDrag`・`linkCandidate`・`selectionDrag`・`hoveredCell` |
| 2〜3 | 35 | `standalone`・`readOnlyDeferred`・`pendingCommands`・`compiledBorders` |
| 4 以上 | 13 | `sync` 16・`editor` 11・`readOnly` 11・`columnTypeRegistry` 6・`destroyed` 6・`selectDropdown` 5・`appearance` 5・`closeSelectDropdown` 5・`closeDatePicker` 5・`firstDataDrawn` 5・`datePicker` 4・`compiledDisplay` 4・`viewportWidth` 4 |

**相互依存の例**（分割で生成の順序が問題になる所）: 読み取り専用の実行時切替が editor の確定と候補欄・日付を閉じる操作を呼ぶ（860–917。今は `closeSelectDropdown?.()` などの遅延参照）。候補欄の提出（`editorSubmit`・3153–3167）が読み取り専用の遅延ロックの状態を読み書きする。editor の生成（3643–）が読み取り専用の状態と候補欄の操作を受け取る。`backend.start()` は `attachBackendRendering` の最後（4004）。

## 5. 区画の地図と分け目の候補（85018dc の行番号・約）

| 分け目の候補 | 今の場所 | 行数 |
|---|---|---|
| ① キー入力の裁定 | editor のフック（`onChange`・`interceptKeydown` など。3640–4005） | 約 365 |
| ② 候補欄 | 選択式入力列（3129–3339）＋候補リスト `syncSuggestList`・`refreshSelectPlacement`（3505–3639） | 約 345 |
| ③ 日付カレンダー | `openDate`・`confirmDate`・`refreshDatePlacement`（3340–3504） | 約 165 |
| ④ ポインター | 宣言とホバー（1163–1286）＋リンク・列幅・自動幅・`pointerdown`・`pointermove`・`dblclick`（1485–2079） | 約 720 |
| ⑤ 読み取り専用 | 実行時切替・送り切り・`pendingCount`（827–1029）＋列・行・セルの判定（1287–1484） | 約 400 |
| ⑥ 起動と 2 モード | 設定取得・列タイプ・`boot`・送信（2080–2531）＋`bootStandalone`・セル状態（4006–4169） | 約 615 |
| ⑦ 編集の結線と命令 | 行操作・再ベース（2532–2713）＋IME と backend の結線・範囲クリア・clipboard・Undo（2820–3128） | 約 490 |
| ⑧ E2E 用の口 | introspection（4321–4475） | 約 155 |
| ⑨ 描画 | 描画層（514–696）＋キャンバス・レイアウト・描画ループ `provisionCanvas`〜`masterLoop`（1030–1162）＋描画の接続（2714–2819）＋rAF の開始（4476–4506） | 約 455 |
| 残す: 組み立て | import と補助関数（1–189）・初期設定（190–229）・状態の宣言（230–328）・購読と GridEvent への写像（329–513）・命令 API（697–826）・公開ハンドル（4170–4320）・末尾（4507–4533） | 約 820 |

①〜⑨ で約 3,710 行、残りは今の形で約 820 行。分割すると部品の生成と結線のコードが増え、import（約 70 行）と状態の宣言（99 行）の多くは部品へ移る。この見積もりで 1,000 行以下に収まる見込み。⑨ を組み立てに残すと残りは約 1,270 行に結線のコードが加わり、1,000 行には届かない。⑨ の描画ループは各部品の状態（選択・ホバー・editor の位置など）を読むので、部品から描画に必要な値を読む口が要る。

## 6. ガードの初期 baseline（閾値: ファイル 1,000 行・循環的複雑度 30）

| 種類 | 対象 | 値 | 補足 |
|---|---|---|---|
| ファイル | `grid/src/mount-controller.ts` | 4,533 | 本 DD で分割 |
| ファイル | `server-hono/src/server.ts` | 1,935 | トップレベル関数 63・モジュール直下の可変状態 0 |
| ファイル | `render/src/base-layer.ts` | 1,107 | `createBaseLayer` が 845 行のクロージャ（次の候補） |
| ファイル | `collab/src/session.ts` | 1,046 | クラス 1 つ・メソッドに分かれている |
| 関数 | `interceptKeydown`（mount-controller） | 62 | 本 DD で分割 |
| 関数 | `pointermove` ハンドラ（mount-controller） | 38 | 本 DD で分割 |
| 関数 | `pointerdown` ハンドラ（mount-controller） | 31 | 本 DD で分割 |
| 関数 | `tokenize`（`formula/src/tokenizer.ts`） | 41 | 字句解析の分岐。対象外 |

値は Phase 1 の実施時に HEAD で取り直す。関数の行数は閾値にしない。150 行を超える関数 18 個の大半は、部品全体を返す factory（`createXxx()`）にあたるため。

## 7. テストの安全網と書く手間

- **vitest には、実物の mount-controller を実行するテストが無い。** React の jsdom テスト（`nanairo-sheet-view*.test.ts` 9 ファイル）はすべて `vi.mock('@nanairo-sheet/grid', …)` で mount を差し替えていて（例: `nanairo-sheet-view.dd064.test.ts` 24–43）、確かめているのは React の props から grid の命令への写像。consumer-app のテストも実物を mount しない
- 実物の配線を通すのは Playwright の E2E（52 本）だけ。分割で壊れたときに気づけるのも E2E だけで、E2E が通らない経路は分割で壊れても全回帰が通る
- 守られていない経路の例: flush を待っている最中の `destroy()`。`destroy()` は判定タイマーを取り消し、待っている flush をすべて `stopped` で解決する（4289–4303）。`flush-state.test.ts` は判定の純関数だけを見ていて、React のテストは grid を mock しているため、この結線はどのテストにも守られていない
- 配線の振る舞いを確かめたいとき、今は E2E を書くしかない（ブラウザーとサーバーを起動する）。単体テストなら 1 件 1 ms 未満（`select-editor.test.ts` は 35 件で 14 ms）

## 8. 最近の機能 DD の変更量（各 DD のコミットの追加行の合計・2026-11-08 時点）

| DD | ドキュメント | SDK のソース | 単体テスト | E2E |
|---|---|---|---|---|
| DD-056 | 1,004 | 1,281 | 1,707 | 657 |
| DD-059 | 59 | 224 | 539 | 245 |
| DD-060 | 273 | 763 | 851 | 648 |
| DD-064 | 241 | 1,650 | 972 | 476 |

テストは SDK のソースの 0.9〜3.5 倍。分割で書きやすくなるのは、このうち配線の振る舞いを確かめる部分（今は E2E でしか書けない部分）。
