# DD-035: 列タイプ拡張と命令API（consumer 駆動: 松下 生産納期）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-03 | 2026-09-03 | 検討中 | consumer 駆動（松下 DD-012-2 の残要件 R2/R4/R6/R7）。要件正本は松下リポ `doc/DD/DD-012/sdk-requirements.md` §B。DD-033 と同じく consumer 駆動の新規トップレベル採番（030〜032 はロードマップ予約のため回避） |

> アプローチ: 標準（要件は consumer 実案件で実測済み。ここでは設計論点の確定 → 実装。guides.md §1）

```text
Risk Class: A（公開 API 新設〔カレンダーエディタ・列単位 readOnly・命令 API〕・R2 が editor 経路に接する）
Risk Triggers: 公開 API/Options の新設（columnTypes への date 種 or 専用オプション／列単位 readOnly／handle 命令 API 3点）／R2 カレンダーが編集開始・確定経路に接する（editor-state-machine・常駐 textarea 本体は無改変が設計目標＝改変が必要と判明したら停止して T1 昇格。DD-033 前例）／R4 が DD-033-1 の抑止2層（入口＋chokepoint）を列単位へ拡張
Human Spec Gate: required（検討内容の論点をユーザー確定後に着手・子DD分割の要否も判断。DD-027/033 前例）
Codex: 着手時に判定（実装 Phase 確定後）
Manual Gate: あり見込み（R2 は実IMEとの併存確認が要る想定 — Spec Gate で確定）
```

## 目的

consumer 統合①（松下 生産納期 = DD-026）の実案件が、共同編集化（松下 DD-012-2）を完了した時点で持ち越した SDK 側の 4 要件を提供する:

- **R2 日付カレンダー入力**: 日付列でカレンダーのポップオーバーから選べる（手入力と併存）
- **R4 列単位 readOnly**: 指定列の編集開始を拒否し、範囲貼り付けはその列をスキップ
- **R6 スクロール・アクティブセルの命令 API**: `scrollToRow(rowId)` / `setActiveCell(rowId, columnId)`
- **R7 行操作の命令 API**: react handle から `insertRows` / `deleteRows` を発行できる（ボタン起点の行追加用）

## 背景・課題

- DD-026（U1〜U3）・DD-027（選択式・リンク・書式）・DD-033（readOnly・キャプション・表示書式）で松下要件の大半は成立し、松下側 DD-012-2 は共同編集を実機で通した（2 ブラウザ収束・JWT 認証・Postgres 投影。2026-09-03）。その適合・E2E 作業で残った SDK 側ギャップが本 4 件
- 要件の詳細・優先度・consumer 側で確認することは**松下リポ `doc/DD/DD-012/sdk-requirements.md` §B が正本**（R2=高 / R4・R6=中 / R7=低）。本DDには起票時点の要旨を写す（乖離したらメモ側が勝つ）
- 現状の実測（2026-09-03・松下側セッションによる）:

| # | 要件 | 現状 | 欲しい形（メモの要旨） |
|---|------|------|----------------------|
| R2 | 日付カレンダー | 日付の手入力 → LocalDate 正準化（ADR-0012）は成立済み。カレンダー UI は無い | 日付列指定でポップオーバーから選択でき、確定値は現行と同じ LocalDate 正準値。手入力併存。開き方（ダブルクリック / F2 / セル右端アイコン）と表示書式は利用側で指定 |
| R4 | 列単位 readOnly | `readOnly` はグリッド全体のみ（DD-033-1）。列単位は無く、consumer は No・算出列への入力をサーバー側投影の無視で防御している（文書には残る＝画面上ずれる） | 列単位フラグ。編集開始を拒否し、範囲貼り付け時はその列をスキップ。共同編集のサーバー側拒否（列権限）は将来スコープで本DD対象外 |
| R6 | scrollToRow / setActiveCell | 無い。`setData` 再注入後もスクロール位置が保たれるため、先頭に入った追加行が画面外のまま（松下 DD-012-1 実測） | `scrollToRow(rowId)` / `setActiveCell(rowId, columnId)`。両モードで機能 |
| R7 | 行操作の命令 API | `GridInstance` には `insertRows` / `deleteRows` がある（DD-021-1）が、react の `NanairoSheetViewHandle` は setData / focus / connectionState のみで包んでいない | handle への追加（`insertRows({ afterRowId, count })` / `deleteRows(rowIds)`）。共同編集モードでは通常の submit 経路に乗る |

- 対象外: R1 選択式（DD-027-1 提供済み）/ R3 表示書式（DD-033-2 提供済み）/ R5 アクティブセルイベント（不要判定）/ U6 poison 観測口（consumer 側の自主検知で代替が立った — 松下 DD-012-2 論点H③）

