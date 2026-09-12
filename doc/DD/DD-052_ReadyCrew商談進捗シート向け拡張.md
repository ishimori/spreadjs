# DD-052: ReadyCrew 商談進捗シート向け拡張（consumer 駆動: ReadyCrew RC1〜RC14）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-12 | 2026-09-12 | 進行中 | consumer 駆動（ReadyCrew DD-124）。要件正本は ready_crew_db `doc/DD/DD-124/sdk-requirements.md`。Human Spec Gate完了・子DD-052-1〜5起票済み。子DD実装中 |

> アプローチ: 標準（アンブレラ。要件の範囲・API の形・子DD分割を決め、実装は子DDで行う）
> リスク: なし（認可・DBスキーマ・外部I/F・機密情報に触れない）
> 採番注記: `doc/plan/phase2-dd-roadmap.md` の予約番号 DD-030（consumer 統合② ReadyCrew）は使わない。DD-030 は開始前提に P-07 判断ゲートを持ち、位置づけ自体が DD-051 論点3 で審議中のため、機能要求の受け皿として新規 DD-052 で起票する（背景「roadmap との関係」）

```text
Risk Class: A（子DD-052-1 がエディター〔常駐 textarea・IME 状態機械〕の Enter 系キー処理を変える。子DD-052-2 は入力値の型変換を変える。他の子DDは起票時に再判定）
Risk Triggers: IME状態機械/textarea の変更（RC1・RC2）／操作仕様の変更（Alt+Enter が「確定＋下移動」から「セル内改行」に変わり既存 consumer へ波及）／データ消失の防止（RC12: 入力の自動型変換で元の文字列が失われる）／公開 API（mount オプション・GridEvent・ref handle）の追加（RC3〜RC6・RC12・RC14）
Human Spec Gate: required（論点1・3〜8。論点2 は 2026-09-12 ユーザー決定済み）
Codex: high（本DD＝文書。2026-09-12 に ready_crew_db DD-124 と合わせて実行。本DDへの指摘なし・要件メモへ RC12〜RC14 を追加）／実装は 2026-09-13 に子DD-052-1〜5＋DD-053 の全差分をまとめて xhigh 実施（7件指摘・全採用・詳細はログ）
Manual Gate: あり・クローズ非ブロック（M1 = 実 Microsoft IME で変換中・変換確定直後の Enter／Alt+Enter。子DD-052-1 で実施）
External Review: なし
Evidence Level: standard
```

## 目的

本番稼働中の社内アプリ ReadyCrew 案件DB の商談進捗シート（単独グリッドモード）で足りない機能について、要件メモ RC1〜RC14 に沿って扱う範囲・API の形・子DD分割を決め、子DDで実装して alpha 配布する。

## 背景・課題

- 要件の正本: ready_crew_db `doc/DD/DD-124/sdk-requirements.md`（RC1〜RC14・行番号つきの現状）。乖離したらメモ側が勝つ（DD-035・DD-050 と同運用）
- 2026-09-12 ユーザー決定: ReadyCrew の商談進捗へ Nanairo Sheet を本番導入し、長文列の編集まで行う。SDK で足りない機能は SDK を改良して応える（SDK を育てる意図）
- 経緯: 列タイプ体系（DD-027）は同じ商談進捗画面の相談（`doc/plan/stage2-backlog.md` §3.6・2026-07-15）が出所。今回はそれを実画面へ載せる段階で出た不足
- alpha.7 の現状（要点。詳細は要件メモの「現状」列）:

