# DD-058 Bug#001: 高DPIのCanvas合成で文字・罫線がにじむ

2026-10-13 / consumer: 広島空港 H15 / 修正前: alpha.13

## 再現

playground の standalone.html を DPR 1.25 で開き、container を CSS left=17px、top=197.77px、1000×500px に置く。
stage の原点は (21.25,247.20703125) device px。overlay と DOM 編集欄を隠し、base の白背景合成 bitmap と page.screenshot の同じ600×200実画素（原点から4px内側）を比較する。

初回調査（Chromium 149.0.7827.55）: 平均差1.87254、最大差126、10,594画素が不一致。DPR1.5では平均差0.84492・最大差84で、全面平均 ≤1 だけでは罫線の補間を検出できない。DPR1.75では平均差1.70552・最大差127。DPR1/2は当該位置で差0だった。

期待: 罫線の1画素と文字の輪郭の画素が bitmap と一致する。実際: 原点の端数による補間で別の色へ薄まり、隣接画素へ広がる。

## 方式の採否

- canvas の left/top だけ: 表示の rect は近づくが合成結果が変わらず不採用。
- translate だけ: 一部の補間が残り、DPR1/2でも新たににじみを作る場合があるため不採用。
- translate + pixelated: 初期位置で差0でも、位置移動後のDPR2で表示が1画素左へずれる（平均差0.90185、最大差167）。原点相殺なしでは不十分。
- viewport (0,0) への原点相殺 + translate + pixelated: 位置移動後と整数px移動後も差0。採用。

原点相殺の必要性は画素比較からの判断で、Chrome内部の丸め処理の推定は実装根拠の保証範囲に含めない。

## 再実行

Viteを5199で起動し、`node doc/archived/DD/DD-058/measure.mjs`。同スクリプトはブラウザー内だけで配置補正/CSS指定を外し、描画ループを止めて候補を比較する。機械検証の正は補正を外さない `apps/playground/e2e/canvas-dpi.spec.ts`。

修正前・候補のPNG、方式比較 `phase0.json` と修正後E2EのPNG/JSONをこのフォルダへ配置する。実機のWindows表示スケール125%/GPU合成は未確認。
