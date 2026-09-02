# DD-021-1: 行操作Command・公開API

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-07-17 | 2026-09-03 | 完了 | 親=DD-021（3分割の第1子）。実装・全検証 green・**Fable 5 レビュー（Codex high 代替・ユーザー決定）P2×2/P3×1 反映済み**。親は Manual Gate 待ち＝子DDのみ先行アーカイブ（2026-09-03） |

```text
Risk Class: A
Risk Triggers: 公開 API 新設（GridInstance メソッド・イベント種別=外部I/F）／単独グリッドモードの保存契約拡張（row-structure-change を利用側が取りこぼすと行構造がサイレント喪失）／常駐 textarea の keydown 裁定=IME 周辺（Editing/Composing 中の誤発火は入力破壊）／RowId 採番の一意性前提（apply の呼び出し側契約=DA D11）
Human Spec Gate: 解決済（親 DD-021 要確認④⑥⑦確定=2026-07-17 フル委譲モード）
Codex: 不可（本起票環境・`bash scripts/codex-review.sh --check` exit 1）。実装セッション開始時に再チェックし、利用可なら**必須・effort high**（公開 API 新設・外部I/F。protocol/IME 状態機械の実質変更なし=xhigh 非該当。発生時は停止して昇格）でレビュータスクを追加する
Manual Gate: なし（本子DDは synthetic E2E まで。実機は親 Phase 4 に集約）
External Review: なし
Evidence Level: full（A区分=L5。API 契約・イベント payload・既知の未保証境界を省略しない）
```

> アプローチ: E2E駆動（UI 発火・利用側契約の振る舞い）＋TDD（backend 経路・イベント生成）
> 親=**DD-021**。依存: なし（Operation/apply/収束基盤は Stage 1 資産）。完了後は DD-021-2（収束・競合）へ。

## 目的

行 Insert/Delete を利用者機能として発火可能にする: `GridInstance.insertRows/deleteRows` 公開 API＋グリッド内蔵ショートカット（両モード）＋行構造変更の利用側通知イベント `row-structure-change`（standalone の保存材料）。現状、行操作の発火手段は playground E2E のテストヘルパー（`submitInsertRowsAfter`/`submitDeleteRow`=`ClientSession.submitLocalOperation` 直呼び）しか存在しない。

## 背景・課題（親 DD-021 §背景の該当分）

- `packages/core` の `InsertRowsOperation`（afterRowId アンカー・新 RowId 同梱）/`DeleteRowsOperation`（tombstone・冪等 no-op）と適用・検証・描画追従（`document-view.ts` row-structure dirty）は実装済み。**公開面（GridInstance・イベント・UI）だけが無い**。
- `GridInstance`（`packages/grid/src/index.ts`）の現行契約: `documentId`/`connectionState`/`subscribe`/`focus`/`setData`/`destroy`。cell-commit イベントはセル値専用（DD-024）＝行構造変更を利用側へ通知する手段が無い。
- 単独グリッドモード（`standalone-session.ts`）は初期データ注入で insertRows を内部使用するのみ。利用者発火の行操作経路・保存契約が未定義。
- keydown 裁定は `mount-controller.ts`（DD-020-3 の `decideUndoRedoKey` と同型の Navigation 位相限定パターンが確立済み）。

## 検討内容

