# DD-036: 固定列・列背景・行readOnly（consumer 駆動: 松下 納入計画）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-03 | 2026-09-03 | 完了 | 松下 DD-014（納入計画のSpreadJS化）からの持ち込み。契約=`DD-036/contract.md`・計測=`DD-036/measurement.md`。Codex high の P2×4 を全反映。Manual Gate T1/M1 は未実施＝既知の未保証境界へ移送 |

> アプローチ: 標準＋TDD（純関数: 静的列背景の解決・行 readOnly 裁定）＋E2E駆動（配線: Playwright ハーネス）。要件は consumer 実案件で実測済み（guides.md §1）

```text
Risk Class: A（公開 API 新設〔frozenColumnCount・columnBackgrounds・readOnlyRows・GridInstance/React handle の scrollToColumn〕・C3 が editor 経路に接する＝DD-035 R4 と同型）
Risk Triggers: 公開 API/Options の新設／C3 行単位 readOnly が編集開始・確定経路に接する（常駐 textarea の行ロック分岐＝DD-035 R4 と同型ゆえ T1 該当。editor-state-machine・ime-editing-session は無改変で成立するかを📐で確定）／C1 が固定 pane 数（現在ハードコード 1）を可変化＝座標変換・ヒットテスト・editor-placement・scroll-anchor の全経路に波及
Human Spec Gate: required（consumer 側の業務要件は松下 DD-014 で確定済みだが、SDK の公開 API 面は未決＝論点 1〜6）
Codex: high（実装完了後にユーザー指示で CLI 実行・findings は妥当性判断のうえ反映）
Manual Gate: あり・クローズ非ブロック（T1=実IME 台帳 5 点＋readOnly 行セルで IME 起動不可／M1=固定 5 列＋網掛けの実機での見え方・横スクロール追従）。未実施なら「既知の未保証境界」へ移送
External Review: なし
Evidence Level: full（A 区分。E2E スクショ証跡・既知の未保証境界を省略しない）
```

## 目的

consumer 統合①（松下）の 2 画面目 = **管理表③ 納入計画**が要求する、マトリクス型シート（列＝日付・約 382 列 × 行＝約 80）の表示制御を SDK 側で提供する:

- **C1 固定列数の指定**: 先頭 n 列を横スクロール時に固定（③は左端のラベル 5 列）
- **C2 列単位の静的背景色**: 値によらない列色（③は非稼働日＝土日祝の網掛け）
- **C3 行単位 readOnly**: 指定行の編集開始を拒否し、範囲貼り付けはその行をスキップ（③は在庫行＝サーバー算出・見出し行）
- **C4 scrollToColumn**: 列方向の可視化命令（③の「今日へジャンプ」）

①（固定列 × 可変行）に対し③は**縦横が逆**のマトリクスで、SDK が行方向にだけ持っている機能（readOnly・scroll 命令）を列方向へ、列方向にだけ持っている機能（固定 pane・書式）を実用的な粒度へ揃える DD にあたる。

## 背景・課題

- consumer 統合①（松下・DD-026）は①生産納期で共同編集まで到達し（松下 DD-012-2）、残りの SDK ギャップは DD-035 で解消した。松下は続けて**③納入計画**を SpreadJS 化する（松下 DD-014 親 / DD-014-1 実装 / DD-014-2 が本DDの成果を受け取る）
- 要件の詳細・優先度・consumer 側で確認することは**松下リポ `doc/DD/DD-014/sdk-requirements.md` §C が正本**（C1・C2＝高 / C3・C4・C5＝中 / C6＝低）。乖離したらメモ側が勝つ（DD-035 と同じ運用）
- 松下 DD-014-1 は**現SDKの範囲だけで実装**し（columnOrder / initialData / setData / onEvent）、本DDの対象機能は「退行・保留」として出荷する。したがって**本DDと松下 DD-014-1 は並行して進められる**。本DDの成果は松下 DD-014-2 が tarball 更新で受け取る
- ③の実寸: ラベル 5 列＋年度の日付列 約 365＋月計列 12 ≒ **382 列 × 約 80 行**（非空 3〜4 万セル）

