# DD-064: セルの結合（consumer 駆動・計画策定の入力シート）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-11-07 | 2026-11-07 | 検討中 | consumer 駆動（hiroshima-keikaku DD-001-15）。要件正本は hiroshima-keikaku `doc/DD/DD-001-15/sdk-requirements.md` の K1〜K4。範囲（論点1〜6）は Human Spec Gate 待ち |

> アプローチ: 標準（描画・選択・貼り付けの経路に結合を通す。範囲を決めてから、selection と clipboard は TDD で進める）
> リスク: なし（認可・DBスキーマ・外部I/F・機密情報に触れない）

```text
Risk Class: A（選択・移動・貼り付けの経路を変え、公開 mount オプションと命令 API を足す。論点1 で文書の Operation〔MergeCells〕にするなら protocol・snapshot も変わる）
Risk Triggers: selection（アクティブセルの正規化・矢印キー・範囲の拡張）・clipboard（貼り付けのスキップ・コピー）・描画（結合範囲の clip）。公開 API の追加
Human Spec Gate: required（論点1〜6。起票時点では未実施）
Codex: high（xhigh は明示指示時のみ）
Manual Gate: 実 IME で、結合範囲の隣のセルへ矢印キーで移って入力を始められることの確認（クローズはブロックしない）
External Review: なし
Evidence Level: standard
```

## 目的

consumer が指定した範囲のセルを1つのセルとして描き、選択・移動・コピー・貼り付けをその範囲に合わせる（セルの結合）。合わせて、列のまとまりの名前を見出しの上に出す（2段の見出し）をこの DD で扱うかを決める。

## 背景・課題

- consumer（hiroshima-keikaku。広島国際空港の計画策定システムの試作）が、各部の入力シートを単独モードで作る（同リポジトリ DD-001-15）。先方の Excel は明細ごとに「予算・実績＋見通し・差異」の3行で、明細の属性の列（No・事業・部署・科目など）を3行にまたがって結合している。ユーザーが「セルの結合は UI として重要」とし、SDK に足すことを積極的に検討する（2026-11-07）
- 開発計画 §12.7 では、セルの結合は後の段階の予定で、固定 ID の矩形端点で持つ・重なりを禁止する・範囲の中のヒットを左上へ正規化する・可視範囲に交わる結合だけを引ける index を持つ・行列の削除で範囲が壊れたときの縮小／解除の規則を ADR で決める、とされている（ADR-019「セル結合の初期制約」は Open。D-17）。MergeCells／UnmergeCells は後続の Operation
- consumer の要件は**表示のための結合**: 範囲は consumer が自分のデータ（明細ごとの行）から決め、結合したセルは読むだけ（K1〜K3）。開発計画の MergeCells（利用者が画面で結合し、共同編集で共有する文書の状態）より狭い
- 現状（alpha.18）: 結合なし。2段の見出しもなし（DD-033-2 で対象外。拡張点メモに「2段ヘッダー」）。consumer は、属性を明細の最初の行だけに出し、明細の境を `rowBorders` の太線にするつなぎで先に進む
- 時期: consumer の試作は 11/12 にユーザーレビュー、11/13 に先方へ渡す。間に合わなければ結合なしの形で渡し、後で差し替える（試作は SDK を待たない）。consumer の本体（受注後）は 2027年1〜3月の着手の可能性がある

## 検討内容

起票時の推奨案。Human Spec Gate でユーザーと決める。

| # | 論点 | 推奨案 |
|---|---|---|
| 1 | 範囲（どの結合か） | **表示のための結合（view-local）**から始める。consumer が mount オプション（例 `mergedCells`）と命令 API（`setData` と一緒に渡すか、結合だけを差し替える命令）で範囲を渡す。文書の状態・Operation・snapshot・protocol は変えない（`rowBackgrounds`・`rowBorders` と同じ置き場）。両モードで使え、共同編集モードで各クライアントが同じ指定を持つのは consumer の責務。利用者が画面で結合・解除する MergeCells／UnmergeCells は後の段階のまま |
| 2 | 結合したセルの編集 | 初版は読むだけに限る（K3）。範囲の中は編集開始・消去・ドロップダウンをしない。貼り付け・範囲の消去・cut は、読み取り専用の行・列と同じく結合範囲のセルを飛ばす。編集できる結合（値は左上のセル）は、要望が出たら別 DD |
| 3 | 選択・移動・コピー | 範囲の中を選ぶと左上のセルを選び、選択の枠は範囲全体に描く。矢印キー・Tab・Enter は範囲を1つのセルとして動く。範囲の選択（Shift＋矢印・ドラッグ）が結合にかかったら、結合の全体を含むように広げる（Excel と同じ）。コピーは左上に値・残りは空 |
| 4 | 指定の誤りと行の入れ直し | 重なり・未知の列・1×1 の範囲は mount 時に fail-fast（既存の列設定と同じ経路）。未知の行と、入れ直しで消えた行を含む範囲は、捨てて診断 warn（`readOnlyRows` の未知 RowId と同じ扱い）。行の挿入・削除で範囲が壊れたら、その範囲を捨てる（初版。縮小の規則は ADR-019 で後に決める） |
| 5 | 2段の見出し（K4） | この DD に含めるかを決める。含めるなら、列のまとまり（例 `columnGroups: [{ caption: '上期', columns: [...] }]`）を見出しの上の段に描く表示だけの設定にする。重ければ別 DD に分ける |
| 6 | 描画 | 結合範囲は1つの矩形として背景・文字・罫線を描き、範囲の中の罫線は描かない。固定 pane とスクロール側にまたがる範囲は、mount 時に fail-fast にする（DD-039・DD-041 の pane ごとの clip を壊さない）。範囲の上の端が隠れたときの文字は、範囲と一緒に動く（Excel と同じ） |