- **API 形状（親⑥確定）**: `insertRows({ afterRowId: string | null, count?: number }): void`・`deleteRows(rowIds: readonly string[]): void` を `GridInstance` へ追加（execute Command bus 化はしない・内部型非露出=R7）。戻り値・エラーは既存イベント経路（rejected/error）で通知し、同期 throw しない（既存 API 流儀）。細部シグネチャは Phase 0 📐 で確定。
- **RowId 採番**: `crypto.randomUUID()`（計画書 §7.6。apply の「rowId 未使用」前提=DA D11 を満たす）。挿入結果の rowId は `row-structure-change` イベントで利用側へ返す。
- **イベント `row-structure-change`（親⑥確定）**: 両モード共通・GridEvent へ種別追加。payload 案=`{ kind: 'insert', rows: [{rowId, afterRowId}] } | { kind: 'delete', rowIds }`（確定分のみ通知か楽観適用時か=collab の通知タイミングは Phase 0 📐 で確定。standalone は即時確定）。cell-commit はセル値専用を維持。
- **ショートカット（親⑦確定）**: Ctrl+Shift+'+'=アクティブ行の**上**へ挿入（afterRowId=直上行・先頭行なら null）／Ctrl+'-'=選択範囲（selection-controller.selectedRange の行帯・無ければアクティブ行）の削除。**Navigation 位相のみ**（Editing/Composing はブラウザ既定・IME 不変条件維持・状態機械へ遷移追加なし）。
- **削除時の activeCell 縮退（親④確定・ローカル発火分）**: 自分の削除でアクティブ行が消えたら最近傍生存行（下優先→無ければ上）へ移動・選択は生存行へ縮退。（リモート起因の再ベース一般化は DD-021-3=K3）。
- **standalone 経路**: `standalone-session.ts` へ insertRows/deleteRows の適用＋`row-structure-change` 発火を追加。`setData` 再注入は行構造ごと差し替え＝再注入後の整合（イベント発火しない・Undo クリア等は DD-020-3 先例）を定義。
- **公開語彙**: 削除対象なし・不正アンカー等の実行前拒否コードを `error-codes.ts` へ追加（命名は 📐 で確定）。collab の reject は既存 rejected（GridConflict）経路。

## 決定事項（親 要確認の確定〔2026-07-17〕の継承）

- **親⑥**: `insertRows({ afterRowId, count })`/`deleteRows(rowIds)` 個別メソッド＋新イベント `row-structure-change`（両モード共通・cell-commit はセル値専用維持）。API 型 snapshot 差分は CHANGELOG 記録。
- **親⑦**: 公開 API を正・ショートカット Ctrl+Shift+'+'（アクティブ行の上へ挿入）/Ctrl+'-'（選択行削除）・Navigation 位相のみ。コンテキストメニュー対象外。
- **親④（ローカル分）**: 削除でアクティブ行消失→最近傍生存行（下優先→上）へ移動・選択縮退。

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | `insertRows({afterRowId, count:2})` → 指定位置に2行挿入・`row-structure-change`（insert・新 rowId＋アンカー）が発火する | Phase 1 unit＋Phase 2 E2E |
| 2 | `deleteRows([rowId])` → 行が表示から消え（tombstone）・`row-structure-change`（delete）が発火する | Phase 1 unit＋Phase 2 E2E |
| 3 | Navigation 位相で Ctrl+Shift+'+' → アクティブ行の上に1行挿入。Ctrl+'-' → 選択範囲の行が削除される | Phase 2 E2E |
| 4 | Editing/Composing 中の同ショートカット → 行操作は発火しない（textarea 既定・composition 非破壊） | Phase 2 synthetic＋IME 不変条件 |
| 5 | 削除でアクティブ行が消える → activeCell が最近傍生存行（下優先→上）へ移動・選択は生存行へ縮退・クラッシュしない | Phase 2 E2E＋unit |
| 6 | standalone モードで行操作 → `row-structure-change` で利用側が行構造を保存できる（rows 再構成が文書と一致）・`setData` 再注入と整合 | Phase 2 standalone E2E |
| 7 | collab モードで行操作 → `submitLocalOperation` 経由で ACK・他クライアントの表示に反映される（収束の網羅は DD-021-2） | Phase 2 collab E2E（2クライアント smoke） |
| 8 | 不正入力（未知アンカー・削除対象なし・count≦0）→ 実行前拒否・公開コードで通知・文書無変更 | Phase 1 unit＋Phase 2 E2E |
| 9 | API 型 snapshot・CHANGELOG・error-codes.md に追加分が記録される | contract test＋網羅確認 |

## タスク一覧

