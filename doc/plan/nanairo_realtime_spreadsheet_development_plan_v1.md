# 業務入力向けリアルタイム共同編集スプレッドシート 開発計画・基本設計

- 文書種別：製品仕様境界書／基本アーキテクチャ／開発計画
- 版：v1.0
- 作成日：2026-07-11
- 入力資料：`nanairo_realtime_spreadsheet_concept_record_v1.md`
- 想定利用者：株式会社ナナイロ 開発・企画関係者
- ステータス：Phase 0着手判断用

> **位置付け（DD-008で明記）**: 製品戦略の上位文書は製品憲章（`doc/product/nanairo_sheet_product_charter_v1.md`）である。本書は**技術方式・アーキテクチャの正典**として、憲章が定める製品方針を技術へ展開する役割を担う。製品の目的・利用者・提供形態・非目標・成熟段階は憲章を、作業順序・DD依存・Go/No-Goは `doc/plan/phase0-dd-roadmap.md` を、現在の進捗は DD-INDEX と各DDを正とする。

---

## 0. エグゼクティブサマリー

本構想は技術的に成立可能である。ただし、一般的なデータグリッドではなく、次の5つを同時に成立させる製品開発として扱う必要がある。

1. Excelに近いセル選択・キーボード操作
2. 日本語IMEを壊さない常駐エディター
3. Canvas 2Dによる数万行描画
4. サーバー主導のリアルタイム共同編集
5. 固定ID、操作ログ、数式参照、Undoを統合する一貫した状態モデル

推奨する基本方針は次のとおりである。

- グリッドコアはTypeScriptのみで実装し、React、Hono、DOM描画方式から分離する。
- 描画はCanvas 2D、入力はグリッド全体で1個の常駐`textarea`を使用する。
- Reactは業務アプリ外周、HonoはHTTP API・WebSocket・認証・永続化を担当する。
- 共同編集はCRDTではなく、オンライン前提のサーバー主導型シーケンサーを採用する。
- 行・列は固定IDで管理し、画面上の番号は順序配列から算出する。
- 利用者操作はCommand、同期可能な状態遷移はOperation、カーソル情報はPresenceとして分離する。
- セル値競合は「Presenceによるソフトロック＋セル単位の楽観的競合検知」を第一候補とする。入力内容を黙って上書きしない。
- 数式は初期から構造だけ組み込み、四則演算・参照・少数関数から段階的に増やす。
- ランタイム依存は最小化し、コアパッケージは原則ゼロ依存とする。Hono、`@hono/node-server`、`ws`、Reactはアダプター層に閉じ込める。

全面実装へ入る前に、Phase 0でIME、Canvas、共同編集、データ表現の4つをPoCする。Phase 0の終了時にGo／条件付きGo／No-Goを判定する。

**実用MVPの概算は24〜36人月、現行構想を一通り実装した製品版は40〜60人月が目安**である。経験者3〜4名体制なら、MVPまで8〜12か月、現行スコープの主要機能まで12〜18か月を見込む。単独開発の場合は、MVPでも18〜30か月程度を計画上の基準とする。

---

## 1. 計画上の前提と仮定

以下は確定事項と、計画を具体化するための暫定仮定を分けて記載する。暫定仮定は意思決定期限までに確定する。

### 1.1 確定事項

- TypeScriptを使用する。
- Reactを業務アプリ外周に使用する。
- HonoをAPI・WebSocketサーバーに使用する。
- グリッドコアはReactおよびHonoに依存しない。
- Canvas 2Dを基本描画方式とする。
- セル編集は常駐`textarea`方式を基本とする。
- 数万行をサポートする。
- 日本語IMEを最優先要件とする。
- リアルタイム共同編集を初期設計から含める。
- 他ユーザーのアクティブセル、選択範囲、編集中セルをPresence表示する。
- 長時間のオフライン編集はサポートしない。
- 行・列は固定IDで管理する。
- 操作ログとスナップショットを併用する。
- 数式は簡易機能から段階的に拡張する。
- 初期業務入力型は文字列、数値、日付、プルダウンとする。
- 外部スプレッドシート製品へ中核依存しない。

### 1.2 暫定仮定

| ID | 暫定仮定 | 確定期限 |
|---|---|---|
| A-01 | 初期対象はデスクトップブラウザー。モバイル・タッチ編集は対象外 | Phase 0開始前 |
| A-02 | Windows 11のChrome／Edgeを最優先、Firefox、macOS Chrome／Safariを次順位とする | Phase 0開始前 |
| A-03 | 1文書あたり50,000行、200列をアドレス可能とする | Phase 0終了時 |
| A-04 | 初期性能試験は500,000個の非空セルを基準とし、2,000,000個をストレッチ目標とする | Phase 0終了時 |
| A-05 | 1文書あたり同時編集者20名を初期目標とする | Phase 0終了時 |
| A-06 | WebSocketサーバーはNode.js上のHonoで運用する | Phase 0終了時 |
| A-07 | 永続化DBはPostgreSQLを第一候補とする | Phase 1開始前 |
| A-08 | 初期MVPは1文書内1シートを完成させ、データモデルは複数シート対応にする | Phase 1開始前 |
| A-09 | セル型は列定義を既定とし、セル単位の型上書きは後続機能とする | Phase 1開始前 |
| A-10 | 同一セル競合はソフトロック＋楽観的競合検知を第一候補とする | Phase 1開始前 |
| A-11 | 初期アクセシビリティはキーボード操作と基本ARIAに限定し、スクリーンリーダー完全対応は後続とする | Phase 1開始前 |
| A-12 | 同一リージョン内のクライアントとサーバーを前提に遅延目標を設定する | Phase 0終了時 |

### 1.3 この計画で意図的に確定しない事項

次の項目は利用案件、PoC結果、運用要件を見て決める。

- ソフトロックとハードロックの最終選択
- 並べ替え・フィルターを共有状態にするか個人状態にするか
- 行高・列幅・固定行列の共有範囲
- 大量貼り付けの最大セル数
- 操作ログの保持期間
- 同時接続数の正式SLO
- 複数シート導入時期
- スクリーンリーダー対応範囲

---

## 2. 製品仕様境界書

### 2.1 製品定義

本製品は、業務Webアプリへ組み込むための、TypeScript製リアルタイム共同編集スプレッドシート型入力基盤である。

Excelの完全互換ではなく、次を優先する。

- 日本語での高速な連続入力
- 範囲単位の編集
- 数万行の表示・編集
- 複数利用者による安全な共同編集
- 業務システムのAPI・DBとの統合
- 長期的に自社で保守できる構造

### 2.2 想定ユースケース

- 受発注、見積、予算、在庫、工程、実績などの明細入力
- 表形式マスタの編集
- 複数担当者が同一表を分担して入力する業務
- 従来Excelで管理していた入力表のWeb化
- AIエージェントや業務ロジックがセルを更新するアプリケーション

### 2.3 MVPに含める機能

MVPは「業務で使える最小範囲」であり、単なるデモではない。

#### 入力・選択

- 単一セル選択
- 連続矩形範囲選択
- マウスドラッグ選択
- 矢印、Enter、Shift＋Enter、Tab、Shift＋Tabによる移動
- 1回クリック後の直接入力
- F2・ダブルクリックによる既存値編集
- Delete／Backspace
- セル内改行
- 日本語IME

#### データ型

- 文字列
- 数値
- 日付
- インライン定義のプルダウン

#### 編集操作

- 複数セルのコピー
- TSV／プレーンテキストの貼り付け
- Webグリッド間のコピー＆ペースト
- 行・列追加
- 行・列削除
- セル値編集、範囲クリア
- セル値・貼り付けのUndo／Redo

#### 表示

- Canvas仮想描画
- 行高・列幅
- 固定行・固定列
- 基本的な背景色、文字色、配置、罫線
- 他ユーザーのアクティブセル、選択範囲、編集中セル

#### 共同編集

- セル値同期
- 行列追加・削除同期
- Presence
- 短時間の切断・再接続
- 操作の重複防止
- 同一セル競合の明示
- 操作ログとスナップショット

#### 数式

- 四則演算
- 括弧
- 同一シートのセル参照
- 矩形範囲参照
- `SUM`、`AVERAGE`、`MIN`、`MAX`、`COUNT`
- 循環参照検出
- `#DIV/0!`、`#VALUE!`、`#REF!`、`#NAME?`、`#CYCLE!`相当のエラー値

`IF`と丸め関数はMVP候補だが、Phase 0の数式PoC後に確定する。

### 2.4 MVP後に段階追加する機能

- 複数範囲選択
- 行全体・列全体選択
- フィルハンドル
- 一括入力
- 行列移動
- 並べ替え
- フィルター
- 右クリックメニュー
- セル結合
- 文字折り返しの高度化
- 条件付き表示
- 複数シート
- シート間参照
- `IF`、`AND`、`OR`、`ROUND`、`ROUNDDOWN`、`ROUNDUP`等
- セル単位の型上書き
- 外部データソース型プルダウン
- アクセシビリティ強化

### 2.5 対象外

- Excelインポート／エクスポート
- ピボットテーブル
- 印刷
- ズーム
- Excel完全互換
- VBA／マクロ
- 長時間オフライン編集
- オフライン状態の高度な自動マージ
- 文字単位の共同編集
- IME変換候補の共有
- 初期段階のモバイル・タッチ編集
- Excelの全関数、財務関数、配列数式、動的配列

### 2.6 製品レベルの成功条件

- Windows環境でセル選択直後から日本語入力でき、先頭文字欠落がない。
- IME変換確定Enterがセル移動として誤処理されない。
- 数万行でもスクロール・選択・入力が実用速度で動く。
- 他ユーザーの位置と編集状態が分かる。
- 通信断、同時編集、操作競合で入力内容が無言で失われない。
- 操作ログの再生結果が全クライアントで一致する。
- React／Hono以外のアプリにもコアを再利用できる。
- ランタイムの中核挙動が外部スプレッドシート製品に依存しない。