### 現状の実測（2026-09-03・本リポのコードを実読）

| # | 要件 | 現状 | 距離 |
|---|------|------|------|
| C1 | 固定列数 | **`mount-controller.ts:127-128` で `frozenRowCount = 1` / `frozenColCount = 1` がハードコード**。4 象限 pane・`ViewportTransform`・`editor-placement`・`scroll-anchor`・base-layer のオーバーフロー停止条件は、いずれも**任意の固定数で動く設計**（DD-004） | **小**。定数を公開オプションへ開けて検証を足す作業。ただし「1 固定」を暗黙前提にしたコードが他に無いかの📐が要る |
| C2 | 列単位の静的背景色 | `columnFormats`（DD-027-3）は**値ベース・表示文字列の完全一致・非空セルのみ**。`format-rules.ts` の設計方針コメントに「列全体の静的背景色（値によらない列色）は v1 対象外」「同経路で追加する」と拡張点が明記されている | **中**。空セルも塗る＝描画経路が値ベース書式と別（非空セルのみの前提を崩さずに足す） |
| C3 | 行単位 readOnly | `readOnlyColumns`（DD-035 R4）が 2 層抑止（keydown 入口＋submit chokepoint）＋常駐 textarea の列ロックで成立済み。**行版は無い** | **中**。抑止の型は流用できるが、**行 ID は動的**（insertRows/deleteRows/tombstone/setData 再注入）で、`columnOrder` で mount 時に確定する列とは**検証タイミングが違う**＝論点 3 |
| C4 | scrollToColumn | `scrollToRow` は `ensureCellVisible({ row, col: 0 })` で**意図的に横を動かさない**実装（`mount-controller.ts:410-421`）。`ensureCellVisible` 自体は両軸を扱う | **小**。対称に列版を足す。構造 dirty 中の保留キュー（DD-035 R6）もそのまま共有できる |
| C5 | 年グリッド規模の実測 | `viewport.ts` は列方向も `PaneRange.cols` で仮想化済み。DD-004 の実測は **50,000 行 × 200 列**（`measurement-spec.md` §論理表） | **測定のみ**。③は約 382 列＝**測定域の約 1.9 倍の列数**・行数は大幅に小さい。確認は列数依存（列ヘッダー描画・Axis prefix sum・columnOrder 由来の Map 群）に絞れる |
| C6 | セル内リンク | **DD-027-2 のリンク列（`link-open` イベント）で提供済み**。§C の代替案「アクティブセル変更イベント」は DD-035 で不要判定 | **対象外**。consumer 側の適用課題として松下 DD-014-2 へ差し戻す |

- **§C メモとの乖離 1 件**: メモは C1 の現状を「なし。横スクロールで全列が流れる」としているが、実際は**先頭 1 列が既に固定されている**（ハードコード）。要件の実体は「無い機能の新設」ではなく「**固定数を 1 から n へ可変化する**」。松下側メモは本DD起票時に訂正済み
- 対象外: C6（提供済み）/ 共同編集サーバー側の行権限（`readOnlyColumns` と同じく権限制御ではない）/ 固定行列の**文書状態化・全ユーザー共有**（論点 1 で v1 スコープ外と整理・`cell-format-sharing-design.md` の経路でまとめて扱う）/ ③の共同編集化に要る §A U4（複数文書）は松下 DD-014 段3 の起票時に改めて持ち込む

## 検討内容（Human Spec Gate: required — spreadjs 側セッションで確定する）