| RC | 要件 | 優先 | alpha.7 の要点 | 既存の計画 |
|----|------|------|---------------|-----------|
| RC1 | セル内改行の入力（Alt+Enter） | 高 | 編集中の Enter は `altKey` を見ず確定＋移動（`packages/ime/src/editor-state-machine.ts:281-289`） | dev plan Phase 5「セル内改行」（`doc/plan/nanairo_realtime_spreadsheet_development_plan_v1.md:1780`）。DD・backlog なし |
| RC2 | 長文の編集欄 | 高 | textarea は `rows=1`・セル矩形と同寸（`packages/grid/src/integration-editor.ts:125-145,197-202`） | なし |
| RC3 | セル単位の読み取り専用（mount 後に変更可） | 高 | 列・行単位のみ・mount 固定（`packages/grid/src/readonly-policy.ts:79-114`） | サーバー側の行権限は将来スコープ（backlog §3.7 H7） |
| RC12 | 文字列として保つ列（型変換しない） | 高 | `parseCellInput` が日付→数値→文字列の順に変換し、`09012345678` は `9012345678` になる（`packages/core/src/cell-input.ts:113-131`）。`cell-commit` の値も変換後 | なし |
| RC4 | 行単位の部分更新／Undo を消さない再注入 | 中 | `setData` は全置換で Undo を消す（`packages/grid/src/mount-controller.ts:3126-3128`） | なし |
| RC5 | 列見出しのクリック通知 | 中 | 見出しの pointerdown はイベントなし（`packages/grid/src/mount-controller.ts:1313-1316`） | sort/filter は dev plan Phase 4・ADR-018 Open |
| RC6 | セルのホバー通知 | 中 | pointermove はイベントなし（`packages/grid/src/mount-controller.ts:1135-1210`） | tooltip 層は dev plan の設計のみ |
| RC13 | `onCellCommit` 内の `setData` 後に拒否した操作が Undo に残る | 中 | `submitToBackend`（単独モードは内側で `cell-commit` を同期発火）の後に `recordUndoEntry`（`packages/grid/src/mount-controller.ts:1679-1681`） | なし（貼り付け経路は購読者の `setData` を想定＝同 2213-2218） |
| RC14 | 行の追加・削除だけを無効にする設定 | 中 | 単独モードで Ctrl+Shift++／Ctrl+- が行を増減（`packages/grid/src/mount-controller.ts:2997-3026`）。止める手段は `readOnly`（全編集停止）のみ | なし |
| RC7 | select の value/label 分離 | 低 | `options: readonly string[]`（`packages/grid/src/column-types.ts:25`） | 当初設計（dev plan ~580-585）・未計画 |
| RC8 | 2段見出し | 低 | `columnCaptions` のみ（DD-033 D4 で対象外） | DD-033-2「複数実案件で要求されたら別DD」 |
| RC9 | セルのクリック通知（link 以外） | 低 | `link-open` のみ（`packages/grid/src/index.ts:118`） | なし |
| RC10 | 確定前の検証フック | 低 | 通知のみ（`packages/grid/src/index.ts:96-100`） | なし |
| RC11 | Vite 8 での導入 | 低 | SDK は Vite 6・広島モックは Vite 7 で検証 | consumer（DD-124 Phase 2）が結果を返す |

- roadmap との関係:
  - `phase2-dd-roadmap.md` は ReadyCrew を統合②（予約 DD-030・S2-1 の2件目）に置き、開始前提を P-07 判断ゲートとしている。DD-051（検討中）の論点3 は統合②を広島へ差し替えて ReadyCrew を Stage 3 候補へ移す案、論点10 は Beta を目指す間はゲート作業を優先する案
  - 本DDの起票で「ReadyCrew が本番 consumer として SDK を使い始める」事実が加わる。**本DDは roadmap・DD-051 を改訂しない**。この事実は DD-051 の Human Spec Gate の入力としてユーザーへ提示する
  - P-07: 本DDの要求は宣言的 mount オプション・GridEvent・ref handle の追加で賄え、Plugin API を前提にしない（DD-051 論点4 (a) と矛盾しない）
- 製品化6観点（`doc/plan/dd-risk-class-header.md` §2）: ①公開API＝Experimental への追加（RC3〜RC6・RC12・RC14）と操作仕様の変更（RC1）②境界＝Facade（grid・react）経由のみ ③再利用性＝長文入力・文字列列・セル単位の読み取り専用・行操作の無効化・見出し/ホバー通知は業務表一般の要求で、ReadyCrew 固有の型を持ち込まない ④拡張性＝宣言的オプションと Event で実現 ⑤DX＝quick-start・features.json・CHANGELOG は子DDで更新 ⑥互換＝RC1 は既存 consumer（松下・広島）の Alt+Enter の挙動を変えるため、CHANGELOG の破壊的変更節に書く。RC12・RC14 は既定値で従来の挙動を保つ

## 検討内容（Human Spec Gate）

