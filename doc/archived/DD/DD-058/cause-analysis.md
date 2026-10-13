# DD-058 原因分析

## Bug#001: 高DPIでグリッドの canvas が実画素からずれてにじむ

**ファイル**:
- `packages/grid/src/dom-scaffold.ts` L36〜43 `buildScaffold()` — base／overlay の canvas を stage の `top:0; left:0` に置くだけ
- `packages/grid/src/mount-controller.ts` L860〜867 `provisionCanvas()`・L878〜892 `syncLayout()` — バッキングストア＝`round(CSS サイズ × DPR)`、`setTransform(dpr, …)`
- `packages/grid/src/mount-controller.ts` L1765〜1768 — `syncLayout()` を呼ぶのは stage の ResizeObserver（大きさの変化）だけ
- `packages/render/src/dpi.ts` `snapToDevice()` — canvas の中の罫線を device pixel へ snap する（canvas の左上が格子に乗っている前提）

**現象**: DPR 1.25 の Windows で、グリッドの文字と罫線だけがぼやけて見える。周りの DOM はくっきりしている。

**原因**: canvas の中では §12.4 どおり device pixel に合わせて描いているが、canvas 要素そのものがページ上の実画素の端数の位置にある。
Chrome はビットマップをその位置へ補間して合成するので、全画素が隣の画素と混ざる。stage の位置は consumer のレイアウトで決まり、SDK は補正していない。

**再現手順**（広島 PoC。alpha.13）:
1. `bash scripts/poc-dev.sh`（広島リポ）で起動し、`http://localhost:5979/?as=u-yamada` →「予算入力」で ① を開く
2. Chrome を DPR 1.25 で表示する（Windows の表示スケール 125%、または Playwright の `deviceScaleFactor: 1.25`・viewport 1440×800）
3. canvas の左上は CSS (17, 197.77) ＝ 実画素 (21.25, 247.21)。罫線が 2 画素に割れ、文字がにじむ

## 計測1: 実機のスクリーンショット（ユーザー提供・2026-10-13）

| 対象 | 画素の値（明るさ 0〜255） | 読み |
|---|---|---|
| canvas の縦の罫線（2 か所） | 230・224 の 2 画素 | 1 画素の罫線が 2 画素に割れている |
| canvas の横の罫線 | 230・225 の 2 画素 | 同上 |
| DOM の枠線（変更履歴の枠・ツールバー・ヘッダーの下線） | 226 の 1 画素 | くっきり |
| 行見出しの幅・列見出しの高さ | 66 画素・30 画素（SDK は 52px・24px） | DPR 1.25 |

文字の色の付き方（暗い画素の R・G・B の差の平均）: canvas の文字 5.6（グレースケール）／DOM の灰色の文字 54〜62（ClearType の色付きのふち）。→ 論点4。

## 計測2: 広島 ① の再現（Playwright・headless Chromium 156.0.8078.4・viewport 1440×800）

canvas の配置（base・overlay とも同じ）:

| DPR | 左上（実画素） | 表示の大きさ（実画素） | バッキングストア |
|---|---|---|---|
| 1 | (17, 197.77) | 1406 × 550 | 1406 × 550 |
| 1.25 | (21.25, 247.21) | 1757.5 × 687.5 | 1758 × 688 |
| 1.5 | (25.5, 296.65) | 2109 × 825 | 2109 × 825 |

base canvas のビットマップ（toDataURL を白に合成）と page.screenshot の同じ範囲（本体の左 600×200 画素）を比べた:

| DPR | 平均差 | 文字の最も濃い画素（ビットマップ → 画面） | 罫線（ビットマップ → 画面） |
|---|---|---|---|
| 1 | 0.46 | 33.7 → 33.7 | 一致 |
| 1.25 | 7.14〜22.34（比べる範囲で変わる） | 33.7 → 79.9 | 212 → 219・241 |
| 1.5 | 5.15 | 33.7 → 33.7 ※ | 212 → 227・231 |

- DPR 1.25 の 212 → 219・241 は、0.25 画素ずれた双線形補間の値と一致する（212×0.75＋243×0.25＝219.75、212×0.25＋251×0.75＝241.25）。左上の x＝21.25 の端数そのもの
- DPR 1.5 の 212 → 227・231 は 0.5 画素ずれの補間（x＝25.5）
- ※ DPR 1.5 で最暗が変わらないのは、文字の線が 3 画素以上の太さになり中心の画素が濃いまま残るため。輪郭は同じようににじんでいる

## 計測3: 対照実験（PoC と無関係な最小ページ・DPR 1.25）

`position:absolute` の canvas に 13px の文字と device pixel へ snap した罫線を描き、位置と大きさだけを変えた:

| canvas の置き方 | 左上（実画素） | 表示 → バッキング | 平均差 | 文字の最暗 |
|---|---|---|---|---|
| 位置も大きさも整数 | (20, 20) | 1755 → 1755 | 0.00 | 42.3 → 42.3 |
| 位置だけ端数 | (21.25, 21.25) | 1755 → 1755 | 10.76 | 42.3 → 82.2 |
| 大きさだけ端数 | (20, 20) | 1757.5 → 1758 | 0.00 | 42.3 → 42.3 |
| 両方端数（PoC と同じ） | (21.25, 247.21) | 1757.5 → 1758 | 13.95 | 42.3 → 92.5 |

- **効いているのは位置**。大きさの端数（1757.5 の表示に 1758 のバッキング）は Chrome が吸収する
- 位置も大きさも整数なら平均差 0.00 で、page.screenshot による比べ方そのものは誤差を生まない

## 計測4: 起票時に試した補正（広島 ①・DPR 1.25。DevTools 相当の page.evaluate で style を書き換えた）

| 試したこと | 左上（実画素） | 結果 |
|---|---|---|
| そのまま | (21.25, 247.21) | にじむ（最暗 79.9） |
| canvas の `left`・`top` を端数ぶん動かす（−0.2px・−0.166px） | (21.016, 247.012) | **合成結果が全く変わらない**（画素値が完全に同じ） |
| canvas に `transform: translate(…)` で端数を打ち消す | (21.0, 247.0) | 横のにじみは消えた。縦に 0.25 画素ぶんの補間が残る（212 → 221・241）。最暗 61.1 |
| stage の大きさを「CSS × DPR が整数」に切り下げる（位置はそのまま） | (21.25, 247.21) | にじむ（最暗 85.7）。計測3と同じく大きさは主因でない |
| 大きさ切り下げ＋transform | (21.0, 247.0) | 縦の残りは同じ（最暗 63.5） |
| canvas の親をレイアウト（`position:relative`＋`left`・`top`）で動かし、CSS の 4px の倍数（実画素 5 の倍数）へ寄せる | (25, 250) | **罫線が縦横とも 1 画素に戻り、文字もほぼ一致**（平均差 1.98。残りは overlay の選択枠など） |

読み（仮説。Phase 0 で確かめる）:
- 1/64px 単位のレイアウトの端数（LayoutUnit）と、合成の段階の端数の扱いが一致していない。
  小さな `left`・`top` の変更は合成結果に届かず、transform は縦横で効き方が違った
- 「要素の位置が CSS で実画素のちょうど整数倍に乗る」形なら確実に一致する。補正量を 1/64px で表せる値にそろえる・transform と組み合わせる、などを Phase 0 で測る

## 付記

- canvas の位置は、大きさを変えずに動くことがある（広島 ① では、上に「同期サーバーとの接続が終わりました」の帯が出ると canvas が下へずれる）。ResizeObserver はこれを拾わない（論点2）
- DPR だけが変わる場合（別のモニターへの移動など）に ResizeObserver が発火するかは未確認（論点3）
- 計測は headless Chromium の deviceScaleFactor エミュレーション。実機の Chrome（GPU 合成）とは細部が違う可能性があるが、計測1の実機のスクリーンショットにも同じにじみ方（罫線が 2 画素に割れる）が出ている

## Phase 0 の追加調査（2026-10-13）

使用ブラウザーは本repoのPlaywright Chromium **149.0.7827.55**（起票時のChromium156とは別）。初回の修正前実測は [bug-report.md](bug-report.md) を参照。

DD-004当時の `f091a5e:apps/playground/poc-b.html` をDPR1.25/1376×850で再配置するとCanvas原点は CSS(13,141)、device(16.25,176.25)だった（[layout-research.json](layout-research.json)）。「当時の原点が整数だった」は裏付けられず、復元レイアウトでは反証された。当時の正確な動的配置は記録がないため確定できない。DD-004の目視1行にはbitmapとの画素比較がなく、今回の保証へ流用しない。

ResizeObserverはサイズを変えないDPR単独変更（CDPで1.25→1.5→2→1.25）では通知数が増えない。既存コードは拾えていなかったためrAFのDPR比較を採用した。

位置読みの追加コスト（120フレーム、既存描画ループのrect呼び出しを計測）: 静止平均0.0092ms、位置変更中平均0.0117ms、両方p95/max約0.1ms。どちらも120 reads/120 frames。これはheadless小規模fixtureの計測で、50k行の描画性能は既存全回帰の性能E2Eで別に確認する。

単純translateは静止時を直せても、後の移動で1画素の表示ずれを起こした。layout原点をviewport(0,0)へ相殺してから整数実画素へ移すと、移動後もbitmapの全画素が一致する。`pixelated` は描画済みの文字のAAを変えず、合成段階の再補間を抑えるために指定する。表示サイズも backing/DPR として1:1を保つ。

参照: [MDN devicePixelRatio](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)、[MDN image-rendering](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/image-rendering)。Modern Web Guidanceのsearch/retrieveも実施したが、この既存Canvasの原点補正に適用するガイドはなく、新しいCSSサイズ機能は採用していない。