---

## 3. アーキテクチャ設計

### 3.1 全体像

```text
┌──────────────────────── Browser ────────────────────────┐
│ React Application                                       │
│  ├─ Toolbar / Dialog / Business UI                      │
│  └─ React Adapter                                       │
│       └─ Web Component / Imperative Grid API            │
│            ├─ Grid Runtime                              │
│            │   ├─ Document Model                        │
│            │   ├─ Command Dispatcher                    │
│            │   ├─ Selection / View State                │
│            │   ├─ Undo Manager                          │
│            │   └─ Formula Coordinator                   │
│            ├─ Canvas Renderer                           │
│            ├─ Persistent Textarea / IME Controller      │
│            └─ Collaboration Client                      │
└───────────────┬───────────────────┬──────────────────────┘
                │ HTTP              │ WebSocket
┌───────────────▼───────────────────▼──────────────────────┐
│ Hono Application Server                                 │
│  ├─ Authentication / Authorization                      │
│  ├─ Snapshot / Operation HTTP API                       │
│  ├─ WebSocket Upgrade / Session                         │
│  ├─ Document Room Coordinator                           │
│  ├─ Operation Validator / Sequencer                     │
│  ├─ Presence Hub                                        │
│  └─ Snapshot Worker                                     │
└───────────────┬───────────────────┬──────────────────────┘
                │                   │
        ┌───────▼────────┐   ┌──────▼─────────┐
        │ PostgreSQL     │   │ Object Storage │ optional
        │ ops / metadata │   │ large snapshot │
        └────────────────┘   └────────────────┘
```

### 3.2 責務分離

#### ブラウザー側

- 画面描画
- 選択、スクロール、キーボード操作
- IME変換中のローカルドラフト
- コマンド生成
- 楽観的適用
- 未確定操作の管理
- 数式の即時再計算
- Presence送信・表示

#### サーバー側

- 認証・文書アクセス権
- Operationの構文・意味検証
- 文書単位の全順序付与
- ID重複・リビジョン・対象存在チェック
- 競合判定
- 操作ログ永続化
- 接続中クライアントへの配信
- スナップショット生成
- 再接続時の差分提供

### 3.3 状態の分類

| 状態 | 例 | 保存 | 同期 |
|---|---|---:|---:|
| Document State | セル値、式、行列、共有書式 | 永続 | Operation |
| Derived State | 数式結果、可視範囲、レイアウト計算 | 原則再計算 | 必要に応じて |
| Local View State | スクロール位置、ローカル選択、編集中ドラフト | 非永続または利用者設定 | 原則しない |
| Presence | アクティブセル、選択範囲、編集セル | 非永続 | 一時配信 |
| Pending State | 未ACKのローカル操作 | 短期ローカル保持 | ACKまで |

### 3.4 一貫性モデル

- 文書Operationはサーバーが単調増加する`revision`を付与する。
- 全クライアントは同一文書について同じOperation列を同じ順序で適用する。
- クライアントは応答性のためローカル操作を先行適用してよい。
- サーバーOperation受信時は、未ACK操作を一度巻き戻し、サーバーOperationを適用し、未ACK操作を再検証・再適用する。
- IME変換中の文字列はDocument Stateへ入れない。
- 数式結果は式と入力値から導出される。Operationログの主対象は式と入力値であり、計算結果はキャッシュ扱いとする。

### 3.5 配置とスケール

初期版は、1文書を同時に複数サーバーが書き込まない構成を推奨する。

- WebSocketはロードバランサーでスティッキーセッションを利用する。
- 文書IDをキーに1つのRoom Coordinatorへルーティングする。
- サーバー障害時はクライアントが再接続し、最新スナップショット＋Operation差分から復元する。
- 水平分割時は文書IDのコンシステントハッシュ、または文書所有権テーブルを利用する。
- 複数ノードが同一文書を同時所有する構成は、分散ロックまたは外部シーケンサー導入まで避ける。

### 3.6 依存最小化方針

- `grid-core`、`grid-formula`、`grid-renderer-canvas`、`grid-editor`は原則ランタイム依存ゼロとする。
- `grid-react`はReactをpeer dependencyとする。
- `grid-server-hono`のみHono、`@hono/node-server`、`ws`へ依存する。
- スキーマ検証、バイナリ形式、データ構造ライブラリを導入する場合は、境界インターフェースの背後へ隔離しADRを残す。
- テスト・ビルド用依存はランタイム依存と分けて管理する。

---

## 4. Architecture Decision Record一覧

| ADR | 状態 | 決定内容 | 主な理由 | 決定期限 |
|---|---|---|---|---|
| ADR-001 | Accepted | グリッドコアをReact／Hono非依存にする | 長期再利用、UIフレームワーク変更耐性 | 確定済み |
| ADR-002 | Accepted | Canvas 2D＋常駐textarea | 数万行描画と日本語IMEを両立 | 確定済み |
| ADR-003 | Accepted | 中核スプレッドシート製品へ依存しない | ライセンス・保守・IME制御 | 確定済み |
| ADR-004 | Accepted | 長時間オフラインを対象外とする | CRDT必須化を避け、複雑性を制御 | 確定済み |
| ADR-005 | Proposed | サーバー主導型の全順序Operationログ | オンライン業務、監査、障害解析 | Phase 0終了時 |
| ADR-006 | Accepted | 行・列を固定ID、表示順を別管理 | 挿入・移動・数式・Presenceの安定参照 | 確定済み |
| ADR-007 | Proposed | Command／Operation／Presenceを分離 | UI意図、永続状態、一時状態の責務分離 | Phase 1開始前 |
| ADR-008 | Proposed | 楽観適用＋rollback/replay | 入力応答性とサーバー権威の両立 | Phase 0終了時 |
| ADR-009 | Accepted | Presenceは非永続 | 高頻度更新をOperationログから分離 | 確定済み |
| ADR-010 | Proposed | ソフトロック＋セル単位OCC | 共同編集を妨げず無言上書きを防止 | Phase 1開始前 |
| ADR-011 | Proposed | 行スロット＋チャンク化セルストア | 大量行、移動、疎・密データの両立 | Phase 0終了時 |
| ADR-012 | Proposed | 日付をタイムゾーン非依存のLocalDateで保持 | 日付ずれ防止、再現性 | Phase 1開始前 |
| ADR-013 | Proposed | 数式ASTは固定ID参照へバインド | 行列変更後も参照を維持 | Phase 1開始前 |
| ADR-014 | Proposed | Undoを補償Operationとして実行 | 共同編集で全体巻き戻しを防止 | Phase 1開始前 |
| ADR-015 | Proposed | Operationログ＋スナップショット | 再接続、監査、復旧、初期読込 | Phase 1開始前 |
| ADR-016 | Proposed | 1文書1Coordinator | 全順序を単純化し、分散競合を回避 | Phase 1開始前 |
| ADR-017 | Proposed | Custom Elementを標準UI境界にする | React以外からも組込可能 | Phase 2開始前 |
| ADR-018 | Open | 並べ替え・フィルターの共有／個人状態 | 共同編集UXに直接影響 | Phase 3開始前 |
| ADR-019 | Open | セル結合の初期制約 | 選択・貼付・共同編集の複雑性 | Phase 4開始前 |
| ADR-020 | Accepted | 大量Operationのinline／参照方式（Stage 2=inline＋セル数上限100,000・参照方式は不採用。`doc/adr/0020-*.md`・DD-020） | 貼り付けとWebSocket上限 | 確定済み（2026-07-17・DD-020） |
| ADR-021 | Open | 初期アクセシビリティ範囲 | Canvas固有の制約 | Phase 1開始前 |
| ADR-022 | Proposed | コアはゼロランタイム依存を原則とする | 長期保守と制御権 | Phase 0終了時 |
| ADR-023 | Proposed | 数式エンジンをクライアント・サーバーで共有 | 計算結果の再現性 | Phase 1開始前 |
| ADR-024 | Open | Operationログ保持・アーカイブ方針 | コスト、監査、Undo期間 | 本番設計前 |

各ADRは`docs/adr/NNNN-title.md`として、背景、選択肢、決定、結果、再検討条件を記録する。

---

## 5. モジュール構成と依存関係

### 5.1 推奨パッケージ

```text
packages/
  types/                 ブランド型、共通イベント、公開型
  core/                  文書モデル、Axis、CellStore、Command、Operation
  selection/             選択・移動・範囲演算
  formula/               parser、AST、依存グラフ、計算
  sheet-renderer-canvas/       Canvas描画、座標、ヒットテスト
  sheet-editor-ime/            常駐textarea、IME、clipboard、keyboard
  collab/         client queue、protocol、presence、reconnect
  sheet-element/               Custom Element
  sheet-react/                 React wrapper
  server/           sequencer、validator、room、snapshot
  server-hono/           Hono HTTP／WebSocket adapter
  sheet-testkit/               fixture、operation fuzzer、event recorder
```

### 5.2 依存方向

```text
types
  ↑
  ├─ core ← selection
  │      ↑             ↑
  │      ├─ formula
  │      ├─ sheet-renderer-canvas
  │      ├─ sheet-editor-ime
  │      └─ collab
  │
  ├─ server ← server-hono
  │
  └─ sheet-element ← sheet-react
```

依存規則：

- `core`はCanvas、DOM、React、Honoをimportしない。
- `formula`はUIをimportしない。
- `sheet-renderer-canvas`はOperation送信を行わない。
- `sheet-editor-ime`はDocument Stateを直接変更せずCommandを発行する。
- `collab`はCanvasやReactを認識しない。
- `sheet-react`は薄いライフサイクルラッパーに限定する。
- サーバーとクライアントは同じOperation型と適用関数を共有する。

### 5.3 公開APIの方向性

