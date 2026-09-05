# DD-047 検証結果（2026-09-05）

## 受け入れ基準

| AC | 結果と根拠 |
|---|---|
| 1 | PASS: 未指定/空RecordのCanvas data URL一致、unitで辺なしhasAny=false |
| 2/3 | PASS: 空セルを含む200列で縦線・集計上下線。行列背景/値背景の上に残る（ledger画像3 DPR） |
| 4 | PASS: 固定列0/1/5 × DPR 1/1.25/2の9組、固定行1、実ドラッグresize・縦横scrollを実ピクセルで検証 |
| 5 | PASS: unitで太さ/同幅後側/逆キー順、E2Eで交点の同幅横優先・太線優先 |
| 6 | PASS: overflow/左外流入停止、wrap自動行高、選択overlay、共同編集Presence（各画像参照） |
| 7 | PASS: 行の前へ2行挿入して対象線はindex 5→7、削除後は消失。後着r999はwarn 1回後に適用。不正設定6 E2E |
| 8 | PASS: React props写像/正準化unit、実React再renderでtextarea同一・draft保持、tarball consumerの4経路描画 |
| 9 | PASS: 表示設定/scroll/resizeでcommitted hash不変・commit通知0、copyはraw-value、編集payloadはrawのpreviousValueを保持。protocol/snapshot実装は差分なし |
| 10 | PASS: 下表。可視境界のunitは50,000行でも解決呼び出し50回未満、固定境界を1回だけ描く |
| 11 | PASS: alpha.4の10 tarballを独立consumerへinstall。公開型・React props・build・serve lifecycle・4経路描画・共同編集・destroyを検証 |

## 実コマンド

WindowsではBashスクリプトを`C:/Program Files/Git/bin/bash.exe`で実行。

| コマンド | 結果 |
|---|---|
| `bash scripts/dd-health.sh --dd DD-047 --new` / `bash scripts/doc-check.sh` | Phase 1 PASS |
| `npx vitest run packages/grid/src/border-rules.test.ts packages/render/src/border-layer.test.ts packages/render/src/text-overflow.test.ts packages/react/src/nanairo-sheet-view.dd036.test.ts tests/contract/facade-surface.test.ts -u` | 5 files / 42 tests、公開宣言snapshot 2件を意図して更新。更新なしの全回帰でもPASS |
| `npx playwright test borders.spec.ts zz-borders-perf.spec.ts --config apps/playground/playwright.config.ts` | 個別実行後、下の全回帰で罫線21＋性能3件PASS |
| `bash scripts/release/build-release.sh --out release/0.1.0-alpha.4` | closure宣言・全workspace typecheck・lint/境界・unit 122 files / 1262 tests PASS。10 tarball / 109 files |
| `npm run test:e2e` | Playground全186/186 PASS（3.1分） |
| `npm run test:e2e:showcase` | Showcase全4/4 PASS（罫線・行帯の実ピクセルを含む） |
| `node scripts/release/check-pack-contents.mjs release/0.1.0-alpha.4` / `node scripts/release/verify-manifest.mjs release/0.1.0-alpha.4` | 禁止設定/test/spec 0、全entrypointあり、10件の名前/版/sha256/bytes一致 |
| `RELEASE_VENDOR_DIR=/c/repo/spreadjs/release/0.1.0-alpha.4 bash scripts/consumer-app.sh` | 10 packageの展開実体・symlink 0・公開型・serve lifecycle・production build・E2E 6/6 PASS |

## 性能（Chromium / Windows / DPR 1 / viewport 1280×800）

各条件とも同じデータとスクロール経路で設定なし/ありを比較。1.5秒計測、開始3フレームを除外し88フレーム。
小規模2件は全セルを文字値で埋め、50,000行は先頭8列の40万セルを埋める。全列幅80px、固定5列/1行。

| 行×列 | なしframeP95 | ありframeP95 | 差 | 基準 |
|---|---:|---:|---:|---|
| 60×200 | 16.8ms | 16.7ms | -0.1ms | <33ms / 差<=3ms PASS |
| 70×382 | 16.8ms | 16.7ms | -0.1ms | PASS |
| 50,000×200 | 16.7ms | 16.8ms | +0.1ms | PASS |

生値: [60×200](perf-60x200.json)、[70×382](perf-70x382.json)、[50,000×200](perf-50000x200.json)。単一端末・Chromiumの計測であり、全実機の速度保証ではない。

## 画像の目視確認

- [固定5列・DPR1](ledger-dpr-1.png)、[DPR1.25](ledger-dpr-1.25.png)、[DPR2](ledger-dpr-2.png)
- [60×200の表](matrix-60x200.png)、[70×382の表](matrix-70x382.png)
- [wrapと選択](wrap-selection.png)、[overflow](overflow.png)、[共同編集Presence](collaboration-presence.png)

## 実行中に修正した試験・consumer

- 空オプションを並べたunitのunion推論が`Record`と合わなかったため、型付きsamplesへ変更しtypecheckを再実行。
- resize後のフォーカス中textareaを画面外へ送ると既存blur→scroll-followが横位置を戻すため、非編集中scrollの試験は明示blur後に実施。実IMEのfocus挙動は今回変更していない。
- standalone playgroundにwrap queryを配線し、公開wrap APIとの併存を検証。
- 独立React consumerにreactとreact-domを明示依存として導入し、異なる場所のReact runtimeを混在させない。standaloneはconnectionイベントを出さないため例のモード表示も修正。SDK配布物のproducer修正は不要で、同じtarballで最終6/6 PASS。

## 成果物の出自

着手前からDD-046が未コミットだったため、その修正を含むtarballの`closureDirty=true`は保持する。DD-047だけをコミットし、残る配布差分は成果物の`source.patch`と`source-state.json`で記録・SHA-256検証する。コミット単独から再現できる正式registry公開物とは区別する。
実tarballがconsumerで動くことと、未コミット差分を含むという出自を分けて記録する。

- 最終画像点検で、共同編集/Showcaseのseedは`row-<1始まり>`であり、standalone例の`r<0始まり>`と異なることを検出。例の行罫線・行背景を実IDへ修正し、両モードconsumerとShowcaseに横罫線の実ピクセル検査を追加した。SDK本体は変更なし。