| # | 論点 | 選択肢 | 推奨と理由 |
|---|------|--------|-----------|
| 1 | 本DD群で扱う範囲 | (a) 高・中（RC1〜RC6・RC12〜RC14）を子DD化し、低（RC7〜RC11）は backlog 記録と consumer のつなぎで済ませる / (b) 高（RC1〜RC3・RC12）だけ / (c) 全部 | **(a)**。RC12 は入力値が黙って失われる。RC4〜RC6・RC13・RC14 は本番の使い勝手（Undo・並べ替え・全文確認・誤操作）に直結する。RC7〜RC10 はつなぎで実害が小さく、RC8・RC10 は既存の判断（DD-033 D4・通知のみの契約）を覆す根拠がまだ1案件分しかない |
| 2 | RC1 のキー | (a) Alt+Enter＝セル内改行（Excel と同じ。Enter は従来どおり確定） / (b) 折り返し列だけ Enter＝改行・Ctrl+Enter＝確定 / (c) RC2 の拡大した欄の中だけ改行可 | **(a)**。Excel 利用者の既定の操作で学習が要らず、列によってキーの意味が変わらない。Tier 1 は Windows のみのため Option キーは扱わない |
| 3 | RC1 を効かせる列 | (a) 全列 / (b) `wrapColumns` の列だけ（それ以外は従来どおり確定＋下移動） | **(b)**。改行が行として描かれるのは折り返し列だけで（`packages/render/src/text-cache.ts:14-15`）、他の列では入れた改行が見えない。既存 consumer の非折り返し列の挙動も変えずに済む |
| 4 | RC2 の形 | (a) 編集中の textarea を内容に合わせて下へ伸ばす（上限＋内部スクロール） / (b) 別ポップオーバーの複数行エディター（select/date と同じ枠組み） / (c) 編集開始を通知し、consumer 側のモーダルで編集 | **(a)**。IME の入力経路（常駐 textarea）を1本のまま保てる。(b) は IME 経路が2本になり状態機械の検証が倍になる。(c) は Canvas と外部 UI の同期と IME を consumer に負わせる |
| 5 | RC3 の形 | (a) 単独グリッドの行データ（`GridStandaloneRow`）に `readOnlyColumns?: string[]` を持たせ `setData` で更新 / (b) `isCellReadOnly(rowId, columnId)` の callback / (c) `readOnlyCells` を mount オプション＋ref で更新 | **(a)**。行データと同じ経路で変わり remount しない。(b) は描画・キー処理のたびに呼ばれ、憲章 §13.2 のフレーム予算契約が要る。(c) は行の増減への追従を consumer に負わせる。共同編集モードは対象外（権限は H7 と同じ将来スコープ） |
| 6 | RC4〜RC6 の形 | RC4: (a) `ref.setRows(rows)`（RowId で置換・追加し、置換セルに触れない Undo を残す） / (b) `setData` で値が変わらないセルの Undo を残す。RC5: `header-click{columnId}` イベント＋並べ替え中を示す表示オプション（並べ替え自体は consumer）。RC6: (a) `cell-hover{rowId,columnId,rect}`（出入りで発火・間引きあり） / (b) 組み込みツールチップ | RC4 **(a)**（差し替えの意図が API に出る）。RC5 **提示のとおり**（ADR-018 の sort/filter を先取りしない）。RC6 **(a)**（consumer が Markdown で描ける。(b) は描画を SDK が抱える） |
| 7 | 着手順と DD-051 との関係 | (a) RC1〜RC3・RC12 は DD-051 の結論を待たず着手し、RC4〜RC6・RC13・RC14 は論点10 の結論に従う / (b) すべて DD-051 の結論を待つ | **(a)**。RC1〜RC3・RC12 は本番 consumer の長文編集とデータ保全を塞いでいる。RC4〜RC6・RC13・RC14 はつなぎで運用できる |
| 8 | RC12〜RC14 の形 | RC12: (a) 列オプション `stringColumns: string[]`（入力・貼り付け・`setData` の値を変換しない。wrap・link と併用可） / (b) 列タイプ `{ type: 'text' }`（select/link/date と排他）。RC13: (a) 記録を通知の前へ移す / (b) `setData` 時に記録予定の Undo も破棄。RC14: `rowOperations?: boolean`（既定 true） | RC12 **(a)**（編集 UI の種類と直交し、選択式の自由入力の値も守れる）。RC13 **子DDで原因を確かめて決める**（通知前に記録すると通知中の再入で順序が変わる恐れ）。RC14 **提示のとおり**（既定で従来挙動） |

## 決定事項

