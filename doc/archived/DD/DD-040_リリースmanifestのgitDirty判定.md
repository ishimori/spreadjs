# DD-040: リリース manifest の gitDirty が配布再現性を判定できない

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-03 | 2026-09-03 | 完了 | manifest に `closureDirty` / `closureDirtyPaths` / `dirtyNote` を追加し、配布再現性を `gitDirty` と読み分けられるようにした。既存 `gitDirty` の意味は不変（後方互換）。AC 1〜7 全て実機で照合 |

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

**Human Spec Gate 実施: 2026-09-03**（ユーザー指示「論点は全部推奨で良い」。明示の推奨が無かった③④も下記で確定）。

| # | 論点 | 決定 | 根拠 |
|---|------|------|------|
| 1 | 既存 `gitDirty` | **(a) 残したまま別フィールドを追加** | 追加のみで後方互換。同名フィールドの意味を変えると DD-018 の S1-6 判定（`gitDirty: true` を根拠に再現 build 未充足とした）の読み替えが発生する |
| 2 | 「配布に影響するパス」 | **(b) `packages/` ＋ ビルド入力** = `packages` / `scripts/release` / `package.json` / `package-lock.json` / `tsconfig.base.json` | tarball の中身は `packages/` だが、**何をどう pack するか**は release スクリプトと workspace 定義が決める。`packages/` だけでは「スクリプトを書き換えたまま pack した」を見逃す |
| 3 | 追加フィールドの形 | **(b) boolean ＋ 汚れているパスの要約**（`closureDirty` / `closureDirtyPaths`・上限20件）＋ 読み方を書いた `dirtyNote` | 「なぜ true なのか」を manifest 単体で説明でき、consumer への引き渡し時に口頭の補足が要らなくなる（今回まさにそれが必要だった）。社内配布のためパス名の露出に支障はない |
| 4 | 判定を誰が使うか | **(a) 人間が読む＋(b) `verify-manifest.mjs` が WARN を出す。(c) build 失敗は採らない** | (b) は manifest の記録値を伝えるだけ（配布ディレクトリは repo 外にも置かれ再計算できない）。**同一性検査とは別物なので exit code は変えない**（tarball と manifest は一致しており、問題は「その manifest が指すコミットから再生成できない」こと）。(c) は doc を書きかけたまま緊急ビルドしたい場面を潰す |
| 5 | ログ出力 | **出し分ける**。closureDirty なら「この成果物は再現できません」＋該当パス列挙、gitDirty のみなら「配布 closure の外＝再現可能」の note | 従来は無関係な dirt でも同じ WARN で、常時 true のオオカミ少年化を招いていた |

**後方互換**: 古い manifest（`closureDirty` を持たない）を `verify-manifest.mjs` が読んでも `undefined` で何も言わない。既存 `gitDirty` の値・意味は不変。

**パス集合の保守**: `scripts/release/build-release.sh` の `CLOSURE_PATHSPEC` が実体で、増減させたら本 DD の論点②も更新する（スクリプト側のコメントに明記済み）。

## 受け入れ基準

**Spec Gate（2026-09-03）で確定**。全て実機実行で照合済み。

| # | 基準（操作 → 期待結果） | 結果 | 証跡 |
|---|------------------------|------|------|
| 1 | `doc/` 配下だけが汚れている状態で build → `closureDirty: false`（配布に影響する dirt なし） | ✅ | worktree に `doc/DD/DD-999_probe.md` を置いて build → `gitDirty=true / closureDirty=false`・`paths: []`。ログに「汚れているのは配布 closure の外です」の note |
| 2 | `packages/` を編集した状態で build → `closureDirty: true` | ✅ | `packages/grid/src/__ac2-probe.tmp` を置いて build → `closureDirty=true`・`paths` に当該ファイル |
| 3 | `scripts/release/build-release.sh` を編集した状態で build → `closureDirty: true` | ✅ | 本DDの実装中の未コミット状態で build → `closureDirty=true`・`paths` に `scripts/release/*` 2件。ログに「この成果物は再現できません」＋パス列挙 |
| 4 | 既存 `gitDirty` の意味・値は従来どおり（working tree 全体） | ✅ | AC1 で `gitDirty: true` のまま（`doc/` の dirt を従来どおり拾う） |
| 5 | `verify-manifest.mjs` が従来どおり OK（exit 0） | ✅ | AC3 の manifest に対し同一性検査 OK＋closureDirty の WARN を出しつつ **exit=0** |
| 6 | 過去の manifest（`closureDirty` を持たない）を読んでも壊れない | ✅ | DD-017 当時の形（3フィールドを削除）を再現して verify → OK・exit=0・追加の出力なし |
| 7 | クリーンな working tree で build → 両方 false | ✅ | `git worktree` で HEAD の clean tree を作って build → `gitDirty=false / closureDirty=false`・警告も note も出ない |

## タスク一覧

### Phase 1: 仕様確認（Human Spec Gate）
- [x] 👀 論点 1〜5 を確定（ユーザー指示「全部推奨で良い」。明示の推奨が無かった③④も決定事項で確定）
- [x] 🔬 機械検証: `bash scripts/dd-health.sh --dd DD-040 --new` → ⚠️ なし / `bash scripts/doc-check.sh` → OK

