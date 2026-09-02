# Stage 2 バックログ（Stage 1 SDK Alpha 完了後の送り項目）

> **位置づけ**: DD-018（Stage 1移行判定・2026-07-15）で確定した「Stage 1 Alpha 対象外＝Stage 2 送り」項目の一覧。
> **正典との関係**: Stage 2 開始時にこの一覧を DD ロードマップ化する（DD-007→`phase1-dd-roadmap.md` の先例に倣う）。本文書は**バックログ（出典・理由・依存の記録）**であり、DD 起票・設計はしない。
> **ロードマップ化済み（DD-023・2026-07-16）**: `doc/plan/phase2-dd-roadmap.md`（正式版）へ全項目の回収先を確定（同 §7 対応表・突合記録=`doc/archived/DD/DD-023/traceability-check.md`）。本書は出典記録として保持する。
> **確定根拠**: DD-018 要確認D（`doc/plan/stage2-backlog.md` 新設・ユーザー承認 2026-07-15）。各項目に出典DDを付す。

## 1. Stage 2 縦切りDD（roadmap §4 で番号確定済み）

| DD | 内容 | Stage 1区分 | 出典 | 依存/備考 |
|---|---|---|---|---|
| DD-019 | Presence DD（activeCell/selection/editingCell・overlay・TTL） | Alpha後拡張 | roadmap §4/§9・DD-009 台帳（`integration/presence-adapter.ts`=Adopt・DD-019 起動） | Stage 1 公開面から除外済（`@nanairo-sheet/grid` 内に adapter 実在・非配線） |
| DD-020 | Clipboard DD（範囲選択・parser・型変換・原子SetCells・OCC・Undo） | Alpha後拡張/Stage 2先頭 | roadmap §4/§9 | DD-013（共同編集同期）に依存・OCC 原子性 |
| DD-021 | 行操作DD（RowId・Insert/Delete・tombstone・Canvas座標・共同編集/reconnect後収束。数式参照維持は数式導入後。DD-021-1〜3 に3分割） | Stage 2 | roadmap §4 | 下記 P2-1・K3・K4 の回収先 |
| DD-022 | 数式DD（四則・参照・SUM・固定ID参照・依存グラフ・replay決定性） | Stage 2 | roadmap §4・DD-009 台帳（`@nanairo-sheet/formula`=Adopt・Stage 2 起動） | `packages/formula` は成立済・Stage 1 は Facade 非搭載 |

## 2. 各DD からの Stage 2 送り項目（配布・運用・基盤）

| 項目 | 内容 | 出典DD | 現状（Stage 1） | Stage 2 での対応 |
|---|---|---|---|---|
| dist ビルド配布への切替 | `tsc` emit の js＋d.ts 配布（9 package のビルドパイプライン新設） | DD-017 決定事項B | TS ソース配布（`main: ./src/index.ts`）で継続。consumer は vite 等 TS 透過コンパイル環境前提 | registry 昇格時に dist ビルド配布へ切替（汎用性向上） |
| private registry 昇格 | Verdaccio/社内 registry へ `publishConfig`＋`npm publish --tag alpha` | DD-017 決定事項A・ADR-0015 §「S1-6 再解釈」 | pack tarball closure 方式（内部9 tarball 同時 install・registry 非経由）を正式化。版採番・closure・チャネル表記は確立済 | registry へ昇格（切替は最小＝メタ確立済み） |
| PostgreSQL 本採用・運用 | ファイルベース実装（append-only JSONL oplog＋snapshot・fsync）→ PostgreSQL adapter | ADR-0023・DD-014 要確認① | `OpLogStore`/`SnapshotStore` interface 抽象＋ファイルベース実装のみ | 本番運用段階で PostgreSQL adapter 追加（interface 差替）。DB 運用は Alpha 配布へ波及するため Stage 2 |
| React 薄ラッパー Facade | `@nanairo-sheet/react`（最初の consumer が React の場合に必須化） | roadmap §7・ADR-0015 §5 昇格条件・DD-017 対象外 | Stage 1 は最小経路（`grid`/`server-hono`）へ絞る。React Facade 未搭載 | 最初の consumer が React 確定時に Stage 1 公開面へ追加（`package-boundary.md` §5 昇格条件） |
| 複数配布チャネル運用 | 複数 registry/チャネルの並行運用 | DD-017 対象外・roadmap §0 S1-6 注記 | 単一チャネル（alpha）のみ | Stage 2 |
| 汎用診断/テレメトリ基盤 | error code 語彙・debug hook を超える汎用診断・テレメトリ | DD-017 対象外・roadmap §0 S1-6 注記 | 最小 error code 語彙＋debug logging hook（`error-codes.md`）のみ | Stage 2 |

## 3. 既知制約の Stage 2 回収項目（DD-018 C節 延期判定）

