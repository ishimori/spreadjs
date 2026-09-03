# DD-040: リリース manifest の gitDirty が配布再現性を判定できない

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-03 | 2026-09-03 | 検討中 | DD-038 の tarball 更新中に判明。`gitDirty` が working tree 全体を見るため、配布 closure に無関係な dirt でも true になり、再現性リスクの有無を読み分けられない |

> アプローチ: 標準（既存スクリプトへ判定を1つ足す小改修。新しい仕組みを作らない。guides.md §1）
> リスク: なし（配布 manifest はフィールド追加のみで後方互換。認可・DBスキーマ・外部I/F・機密のいずれにも該当しない）

```text
Risk Class: B（配布成果物 manifest のスキーマに追加が入る＝consumer が読むファイル。ただし追加のみで既存フィールドの意味は変えない）
Risk Triggers: consumer へ渡る manifest のスキーマ変更／Stage 1 ゲート（S1-6 再現 build）の証拠として使われた項目の意味論に触れる
昇格条件: 既存 `gitDirty` を**削除する・意味を狭める**方向へ倒す必要が生じたら停止して A へ昇格する（過去のゲート判定の読み替えが発生するため）
Human Spec Gate: required（論点①既存 gitDirty を残すか置換するか ②「配布に影響するパス」の定義 ③ 判定を誰が使うか）
Codex: 着手時に判定（medium 想定。ビルドスクリプトと manifest 生成のみで、状態機械・protocol・永続化に触れない）
Manual Gate: なし見込み（スクリプト実行と manifest の中身で判定できる）
External Review: なし
Evidence Level: standard
```

## 目的

**リリース manifest を見た人が「この tarball は記録されたコミットから再現できるか」を判断できるようにする。**
現在の `gitDirty` は「working tree のどこかが汚れている」しか言っておらず、配布物の再現性が実際に脅かされているかを区別できない。

## 背景・課題

