# DDロードマップ（Phase 0 詳細＋Phase 1以降の方針）

> 正典 `nanairo_realtime_spreadsheet_development_plan_v1.md`（以下「計画書」）を、DD運用（1 DD = 1レビューサイクル）へ写像した**作業管理ドキュメント**。
> 本ファイルは下記3層構造の最上位＝管理層であり、**それ自体は実装DDではない**。
> ただしこの「最上位」は **DD作業管理上の最上位**を指す。文書体系全体では上位に製品戦略の正典＝製品憲章（`doc/product/nanairo_sheet_product_charter_v1.md`）と、技術方式の正典＝開発計画・基本設計（計画書）があり、本ファイルはそれらを実行単位（DD）へ展開する。DDの現在状態は `doc/DD/DD-INDEX.md` と各DDヘッダを正とする。

## DDの3層構造（2026-07-11 ユーザー提案で確定）

1. **ロードマップ**（本ファイル）: DD間の依存関係・実行順序・マイルストーン・Go/No-Go条件。作業管理用。
2. **個別DD**（`doc/DD/`）: 1レビューサイクルで完了する実装・検証単位。巨大な親DDは作らない。個別DDが肥大化したら、技術モジュールではなく**受け入れ基準を独立して検証できる単位**で分割する。
3. **ADR・仕様書**（`doc/adr/`・`doc/spec/`・`doc/decisions.md`）: DDをまたいで長期的に維持する設計判断と正式仕様。

## 基本方針: Phase 0 は技術リスク別、Phase 1以降はユーザー操作単位

- **Phase 0**: 成立性が不明な技術リスクを個別に潰すため、**技術領域ごと**にDDを分ける（下記 DD-001〜006）。
- **Phase 1以降**: 技術領域ごとに分け続けると「各モジュールは完成しているがユーザー操作としてつながらない」状態に陥る。そのため**「利用者が一連の操作を完了できる単位（縦切り）」**でDDを分ける（下記「Phase 1以降」参照）。

## DD化の原則

1. **1 DD = 1レビューサイクル**（`doc/templates/guides.md` §6）。
2. **Phase 0 の受け入れ基準は計画書 §18 の合格条件を流用**（既に「操作 → 期待結果」で検証可能）。
3. **PoC DDの成果物**（コードだけでなく）: 技術仮説／合格条件／計測結果／イベントトレース・試験証跡／既知の制約／ADRドラフト／Phase 1へ引き継ぐ設計注意事項。
4. **Phase 1以降の詳細DDはPhase 0のGo判定後に確定**する（計画書 §19。正式バックログ・性能SLOはPhase 0結果で確定）。
5. 実行は **1 DDにつき1モデル（Opus または Codex）で完走**、原則直列。完了報告を見たユーザーが必要と判断した場合のみ、もう一方のモデルへレビューを指示する（v7で dd-auto の自動振り分けは廃止）。コミットは各DDのユーザー確認後に `DD-{番号}: 概要`。

## Phase 0 DD一覧（技術リスク別）

> **🏁 Phase 0 完了（2026-07-12）**: DD-001〜007 すべて完了。DD-007 で Go/No-Go を **条件付きGo**（CG-1〜6 を解除条件）と判定し、Phase 1 正式バックログ（`doc/plan/phase1-dd-roadmap.md`＝Stage 1 SDK Alpha）を確定。全PoC DD（DD-001〜007）はアーカイブ済み（`doc/archived/DD/`）。**次は Phase 1（基盤判断DD → 単一利用者IME → … → Stage 1移行判定）**。
> DD番号は作成順＝実装順。状態列は作業管理用の目安で、**現在状態の正は `DD-INDEX.md`／各DDヘッダ**。