> クラス名 `NanairoSheet` は仮称（憲章 P-02・公開クラス候補）。正式名称は Phase 1 最初の Facade DD で確定する。旧コード例の `SpreadJS` は商用製品との混同を避けるため `NanairoSheet` へ改めた（DD-008・decisions.md D-003）。

```ts
const sheet = new NanairoSheet(container, {
  locale: 'ja-JP',
  documentId,
  dataSource,
  collaboration,
  capabilities: {
    formulas: true,
    multiRange: false,
  },
})

sheet.on('cell-commit', listener)
sheet.on('selection-change', listener)
sheet.on('conflict', listener)
sheet.on('connection-state-change', listener)

sheet.execute({ type: 'insertRows', at: anchor, count: 10 })
sheet.setReadOnly(false)
sheet.focus()
sheet.destroy()
```

公開APIは内部データ構造を露出せず、バージョン互換を維持できるCommandとイベントを中心にする。

---

## 6. データモデル

### 6.1 識別子

```ts
type DocumentId = string & { readonly __brand: 'DocumentId' }
type SheetId = string & { readonly __brand: 'SheetId' }
type RowId = string & { readonly __brand: 'RowId' }
type ColumnId = string & { readonly __brand: 'ColumnId' }
type OperationId = string & { readonly __brand: 'OperationId' }
type TransactionId = string & { readonly __brand: 'TransactionId' }
```

ID生成はWeb Cryptoの`crypto.randomUUID()`を第一候補とし、順序はIDに埋め込まず別構造で管理する。

### 6.2 文書モデル

```ts
interface SheetDocument {
  id: DocumentId
  schemaVersion: number
  revision: number
  formulaEngineVersion: string
  sheets: Map<SheetId, SheetModel>
  styleTable: StyleTable
}

interface SheetModel {
  id: SheetId
  name: string
  rows: AxisSequence<RowId, RowMeta>
  columns: AxisSequence<ColumnId, ColumnMeta>
  cells: CellStore
  merges: MergeRegistry
  frozen: FrozenPane
}
```

### 6.3 行・列と内部スロット

固定IDと表示順序に加え、セル格納用の安定した整数スロットを持つ。

```ts
interface RowMeta {
  id: RowId
  slot: number
  height?: number
  hidden?: boolean
  styleId?: number
  lastChangedRevision: number
}

interface ColumnMeta {
  id: ColumnId
  slot: number
  width?: number
  hidden?: boolean
  dataType: CellDataType
  dropdownSource?: DropdownSource
  styleId?: number
  lastChangedRevision: number
}
```

- 行移動は`rowOrder`のみを変更し、セルの物理格納位置を移動しない。
- 行削除はスロットをtombstone化する。スロット再利用はスナップショット再構築時のみ検討する。
- `rowId → slot`、`rowId → displayIndex`を別々に持つ。
- Phase 0では配列＋Mapで実測し、構造変更がボトルネックになった場合だけチャンク化Axisへ移行する。

### 6.4 セルストア

大量の空セルにオブジェクトを割り当てない。

```ts
interface CellRecord {
  value?: CellScalar
  formula?: FormulaRecord
  styleId?: number
  typeOverride?: CellDataType
  lastChangedRevision: number
}

type CellScalar =
  | { kind: 'blank' }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'date'; value: string } // ISO LocalDate: YYYY-MM-DD
  | { kind: 'dropdown'; value: string }
```

推奨格納方式：

- 列ごとにチャンクMapを持つ。
- 1チャンクは例として256行スロット。
- 非空セルを含むチャンクだけを確保する。
- スタイルは共有テーブルのID参照とし、セルごとにCSS相当オブジェクトを持たない。

```ts
interface ColumnChunks {
  chunks: Map<number, CellChunk>
}

interface CellChunk {
  records: Array<CellRecord | undefined>
}
```

Phase 0で、疎データと密データの両方についてMap方式、チャンク方式、配列方式を比較する。

### 6.5 型と入力値

#### 文字列

- Unicode文字列をそのまま保持する。
- 正規化は自動で行わない。業務側が必要ならCommand前後のフックで実施する。

#### 数値

- 永続値はIEEE 754倍精度数を基本とする。
- 入力時の桁区切り、全角数字、小数点、負数表現はロケールパーサーで正規化する。
- 金額の厳密小数が必要な案件は、後続でdecimal型を追加できるよう型拡張点を残す。

#### 日付

- 初期の日付型は時刻を持たないLocalDateとする。
- プロトコルと永続化は`YYYY-MM-DD`を使用する。
- JavaScriptのローカルタイム`Date`を正規値にしない。
- 数式内部では必要に応じてepoch dayへ変換する。

#### プルダウン

MVPはインライン候補に限定する。

```ts
interface DropdownSource {
  kind: 'inline'
  options: Array<{ value: string; label: string; disabled?: boolean }>
  allowBlank: boolean
}
```

候補値は表示ラベルではなく安定した`value`を保存する。

### 6.6 スタイル

```ts
interface CellStyle {
  fontFamily?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  textColor?: string
  backgroundColor?: string
  horizontalAlign?: 'left' | 'center' | 'right'
  verticalAlign?: 'top' | 'middle' | 'bottom'
  wrap?: boolean
  borders?: BorderSet
}
```

同一スタイルをハッシュ・重複排除して`styleId`へ変換する。

### 6.7 表示状態と共有状態

- スクロール位置、ローカル選択、編集中ドラフトはローカル状態。
- 行列順、共有書式、固定行列は原則文書状態候補。
- フィルター・並べ替えはADR-018で決定する。
- Presenceは別モデル。

---

## 7. Command／Operationモデル

### 7.1 用語

- **Command**：利用者や外部APIが要求した意図。現在選択や権限に依存し、失敗し得る。
- **Operation**：文書へ適用できる決定論的・直列化可能な状態遷移。
- **Transaction**：1回の利用者操作として扱うOperation集合。
- **Event**：適用結果やUI通知。
- **Presence**：非永続の共同編集状態。

### 7.2 Command例

```ts
type GridCommand =
  | { type: 'commitEditor'; value: string }
  | { type: 'clearSelection' }
  | { type: 'paste'; matrix: string[][] }
  | { type: 'insertRows'; anchor: RowAnchor; count: number }
  | { type: 'deleteRows'; rowIds: RowId[] }
  | { type: 'setColumnWidth'; columnId: ColumnId; width: number }
```

Command Handlerは次を行う。

1. 現在の選択・セル型・権限を確認
2. 入力値を型変換
3. 対象を固定IDへ解決
4. 1つ以上のOperationへ変換
5. ローカル選択の次状態を算出
6. Undo履歴単位を作成

### 7.3 Operation Envelope

```ts
interface ClientOperationEnvelope {
  protocolVersion: number
  documentId: DocumentId
  operationId: OperationId
  transactionId: TransactionId
  actorId: string
  clientId: string
  clientSequence: number
  baseRevision: number
  operation: DocumentOperation
}

interface ServerOperationEnvelope extends ClientOperationEnvelope {
  revision: number
  acceptedAt: string
  canonicalOperation: DocumentOperation
  conflict?: ConflictMetadata
}
```

### 7.4 初期Operation

```ts
type DocumentOperation =
  | SetCellsOperation
  | InsertRowsOperation
  | DeleteRowsOperation
  | InsertColumnsOperation
  | DeleteColumnsOperation
  | SetRowHeightOperation
  | SetColumnWidthOperation
  | SetCellStyleOperation
  | SetFrozenPaneOperation
```

後続：

- MoveRows／MoveColumns
- MergeCells／UnmergeCells
- SortRows
- SetSheetMetadata
- AddSheet／DeleteSheet／RenameSheet

### 7.5 SetCells

単一セルも貼り付けも同じOperation表現へ寄せる。

```ts
interface SetCellsOperation {
  type: 'setCells'
  changes: Array<{
    rowId: RowId
    columnId: ColumnId
    beforeRevision?: number
    value?: CellScalar
    formulaText?: string
  }>
  conflictPolicy: 'reject-overlap' | 'accept-latest'
}
```

- MVPの単一セル編集は`reject-overlap`を推奨する。
- 貼り付けはTransaction単位で原子的に扱う。
- 大量貼り付けの部分成功は後続候補とし、MVPは全成功／全失敗を基本とする。

### 7.6 決定論

Operation適用関数は次を満たす。

- 現在時刻、乱数、DOM、ネットワークを参照しない。
- 同じ入力文書とOperationから同じ結果を返す。
- 変更集合、逆操作用メタデータ、再描画範囲、数式無効化集合を返す。
- 不正Operationは明示的エラーにする。

```ts
interface ApplyResult {
  changeSet: ChangeSet
  inverseSeed: InverseSeed
  dirtyRegions: DirtyRegion[]
  formulaInvalidations: CellAddress[]
}
```

### 7.7 楽観適用

クライアントは`Committed State`と`Pending Operations`を分ける。

```text
Server operation受信
  1. pendingを逆順でrollback
  2. server operationをcommittedへ適用
  3. own operationならpendingから除去
  4. 残pendingを再検証
  5. 再適用
  6. 不成立pendingはConflict Queueへ移す
```

IMEドラフトはこの処理の外側に置き、リモートOperationで`textarea.value`を上書きしない。

---

## 8. WebSocket同期プロトコル

### 8.1 基本方針

- 文書OperationとPresenceを同じWebSocket接続上の異なるメッセージ種別として扱う。
- Operationはサーバーの`revision`順で適用する。
- `operationId`で冪等性を保証する。
- `clientSequence`でクライアント送信順を検査する。
- Protocol、Document Schema、Formula Engineの各バージョンをhandshakeで確認する。

### 8.2 初期接続

1. HTTPで認証済みセッションを確立する。
2. HTTPで最新スナップショットを取得する。スナップショットはrevision `R`を含む。
3. WebSocketへ接続し、`join`で`lastAppliedRevision = R`を送る。
4. サーバーは`R+1`以降のOperationを送る。
5. 差分が保持期間外なら`resyncRequired`を返し、最新スナップショットを再取得させる。