### Phase 2: 実装（Spec Gate 後）
- [x] `scripts/release/build-release.sh`: `CLOSURE_PATHSPEC` に限定した dirty 判定を追加し、manifest（`closureDirty` / `closureDirtyPaths` / `dirtyNote`）とログへ反映（既存 `gitDirty` は据え置き）
- [x] `scripts/release/verify-manifest.mjs`: `closureDirty=true` で WARN・該当パス列挙（exit code は変えない）／`gitDirty` のみなら note ／フィールド欠如は無言（論点④(b)）
- [x] 🔬 機械検証: AC1〜7 を実機実行で確認（AC1・AC7 は `git worktree` で clean tree を作って検証）／`verify-manifest` → OK・exit 0

### 完了前チェック
- [x] 受け入れ基準 1〜7 を1項目ずつ照合（全て ✅・上表に証跡）
- [x] `CHANGELOG.md` への記載要否を判断 → **記載しない**（CHANGELOG は「`@nanairo-sheet/*` package の変更履歴」で、本DDは package の API・挙動を一切変えない。manifest 側は自己記述の `dirtyNote` を持たせて読み方をその場で説明できるようにした）
- [x] 😈 セルフレビュー1巡（所見2件を反映。ログ参照）
- [x] 🔬 全回帰1回（`npm test` 1216件 / `npm run typecheck` 0 error / `npm run lint`（boundary new=0）→ 全パス）

## ログ

### 2026-09-03
- 起票。DD-038 の tarball 更新中に判明した。生成した manifest が `gitDirty: true` になり、原因を追うと別セッションの未追跡 DD ファイル 1 個だけで、配布物の再現性には影響していなかった
- 親子DDにはしない。DD-038（貼り付け後の選択レンジ）とはテーマが無関係で、DD-038 は AC 全充足でクローズ・アーカイブ済み＝分割対象の親ではない。系譜としては DD-017（配布・release automation）／DD-018（Stage 1 ゲート）だが、どちらも完了・ゲート判定済みのため閉じたDDに子をぶら下げず独立番号とした
- **同一の症状に見えた別問題は DD-038 の作業中に是正済み**（`2a07b0d`）。`build-release.sh` が証跡を `doc/DD/DD-017/`（アーカイブ済みDDの active パス）へ複製し、孤児フォルダの未追跡ファイルで自ら `gitDirty=true` を誘発していた。複製先をアーカイブ先へ向け直す案は**採らなかった** — `doc/archived/DD/DD-017/release-manifest.json` は CG-4 の gate 証拠として `doc/plan/cg-ledger.md` と DD-018 の `stage1-gate-checklist.md` から参照されており、build のたびに上書きすると Stage 1 のゲート証拠が壊れるため
- Human Spec Gate 実施（ユーザー指示で全論点を推奨案）。実装は 2 ファイル・約 40 行。既存 `gitDirty` は 1 文字も変えていない
- **AC1・AC7 は `git worktree` で検証した**。本体の working tree は別セッションが `packages/render/` を編集中で clean にできず、かつ他セッションのファイルには触れられないため、HEAD の隔離コピーを作って「clean tree」「`doc/` のみ dirty」の 2 状態を再現した。検証後 worktree は削除済み
- **😈 セルフレビューで 2 件を反映**:
  - **監視漏れの偽陰性**: `git status --porcelain -- <存在しないパス>` は**エラーにならず exit 0 で空を返す**（実測）。つまり将来 `tsconfig.base.json` 等がリネーム・移動されると、**警告なく監視対象から外れて `closureDirty` が常に false になる**。`CLOSURE_PATHSPEC` の各エントリの存在を build 時に確認し、無ければ WARN を出すようにした（成果物は作る。判定材料が減ったことを伝えるのが目的）
  - **一覧の打ち切りが黙っている**: 21 件以上汚れていると先頭 20 件だけが載り「これで全部」と誤読させる。`…他 N 件（一覧は上限20件）` を末尾に足した（判定の正は boolean 側で、一覧はあくまで手掛かり）
- **知見昇格（アーカイブ時）**: `doc/engineering-patterns.md` #16「許可リストで監視対象を列挙する仕組みは、対象が消えたことを検知できない（存在確認をセットで置く）」を追加した。同スクリプト内の `CLOSURE_PKGS`（対象が消えたら tarball 名の完全一致で必ず落ちる＝安全側）との対比を含め、「消えたら落ちるか、消えたら黙るか」で許可リストを分類する形にした。仕様書同期は該当なし（`doc/spec/` を持たない SDK リポジトリ）
- **`release/` の再生成は本DDでは行わない**。現在の成果物は `8329c0a`・`gitDirty: false` で健全（`verify-manifest` OK）だが、いま再ビルドすると別セッションの `packages/render/` 編集を拾って `closureDirty: true` になり、かえって引き渡しに適さなくなる。新フィールド付きの manifest は、配布パスが clean な次回ビルドから載る