| DD | 題 | 内容（計画書対応） | 主な成果物・レビュー対象 | 状態 |
|----|----|-------------------|------------------------|------|
| DD-001 | 開発基盤・monorepo | npm workspaces、TS strict、`sheet-types`骨格、playground土台、test/typecheck/lint（§17・§26-1） | `npm run dev/test/typecheck/lint` が動く骨格 | ✅完了 |
| DD-002 | 日本語IME・常駐textarea | 20×10 Canvas＋常駐textarea＋生イベントrecorder＋実トレース採取→状態機械＋リモート更新シミュレーター（§18.1・§11） | 実IMEトレース、状態機械、合格判定（**実機手動試験含む**） | ✅完了（アーカイブ） |
| DD-003 | 共同編集・Operation収束 | `sheet-core`/`sheet-server-core`最小＋WS同期＋楽観適用rollback/replay＋Presence(3種+識別・TTL)＋2ブラウザーデバッグデモ（§18.3・§7・§8・§9） | ランダムOperation収束（hash一致）、ADR-005/008ドラフト | ✅完了（アーカイブ） |
| DD-004 | Canvas描画・仮想スクロール | 50,000行×200列、可変行高・列幅、固定行列、Presence overlay 20人、高DPI（§18.2・§12・§13） | fps・メモリ計測、scroll anchor検証、ADR-011ドラフト | ✅完了（アーカイブ・実機run overall=pass） |
| DD-005 | 統合PoC（IME・Canvas・共同編集） | DD-002 のIME＋DD-004 のCanvas描画＋DD-003 の共同編集クライアントを**一つのセル編集フロー**として結線し、下記の統合シナリオを実装・検証。textarea追従の ViewportTransform 統合（§13.5）を含む（§18.1〜18.3・§11） | 統合シナリオ成立の証跡（イベントトレース・試験証跡） | ✅完了（Phase 1〜4・Phase 5は実機なしでクローズ〔根拠記録〕） |
| DD-006 | データ表現・簡易数式 | CellStore方式比較、500k非空セル計測、formula parser最小＋固定ID参照＋依存グラフ、replay計測（§18.4・§6・§14） | 計測レポート、ADR-011/022ドラフト | ✅完了（AC1〜9合格・アーカイブ） |
| DD-007 | Phase 0 Go/No-Go判定・Phase 1正式バックログ | 各PoC結果・ADR・性能SLO（§21）・既知の制約を集約し、Go／条件付きGo／No-Go を判定。Goの場合 Phase 1 正式バックログを確定 | 判定一式＋Phase 1バックログ | ✅完了（条件付きGo・Phase 1バックログ確定・アーカイブ） |

### DD-005 の統合シナリオ（Phase 0 Go の必須条件）

各PoCが個別に通っても、統合時に問題が出る。Phase 0 で最も重要なのは、IME・Canvas・共同編集が**一つのセル編集フローとして成立する**ことであり、DD-005 は次の一連が成立することを実装・検証する:

```text
1. 利用者AがCanvas上のセルで日本語IME変換を開始する
2. 利用者Bが同じセルを更新・確定する
3. AのCanvasへリモート値と競合状態が反映される
4. Aの常駐textareaと未確定ドラフトは維持される
5. AがIME変換を確定してセルをCommitする
6. beforeRevision不一致として競合処理（reject）される
7. Aの入力内容はConflict Queueに保持される
8. 全クライアントとサーバーの文書状態が最終的に収束する
9. スクロール中も常駐textareaが正しいセルへ追従する
10. PresenceのactiveCell・selectionRanges・editingCellが正しく表示される
```

この統合シナリオが成立して初めて Phase 0 を Go とできる（判定そのものは DD-007 で行う）。

