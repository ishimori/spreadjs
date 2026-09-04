# DD 索引

> `bash scripts/dd-index-gen.sh` で自動生成。手動編集禁止。

## 進行中

| DD | 件名 | ステータス | 補足 |
|----|------|-----------|------|
| DD-043 | 複数文書serve | 完了 | consumer 駆動（松下 納入計画③の共同編集化 = 松下 DD-014-3〔年度単位の board 切替〕）。要件正本は松下リポ `doc/DD/DD-014/sdk-requirements.md` **§D**（DD-012 要件票 §A の U4 を置き換え）。将来制約の正本は **ADR-0025**（**Accepted**・実装で確定した細目を追記）。**実装・全回帰 green。実機検証は松下 DD-014-3 側** |
| DD-042 | 固定境界の見出し文字切れ | N/A |  |

## 保留・見送り

| DD | 件名 | ステータス | 理由 |
|----|------|-----------|------|

## 完了済み

| DD | 件名 | 主な成果 |
|----|------|---------|
| DD-041 | Presence枠タグのpane clip漏れ | 不具合修正。他ユーザーの activeCell 枠と名前タグを pane ごとの clip へ差し替えた（論点①=(a) で確定）。unit 5 件＋E2E 1 件で固定し、修正前は E2E で固定帯に 1,028 ピクセルの漏れ・修正後 0 を実測。Manual Gate M1 は E2E が自動化したため実機確認不要 |
| DD-040 | リリースmanifestのgitDirty判定 | manifest に `closureDirty` / `closureDirtyPaths` / `dirtyNote` を追加し、配布再現性を `gitDirty` と読み分けられるようにした。既存 `gitDirty` の意味は不変（後方互換）。AC 1〜7 全て実機で照合 |
| DD-039 | 固定ペインのヘッダーclip漏れ | consumer 駆動（松下 納入計画・生産納期の実機検証）。要件正本は松下リポ `doc/DD/DD-014/sdk-requirements.md` **§C 追補 C7**。`drawHeaders` の帯 clip の内側に pane 境界の入れ子 clip を張り、固定ペインの見出しにスクロール側の見出しが重なる不具合を解消。AC1〜7 充足・**追加テストが修正前コードで fail することを実証**（unit 3/4・E2E 2/2）・全回帰 green（unit 1216／E2E 154）・frameP95 は修正前後とも 16.8ms・**Codex medium findings 0**。M1 は未実施＝既知の未保証境界へ移送 |
| DD-038 | 貼り付け後の選択レンジ | consumer 駆動（松下 DD-016 のユーザー指摘）。要件正本は松下リポ `doc/DD/DD-016/sdk-requirements.md` **P1**。DD-020-2（クリップボード）の仕上げ。論点①は(a)＝selection の不変条件により技術的に強制（起票時の所見を否定）。AC 1〜13 全て充足。tarball 引き渡しは松下 DD-016 の追補が受け取る |
| DD-037 | 自由入力併存の選択式列 | consumer 駆動（松下 DD-012-3 の実機検証で判明）。要件正本は松下リポ `doc/DD/DD-012/sdk-requirements.md` **R8**。DD-027-1 の未達分の回収。論点①は(a)既定挙動変更を採用（CHANGELOG に破壊的変更として記載）。Manual Gate T1（実 IME での絞り込み）は未実施＝既知の未保証境界へ移送 |
| DD-036 | 固定列・列背景・行readOnly | 松下 DD-014（納入計画のSpreadJS化）からの持ち込み。契約=`DD-036/contract.md`・計測=`DD-036/measurement.md`。Codex high の P2×4 を全反映。Manual Gate T1/M1 は未実施＝既知の未保証境界へ移送 |
| DD-035 | 列タイプ拡張と命令API | 日付列（カレンダー）・readOnlyColumns・scrollToRow/setActiveCell・React handle 4 メソッド＋列スキーマ props 6 点を提供。AC1〜9 充足・Codex high P1×1/P2×3 全反映・全回帰 green（unit 1155・E2E 123＋3）。T1/M1 は事後に実 IME 代行で全 PASS（順序B×10）。ユーザー確認済みでアーカイブ（2026-09-03） |
| DD-034 | DD運用軽量化第2弾 | 記録git一本化・親統合レビュー1回・完了処理1コミット・ガバナンスDD凍結・IME台帳一本化・dd-update停止を反映。効果測定はDD-033へ移管 |
| DD-033 | 明細閲覧ビュー | readOnly・columnCaptions・columnDisplayFormats を提供。AC1〜10充足・統合レビューP2×2修正・計測回帰なし・M1/M2/T1全PASS（実IME証明） |
| DD-033-1 | 表示専用モード | readOnly mount オプション＝2層抑止（入口＋chokepoint）。AC1〜7充足・全回帰green(1077件)・IME系3ファイル無改変。レビュー/M1/T1は親Phase 3集約 |
| DD-033-2 | 列見出し表示書式 | 親=DD-033（子2本の第2子）。ヘッダーの業務名置換＋数値/日付の Canvas 描画整形（契約不変=raw 維持）。機械検証 green まで完了（AC1〜10 充足・全回帰 green）。親 Phase 3 で統合レビュー・M2・headed 計測 |
| DD-029-1 | KPI計測契約 | 承認①②済（2026-07-16）・kpi-ledger.md 新設・Codex high 7件全反映（見送り0）。契約確定＝DD-026 起票可能 |
| DD-028 | 継続回帰CI・API差分監視 | CI常設（Actions 2job・連続4run green）・API型snapshot=公開宣言closure・migration dry-run常設test・deprecation policy 3層（P-10/D-006）・IME実機台帳常設。835 test/E2E 25 green・Codex high P2×2 全反映 |
| DD-027 | 列タイプ体系 | 列タイプ体系（選択式・リンク・書式・auto-fit）を提供開始。子3本＋親 Phase 4 完了（統合回帰 全 green・features/demo・P-07 材料提出・Manual Gate 代行受付・T1 非該当）。ユーザー確認済みでアーカイブ |
| DD-027-1 | 選択式入力列 | 親=DD-027（子3本の第1子）。選択式入力列（候補ドロップダウン・commit 前検証・allowFreeText）を実装。Fable 5 レビュー反映（P2×5＋P3×5）・親 Phase 4 統合検証 全 green。親と共にアーカイブ |
| DD-027-2 | ハイパーリンク列 | 親=DD-027（子3本の第2子）。ハイパーリンク列（link-open イベント・候補追跡方式・defaultOpen）を実装。Fable 5 レビュー反映（P1×1/P2×3/P3×4）・親 Phase 4 統合検証 全 green。親と共にアーカイブ |
| DD-027-3 | セル書式モデル | 親=DD-027（子3本の第3子）。セル書式モデル（背景色・バッジ・auto-fit・共有化設計文書）を実装。Fable 5 レビュー反映（P2×2/P3×4）・親 Phase 4 統合検証 全 green・headed 計測（書式起因の回帰なし）。親と共にアーカイブ |
| DD-026 | consumer統合①松下生産納期 | consumer を松下 生産納期へ変更（D-007）。U1〜U3 を server-hono 公開 API として提供（DD-026-1〜3）。新規テスト 25 件・全回帰 green・Codex xhigh P1×3/P2×2 全反映・公開型 snapshot 追加のみ。consumer 実機（2 ブラウザ収束・JWT 拒否・再起動復旧）と KPI-1/5 は未実施＝既知の未保証境界（松下 DD-012-2 で実施） |
| DD-026-1 | ストア注入と初期文書 | U1 成立: `serve({ oplog, snapshotStore, initialDocument })`・snapshot format v2（jsonb 可・v1 互換）・bootstrap@0。stores 9 件＋単体 5 件 green・Codex xhigh P1×2 反映（append 直列化 fail-stop／非有限数・非正準 date の拒否／bootstrap@0 接続ごと受理） |
| DD-026-2 | 認証フック | U2 成立: `serve({ authenticate })`（null=401・throw=500・identity で actorId/presence を上書き）。auth 5 件 green・Codex xhigh P2×2 反映（診断から hook の message を除去／認証待ち socket を stop で破棄） |
| DD-026-3 | サーバー起点操作 | U3 成立: `ServerInstance.submit(setCells, { actorId })`（通常受理経路・clientId 'server' 予約・reject は結果で返す）。submit 5 件＋grid own-echo 1 件 green・Codex xhigh 指摘（並行 append 直列化・値検証）は 26-1 側で反映 |
| DD-025 | ReactFacade | 全Phase完了・Manual Gate実機OK（IME確定→onCellCommit・再注入・再mount正常・console clean） |
| DD-024 | 単独グリッドモード | 単独グリッドモード成立（判別union・cell-commit通知のみ・mount時＋setData再注入・案B backend）。814 test/E2E 18 green・Codex high 3件全反映・見送り0・**実機確認OK（ユーザー 2026-07-16）＝AC1〜8 充足** |
| DD-023 | Stage2ロードマップ策定 | phase2-dd-roadmap 正式版昇格（S2-1〜6 ゲート・DD-024〜032 採番・命名/P-07 ゲート）＋stage3-outlook 新設。突合3点全OK・Codex high 10件全反映・見送り0・ユーザー承認2回 |
| DD-021 | 行操作 | 全AC充足・K3/K4/P2-1 回収。Fable 5 レビュー（Codex 代替）全反映。Manual Gate M1〜M2 はユーザー指示で Claude 代行（実 MS-IME SendInput 実駆動・台帳5点込み・ime-manual-gate-ledger 記録済み）。PR #1 統合時に別PC側の台帳・画像証跡を回収。P2-1 実測: 50k行+Insert×1,000=128ms |
| DD-021-1 | 行操作Command公開API | 親=DD-021（3分割の第1子）。実装・全検証 green・**Fable 5 レビュー（Codex high 代替・ユーザー決定）P2×2/P3×1 反映済み**。2026-09-03 アーカイブ（親 DD-021 も同日クローズ＝Manual Gate 未実施のままユーザー判断） |
| DD-021-2 | 行操作収束・競合 | 親=DD-021（3分割の第2子）。実装・全検証 green・**Fable 5 レビュー（Codex high 代替・ユーザー決定）P1×1/P2×2/P3×4 反映済み**。2026-09-03 アーカイブ（親 DD-021 も同日クローズ＝Manual Gate 未実施のままユーザー判断） |
| DD-021-3 | 選択再ベース・性能 | 親=DD-021（3分割の第3子）。K3 回収・Undo 生存整合・P2-1 Θ(N²) 是正。実装・全検証 green・**Fable 5 レビュー（Codex high 代替・ユーザー決定）P2×1/P3×2 反映済み・maxSlot 全経路/replay 決定性は無欠陥確認**。2026-09-03 アーカイブ（親 DD-021 も同日クローズ＝Manual Gate 未実施のままユーザー判断） |
| DD-020 | Clipboard | 全AC（1〜12）充足。Manual Gate M1〜M3 はユーザー指示で Claude 代行（M1/M2=実 Excel COM・M3=実 MS-IME SendInput 実駆動・ime-manual-gate-ledger 記録済み）。PR #1 統合時に別PC側の台帳・画像証跡を回収。実測: 10,000セル paste ローカル適用 median 50ms |
| DD-020-1 | 範囲選択 | 親=DD-020（3分割の第1子）。AC1〜8 充足・Codex high 2件反映済み。実機統合確認は親 Phase 4（アーカイブは親完了時にオーケストレータが実施） |
| DD-020-2 | clipboard | AC1〜10 充足・Codex high 2件（P2 反映/P1 既存境界）。chokepoint=`submitSetCells`。実機統合は親 Phase 4（アーカイブは親完了時） |
| DD-020-3 | UndoRedo | 親=DD-020（3分割の第3子）。全AC充足・Codex high 5件反映。ADR-0024 起票。実機統合は親 Phase 4（2026-09-03 アーカイブ。親 DD-020 も同日クローズ＝Manual Gate 未実施のままユーザー判断） |
| DD-018 | Stage1移行判定 | **総合判定=Stage 1 移行 可（Alpha 宣言可・ユーザー承認済 2026-07-15）**。S1-1〜6 全合格・CG-1〜6 全終端・cg-ledger 全CG終端化・stage2-backlog.md 新設。K7 は子DD DD-018-1（非ブロッカー=ユーザー承認・着手は別途判断）。Codex 証拠監査 high 4件全反映 |
| DD-018-1 | documentId-persistenceDir-failfast | documentId 不一致（snapshot＋全 oplog entry）＋封筒 revision 相互検査＋restoreFrom×persistenceDir 排他の3 fail-fast で **DD-014 既知制約 P2-3/P2-4 回収**。全検証 green（738 pass）・Codex high 2件全反映・見送り0。AC1〜3 充足 |
| DD-017 | Alpha配布・診断 | S1-6 充足（pack tarball 配布正式化・release automation・CHANGELOG・Quick Start・診断API・CG-4 実測記入・ADR-0015 Accepted）。Codex(high) 8件全対応・test 730 green。コミット 889b903。派生 flake は DD-017-1 で恒久是正済み |
| DD-017-1 | ルートbuild間欠flake是正 | 親=DD-017。真因=html-inline-proxy の cwd casing 不一致（決定的バグ）。vite.config.ts input を realpath 正準化で恒久是正・ルート build 8/8 green。コミット 8fe7148。知見は engineering-patterns #5 へ昇格 |
| DD-017-2 | SDK紹介サイト・機能カタログ | 紹介サイト＋動作デモ6シナリオ（apps/showcase・Facade のみ・boundary baseline追加0）。features.json 一元化＋更新義務を AGENTS.md へ常設・dev-start --showcase 統合・5分デモ台本。全🔬green（744 test・e2e 3本・起動200）・Codex medium P2×2 全反映・見送り0。AC1〜7 充足・ユーザー承認 2026-07-15 |
| DD-016 | Facade・実consumer統合 | 案Y 2分割＝アンブレラ化。**DD-016-1＋DD-016-2 完了**（Facade実装・物理抽出・S1-3実証・CG-1統合後スモークPASS・CG-6精密メモリPASS〔redraw境界化〕）。AC1〜8 全充足。DD-012 アンブレラ（AC2/AC4）クローズ可。派生=DD-016-3（ナビ修正）。要確認①〜⑤ 確定済 |
| DD-016-1 | Facade実装・物理抽出 | 親=DD-016（案Y 2分割）。公開API固定・ime/selection/render抽出・grid/server-hono Facade・collaboration-server昇華・baseline 41→10。**720 test＋8 E2E＋R7漏洩0**。Codex xhigh 6 findings 反映（P2-1 consumer-harness は DD-016-2 委譲・見送り0） |
| DD-016-2 | 独立consumer実証・統合後実機スモーク | 親=DD-016（案Y 2分割）。**AC1〜5 全充足＝完了**: Phase 0/3（S1-3 実証・pack closure・再mount leak なし）＋Phase 4 実機ゲート — **CG-1 統合後スモーク PASS**（Chrome6＋Edge3＝9 sessions・先頭欠落0・順序B）＋**CG-6 精密メモリ PASS**（peak 65.3MB≪300MB・純減リークなし・`--enable-precise-memory-info` flag run／redraw は境界化=上限明示）。cg-ledger CG-1/CG-6 解除済。DD-012 アンブレラ（AC2/AC4）クローズ可。派生=DD-016-3（ナビ修正）。P2-1委譲反映済 |
| DD-016-3 | アクティブセルキーボードナビ・focus保持scroll-follow | 発見元=DD-016-2 CG-1 実機テスト中（ユーザー報告）。**「今すぐ軽く修正＝DDは後追い記録」方針（2026-07-14 ユーザー）**。既存バグ（DD-016-1 リグレッションではない）＋未実装機能を修正。実機ドライブ（Playwright）＋ユーザー実機確認で green |
| DD-015 | reconnect・catch-up・idempotency | **CG-5 解除**（D27/D34回収）。exactly-once reconcile・catch-up閾値・指数バックオフ・イベント契約・fault injection常設化。732 pass/Codex xhigh 3回反映/実ブラウザーheaded smoke green。ユーザー承認済 |
| DD-014 | 永続化・snapshot復元 | サーバー側（durable ACK・snapshot format v1・100k復旧≦1s・O(N²)回避・fail-fast）＋**子DD DD-014-1 でクライアント snapshot bootstrap・durable frontier/poisoning を実装し CG-3 解除**（AC1〜9 充足・ADR-0023 Accepted）。P2-1（行操作Θ(N²)=DD-021）・P2-3/P2-4（異常構成エッジ）は既知制約。roadmap §4/§5 |
| DD-014-1 | クライアントbootstrap・durable整合 | 親=DD-014。Codex xhigh P1 findings（P1-3〜P1-7）を解消し **CG-3 解除**（DD-014＋DD-014-1）。join bootstrap(document@frontier)・durable frontier/barrier/poisoning・ADR-0023 Accepted。**AC1〜AC8 充足・reload E2E green・bootstrap 4.8ms vs 全replay26s**・Codex 2巡目 P1×4 も全対応。P2-1/P2-3/P2-4 は親DD-014 既知制約。コミット済 |
| DD-013 | 共同編集同期・OCC | 同期/OCC harden（テスト実充足）・randomized収束スイート・Phase4 実WS 2タブ smoke PASS・Codex high 反映済 |
| DD-012 | 単一利用者IME縦切り | 案Y 2分割・両子DD完了アーカイブ済（DD-012-1＝CG-1解除／DD-012-2＝CG-6指標pass）。milestone残（ime/selection/render物理抽出・baseline縮退・CG-1統合後スモーク・CG-6精密メモリ）は**DD-016で確定＝完了**（DD-016-1 抽出・baseline縮退／DD-016-2 CG-1統合後スモークPASS・CG-6精密メモリPASS＋redraw境界化）。**AC2/AC4 充足＝本アンブレラ クローズ（2026-07-14）** |
| DD-012-1 | 入力縦切り | Phase 1〜4完了。型変換/date/ローカルOp/IME不変6項目/ADR-012/Codex＋CG-1解除済（実機PASS・先頭欠落0・順序B×Chrome/Edge）。実機で順序A不発（Chromium150）の知見を記録。抽出はDD-016委譲 |
| DD-012-2 | 性能縦切り | 親=DD-012（案Y分割）。CG-6 担当。**Phase2/3 指標計測完了**（Playwright: scroll p95 16.8ms・メモリ 24MB≪300MB pass／redraw over-budget=render無変更ゆえ回帰不能のアーティファクト）。予算常設化・計測ハーネス・Codex 完了。**定義的確定（CG-6精密・render抽出・clean redraw）は DD-016 委譲** |
| DD-012-3 | F2再編集キャレット位置IME確定バグ修正 | compositionend の base+data 近似上書きを sawCompositionInput で guard（キャレット位置保持）。S-C6/S-C7 追加・746 test＋invariants＋E2E 8本 green・Codex high findings 0・**実IME実機確認 OK（ユーザー 2026-07-15）＝AC1〜4 全充足** |
| DD-012-4 | 列幅行高リサイズ | ヘッダー境界ドラッグで列幅・行高変更（view-local・layout イベント＋mount 初期値で利用側保存→F5復元）。Codex high P1×1/P2×8 全反映・766 test/E2E 11 green・headed perf 回帰なし（DD-012-5 と同一 run）・**実機確認 OK（ユーザー 2026-07-15）＝AC1〜8 充足** |
| DD-012-5 | オーバーフロー表示折り返し自動行高 | オーバーフロー（右方向空セル延長・非空手前クリップ）＋列単位wrap＋自動行高（手動優先）。Codex high 4件反映/1件境界化・797 test/E2E 12＋3 green・headed perf 回帰なし（p95 16.8ms・redraw 境界12ms内）・**実機確認 OK（ユーザー 2026-07-15）＝AC1〜8 充足** |
| DD-011 | 基盤実装 | 要確認①〜④回答済。DD-011-1 完了前提で全Phase実装＋Codex(high)4件全対応。Facade skeleton・boundary lint(baseline 41)・不変条件runner・consumer harness雛形・Risk Classヘッダ新設。typecheck/lint(+boundary)/build/test:invariants/contract/consumer-harness green。差分テストflaky恒久是正。ws-convergence.smokeは環境依存flaky据え置き。コミット済 |
| DD-011-1 | packageリネーム | 実装完了（rename 5 package・66 renames＋import 全置換・dir==name 統一）・test 561/561・typecheck/lint/build green・Codex(medium) findings 0・旧名/旧dir 参照 0＋正典パッケージ名の現行構成整合。DD-011 の前提確定。コミット cbf7064系列（159d5e8） |
| DD-010 | 安定ID・CellStore移行 | 実装・テスト（561 green）・Codexレビュー反映（findings 4件全対応）・**CG-2 解除**（index→RowId slot間接・serialization/replay整合証拠）まで完了。**ADR-0011 は Codex レビューをもって Accepted 確定**（ユーザー判断 2026-07-13＝ChatGPT ではなく Codex で十分・AC6 性能 baseline 解釈も同承認に含む）。コミット cbf7064 |
| DD-009 | 基盤判断 | 成果物完成（台帳・境界・CG台帳・ADR）＋Codex反映済＋Q1〜Q7暫定確定。外部レビュー(ChatGPT)は保留・事後実施可（ユーザー決定で完了） |
| DD-008 | 製品憲章導入と文書体系同期 | 憲章Accepted・3層文書体系確立（D-004昇格）・5文書同期・Codex指摘4件全対応。コミット 6bfc2bd |
| DD-007 | Phase0GoNoGo判定 | **全Phase完了**（Phase 1 判定材料集約 → Phase 2 判定＝**条件付きGo**〔CG-1〜6・前提条件記録〕→ Phase 3 バックログ確定）。🔬doc-check green・😈DA 7所見・🧑‍⚖️Codex証拠監査6指摘全対応（見送り0）。Phase 3: `phase1-dd-roadmap.md` を採択→**ChatGPTレビュー（要修正）反映で正式版へ昇格**（Alpha必須ライン全面採用〔reconnect必須・Presence他除外〕・CG-1〜6ハードゲート本体化・過積載DD分割・製品境界/consumer実証明記）。採択記録=`phase1-backlog.md`。**→ 2026-07-12 完了・アーカイブ（`doc/archived/DD/DD-007/`）**。要確認1〜4回答済み・外部レビュー3回反映済み |
| DD-006 | PoC-Dデータ表現・簡易数式 | **Phase 1〜5 実装＋Codexレビュー反映（P1×6・P2×6）＋AC9ブラウザ実機実測（Chrome 150・乖離なし）完了**。**AC1〜9 全実測合格**（AC2 fanout-100 p95 1.09ms／メモリ全方式300MB内／AC5 replay 100k=14分＝snapshot必須／固定ID数式評価を実文書で実証／AC9 Node比1.0〜1.2倍で乖離なし・§18.6メモリNo-Go非該当）。sheet-formula 74＋結合3テスト green。成果=CellStore用途別選択表・ADR-011拡充・ADR-022ドラフト・計測レポート。DD-007（Go/No-Go）判定材料が揃った |
| DD-005 | 統合PoC-IME・Canvas・共同編集 | 要確認1〜3確定（案A/Codex2回/初期約10万セル）。**Phase 1**（sheet-collaboration 抽出・Codex xhigh 済）＋**Phase 2**（統合ページ土台）＋**Phase 3**（IME×共同編集結線＝commit-bridge cell-level beforeRevision・ime-editing-session・integration-editor・Presence・#8不変/AC4退避）＋**Phase 4**（統合E2E・証跡・Codex xhigh 済）実装完了。**#3 protocol 検証＝cell-level 確定**（SetCellsChange.beforeRevision＋CellRecord.lastChangedRevision＋server validateSetCells がセル単位で照合）。test 434／**E2E 17**（DD-002 11＋統合 6・回帰0）green。統合シナリオ10項目＋AC1〜4 を synthetic composition＋実WS 2コンテキストで自動実証（証跡 `dd005-p4-e2e-*.png`・`integration-evidence.md`）。**Phase 5（実機IMEゲート）はユーザー判断で実機テストなしでクローズ**（2026-07-12・根拠は AC6/下記ログ）: IME正しさは DD-002 実機4環境＋E2E順序A/B両方＋Codex で担保済み・状態機械を無改変再利用。残余（新 integration-editor アダプタ×実IME候補ウィンドウ・順序A/Bの実機記録）は低リスクゆえ Phase 1 製品化＋DD-007 既知制約へ。headed 2タブ smoke（#9競合・スクロール追従）は Phase 2/3 で主セッション実行済み。**DD-005 完了** |
| DD-004 | PoC-BCanvas仮想スクロール | 実装＋headed計測＋**実機確認run（2026-07-12・実Chrome・overall pass）**でAC1〜5合格（p95 16.8ms/再描画0.33ms/選択16.9ms/メモリ−79KB/s・純減/anchor維持）。measurement-report.md「実機確認run」節・pocb-measurement-realrun-20260712.json 参照 |
| DD-003 | PoC-C共同編集Operation | Operation収束性を実証（10,000件×3〜10体でhash一致・二重適用0・AC1〜5合格）。sheet-core/sheet-server-core/collaboration-server実装＋ADR-005/008ドラフト |
| DD-002 | PoC-A日本語IME | PoC-A成立（R-01回避）。常駐textarea＋状態機械＋E2E11＋実機4環境合格（申告）。順序A/BはDD-005で採取 |
| DD-001 | 開発基盤monorepo構築 | npm workspaces基盤（sheet-types+playground）構築。dev/test/typecheck/lint整備、D-001/D-002記録 |