### Phase 0: 事前精査
- [x] 📋 **各Phaseのタスク精査・詳細化**（AC⇔検証対応・対象パス・変更内容の具体性・🔬の有無）
- [x] 📐 **実装前詳細化**（判定=要〔公開 API 新設・外部I/F・3ファイル超〕）: API シグネチャ・`row-structure-change` payload と collab 通知タイミング（楽観 or 確定）・公開エラーコード命名・selection 行帯→rowIds 解決を確定（→ ログ「実装セッション」参照。フル委譲モードのため 👀 確認はログ記録で代替）
- [x] 🧑‍⚖️ **Codexレビュー要否判定**: 実装セッションで `--check` 再実行 → exit 1（Codex 利用不可）。**スキップ**し次セッションへ持ち越し（ログ参照）
- [x] 😈 **Devil's Advocate調査**（→ DA批判レビュー記録参照）

### Phase 1: backend 経路・イベント生成（TDD）
- [x] `packages/grid/src/grid-backend.ts`: 行操作 submit の共通契約 → 既存 `submitLocalOperation`（両モードが構造 Op を適用可能）で充足。**変更不要**を確認（ログ参照）
- [x] `packages/grid/src/standalone-session.ts`: insertRows/deleteRows は既存 `submitLocalOperation`（applyOperation＋noteOperation）で適用済み・`setData` 再注入は履歴/通知リセット済み（DD-020-3 先例）。row-structure-change の emit は mount-controller に集約したため**変更不要**を確認（ログ参照）
- [x] `packages/grid/src/index.ts`: `GridInstance.insertRows/deleteRows`・GridEvent へ `row-structure-change` 種別・`GridRowStructureChange` 公開型を追加（内部型非露出＝RowId は文字列）
- [x] `packages/grid/src/error-codes.ts`: 実行前拒否コード `row-anchor-unknown`/`row-count-invalid`/`row-delete-empty` を追加
- [x] `packages/grid/src/row-operations.ts`（新設）: 純関数 `decideRowStructureKey`/`resolveDeleteTargets`/`reduceActiveRowTarget`＋`row-operations.test.ts`（TDD・15 ケース）
- [x] 🔬 **機械検証**: `npm run test`（967 pass）`npm run typecheck`（全 green・boundary new=0）
- [x] 😈 **DA批判レビュー（「このPhaseで何が壊れるか」を探す。基準: da-method.md §3.4）**

### Phase 2: UI 発火・配線・E2E
- [x] `packages/grid/src/mount-controller.ts`: 公開 API 配線（insertRows/deleteRows）・keydown 裁定（`decideRowStructureKey`・Navigation 位相のみ）・削除時 activeCell 縮退（最近傍生存行＋index シフト補正）
- [x] `apps/playground/e2e/row-operations.spec.ts`（新設）: AC1〜8 の E2E（standalone 主・collab 2クライアント smoke）。8 ケース全 green。既存 `submitInsertRowsAfter`/`submitDeleteRow` は**併存**（既存 integration/reconnect spec が依存・raw ClientSession 経路の低レベル検査用。公開 API 検査は新 spec が `__gridInstance` 経由で担う）
- [x] `tests/invariants/ime/row-structure.invariant.test.ts`（新設）: Editing/Composing 中ショートカット非干渉ケース追加（全位相×composing 掃引＋実セッション composition 非破壊）
- [x] contract snapshot（`-u` 更新）・`CHANGELOG.md`・`doc/archived/DD/DD-017/error-codes.md`（DD-017 はアーカイブ済み＝DD-020 と同運用）へ API/語彙追加を記録
- [x] 🔬 **機械検証**: `npm run test`（967 pass）`npm run lint`（eslint＋boundary new=0）`npx playwright test row-operations`（8 pass）→ 全 green
- [x] 😈 **DA批判レビュー（基準: da-method.md §3.4）**

## 引き継ぎ物（→ DD-021-2 / 親 Phase 4）

- 公開 API `insertRows`/`deleteRows`・イベント `row-structure-change`・公開エラー語彙（DD-021-2 の収束テストが公開経路で行操作を発火できる）。
- E2E 発火経路（row-operations.spec の操作ヘルパー）。
- features.json の available 化・Manual Gate は親 Phase 4（本子DDでは触らない）。