| # | 論点 | 選択肢 | 推奨と理由（**未確定**） |
|---|------|-------|----------------------|
| 1 | C1 の公開面と共有範囲 | (a) mount オプション `frozenColumnCount` / `frozenRowCount`（view-local） / (b) 文書状態にして全ユーザー共有（Operation 化・snapshot 拡張） | **(a)**。開発計画書 §609 は「固定行列は原則**文書状態候補**」だが、DD-027-3 の書式が v1 を view-local にして共有化を `cell-format-sharing-design.md` へ切り出した先例と揃える。共有化は列幅・行高・書式とまとめて 1 回で扱うべきで、本DDで単独に文書状態を増やすと後で二重移行になる。**行側も対称に開ける**（既定は現行の 1＝後方互換） |
| 2 | C2 の API 面 | (a) 独立オプション `columnBackgrounds: Record<ColumnId, string>` / (b) `columnFormats` に「値によらない」ルール種を足す（`match: '*'` 等） | **(a)**。format-rules は「**非空セルのみ・値ベース**」を設計の芯にしており（プリコンパイル済み Map で O(1) lookup）、空セルを塗る要件はそこへ混ぜると芯が濁る。優先順位は「値ベース書式 > 静的列背景」と定義し、静的側は base-layer の**セル背景の既定値**として解決する |
| 3 | C3 の行 ID をいつ検証するか | (a) mount オプション `readOnlyRows: string[]`＝mount 固定・未知 ID は **warn**（fail-fast にしない） / (b) `setData` の `GridStandaloneData` に載せて再注入のたびに更新 / (c) handle に `setReadOnlyRows()` を足す | **(a) を v1**。③は行の追加・削除が対象外（松下 DD-014-1 決定）で mount 固定で足りる。ただし列（`columnOrder` で mount 時に全 ID が既知）と違い**行は初期データ到着前に検証できない**ため、`readOnlyColumns` の fail-fast（`column-types-invalid`）と**同じ扱いにはできない**＝未知行は診断 warn に留める。(b)(c) は行の動的化要求が実案件で出たときの拡張点 |
| 4 | C4 の公開面 | grid `GridInstance.scrollToColumn(columnId)` ＋ React handle へ直結（DD-035 R6 と対称） | **採用**。`ensureCellVisible({ row: <固定行の次>, col })` を使い**縦は動かさない**（`scrollToRow` の鏡像）。保留キュー・未知 ID の warn・最小スクロール（可視なら動かさない）も R6 と同仕様に揃える |
| 5 | C5 の測り方 | (a) 既存 DD-004 ハーネスの列数を 382 まで振って計測 / (b) showcase に③相当のデモを足して計測 | **(a)**。KPI 契約（`kpi-ledger.md`・DD-029-1）の記録先が既にあり、比較可能な数字になる。(b) は features カタログの更新（Phase 5）とは別問題で、デモ追加は要求が出てから |
| 6 | 子DD分割 | 分割 / 単一DD | **単一DD・5 Phase**（DD-035 と同じ）。レビューゲートは完了後の Codex 1 回のみ（guides §6「1 レビューサイクル＝1 DD」）。C1/C4 は座標系、C2 は描画、C3 は editor 経路と**触る層が分かれている**ので Phase で切れば足りる |

## 決定事項

Phase 1（2026-09-03・ユーザー指示「DD-036 を進める・完了したら Codex レビュー」に基づき推奨案で代行確定）。公開面の詳細契約は `DD-036/contract.md`（DD-035 の前例）。

- **①C1 の公開面**: mount オプション `frozenColumnCount` / `frozenRowCount`（**view-local**・既定 1＝現行と完全一致）。文書状態化・全ユーザー共有は `cell-format-sharing-design.md` の共有化スコープへ送る
- **②C2 の API 面**: 独立オプション `columnBackgrounds: Record<ColumnId, string>`（`columnFormats` には混ぜない）。**値ベース書式 > 静的列背景**。静的側は pane 背景の直後・罫線描画の**前**に列バンドを塗る＝空セルも塗られ罫線は上に乗る
- **③C3 の行 ID 検証**: `readOnlyRows: string[]`＝**mount 固定**。未知 rowId は**診断 warn のみ**（列の fail-fast と分ける＝行は初期データ到着前に検証できない）。判定は初回描画後の1回だけ実施する
- **④C4 の公開面**: `GridInstance.scrollToColumn(columnId)` ＋ React handle。`ensureCellVisible` に軸指定（`'vertical' | 'horizontal' | 'both'`）を足し、`scrollToRow`＝縦のみ／`scrollToColumn`＝横のみを**固定数に依存せず**成立させる（`frozenColumnCount: 0` でも `scrollToRow` が横を動かさない）
- **⑤C5 の測り方**: DD-004 ハーネスの列数を 382 まで振って計測し `kpi-ledger.md` へ記録
- **⑥子DD分割**: 単一DD・5 Phase。レビューゲートは完了後の Codex 1 回のみ