スナップショット取得とWebSocket接続の間に更新が発生しても、Operationログから追従できる。

### 8.3 メッセージ種別

#### Client → Server

```ts
type ClientMessage =
  | { type: 'join'; protocolVersion: number; documentId: string; lastAppliedRevision: number; clientId: string }
  | { type: 'submitOperation'; envelope: ClientOperationEnvelope }
  | { type: 'presence'; sequence: number; payload: PresencePayload }
  | { type: 'heartbeat'; sentAt: number }
  | { type: 'requestCatchup'; afterRevision: number }
```

#### Server → Client

```ts
type ServerMessage =
  | { type: 'welcome'; sessionId: string; currentRevision: number; capabilities: ServerCapabilities }
  | { type: 'operations'; fromRevision: number; toRevision: number; operations: ServerOperationEnvelope[] }
  | { type: 'operationAck'; operationId: string; revision: number }
  | { type: 'operationRejected'; operationId: string; code: string; details?: unknown }
  | { type: 'presenceSnapshot'; users: UserPresence[] }
  | { type: 'presenceDelta'; presence: UserPresence }
  | { type: 'presenceRemoved'; sessionId: string }
  | { type: 'resyncRequired'; snapshotRevision: number; reason: string }
  | { type: 'heartbeatAck'; serverTime: number }
```

### 8.4 順序・欠落・重複

- クライアントは`nextExpectedRevision`を保持する。
- 期待値より大きいrevisionを受信した場合は適用を止め、catch-upを要求する。
- 期待値より小さいrevisionは重複として無視する。
- `operationId`はDBで文書単位に一意制約を持つ。
- 同じOperationを再送しても、同じACKを返す。

### 8.5 切断・再接続

- 短時間の切断中は確定済みローカルOperationを上限付きキューへ保持する。
- IME変換中のドラフトはローカルに保持する。
- 再接続後、先にサーバー差分を取得し、その後で未送信Operationを再検証・送信する。
- 一定時間または一定件数を超えた場合は編集を停止し、読み取り状態へ移行する。
- 暫定値：30秒または100Operation。Phase 0でUXと運用要件から確定する。

### 8.6 大量Operation

大量貼り付けを想定し、Operation transportを抽象化する。

- 小さいOperation：WebSocket内へinline。
- 大きいOperation：HTTPへアップロードし、WebSocketでは参照IDとハッシュを送る方式を将来追加可能にする。
- MVPでのinline上限はPhase 0の計測後に決める。
- サーバーは解凍後サイズ、セル数、文字列長、数式数を検証する。

### 8.7 認証・セキュリティ

- WebSocket upgrade時に認証と文書権限を検証する。
- 同一オリジンCookieを利用する場合も`Origin`を検査する。
- 接続後もOperationごとに権限・対象文書を検証する。
- メッセージサイズ、送信頻度、同時未ACK数へ上限を設ける。
- 数式を`eval`しない。
- プロトコル不一致は明示的に切断し、クライアント更新を促す。

---

## 9. Presenceプロトコル

### 9.1 Presenceモデル

```ts
interface UserPresence {
  sessionId: string
  userId: string
  displayName: string
  colorToken: string
  activeSheetId: SheetId
  activeCell?: CellAddressById
  selections: SelectionById[]
  editingCell?: CellAddressById
  sequence: number
  updatedAt: number
}
```

### 9.2 共有する情報

- アクティブセル
- 選択範囲
- 編集中セル
- 表示名
- 識別色
- 接続状態

共有しない情報：

- IME変換中文字列
- 変換候補
- セル内の文字単位キャレット位置
- 未確定ドラフト
- ローカルスクロール位置

### 9.3 配信方針

- アクティブセル変更と編集開始・終了は即時送信する。
- ドラッグ中の選択範囲はスロットリングし、目安として20〜30Hz以下へ抑える。
- 最新状態だけが重要なため、送信待ちPresenceは上書き・集約する。
- Presenceに単調増加`sequence`を付け、古い更新を破棄する。
- アプリケーションheartbeatを5秒程度、Presence TTLを15秒程度の初期値としてPoCする。
- 正常close時は即時削除、異常切断時はTTLで削除する。

### 9.4 表示

- 選択枠とアクティブセルはCanvas overlayへ描画する。
- 利用者名ラベルは重なりを避ける簡易配置を行う。
- 同色衝突を避けるため色はサーバーがセッション単位で割り当てる。
- 色だけに依存せず、名前またはイニシャルを併記する。
- 画面外の編集者は接続ユーザー一覧に表示する。

### 9.5 行列変更時

- Presenceは固定RowId／ColumnIdを参照するため、挿入・移動で同じ論理セルを指し続ける。
- 対象行・列が削除された場合は、サーバーOperation適用後にクライアントが最寄りの生存セルへ移すか選択を解除する。
- この移動はローカル計算し、新しいPresenceを送信する。

---

## 10. 競合解決仕様

### 10.1 原則

1. 入力内容を黙って消さない。
2. サーバーOperation順序を全クライアントで共有する。
3. 同一セルの未確定IMEドラフトをリモート値で上書きしない。
4. 構造Operationは固定IDとanchorで表現する。
5. 自動解決できない競合は利用者へ明示する。
6. 競合したローカル値はコピー可能な形で保持する。

### 10.2 推奨するセル競合方式

**Presenceによるソフトロック＋セル単位の楽観的競合検知**を推奨する。

- 編集開始時の`lastChangedRevision`を記録する。
- Commit Operationへ`beforeRevision`を含める。
- サーバー上のセルrevisionが一致すれば受理する。
- 不一致ならOperationを拒否し、現在値、現在revision、競合相手を返す。
- クライアントはドラフトを保持し、「自分の値で再送」「現在値を採用」「内容をコピー」を表示する。

この方式は完全なハードロックではないため、通信遅延やPresence欠落があっても編集を開始できる。一方、最後の書き込みを無条件に採用するLWWよりも入力消失を防ぎやすい。

### 10.3 競合マトリクス

| Operation A | Operation B | 基本ルール |
|---|---|---|
| SetCell | 同一Cell SetCell | 先に確定したOperationを保持。後続の古いbeforeRevisionは拒否 |
| SetCell | 別Cell SetCell | 両方適用 |
| SetCells貼付 | 対象内Cell更新 | MVPはTransaction全体を拒否し、再試行を促す |
| SetCell | DeleteRow | DeleteRowが先ならSetCell拒否。SetCellが先なら後から行削除 |
| InsertRows | 同一anchor InsertRows | サーバー受付順。新RowIdで両方保持 |
| MoveRows | DeleteRows | 削除済みIDを含むMoveは拒否または残存対象だけに縮退。MVPは拒否 |
| SetColumnWidth | 同一列SetColumnWidth | サーバー順で最後を採用。低リスクのため通知のみ |
| MergeCells | 重複MergeCells | 後続を拒否 |
| Formula edit | 参照先Cell更新 | 両方適用し、式を再計算 |
| SortRows | Cell edit | CellはRowIdに紐づくため両方適用可能。構造変更が競合した場合はSortを再検証 |

### 10.4 IME変換中のリモート更新

- リモート値はDocument Stateへ適用する。
- ただし編集中`textarea`とドラフトは変更しない。
- 編集開始時revisionと現在revisionがずれたことを編集UIへ表示する。
- Commit時に競合ダイアログへ進む。
- 利用者が明示的に選ぶまでドラフトを保持する。

### 10.5 ソフトロックとハードロック

Phase 0で比較する。

#### ソフトロック

- 長所：自由度、切断耐性、実装が単純
- 短所：競合は発生する

#### ハードロック

- 長所：同時上書きを事前に防止
- 短所：ロック残留、遅延、操作阻害、切断処理が複雑

初期製品ではソフトロック＋OCCを採用し、特定業務向けにハードロックポリシーを追加できる拡張点を設けるのが妥当である。

---

## 11. 日本語IME操作仕様

### 11.1 目標

「日本語対応」ではなく、Excel利用者が意識せず連続入力できる状態を合格基準にする。

### 11.2 編集状態機械

```text
Navigation
  ├─ printable input / compositionstart → EditingReplace
  ├─ F2 / double click / formula bar     → EditingExisting
  └─ paste                               → Command execution

EditingReplace / EditingExisting
  ├─ compositionstart → Composing
  ├─ Enter / Tab      → CommitAndMove
  ├─ Escape           → Cancel
  └─ pointer move     → CommitOrQueueNavigation

Composing
  ├─ compositionupdate → LocalDraftOnly
  ├─ compositionend    → EditingAwaitFinalInput
  ├─ remote operation  → MarkConflictOnly
  └─ navigation input  → Suppress / Queue

EditingAwaitFinalInput
  ├─ input → Editing
  └─ compatibility guard → suppress IME-confirm key sequence
```

### 11.3 常駐textarea

- グリッド生成時に1個だけ作成し、`destroy()`まで破棄しない。
- Reactのcontrolled inputにしない。
- Navigation中もフォーカスを維持する。
- `display:none`、`visibility:hidden`、ゼロサイズにしない。
- アクティブセル位置へ配置し、IME候補ウィンドウの基準位置をセル近傍に保つ。
- Navigation中は値を空にしておき、直接入力時の置換編集を実現する。
- F2／ダブルクリック時だけ既存セル文字列を設定して編集モードへ入る。
- Composition中に`value`、selection range、DOM親、classによる再生成を変更しない。

### 11.4 Excelに近い操作