## ログ

### 2026-07-17
- DD作成（親 DD-021 の Phase 1 を自己完結の子DDとして起票。親 要確認①〜⑦は同日確定済み=フル委譲モード。④⑥⑦の確定値を決定事項へ転記）。
- Codex 利用可否: 不可（本起票環境）。実装セッションで再チェック（ヘッダ参照）。

### 2026-07-17（実装セッション）
- **Codex 再チェック**: `bash scripts/codex-review.sh --check` → exit 1（起動できる codex CLI が無い）。**Codex レビューはスキップ**。実装は完了だが Codex レビューは次セッションで実施要（勝手に完了扱いにしない）。
- **Phase 0 📐 確定**（実装前詳細化）:
  - **API シグネチャ**: `insertRows(options: { afterRowId: string | null; count?: number }): void`（count 既定 1）／`deleteRows(rowIds: readonly string[]): void`。いずれも同期 throw しない（既存 API 流儀）。boot 未完了時は黙って無視（setData と同型）。
  - **`row-structure-change` payload**: `{ type: 'row-structure-change'; change: GridRowStructureChange }`。`GridRowStructureChange = { kind: 'insert'; afterRowId: string | null; rowIds: readonly string[] } | { kind: 'delete'; rowIds: readonly string[] }`（RowId は文字列＝R7）。insert の rowIds は crypto.randomUUID 採番の新 RowId（表示順）。
  - **collab 通知タイミング=楽観適用時**（submit 直後）に確定。standalone は即時確定＝同一。理由: 本イベントの主目的は standalone の保存材料であり、公開 API/ショートカット発火 → 楽観適用 → 即通知が最も素直（reject は既存 rejected 経路で別途通知）。**リモート起因の行構造変更の通知は本子DD対象外**（ローカル発火のみ・DD-021-2/3 へ）。
  - **公開エラーコード命名**（GRID_CONFLICT_CODES へ追加・実行前拒否＝operationId 空文字）: `row-anchor-unknown`（insert の未知アンカー）／`row-count-invalid`（count≦0 または非整数）／`row-delete-empty`（delete 対象が空/全て非現存）。collab のみ rejected 発火・standalone は診断のみ（DD-020 先例）。
  - **selection 行帯→rowIds 解決**: Ctrl+'-' は `selectionCtrl.selectedRange(activeCell)` の行帯 [rowStart,rowEnd) を `view.rowIdAt` で RowId 列へ変換 → `deleteRows`。無選択時は activeCell の単一行。
  - **emit 集約点**: `row-structure-change` は mount-controller の行操作 submit 経路で**両モード共通に 1 箇所**から emit（standalone-session に専用 callback を足さない＝単一 emission 点で単純化）。standalone-session は既存の `submitLocalOperation`（applyOperation＋noteOperation）で構造 Op を適用済みのため**変更不要**。
  - **activeCell 縮退**: 削除前の表示行順・active index を採取 → 削除後、active 行が消えていれば最近傍生存行（下優先→上）へ `editor.pointerdownCell` 再シート、生存行皆無なら選択解除。active 行が生存でも index シフトすれば同一 RowId の新 index へ再シート（ローカル削除の index 整合。一般の選択再ベースは DD-021-3）。composition 中は触らない（I-3）。
- **IME 状態機械の遷移追加・protocol 変更**: いずれも不要（xhigh 昇格条項に非該当）。keydown 裁定は `decideRowStructureKey`（純関数・Navigation 位相かつ非 composing のみ・`decideUndoRedoKey` と同型）で状態機械の**前段**消費、状態機械へは一切手を入れない。

---

## DA批判レビュー記録

### Phase 1/2 DA批判レビュー（2026-07-17）

**DA観点:** 公開 API が外部 I/F になる点・常駐 textarea の keydown 裁定が IME 経路を汚す点・行削除で activeCell/表示行 index が壊れる点・row-structure-change の取りこぼしで行構造がサイレント喪失する点。

