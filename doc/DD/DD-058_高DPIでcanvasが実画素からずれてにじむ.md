# DD-058: 高DPIでcanvasが実画素からずれてにじむ（consumer 駆動: 広島空港 H15）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-10-13 | 2026-10-13 | 検討中 | consumer 駆動（広島空港）。要件正本は広島 `doc/poc/sdk-requirements.md` H15。Human Spec Gate 前（論点1〜4） |

> アプローチ: バグ修正・フルパス（画面表示に影響し、直し方を Chrome の合成の挙動を測って決める必要があるため）
> エビデンス: 数値比較テーブル（canvas のビットマップ〔toDataURL〕と画面の画素の差）＋画面キャプチャ
> リスク: なし（認可・DBスキーマ・外部I/F・機密情報に触れない）
> 起票注記: 広島空港リポ（`C:/repo/hiroshima-airport`）のセッションから、ユーザーの指示で起票した（2026-10-13）

```text
Risk Class: B（描画の配置〔dom-scaffold の canvas の置き方・mount-controller の syncLayout〕だけを変える。IME 状態機械・textarea・focus・selection・protocol・永続化は変えない）
Risk Triggers: なし（位置の補正が textarea・選択枠・IME の座標計算〔R-02 座標ずれ〕に波及したら停止して A へ昇格）
Human Spec Gate: required（未。論点1〜4。consumer 起点で承認済みバックログの外のため）
Codex: medium（配置の補正のみ。A へ昇格したら xhigh を見直す）
Manual Gate: 実機の Chrome（GPU 合成）・Windows の表示スケール 125% で、広島 PoC の入力画面の罫線が 1 画素・文字がにじまないことを目視（正味5分。クローズはブロックしない）
External Review: なし
Evidence Level: standard
```

## 目的

devicePixelRatio が整数でない環境（Windows の表示スケール 125%・150%、ブラウザの拡大率）で、グリッドの canvas を**実画素の格子にそろえて表示**し、文字と罫線をにじませない。
consumer がグリッドをページのどこに置いても（左上が実画素の端数の位置に来ても）、周りの DOM と同じくっきりさで見えるようにする。

## 概要

| Bug# | 概要 | 重要度 |
|------|------|--------|
| 001 | DPR 1.25 で、canvas の左上が実画素の端数の位置に来ると、Chrome がビットマップを補間して合成し、セルの文字・罫線が全面で 2 画素ににじむ | MEDIUM |

- 発見の経緯: 広島 PoC の入力画面（①。alpha.13）を実機で見たユーザーが「Excel ライクな部分だけぼやけて見える」と指摘した（2026-10-13）。
  スクリーンショットでは、canvas の罫線は 2 画素に割れて薄く（230・224）、周りの DOM の枠線は 1 画素でくっきりしていた。
  行見出し 66 画素（`HEADER_WIDTH` 52px）・列見出し 30 画素（`HEADER_HEIGHT` 24px）から DPR 1.25
- consumer の影響: 10/22 の商談のデモで、表の部分だけがぼやけて見える。先方の PC も 125% の可能性が高い
- consumer のつなぎ: Chrome の拡大率を 80% にする（125% × 80% で DPR 1.0）か、表示スケール 100% の PC で見せる
- DD-004 の計測（DPR 1.25）では「1px 罫線がにじまない」と記録している（`doc/archived/DD/DD-004/measurement-report.md`）。
  playground では canvas の左上がたまたま実画素の整数位置にあったためと見られる（未確認。Phase 0 で確かめる）

## 原因分析

§12.4 の高DPI対応（バッキングストア＝CSS サイズ × DPR、罫線は device pixel へ snap）は、**canvas の左上が device pixel の格子に乗っている**ことを暗に前提にしている。
ところが canvas は stage の (0,0) に置くだけ（`dom-scaffold.ts`）で、stage がページ上のどこに来るかは consumer のレイアウトで決まる。
広島 ① では canvas の左上が CSS (17, 197.77) ＝ 実画素 (21.25, 247.21) になり、Chrome はビットマップをその端数の位置へ補間して合成する。
canvas の中で罫線を device pixel へ snap しても、合成の段階で全画素が隣の画素へ混ざる。

> 詳細（計測値・対照実験・起票時に試した補正）: [cause-analysis.md](DD-058/cause-analysis.md)

## 修正方針

