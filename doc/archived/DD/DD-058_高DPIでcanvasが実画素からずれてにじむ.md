# DD-058: 高DPIでcanvasが実画素からずれてにじむ（consumer 駆動: 広島空港 H15）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-10-13 | 2026-10-14 | 完了 | 高DPI画素一致・位置/DPR追従・自己レビュー・alpha.14配布。実機125%と広島取り込みは未保証境界へ |

> アプローチ: バグ修正・フルパス（画面表示に影響し、直し方を Chrome の合成の挙動を測って決める必要があるため）
> エビデンス: 数値比較テーブル（canvas のビットマップ〔toDataURL〕と画面の画素の差）＋画面キャプチャ
> リスク: なし（認可・DBスキーマ・外部I/F・機密情報に触れない）
> 起票注記: 広島空港リポ（`C:/repo/hiroshima-airport`）のセッションから、ユーザーの指示で起票した（2026-10-13）

```text
Risk Class: B（描画の配置〔dom-scaffold の canvas の置き方・mount-controller の syncLayout〕だけを変える。IME 状態機械・textarea・focus・selection・protocol・永続化は変えない）
Risk Triggers: なし（位置の補正が textarea・選択枠・IME の座標計算〔R-02 座標ずれ〕に波及したら停止して A へ昇格）
Human Spec Gate: passed（2026-10-13: ユーザーが開始と推奨案での決定を承認。論点1は実測で確定、2=(a)、3=(a)、4=(a)）
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
| `packages/grid/src/canvas-layout.ts` / `.test.ts` | rAFの位置/DPR検知・原点相殺・同位置でのCSS更新抑止。純関数のoffsetを使う内部controllerとそのunit |
| `packages/render/src/dpi.ts` | 補正量の計算を純関数で足す（DOM 非依存。unit を先に書く） |
| `apps/playground/e2e/`（新規） | 受け入れ基準 1〜4 の E2E |
| `doc/plan/nanairo_realtime_spreadsheet_development_plan_v1.md` §12.4 | 「canvas の左上を device pixel の格子にそろえる」を足す |

## 受け入れ基準

（推奨案での決定をユーザーから委任され確定。検証の丸め許容と追加条件は決定事項を参照）

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | DPR 1.25 で、stage の左上が実画素の端数の位置に来るページ（例: CSS 17px・197.77px）→ base canvas のビットマップ（toDataURL）と画面の画素が一致する（平均差 ≤ 1、罫線が 1 画素） | playground E2E（deviceScaleFactor 1.25。overlay canvas を隠して base だけを比べる） |
| 2 | 同じページで DPR 1.5・1.75 でも 1 と同じ | 同 E2E のパラメータ |
| 3 | DPR 1・2 では今と同じ（一致を保つ） | 同 E2E のパラメータ |
| 4 | stage の大きさを変えずに位置だけを動かす（上に要素を出し入れする）→ 次の描画で 1 の一致に戻る | E2E |
| 5 | 選択枠・セル編集の textarea・プレゼンス・選択式のドロップダウンの位置が、canvas の内容とずれない | 既存の unit・E2E を変えずに green |
| 6 | （論点3で (a) を採った場合）CSS サイズを変えずに DPR だけが変わる → バッキングストアを確保し直し、1 の一致に戻る | unit（DPR の変化を差し替えて syncLayout が走ること） |

比べ方の妥当性: headless Chromium の page.screenshot は、canvas が実画素の整数位置にあればビットマップと完全に一致した（平均差 0.00。cause-analysis の対照実験）。比べ方そのものが誤差を生まないことは確認済み。

## 決定事項（2026-10-13）

- 論点1: (d)。canvas の `left/top` で stage の viewport 原点を相殺し、一度 (0,0) を描画原点にしてから最寄りの実画素へ `translate`。`image-rendering: pixelated` と backing/DPR の表示サイズを併用する。単純 translate は静止時に一致しても位置移動後に1画素ずれる場合があり不採用。実際の移動量は最大0.5 device px。base/overlay 共通、stage/textarea/ヒットテストの論理座標は変更しないため Risk B の範囲を維持する。
- 論点2: (a)。既存 rAF の先頭で rect を1回読み、原点が同じなら DOM を更新しない。整数 px の移動でも相殺を更新する。追加の consumer API・監視リスナー・rAF は不要。
- 論点3: (a)。同じ rAF で normalized DPR の変化を検知し `syncLayout()` を実行する。ResizeObserver は DPR 単独変更を通知しないことを実ブラウザーE2Eで確認した。
- 論点4: (a)。透明 Canvas 2D と文字 AA は維持する。CSS の合成指定は bitmap の文字の描き方を変更しない。
- AC1〜4 は平均差 ≤1 に加え、各画素の最大差 ≤2、原点誤差 <0.0001 device px を E2E で検証する。AC5 の「ずれない」は base/overlay が一致し、DOM の共通論理座標に対する Canvas の移動が最大0.5 device px（丸めの範囲）であることと既存回帰の green で確認する。
- §12.4・CHANGELOG・機能カタログを同期し、公開API版は維持、package版は alpha.14 とする。配布 tarball を作成して広島の取り込み用記録を残す。

## タスク一覧

### Phase 0: 調査・再現確認・修正前エビデンス

**調査:**
- [x] playground で、DD-004 の計測時に canvas が実画素の整数位置にあったかを確かめる（にじみを見逃した理由）
- [x] DPR だけが変わったときに ResizeObserver が発火するかを確かめる（論点3）
- [x] 原因分析を添付 `DD-058/cause-analysis.md` に追記する（起票時の計測は記載済み）

**再現確認・修正前エビデンス:**
- [x] playground に、stage を実画素の端数の位置に置く再現ページ（または E2E のフィクスチャ）を作る
- [x] 📸 修正前エビデンス: DPR 1・1.25・1.5 で、ビットマップと画面の差・罫線の画素・拡大キャプチャ（`DD-058/`）
- [x] 論点1の候補（(a)〜(d)）を測り、論点2の毎フレームの位置読みの描画時間への影響を測る
- [x] 📝 バグレポート作成（`DD-058/bug-report.md`）
- [x] 👀 **ユーザーレビュー** — 推奨案決定の委任で通過（2026-10-13）。実測により論点1〜4を確定

### Phase 1: コード修正・テスト

- [x] `packages/render/src/dpi.ts`: 補正量の計算（unit を先に書く）
- [x] `packages/grid/src/mount-controller.ts`: syncLayout と論点2の契機で補正を当てる。論点3を採れば DPR の変化の検知
- [x] 同根パターンの横展開確認（overlay canvas と、他に canvas を置いている所がないか grep で確認）
- [x] playground E2E に受け入れ基準 1〜4（と 6 の unit）を足す
- [x] 🔬 **機械検証**: unit・型検査・playground E2E → 全パス

### Phase 2: 修正後エビデンス・配布

- [x] 📸 修正後エビデンス（Phase 0 と同じ手段で）・`DD-058/verification.md`（Before/After）
- [x] 計画書 §12.4 の同期、CHANGELOG・公開 JSDoc（挙動の記述があれば）。機能カタログ（`apps/showcase/src/features.json`）は該当すれば
- [x] alpha を切って広島へ引き渡す（広島 `doc/poc/sdk-requirements.md` H15 の「取り込み結果」は広島側が書く）
- [x] 🔬 機械検証: 配布物の manifest（生成元・`closureDirty=false`）

### 完了前チェック
- [x] 受け入れ基準を1項目ずつ照合（未達成があれば理由をログへ）
- [x] 😈 セルフレビュー1巡（「どこが壊れるか」を探す。読み返す価値のある所見のみログへ。深掘りが要る場合の手法: doc/da-method.md）
- [x] 🔬 全回帰1回（unit/typecheck/lint/build/E2E。起動待ち競合1件は対象15件の再実行で全パス）

## エビデンス配置

```
doc/DD/DD-058/
  cause-analysis.md      # 原因分析（起票時の計測・対照実験を含む）
  bug-report.md          # 修正前の再現（Phase 0）
  verification.md        # 修正後の検証（Phase 2）
  self-review.md         # 実装後の自己レビューと所見の処置
  handoff.md             # alpha.14 の生成元・consumer検証・広島取り込み手順
  phase0.json / layout-research.json  # 方式比較・位置読み性能・旧レイアウトの復元
  bug001-before-*.png    # 修正前キャプチャ
  bug001-after-*.png     # 修正後キャプチャ