- 2026-09-12 ユーザー: ReadyCrew 商談進捗への本番導入と、SDK の不足を SDK 改良で応える方針（背景）
- 論点2: **(a) Alt+Enter＝セル内改行を SDK 側で持つ**（2026-09-12 ユーザー決定。consumer にキー処理を実装させない）
- consumer（ReadyCrew）の対応環境は Chrome/Edge のみで可（2026-09-12 ユーザー確認）＝Tier 1 の拡大は求めない
- 2026-09-12 ユーザー: 「DD-052・DD-053 を連続実施、実装に迷ったら推奨案で決定」の指示。以降の論点1・3〜8 は表の推奨のとおり確定（推奨と異なる判断はなし）
- 論点1: **(a)**。高・中（RC1〜RC6・RC12〜RC14）を子DD化し、低（RC7〜RC11）は backlog 記録と consumer のつなぎで済ませる
- 論点3: **(b)**。RC1（セル内改行）は `wrapColumns` の列だけに効かせる。それ以外の列は従来どおり確定＋下移動
- 論点4: **(a)**。RC2 は編集中の textarea を内容に合わせて下へ伸ばす（上限＋内部スクロール）。常駐 textarea 1本の IME 経路を維持
- 論点5: **(a)**。RC3 は `GridStandaloneRow` に `readOnlyColumns?: string[]` を持たせ `setData` で更新
- 論点6: **RC4 (a)・RC5 提示のとおり・RC6 (a)**。RC4 は `ref.setRows(rows)`（RowId で置換・追加、置換セルに触れない Undo を残す）。RC5 は `header-click{columnId}` イベント＋並べ替え中を示す表示オプション。RC6 は `cell-hover{rowId,columnId,rect}`（出入りで発火・間引きあり）
- 論点7: **(a)**。RC1〜RC3・RC12 は DD-051 の結論を待たず着手する。RC4〜RC6・RC13・RC14 も本ユーザー指示（2026-09-12・DD-052/053 連続実施）により今回まとめて着手する — DD-051 論点10（consumer駆動DDとゲート作業の優先順位）は依然未決だが、これは「今後どちらを先に着手するか」の優先順位づけの論点であり、ユーザーが今回直接指示して着手済みの作業を事後的に後戻りさせる根拠にはならない。DD-051 論点10 の結論は本DD完了後に着手する将来の consumer 駆動 DD にのみ適用する
- 論点8: **RC12 (a)・RC13 は子DD-052-4 で原因を確認のうえ決定・RC14 提示のとおり**。RC12 は列オプション `stringColumns: string[]`（入力・貼り付け・`setData` の値を変換しない）。RC14 は `rowOperations?: boolean`（既定 true）
- 子DD分割（確定）: DD-052-1 長文セル編集（RC1・RC2・Risk A）／DD-052-2 文字列として保つ列（RC12・Risk A）／DD-052-3 編集の制限（RC3・RC14）／DD-052-4 再注入と元に戻す履歴（RC4・RC13）／DD-052-5 見出しクリックとホバーの通知（RC5・RC6）

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | 論点1〜8 の結論が決定事項に記録され、推奨と異なる判断には理由がある | Phase 1 目視 |
| 2 | 範囲に入った RC ごとに子DDが起票され、各子DDの補足に RC 番号と要件メモへの参照がある | Phase 2 `bash scripts/dd-index-gen.sh` 後の DD-INDEX 目視 |
| 3 | 範囲外の RC が `doc/plan/stage2-backlog.md` に出典・つなぎ・再検討条件つきで記録されている | Phase 2 `grep -n "RC7" doc/plan/stage2-backlog.md` |
| 4 | 子DDが完了するたびに alpha 配布され、要件メモの「取り込み結果」へ書ける引き渡し記録（版・変更点・つなぎの外し方）が子DDのログにある | Phase 3 目視 |

## タスク一覧

### Phase 1: Human Spec Gate
- [x] 論点1〜8 をユーザーへ提示し、結論を決定事項へ記録（2026-09-12・全論点推奨採用）
- [x] 🔬 機械検証: `bash scripts/doc-check.sh` → エラー0

### Phase 2: 子DD起票と backlog 記録
- [x] 論点1 の範囲で子DD（`doc/DD/DD-052-N_*.md`）を起票し、Risk Class ヘッダを子DDごとに判定（052-1・052-2=A／052-3・052-4・052-5=B）
- [x] 範囲外の RC を `doc/plan/stage2-backlog.md` §3.8 に記録（出典: ReadyCrew DD-124）
- [x] 🔬 機械検証: `bash scripts/dd-index-gen.sh`・`bash scripts/doc-check.sh` → エラー0

### Phase 3: 子DDの完了と引き渡し
- [ ] 子DDの完了・配布を確認し、本DDのログへ版と対応 RC を1行ずつ記録
- [ ] 🔬 機械検証: `ls doc/DD/ | grep DD-052-` → 0件（子DDがすべてアーカイブ済み）