stage のページ上の位置を測り、canvas の左上を device pixel の格子にそろえる。補正の量は 1 device pixel 未満。
ただし、起票時に試した範囲では**補正の当て方で Chrome の結果が変わる**（下の論点1）。Phase 0 で候補を測ってから決める。

### 検討内容（Human Spec Gate）

| # | 論点 | 選択肢 | 推奨と理由（起票時の仮説） |
|---|------|--------|------------------------|
| 1 | 位置をそろえる方法 | (a) canvas に `transform: translate(-端数)` を当てる ／ (b) canvas の `left`・`top` を端数ぶん動かす ／ (c) canvas を包む要素をもう1つ挟み、それを動かす ／ (d) その他（Phase 0 で見つかったもの） | **Phase 0 の計測で決める**。起票時の試し（広島 ①・headless Chromium 156・DPR 1.25）: (b) −0.2px は合成結果が全く変わらなかった。(a) は横のにじみが消えたが、縦に 0.25 画素ぶん残った。canvas の親をレイアウトで動かして実画素 (25, 250) に置くと一致した（平均差 1.98）。決める基準は「受け入れ基準 1〜3 を DPR 1.25・1.5・1.75 で満たし、textarea・選択枠とずれない」 |
| 2 | そろえ直す契機 | (a) 描画ループで毎フレーム stage の位置を読み、端数が変わったときだけそろえ直す ／ (b) consumer に「配置が変わった」を知らせる API を出し、consumer が呼ぶ ／ (c) (a)＋(b) | **(a)**。大きさを変えずに位置だけが動く場面（上に帯が出る・フォントの読み込みで行の高さが変わる）を ResizeObserver は拾わず、consumer もすべては把握できない。読むのは `getBoundingClientRect` 1回で、端数が同じなら何もしない。レイアウトの強制が描画の時間に響かないかを Phase 0 で測る |
| 3 | DPR だけが変わったときの検知 | (a) 本DDに含める：CSS サイズが変わらずに DPR だけが変わる場合（別のモニターへの移動など）にも、バッキングストアを確保し直す（`matchMedia('(resolution: …dppx)')` の change など） ／ (b) 別DD | **(a)、ただし現状で拾えていなければ**。今は ResizeObserver（stage の大きさ）だけで syncLayout を呼んでいる。拾えていないかどうかは起票時に未確認。§12.4「DPR変更、画面移動…を監視する」の範囲で、同じ syncLayout に入るため |
| 4 | canvas の文字の描き方の差 | (a) 対象外：canvas の文字はグレースケールのアンチエイリアス、DOM の文字は ClearType（色付きのサブピクセル）で、位置をそろえても少し細く淡く見える差は残る ／ (b) base canvas を不透明（`getContext('2d', { alpha: false })`）にして、Chrome の LCD 文字を試す | **(a)**。にじみの主因は位置で、こちらは見え方の好みの差に近い。(b) は stage の背景が透けている所がないかの確認と実機での比較が要るので、要るなら別DD |

## 対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `packages/grid/src/mount-controller.ts` | `syncLayout()`（L878〜）と論点2の契機で、stage の位置の端数から canvas の補正量を求めて当てる。論点3を採れば DPR の変化の検知を足す（L1765〜 の ResizeObserver の隣） |
| `packages/grid/src/dom-scaffold.ts` | 論点1の結論によっては canvas の置き方（L36〜43）を変える |
| `packages/render/src/dpi.ts` | 補正量の計算を純関数で足す（DOM 非依存。unit を先に書く） |
| `apps/playground/e2e/`（新規） | 受け入れ基準 1〜4 の E2E |
| `doc/plan/nanairo_realtime_spreadsheet_development_plan_v1.md` §12.4 | 「canvas の左上を device pixel の格子にそろえる」を足す |

## 受け入れ基準

