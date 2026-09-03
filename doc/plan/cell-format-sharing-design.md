# セル書式の共有化 設計整合文書（Operation 化・snapshot 拡張）

> 起票: DD-027-3（2026-07-21）。**本文書は設計整合まで＝実装しない**（親 DD-027 決定④「実装は発火条件付き」）。
> 共同編集採用案件の確定で実装子DDを採番する（手順は §6）。DD 添付ではなく `doc/plan/` 配下に置く理由:
> 発火条件付き実装の参照正本であり、アーカイブで埋もれる DD 添付だと後続子DDが辿れない（DD-011 要確認①の先例と同判断）。

## 1. 目的と位置づけ

DD-027-3 は「利用側供給の値→書式マッピングによる **view-local 描画**」（`columnFormats` mount オプション）を実装した。
これは**文書状態を変えない**（同じ表示値なら同じ見た目・設定一致は利用側責務）。本文書は、これを一段進めて
**書式を文書プロパティ化し全ユーザーで共有する**（＝Operation 化・snapshot 拡張・正準 hash への算入）ための設計を、
実装前に整合させておく。あわせて `stage2-backlog.md §3.5`（列幅・行高・wrap 設定の全ユーザー共有）と統合する。

- 現状（DD-027-3 実装済み・view-local）:
  - `columnFormats: Record<ColumnId, GridColumnFormatRule[]>`（mount 時固定・両モード共通）。
  - `GridColumnFormatRule = { match: string | string[]; style: { cellBackground?, textColor?, badge?, badgeColor? } }`。
  - 描画は base-layer の `getCellStyle(colIndex, value)` フック（プリコンパイル Map の O(1) lookup・可視非空セルのみ）。
  - **文書（CellScalar・protocol・snapshot・hash）は無変更**。設定不一致クライアントは異なる装飾を見る（文書 hash は乖離しない）。
- 本文書が設計する将来像（発火条件付き・未実装）:
  - 書式（値ベースルール／将来はセル単位の明示書式）を**文書プロパティ**として持ち、Operation で編集・全ユーザーへ同期し、
    snapshot/replay で復元し、正準 hash に含めて収束検証する。

## 2. 発火条件（いつ実装するか）

親 DD-027 決定④・roadmap §7 の確定に従う:

- **発火条件**: 共同編集を採用する consumer 案件が確定し、「全ユーザーで同一の書式（色・バッジ・将来はセル単位書式）を
  リアルタイム共有する」要求が実確認されたとき。
- **不成立時**: Stage 2 中に成立しなければ `DD-032` が Stage 3 バックログへ登録する（roadmap §7）。
- Stage 2 の consumer 2 件は共同編集不採用（roadmap §6）ゆえ、当面は view-local（DD-027-3）で要求を満たす。

## 3. モデルの置き場（3 案の比較）

| 案 | 置き場 | 長所 | 短所 |
|---|---|---|---|
| A: ルール文書化 | 「列→値→style」ルール集合を**文書プロパティ**（`document.formatRules`）として持ち Operation で編集 | データ量小（ルールは疎）・DD-027-3 の view-local ルールと同形＝移行が滑らか・値ベースで自動着色 | 「特定セルだけ手で色を変える」明示書式は表現できない（値に紐づく） |
| B: セル単位書式 | セルごとに style を持つ（`CellRecord.style`）。CellScalar とは別レイヤ | Excel 的な任意セル書式が表現できる | データ量大（密行列で肥大）・hash/snapshot への影響大・OCC 粒度が細かくなる |
| C: 併用 | ルール（A）＋セル override（B）。描画は override > ルール > 既定 で合成 | 表現力最大 | 最も複雑・2 系統の同期/OCC/合成順の設計が要る |

**推奨（実装子DDの初期案）**: まず **案 A（ルール文書化）** を実装する。DD-027-3 の view-local ルールと同一形状ゆえ、
`columnFormats`（mount 固定）→ `document.formatRules`（共有・可変）への移行が最小差分になる。案 B/C は
「セル単位明示書式」の実要求が出てから追加する（憲章 §13.2＝共通要求が確認されるまで確定しない）。

## 4. Operation 化・snapshot・hash・OCC の拡張方針（案 A 前提）

### 4.1 FormatOperation の形

既存 `DocumentOperation = SetCellsOperation | InsertRowsOperation | DeleteRowsOperation`（`packages/core/src/operations.ts`）へ
`SetFormatRulesOperation` を追加する（union 拡張）。ルールは列単位の集合を差し替える粒度を初期案とする（セル単位でなく列単位＝
OCC 粒度を粗く保ちデータ量を抑える）。

```ts
// 設計イメージ（未実装）
interface SetFormatRulesOperation {
  type: 'setFormatRules';
  conflictPolicy: 'reject-overlap';       // 既存 SetCells と同語彙
  changes: ReadonlyArray<{
    columnId: ColumnId;
    beforeRevision?: number;               // 列の書式リビジョン（stale 検査・§4.4）
    rules: readonly GridColumnFormatRule[]; // 空配列＝当該列の書式解除
  }>;
}
```

- 値の一致条件（match）は DD-027-3 と同一（完全一致 v1）。protocol へ乗せるのは JSON シリアライズ可能な素の
  ルール配列（関数 callback は乗せない＝v1 対象外を維持）。

### 4.2 snapshot 拡張と version 方針

