# DD-036 C5 計測記録（382 列 × 80 行・AC9）

> ③納入計画の実寸（ラベル 5 列＋日付 365＋月計 12 ≒ **382 列** × 約 80 行）で、列数依存の経路が予算内かを実測した。
> DD-004 の実測域は 50,000 行 × **200 列**で、③は**列数が約 1.9 倍**（行数は大幅に小さい）。

## 1. 計測ハーネス（AC9 の記載訂正）

DD 起票時の AC9 は「DD-004 ハーネスで計測し `kpi-ledger.md` へ記録」としていたが、実装時に次の 2 点を訂正した:

- **DD-004 のハーネス（`poc-b.html`）は DD-016 で削除済み**（PoC ページの整理）。現行の性能計測は
  **headed 可能な Playwright spec**（先例: `apps/playground/e2e/zz-paste-perf.spec.ts`＝DD-020 AC11）が定石のため、
  同形式で `apps/playground/e2e/zz-wide-grid-perf.spec.ts` を新設した。
- **記録先は `kpi-ledger.md` ではなく本ファイル**。`kpi-ledger.md` は憲章 §16.1 の **consumer 統合 KPI（KPI-1〜8）専用の
  常設台帳**で、契約表に無い行の追記は台帳の契約（§4-1 遡及変更禁止・§4-5 正本の一意化）に反する。描画性能の記録は
  DD 添付が先例（DD-004 `measurement-report.md`・DD-012-2 `perf-judge-result.json`）。

## 2. 条件

| 項目 | 値 |
|---|---|
| ページ | `standalone.html?extracols=378&frozencols=5&frozenrows=1`（単独モード） |
| 論理表 | **382 列 × 80 行**（固定 5 列・固定 1 行） |
| 非空セル | **30,560**（全セル埋め。先頭 5 列は文字列ラベル・以降は数値） |
| viewport | 1280 × 800（可視セル ≒ 15 列 × 35 行＋overscan） |
| 計測環境 | Windows 11 / Chromium（Playwright）・本機 |
| 生データ | `test-results/dd-evidence/DD-036/wide-grid-perf.json`（spec 実行のたびに上書き） |

再現コマンド:

```bash
npx playwright test --config apps/playground/playwright.config.ts wide-grid-perf --headed
```

## 3. 実測値（2026-09-03）

| 項目 | 目標（計画書 §21 / DD-004 §18.2） | headed | headless | 判定 |
|---|---|---|---|---|
| ① 初回描画（setData → 全行が描かれた最初のフレーム。列 Axis 構築＋初回 draw を含む） | 1,000ms 未満（本DDで設定した予算） | **255.9ms** | 77.6ms | pass |
| ② 横スクロール frame p95（rAF ごとに scrollLeft を 40px 送る往復・2 秒・119 フレーム） | **33ms 未満**（§18.2 AC1） | **16.8ms**（p50 16.7 / worst 16.9） | 16.8ms | pass |
| ③ 入力確定（常駐 textarea の確定 dispatch＝同期 submit 経路） | 50ms 未満（§18.2 AC3 相当） | **0.5ms** | 0.3ms | pass |

- **フレーム間隔は 16.7〜16.9ms に張り付いており（60fps の vsync 間隔）、382 列でも描画がフレーム予算を使い切っていない**。
  列数依存の経路（列 Axis の prefix sum・列ヘッダー描画・pane ごとの列走査・DD-036 の静的列背景バンド）は、
  この規模では律速になっていない。
- 初回描画の headed/headless 差（256ms vs 78ms）は実ウィンドウの合成・GPU 経路ぶん。**judgment には headed を採る**
  （DD-004 §18.2 の「headed 実ウィンドウ」規約に合わせる）。
- 本計測は単独モード（共同編集の WS 往復を含まない）。共同編集での同規模計測は③の共同編集化（松下 DD-014 段3）で
  必要になったときに実施する＝**本DDの未保証境界**。

## 4. 所見（consumer への含意）

- 382 列は現行実装のまま実用域。列数のさらなる増加（例: 複数年＝700 列超）でも p95 は余裕があるが未計測。
- 非空 3 万セルは DD-004 の 50 万セル実測に対し十分小さく、メモリ・チャンクストア側の懸念はない（10 分メモリ計測は
  本DDでは実施していない＝規模が DD-004 の実測域内に収まるため）。