## 検討内容

（Human Spec Gate で確定する論点。起票時点の候補）

| # | 論点 | 選択肢・考慮 |
|---|------|-------------|
| 1 | R2 の API 面 | (a) `columnTypes` に `{ type: 'date' }` を追加（select/link と同居） / (b) 専用オプション。エディタは常駐 textarea と別 UI（カレンダー）だが、確定は既存 commit 経路へ委譲して IME 不変条件に触れない設計にできるか |
| 2 | R2 の開き方 | ダブルクリック / F2 / セル右端アイコンのどれを既定にするか。手入力（現行の型変換）との切り替え |
| 3 | R4 の API 面 | (a) `columnTypes` に `readOnly` 種 / (b) `readOnlyColumns: string[]`（`wrapColumns` と同運用）。DD-033-1 の 2 層抑止（入口＋chokepoint）を列単位条件へ拡張する形が素直か |
| 4 | R4 の貼り付け挙動 | 範囲貼り付けで readOnly 列をスキップし他列は適用（メモの要求）。TSV 列ズレの扱い |
| 5 | R6/R7 の公開面 | grid `GridInstance` と react handle のどちらへどこまで出すか（R7 は grid に実体があり react が包むだけ。R6 は新規実装） |
| 6 | 子DD分割 | R2 は editor 経路で独立子が有力。R4 も抑止層で独立候補。R6/R7 は小さく同一子でよい見込み |

## 決定事項

（Human Spec Gate で確定後に記載）

## 受け入れ基準

（起票時点の案。Spec Gate・子DD分割で確定させる）

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | 日付列でカレンダーから日付を選ぶ → LocalDate 正準値（`YYYY-MM-DD`）で commit され、手入力も従来どおり動く。IME 不変条件（先頭文字欠落なし等）に回帰なし | 実装 Phase のテスト + T1/Manual Gate（Spec Gate で確定） |
| 2 | 列単位 readOnly 指定列 → 編集開始・Delete/Backspace・ドロップダウンが抑止され、範囲貼り付けはその列をスキップして他列へ適用される | 実装 Phase のテスト |
| 3 | `scrollToRow(rowId)` / `setActiveCell(rowId, columnId)` → 対象行が可視化・アクティブ化される。`setData` 再注入後・共同編集の受信反映後も機能する | 実装 Phase のテスト |
| 4 | react handle の `insertRows` / `deleteRows` → 単独モードは row-structure-change 通知、共同編集モードは通常 submit 経路で全接続へ配信される | 実装 Phase のテスト |
| 5 | 全回帰 green・公開 .d.ts snapshot の差分が追加のみ（破壊的変更なし）・`features.json` 更新 | `npm test` / snapshot 差分 / features smoke |

## タスク一覧

### Phase 1: 仕様確認（Human Spec Gate）
- [ ] 検討内容の論点 1〜6 をユーザー確定。子DD分割の要否と実装順を決める（優先はメモ準拠: R2 高 / R4・R6 中 / R7 低）
- [ ] 🔬 機械検証: `bash scripts/dd-health.sh --dd DD-035 --new` → ⚠️ なし / `bash scripts/doc-check.sh` → OK

### Phase 2 以降: 実装（Spec Gate 後に子DD・Phase 構成を確定して記載）
- [ ] （子DD or Phase 展開）
- [ ] 🔬 機械検証: 全 workspace テスト green / 公開型 snapshot 差分が追加のみ

### 完了前チェック
- [ ] 受け入れ基準を1項目ずつ照合（未達成があれば理由をログへ）
- [ ] `apps/showcase/src/features.json` の該当エントリ更新（機能追加のため）
- [ ] tarball 再生成 → 松下側へ引き渡し（vendor 取り込み・適用は松下側 DD が実施）
- [ ] 😈 セルフレビュー1巡
- [ ] 🔬 全回帰1回（`npm test` / `npm run typecheck` / `npm run lint` → 全パス）

## ログ

### 2026-09-03
- 起票。松下リポの DD-012-2（共同編集化）完了作業からの持ち込みで、DD-026 と同じく松下側セッションが起票を代行（以後は spreadjs 側のセッションで進める）
- 要件出所: 松下 `doc/DD/DD-012/sdk-requirements.md` §B の R2/R4/R6/R7（2026-09-03 更新版）。同メモの U1〜U3・R1・R3 は DD-026/027/033 で成立済み、U6 は consumer 側の自主検知（append 恒久失敗 → crash-only 再起動）で代替が立ったため対象外
- 番号は DD-030〜032 がロードマップ予約（ReadyCrew 統合・配布昇格・Stage 2 判定）のため DD-035 を採番（consumer 駆動の新規トップレベル = DD-033 前例）
