# DD-020: Clipboard（範囲選択・copy/paste・Undo）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-07-16 | 2026-09-03 | 完了 | 子DD 3本＋親 Phase 4（統合検証・計測・提供開始）完了。**Manual Gate M1〜M3 は未実施のまま、ユーザー判断でクローズ（2026-09-03）**＝残余（実 Excel の未知方言・実 IME）は §既知の未保証境界へ移送 |

```text
Risk Class: A（roadmap §1 指定・支配的リスク=Clipboard 原子性・競合）
Risk Triggers: 利用者入力（ペースト内容・既存セル値）を失う/サイレント上書きの可能性／OCC・rollback-replay 経路の利用拡大（SetCells batch）／常駐 textarea の clipboard イベント=IME 周辺／公開イベント語彙（エラー/競合コード）の追加
Human Spec Gate: required（フル委譲モード＝要確認①〜⑥を既定案付きで提示しオーケストレータが確定・本文に記録）
Codex: high（子DDごとに必須1回。protocol/永続化/IME状態機械の実質変更なし＝roadmap §2.2 L3 の xhigh 条件非該当。実装中に protocol 変更・状態機械の遷移追加が発生したら停止して xhigh へ昇格）
Manual Gate: あり（実 Excel ⇄ グリッド round-trip＋実IME 併用スモーク=正味10分・§Manual Gate。他は synthetic E2E で自動化）
External Review: なし（Phase 境界・ADR 転換・Go/No-Go に非該当。ChatGPT レビューは手動運用方針）
Evidence Level: full（A区分=L5。OCC 競合マトリクス・再現コマンド・event trace・既知の未保証境界を省略しない）
```

> アプローチ: 親=標準（アンブレラ管理・統合検証）。子DDで混在: DD-020-1=E2E駆動（選択UIの振る舞い）／DD-020-2=TDD＋E2E（parser・型変換・原子性・OCC）／DD-020-3=TDD＋E2E（Undo条件ロジック）。

## 目的

外部アプリ（Excel 等）⇄ グリッド間およびグリッド内の copy/cut/paste と Undo/Redo を、範囲選択 → clipboard parser → 型変換 → **原子的 SetCells**（部分適用しない）→ OCC（beforeRevision 照合）の一貫経路で提供する。大量明細入力（Stage 2 consumer の中核ユースケース）を成立させる。

## 背景・課題

- 正典: roadmap §1 DD-020 行（Risk Class A・Stage 1 予約番号）・stage2-backlog §1 DD-020 項（DD-013 依存・OCC 原子性）。SDK 機能先行フェーズ（roadmap §2 順序入替・2026-07-16）: DD-028 CI 常設済み → **本DD** → DD-021 行操作 → DD-027 列タイプ。CI は push ごとに checks+e2e が回帰検証する。
- 既存実装の実調査（2026-07-16・本DD起票時）:
  - **範囲選択**: `packages/selection/src/selection.ts` に矩形幾何（`rangeFromAnchorFocus`/`rangeContains`）は実在するが、UI は単一セル選択のみ（`packages/grid/src/mount-controller.ts` の `selection` は `singleCell()` でのみ設定。pointerdown にドラッグ矩形なし・`packages/ime/src/navigation.ts` に Shift+矢印拡張なし）。
  - **原子 SetCells・OCC**: `packages/core/src/operations.ts` の `SetCellsOperation`（全件適用 or 全件拒否=I-5・`beforeRevision` セル単位）と `packages/core/src/validate.ts` の `stale-cell-revision`（全違反列挙=原子性 reject details）が実装・検証済み（DD-013）。「貼り付けも同じ Operation 表現へ寄せる」は計画書 §7.5 で確定済み。
  - **型変換**: `packages/core/src/cell-input.ts` の `parseCellInput`（文字列→number/date/string・正準化・DD-012-1）が正本。clipboard 側はこれへ委譲すれば型システムと整合する。
  - **Undo/Redo**: 全パッケージ未実装（grep 0件）。`packages/core/src/apply.ts` は `InverseSeed`（逆値+削除行メタ）を返すが、`packages/collab/src/session.ts` は `emptyInverseSeed()` で捨てている＝Undo 材料の保持機構が無い。
  - **clipboard イベント処理**: 未実装。`packages/ime/src/editor-state-machine.ts` の EditorEvent に paste/copy 種別なし。計画書 §11.2 は「Navigation の paste → Command execution」・§11.5 は copy/cut/paste を常駐 textarea の監視対象と定義。
  - **確定経路**: 共同編集=`ClientSession.submitLocalOperation`（楽観適用・rollback/replay・Conflict Queue・rejected イベント）／単独=`StandaloneSession`（`GridBackend` 共通契約・DD-024）。cell-commit 通知は SetCells batch 単位（`GridCellCommitChange[]`）で複数セル対応済み＝貼り付けは既存契約のまま通知できる。
