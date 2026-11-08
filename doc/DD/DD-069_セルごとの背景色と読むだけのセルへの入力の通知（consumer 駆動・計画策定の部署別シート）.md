# DD-069: セルごとの背景色と読むだけのセルへの入力の通知（consumer 駆動・計画策定の部署別シート）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-11-08 | 2026-11-08 | 検討中 | consumer 駆動（hiroshima-keikaku DD-001-28）。要件正本は hiroshima-keikaku `doc/archived/DD/DD-001-27/sdk-requirements.md` の K8・K11。範囲（論点1〜6）は Human Spec Gate 待ち |

> アプローチ: 標準（描画の背景の重ね順と、編集を止める経路に通知を足す。範囲を決めてから、通知の発火条件は TDD で進める）
> リスク: なし（認可・DBスキーマ・外部I/F・機密情報に触れない）

```text
Risk Class: A（編集を止める経路〔印字キー・IME・Delete・F2・ダブルクリック・貼り付け・切り取り・範囲の消去〕に通知を足し、公開のイベントと行データの項目を足す）
Risk Triggers: 描画（セルの背景の重ね順）・入力の経路（キー・textarea・IME・ポインタ・clipboard）。公開 API の追加
Human Spec Gate: required（論点1〜6。起票時点では未実施）
Codex: high（xhigh は明示指示時のみ）
Manual Gate: 実 IME（日本語入力オン）で読むだけのセルに打つと、通知が1回だけ届き、変換が始まらないことの確認（クローズはブロックしない）
External Review: なし
Evidence Level: standard
```

## 目的

consumer がセルごとに背景色を指定できるようにする（K8）。読むだけのセルへの編集を止めたとき、どのセルで何をしたかを consumer へ知らせる（K11）。

## 背景・課題

- consumer（hiroshima-keikaku。広島国際空港の計画策定システムの試作）の部署別シート（旧 入力シート。同リポジトリ DD-001-27）で、セルの背景を「白＝入力できる／灰＝読むだけ（式の結果・参照）」に分けることを、consumer のユーザーと合意した。実績＋見通しの版では、同じ行の中で入力できる月（実績の月）と読むだけの月（式で計算する見通しの月）が混ざり、式の入力値の行はその逆になる。読むだけのセルに打ったら、理由と直す先（「11月の実績＋見通しは式で計算しています。下の『利用率』の11月を直してください」など）を出す
- 現状（alpha.22）の背景: `rowBackgrounds`（DD-045）と `columnBackgrounds`（DD-036 C2）だけで、交差は行が勝つ。セルごとに付けられるのは `cellStatus` の error・warning（DD-060〜062）で、consumer はどちらも使っている（計算不能の赤・未入力の黄）
- 現状（alpha.22）の読むだけのセル: 印字キーは入力欄（textarea）の readOnly（`setInputLock`）とキーの抑止（`mount/keyboard.ts`。診断 `readonly-*-blocked`・`merged-cell-blocked`）で止まり、範囲の操作は `filterReadOnlyCells`（診断 `readonly-*-skipped`・`merged-cell-skipped`。件数だけ）で飛ばす。どれも位置を持たない診断で、公開の契約ではない。選択中のセルを返す API・選択が変わったイベントもない
- consumer のつなぎ（届くまで）: 背景は行と列の色を組み合わせて近づけ、入力値の行の実績の月（空欄・読むだけ）・年計・積算根拠などが白のまま残る。理由の通知は、クリックした時点の `cell-hover` で選んだセルを覚え、textarea の `readOnly` で読むだけかを見分けて出す（SDK の中の作りに頼っている）。キーで選択を動かした後・貼り付けの後はセルが分からず、決まりだけを出す
- 対象外: K9（セルごとの印）・K10（列ごとの見出しの色）・K12（リンクの列の折り返し）は、consumer のユーザーが見送った（hiroshima-keikaku DD-001-28）
- 時期: consumer は受注前の PoC で、届くまではつなぎのまま動く（SDK を待たない）

## 検討内容