`DocumentSnapshot`（`packages/core/src/document-snapshot.ts`）へ `formatRules?: Record<ColumnId, GridColumnFormatRule[]>` を
**任意フィールド**で追加する。

- **後方互換**: 旧 snapshot（`formatRules` 無し）は「書式なし」として復元する（fail-fast しない＝欠落は空扱い）。
- **version**: snapshot に version フィールドがある場合は minor bump（後方互換の追加）。deserialize は未知の追加フィールドを
  無視する寛容パーサにし、`columnOrder` 外の列を参照する formatRules は fail-fast（安定 ID 破損検知・既存 cell 参照と同方針）。

### 4.3 正準 hash への算入

`documentHash`（収束検証の基底）へ formatRules を**正準順序で**含める。

- 正準化: 列は `columnOrder` 順、各列内のルールは「match 値の昇順」で正規化してから hash 材料に入れる（挿入順で hash が
  ブレないように＝replay 決定性）。style のキーも固定順で直列化する。
- **重大な含意**: hash に含めた瞬間、**設定（書式）が全クライアントで一致していないと hash が乖離する**。view-local
  （DD-027-3）は hash に含めないので乖離しなかったが、共有化後は「書式も収束対象」になる。invariant テスト
  （`tests/invariants/collab`）に書式編集を混ぜた収束シナリオを追加すること（実装子DDの AC）。

### 4.4 OCC 粒度

- 初期案は**列単位**の楽観ロック（`beforeRevision` を列の書式リビジョンに対して検査）。同一列の書式を 2 人が同時に
  変更したら後着を reject（既存 SetCells の stale-cell-revision と同型の語彙＝公開 `cell-conflict` 系へ写像）。
- セル単位書式（案 B）を将来入れる場合は、セル OCC（既存 SetCells と同じ beforeRevision）へ揃える。

## 5. §3.5（列幅・行高・wrap の全ユーザー共有）との統合方針

`stage2-backlog.md §3.5`「列幅・行高・wrap設定の全ユーザー共有」は本書式共有と**同じ機構**（view-local→文書プロパティ化・
Operation 化・snapshot 拡張・hash 算入）を必要とする。統合方針:

- レイアウト（列幅/行高/wrap）と書式は**別の Operation 種別**として設計するが、**同一の設計パターン**（任意 snapshot
  フィールド＋正準 hash 算入＋列/行単位 OCC）を共有する。実装子DDは両者を**同一の設計レビューで**扱い、片方だけ hash に
  入れて他方を view-local に残す不整合を避ける。
- 現状（view-local）の公開契約は**維持する**: `columnWidths`/`rowHeights`/`wrapColumns`/`columnFormats` の mount オプションと
  `layout` イベント（DD-012-4 D2）は、共有化後も「初期値注入＋利用側保存」の後方互換経路として残す（共有化は上乗せ）。
- auto-fit（DD-027-3・C級）は列幅の**算出**であり共有化の対象ではない（結果の列幅 override が §3.5 の共有対象に乗るだけ）。

## 6. 実装子DDの採番手順（発火時）

1. 発火条件（§2）の成立を確認し、共有対象を確定する（書式のみ／レイアウトのみ／両方）。
2. 親 `DD-027`（列タイプ体系）の系譜ではなく、roadmap §7 が指す **`DD-032`**（Stage 3 バックログ登録先）を起点に、
   Stage 2 内実装なら新規子DDを採番（例 `DD-0xx セル書式・レイアウトの共同編集共有`）。roadmap の採番規約（letter 枝番禁止・
   親子は roadmap 指定）に従う。
3. 本文書（§3 推奨＝案 A）を実装前詳細化 📐 の入力とし、Risk Class は **A**（protocol/snapshot/hash 変更＝収束の基盤）。
   Human Spec Gate は「セル単位書式（案 B）を含めるか」「OCC 粒度」をユーザー確定する。
4. Codex（利用可なら）または Fable 5 独立レビューで、hash 算入による収束検証（invariant）と後方互換 snapshot を必須確認する。
5. 完了時に本文書へ「実装済み・実装DD番号・view-local からの移行結果」を追記し、`stage2-backlog.md §3.5`／§3.6 の該当行を消し込む。

## 7. 未保証・既知の論点（実装子DDが解く）

- 設定不一致クライアントの扱い（view-local 時代の「各自設定」から「文書共有」への移行時、旧 `columnFormats` mount 指定と
  文書 formatRules の**合成順序**）。初期案: 文書 formatRules が正・mount `columnFormats` は文書に formatRules が無いときの
  フォールバック（後方互換）とする。
- 数値/日付セルの match 正準性（表示文字列ベース＝DD-027-3 と同じ。`"1234"` に一致し `"1,234"` には一致しない）。
- バッジ/色の描画予算（共有化しても描画経路は DD-027-3 と同一＝O(可視非空セル)。予算 p95 16.7ms・redraw ≤12ms を維持）。

## 参照

- 親: `doc/DD/DD-027_列タイプ体系.md`（決定④⑤）／子: `doc/DD/DD-027-3_セル書式モデル.md`（view-local 実装・📐）
- `doc/plan/stage2-backlog.md` §3.5/§3.6・roadmap §7（`doc/plan/phase2-dd-roadmap.md`）
- `packages/core/src/operations.ts`（DocumentOperation union）・`packages/core/src/document-snapshot.ts`（snapshot/hash）