- 課題: (a) 選択状態の所有者設計（activeCell は editor-state-machine が所有・選択レンジは所有者不在）、(b) 貼り付け原子性と OCC reject 時の UX（入力を失わない）、(c) 計画書 §15.2 のサーバー主導 undoRequest と Stage 2 consumer（単独グリッドモード・サーバー無し）の不整合。

## 検討内容

### D1 Undo 方式（計画書 §15 との整合が論点）
- 案A: 計画書 §15.2 どおり undoRequest/undoAccepted プロトコル新設（サーバーが検証）→ protocol 変更・server 実装大・**単独グリッドモード（サーバー無し）に別経路が必要**・Stage 2 consumer は単独モードのため主経路が使えない。
- 案B（採用）: **クライアント主導・補償 SetCells**。Undo スタックはクライアントが確定単位（transactionId）ごとに逆値＋確定時 revision を保持し、Undo は逆値を beforeRevision 付き SetCells で submit する。既存 OCC（stale-cell-revision）が「対象セルがその後変更されていない」条件（計画書 §15.4）をセル単位で自然に検証し、違反時は既存 reject 経路で通知（強制 Undo なし=R-07 対策と一致）。protocol・server・永続化の変更ゼロ。単独/共同の両モードで同一機構（`GridBackendSession.submitLocalOperation` 経由）。§15.1「文書全体を巻き戻さない・補償 Operation を新たに生成」と整合。undoRequest プロトコル（サーバー側ログ検証）は共同編集の高度 Undo が必要になった段階の将来課題として境界化する。

### D2 貼り付け範囲の決定（Excel セマンティクスの採用範囲）
- 貼り付け先=選択範囲の左上アンカーから matrix 行×列。例外: **matrix 1×1 かつ複数セル選択中 → 選択範囲全体へ敷き詰め**（Excel 頻出・実務価値大）。一般タイル展開（2×2→4×4 繰り返し）は対象外（将来拡張）。
- 行/列端をはみ出す場合: **全体拒否＋通知**（サイレント切り捨て=実質部分適用をしない）。「不足行の自動挿入」は DD-021（行操作）完了後の拡張課題として既知制約に記録。

### D3 大量貼り付け上限（計画書 §1.3 意図的未確定 → 本DDで確定・R-08・ADR-020）
- 上限 **100,000 セル**（超過は実行前拒否＋通知・`packages/core/src/protocol-limits.ts` へ定数化＝client/server 同値共有）。性能実測は 10,000 セル（§21 目標: ローカル適用 250〜500ms）。transport は現行 inline JSON のまま（10 万セル TSV ≒ 数 MB・ws 既定上限内）。payload 参照方式（ADR-020 Open）は上限内 inline で不要＝ADR-020 へ「Stage 2 は inline＋セル数上限」の判断を追記して解消する。

### D4 対象データ・clipboard 形式
- **値のみ**（書式 copy/paste はセル書式モデル=DD-027-3 のスコープ・backlog §3.5 で確定済み）。
- 読み取り: `text/plain`（TSV 方言: タブ区切り・CRLF/LF・`"` 引用・引用内改行/タブ/連続引用=エスケープ）。Excel 系が書く text/plain を fixture 化して parser を検証（fuzz: 引用・改行・巨大文字列=計画書 §20.2）。text/html 解析は対象外（text/plain で round-trip 成立）。
- 書き出し: `text/plain`（TSV・改行/タブ/引用を含むセルのみ `"` 引用）。セル値は表示文字列（cell-commit の value と同じ round-trip 規約）。

### D5 clipboard イベントと IME 不変条件
- copy/cut/paste は常駐 textarea の ClipboardEvent で受ける（計画書 §11.5）。**Navigation 位相のみ** Command 化（範囲 copy/cut/paste）。Editing/Composing 位相はブラウザ既定動作（textarea 内のテキスト編集）へ任せ、composition 中の value/selection に介入しない（I-3 維持）。editor-state-machine には位相問い合わせ（`getPhase()`）だけで依存し、**状態遷移の追加はしない**（最小侵襲。遷移追加が必要と判明したら停止して Codex xhigh へ昇格=Risk Class ヘッダ）。IME 不変条件スイートへ「composition 中 clipboard 干渉なし」ケースを追加。

### D6 選択状態の所有者
- 選択レンジ（anchor/focus）は activeCell 移動（Shift+矢印）と不可分のため、activeCell 所有者（editor-state-machine）との整合設計が必要。所有者を状態機械内に置くか、grid 層の selection-controller として外に置くかは **DD-020-1 の実装前詳細化（📐）で確定**する（Phase 0 詳細化判定=要）。Presence への選択共有（selectionRanges 送信）は DD-019 スコープ＝本DDはローカル選択のみ。