## 決定事項

- 2026-11-07（ユーザー）: セルの結合を SDK に足すことを積極的に検討する。要件正本は consumer の `sdk-requirements.md`
- 論点1〜6 は Human Spec Gate で決める

## 受け入れ基準

論点1〜3 を推奨案で決めた場合。Gate で変わったら直す。

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | 単独モードで3行×1列の結合を指定して mount → 1つのセルとして描かれ（範囲の中の横線なし）、値は左上のセル | unit（描画の座標）・E2E のスクリーンショット |
| 2 | 結合の中をクリックする／矢印キーで入る → アクティブセルが左上に正規化され、枠が範囲全体に出る。矢印キーで範囲を1つのセルとして抜ける | unit（selection）・E2E |
| 3 | 結合範囲で印字キー・F2・Delete・貼り付け → 文書は変わらない。結合範囲にかかる貼り付けは、範囲のセルだけを飛ばして残りに入る | unit・E2E |
| 4 | 結合範囲を含む範囲をコピー → TSV は左上に値・残りは空 | unit |
| 5 | 重なり・未知の列の指定 → mount 時に error（phase=config）。`setData` で行が消えた範囲 → 捨てて診断 warn | unit |
| 6 | 固定列の中の結合を縦・横に動かす → 崩れず、pane の外へ描き漏れない | E2E |
| 7 | React Facade の props と handle へ写されている | unit（react） |
| 8 | 配布した alpha を consumer の試作（1ファイルの HTML）に取り込んで動く | consumer 側（hiroshima-keikaku DD-001-15） |

## タスク一覧

### Phase 1: 範囲を決める（Human Spec Gate）
- [ ] 論点1〜6 をユーザーと決めて決定事項へ書き、公開 API の形（オプション名・型・命令 API・診断コード）を `doc/DD/DD-064/contract.md` に書く
- [ ] ADR-019（セル結合の初期制約）を、この DD の範囲（表示のための結合）で一部決めるか、Open のまま残すかを決める
- [ ] 🔬 機械検証: `bash scripts/doc-check.sh` → OK

### Phase 2: 実装
- [ ] `packages/render`（結合範囲の描画と clip）・`packages/selection`（正規化・移動・範囲の拡張）・`packages/grid`（mount オプション・命令 API・貼り付けのスキップ・コピー・診断）・`packages/react`（写像）
- [ ] 🔬 機械検証: 対象の unit・E2E → 全パス

### Phase 3: 配布
- [ ] 配布の前の検証（typecheck・typecheck:consumer-strict・lint・test・build）を1回通し、alpha を作って consumer へ渡す
- [ ] `apps/showcase/src/features.json`・README・CHANGELOG を直す
- [ ] 🔬 機械検証: `bash scripts/release/build-release.sh` → 10 個の tarball と manifest（`closureDirty=false`）ができる。`npm run consumer-harness` → PASS

### 完了前チェック
- [ ] 受け入れ基準を1項目ずつ照合（未達成があれば理由をログへ）
- [ ] 製品化6観点（`doc/plan/dd-risk-class-header.md` §2）を確かめる
- [ ] 😈 セルフレビュー1巡（「どこが壊れるか」を探す。読み返す価値のある所見のみログへ）
- [ ] 🔬 全回帰1回

## ログ

### 2026-11-07
- DD作成（consumer 駆動。hiroshima-keikaku DD-001-15 の起票と同時に、そのセッションから起票した）。ユーザーの指示「セル結合は UI として重要な機能。spreadjs 側に DD を起票して、セル結合ができるように機能拡張することも積極的に検討したい」。実装は未着手