```

## ログ

### 2026-10-14
- 完了。論点1=(d)原点相殺＋translate＋pixelated、2=(a)既存rAFで位置検知、3=(a)DPR単独変更を含める、4=(a)Canvas文字AAを維持。Risk B の範囲内で完走。
- 修正前・方式比較・4倍拡大キャプチャを保存。DPR1/1.25/1.5/1.75/2、位置だけの移動・整数px移動・DPR単独変更すべて平均/最大画素差0。AC1〜6を照合済み。DPR純関数はunitを先に追加し、6件red→実装後greenを確認。
- unit/invariants/contract 1457件、typecheck、consumer-strict、lint/boundary、buildはgreen。全playground初回は258/259greenで、既存openClientのAPI公開前snapshotによる起動待ち競合が1件。対象row-operations15件を変更なしで再実行して全green、最終DPI6件も全green。初回全件一発greenとは記録しない。
- 自己レビュー1巡: 整数px移動での相殺更新、平均差だけでは見逃す補間、空bitmapによる偽陽性を回帰試験で補強。最終差分に未対応の重大所見なし。`DD-058/self-review.md`・`verification.md`を参照。
- 実装コミット `f1a97c7`。alpha.14を同コミットから生成（manifest `closureDirty=false`）。10 tarballのSHA/版/pack内容を照合し、配布tarballの独立consumer-app E2E10件・typecheck/build/lifecycle、consumer-harnessもgreen。12 entriesのZIPを作成し全entryが元ファイルと同一であることを確認。広島H15向け `DD-058/handoff.md` を用意した。
- Manual Gateは下記へ移送し、通常のバグ修正DDとして完了・添付フォルダごとアーカイブする。§12.4・CHANGELOG・機能カタログを同期。公開JSDocの挙動保証は既存のままで追記不要、公開API/IME/protocol/schema変更なし。

### 2026-10-13
- 開始指示と「推奨案で決めてよい」「実装後に自己レビュー」を受領。Human Spec Gate 通過。論点1は AC の画素比較で決定、2は毎フレーム検知、3は DPR 単独変更を含める、4は文字 AA 方式を維持する。
- DD作成（広島空港リポのセッションから、ユーザーの指示で起票。要件 H15）。起票時の計測・対照実験は `DD-058/cause-analysis.md`
- 時期: consumer の希望は H14 と同じく 2026-10-19 頃までに alpha（商談は 10/22）。間に合わなければ consumer はつなぎ（拡大率 80%）で見せる

## 既知の未保証境界

- 実機Chrome/GPU合成・Windows表示スケール125%の目視、広島PoCの取り込み/実入力画面/商談受入は未実施（広島H15の取り込み確認へ引き継ぐ）。CanvasとDOMの文字AA差は対象外。push/registry publishは未実施。