### 子DD分割（過積載防止=DD-005/009 教訓。guides.md L1 分割シグナル該当: 主要な状態所有者が複数変わる／Codex 2回以上必要／AC を独立検証・リリース可能）
| 子DD | スコープ | アプローチ | 主対象 |
|---|---|---|---|
| DD-020-1 範囲選択・範囲クリア | ドラッグ矩形選択・Shift+クリック/Shift+矢印拡張・選択描画・範囲 Delete（blank 敷き詰め SetCells=原子 batch 経路の土台） | E2E駆動 | `packages/selection`・`packages/grid/src/mount-controller.ts`・`packages/ime` |
| DD-020-2 clipboard copy/cut/paste | TSV parser・型変換・copy/cut 書き出し・paste=原子 SetCells＋OCC・上限・敷き詰め・エラー語彙 | TDD＋E2E | `packages/core`（parser）・`packages/grid`（配線）・`apps/playground/e2e` |
| DD-020-3 Undo/Redo | 確定単位 Undo スタック・補償 SetCells・条件付き拒否・Redo・新操作で Redo 破棄 | TDD＋E2E | `packages/grid`（undo-stack）・`packages/collab` 連携 |

## 決定事項

- D1〜D6 を採用。**要確認①〜⑥は 2026-07-16 に全項目既定案どおり確定**（フル委譲モード・オーケストレータ確定。§要確認に確定値を記載・各子DDの決定事項へ転記済み）。子DD 3分割（DD-020-1〜3・letter 枝番禁止）で実装し、本DDは子スコープの確定・統合検証（性能・実機 Manual Gate・機能カタログ更新）を担うアンブレラとする。
- 子DD本文は起票済み（実装は 020-1 → 020-2 → 020-3 の順・各子DDに引き継ぎ物を明記）: `doc/archived/DD/DD-020-1_範囲選択.md`・`doc/archived/DD/DD-020-2_clipboard.md`・`doc/archived/DD/DD-020-3_UndoRedo.md`。Manual Gate は本DD Phase 4 に集約（子DDは synthetic E2E まで）。
- 公開面への影響: ペースト競合は既存 `rejected`（GridConflict）経路を使い、上限超過・範囲はみ出しは **公開エラー/競合コードの語彙追加のみ**（`packages/grid/src/error-codes.ts`・内部型を露出しない=R7 維持）。mount options・GridInstance のシグネチャ変更なし想定。API 型 snapshot（DD-028 常設）に差分が出たら CHANGELOG へ記録（0.x deprecation policy 準拠）。

## 要確認（**全項目 確定済み 2026-07-16**・フル委譲モード=オーケストレータが既定案どおり確定。確定値は各子DDの決定事項へ転記済み）

1. **要確認①: 貼り付け上限セル数** — 確定（2026-07-16・既定案どおり）: **100,000 セル**（超過は実行前拒否＋通知）。根拠: 大量明細（数万行×数列）を妨げず、R-08（WS/DB 圧迫）を定数1つで防げる。性能保証は 10,000 セル（§21）で実測し、上限側は「動作するが性能目標対象外」と明記。
2. **要確認②: 行/列端をはみ出す貼り付け** — 確定（2026-07-16・既定案どおり）: **全体拒否＋通知**。根拠: 切り捨ては実質部分適用（原子性の精神に反しサイレント欠落を生む）。行自動挿入は DD-021 完了後の拡張課題として記録。
3. **要確認③: Undo 方式** — 確定（2026-07-16・既定案どおり）: **クライアント主導・補償 SetCells（D1 案B・protocol 変更なし）**。根拠: 単独/共同の両モードで同一機構・既存 OCC が条件付き Undo（計画書 §15.4）を自然に実現。計画書 §15.2 undoRequest プロトコルからの方式変更を含むため明示確認とする。
4. **要確認④: cut の提供** — 確定（2026-07-16・既定案どおり）: **提供する**（copy＋範囲クリアの合成・即時クリア）。Excel の「移動」セマンティクス（貼り付け時に元を消す）にはしない。根拠: 範囲クリア（DD-020-1）の増分が小さく業務頻出。
5. **要確認⑤: 書き出し形式** — 確定（2026-07-16・既定案どおり）: **text/plain（TSV）のみ**。根拠: Excel は text/plain を受理し round-trip が成立。text/html 書き出しは将来拡張。
6. **要確認⑥: Undo スタック仕様** — 確定（2026-07-16・既定案どおり）: **深さ100・自分の操作のみ（計画書 §15.1）・セッション内（reload で消える）・対象=セル確定/貼り付け/範囲クリア**（行操作 Undo は DD-021 以降=計画書 §15.3 MVP後リスト通り）。ACK 前（pending 中）操作の Undo は ACK 確定まで不可とする。

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | ドラッグ/Shift+クリック/Shift+矢印で矩形範囲を選択 → 選択範囲が描画され activeCell と整合する | DD-020-1 E2E |
| 2 | 範囲選択して Delete → 範囲全体が 1 SetCells で一括クリア（原子）される | DD-020-1 E2E＋unit |
| 3 | グリッド内 copy→paste round-trip → 値と型（number/date/string）が保持される | DD-020-2 E2E（実 Clipboard API・grantPermissions） |
| 4 | Excel TSV 方言 fixture（引用・セル内改行・CRLF・空セル・巨大文字列）→ parser が正しく解析する | DD-020-2 unit＋fuzz |
| 5 | 貼り付けは全成功/全失敗。他クライアントが範囲内セルを先に変更 → 全体 reject・文書無変更・rejected 通知（サイレント上書きなし） | DD-020-2 unit＋2クライアント収束テスト |
| 6 | 上限超過・範囲はみ出しの貼り付け → 実行前拒否・公開コードで通知される | DD-020-2 unit＋E2E |
| 7 | 1×1 copy → 複数セル選択して paste → 選択範囲全体へ敷き詰め | DD-020-2 E2E |
| 8 | Ctrl+Z → 直前操作（確定/貼り付け/クリア）が補償 SetCells で戻る。他者が後続変更したセルを含む場合は拒否通知（強制 Undo なし）。Ctrl+Y で Redo・新規操作で Redo スタック破棄 | DD-020-3 unit＋E2E |
| 9 | 単独グリッドモードの paste/undo → cell-commit（SetCells batch 単位）が発火し利用側保存契約（DD-024）が成立する | DD-020-2/3 standalone E2E |
| 10 | composition 中の clipboard 操作がドラフト・textarea を破壊しない（IME 不変条件維持） | 不変条件スイート＋synthetic E2E |
| 11 | 10,000 セル paste のローカル適用 250〜500ms 以内（計画書 §21） | **充足**（Phase 4 headed 計測・2026-07-17。median 50.0ms≪500ms・`paste-perf.spec.ts`・再現コマンドは Phase 4 タスク参照） |
| 12 | 実 Excel ⇄ グリッド round-trip（数値・日付・改行セル）が実機で成立する | Manual Gate M1/M2（**未実施＝ユーザー判断でクローズ 2026-09-03**。synthetic は実 Excel ペイロードの fixture 注入で代替済み・残余は §既知の未保証境界） |