📐 実装前詳細化の結論（コード実読・2026-09-03）:

- **`frozenColCount = 1` の暗黙前提は無い**。`viewport.ts` / `scroll-anchor.ts` / `editor-placement.ts` / `base-layer.ts`（オーバーフロー左外流入の停止条件）は**いずれも任意の固定数で動く**（viewport は `Math.min(count)` で自クランプ）。唯一の例外が `performScrollToRow` の `ensureCellVisible({ row, col: 0 })`＝「index 0 は固定列だから横が動かない」という前提で、これは④の軸指定で解消する
- **C3 は `integration-editor.ts` を無改変で成立する**（起票時の想定より軽い）。DD-035 R4 が入れた動的判定 `isInputLocked()` / `setInputLock()` の**判定条件に行を足すだけ**で、textarea の物理ロック（`readOnly` 属性）・論理ロック（DOM イベント dispatch 抑止）はそのまま共有できる。`editor-state-machine` / `ime-editing-session` / `packages/ime/*` も無改変
- **抑止の 2 層**（keydown 入口＝`shouldSuppressReadonlyKey` の呼び出し条件／chokepoint＝`submitSetCells`・`submitToBackend`）と**範囲スキップ**（`partitionReadOnlyColumnChanges`）は列版と同型。純関数側は行版を並置し、内部の走査ロジックだけ共有する

起票時点で先に置く制約:

- **無改変制約**: `packages/ime/*`・`packages/grid/src/ime-editing-session.ts`・`editor-state-machine` は無改変。`integration-editor.ts` は C3 の行ロック用の分岐追加のみ（readOnly=false かつ行・列ロック無しの経路は完全無変更）＝改変が必要と判明したら停止して報告
- **公開 error/conflict code は追加しない**（不正設定は既存 `column-types-invalid`・抑止は診断のみ＝DD-033-1 / DD-035 と同方針）
- **未使用の consumer は現行挙動と完全一致**させる（4 オプションいずれも未指定なら、固定数は現行どおり 1／判定は即 false でコスト増ゼロ）

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | `frozenColumnCount: 5` で先頭 5 列が横スクロールしても画面左に残る。固定バンド内のヒットテスト・範囲選択・アクティブセル・editor 配置・オーバーフロー停止が pane 境界でずれない | Phase 2 E2E `frozen-panes.spec.ts`＋unit（viewport / editor-placement / scroll-anchor） |
| 2 | `frozenColumnCount` / `frozenRowCount` 未指定なら現行（1／1）と完全一致。既存 unit・invariants・E2E が**無修正で** green | Phase 2＋Phase 5 全回帰 |
| 3 | `columnBackgrounds` 指定列は**空セルも**指定色で塗られる。罫線・Presence・選択表示は従来どおり上に乗る | Phase 3 E2E `column-background.spec.ts`＋unit |
| 4 | 同一セルに `columnFormats` の値ベース書式と `columnBackgrounds` が両方効くとき、**値ベースが勝つ**。値ベース書式のあるセル以外は静的列色のまま | Phase 3 unit `format-rules.test.ts` 追補＋E2E |
| 5 | `readOnlyRows` 指定行で 印字キー・F2・dblclick・synthetic IME・Delete/Backspace のいずれでも編集 UI が開かず文書無変更（診断 `readonly-row-blocked`）。他行は従来どおり編集できる | Phase 4 E2E `readonly-rows.spec.ts`＋unit |
| 6 | readOnly 行を含む矩形へ貼り付け／Delete 範囲クリア → その行のセルはスキップされ他行だけ適用（TSV の行位置は不変・全セルスキップなら no-op・診断 `readonly-row-skipped`） | Phase 4 E2E＋unit |
| 7 | readOnly 行でも範囲選択・コピー・スクロール・setData・（共同編集）リモート受信反映が従来どおり動く。未知 rowId は診断 warn のみで mount は成功する | Phase 4 E2E＋unit |
| 8 | `scrollToColumn(columnId)` → 画面外の列が可視化される（**縦スクロールは動かない**・可視なら動かない・`setData` 直後でも成立）。未知 ID は warn のみ。React handle から到達できる | Phase 2 E2E `imperative-nav.spec.ts` 追補＋react unit |
| 9 | 約 382 列 × 80 行（非空 3〜4 万セル）で初回描画・横スクロール・入力が KPI 契約の閾値内。数値を `kpi-ledger.md` へ記録 | Phase 5 🔬 計測（DD-004 ハーネス） |
| 10 | 公開 .d.ts snapshot の差分が**追加のみ**・CHANGELOG 記載・`features.json` 更新・boundary lint new=0 | Phase 5 contract test＋features smoke＋lint |