| 操作 | 期待動作 |
|---|---|
| セルを1回クリックし日本語入力 | 選択セルの既存値を置換して入力開始 |
| 矢印移動後に日本語入力 | 移動先で直ちに入力開始 |
| Enter／Tab移動後に日本語入力 | フォーカスを失わず入力開始 |
| F2 | 既存値を編集。原則末尾へキャレット |
| ダブルクリック | クリック位置に近い文字位置で既存値編集。初期は末尾でも可 |
| IME変換確定Enter | セルを確定・移動しない |
| 変換確定後の次のEnter | セルを確定して下へ移動 |
| Escape | 変換中はIME側の取消を優先し、編集取消はその後のEscape |
| Delete | Navigation中は選択セルをクリア |
| Backspace | Navigation中はセルクリア後に編集開始するかをExcel比較で決定 |
| Alt／Option＋Enter | セル内改行候補。OS差をPoCで確定 |

### 11.5 イベント処理

主に次を監視する。

- `compositionstart`
- `compositionupdate`
- `compositionend`
- `beforeinput`
- `input`
- `keydown`
- `keyup`
- `copy`、`cut`、`paste`
- `pointerdown`
- `blur`、`focus`

原則：

- 値変更の正は`input`イベント後の`textarea.value`とする。
- `keydown`だけで文字入力を推測しない。
- `isComposing`と内部composition stateの両方を見る。
- composition開始・終了境界のブラウザー差に備え、IME由来キー判定の互換層を設ける。
- `keyCode === 229`は非推奨APIであるため主判定にせず、実ブラウザー検証で必要な場合だけ限定的fallbackとして隔離する。
- composition終了直後のEnter誤判定を防ぐため、event sequenceを記録し、`suppressCommitUntilKeyup`等の互換状態をブラウザー別に検証する。

### 11.6 ポインター・スクロール

#### 変換中に別セルをクリック

- クリック先を`pendingNavigation`として保持する。
- 現在のcompositionを壊すDOM操作を行わない。
- 最終`input`受信後にセルCommitを試みる。
- 競合がなければクリック先へ移動する。
- 競合時は現在セルに留まり、ドラフトを保持する。

#### 変換中にスクロール

PoCで次を比較する。

1. 編集セルを画面内へクランプする
2. `textarea`をセルへ追従させ、画面外へ出る直前にCommitする
3. 編集中はスクロールを許可するが編集セルをoverlayへ固定表示する

MVPでは最もブラウザー差が少ない方式を採用する。Composition中の強制blurは避ける。

### 11.7 リモート更新

- リモートOperation受信でCanvasは再描画してよい。
- `textarea`のDOM、値、selectionを変更しない。
- 編集セルがリモートで削除された場合、ドラフトを「復元可能な競合」として退避する。
- リモートでセル値が変更された場合、セル枠へ競合インジケーターを表示する。

### 11.8 IMEテストマトリクス

最低限：

- Windows 11＋Microsoft IME＋Chrome
- Windows 11＋Microsoft IME＋Edge
- Windows 11＋Microsoft IME＋Firefox
- Windows 11＋Google日本語入力＋Chrome
- Windows 11＋Google日本語入力＋Edge
- macOS＋日本語入力＋Safari
- macOS＋日本語入力＋Chrome

自動テストのcompositionイベント送出だけでは実IMEの候補ウィンドウやイベント順を再現できないため、実OS・実IMEの受入試験をリリース条件に含める。

### 11.9 禁止事項

- 文字キーを検出してからinputを生成・focusする
- Composition中にtextareaを再マウントする
- Composition中に`value`を整形する
- Composition中にサーバー値を反映する
- IME確定Enterを通常Enterとして扱う
- セル移動ごとに別inputへfocusを移す
- React stateをtextareaの真実の値にする

---

## 12. Canvas描画設計

### 12.1 レイヤー

```text
DOM container
  ├─ native scroll viewport + spacer
  ├─ base canvas        セル背景、文字、罫線、ヘッダー
  ├─ overlay canvas     選択、Presence、ドラッグガイド、競合表示
  ├─ textarea           セル編集
  └─ DOM popover layer  dropdown、context menu、tooltip
```

BaseとOverlayを分け、Presenceや選択変更で全セルを再描画しない。

### 12.2 描画領域

固定行・固定列を含む場合、1つのCanvas内で4つのclip regionを描く。

1. 左上固定領域
2. 上部固定行領域
3. 左側固定列領域
4. スクロール領域

座標変換は`ViewportTransform`へ集約し、描画、ヒットテスト、textarea位置、Presenceで同じ実装を使用する。

### 12.3 描画パイプライン

```text
scroll / data change / resize
  → RenderScheduler.invalidate(flags)
  → requestAnimationFrame
  → visible row/column range calculation
  → base layer draw if required
  → overlay draw
  → editor position update
```

Dirty flag例：

- `geometry`
- `cells`
- `styles`
- `selection`
- `presence`
- `editor`
- `full`

初期実装は可視範囲全描画で開始し、実測で必要な場合にdirty rectangleやtile cacheを追加する。

### 12.4 高DPI

- Canvas backing storeをCSSサイズ×`devicePixelRatio`で確保する。
- 描画座標はCSS pixelを基準に統一する。
- 1px罫線はdevice pixelへsnapする。
- base/overlay Canvas の表示原点も最寄りの device pixel へそろえる（移動量は最大0.5 device px）。Chrome の端数原点の丸めを避けるため、Canvas の配置原点を一度 viewport の (0,0) へ相殺してから、そろえた表示原点へ translate する。表示サイズも backing store / DPR とし、`image-rendering: pixelated` で描画済み bitmap の再補間を抑える（DD-058）。stage・textarea・ヒットテストの論理座標は維持する。
- 既存の描画 rAF で stage の位置を1回読む。サイズを変えない移動も次フレームで補正し、位置が同じなら DOM を更新しない。DPR 単独変更も検知して両 Canvas を再確保し、文字測定キャッシュと viewport を更新する。ResizeObserver によるサイズ変更の監視も維持する。製品機能としてのズームは実装しない。

### 12.5 文字描画

- font、文字列、列幅、wrap条件をキーに測定結果をキャッシュする。
- 同一フレームで`measureText`を繰り返さない。
- セルclipを適用し、隣接セルへはみ出さない。
- IME編集中の文字はCanvasで描画せずtextareaに任せる。
- Web font読込完了時にgeometryとtext cacheを無効化する。

### 12.6 ヒットテスト

```ts
interface GridHit {
  area: 'cell' | 'row-header' | 'column-header' | 'resize-handle' | 'fill-handle'
  rowId?: RowId
  columnId?: ColumnId
  localX: number
  localY: number
}
```

ヒットテストもAxis prefix sumを利用し、DOMセルを探索しない。

### 12.7 セル結合

後続機能だが、描画構造は初期から考慮する。

- Mergeは固定IDの矩形端点で保持する。
- overlapping mergeを禁止する。
- 結合領域内のヒットはtop-left cellへ正規化する。
- 可視範囲へ交差するMergeだけを取得できるindexを持つ。
- 行列削除で結合範囲が破壊される場合の縮小・解除規則をADRで決める。

### 12.8 アクセシビリティ

Canvas単独ではセル構造を支援技術へ伝えられないため、次を段階導入する。

- コンテナへ`role="grid"`
- 行列数、アクティブセル、選択範囲のARIA情報
- 画面外の軽量DOM live regionでセル位置と値を通知
- キーボード操作をマウスなしで完結
- 完全な仮想DOM grid mirrorは後続評価

---

## 13. 仮想スクロール設計

### 13.1 基本方式

- ブラウザー標準スクロールを使うDOM viewportを用意する。
- 内容サイズを表すspacer要素を配置する。
- Canvasはviewportと同サイズで固定し、`scrollTop`／`scrollLeft`から表示範囲を計算する。
- 50,000行×標準行高程度は通常のスクロール座標範囲に収まるため、初期はsegmented scrollingを採用しない。

### 13.2 Axisサイズ構造

必要な操作：

- index → pixel offset
- pixel offset → index
- RowId／ColumnId → index
- 行高・列幅変更
- 挿入・削除・移動

初期実装候補：

- 順序配列
- ID→index Map
- 標準サイズ＋疎なoverride
- prefix sum用Fenwick Tree

行列構造変更時はFenwick Treeとindex Mapを再構築しても、50,000行規模では頻度が低ければ成立する可能性が高い。Phase 0で測定し、必要ならchunked B-tree／ropeへ置き換える。Axis APIを抽象化し、上位層へ配列を露出しない。

### 13.3 Overscan

- 縦方向は画面高の0.5〜1.0倍を前後にoverscanする。
- 横方向は数列分をoverscanする。
- 高速スクロール中は文字描画を簡略化する適応モードを検討する。
- スクロール停止後に完全描画する。

### 13.4 スクロールアンカー

行高変更、行挿入、リモート構造更新で画面が跳ばないよう、次を保持する。

```ts
interface ScrollAnchor {
  rowId: RowId
  offsetWithinRow: number
  columnId: ColumnId
  offsetWithinColumn: number
}
```

Operation適用後に同じIDを基準に`scrollTop`／`scrollLeft`を補正する。

### 13.5 エディター追従

- textarea座標は描画と同じ`ViewportTransform`で算出する。
- scrollイベント中はrAF単位で位置を更新する。
- 固定領域とスクロール領域を正しく区別する。
- 編集セルが非表示行・列へ変化した場合は、ドラフトを保持して競合処理へ送る。

---

## 14. 数式エンジン設計

### 14.1 基本方針

- Excel互換エンジンではなく、独自仕様として定義する。
- Formula textを自前parserでASTへ変換する。
- ASTのセル参照は解析時に固定RowId／ColumnIdへバインドする。
- クライアントとサーバーで同一パッケージを使用する。
- 任意コード実行や動的関数ロードを禁止する。

### 14.2 MVP文法候補

```text
formula      := '=' expression
expression   := comparison
comparison   := additive (comparisonOp additive)*
additive     := multiplicative (('+' | '-') multiplicative)*
multiplicative := power (('*' | '/') power)*
power        := unary ('^' unary)*
unary        := ('+' | '-') unary | primary
primary      := number | string | cellRef | rangeRef | functionCall | '(' expression ')'
functionCall := identifier '(' arguments? ')'
```