| # | 発見した問題/改善点 | 重要度 | 再現手順（高/中は必須） | DA観点 | 対応 |
|---|-------------------|--------|----------------------|--------|------|
| 1 | `displayCell` は tombstone 下でも cell データを返す（削除で表示から消えたことの検証に使えない） | 中 | deleteRows 後に displayCell(削除行) を読むと旧値が返る | テスト誤検知 | E2E AC2 を「表示行順（rowIdAt/rowAxis）から消える」検証へ修正（データは tombstone 下で残る仕様を明記） |
| 2 | 行削除で active 行が生存でも上の行が消えると activeCell の**index** が別行を指す（index ベース所有のため） | 高 | 行 2 を選択→行 0 を削除→activeCell.row=2 が旧行 3 を指す | 選択整合の破壊 | active 行 rowId を採取し削除後の新 index へ再シート（`reduceActiveCellAfterDelete` の `'unchanged'` 分岐）。一般の選択レンジ再ベースは DD-021-3 へ明示引き継ぎ |
| 3 | ショートカット Ctrl+'-'/Ctrl+Shift+'+' はブラウザのズーム（Ctrl+-/Ctrl++）と競合 | 中 | Navigation で Ctrl+'-' | OS/ブラウザ競合（DA調査項目） | `interceptKeydown` が消費時 true→`preventDefault` するためズームは抑止される（Navigation 位相のみ・編集/変換中は委譲）。E2E AC3 で挙動確認 |
| 4 | collab で submitLocalOperation の楽観適用は view 構造 dirty を自動で立てない（server echo まで再描画されない） | 中 | collab で公開 API 挿入直後の描画遅延 | 応答性・楽観適用の欠落 | submit 直後に明示 `view.noteOperation(op)` で構造 dirty を立て即時楽観再描画（standalone は冪等）。AC7 で伝播確認 |
| 5 | row-structure-change 取りこぼし時の利用側復元手段（DA調査項目） | 低 | — | 将来互換・データ喪失 | payload に afterRowId＋rowIds（表示順）を含め、利用側は `setData` 全差し替えで常に復元可能（AC6 で実演）。イベント粒度は insert/delete の 2 kind に限定し、将来 MoveRows/SortRows 追加時も kind 追加で後方互換（union 拡張）にできる設計を確認 |
| 6 | count が非整数/NaN/Infinity で無限ループ・巨大挿入の恐れ | 中 | insertRows({afterRowId:null,count:1.5}) | 入力堅牢性 | `Number.isInteger(count) && count>0` で実行前拒否（`row-count-invalid`）。unit＋E2E AC8 で固定 |

## ログ（実装セッション補足）

### 2026-07-17（実装完了）
- **変更ファイル**: `packages/grid/src/index.ts`（公開 API・GridEvent・GridRowStructureChange 追加）／`error-codes.ts`（3 コード追加）／`row-operations.ts`（新設・純関数）／`row-operations.test.ts`（新設）／`mount-controller.ts`（配線・keydown・activeCell 縮退）／`apps/playground/e2e/row-operations.spec.ts`（新設）／`tests/invariants/ime/row-structure.invariant.test.ts`（新設）／`CHANGELOG.md`／`doc/archived/DD/DD-017/error-codes.md`／contract snapshot（`facade-surface.test.ts.snap`）。
- **grid-backend.ts / standalone-session.ts は変更なし**: 行 Op の適用は既存 `submitLocalOperation`（両モード）で成立し、row-structure-change の emit は mount-controller に単一集約したため、これらファイルの拡張は不要だった（📐 の emit 集約方針）。DD タスクは方針変更として達成（サイレント喪失防止契約は index.ts の event 型＋mount-controller の emit で担保）。
- **検証結果**: `npm run test` 967 pass（新規 unit 15＋invariant 3）／`npm run typecheck` 全 green／`npm run lint` eslint green・boundary new=0／`npx playwright test row-operations` 8 pass（AC1〜8）。API 型 snapshot 差分あり（GridEvent 追加・GridRowStructureChange・insertRows/deleteRows・conflict codes 3 件）→ `-u` で更新済み（公開 value surface は不変＝型のみ追加）。
- **Codex レビュー**: `--check` exit 1（利用不可）→ スキップ。**実装は完了だが Codex レビューは次セッションで実施要**（Risk Class A・公開 API 新設・effort high）。
- **要判断/停止事項**: なし（IME 状態機械の遷移追加・protocol 変更いずれも不要＝xhigh 昇格条項に非該当）。