## タスク一覧

### Phase 1: 仕様確認（Human Spec Gate）
- [x] 👀 論点 1〜6 を確定（ゲート・推奨案で代行確定）。契約は `DD-036/contract.md` へ切り出した
- [x] 📐 実装前詳細化: 「固定 1 の暗黙前提」は `performScrollToRow` の `col: 0` 依存 1 箇所だけと確定（他は任意の固定数で動く）／行ロックは `isInputLocked`/`setInputLock` の判定条件拡張だけで足り **`integration-editor.ts` は無改変**と確定
- [x] 🔬 機械検証: `bash scripts/dd-health.sh --dd DD-036 --new` → ⚠️ なし / `bash scripts/doc-check.sh` → OK

### Phase 2: C1 固定列数 ＋ C4 scrollToColumn（座標・スクロール系）
- [x] `packages/grid/src/mount-controller.ts`: 固定数を mount オプション化（既定 1・整数検証 → `frozen-count-invalid` warn で既定へ・超過は viewport がクランプ）／`ensureCellVisible` に軸指定を追加し `scrollToColumn` を `GridInstance` へ新設（保留キュー共有）
- [x] `packages/react/src/index.ts`: props（識別系＝変更で remount）と handle `scrollToColumn` を写像
- [x] 🔬 機械検証: unit（`viewport.dd036` / `scroll-anchor` / `editor-placement` / react `dd036`）＋ E2E `frozen-panes.spec.ts`・`imperative-nav.spec.ts` 追補 → AC1・2・8 green

### Phase 3: C2 列単位の静的背景色（描画系）
- [x] `format-rules.ts` に `compileColumnBackgrounds`（値ベースとは別解決器）＋ `base-layer.ts` に `columnBackground` フック（pane 背景の直後・罫線の前に列バンド）。値ベース書式は後から上塗り＝優先
- [x] `packages/react/src/index.ts`: `columnBackgrounds` props 写像
- [x] 🔬 機械検証: unit（`base-layer.dd036`＝描画順・空セル塗り・未指定時ゼロコスト／`dd036-options`＝コンパイル・fail-fast）＋ E2E（`frozen-panes.spec.ts` の AC3/AC4・Canvas ピクセル読み）→ AC3・4 green

### Phase 4: C3 行単位 readOnly（editor 経路・T1 対象）
- [x] `readonly-policy.ts`（行版 partition/touches・走査は列版と共通化）・`mount-controller.ts`（判定・フィルタ合成・chokepoint・入口抑止）。**`integration-editor.ts`・`clipboard-controller.ts` は無改変**（判定条件の拡張だけで成立＝📐 のとおり）
- [x] 未知 rowId の warn 経路（`readonly-row-unknown`・初回描画後に 1 回だけ判定）
- [x] 🔬 機械検証: unit `dd036-options`（行版フィルタ）＋ E2E `readonly-rows.spec.ts` → AC5・6・7 green

