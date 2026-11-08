# DD-069: セルごとの背景色と読むだけのセルへの入力の通知（consumer 駆動・計画策定の部署別シート）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-11-08 | 2026-11-08 | 進行中 | K8（cellBackgrounds・setCellBackgrounds）と K11（edit-blocked・cells-skipped）を実装し、単体・E2E で確認。Codex レビュー待ち |

> アプローチ: 標準（描画の背景の重ね順と、編集を止める経路に通知を足す。範囲を決めてから、通知の発火条件は TDD で進める）
> リスク: なし（認可・DBスキーマ・外部I/F・機密情報に触れない）

```text
Risk Class: A（編集を止める経路〔印字キー・IME・Delete・F2・ダブルクリック・貼り付け・切り取り・範囲の消去〕に通知を足し、公開のイベントと行データの項目を足す）
Risk Triggers: 描画（セルの背景の重ね順）・入力の経路（キー・textarea・IME・ポインタ・clipboard）。公開 API の追加
Human Spec Gate: passed＋delegated（2026-11-08・ユーザーが「DD-069を推奨で進めて」と指示。論点1〜6 を推奨案で確定。実装で詰めた細目は決定事項）
Codex: high（1 回・P2×2 をどちらも採用して修正。xhigh は明示指示時のみ）
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

- 2026-11-08（ユーザー・hiroshima-keikaku DD-001-28）: K8・K11 を持ち込む。K9・K10・K12 は見送り
- 2026-11-08（ユーザー）: 「DD-069を推奨で進めて」→ **論点1〜6 を上の推奨案で確定**（Human Spec Gate を推奨案で代行確定）。実装が終わったら Codex にレビューを頼み、指摘は妥当性を判断した上で Claude が直す
- 実装で詰めた細目（推奨案の範囲の中での判断）:
  - **論点1**: 置き場は `cellStatus` と同じ形の `CellBackgroundStore`（`grid/src/cell-background.ts`）。単独モードの行データ（`initialData`・`setData`・`setRows`）と両モード共通の `setCellBackgrounds` が同じ置き場を使う。単独モードの boot 前の `setCellBackgrounds` は `setData`/`setRows` と同じ queue に積んで呼んだ順に適用する（DD-062 と同じ）。共同編集モードの置き場は列を確かめず、描画で解決できない列を描かない
  - **論点2**: 重なり順は pane → 列 → 行 → **セル** → 値ベース書式 → 状態表示（値ベース書式と状態表示の間は従来どおり状態表示が勝つ）。結合範囲は左上のセルの色で範囲全体を塗る（範囲の中の他の行の指定は描かない）
  - **論点3（推奨案から変えた）**: mount 時（`initialData`）も fail-fast にせず、空・空白だけ・文字列でない色はそのセルだけ捨てて診断 warn（`cell-background-invalid`）。`cellBackgrounds` 自体がオブジェクトでない行は、その行を変えずに同じ診断。理由: `cellStatus` の不正な `level` と同じ扱いにそろえる（行データは consumer の業務データから作る値で、1 セルの誤りで画面全体を出さないのは重すぎる。mount オプションではないので `column-types-invalid` の経路に乗らない）
  - **論点4**: `edit-blocked` は選択中のセル（キー、表全体が readOnly のときの貼り付け・切り取り・範囲の消去）とダブルクリックしたセルについて出す。理由が重なるときは `grid-readonly` → `merged` → `readonly-row` → `readonly-column` → `readonly-cell` の順で先のもの。結合範囲は左上のセルとして知らせる。印字キーは従来どおり素通し（textarea の readOnly で止まる）で通知だけ足し、抑止するキー（F2・Delete・Backspace）と素通しのキーで知らせる段を分けて、1 打鍵で 1 回にする
  - **論点4**: 貼り付け・切り取り・範囲の消去で飛ばしたセルは、1 つだけでも `cells-skipped`（`edit-blocked` にしない）。理由: 貼り付けの範囲はクリップボードの大きさで決まり選択中のセルとは限らないので、飛ばしたかどうかを 1 つの経路で知らせる。結合範囲は覆うセルを全部含む。通知は書き込みの後（貼り付けは選択の移動の後）に出し、受け取った consumer が `setActiveCell` などを呼んでも上書きしない。`validateCell` で貼り付け全体を拒否したときは出さない（`cell-invalid` が出る）
  - **論点4（セルフレビューで足した）**: 素通しする印字キーの通知は、位置と理由を打鍵の時点で決め、出すのは打鍵の処理（後段のハンドラ・状態機械・textarea の既定動作）が済んだ後にする。その場で出すと、購読者がすぐ `setActiveCell` で入力できるセルへ動かしたときに、同じ打鍵が移った先のセルで入力を始めてしまう（E2E で再現）。通知は控えに積み、タイマー（setTimeout 0）・次のキーやポインタの処理の始め・その場で出す通知の前の、いちばん早い時に出す（Chrome はキー入力をタイマーより先に処理するので、タイマーだけだと次の打鍵の通知と順が入れ替わる。E2E で再現）。消費するキー・ダブルクリック・貼り付けなどは通知の直後に処理を終えるので、その場で出す
  - **論点5**: 選択式列の候補欄を開く操作（Alt+↓・検索つきの列の 1 回のクリック）と日付のカレンダーを止めたときは通知しない（consumer の部署別シートに選択式・日付の列がない。印字キー・F2・ダブルクリックは通知する。要れば別 DD）。日本語入力オンの打鍵は、読むだけのセルでは変換が始まらないので 1 打鍵で 1 回
  - **render**: 列・行・セルの背景と結合範囲の重ね塗りを `render/src/background-bands.ts` へ切り出した（`base-layer.ts` はサイズのガードの超過 1,105 行を増やせないため。1,046 行に減り baseline を更新）

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | 行データの `cellBackgrounds` で指定したセルだけがその色で描かれる。行・列の背景より勝ち、状態表示（黄・赤）には負ける。`setRows` で変えると描き直る | vitest（render の重ね順・grid の置き場）・E2E（`cell-backgrounds.spec.ts` の実ピクセル） |
| 2 | 読むだけのセル（列・行・セル単位・結合・表全体の readOnly）で、印字キー・Delete・F2・ダブルクリック・貼り付け・切り取り・範囲の消去をすると、`edit-blocked`（範囲の一部なら `cells-skipped`）が位置と操作つきで1回だけ届き、文書は変わらない | vitest（keyboard・edit-blocked）・E2E（`edit-blocked.spec.ts`） |
| 3 | 入力できるセルの編集・`setRows`・リモートの変更・移動キーでは届かない | vitest・E2E（リモートの変更は通知の経路を通らないことをコードで確認） |
| 4 | 公開の型・React の写像（必要なら）・CHANGELOG・`apps/showcase/src/features.json` がそろう | typecheck・`npm test` |

## タスク一覧

### Phase 1: 範囲を決める（Human Spec Gate）

- [x] 論点1〜6 をユーザーと確定し、決定事項に書く（公開 API の細目は決定事項と quick-start に書き、contract.md は作らない）
- [x] 🔬 机上検証: 決定事項・受け入れ基準・Risk Class の欄が食い違わない

### Phase 2: 実装と検証（Phase 1 の後）

- [x] K8 描画: render `background-bands.ts`（列・行・セルの背景・結合範囲の重ね塗り）、`base-layer.ts` のフック `cellBackgroundsInRow`
- [x] K8 置き場と注入: grid `cell-background.ts`・`standalone-session.ts`（行データ）・`mount/lifecycle.ts`（`setCellBackgrounds`・boot 前の queue）・`mount/base-layer-options.ts`（描画への橋渡し）・`mount-controller.ts`・公開型 `GridCellBackgroundRow`。react の ref handle `setCellBackgrounds`
- [x] K11: grid `mount/edit-blocked.ts`（通知の組み立て）・`mount/keyboard.ts`・`mount/pointer.ts`・`mount/edit-commands.ts`・`mount/cell-lock.ts`（飛ばしたセルを集める）・公開型 `GridCellRef`・`GridEditBlockedInput`・`GridEditBlockedReason`
- [x] 🔬 単体: render 6 件・grid（keyboard 8・edit-blocked 14・standalone-session 14・lifecycle 3）・react 1
- [x] 🔬 E2E: playground `cell-backgrounds.spec.ts`（2）・`edit-blocked.spec.ts`（4）
- [x] 🔬 機械検証: `typecheck`・`typecheck:consumer-strict`・`lint`（boundary・size）・`test`・`build` が成功する（公開 .d.ts の snapshot は追加だけを確かめて更新）
- [x] Codex high のレビューと対応（`DD-069/codex-review-result.md`。P2×2 を採用して修正）
- [ ] alpha.23 を pack し、manifest と内容を検査する

### 完了前チェック

- [ ] 受け入れ基準を1項目ずつ照合（未達成は理由を、人手の確認が残るものは確認していない範囲をログへ — guides.md §3）
- [x] 📄 現在形の文書へ反映 — 対象: `doc/quick-start.md`（mount・行データ・イベントの手引き）・CHANGELOG・`apps/showcase/src/features.json`
- [ ] 😈 セルフレビュー1巡
- [ ] 🔬 全回帰1回（`npm test` → 全パス）

## ログ

### 2026-11-08

- 起票（consumer 駆動・hiroshima-keikaku DD-001-28）。hiroshima-keikaku の DD-001-27 で合意した部署別シートの見せ方のうち、表の部品に機能がなかった5つを、consumer のユーザーが DD-001-28 で判断し、K8（セルごとの背景色）と K11（読むだけのセルへの入力の通知）を持ち込むことにした。論点1〜6 は推奨案で、Human Spec Gate 待ち。実装は未着手
- Human Spec Gate: ユーザーが「推奨で進めて」と指示 → 論点1〜6 を推奨案で確定。実装で詰めた細目（論点3 は推奨案から変えた）は決定事項へ
- 実装: K8 は render の背景の描画を `background-bands.ts` に切り出してセルの段を足し、grid に置き場（`cell-background.ts`）と注入（行データ・`setCellBackgrounds`）を足した。K11 は止める判断を変えずに、止めた所から `mount/edit-blocked.ts` を通して通知を出す（キー 2 段・ダブルクリック 5 か所・貼り付け／切り取り／範囲の消去）
- テスト: 単体（render 6・grid 32・react 1）と playground の E2E 5 件が成功。E2E は最初、色を見る点が文字に重なる・固定列の地の色が白でない・`setData` で文書のハッシュが変わる、というテスト側の誤りで 3 回落ち、見る点と確かめる順を直した（実装の変更なし）
- 文書: quick-start に 2 節、CHANGELOG に alpha.23、features.json の 2 項目。CHANGELOG の版の表に alpha.21（DD-067）・alpha.22（DD-068）の行が抜けていたので 1 行ずつ足した
- 機械検証: `typecheck`・`typecheck:consumer-strict`・`lint`・`build` は成功。`test` は公開 .d.ts の snapshot（`tests/contract/facade-surface.test.ts`・DD-028）だけが落ちた。差分が追加だけ（grid の公開型 4 つ・`GridEvent` の 2 種・`setCellBackgrounds`・`cellBackgrounds`、react の import 行に `GridCellBackgroundRow`）で削除が無いことを確かめて `-u` で更新した。公開 API への影響は追加のみ（`GridEvent` の union の拡張は CHANGELOG の Changed に記録）。更新後の全体実行は 1,726 件成功。`tests/tooling/size-guard-base-ref.test.ts` の準備（一時 git リポジトリの作成）が 10 秒の制限を超えて 1 回落ちたが、同時に doc-check を走らせた負荷によるもので、単体で再実行して成功（今回の変更と無関係・1 回目の全体実行でも成功していた）
- 実装をコミット（d98d9f5）し、Codex high にレビューを依頼（1 回目はセッションの終了で中断し、同じコミットで出し直した）
- セルフレビュー（Codex と並行）: 素通しする印字キーの通知をその場で出していたため、購読者がすぐ `setActiveCell` で入力できるセルへ動かすと、打った文字が移った先のセルに入る（E2E で再現: 移った先の編集中の文字が `z`）。打鍵の処理の後に出すよう直した。最初は setTimeout 0 だけで遅らせたが、E2E で次の F2・Delete の通知より後に届いた（Chrome はキー入力をタイマーより先に処理する）ため、控えに積んでタイマー・次のキーやポインタの処理の始め・その場で出す通知の前の、いちばん早い時に出す形にした。E2E（購読者がその場で `setActiveCell` しても文字が入らない）を足し、直す前の作りで落ちることを確かめた
- Codex の指摘（P2×2・どちらも妥当と判断して採用）:
  1. 表全体とセルの両方が読むだけのとき、最初の通知を受けた購読者がその場で `setReadOnly(false)` を呼ぶと、後の段（読むだけのセル）が同じ打鍵をもう一度知らせる → 上の遅らせる修正で素通しの経路は起きなくなったが、打鍵ごとに「知らせた」印（`KeyEnv.notice`）を通知の前に立て、どの段からも二度出さないようにした
  2. 変換中に `setReadOnly(true)` を呼ぶと、変換の終わりを待つ間も表全体の判定が先に効き、貼り付け・切り取りが変換中でも `edit-blocked` を出す（決定事項の「変換中は出さない」に反する）→ 選択中のセルへの通知（`atActive`・印字キーの控え）は、変換中・Navigation でない位相では出さない。止める動きと診断は変えない
  - どちらも単体テストを足し、直す前の作りで落ちることを確かめた
- 修正後の検証: playground の関連 E2E 88 件（DD-069 の 6 件と、読み取り専用・結合・貼り付け・状態表示・行背景・検証・React の読み取り専用）が成功。`typecheck`・`typecheck:consumer-strict`・`lint`（boundary・size）・`test`（1,738 件）・`build` が成功。公開 .d.ts の snapshot は `edit-blocked` の説明文の 3 行だけが変わったことを確かめて更新。版を 10 package とも `0.1.0-alpha.23` に上げた
