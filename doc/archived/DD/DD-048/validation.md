# DD-048 検証結果（2026-09-06）

## 受け入れ基準

| AC | 結果・証拠 |
|---|---|
| 1 | PASS: 無指定/空の既存E2E、solid省略/明示のCanvas data URL一致、公開宣言snapshot・React unit |
| 2 | PASS: dotted/dashedのon/off画素をDPR別に検査。offに列背景・行背景・値背景が残る。描画unitで当該格子pathの抑止と値背景inset解除を検証 |
| 3 | PASS: 共通線の0/1行・最終行・非連続ID・setData。1device pxの外周線がclipで消えないことをunitとCanvasで確認 |
| 4 | PASS: 共通より細い明示線優先、同幅後側、逆キー順のunit。実線/点線/破線の混在、交点の幅→横線の既存E2E |
| 5 | PASS（確定範囲）: 再mountせずローカル/リモートinsert/delete・setData、追加行をセル編集してUndo/Redo後も点線を保持。行操作自体のUndo/Redoは既存未提供のため検証対象外と明確化 |
| 6 | PASS: DPR 1/1.25/2 × 固定0/2行列の6組、縦横scroll、実ドラッグの列幅/行高resize、viewport resize、wrap。固定境界は一度だけ描画し周期を再開しない |
| 7 | PASS: 表示設定・scroll/resizeでcommitted hash不変、cell-commit 0。copyはraw、編集のpreviousValue不変、2クライアントhash一致、選択/Presenceはoverlay。文書/protocol/snapshotの実装差分なし |
| 8 | PASS: 不正style/defaultのunitとconfigエラーE2E、Reactのprop写像・同値判定・style変更時remount。実Reactのdraft/textarea保持と独立consumer接続保持 |
| 9 | PASS: 50,000×200、40万非空セル、frameP95 16.7ms、なし比0ms。unitでも50,000行に対するrow境界解決は30回未満 |
| 10 | PASS: 正式alpha.5 tarballのみでgrid/React × standalone/collaboration、型解決・build・serve lifecycle・追加行・setData・同値draft/接続保持を検証 |

## 実コマンドと結果

WindowsのBashは`C:/Program Files/Git/bin/bash.exe`を使用。Node v22.20.0 / npm 10.9.3。

| コマンド | 結果 |
|---|---|
| `bash scripts/dd-health.sh --dd DD-048` / `bash scripts/doc-check.sh` | Phase 1 PASS |
| `npx vitest run packages/grid/src/border-rules.test.ts packages/react/src/nanairo-sheet-view.dd036.test.ts packages/react/src/nanairo-sheet-view.test.ts packages/render/src/border-layer.test.ts` | 51件PASS |
| `npx vitest run packages/render/src/base-layer.dd048.test.ts` | 8件PASS |
| `npx vitest run tests/contract/facade-surface.test.ts -u` | 9件PASS・新APIに一致するsnapshot 2件を更新、下の全unitで更新なしPASS |
| `npx playwright test borders.spec.ts zz-borders-perf.spec.ts --config apps/playground/playwright.config.ts -g DD-048` | 対象15件PASS |
| `npm run test:e2e` | Playground全201/201 PASS（2.9分） |
| `npm run test:e2e:showcase` | Showcase全4/4 PASS |
| `bash scripts/release/build-release.sh --out release/0.1.0-alpha.5` | closure宣言・全workspace typecheck・lint/境界・unit 123 files / 1,281 tests PASS。10tarball / 109files |
| `node scripts/release/verify-manifest.mjs release/0.1.0-alpha.5` / `node scripts/release/check-pack-contents.mjs release/0.1.0-alpha.5` | 10tarballの名前/版/bytes/SHA-256一致、禁止設定/test/specなし、全entrypointあり |
| `RELEASE_VENDOR_DIR=/c/repo/spreadjs/release/0.1.0-alpha.5 bash scripts/consumer-app.sh` | 最終配布10tarballのinstall実体・symlink0・型解決・serve lifecycle・production build・E2E 10/10 PASS |

## 性能・画面証拠

Chromium 149.0.7827.55 / Windows / DPR1 / viewport1280×800、列幅80px、固定5列/1行。
50,000×200・先頭8列40万セル、1.5秒の横scroll、最初3frameを除外した88frameで比較。
設定なし16.7ms、共通点線＋縦破線16.7ms、差0ms（基準<33ms・差≤3ms）。
生値・userAgent・計測時刻: [perf-50000x200.json](perf-50000x200.json)。単一端末での計測であり全実機の保証ではない。

- [固定2行列・DPR1 Before](pattern-before-dpr-1-frozen-2.png) / [After](pattern-after-dpr-1-frozen-2.png)
- [DPR1.25](pattern-before-dpr-1.25-frozen-2.png) / [DPR2](pattern-before-dpr-2-frozen-2.png)
- [wrap](wrap.png) / [共同編集](collaboration.png)

Before/Afterは実装前後ではなく、同じ実装でのscroll/resize前後。赤/青は画素判定用の色。
人手での実機拡大率における薄い点線の視認性、松下の実画面での受け入れは未実施。
全再生成ログは`test-results/dd-evidence/DD-048/`（gitignore）へ保存する。

## 検証中に明確化・修正した事項

- 既存UndoスタックはSetCellsのみ。行構造Undoを新規実装せず、既存の行増減とセル値Undo/Redoを組み合わせて確認する範囲にDDを明確化した。
- 外周1device px線がclipで消える描画を修正し、最終行の下端へ内側1device pxを残した。
- 共同編集の新規E2Eは追加行を削除して後続回帰の行位置を維持。全回帰をクリーンなサーバーから再実行した。
- consumerの`ref`はReact props型そのものへ含めず`createElement`に渡すよう修正し、独立型解決・build・10件E2Eを確認した。

## 出自

配布ソースは`e52944c`。全配布パスをcommit後に正式packし、`closureDirty=false`。
[凍結manifest](release-manifest.json)と配布ディレクトリのmanifestは同一。
成果物の公開・push・松下への適用は本作業では実施していない。

配布ZIP `release/nanairo-sheet-0.1.0-alpha.5.zip`: 338543 bytes / 12 entries。ZIP内10tarballのSHA-256/bytesをmanifestと照合してPASS。