MVPでは比較演算を`IF`導入時に有効化する。

### 14.3 参照表現

```ts
interface BoundCellReference {
  sheetId: SheetId
  rowId: RowId
  columnId: ColumnId
  rowMode: 'relative' | 'absolute'
  columnMode: 'relative' | 'absolute'
}
```

- 表示・入力はA1形式。
- 保存ASTは固定ID。
- 行列挿入・移動後も同じ論理セルを参照する。
- 参照対象削除時は`#REF!`。
- コピー・フィルでは相対／絶対属性に従い、新しい参照先へrebindする。
- `$A$1`、`A$1`、`$A1`はMVPまたはMVP直後に入れる。フィルハンドル導入前には必須とする。

### 14.4 依存関係

- formula cell → precedent cells／ranges
- cell change → dependent formula cells
- topological orderで差分再計算
- cycle検出はTarjan法またはDFS coloring

小さいrangeはセルへ展開してよい。大きいrangeはinterval dependencyとして保持する。Phase 0では以下を比較する。

1. 全展開
2. 列別interval index
3. hybrid方式

### 14.5 Worker分離

MVP初期はmain threadで機能を完成させ、閾値を超えた再計算をWeb Workerへ移す。

Workerは独立したFormula Stateを持ち、main threadからOperation差分を受け取る。

```text
main: operation delta → worker
worker: update graph → recalc → result batch + generation
main: discard stale generation → apply display results
```

毎回文書全体をstructured cloneしない。

### 14.6 計算値と永続化

- Operationログには入力値とFormula text／canonical ASTを保存する。
- 計算結果はスナップショットへキャッシュしてよい。
- キャッシュには`formulaEngineVersion`を付ける。
- エンジン版不一致時は再計算する。
- サーバーはformula textを再parse・validateし、クライアント生成ASTを無条件に信用しない。

### 14.7 初期関数

確定候補：

- `SUM`
- `AVERAGE`
- `MIN`
- `MAX`
- `COUNT`

追加候補：

- `IF`
- `AND`
- `OR`
- `ROUND`
- `ROUNDDOWN`
- `ROUNDUP`

関数ごとに、空白、文字列、エラー、範囲、数値変換の仕様を独自に明記する。

### 14.8 日付・ロケール

- Formula grammarはロケール非依存とする。
- 小数点は`.`、引数区切りは`,`を基本とする。
- セル表示・入力パースだけを`ja-JP`へローカライズする。
- 日付関数はLocalDate仕様が固まるまでMVP対象外とする。

---

## 15. Undo／Redo設計

### 15.1 基本原則

- 文書全体を過去へ巻き戻さない。
- 自分が実行し、サーバーで確定したTransactionを対象にする。
- Undoは対象Transactionを打ち消す補償Operationを新たに生成する。
- サーバーがOperationログと現状態からUndo可能性を検証する。

### 15.2 Undo Request

```ts
interface UndoRequest {
  type: 'undoRequest'
  documentId: DocumentId
  targetTransactionId: TransactionId
  clientId: string
}
```

サーバーは次を返す。

- `undoAccepted`＋補償Operation
- `undoRejected`＋理由
- 将来：`undoPartiallyAvailable`＋影響範囲

### 15.3 MVP対象

- 単一セル値変更
- 複数セル貼り付け
- 範囲クリア
- 基本書式変更

MVP後：

- 行・列追加
- 行・列削除
- 行列移動
- セル結合
- 並べ替え

### 15.4 条件付きUndo

セル値変更をUndoする場合、対象セルがその後に他Operationで変更されていないことを基本条件にする。

- 条件成立：以前の値へ戻す補償Operationを生成。
- 条件不成立：Undoを拒否し、競合理由を表示。
- 他ユーザーの後続変更を上書きする「強制Undo」はMVP対象外。

貼り付けはTransaction単位で全成功／全失敗とする。部分Undoは後続候補。

### 15.5 Redo

- Undoによって生成された補償Transactionを対象に、元Operationを再適用する。
- 対象セルがさらに変更されていればRedoを拒否する。
- 新しい通常操作を行った時点でローカルRedoスタックを破棄する。

---

## 16. 操作ログ・スナップショット設計

### 16.1 推奨DB構造

```text
documents
  id
  schema_version
  current_revision
  latest_snapshot_revision
  created_at / updated_at

document_operations
  document_id
  revision
  operation_id
  transaction_id
  actor_id
  client_id
  client_sequence
  operation_type
  payload
  inverse_seed
  created_at

document_snapshots
  document_id
  revision
  schema_version
  formula_engine_version
  payload_or_object_key
  payload_hash
  created_at
```

制約：

- `(document_id, revision)` unique
- `(document_id, operation_id)` unique
- Operation追加と`current_revision`更新を同一DB transactionで行う

### 16.2 スナップショット形式

初期はバージョン付きJSONを圧縮して使用する。

```ts
interface DocumentSnapshotEnvelope {
  schemaVersion: number
  documentId: DocumentId
  revision: number
  formulaEngineVersion: string
  createdAt: string
  document: SerializedDocument
  checksum: string
}
```

サイズが大きくなった場合、Object Storageへ移し、DBには参照とハッシュを保存する。

### 16.3 生成タイミング

暫定トリガー：

- 前回から1,000〜5,000 Operation
- Operation payload累積10〜50MB
- 一定時間経過
- 明示的なメンテナンス

Phase 0／1のリプレイ性能から閾値を決める。

### 16.4 復旧

1. 最新の正常なスナップショットを読み込む。
2. ハッシュとschema versionを検証する。
3. snapshot revision以降のOperationを順に適用する。
4. 最終Document hashを検証する。
5. Roomを受付可能状態にする。

定期テストでスナップショット＋ログから同じhashへ復元できることを確認する。

### 16.5 ログ保持

未決定事項：

- 全期間保持するか
- 監査期間だけ保持するか
- 古いOperationをアーカイブするか
- Undo可能期間と監査保持期間を分けるか

本番導入先の監査要件に依存するため、Phase 6前に確定する。

### 16.6 Presence

PresenceはDBへ保存しない。必要ならメトリクスとして集計値だけを保存する。

---

## 17. リポジトリ構成

### 17.1 推奨monorepo

```text
spreadjs/
  apps/
    playground/              単体検証・IME event recorder
    demo-react/              React組込例
    demo-hono/               Hono統合例
    collaboration-server/    開発用サーバー

  packages/
    types/
    core/
    selection/
    formula/
    sheet-renderer-canvas/
    sheet-editor-ime/
    collab/
    sheet-element/
    sheet-react/
    server/
    server-hono/
    sheet-testkit/

  tests/
    e2e/
    ime-manual/
    performance/
    protocol/
    replay/

  docs/
    architecture/
    adr/
    protocols/
    ime/
    performance/
    release/

  tools/
    generate-fixtures/
    replay-log/
    inspect-snapshot/
    event-trace-viewer/
```

### 17.2 開発規約

- strict TypeScript
- 公開APIはAPI Extractor相当の差分監視、または独自の型スナップショットを行う
- package boundaryをlintで検査する
- すべてのOperationへschema versionを持たせる
- coreにDOM型を持ち込まない
- Canvas座標はCSS pixelへ統一する
- エラーコードを文字列定数で管理する
- ログへセル内容を無条件に出さない

### 17.3 CI

- 型検査
- unit test
- protocol compatibility test
- replay determinism test
- browser E2E
- Canvas geometry snapshot
- bundle size
- dependency license scan
- performance smoke test

---

## 18. PoC計画

Phase 0は「製品機能を作る」のではなく、後戻りコストの高い技術判断を検証する。

### 18.1 PoC-A：日本語IME

#### 目的

常駐textareaでExcelに近い日本語連続入力が成立するかを確認する。

#### 実装範囲

- 20行×10列Canvas
- 単一セル選択
- 矢印、Enter、Tab
- 直接入力、F2、ダブルクリック
- composition event recorder
- リモート更新シミュレーター
- スクロールとtextarea追従

#### 合格条件

- 各対象環境で50回連続入力し、先頭文字欠落0件
- IME確定Enterによる誤移動0件
- 矢印／Enter／Tab移動後の再入力成功率100%
- 変換中のCanvas再描画で文字消失0件
- 変換中のリモート更新でドラフト消失0件
- イベントトレースを保存し、再現手順を文書化

### 18.2 PoC-B：Canvas・仮想スクロール

#### 実装範囲

- 50,000行×200列の論理表
- 可変行高・列幅
- 固定行・固定列
- 2,000〜4,000可視セル
- 選択・ドラッグ
- Presence overlay 20人
- 高DPI

#### 合格条件

- 参照端末で通常スクロールの95%フレームが33ms未満
- 停止中の再描画8〜12ms以内を目標
- pointerから選択枠表示まで50ms未満
- 10分連続スクロールでメモリが単調増加しない
- 50,000行でscroll anchorが維持される

### 18.3 PoC-C：共同編集・Operation

#### 実装範囲

- 3〜10クライアント
- SetCell、InsertRows、DeleteRows
- サーバーrevision
- optimistic apply＋rollback/replay
- Presence
- 切断・再接続
- operation idempotency

#### 合格条件

- 10,000件のランダムOperation後に全クライアントhash一致
- Operation重複送信で二重適用0件
- revision欠落を検知して自動catch-up
- 同一セル競合でローカル入力を保持
- サーバー再起動後にsnapshot＋logから復元

### 18.4 PoC-D：データ表現・数式

#### 実装範囲

- 50,000行
- 疎／密CellStore比較
- 500,000非空セル
- 四則演算、セル参照、SUM
- 10,000formula cells
- Operation replay

#### 合格条件

- メモリと読書き性能を計測し、CellStore方式をADR化
- 1セル変更の差分再計算が入力を阻害しない
- 行挿入後も固定ID参照が維持される
- 削除参照が`#REF!`になる
- 100,000 Operationのreplay時間を測定しsnapshot閾値を決められる