### 完了前チェック
- [ ] 受け入れ基準を1項目ずつ照合（未達成があれば理由をログへ）
- [ ] 😈 セルフレビュー1巡（「どこが壊れるか」を探す。読み返す価値のある所見のみログへ。深掘りが要る場合の手法: doc/da-method.md）
- [ ] 🔬 全回帰1回（コード変更は子DDで回帰済みのため、本DDは `bash scripts/doc-check.sh` → パス）

## ログ

### 2026-09-12
- DD作成。ready_crew_db のセッションが起票を代行（要件メモは同セッションが alpha.7 のソースを読んで作成）。以後は spreadjs 側のセッションで進める
- Codex レビュー（high・ready_crew_db `doc/DD/DD-124/codex-review-result.md`。DD-124 と合わせて実行）: 本DDへの指摘なし（Risk A・IME 経路・DD-051 との書き分けは妥当）。consumer 側の指摘から RC12（型変換）・RC13（コールバック内 setData と Undo）・RC14（行操作の無効化）を要件メモへ追加し、本DDの表・論点1/7/8・子DD分割案へ反映
- ユーザー決定: 論点2 (a)（Alt+Enter＝セル内改行を SDK 側で持つ）。consumer の対応環境は Chrome/Edge のみで可＝Tier 1 の拡大要求なし
- Human Spec Gate（論点1・3〜8）を推奨案で確定。`doc/plan/stage2-backlog.md` §3.8 に RC7〜RC11 を記録。子DD DD-052-1〜5 を起票（`bash scripts/dd-index-gen.sh`・`bash scripts/doc-check.sh` 済み）。以降は子DDで実装を進める

### 2026-09-13
- ユーザー指示「DD-052・053 を連続で実施」に基づき、子DD-052-1〜5・DD-053 の実装を完了（各子DDのログ参照）。全回帰（unit 1356件・typecheck・consumer-strict・lint・E2E 218件）を確認した上で、実装差分全体（`e1d6553..HEAD`・6DD分）を対象に Codex CLI レビューを実施した
- **Codex レビュー**: `doc/DD/DD-052/codex-review-request.md`（依頼書。6DD分の背景・決定事項・重点確認観点を個別記載）／`doc/DD/DD-052/codex-review-result.md`（結果）。`bash scripts/codex-review.sh --base e1d6553 --effort xhigh`。指摘7件（P1×2・P2×5）、**全件を妥当と判断し採用・修正**。各指摘は該当子DDの実装ファイルを直接読んで再現条件を裏付けたうえで修正し、修正のたびに一旦 revert して回帰テストが実際に red になることを確認してから再適用した（false-positive のテストを残さない）
  1. [P1・DD-052-3] `syncCellLock()` の `hasReadOnlyCells()` 早期returnにより、readOnly 全解除後に textarea ロックが固着 → ガード除去
  2. [P1・DD-052-4] `setRows` が削除済み RowId を未知行と誤認し `rowOrder` に重複挿入 → `deletedRowIds` 集合で除外
  3. [P2・DD-052-2] `confirmSelect`/`confirmDate` が `stringColumns` を無視 → 両経路に `stringColumnStrings` 判定を追加
  4. [P2・DD-052-4] boot 前の `setRows`→`setData` 呼び出し順が起動処理内で逆転 → 単一の順序保存キューへ統合
  5. [P2・DD-052-4] `setRows` の Undo 記録が無関係な行の Redo 履歴まで全消去 → `recordProgrammaticOp`（重なるセルだけ個別に破棄）を新設
  6. [P2・DD-052-3] dblclick 入口が RC3 のセル単位 readOnly を判定せず編集textareaへ既存値が読み込まれる → `isReadOnlyCellIndex` 判定を追加
  7. [P2・DD-052-5] 範囲選択ドラッグ開始時に hover 終了（null）が発火せず開始セルの `cell-hover` が残留 → ドラッグ開始時に `updateCellHover(null)` を追加
- 全7件に対し回帰テスト（unit: `standalone-session.test.ts`・`undo-stack.test.ts`／E2E: `cell-readonly-row-operations.spec.ts`・`string-columns.spec.ts`・`set-rows.spec.ts`・`header-click-cell-hover.spec.ts`）を追加し、フル回帰（unit 1360件・typecheck・consumer-strict・lint）を再確認した（E2E フルスイートは別途確認）
- DD-053 が発見した既存バグ（K5・message storm）についても、独立した視点での確認を Codex へ依頼済み。結果: 「presence変更を戻した状態でも再現し、既存不具合という診断と整合」と確認（診断の妥当性を追認。修正は本レビューの対象外のまま `doc/plan/stage2-backlog.md` K5 に記録済み）