- `scripts/release/build-release.sh` は manifest に `gitCommit` と `gitDirty` を刻む。`gitDirty` の判定は `git status --porcelain` が非空かどうか（[build-release.sh:45](../../scripts/release/build-release.sh#L45)）で、**未追跡ファイルも数える**
- **実測（2026-09-03・DD-038 の tarball 更新時）**: 生成した manifest は `gitCommit: 2a07b0d` / `gitDirty: true`。ところが dirt の正体は**別セッションが起票中の `doc/DD/DD-039_*.md` 1 ファイルのみ**で、配布 closure（`packages/` の 9 package）には一切影響しない。**記録コミットから同じ tarball を再生成できる**にもかかわらず manifest は「未コミットの変更を含む」と警告する
- 逆方向の危険もある。`gitDirty` が常時 true になると**オオカミ少年化**し、`packages/` を編集したまま pack した本物の再現性違反を見落とす。今回はまさに「true が既定値」の状態だった
- **この項目は過去にゲート判定へ使われている**。DD-018（Stage 1 ゲート）の Codex レビューは `release-manifest.json` の `gitDirty: true` を根拠に「記録された commit から manifest の tarball を再生成できない＝S1-6 の再現 build は現証拠では未充足」と判定した（`doc/archived/DD/DD-018/codex-review-result.md`）。**意味論を変えると過去の判定の読み替えが要る**ため、慎重に扱う
- なお「スクリプト自身が dirty を誘発していた」分（証跡を閉じた DD-017 の active パスへ複製し、孤児の未追跡ファイルを毎回生成していた）は DD-038 の作業中に **`2a07b0d` で是正済み**。本DDが扱うのは残った判定精度の問題

## 検討内容

| # | 論点 | 選択肢 | 起票時の所見 |
|---|------|--------|------------|
| 1 | 既存 `gitDirty` をどうするか | (a) 残したまま**別フィールドを追加** / (b) `gitDirty` の判定自体を配布影響パスに狭める | **(a) 推奨**。(b) は過去のゲート判定（DD-018）と同名フィールドで意味が変わり、古い manifest との比較が壊れる。(a) なら追加のみで後方互換 |
| 2 | 「配布に影響するパス」の定義 | (a) `packages/` のみ / (b) `packages/` ＋ ビルド入力（`scripts/release/`・ルート `package.json` / `package-lock.json` / 共有 tsconfig） | **(b) 推奨**。tarball の中身は `packages/` だが、**何をどう pack するか**は release スクリプトとルート設定が決める。狭すぎる定義は「スクリプトを書き換えたまま pack した」を見逃す |
| 3 | 追加フィールドの形 | (a) boolean 1 つ / (b) boolean ＋ 汚れているパスの要約 | 要検討。(b) は「なぜ true なのか」を manifest だけで説明でき、consumer への引き渡し時の説明が要らなくなる。ただしパス名を成果物へ書くことになる（社内配布なので支障はない見込み） |
| 4 | 判定を誰が使うか | (a) 人間が読むだけ / (b) `verify-manifest.mjs` でも検査 / (c) build を失敗させる | (a) を既定に。**(c) は採らない**（doc を書きかけたまま緊急ビルドしたい場面を潰す）。(b) は要検討 |
| 5 | ログ出力 | 現状は dirty 時に WARN 1 行 | 追加判定に合わせて「配布に影響する dirt か否か」を出し分けたい（現状は無関係な dirt でも同じ警告） |

## 決定事項

（Human Spec Gate で確定後に記載）

## 受け入れ基準

（起票時点の案。Spec Gate で確定させる）

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | `doc/` 配下だけが汚れている状態で build → manifest は「配布に影響する dirt なし」を示す | 実機実行（`doc/` にダミーの未追跡ファイルを置いて build） |
| 2 | `packages/` を編集した状態で build → 「配布に影響する dirt あり」を示す | 実機実行 |
| 3 | `scripts/release/build-release.sh` を編集した状態で build → 「配布に影響する dirt あり」を示す（論点②(b) を採る場合） | 実機実行 |
| 4 | 既存 `gitDirty` の意味・値は従来どおり（working tree 全体） | 上記1で `gitDirty: true` のままであることを確認 |
| 5 | `node scripts/release/verify-manifest.mjs release` が従来どおり OK | 実機実行 |
| 6 | 過去の manifest（`doc/archived/DD/DD-017/release-manifest.json`）を読んでも壊れない（フィールド欠如を許容） | 論点④(b) を採る場合のみ・unit or 実行確認 |
| 7 | クリーンな working tree で build → 両方の判定が false | 実機実行 |

## タスク一覧

### Phase 1: 仕様確認（Human Spec Gate）
- [ ] 👀 論点 1〜5 を確定（特に①既存 `gitDirty` の扱いと②パス定義）
- [ ] 🔬 機械検証: `bash scripts/dd-health.sh --dd DD-040 --new` → ⚠️ なし / `bash scripts/doc-check.sh` → OK

### Phase 2: 実装（Spec Gate 後）
- [ ] `scripts/release/build-release.sh`: 配布影響パスに限定した dirty 判定を追加し、manifest とログへ反映（既存 `gitDirty` は据え置き）
- [ ] 論点④の結論次第で `scripts/release/verify-manifest.mjs` を追補
- [ ] 🔬 機械検証: AC1〜3・7 を実機実行で確認（各状態を作って build → manifest を確認）／`node scripts/release/verify-manifest.mjs release` → OK

### 完了前チェック
- [ ] 受け入れ基準を1項目ずつ照合（未達成があれば理由をログへ）
- [ ] `CHANGELOG.md` への記載要否を判断（配布 manifest のスキーマ追加＝consumer が読むファイルのため）
- [ ] 😈 セルフレビュー1巡（「どこが壊れるか」を探す。所見はログへ）
- [ ] 🔬 全回帰1回（`npm test` / `npm run typecheck` / `npm run lint` → 全パス）

## ログ

### 2026-09-03
- 起票。DD-038 の tarball 更新中に判明した。生成した manifest が `gitDirty: true` になり、原因を追うと別セッションの未追跡 DD ファイル 1 個だけで、配布物の再現性には影響していなかった
- 親子DDにはしない。DD-038（貼り付け後の選択レンジ）とはテーマが無関係で、DD-038 は AC 全充足でクローズ・アーカイブ済み＝分割対象の親ではない。系譜としては DD-017（配布・release automation）／DD-018（Stage 1 ゲート）だが、どちらも完了・ゲート判定済みのため閉じたDDに子をぶら下げず独立番号とした
- **同一の症状に見えた別問題は DD-038 の作業中に是正済み**（`2a07b0d`）。`build-release.sh` が証跡を `doc/DD/DD-017/`（アーカイブ済みDDの active パス）へ複製し、孤児フォルダの未追跡ファイルで自ら `gitDirty=true` を誘発していた。複製先をアーカイブ先へ向け直す案は**採らなかった** — `doc/archived/DD/DD-017/release-manifest.json` は CG-4 の gate 証拠として `doc/plan/cg-ledger.md` と DD-018 の `stage1-gate-checklist.md` から参照されており、build のたびに上書きすると Stage 1 のゲート証拠が壊れるため
