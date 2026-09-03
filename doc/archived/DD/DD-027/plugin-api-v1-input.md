# DD-027 → P-07 判断材料メモ（Plugin API v1 範囲の入力）

> 作成: 2026-07-21（DD-027 親 Phase 4・オーケストレータ〔Fable 5〕）。**提出先: P-07 判断ゲート（DD-030 起票前の独立判断）**。
> 位置づけ: DD-027「列タイプ体系」は **Cell type plugin の実質プロトタイプ**として設計した（roadmap §1・製品憲章 §13.1/§13.2）。
> 本メモは「宣言的 mount オプションだけで何が実現でき、何が実現できなかったか（＝将来の register API／fork 圧力）」を事実として記録する。
> **v1 API を確定するものではない**（憲章 §13.2: 複数実案件の共通要求が確認されるまで確定しない）。

## 1. 実装した内部構造（v1 候補インターフェースの実体）

DD-027 は列タイプを **grid 層の宣言的 mount オプション**（`columnTypes` / `columnFormats`）＋**Internal な registry**として実装した。core（CellScalar・protocol・snapshot・hash）は一切変更していない（値は string のまま）。consumer 向けの register API は**公開していない**（決定⑤）。

### 1.1 ColumnTypeRegistry（`packages/grid/src/column-types.ts`・Internal）
mount 時に `columnTypes` をプリコンパイルした列単位メタの O(1) 参照器。実装済みメソッド（＝v1 候補 I/F の観測点）:

| メソッド | 役割 | 対応する Plugin 候補（§13.1） |
|---|---|---|
| `isSelectColumn` / `getSelectOptions` / `allowsFreeText` | 選択式列の判定と静的候補供給 | Cell editor |
| `validateEditorCommit(columnId, value)` | commit 前検証（chokepoint `submitSetCells` 手前・editor 経路限定） | Validator |
| `isLinkColumn` / `getLinkType` | リンク列の判定と defaultOpen 取得 | Cell type（クリック解釈） |
| `hasAnySelectColumn` / `hasAnyLinkColumn` | 未使用時の cheap path ゲート（描画/裁定オーバーヘッド 0） | 全 Plugin 共通の「無効時ゼロコスト」契約 |

### 1.2 CompiledColumnFormats（`packages/grid/src/format-rules.ts`・Internal）
mount 時に `columnFormats` を「列→値→style」Map へプリコンパイル。描画ホットパスは `getStyle(columnId, value)` の O(1) lookup。

| メソッド | 役割 | 対応する Plugin 候補（§13.1） |
|---|---|---|
| `getStyle(columnId, value)` | 値→書式（背景色・文字色・バッジ）の解決 | Canvas renderer / overlay |
| `hasAny()` | 未使用時の cheap path ゲート | 描画 Plugin の「フレーム予算を破らない」契約 |

### 1.3 描画・裁定フック（render/mount-controller・Internal・§13.1 の renderer/editor 相当）
- `base-layer` の `getCellStyle` / `isLinkColumn` / `isWrapColumn` フック（同型・DOM 非依存・render 内部の描画契約型 `ResolvedCellStyle` は公開型 `GridCellFormatStyle` と構造同一＝R7 型漏洩0）。
- 選択式エディタ（`select-editor.ts` の純粋 `createSelectController` ＋薄い DOM アダプタ）／リンククリック裁定（`link-column.ts` の純関数 `shouldArmLinkCandidate`）。いずれも editor-state-machine・commit-bridge・常駐 textarea には**触れていない**（T1 非該当）。

**観察**: 3 機能とも「grid 層の登録制メタ＋描画/裁定/検証フック」で成立した。これは §13.1 の Plugin 候補（Cell type / Validator / Canvas renderer / Cell editor）と構造的に一致する。**registry を consumer に開けば Cell type plugin API v1 の骨格になり得る**（＝有力な v1 候補）。

## 2. 宣言的設定「だけ」で実現できた要求（v1 を register API 化しなくても足りた範囲）

- 選択式入力（静的候補・commit 前検証・`allowFreeText` で自由入力許可・paste/setData/リモート由来の非候補値は保持）。
- ハイパーリンク列（クリック→`link-open` 通知・SDK は navigate しない・opt-in の `defaultOpen` で http/https のみ open）。
- 値ベースのセル書式（背景色・文字色・バッジ／表示文字列の完全一致・view-local 描画）。
- ダブルクリック auto-fit（列内容幅への自動調整・layout イベントで利用側保存）。
- 両モード（共同編集/単独 DD-024）共通・mount 時固定（`wrapColumns` と同運用）。