**DD-005 進捗（2026-07-12・作業管理メモ。現在状態の正は DD-INDEX/DDヘッダ）**: 案A（`packages/sheet-collaboration` 抽出）で **Phase 1**（抽出・git R100 byte-identical・362テスト green・`bbd7f49`）／**Phase 2**（統合ページ土台＝単一正本 ClientSession→DocumentView〔read-through Adapter〕→Canvas・headed 2タブ smoke で相互反映 PASS・`870e945`）／**Phase 3**（IME×共同編集結線＝IME状態機械再利用・cell-level beforeRevision・**上記シナリオ 1〜8＝AC2 中核を実ブラウザーで実証**〔#9 競合表示・reject→Conflict Queue→収束〕・`812c035`）完了・コミット済み。**Phase 4**（統合E2E 17テスト＝AC1〜4＋Presence＋順序A/B・Codex xhigh 5指摘→4修正＋1既知制約）完了。統合シナリオ10項目＋AC1〜4 が synthetic 込みで自動化・成立。**Phase 5（実機IMEゲート）はユーザー判断で実機テストなしでクローズ**（2026-07-12）: IME正しさは DD-002 実機4環境＋E2E順序A/B両方＋Codex で担保・状態機械を無改変再利用。残余（新アダプタ×実IME候補ウィンドウ・順序A/B記録）は低リスクゆえ **Phase 1 製品化＋DD-007 既知制約へ**。→ **DD-005 完了**。統合シナリオが実装＋自動E2E＋headed で成立＝**技術的に Phase 0 Go 相当**（最終判定は DD-006 完了後に DD-007）。**シナリオ 9（スクロール追従）・10（Presence 全種）と実IME（候補ウィンドウ・確定 Enter 順序 A/B）は Phase 5 ユーザー実機ゲートで最終確認**（DD-002 DA #11 の正式回収）。統合ブリッジ設計・状態所有権・既知制約は DD-005 本文「Phase 2/3 詳細設計・状態所有権」節を正とする。

### 旧DD-006の分割（2026-07-12 ユーザー確定）

当初のDD-006は「統合シナリオの実装・検証」と「Phase 0 最終Go/No-Go判定」の2つのレビュー単位を含み、1 DD＝1レビューサイクルの原則に対して大きすぎたため、DD-005（統合PoC）と DD-007（最終判定）へ分割した。あわせて統合PoCをデータ表現・数式（DD-006）より**先**に実施する:

- **DD-005（統合PoC）着手条件**: DD-002・DD-003・DD-004 完了（データ表現・数式は統合シナリオの必須依存にしない）。
- **DD-007（最終判定）着手条件**: DD-002〜DD-006 全完了（DD-006 の計測結果も揃えてから判定する）。

## 順序と依存

- DD-001 が全PoCの前提。以降は **DD番号順に実装**（＝DD-002 IME → DD-003 共同編集 → DD-004 Canvas → DD-005 統合PoC → DD-006 データ/数式 → DD-007 Go/No-Go判定）。
- **DD-002 を最優先**（IME＝R-01: 致命的×高がNo-Go条件の筆頭）。
- **DD-002 と DD-003 は領域分離**（playground vs packages/＋collaboration-server）で競合しない（計画書§19「Canvas/IMEとserver coreは並行可能」）。実装は直列だが、DD-002 のコミット後にユーザーが実機IME試験をしている間に DD-003 を実装するパイプラインで人間待ち時間を活用する。同一ツリーでの同時実装はしない（`package-lock.json` 競合・Codexレビュー差分の混線回避）。
- **DD-004（Canvas）は DD-002 と同じ playground・グリッド描画に触れる**ため DD-002 の後。**DD-005（統合PoC）は DD-002/003/004 完了が着手条件**、**DD-007（最終判定）は DD-006 のデータ/数式計測も含む全PoC完了が前提**（上記「旧DD-006の分割」）。
- **DD-002 はトレース先行方針**: 状態機械を机上で先に固定せず、最小の常駐textarea＋生イベントrecorderを先に作り、実IME（MS IME／Google日本語入力 × Chrome／Edge）のトレースを採取してから scenarios.md と状態機械を確定する。
- 途中のバグ修正・ツール整備は別DDとして随時割り込んでよい。

## Phase 1以降: ユーザー操作単位の縦切りDD

Phase 0 Go 後、技術モジュールではなく**利用者が完了できる操作単位**でDDを作る（各DDが Canvas・IME・共同編集・数式・Undo を縦に貫く）。