### 18.5 Phase 0期間と体制

- 期間：6〜8週間
- 推奨体制：技術リード1名、フロント／Canvas 1名、共同編集／サーバー1名
- QAまたは実利用者によるIME受入を週次で実施

### 18.6 Phase 0 Go／No-Go

Go条件：

- IME合格条件を満たす
- Canvasが50,000行で実用速度
- Operation収束性が確認できる
- メモリ見積が実用範囲
- 主要未決定事項をADR化できる

条件付きGo：

- 主要ブラウザーのうち1つに限定すれば成立
- 性能目標をデータ密度または列数の制約で達成可能

No-Go／再設計：

- 常駐textareaでも実IMEの先頭文字欠落を安定回避できない
- rollback/replayが入力遅延を恒常的に発生させる
- 想定データ量でブラウザーメモリ上限を超える

---

## 19. フェーズ別開発計画

### Phase 0：技術成立性とADR確定

- 期間：6〜8週間
- 主成果：4 PoC、event trace、benchmark、ADR-005〜016の主要決定
- 完了後：正式なMVPバックログと性能SLOを確定

### Phase 1：単一利用者コア・描画・IME基盤

- 期間：8〜10週間
- 文書／シート／行列／CellStore
- Canvas renderer
- Axis、仮想スクロール、固定行列
- 単一・矩形選択
- 常駐textarea、IME state machine
- Keyboard navigation
- Command／Operation local runtime
- 文字列、数値、日付
- 基本Clipboard
- 基本数式parserの骨格

### Phase 2：共同編集Alpha・永続化

- 期間：8〜10週間
- Hono WebSocket adapter
- Room Coordinator、sequencer
- operation log、snapshot
- optimistic queue、rollback/replay
- Presence
- reconnect、catch-up、idempotency
- セルOCC競合UI
- 行列追加・削除
- inline dropdown
- 最小数式：四則演算、参照、SUM

### Phase 3：業務利用MVP

- 期間：8〜10週間
- 複数セルcopy／paste
- 大量貼り付け制限と原子性
- Undo／Redo：セル、貼付、clear、基本style
- 行高・列幅
- 色、罫線、配置
- 数式：AVERAGE、MIN、MAX、COUNT、cycle、errors
- 競合センター
- 接続ユーザー一覧
- 権限フック
- API／Web Component／React wrapper安定化
- 監視、バックアップ、運用手順

**Phase 3終了を社内業務MVPの基準とする。**

### Phase 4：Excelライク操作拡張

- 期間：8〜12週間
- 複数範囲選択
- 行列全体選択
- フィルハンドル
- 一括入力
- 行列移動
- 並べ替え
- フィルター
- 右クリックメニュー
- コピー時の数式相対参照

### Phase 5：表示・シート・数式拡張

- 期間：8〜12週間
- セル結合
- 高度なwrap、セル内改行
- 条件付き表示
- 複数シート
- シート間参照
- IF、論理、丸め関数
- Formula Worker
- 大規模range dependency最適化

### Phase 6：品質・運用強化

- 期間：6〜10週間
- ブラウザー／IME回帰マトリクス
- 長時間接続・負荷試験
- 障害復旧演習
- snapshot migration
- セキュリティレビュー
- アクセシビリティ改善
- プロファイリング・メモリ改善
- API互換ポリシー、リリース手順

### 並行開発

- Phase 1のCanvas／IMEと、Phase 2のserver coreは並行可能。
- FormulaのASTと固定ID参照設計はPhase 1で開始し、関数実装だけを後段へ送る。
- テスト基盤、replay tool、event recorderはPhase 0から継続開発する。

---

## 20. テスト計画

### 20.1 Unit Test

- Axis index／offset変換
- RowId／ColumnIdとindexの整合
- CellStoreの疎・密操作
- Command→Operation変換
- Operation適用と逆操作seed
- Selection range演算
- Formula parser／evaluator
- date／number parser
- clipboard TSV parser
- Presence sequence／TTL

### 20.2 Property-based／Fuzz Test

- ランダムな行列挿入・削除・移動後もID整合
- 同じOperation列から常に同一hash
- Operation＋inverseで元状態へ戻る条件
- 不正数式でparserが停止・暴走しない
- TSVの引用、改行、巨大文字列
- Mergeが重複しない不変条件

### 20.3 Protocol Contract Test

- client/serverのmessage schema互換
- protocol version不一致
- operation重複
- revision欠落
- reconnect catch-up
- stale cell revision
- payload size超過
- authorization拒否

### 20.4 Browser E2E

- 選択、ドラッグ、キーボード
- copy／paste
- dropdown
- row／column操作
- Presence表示
- 競合UI
- reconnect
- Canvas resize／DPR

### 20.5 実IME試験

自動化と手動を分ける。

#### 自動

- compositionイベントstate machine
- synthetic event sequence
- focus／blur回帰
- textarea再生成検知

#### 実OS手動／半自動

- Microsoft IME
- Google日本語入力
- macOS日本語入力
- 候補確定、再変換、長文変換、文節移動
- 変換中クリック、スクロール、リモート更新

各試験ではevent trace、画面録画、環境情報を保存する。

### 20.6 Canvas試験

- Geometry command snapshotを主とし、OSフォント差の大きいpixel perfect比較だけに依存しない。
- 限定した参照環境でスクリーンショット比較を行う。
- hit testと描画rectが一致することを数値で検証する。

### 20.7 共同編集試験

- 複数クライアントのrandomized scenario
- 同一セル競合
- 行削除中編集
- サーバー再起動
- packet delay、drop、duplicate、reorderの疑似注入
- 100,000 Operation replay
- 24時間接続

### 20.8 性能試験

- 50,000行／200列
- 500,000非空セル
- 20 Presence
- 10,000セルpaste
- 10,000formula cells
- 高速scroll
- 長時間編集によるheap増加

### 20.9 リリースゲート

- 実IME重要シナリオ100%合格
- operation replay hash不一致0件
- P0／P1不具合0件
- 性能SLOを満たす
- snapshot restore成功
- protocol migration試験成功

---

## 21. 性能目標

以下はPhase 0で確定する暫定SLOである。

| 指標 | 暫定目標 |
|---|---:|
| アドレス可能行数 | 50,000行以上 |
| アドレス可能列数 | 200列以上 |
| 非空セル | 500,000基準、2,000,000ストレッチ |
| 可視セル描画 | 2,500セル程度を1フレーム8〜12ms目標 |
| スクロール | 95%フレーム33ms未満、通常時60fps志向 |
| 選択反応 | pointer／keyから50ms未満 |
| IME draft表示 | input eventから次フレーム以内 |
| 10,000セル貼り付け | ローカル適用250〜500ms以内を目標 |
| Operation伝播 | 同一リージョンp95 150〜250ms以内 |
| Presence伝播 | p95 250ms以内 |
| 再接続 | 1,000 Operation差分で2秒以内を目標 |
| 同時編集者 | 1文書20名 |
| メモリ | 基準データで300MB未満を目標 |
| snapshot restore | 基準文書で5秒以内を目標 |

参照端末を固定して測定する。例として、業務標準クラスの4〜8コアCPU、16GB RAM、内蔵GPUを用いる。具体機種はPhase 0開始前に決める。

---

## 22. リスク一覧

| ID | リスク | 影響 | 可能性 | 対応 |
|---|---|---:|---:|---|
| R-01 | IMEイベント順がOS・ブラウザーで異なる | 致命的 | 高 | 常駐textarea、event recorder、実IME試験、互換層 |
| R-02 | Canvasとtextareaの座標ずれ | 高 | 中 | 共通Transform、DPR試験、scroll anchor |
| R-03 | データ密度でブラウザーメモリ超過 | 高 | 中 | チャンクCellStore、非空セル目標、ページング拡張点 |
| R-04 | 未ACK rollback/replayが遅い | 高 | 中 | Operation粒度制御、batch、差分モデル、PoC |
| R-05 | 同一セル競合で入力消失 | 致命的 | 中 | OCC、ドラフト隔離、競合UI |
| R-06 | 行列操作と数式参照が壊れる | 高 | 中 | 固定ID AST、property test |
| R-07 | Undoが他ユーザー更新を壊す | 高 | 中 | 条件付き補償Operation、強制Undo禁止 |
| R-08 | 大量pasteがWS・DBを圧迫 | 高 | 高 | セル数上限、batch、payload参照方式 |
| R-09 | Presence更新が高頻度 | 中 | 高 | throttle、coalesce、TTL、非永続 |
| R-10 | Operationログ肥大化 | 中 | 高 | snapshot、archive、圧縮、保持方針 |
| R-11 | サーバー障害で文書Room停止 | 高 | 中 | log復旧、client reconnect、single-owner設計 |
| R-12 | 水平スケール時の二重sequencer | 致命的 | 低〜中 | document ownership、sticky routing、fencing token |
| R-13 | Canvasアクセシビリティ不足 | 中 | 高 | Keyboard、ARIA、段階的DOM mirror |
| R-14 | テスト組合せ爆発 | 高 | 高 | 状態機械、property test、優先環境定義 |
| R-15 | Excel同等期待が無制限に拡大 | 高 | 高 | 仕様境界書、非目標、段階リリース |
| R-16 | 数式仕様の曖昧さ | 中 | 高 | 独自仕様書、関数ごとの型規則 |
| R-17 | 外部依存回避により自作範囲が過大 | 高 | 中 | コアゼロ依存、低レベル依存はADRで許可 |
| R-18 | 文字列・日付・数値のロケール差 | 中 | 中 | canonical valueと表示を分離 |
| R-19 | 互換性のないprotocol更新 | 高 | 中 | version handshake、migration、N-1対応方針 |
| R-20 | 操作ログに機密セル値が残る | 高 | 中 | アクセス制御、暗号化、監査、ログ出力抑制 |