## タスク一覧

### Phase 0: 事前精査
- [ ] 📋 **各Phaseのタスク精査・詳細化**
  - 受け入れ基準が検証可能な形（操作 → 期待結果）で書かれているか
  - 受け入れ基準の各項目に検証方法（機械検証・E2E・エビデンス）が対応しているか
  - 各タスクに対象ファイルパスが明記されているか
  - 各タスクの変更内容が具体的か（before/after または操作手順）
  - 各Phaseに🔬機械検証タスクがあるか（コマンド + 期待結果）
- [ ] 📐 **実装前詳細化トリガー判定**（判定結果: DD-020-1 → 要〔選択所有者の設計=状態遷移変更・3ファイル超〕／DD-020-2 → 要〔新規モジュール・公開語彙追加・並行処理=OCC〕／DD-020-3 → 要〔新規状態所有者=Undo スタック・データ上書き可能性〕。各子DDの冒頭 📐 で実施）
- [ ] 🧑‍⚖️ **Codexレビュー要否判定**（判定結果: DD-020-1〜3 → 各**必須・effort: high**〔TDD/E2E 対象・入力検証・並行処理=OCC 利用。protocol/永続化/状態機械の実質変更なしのため xhigh 非該当。発生時は昇格〕／親 Phase 4 → 不要〔子で計3回実施済み・統合差分は計測とカタログのみ〕）
- [ ] 😈 **Devil's Advocate調査**
  - このアプローチの欠点・リスクは何か？（クライアント主導 Undo の限界=他クライアントからの Undo 不可・ログ検証なし。TSV 方言の取りこぼし。上限値の妥当性）
  - 他に有力な選択肢はないか？（undoRequest プロトコル=案A・text/html 対応）
  - 将来壊れやすくなるポイントはないか？（行操作=DD-021 導入時の選択再ベース・Undo 対象拡大。数式=DD-022 導入時の formulaText 貼り付け）

### Phase 1: DD-020-1 範囲選択・範囲クリア（実装は子DD参照）
- [x] 子DD起票: `doc/archived/DD/DD-020-1_範囲選択.md`（2026-07-16。要確認①④⑥確定値を決定事項へ転記済み・自己完結）
- [x] DD-020-1 の全Phase完了確認（2026-07-17 完了。案X=selection-controller・Codex high 2件反映・親AC1/2 充足=E2E S1〜S8。引き継ぎ物=`selection-controller.selectedRange`・`range-ops.buildRangeClear`＋`SETCELLS_MAX_CELLS`・公開語彙 `range-too-large`）
- [x] 🔬 **機械検証**: `npm run test && npm run typecheck && npm run lint` → 全 green（2026-07-17: 876 unit・boundary new=0。CI も push で検証）