> **Phase 1 の実体計画は `doc/plan/phase1-dd-roadmap.md`（Stage 1 社内SDK Alpha までの縦切り計画・正式版）を正本とする**。DD-007 の **条件付きGo 判定（2026-07-12）＋ChatGPTレビュー（要修正）反映**で確定（採択記録＝`doc/archived/DD/DD-007/phase1-backlog.md`・条件 CG-1〜6 の担当DD対応を含む）。以下は方針の要約。

**最初のDDは「日本語でセルを連続入力し、確定値が共同編集で保存される」を製品パッケージとして完成させる**（2026-07-12 ユーザー確定）。以降の例:

- **日本語でセルを連続入力できる**: セル選択／常駐textarea／IME／Enter・Tab移動／SetCells化／サーバー保存／他クライアント反映／Undo登録
- **複数セルをコピー＆ペーストできる**: 範囲選択／クリップボード解析／型変換／SetCells原子的適用／競合判定／Undo／再描画／E2E
- **他ユーザーの位置を確認できる**: activeCell／selectionRanges／editingCell／displayName／colorKey／connection単位管理／Presence TTL／幽霊カーソル除去／Canvas overlay
- **行を追加・削除できる**: RowId／InsertRows・DeleteRows／tombstone／Canvas座標更新／数式参照維持／共同編集／Undo／再接続後の収束

### Phase 1以降の個別DDに必須とする項目

ユーザーが実現したい操作／対象範囲／対象外／変更するモジュール／状態遷移／Operation境界／共同編集時の競合／IMEへの影響／Undo・Redoへの影響／性能への影響／受け入れ基準／自動検証／手動検証／障害・競合シナリオ／DAレビュー／Codexレビュー／証跡／既知の制約／ADR・仕様書への反映要否。

**製品化観点（DD-008で追加。製品憲章 §26・§29 と整合）**: Phase 1以降の各DDでは、上記に加えて次の6観点を確認する。

1. **公開APIへの影響**（Command／Event／Options／Capabilities／Adapter／Plugin 契約に変更・追加があるか。憲章 §12）
2. **内部パッケージとFacadeパッケージの境界**（`@nanairo-sheet/{core,selection,…}` 等の内部を、利用者向け Facade（`grid`／`react`／`server-hono` 等）越しに漏らしていないか。憲章 §10）
3. **他プロジェクトからの再利用性**（特定案件・特定UI/DBへ結合せず、複数プロジェクトで再利用できるか。憲章 §16.1）
4. **Adapter・Pluginでの拡張性**（案件固有要件をコアへ混入させず、設定・Command・Event・Adapter・Plugin で実現できるか。憲章 §13・§29-3）
5. **Developer Experience成果物**（Quick Start／サンプル／型定義／エラーコード／Testkit 等、導入・診断のための成果物を同時に更新したか。憲章 §17）
6. **API互換性への影響**（Stable/Experimental/Internal 区分・破壊的変更・移行ガイド・schema/protocol version への影響。憲章 §12.4・§18）

> これらは Phase 1 着手時に `doc/templates/dd_template.md`（またはPhase1用の差分テンプレート）へ反映する。Phase 0 の残りPoC DDには遡及適用しない。

## 自動継続のルール（2026-07-11 ユーザー確定）

DD合意済みの範囲内では、以下は**ユーザー確認待ちで停止せず自動継続**する:

- 内部のファイル分割／関数・型の詳細化／テスト追加／リファクタリング／DA指摘への修正／Codexレビュー指摘への修正

以下の場合**のみ**停止してユーザー判断を求める:

- 受け入れ基準を変更する／対象範囲を追加・削除する／ユーザー操作を変更する／データ消失につながる競合仕様を変更する／ADRの基本方針を覆す／外部依存を新たに導入する／Go・No-Go判断が必要になる／明示的なユーザー実機ゲート（例: DD-002 実機トレース採取・受入試験）