### 2026-07-17（外部レビュー: Fable 5 で Codex high を代替・ユーザー決定）
- Codex CLI が本環境で利用不可のため、**ユーザー決定（2026-07-17）で Fable 5 レビューを Codex high の代替**とした。独立レビューア（Fable 5 サブエージェント・実バグ優先・周辺コード読解込み）が本コミット差分（21e313f）をレビューし、オーケストレータが全 findings を裏取りのうえ反映。ヘッダの「Codex レビューは次セッションで実施要」はこれをもって充足と読み替える。
- findings と採否:
  - **[P2 反映] stopped セッションで insertRows/deleteRows が同期 throw**（「同期 throw しない」公開契約違反・keydown 経路は未捕捉例外）→ `performInsertRows`/`performDeleteRows` 冒頭に `isStopped` ガード（no-op＋診断・performUndo/Redo と同型）。
  - **[P2 反映] count 上限なし**（count=2^32 で同期 RangeError・1e8 で UI フリーズ/巨大 envelope）→ 上限 `SETCELLS_MAX_CELLS`（100,000）で実行前拒否（`row-count-invalid` の意味を「1〜100,000 の整数」に拡張・公開 doc 更新）。E2E AC8 に非整数・上限超過ケース追加。
  - **[P3 反映] 公開 doc の「boot 未完了時は setData と同型」が事実と不整合**（setData は保留適用・行操作はサイレント無視）→ doc を実態（黙って無視・保留しない・stopped は診断のみ）へ修正。
  - **[P3 記録] 非 secure context で `crypto.randomUUID` 未定義 → standalone でも同期 TypeError**: 既知境界として記録（collab は従来から clientId 採番で同依存・http 配信は Tier 1 想定外。要件化時に fallback 採番を検討）。
  - **[P3 記録] activeCell.row が軸範囲外のとき Ctrl+Shift+'+' が先頭挿入に化ける**: K3 再ベース（DD-021-3）後は実到達性が低い（構造 flush 毎に生存行へ引き直される）ため記録のみ。
- 問題なし確認（レビューアの裏取り済み）: I-3（全5位相×composing 掃引で固定）・emit 集約と reject 経路（DD-020 規約整合）・R7（公開面は素の string のみ）・純関数 3 種・E2E の view 軸 poll ゲート。

### 2026-07-17（オーケストレータ独立検証・E2E flake 是正）
- dd-auto オーケストレータが完了報告を鵜呑みにせず独立検証（`npm run test` 967 pass／typecheck／lint boundary new=0 を再現確認）した際、**`row-operations` フルスイートで AC6 standalone が間欠失敗**（分離実行では 3/3 pass・実装報告の「8 pass」は warm 状態での結果）。
- **根因**: `rowIdAt` は view の `currentRowAxis`（`document-view.ts` の flush 時に `displayRowOrder` から再構築）を読む。AC6 の line 200 は**同期発火の row-structure-change イベント数**を poll していたため、軸再構築（rAF flush）前に line 204 `rowIdAt(0)` を即読みして旧先頭 `r0` を掴む race だった。AC1/2/3 は直前に `rowCount()`（＝同一 `currentRowAxis.count()`）を poll するため軸再構築を待てており安定。**プロダクト正当性の問題ではない**（モデル適用・イベントの rowIds は同期で正・consumer 契約はイベントの rowIds を使う）。
- **是正**: `apps/playground/e2e/row-operations.spec.ts` の該当 `rowIdAt(0)` 検証を `expect.poll` 化（view 軸 settle を待つ・他の view 読みは既に rowCount poll でゲート済み）。フルスイートを 2 回連続実行し **8/8 pass を確認**（flake 解消）。