### Phase 2: DD-020-2 clipboard copy/cut/paste（実装は子DD参照）
- [x] 子DD起票: `doc/archived/DD/DD-020-2_clipboard.md`（2026-07-16。要確認①②④⑤確定値を決定事項へ転記済み・parser 仕様・敷き詰め・語彙・fixture 方針を含む）
- [x] DD-020-2 の全Phase完了確認（2026-07-17 完了確認。TSV parser/serializer・原子paste/cut Command＋OCC・親AC3〜7/9(paste)/10 充足。Codex high 2件＝P2 standalone rejected契約統一で反映／P1 画面外textarea不達は全キー入力共通の既存境界で見送り。引き継ぎ物=確定単位 chokepoint `submitSetCells`・公開語彙 `paste-too-large`/`paste-out-of-bounds`）
- [x] 🔬 **機械検証**: `npm run test && npx playwright test`（apps/playground） → 全 green（DD-020-2完了時点: 93 files/924 tests・playground E2E 42・showcase 3・invariants 46・boundary new=0）

### Phase 3: DD-020-3 Undo/Redo（実装は子DD参照）
- [x] 子DD起票: `doc/archived/DD/DD-020-3_UndoRedo.md`（2026-07-16。要確認③⑥確定値を決定事項へ転記済み・補償 SetCells・条件付き拒否・ADR ドラフトは同DD Phase 2 タスク）
- [x] DD-020-3 の全Phase完了確認（2026-07-17 完了。クライアント主導・補償SetCells＝undo-stack.ts＋chokepoint配線・親AC8/9(undo)充足。Codex high 5件全反映（P1a逆値view化／P1b実行前OCC検査／P1c setData時clear／P2a同期reject記録漏れ／P2b cellKey NUL区切り）。ADR-0024起票。既知制約「クリア/貼り付けの Undo なし」解消）
- [x] 🔬 **機械検証**: `npm run test && npx playwright test` → 全 green（DD-020-3完了時点: unit 947件・playground E2E 49・showcase 3・invariants 49・typecheck/lint boundary new=0）

### Phase 4: 統合検証・提供開始（本DDで実施）
- [x] 10,000 セル paste の headed 計測（`apps/playground/e2e/paste-perf.spec.ts`・AC11・2026-07-17）。**実測: 1,000行×10列=10,000セル・5 run で min 31.3ms / median 50.0ms / max 70.8ms**（§21 目標 250〜500ms を大きく下回る）。計測対象=ローカル楽観適用（parse→buildPaste→submitLocalOperation の同期処理・再描画は含めない=frame 予算は DD-004/012-2 で別担保）。**再現コマンド**: `npx playwright test --config apps/playground/playwright.config.ts paste-perf --headed`（webServer は config が自動起動＝50,000行×200列シード）。回帰ガードは median<2,000ms で常設。
- [x] 統合回帰: `npm run test`（947）＋`npm run test:invariants`（49）＋`npm run lint`（eslint＋boundary new=0）＋`npm run typecheck`＋contract（facade-surface .d.ts snapshot・migration dry-run=11）→ 全 green。**API 型 snapshot 差分なし**（子DD時点で `GRID_CONFLICT_CODES` の語彙追加を snapshot 反映済み・Phase 4 で新規差分ゼロ）。
- [x] `apps/showcase/src/features.json` の clipboard エントリを status=available へ更新（summary/source/meta 更新＋demo リンク新設。`apps/showcase/src/demo/scenarios.ts` に `clipboard` シナリオ追加。features smoke 6 green・showcase demo e2e 3 green）。
- [x] `CHANGELOG.md`・`doc/DD/DD-017/error-codes.md` へ公開語彙追加を記録（**確認**: 子DD実装時に `range-too-large`/`paste-too-large`/`paste-out-of-bounds`/`undo-blocked`/`redo-blocked` の全5語彙が両文書へ記載済み＝Phase 4 は網羅確認で充足）。
- [x] `doc/adr/`: **ADR-0020 を新設**（`doc/adr/0020-large-operation-inline-transport.md`・Status: Accepted）。「Stage 2 は inline＋セル数上限100,000・payload 参照方式は不採用」を D3 の決定として記録。計画書 ADR 台帳 ADR-020 行（Open→Accepted）・決定台帳 D-11/D-12・DOC-MAP も同期更新。
- [x] 🔬 **機械検証**: `bash scripts/doc-check.sh` → 整合 OK（`doc/spec/` の空ディレクトリ参照＝git 非追跡で fresh checkout に不在の潜在破れを「未作成」明記で恒久解消）／features smoke green。
- [x] 😈 **DA批判レビュー**（下記「DA批判レビュー記録」§Phase 4 に記録）。
- [x] Manual Gate M1〜M3 の受付（AC12）→ **未実施のままユーザー判断でクローズ（2026-09-03）**。M1〜M3 は実行していない＝合格の証拠はない。残余リスク（実 Excel の未知方言・実 IME 併用）は §既知の未保証境界へ移送し、事象が出たら別DDで起票する。

## Manual Gate（synthetic 自動化を最大化・ユーザー実機は正味10分）

**synthetic で自動化する範囲**（Playwright 実ブラウザー・CI 常設）: グリッド内 copy/paste round-trip は `context.grantPermissions(['clipboard-read','clipboard-write'])` で実 Clipboard API を read/write（完全自動）。Excel 方言 paste は実 Excel の text/plain ペイロードを fixture 化して注入（完全自動）。OCC 競合・原子性・上限・Undo 条件・IME 干渉は unit＋2クライアント＋synthetic E2E（完全自動）。