---

## 23. 各フェーズの完了条件

### Phase 0

- 4 PoC完了
- IME対象環境の合格条件達成
- 50,000行Canvasベンチ結果
- 共同編集random testでhash一致
- CellStore方式決定
- 主要ADR承認
- MVP性能SLO確定

### Phase 1

- 単一利用者で連続日本語入力可能
- 50,000行の基本scroll／selection
- 文字列、数値、日付を編集可能
- Clipboard基本動作
- CoreにReact／Hono依存なし
- 主要Operationをローカル適用可能
- unit coverageと不変条件テスト整備

### Phase 2

- 3名以上の同時編集
- Presence表示
- SetCell、行列追加削除の同期
- reconnectとidempotency
- snapshot＋log復元
- 同一セル競合でドラフト保持
- 最小数式が全クライアントで一致

### Phase 3

- 10,000セルpasteの制限内動作
- セル／貼付Undo／Redo
- 基本style、行高、列幅
- 20名Presence負荷試験
- React／Web Component公開API安定
- 運用監視、バックアップ、障害手順
- 社内業務で4週間のpilot運用

### Phase 4

- 複数範囲、fill、sort／filterの仕様確定・実装
- 操作組合せE2E
- 数式コピーの相対参照
- 共同編集下での行列移動収束

### Phase 5

- merge、複数sheet、式拡張
- Formula Worker
- 大規模range性能
- schema migration試験

### Phase 6

- 対応ブラウザー／IMEマトリクス合格
- 24時間接続、障害復旧、負荷試験合格
- セキュリティレビュー完了
- API互換・リリース・サポート方針確定

---

## 24. 未決定事項と意思決定期限

| ID | 未決定事項 | 推奨案 | 期限 |
|---|---|---|---|
| D-01 | 対応OS／ブラウザー | Windows Chrome／Edge最優先、macOS次順位 | Phase 0開始前 |
| D-02 | データ密度目標 | 500k非空セル基準 | Phase 0終了時 |
| D-03 | 同時編集者数 | 20名／文書 | Phase 0終了時 |
| D-04 | セル競合 | Soft lock＋OCC | Phase 1開始前 |
| D-05 | DB | PostgreSQL | Phase 1開始前 |
| D-06 | Server runtime | Node.js上のHono | Phase 0終了時 |
| D-07 | 初期シート数 | UIは1、モデルは複数対応 | Phase 1開始前 |
| D-08 | 日付正規値 | ISO LocalDate | Phase 1開始前 |
| D-09 | 数式MVP関数 | 基本5関数＋必要ならIF | Phase 1終了時 |
| D-10 | `$`絶対参照 | Fill導入前に必須 | Phase 3開始前 |
| D-11 | Paste上限 | **確定（DD-020・2026-07-17）: 100,000セル**（実行前拒否・性能保証は10,000セルで実測）。初期候補10,000から引き上げ | 確定済み |
| D-12 | 大量Operation transport | **確定（DD-020・ADR-0020・2026-07-17）: inline＋セル数上限**（payload参照方式は上限超要件化時に別ADR） | 確定済み |
| D-13 | 切断中編集上限 | 30秒／100Operation候補 | Phase 2開始前 |
| D-14 | Filter共有性 | 個人表示を第一候補 | Phase 3開始前 |
| D-15 | Sort共有性 | 明示的共有Operation候補 | Phase 3開始前 |
| D-16 | 行高・列幅共有性 | 文書共有を第一候補 | Phase 3開始前 |
| D-17 | Merge削除規則 | 破壊時自動解除候補 | Phase 4開始前 |
| D-18 | アクセシビリティ範囲 | Keyboard＋基本ARIA | Phase 1開始前 |
| D-19 | Operation保持期間 | 監査要件確認後 | 本番設計前 |
| D-20 | 文書sharding | single owner＋sticky | スケール試験前 |
| D-21 | 権限モデル | 文書read／writeから開始 | Phase 2開始前 |
| D-22 | 数式結果のserver検証頻度 | 非同期検証候補 | Phase 2開始前 |

---

## 25. 開発工数の概算

### 25.1 見積前提

- TypeScript、Canvas、WebSocketの経験者を含む。
- 既存の認証基盤、CI、PostgreSQL運用基盤を利用できる。
- モバイル・タッチ、Excel I/O、印刷、ピボット、長時間オフラインは含まない。
- デザインシステムの全面新規開発は含まない。
- 実IME試験用のWindows／macOS環境を用意できる。
- 1人月は実装・レビュー・テスト・文書化を含む。

### 25.2 人月レンジ

| フェーズ | 人月 |
|---|---:|
| Phase 0：PoC・ADR | 4〜6 |
| Phase 1：Core／Canvas／IME | 7〜10 |
| Phase 2：共同編集／永続化 | 7〜10 |
| Phase 3：業務MVP | 6〜10 |
| Phase 4：操作拡張 | 6〜9 |
| Phase 5：表示・数式拡張 | 6〜10 |
| Phase 6：品質・運用 | 4〜7 |
| **合計** | **40〜62** |

MVPはPhase 0〜3で**24〜36人月**。

### 25.3 推奨体制

- Tech Lead／Architect：1名
- Grid／Canvas／IME：1〜2名
- Collaboration／Backend：1名
- QA／Automation：0.5〜1名
- Product Owner／業務受入：0.2〜0.5名

3〜4名の実働開発者でMVPまで8〜12か月、Phase 5まで12〜18か月が目安。

### 25.4 単独開発の場合

- Phase 0：2〜3か月
- 技術Alpha：8〜12か月
- 社内MVP：18〜30か月
- 現行主要スコープ：30〜48か月

単独開発では、同時にCanvas、IME、共同編集、数式を進めず、Phase 0で順番と制約を厳格に決める必要がある。

### 25.5 見積を増加させる条件

- 100人以上の同時編集
- 高度な権限・監査
- 完全なスクリーンリーダー対応
- モバイル／タッチ
- 100万〜数百万の密なセルを常時クライアントへ保持
- 高度な数式互換
- 複数リージョンactive-active
- 長時間オフライン

---

## 26. 直近の実行計画

### 最初の2週間

1. monorepoとpackage boundaryを作成する。
2. `playground`へCanvas、常駐textarea、event recorderを実装する。
3. Windows 11のMicrosoft IME、Google日本語入力でイベントログを採取する。
4. `core`へ固定ID、Row／Column Axis、最小CellStoreを実装する。
5. `server`へin-memory sequencerを実装する。
6. Hono WebSocketで2ブラウザーのSetCell同期を動かす。
7. 参照端末と性能データセットを確定する。
8. ADR-005、008、010、011、012をレビューする。

### 3〜4週目

- Canvas 50,000行ベンチ
- Presence overlay
- rollback／replay
- IME変換中リモート更新
- CellStore比較
- formula parser最小版

### 5〜8週目

- ランダムOperation収束試験
- snapshot／replay試験
- 実IMEマトリクス
- SLO確定
- Phase 1正式バックログ
- Go／No-Goレビュー

---

## Appendix A：Operation例

### A.1 単一セル更新

```json
{
  "type": "submitOperation",
  "envelope": {
    "protocolVersion": 1,
    "documentId": "doc-1",
    "operationId": "op-...",
    "transactionId": "tx-...",
    "actorId": "user-1",
    "clientId": "client-1",
    "clientSequence": 42,
    "baseRevision": 105,
    "operation": {
      "type": "setCells",
      "conflictPolicy": "reject-overlap",
      "changes": [
        {
          "rowId": "row-10",
          "columnId": "col-name",
          "beforeRevision": 100,
          "value": { "kind": "string", "value": "株式会社ナナイロ" }
        }
      ]
    }
  }
}
```

### A.2 行追加

```json
{
  "type": "insertRows",
  "afterRowId": "row-10",
  "rows": [
    { "rowId": "row-new-1", "height": 24 },
    { "rowId": "row-new-2", "height": 24 }
  ]
}
```

Indexではなくanchor IDを使用する。

---

## Appendix B：IMEイベント記録形式

```ts
interface ImeEventTrace {
  timestamp: number
  browser: string
  os: string
  ime: string
  state: EditorState
  eventType: string
  key?: string
  code?: string
  isComposing?: boolean
  inputType?: string
  data?: string | null
  value: string
  selectionStart: number | null
  selectionEnd: number | null
  activeCell: CellAddressById
}
```

実装不具合は「IMEが変」と記録せず、イベント列と状態遷移で再現可能にする。

---

## Appendix C：技術的根拠として確認した公式資料

- Hono公式ドキュメント「WebSocket Helper」：Honoのサーバー側WebSocket helper、Node.js adapterでの`@hono/node-server`と`ws`の構成を確認。
- Hono公式ドキュメント「Node.js」：Node.js上のWebSocket組込み方法と旧`@hono/node-ws`の非推奨を確認。
- W3C「Input Events Level 2」：`beforeinput`／`input`とcompositionを含む入力イベントモデルを確認。
- W3C「UI Events」：keyboard・compositionを含むUIイベント仕様を確認。
- MDN「compositionstart」「beforeinput」「keydown」：composition session、`InputEvent.isComposing`、composition境界付近の`keydown`差異を確認。

---

## 最終判断

現時点では、追加の一般的な壁打ちよりもPhase 0へ進むべきである。ただし、Phase 0は本番コードの大量実装ではなく、IME、Canvas、共同編集、データ表現の成立性を数値とイベントログで確認する工程とする。

最初の製品判断は「機能を何個作れたか」ではなく、次の4点で行う。

1. 日本語IMEが実環境で自然か
2. 50,000行で描画・メモリが成立するか
3. Operation列が切断・競合後も収束するか
4. 入力内容を無言で失わないか

この4点を満たせば、外部スプレッドシート製品へ中核依存せず、長期的に自社で保守できる業務入力基盤として開発を継続する合理性がある。