| # | 制約 | 出典DD | 回収先 | 備考 |
|---|---|---|---|---|
| ~~K3~~ | ~~行挿入後のローカル選択・Enter移動先の再ベース~~ | roadmap §8 | **DD-021-3 で回収済（2026-07-17）** | activeCell・選択レンジ（ドラッグ中含む）・Enter 移動先を RowId 追従で再ベース（構造 flush bracket hook） |
| ~~K4~~ | ~~実IME変換中に対象行が削除された場合の挙動~~ | roadmap §8 | **DD-021-2 で回収済（synthetic・2026-07-17）** | 編集継続・draft/composition 非破壊・commit 時退避＋公開 rejected（row-unavailable）通知。**実IME 確認（DD-021 Manual Gate M1）は未実施のまま 2026-09-03 にユーザー判断でクローズ**＝synthetic 三層までが証拠水準（DD-021 §既知の未保証境界） |
| ~~P2-1~~ | ~~単一行 InsertRows 連発ログの Θ(N²)（`apply.ts` nextSlot 全走査＋splice）~~ | DD-014 既知制約 | **DD-021-3 で回収済（2026-07-17）** | slot 採番を maxSlot キャッシュで O(1) 化。replay 経路実測: 50k行+Insert×1,000=128ms（目標2s・p95 0.186ms）。**残存（Stage 3 候補）**: `resolveAnchorIndex.indexOf`＋`splice`＋対話経路の op ごと全文書 clone は per-op O(N) のまま（目標内ゆえ許容・順序構造/gap buffer 化は要件化時に別DD） |
| ~~P2-3~~ | ~~recovery の documentId/revision 相互検証欠如~~ | DD-014 既知制約 | **DD-018-1 で回収済** | documentId 照合＋封筒 revision 相互検査 fail-fast を実装（誤公開防止） |
| ~~P2-4~~ | ~~restoreFrom＋persistenceDir 併用の revision 不連続~~ | DD-014 既知制約 | **DD-018-1 で回収済** | restoreFrom×persistenceDir を明示拒否（throw）。全ログ durable bootstrap は現 caller 不在ゆえ不採用 |

## 3.5 機能追加DD（DD-012-4/5・2026-07-15 起票）からの送り項目

| 項目 | 内容 | 出典DD | Stage 2 での対応 |
|---|---|---|---|
| 列幅・行高・wrap設定の全ユーザー共有 | 現状は view-local＋利用側保存API（F5反映は初期値注入）。リアルタイム共有は Operation 化・snapshot 拡張が必要 | DD-012-4 D1・DD-012-5 D1 | 書式・レイアウトの文書プロパティ化とあわせて設計 |
| セル単位の書式モデル | wrap は列単位で提供。セル単位書式（折り返し・色・罫線等）は書式モデル新設＝共同編集・永続化へ波及 | DD-012-5 D1 | Stage 2（Clipboard・数式の書式要件と統合） |
| ダブルクリック auto-fit（列幅自動調整） | 対象外とした（測定コスト・仕様確定を分離） | DD-012-4 D3 | リサイズ実装の延長で追加 |

## 3.6 列タイプ体系（相談ベース・2026-07-15・実利用アプリへの組み込み検討中）

> **出典**: ユーザーが社内Webアプリ（ReadyCrew 案件DB・商談進捗パイプライン画面）への組み込みを検討する中で相談された3機能。
> 実装なし（現状は文字列描画＋自由入力テキストエリア1種類のみ）。**Stage 1 へは追加せず Stage 2 スコープと決定**（2026-07-15 ユーザー判断）。
> 判断理由: DD-012-4/5（リサイズ・テキスト表示）と異なり、これらは「列ごとに編集方式を変える」「クリックが選択でなく別ナビゲーションになる」「セル単位の書式」という**新しいアーキテクチャ概念（列タイプ体系）**であり、
> 見た目の微調整の範囲を超える。設計判断（選択肢の渡し方・クリック競合の裁き方・書式のデータモデル）が要る＝ Human Spec Gate が必要な規模。

| 項目 | 内容 | 現状 | Stage 2 での扱い |
|---|---|---|---|
| 選択式入力列（ドロップダウン制約） | 列単位で「決められた値だけ選択入力できる」エディタ（Excel の入力規則に相当） | 未実装。編集は自由入力のテキストエリア1種類のみ | 列タイプ体系の一部として設計。選択肢の供給方法（列オプション固定 or 動的）・自由入力との併存可否が論点 |
| ハイパーリンク列 | 列単位でセルクリックを「選択」でなく詳細画面遷移として扱う | 未実装。クリックは常にセル選択（`pointerdown`→`MoveTo`/編集開始） | 列タイプ体系の一部。**既存のクリック＝選択/編集開始の状態機械と競合しないよう設計要**（リンク列はクリック時に navigate、選択自体は別手段で可能にする等） |
| 背景色・バッジ表示 | セル/列単位の背景色・バッジ的な装飾表示 | 未実装 | **セル単位の書式モデル**（上表・DD-012-5 D1）と同一項目。値ベースの自動着色（ルール）か明示プロパティかが論点 |

## 4. 製品境界化（Stage 2 送りではない・Alpha で明示済み）

> 以下は「延期」ではなく roadmap §6 Alpha 製品境界で明示済み（参考記載・DD-018 判定で境界化＝合格扱い）。

- **CG-4**: 対応環境 Tier1（Win Chrome/Edge）限定・macOS/Firefox/モバイル 対象外（roadmap §6・ADR-0015）
- **CG-6**: redraw ≤12ms 上限明示（roadmap §18.2 機能上限内・計測環境アーティファクト）
- **K9**: 確定Enter順序A は Chromium150 で構造的に不発→自動テスト担保（roadmap §0 注記。将来 Tier-1 に順序A発生ブラウザが入れば再ゲート）

## 参照

- Stage 1 移行判定: `doc/DD/DD-018_Stage1移行判定.md`・`doc/DD/DD-018/stage1-gate-checklist.md`
- roadmap（DD-019〜022 定義・§6 製品境界・§8 既知制約）: `doc/plan/phase1-dd-roadmap.md`
- CG 台帳: `doc/plan/cg-ledger.md`
- 配布方針: `doc/adr/0015-stage1-api-maturity-and-tier1-support.md`・`doc/adr/0023-durable-persistence-and-versioned-snapshot.md`