**ユーザーにしか出来ない残余**（=「実 Excel が書く実ペイロード」と「実 IME」のみ）:

| # | 項目 | 正味 |
|---|------|------|
| M1 | 実 Excel → グリッド貼り付け（数値/日付/セル内改行の3パターン） | 5分 |
| M2 | グリッド → 実 Excel 貼り付け（行列分離の確認） | 3分 |
| M3 | 実 IME 変換中の clipboard 干渉なしスモーク | 2分 |

> **結果: M1〜M3 は実施しないまま、ユーザー判断で 2026-09-03 にクローズ**（DD-005 Phase 5 と同じ扱い＝実機ゲートなしクローズ）。合格の記録ではない。下記 §既知の未保証境界に残余として記載する。

## 既知の未保証境界（2026-09-03 クローズ時点）

- **実 Excel が書く実ペイロードでの round-trip は未検証**（AC12・M1/M2）。synthetic は「実 Excel の text/plain を書き起こした fixture」（`packages/core/src/__fixtures__/clipboard-tsv/`）で代替しており、fixture に無い方言（別バージョン・別ロケール・書式付きセル）で paste が崩れる可能性が残る。
- **実 IME 変換中の clipboard 操作は未検証**（M3）。synthetic E2E＋IME 不変条件テストでは干渉なしを固定済みだが、実 IME 候補ウィンドウ下での copy/cut/paste は実機確認していない。
- 上記はいずれも「出たら別DDで起票」扱い。DD-020 の機能自体は features.json で available 化済みのため、利用者報告が最初の検知経路になる。

## ログ

### 2026-07-16
- DD作成（dd-auto・フル委譲モード=仕様確認ゲート省略の明示指示・要確認①〜⑥は既定案付き）。
- 既存実装の実調査を「背景・課題」へ記録: SetCells 原子性（I-5）・OCC（stale-cell-revision）・InverseSeed・parseCellInput は既存資産。範囲選択UI・clipboard parser・Undo スタックは未実装（Undo は全パッケージ grep 0件・session.ts は emptyInverseSeed で逆操作を破棄している）。
- 子DD 3分割を決定（guides.md L1 分割シグナル: 状態所有者が複数変わる／Codex 2回以上／AC 独立検証可能。DD-016/021 の先例と整合・letter 枝番禁止）。
- Codex 利用可否: 利用可能（codex-cli 0.144.2・`scripts/codex-review.sh --check` exit 0）→ 各子DDに Codex high 必須で組み込み。
- Playwright MCP: 本セッションでは未確認（起票専任）。エビデンスは常設 Playwright E2E ハーネス（`apps/playground/e2e`・スクリーンショット取得）で代替可能。実装セッションで MCP 可否を再確認する。
- **要確認①〜⑥ 全項目確定**（同日・フル委譲モード=オーケストレータが既定案どおり確定）: ①100,000セル上限 ②はみ出し全体拒否 ③クライアント主導・補償 SetCells（ADR 記録は実装時=DD-020-3 Phase 2） ④cut 提供（移動セマンティクスなし） ⑤text/plain TSV のみ ⑥深さ100・自分のみ・セッション内・pending 中 ACK まで不可。
- **子DD 3本起票**（同日）: `DD-020-1_範囲選択.md`・`DD-020-2_clipboard.md`・`DD-020-3_UndoRedo.md`（各Risk Class 再判定=いずれも A・Codex high。確定値を各決定事項へ転記・実装順 020-1→020-2→020-3・引き継ぎ物明記・Manual Gate は本DD Phase 4 に集約）。タスク一覧 Phase 1〜3 を子DD参照形式へ更新。
- 子DD起票時の追加既定案（オーケストレータ確定対象・各子DD本文に記録済み）: (a) Undo 拒否エントリ=スタックから除去＋通知〔020-3〕 (b) Editing/Composing 中の Ctrl+Z=ブラウザ既定・グリッド Undo は Navigation のみ〔020-3〕 (c) Ctrl+A 全選択=対象外〔020-1〕 (d) 不整合列数 TSV の欠けセル=変更対象に含めない（skip）〔020-2〕。

### 2026-07-17
- **DD-020-1 完了**（Phase 1 消化）: 範囲選択（案X=grid 層 selection-controller・IME 状態機械無変更）＋範囲クリア（原子 SetCells・上限 100,000・公開語彙 `range-too-large`）。Codex high 2件（viewport 外ドラッグ境界・空レンジ走査ガード）反映済み。既知境界（own pending 混在範囲の全体 reject 等）は子DD本文に記録。引き継ぎ物は子DD §引き継ぎ物と本 Phase 1 チェック項目を参照。公開語彙追加は CHANGELOG・error-codes.md 記録済み（本DD Phase 4 の記録タスクは確認に読み替え）。
- 本DDのタスク一覧が子DD完了実態に追従していなかったため是正: DD-020-2/DD-020-3 とも実装・Codexレビュー・アーカイブ用ステータスは「完了」済みだったが、本DD側の Phase 2/3 完了確認チェックが未消化のまま残っていた。両方にチェックを入れ、AC充足・Codex findings・引き継ぎ物を要約転記（詳細は各子DD本文参照）。あわせてヘッダ ステータスを「検討中」→「進行中」へ修正（D1〜D6 決定済み・子DD 3本中2本実装完了は「起票〜方針決定前」に該当しない＝`doc/templates/guides.md` §3 語彙と不整合だった）。