### Phase 5: 統合・計測・提供開始
- [x] 🔬 C5 計測: 382 列 × 80 行を新規 spec `zz-wide-grid-perf.spec.ts` で計測（DD-004 ハーネスは DD-016 で削除済みのため現行方式＝headed Playwright へ置換）→ 記録先は `DD-036/measurement.md`（`kpi-ledger.md` は consumer 統合 KPI 専用台帳のため不可・理由は measurement.md §1）
- [x] `tests/contract` snapshot 更新（差分は追加のみ＋既存 union 1 件の拡張）／`CHANGELOG.md`／`apps/showcase/src/features.json`（`matrix-view` 新設＋`column-types`/`react`/`scroll` 更新）→ features smoke green（AC10）
- [x] 📸 エビデンス: E2E スクショ 6 点を `test-results/dd-evidence/DD-036/` へ（出力先規約どおり）
- [x] 😈 セルフレビュー 1 巡（所見はログへ）
- [x] 🔬 機械検証（全回帰 1 回）: `npm test`（1186）/ `npm run typecheck` / `npm run lint`（boundary new=0）/ `npm run test:e2e`（134）/ `npm run test:e2e:showcase`（3）→ 全 green（AC2）

### 完了前チェック
- [x] 受け入れ基準 1〜10 を 1 項目ずつ照合（AC9 は計測記録先を変更＝ログ参照。他は達成）
- [x] Manual Gate 未実施分を「既知の未保証境界」へ移送（クローズはブロックしない）
- [x] Codex レビュー（ユーザー指示・high）→ P2×4 を**全件採用・反映**（見送り 0）。各件に回帰テストを追加し、修正前に落ちることも確認
- [ ] tarball 引き渡しは松下側 DD-014-2 が実施（`scripts/release/build-release.sh`）

## 既知の未保証境界・既知制約

- **`readOnlyRows` は権限制御ではない**（サーバー側強制なし・`readOnlyColumns` / `readOnly` と同型）。共同編集の行権限は本DD対象外
- **固定行列・列背景は view-local**。設定が異なるクライアントは異なる見え方をする＝`cell-format-sharing-design.md` の共有化スコープへ送る
- **`scrollToColumn` は最小スクロール**（可視なら動かさない）。align 指定は要求が出たら拡張点。固定列（index < frozenColumnCount）は常に可視のため無変更
- **`readOnlyRows` は mount 時固定**。行の動的化（`setReadOnlyRows` / `setData` 同梱）は未提供＝③は行の追加削除が対象外（松下 DD-014-1 決定）で足りる。未知 rowId の判定も**初回描画後の 1 回だけ**で、以後に現れた RowId は警告されない（読み取り専用としては正しく効く）
- **T1/M1 の実機確認（Manual Gate）は未実施**＝以下は synthetic（Playwright）でのみ保証: ①readOnly **行**セルでの実 MS-IME 起動不可 ②固定 5 列＋網掛けの実ウィンドウでの見え方・横スクロール追従・pane 境界の描画。実 IME 経路は DD-035 T1（列ロック）で PASS 済みで、行ロックは**同じ `setInputLock` 機構の判定条件違い**のため差分リスクは低い
- **382 列を超える規模（複数年＝700 列超）・共同編集モードでの同規模**は未計測（`DD-036/measurement.md` §3）
- **固定行数を大きくしたときの UX**（可視領域が固定バンドで埋まる）はガードしない＝利用側責務（viewport はクランプするだけ）

## Manual Gate（クローズ非ブロック・正味）

| # | 項目 | 正味 | 結果 |
|---|------|------|------|
| T1 | 実IME 台帳 5 点（`ime-manual-gate-ledger.md` §2）＋変更固有: readOnly **行**セルで IME を起動できない・上下の可編集行へ移ると起動できる（integration-editor の行ロック分岐） | 5 分 | 未実施 |
| M1 | 固定 5 列＋非稼働日の網掛けを実機で確認（横スクロール追従・pane 境界の描画・382 列でのスクロール体感） | 3 分 | 未実施 |