（起票時の案。Human Spec Gate で確定する）

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | DPR 1.25 で、stage の左上が実画素の端数の位置に来るページ（例: CSS 17px・197.77px）→ base canvas のビットマップ（toDataURL）と画面の画素が一致する（平均差 ≤ 1、罫線が 1 画素） | playground E2E（deviceScaleFactor 1.25。overlay canvas を隠して base だけを比べる） |
| 2 | 同じページで DPR 1.5・1.75 でも 1 と同じ | 同 E2E のパラメータ |
| 3 | DPR 1・2 では今と同じ（一致を保つ） | 同 E2E のパラメータ |
| 4 | stage の大きさを変えずに位置だけを動かす（上に要素を出し入れする）→ 次の描画で 1 の一致に戻る | E2E |
| 5 | 選択枠・セル編集の textarea・プレゼンス・選択式のドロップダウンの位置が、canvas の内容とずれない | 既存の unit・E2E を変えずに green |
| 6 | （論点3で (a) を採った場合）CSS サイズを変えずに DPR だけが変わる → バッキングストアを確保し直し、1 の一致に戻る | unit（DPR の変化を差し替えて syncLayout が走ること） |

比べ方の妥当性: headless Chromium の page.screenshot は、canvas が実画素の整数位置にあればビットマップと完全に一致した（平均差 0.00。cause-analysis の対照実験）。比べ方そのものが誤差を生まないことは確認済み。

## タスク一覧

### Phase 0: 調査・再現確認・修正前エビデンス

**調査:**
- [ ] playground で、DD-004 の計測時に canvas が実画素の整数位置にあったかを確かめる（にじみを見逃した理由）
- [ ] DPR だけが変わったときに ResizeObserver が発火するかを確かめる（論点3）
- [ ] 原因分析を添付 `DD-058/cause-analysis.md` に追記する（起票時の計測は記載済み）

**再現確認・修正前エビデンス:**
- [ ] playground に、stage を実画素の端数の位置に置く再現ページ（または E2E のフィクスチャ）を作る
- [ ] 📸 修正前エビデンス: DPR 1・1.25・1.5 で、ビットマップと画面の差・罫線の画素・拡大キャプチャ（`DD-058/`）
- [ ] 論点1の候補（(a)〜(d)）を測り、論点2の毎フレームの位置読みの描画時間への影響を測る
- [ ] 📝 バグレポート作成（`DD-058/bug-report.md`）
- [ ] 👀 **ユーザーレビュー** — 再現・原因・論点1〜4 の合意（Human Spec Gate）

### Phase 1: コード修正・テスト

- [ ] `packages/render/src/dpi.ts`: 補正量の計算（unit を先に書く）
- [ ] `packages/grid/src/mount-controller.ts`: syncLayout と論点2の契機で補正を当てる。論点3を採れば DPR の変化の検知
- [ ] 同根パターンの横展開確認（overlay canvas と、他に canvas を置いている所がないか grep で確認）
- [ ] playground E2E に受け入れ基準 1〜4（と 6 の unit）を足す
- [ ] 🔬 **機械検証**: unit・型検査・playground E2E → 全パス

### Phase 2: 修正後エビデンス・配布

- [ ] 📸 修正後エビデンス（Phase 0 と同じ手段で）・`DD-058/verification.md`（Before/After）
- [ ] 計画書 §12.4 の同期、CHANGELOG・公開 JSDoc（挙動の記述があれば）。機能カタログ（`apps/showcase/src/features.json`）は該当すれば
- [ ] alpha を切って広島へ引き渡す（広島 `doc/poc/sdk-requirements.md` H15 の「取り込み結果」は広島側が書く）
- [ ] 🔬 機械検証: 配布物の manifest（生成元・`closureDirty=false`）

### 完了前チェック
- [ ] 受け入れ基準を1項目ずつ照合（未達成があれば理由をログへ）
- [ ] 😈 セルフレビュー1巡（「どこが壊れるか」を探す。読み返す価値のある所見のみログへ。深掘りが要る場合の手法: doc/da-method.md）
- [ ] 🔬 全回帰1回（precheck 等の集約コマンド → 全パス）

## エビデンス配置

```
doc/DD/DD-058/
  cause-analysis.md      # 原因分析（起票時の計測・対照実験を含む）
  bug-report.md          # 修正前の再現（Phase 0）
  verification.md        # 修正後の検証（Phase 2）
  bug001-before-*.png    # 修正前キャプチャ
  bug001-after-*.png     # 修正後キャプチャ
```

## ログ

### 2026-10-13
- DD作成（広島空港リポのセッションから、ユーザーの指示で起票。要件 H15）。起票時の計測・対照実験は `DD-058/cause-analysis.md`
- 時期: consumer の希望は H14 と同じく 2026-10-19 頃までに alpha（商談は 10/22）。間に合わなければ consumer はつなぎ（拡大率 80%）で見せる