### 2026-07-17（セッション再開・一時停止）
- 前セッションの引き継ぎメモを検証: `packages/core/src/clipboard-text.test.ts` の fixture 参照は DD-020-3 の付随修正（同日ログ参照）で `doc/archived/DD/DD-020-2/fixtures/` へ復旧済みで、`import.meta.url` 相対解決も実際には正しく（3階層上=リポジトリ直下）ENOENTは再現しなかった。ただし**アーカイブ済みDDフォルダの存続にテスト資産が依存する**構造は恒久的に脆い（doc/archived は文書スナップショットであり test fixture の置き場所として不適切）ため、fixture 一式（`.gitattributes`・`README.md`・`*.tsv` 5件）を `git mv` で `packages/core/src/__fixtures__/clipboard-tsv/` へ恒久化し、テスト参照をパッケージ内相対パスへ変更。🔬 `npx vitest run packages/core/src/clipboard-text.test.ts` → 24/24 green で確認。空になった `doc/archived/DD/DD-020-2/fixtures/` ディレクトリ（git 非追跡の残骸）は削除。
- 🔬 全体検証: `npm run typecheck && npm run lint && npm run test && npm run build && bash scripts/doc-check.sh` → 全 green（947 tests・boundary new=0）。
- **本セッションはユーザー指示でここまで**（区切り良く停止・DD記載/不要ファイル削除/コミット漏れ解消を実施）。**次回再開時の入口**: 本DD Phase 4（10,000セル paste headed 計測・`apps/showcase/src/features.json` の clipboard/undo を available 化・CHANGELOG・ADR-020 追記・doc-check・DA批判レビュー・Manual Gate M1〜M3 受付）から着手 → 本DDクローズ・アーカイブ。その後はロードマップ順で DD-021（行操作・3分割）→ DD-027（列タイプ体系・3分割）。

### 2026-07-17（セッション再開・Phase 4 実施＝確認待ちへ）
- **入口の前提整備**: fresh checkout ゆえ `node_modules` 不在 → `npm install`（257 packages・0 vuln）。副作用の `package-lock.json` churn（npm 11 が peer フラグを再正規化するだけ・解決バージョン不変・DD 無関係）は `git checkout` で revert。
- **Phase 4 統合回帰**: `npm run test` 947 / `test:invariants` 49 / contract 11（facade-surface .d.ts snapshot＝**API 差分なし**・migration dry-run）/ `typecheck` / `lint`（eslint＋boundary new=0）すべて green。
- **AC11 headed 計測**（新設 `apps/playground/e2e/paste-perf.spec.ts`）: 1,000行×10列=10,000セルを常駐 textarea への合成 paste で 5 run 計測。**min 31.3ms / median 50.0ms / max 70.8ms**（§21 目標 250〜500ms を大きく下回る）。計測対象はローカル楽観適用の同期処理（parse→buildPaste→submitLocalOperation）。値ベース検証（ACK 非依存）＋回帰ガード median<2,000ms を常設。当初 pending 件数ベースの検証が ACK 到着と競合して flaky だったため値ベースへ是正、scroll+click 座標ズレで anchor が狂ったため可視域先頭アンカーへ是正（2 度の修正で安定）。
- **提供開始**: `features.json` clipboard を available 化（summary/source/meta 更新＋demo リンク）＋`demo/scenarios.ts` に `clipboard` シナリオ新設。features smoke 6 green・showcase demo e2e 3 green（全シナリオ開閉テスト含む）。
- **公開語彙**: CHANGELOG [Unreleased]・`doc/DD/DD-017/error-codes.md` に DD-020 の5語彙が子DD時点で記載済みを確認（Phase 4 は網羅確認で充足）。
- **ADR-0020 新設**（`doc/adr/0020-large-operation-inline-transport.md`・Accepted）: 「Stage 2=inline＋セル数上限100,000・payload 参照方式は不採用」を D3 決定として記録。計画書 ADR 台帳（ADR-020: Open→Accepted）・決定台帳（D-11 Paste上限=100,000確定／D-12 transport=inline確定）・DOC-MAP を同期。
- **doc-check 恒久是正**: DOC-MAP が参照する `doc/spec/` は git 非追跡の空ディレクトリで fresh checkout に不在（履歴上一度も追跡内容なし＝以前は local 残骸で偶然 green だった潜在破れ）。SDK フェーズは対象画面が無いため「未作成」明記（画面を持つ DD-026 以降で作成）で解消 → doc-check green。
- **DA批判レビュー**: §Phase 4 に6件記録（計測範囲の透明性・spec の前提依存・回帰ガードの安定性・カタログ数値の腐り〔別DD〕・Manual Gate 残余・ADR 射程）。ブロッカーなし。
- **残**: Manual Gate M1〜M3（ユーザー実機・正味10分）を「確認待ち」で保持。受付後に本DDをクローズ・アーカイブ（子DD 3本＋添付も同時移動）。次ステップはロードマップ順で DD-021（行操作・3分割）を dd-auto 起票。