→ **Stage 2 の consumer 要件（ReadyCrew 案件DB 商談進捗パイプライン画面）は宣言的 mount オプションで充足した。** 現時点で register API を公開する差し迫った必要はない（憲章 §13.2 の「確定しない」判断を支持する事実）。

## 3. 宣言的設定「では実現できなかった／保留した」要求（＝将来の register API・fork 圧力の記録）

以下は v1 を宣言的設定に限定したことで**実装しなかった**要求。複数実案件で再要求されたら register API（または宣言モデルの拡張）の検討材料になる。

| # | 要求 | v1 での扱い | register API 化の圧力・備考 |
|---|---|---|---|
| A | **動的候補供給**（callback / Promise で候補を返す） | 対象外（静的候補のみ） | 参照マスタ連動の選択肢等で再要求されやすい。callback は「フレーム予算契約」（§13.2）を要する |
| B | **書式の一致条件拡張**（値レンジ〔数値比較〕・正規表現・利用側 callback） | 対象外（表示文字列の完全一致のみ） | 数値しきい値での色分け等。callback 形は描画 Plugin のフレーム予算契約が前提 |
| C | **列全体の静的背景色**（値によらない列色） | 対象外（書式は値ベース＝非空セルのみ） | 空セルへのオーバーフロー流入裁定を複雑化するため保留 |
| D | **選択式のリスト提示＋自由確定併存**（Excel の入力規則「リスト」相当） | 見送り（`allowFreeText:true` は候補ドロップダウンを出さず自由入力のみ） | DD-027-1 Fable レビューで既知制約化。Alt+↓ で候補提示＋自由確定、が Excel 準拠。**設定だけで実現できなかった代表例** |
| E | **編集継続する拒否 UX**（非候補値の commit を握り潰して textarea を閉じず再入力させる） | 見送り（未 submit＋通知に留めた） | editor-state-machine 改変＝IME 経路変更（T1）を招くため回避。register API で editor plugin を開くなら再検討点 |
| F | **書式の全ユーザー共有**（Operation 化・snapshot 拡張） | 設計整合文書のみ（`doc/plan/cell-format-sharing-design.md`）・実装は発火条件付き | 共同編集採用案件の確定が発火条件（親④）。文書 hash は乖離しない前提 |
| G | **consumer 向け register API そのもの**（editor/renderer/validator を利用側が差し込む） | 非公開（registry は Internal） | 本メモの主題。Stage 2 では宣言的設定で足り、公開の必要が生じなかった |

## 4. P-07 への提言（判断材料・結論は P-07 ゲートに委ねる）

- **registry（§1）は Cell type plugin API v1 の有力な骨格候補**である（3 機能が同一構造で成立した実証）。ただし現状は Internal のままで Stage 2 要件は充足しており、**今すぐ register API を確定・公開する差し迫った必要はない**（§13.2 の判断を事実で支持）。
- v1 を開く場合の**最初の圧力源**は D（リスト＋自由確定）・A（動的候補）・B（書式の条件拡張）。これらは「宣言モデルの拡張」で吸収できるもの（A の一部・B の一部・D）と、「callback＝フレーム予算契約が要るもの」（A/B の callback 形・E の editor 差し込み）に分かれる。**v1 の線引きは『宣言的拡張』と『callback/フック公開』の境界に置くのが自然**。
- **fork 圧力の兆候**: 現時点では観測されない（consumer は Facade の宣言的設定で統合できている＝本 SDK の showcase/demo 自身がその実証）。D/E を強く求める実案件が複数現れた時点が、register API 検討の発火点になる。

## 5. 参照
- 親DD: `doc/DD/DD-027_列タイプ体系.md`（決定事項①〜⑥）／子: `DD-027-1`（選択式）・`DD-027-2`（リンク）・`DD-027-3`（書式）
- 共有化設計: `doc/plan/cell-format-sharing-design.md`（要求 F の拡張方針）
- 憲章: 製品計画 §13.1（Plugin 候補）／§13.2（v1 は複数実案件の共通要求まで確定しない・描画 Plugin のフレーム予算契約）
- 描画性能の実測（回帰なし）: `doc/DD/DD-027-3/perf-before-no-format.json` / `perf-after-with-format.json`