## ログ

### 2026-09-03
- 起票。松下リポの DD-014（納入計画のSpreadJS化）からの持ち込みで、DD-026 / DD-035 と同じく**松下側セッションが起票を代行**（以後は spreadjs 側のセッションで進める）
- 要件出所: 松下 `doc/DD/DD-014/sdk-requirements.md` §C の C1〜C5。C6（セル内リンク）は DD-027-2 のリンク列で提供済みのため対象外とし、consumer 側の適用課題として松下 DD-014-2 へ差し戻した
- 番号は DD-030〜032 がロードマップ予約（ReadyCrew 統合・配布昇格・Stage 2 判定）のため DD-036 を採番（consumer 駆動の新規トップレベル = DD-033 / DD-035 前例）
- 起票前調査（本リポのコード実読）で**§C メモとの乖離 1 件**を発見: C1 の現状は「固定列なし」ではなく `mount-controller.ts:127-128` で **`frozenColCount = 1` がハードコード**＝要件の実体は新設ではなく可変化。松下側メモを訂正済み。あわせて C4 は `ensureCellVisible` の鏡像で足りること、C2 は `format-rules.ts` が自ら拡張点として予告している経路であること、C5 は DD-004 の実測が 200 列で③の 382 列は測定域外であることを確認し、背景・課題の「現状の実測」表へ記録した
- **松下 DD-014-1（consumer 側の実装）は本DDを待たない**（現SDKの範囲で実装し、本DDの対象機能は退行・保留として出荷）。したがって本DDと松下 DD-014-1 は並行して進む
- Phase 1（spreadjs 側セッション）: ユーザー指示「DD-036 を進める・完了したら Codex レビュー」に基づき Human Spec Gate を**推奨案で代行確定**（論点 1〜6・契約は `DD-036/contract.md`＝DD-035 と同じ運用）。📐 の結論 2 件が起票時の想定を軽くした: ①「固定 1 の暗黙前提」は `performScrollToRow` の `col: 0` 依存 1 箇所だけ（viewport/scroll-anchor/editor-placement/base-layer は任意の固定数で動く設計） ②行 readOnly は **`integration-editor.ts` 無改変**で成立（DD-035 R4 の `isInputLocked`/`setInputLock` の判定条件に行を足すだけ）。Codex `--check` → 利用可（codex-cli 0.151.0）。dd-health/doc-check green。ステータス 検討中→進行中
- Phase 2（C1/C4）: 固定数は `resolveFrozenCount`（0 以上の整数以外は `frozen-count-invalid` warn → 既定 1）。`ensureCellVisible(cell, axes)` の軸指定を追加し、`scrollToRow`=縦のみ／`scrollToColumn`=横のみを**固定数に依存せず**成立させた（従来の「index 0 は固定列だから横が動かない」前提を廃止＝`frozenColumnCount: 0` でも正しい）。E2E 用に standalone/react ハーネスへ `?extracols=N`（列追加）と `?frozenrows/frozencols` を追加
- Phase 3（C2）: `format-rules.ts` 内に**別解決器**として実装（値ベースの「非空セルのみ」という芯を濁さない・同ファイルの拡張点メモに対する結論）。描画は pane 背景の直後・**罫線の前**に列バンドを 1 列 1 fillRect（空セルも塗る／罫線・選択・Presence は上に乗る／値ベース背景は後から上塗り＝優先）。未指定なら base-layer へフックを束縛せず描画コスト増ゼロ
- Phase 4（C3）: 判定は RowId ベース（`readOnlyRowSet`）＝行挿入削除で index がずれても追従する。列版と行版は `filterReadOnlyCells` で順に適用（和）。未知 rowId は初回描画後 1 回だけ判定して warn（列の fail-fast と分ける＝行は初期データ到着前に検証できない）
- Phase 5: 計測は 382 列 × 80 行（非空 30,560）で **横スクロール p95 16.8ms（目標 33ms）・初回描画 256ms（headed）・入力確定 0.5ms** ＝全て予算内（`DD-036/measurement.md`）。**AC9 の記載を 2 点訂正**: ①「DD-004 ハーネス」は DD-016 で削除済み → 現行方式（headed Playwright spec・DD-020 AC11 の先例）で新設 ②記録先は `kpi-ledger.md` ではなく DD 添付（同台帳は憲章 §16.1 の consumer 統合 KPI 専用で、契約表に無い行の追記は §4-1/§4-5 に反する。描画性能は DD-004/DD-012-2 と同じく DD 添付が先例）
- 全回帰: unit 1186（新規 25 含む）・typecheck・lint（boundary new=0）・playground E2E 134（新規 10）・showcase E2E 3 → 全 green。既存 spec の**先在フレーク 1 件**（`readonly-columns.spec.ts` の `rowCount` を再構築前に読む）を poll へ是正（負荷増で顕在化・同型の race を新 spec でも回避）
- Codex レビュー（high・`--uncommitted`・ユーザー指示・依頼書=`DD-036/codex-review-request.md`・結果=`codex-review-result.md`）: 総評「要修正」・**P1 なし / P2×4 → 4 件すべて採用・反映**（見送り 0）
  - P2 **全列固定で描画ループが例外停止**（`frozenColumnCount >= 列数` のとき `captureAnchor` が範囲外 index を `Axis.getId` → throw）→ `scroll-anchor.ts` で固定数を軸要素数へクランプ＋index を実在範囲へクランプ（`ViewportTransform` と同じ扱い）。unit 2 件＋E2E（全列固定で setData/行挿入しても描画が生きている・pageerror なし）を追加。**契約 §1「超過はクランプ」が render 層で守られていなかった**＝指摘どおり
  - P2 **構造変更後に行ロックが再同期されない**（readOnly 行を削除して同 index に可編集行が来ると textarea が `readOnly` のまま。K3 再ベースは index 不変で editor を触らない＝onChange が起きない経路）→ `flushStructural` の末尾と初回データ描画時に `syncCellLock()` を実行。E2E で両方向（ロック解除／ロック付与）を検証
  - P2 **行 0 件の文書で `scrollToColumn` が保留され続ける**（`firstDataDrawn` は行 0 では永遠に立たない）→ 列命令用の ready 条件 `canRunColumnCommandsNow()`（backend 配線済み・構造 dirty なし・列 Axis 非空・viewport 確定）を追加し、命令の実行判定と保留 drain の両方で使う。ハーネスへ `?seedrows=0` を追加して E2E 化
  - P2 **不正色が直前列の色を継承する**（Canvas は不正な `fillStyle` 代入を無視＝前の色が残るため、`{a:'#ff0000', b:'not-a-color'}` で b 列まで赤くなる）→ 列ごとに pane 背景へ戻してから候補色を代入（不正色は pane 背景で塗られる＝「Canvas が無視して安全」の契約どおり）。unit を追加
- Codex 反映後の再回帰: unit 1189（新規回帰 3 含む）・typecheck・lint（boundary new=0）・playground E2E 137（新規回帰 3 含む）・showcase E2E 3・contract snapshot → 全 green。ステータス 進行中→完了
- 😈 セルフレビュー所見（1 判断 1 行）: ①`frozenColumnCount` 超過時の裁定は viewport のクランプに委ねる（controller 側で二重クランプしない＝真実の源を 1 つに） ②列バンドはセル単位でなく列 1 本の fillRect（空セルを含む列全体が対象・描画予算） ③未知 rowId の警告は初回描画後 1 回に限定（実行時に警告を出し続けない・後から現れた行は正しくロックされる） ④`readOnlyRows` の重複指定は集合として吸収（列版の fail-fast と分ける＝行 ID は利用側が動的に組む想定） ⑤`FormatRuleConfigError.reason` の union 拡張は DD-035 の `ColumnTypeConfigError.reason` と同型の既定路線 ⑥固定バンドを跨ぐ範囲選択・オーバーフロー流入は base-layer の既存停止条件（`pane.cols.start > frozenColCount`）がそのまま効く（n>1 でも同じ式）