### 2026-07-17（paste-perf のテスト分離是正・DD-021 全スイート検証で発見）
- `paste-perf.spec.ts` は共有文書の行 2〜1010×列 1〜10 へ 5 万セルを書き込むため、後に実行される spec（セル初期値を前提にする `undo-redo-collab` UE-8 等）を汚染することが DD-021 レビュー後の**全スイート実行**で表面化（UE-8 が paste データ `400070` を拾って fail・分離実行は green）。`zz-paste-perf.spec.ts` へ rename し（workers:1・ファイル名昇順＝スイート最後に実行）、順序要件をファイル先頭コメントに明記。再現コマンド（`... paste-perf --headed` パターン一致）は従来どおり有効。全スイート 67 pass で解消確認。

### 2026-09-03（クローズ・アーカイブ）
- **ユーザー判断で DD-020 を完了扱いにしクローズ**（「DD-020, 021 も完了扱いにしていいです」）。**Manual Gate M1〜M3 は実施していない**＝AC12 は synthetic（実 Excel ペイロードの fixture 注入）までで、実機合格の証拠はない。残余は §既知の未保証境界へ移送した（DA批判レビュー §Phase 4 No.5「Manual Gate 残余」の対応を「⏭️確認待ちで保持」→「未実施のままクローズ・境界化」へ変更）。
- ステータス 確認待ち→完了。子DD 3本（DD-020-1/2/3）は先行アーカイブ済み。本DD本文をアーカイブへ移動。
- 🔬 `bash scripts/doc-check.sh` green・`bash scripts/dd-index-gen.sh` 再生成。

---

## DA批判レビュー記録

### Phase 4 DA批判レビュー（2026-07-17）

**DA観点:** 統合検証・提供開始 Phase で「計測の妥当性」「新設エビデンスの脆さ」「カタログ/文書の腐り」は壊れやすい。

| # | 発見した問題/改善点 | 重要度 | 再現手順（高/中は必須） | DA観点 | 対応 |
|---|-------------------|--------|----------------------|--------|------|
| 1 | paste-perf の計測対象は「ローカル同期適用」であり再描画（rAF）を含まない。AC11 の文言「ローカル適用」とは一致するが、利用者体感（描画完了まで）とは別物。混同すると「50ms で描画まで終わる」と誤読されうる | 中 | spec/DDに計測範囲を明記しないと誤読 | 計測範囲の透明性（何を測っていないか） | ✅spec冒頭コメント＋DD Phase4＋ADR-0020に「再描画は含めない=frame予算は別担保」を明記 |
| 2 | paste-perf.spec は固定アンカー行(2,4,6,8,10)と 200列シードに依存。シード形状（playwright.config の dev:integration=50,000行×200列）が変わると壊れる | 低 | シードを小さくすると selectCell/paste が範囲外で失敗 | 前提の暗黙依存 | ✅spec に依存前提（可視域アンカー・Axis解決）をコメント化。シードは config 固定＝現状壊れない |
| 3 | 計測は in-browser wall-clock で、遅い CI では median が跳ねうる。厳密な 500ms ゲートにすると flaky 化 | 中 | 高負荷 CI で 500ms 超過→false negative | 常設テストの安定性 | ✅ゲートは回帰ガード median<2,000ms（目標の4〜8倍ヘッドルーム）。AC11 の evidence は実測値記録（DD）＝厳密ゲートにしない |
| 4 | features.json の `quality` エントリのテスト件数（835件/E2E 25本）が現状（947/49+）と乖離。DD-020 では未修正 | 低 | カタログ閲覧で古い数値を表示 | カタログの腐り | ⏭️別DD（DD-028=CI/品質の領域。本DD更新義務の対象は clipboard エントリのみ＝スコープ外。DD-028 系の棚卸しで是正） |
| 5 | Manual Gate M1〜M3（実 Excel/実 IME）は synthetic で代替不能ゆえ未実施のままクローズ準備。「実ペイロードの取りこぼし」が残余リスク | 中 | 実 Excel の未知方言で paste 崩れの可能性 | 自動化の限界（実機残余） | ⏭️確認待ちで保持（DD方針どおり）。受付後にアーカイブ＝宙吊りにしない |
| 6 | ADR-0020 を Accepted 化したが、上限超ユースケース（超巨大投入・添付・数式大量参照）の transport は未決 | 低 | 100,000セル超の要件化時に再設計要 | 決定の射程 | ✅ADR-0020「将来の再検討条件」に payload 参照方式の別ADR化を明記＝射程を限定 |