| # | 論点 | 推奨案（起票時。Human Spec Gate で確定する） |
|---|---|---|
| 1 | K8 の置き場所 | 行データの項目 `cellBackgrounds?: Record<ColumnId, string>`（`readOnlyColumns`・`cellStatus` と同じ置き場。`setData`・`setRows` のたびに入れ直す）。共同編集モードには `setCellBackgrounds(rows)`（DD-062 の `setCellStatus` と同じ形）。view-local（文書・Operation・Undo・snapshot は変えない） |
| 2 | 背景の重ね順 | pane 背景 → 列背景 → 行背景 → **セルの背景** → 状態表示（error・warning）・値の書式。状態表示はセルの背景より勝つ（未入力の黄・計算不能の赤を消さない）。結合したセルは左上のセルの色（DD-064 と同じ） |
| 3 | 色の検査 | 空・空白だけの色は、mount なら fail-fast（`column-types-invalid` と同じ経路）、`setRows` ならその行の指定だけ捨てて診断 warn。CSS の色の妥当性そのものは検査しない（`rowBackgrounds` と同じ） |
| 4 | K11 の形 | 新しいイベント `edit-blocked`（両モード）: `{ type, rowId, columnId, input, reason }`。`input` は `key`（印字キー。日本語入力オンの打鍵を含む）・`delete`（Delete・Backspace）・`f2`・`dblclick`・`paste`・`cut`・`clear`。`reason` は `readonly-column`・`readonly-row`・`readonly-cell`・`merged`・`grid-readonly`。選択中のセルで止めたら1回。範囲の操作で一部のセルを飛ばしたら、飛ばしたセルの一覧を `cells-skipped`（`operation`・`cells`）で別に知らせる |
| 5 | 発火しない場合 | 入力できるセルでの編集、`setRows`・`setData`、リモートの変更、移動キー、Ctrl+C などの修飾キーつきのショートカット（Ctrl+V・Ctrl+X は `paste`・`cut` として出す）。IME の変換中の途中のキーは出さない（始まりの1回だけ） |
| 6 | 選択中のセルを返す API | この DD では足さない（consumer の用途は論点4のイベントで足りる）。要るなら別 DD |

## 決定事項

（Human Spec Gate の後に、論点ごとの結果を書く）

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | 行データの `cellBackgrounds` で指定したセルだけがその色で描かれる。行・列の背景より勝ち、状態表示（黄・赤）には負ける。`setRows` で変えると描き直る | vitest（背景の解決）・consumer-harness |
| 2 | 読むだけのセル（列・行・セル単位・結合・表全体の readOnly）で、印字キー・Delete・F2・ダブルクリック・貼り付け・切り取り・範囲の消去をすると、`edit-blocked`（範囲の一部なら `cells-skipped`）が位置と操作つきで1回だけ届き、文書は変わらない | vitest（keyboard・pointer・edit-commands） |
| 3 | 入力できるセルの編集・`setRows`・リモートの変更・移動キーでは届かない | vitest |
| 4 | 公開の型・React の写像（必要なら）・CHANGELOG・`apps/showcase/src/features.json` がそろう | typecheck・`npm test` |

## タスク一覧

### Phase 1: 範囲を決める（Human Spec Gate）

- [ ] 論点1〜6 をユーザーと確定し、決定事項に書く（公開 API の細目は、要れば `DD-069/contract.md` に分ける）
- [ ] 🔬 机上検証: 決定事項・受け入れ基準・Risk Class の欄が食い違わない

### Phase 2: 実装と検証（Phase 1 の後）

- [ ] 範囲が決まったら、触るファイルと手順をここに書く
- [ ] 🔬 機械検証: `npm test`（lint・typecheck・vitest）が成功する

### 完了前チェック

- [ ] 受け入れ基準を1項目ずつ照合（未達成は理由を、人手の確認が残るものは確認していない範囲をログへ — guides.md §3）
- [ ] 📄 現在形の文書へ反映 — 対象: README（mount オプションとイベント）・CHANGELOG・`apps/showcase/src/features.json`
- [ ] 😈 セルフレビュー1巡
- [ ] 🔬 全回帰1回（`npm test` → 全パス）

## ログ

### 2026-11-08

- 起票（consumer 駆動・hiroshima-keikaku DD-001-28）。hiroshima-keikaku の DD-001-27 で合意した部署別シートの見せ方のうち、表の部品に機能がなかった5つを、consumer のユーザーが DD-001-28 で判断し、K8（セルごとの背景色）と K11（読むだけのセルへの入力の通知）を持ち込むことにした。論点1〜6 は推奨案で、Human Spec Gate 待ち。実装は未着手
