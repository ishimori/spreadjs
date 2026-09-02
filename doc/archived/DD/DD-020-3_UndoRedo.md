# DD-020-3: Undo/Redo

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-07-16 | 2026-09-03 | 完了 | 親=DD-020（3分割の第3子）。全AC充足・Codex high 5件反映。ADR-0024 起票。実機統合は親 Phase 4（2026-09-03 アーカイブ。親 DD-020 も同日クローズ＝Manual Gate 未実施のままユーザー判断） |

```text
Risk Class: A
Risk Triggers: 補償 SetCells が他者更新を上書きする可能性（計画書 R-07。条件付き拒否=OCC で防止するが、逆値・revision 捕捉の誤りは「黙って過去値へ戻す」サイレント上書きになる）／新規状態所有者（undo/redo スタック）の追加／OCC・rejected 経路への依存拡大／利用者の直前入力を失う可能性（誤 Undo）
Human Spec Gate: 解決済（親 DD-020 要確認③⑥確定=2026-07-16 フル委譲モード。テストシナリオ合意はオーケストレータ確認で代替）
Codex: high（必須・TDD 対象ゆえ原則必須。protocol 変更なし=親③〔補償 SetCells 方式〕・永続化/状態機械の実質変更なし=xhigh 非該当。protocol 変更が生じたら停止して xhigh へ昇格=親ヘッダ条項）
Manual Gate: なし（本子DDは synthetic E2E まで。実機は親 Phase 4 に集約）
External Review: なし（クライアント主導 Undo の方式判断は ADR ドラフトとして記録し Codex high で代替=Phase 2 タスク）
Evidence Level: full（A区分=L5。Undo 条件マトリクス・再現コマンド・既知の未保証境界を省略しない）
```

> アプローチ: TDD（Undo 条件ロジック=正解が明確）＋E2E（キーバインド・standalone 契約）
> 親=**DD-020**。依存: **DD-020-1／DD-020-2 完了**（確定単位 chokepoint・`range-ops`・公開語彙を利用）。完了後は親 Phase 4（統合検証・Manual Gate）へ。

## 目的

確定単位（1 利用者操作=1 SetCells）の Undo/Redo を、**クライアント主導・補償 SetCells**（親③・protocol 変更なし）で提供する。対象=セル確定・貼り付け・cut/範囲クリア。既存 OCC（stale-cell-revision）が「対象セルがその後変更されていない」条件（計画書 §15.4）を検証し、条件不成立は拒否通知（強制 Undo なし=R-07 対策）。

## 背景・課題（親 DD-020 §背景の該当分）

- Undo/Redo は全パッケージ未実装（grep 0件）。`core/apply.ts` の `InverseSeed` は `collab/session.ts` が `emptyInverseSeed()` で破棄しており、逆操作材料の保持機構が無い。
- 計画書 §15.2 はサーバー主導 undoRequest プロトコルだが、**親③でクライアント主導・補償 SetCells 方式に確定**（単独グリッドモード〔サーバー無し・Stage 2 主 consumer〕で同一機構が動く・protocol/server/永続化 変更ゼロ。undoRequest は将来課題へ境界化）。
- 補償 SetCells は `GridBackendSession.submitLocalOperation`（単独/共同の共通契約・DD-024）へ流すだけで両モードが同一経路になる。reject 通知（rejected イベント・Conflict Queue）も既存資産。

## 検討内容

- **スタック所有**: `packages/grid/src/undo-stack.ts` 新設（純ロジック=エントリ管理・補償生成。DOM/backend 非依存で unit 可能）＋grid 層で配線。
- **逆値の捕捉点**: DD-020-2 が整備する**確定単位 chokepoint**（単一 commit・paste・cut/クリアが通る共通 submit 記録点）で、submit 直前に committed から前値＋`lastChangedRevision` を読む（`captureEditStartRevision` 規約）。`InverseSeed`（apply 戻り値）を使う案は、collab（楽観適用）と standalone（即適用）で経路が異なるため不採用＝**submit 前の committed 読み取りへ統一**（両モード同一・単純）。
- **undo-able 化のタイミング（親⑥: pending 中は ACK まで Undo 不可）**: エントリは submit 時に記録し、**ACK 受領（standalone は即時）で undo-able 化**。ACK 時に対象セルの `lastChangedRevision`（=元操作が付与した revision）を確定記録し、補償 SetCells の beforeRevision に使う。reject された元操作のエントリはスタックへ残さない（破棄）。
- **Undo 実行**: 補償 SetCells（前値・beforeRevision=元操作確定時 revision）を submit。他者がその後同セルを変更していれば stale-cell-revision で**全体 reject**（原子・部分 Undo なし=計画書 §15.4）→ 通知。
- **Undo 拒否時のエントリ処理（既定案 (a)）**: スタックから**除去＋通知**（同一条件の再試行は同結果。将来「他者が値を戻したら再試行可」が要件化したら保持へ変更）。
- **Redo（計画書 §15.5）**: Undo 成功時に redo スタックへ積む（元値の再適用・同じ条件検査=beforeRevision は補償操作の確定 revision）。**新規通常操作で redo スタック破棄**。対象セルがさらに変更されていれば拒否。
- **キーバインド（既定案 (b)）**: Ctrl+Z=Undo／Ctrl+Y・Ctrl+Shift+Z=Redo。**Navigation 位相のみ**グリッド Undo として裁定。Editing/Composing 中の Ctrl+Z は**ブラウザ既定**（textarea 内テキストの undo）へ任せ、グリッド Undo を発火しない（I-3 維持・状態機械へ遷移追加なし）。
- **通知語彙**: Undo/Redo 拒否は既存 rejected（GridConflict）経路に **undo-blocked 系の公開コード**を追加（`GRID_CONFLICT_CODES`・R7 写像維持。命名は Phase 0 📐 で確定）。
- **対象外**: 行操作の Undo（DD-021 以降=計画書 §15.3 MVP後）・他クライアント操作の Undo・強制 Undo・reload を跨ぐ永続 Undo 履歴。

## 決定事項（親 要確認①〜⑥の確定〔2026-07-16〕の継承＋本子DD分）

- **親③**: クライアント主導・補償 SetCells・**protocol 変更なし**。方式判断は **ADR ドラフトとして実装時に記録**（Phase 2 タスク・オーケストレータ指示）。
- **親⑥**: 深さ **100**（超過は古い順に破棄）・**自分の操作のみ**・**セッション内**（reload で消える）・**pending 中は ACK まで Undo 不可**・対象=セル確定/貼り付け/範囲クリア（cut 含む）。
- 本子DD: 逆値は chokepoint の submit 前 committed 読み取りで捕捉・Undo 拒否エントリは除去＋通知（既定案 (a)）・Editing/Composing 中の Ctrl+Z はブラウザ既定（既定案 (b)）。（(a)(b) は親へ報告済み・オーケストレータ確定対象）

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | セル確定 → Ctrl+Z → 前値へ戻る（補償 SetCells 1 op・型も復元） | Phase 1 unit＋Phase 2 E2E |
| 2 | 貼り付け／cut／範囲クリア → Ctrl+Z → 範囲全体が前値へ（原子・全成功/全失敗） | Phase 1 unit＋Phase 2 E2E |
| 3 | 他者が対象範囲内セルを後続変更 → Ctrl+Z → 全体拒否・undo-blocked 通知・文書無変更（強制 Undo なし） | Phase 1 unit＋2クライアントテスト |
| 4 | Undo 成功 → Ctrl+Y → 元値再適用。新規通常操作後は Redo 不可（スタック破棄） | Phase 1 unit＋Phase 2 E2E |
| 5 | pending 中（ACK 前）の操作は Undo 対象外・ACK 後に Undo 可能。reject された操作はスタックに入らない | Phase 1 unit（collab） |
| 6 | 深さ 100 超は古い順に破棄。reload で履歴が消える（=永続化しない） | Phase 1 unit |
| 7 | standalone モードで undo/redo → cell-commit（batch）通知が発火し利用側保存契約（DD-024）と整合 | Phase 2 standalone E2E |
| 8 | Editing/Composing 中の Ctrl+Z はグリッド Undo を発火しない（textarea 既定・composition 非破壊） | Phase 2 synthetic＋不変条件 |

## タスク一覧

### Phase 0: 事前精査
- [x] 📋 **各Phaseのタスク精査・詳細化**（AC⇔検証対応・対象パス・変更内容の具体性・🔬の有無）
- [x] 🧪 **テスト設計（Red）**: Undo 条件マトリクスを `doc/archived/DD/DD-020-3/scenarios.md` へ作成（U-1〜U-12・UE-1〜UE-8・IV-1/2・AC対応表）。フル委譲モード=オーケストレータ確認で合意扱い
- [x] 📐 **実装前詳細化トリガー判定**（Phase 1/2 とも要＝設計は §検討内容＋本ログ 2026-07-17 に自己完結記録）
- [x] 🧑‍⚖️ **Codexレビュー要否判定**（必須・effort high・最終 Phase 1 回。実施＝findings 5件反映）
- [x] 😈 **Devil's Advocate調査**（下記ログ 2026-07-17・DA表 Phase 0/1/2）

### Phase 1: undo-stack ロジック（TDD）
- [x] **Red**: scenarios から `packages/grid/src/undo-stack.test.ts` 作成（U-3 で filter 未実装 fail→修正で Green＝テストが実挙動を検証）
- [x] **Green**: `packages/grid/src/undo-stack.ts` 新設（エントリ記録・ownedRevision で ACK 追跡・補償 SetCells 生成・redo・深さ100・新規操作で redo 破棄・拒否時除去・`decideUndoRedoKey`）
- [x] **Refactor**: 2クライアント競合＝AC3 は unit U-8（validateOperation で stale 実証）＋collab E2E UE-5／AC5 は unit U-6/U-7
- [x] 🔬 **機械検証**: `npm run test` → 全 green（undo-stack unit 20 件含む・947 tests）
- [x] 😈 **DA批判レビュー（基準: da-method.md §3.4）**（下記 DA 表）

### Phase 2: 配線・E2E・ADR＋Codex
- [x] chokepoint hook 配線: `mount-controller.ts` の `submitSetCells`（単一記録点）で submit 直前に **view** から逆値捕捉→`recordUndoEntry`。全確定経路（IME commit/範囲クリア/paste/cut）が通過
- [x] キーバインド裁定: `decideUndoRedoKey`（Ctrl/Cmd+Z=Undo・Ctrl+Y/Ctrl+Shift+Z=Redo）を Navigation 位相のみ・`mount-controller.ts` interceptKeydown 前段。Editing/Composing はブラウザ既定（`integration-editor.ts` に ctrl/meta/alt 追加）
- [x] `packages/grid/src/error-codes.ts` へ `undo-blocked`/`redo-blocked` 追加＋`doc/archived/DD/DD-017/error-codes.md` へ登録（DD-017 はアーカイブ済み）＋CHANGELOG＋contract snapshot 更新
- [x] ADR ドラフト起票: `doc/adr/0024-client-driven-undo-compensating-setcells.md`（DOC-MAP 同期）
- [x] `apps/playground/e2e/undo-redo.spec.ts`（standalone UE-1〜4/7）＋`undo-redo-collab.spec.ts`（collab UE-5/6/8）新設
- [x] `tests/invariants/ime/undo.invariant.test.ts` へ「composition 中 Ctrl+Z 非干渉」追加
- [x] 🔬 **機械検証**: playground E2E 49／showcase 3／invariants 49／typecheck／lint（boundary new=0）→ 全 green
- [x] 😈 **DA批判レビュー（基準: da-method.md §3.4）**（下記 DA 表）
- [x] Codexレビュー自動実行（本子DD全差分・effort high。`doc/archived/DD/DD-020-3/codex-review-request.md`→`codex-review-result.md`。findings 5件）
- [x] Codexレビュー指摘への対応（5件全反映・下記ログ 2026-07-17 Codex 節）

## 引き継ぎ物（→ 親 DD-020 Phase 4）

- 全対象操作（commit/paste/cut/clear）の Undo/Redo 成立＝親の既知制約「範囲クリア・貼り付けの Undo なし」を解消。
- 公開語彙 `undo-blocked`/`redo-blocked` 確立（error-codes.md・CHANGELOG・contract snapshot 更新済み）。ADR-0024 起票（方式・protocol 無変更の根拠）。
- 親 Phase 4 の統合検証（性能計測・**features.json の clipboard/undo エントリ available 化**・Manual Gate M1〜M3 受付）へ移行可能な状態。features.json は本子DDでは触っていない（親 Phase 4 で一括・指示どおり）。

## 既知の未保証境界（L5・本子DD時点）

- **自分の操作のみ・セッション内**（reload で履歴消滅・計画書 §15.1 MVP）。他クライアント操作の Undo・強制 Undo・永続 Undo 履歴は対象外（ADR-0024）。
- **再接続中に accepted された自分の op**（own echo を伴わず reconcile 経由で pending 除去）は ownedRevision を確定できず、その op の Undo は保守的に OCC 拒否されうる（サイレント上書きより安全側＝データ喪失なし）。
- **メモリ**: 逆値は保持エントリ分（深さ 100）の CellScalar を保持。巨大 paste（最大 100,000 セル）を多数履歴に残すとメモリが総セル数に比例して増える。ownedRevision マップはセッション内 distinct 編集セル数に比例（int 1 個/セル・軽微）。
- **同一セルの重複 pending 編集**: 同一セルを 2 回編集して 1 つ目が未確定のまま 2 つ目を submit すると、2 つ目は committed 由来 beforeRevision（IME startRevision）で先行確定に負けて全体 reject されうる（DD-020-2 既知境界と同旨＝own pending 先行確定）。この場合 2 つ目のエントリは reject で除去される。
- **in-flight 補償中の並行編集（collab の稀 race）**: 補償 ACK 往復（〜数十 ms）中に新規編集を差し込むと、undo 方向補償は redo 復活抑止（suppressRedoResurrect）で保護するが、redo 方向補償の undo 復帰順序が厳密でない場合がある（非破壊）。standalone（同期）は無影響。

## ログ

### 2026-07-16
- DD作成（親 DD-020 の Phase 3 を自己完結の子DDとして切り出し。親 要確認①〜⑥はオーケストレータ確定済み=フル委譲モード。③=クライアント主導・補償 SetCells・ADR 記録は実装時〔Phase 2 タスク化済み〕）。
- 逆値捕捉の設計: InverseSeed 再利用ではなく chokepoint での submit 前 committed 読み取りへ統一（両モード同一経路・楽観適用との整合は OCC が安全側に倒す）。
- 本子DD追加の既定案: (a) Undo 拒否エントリ=除去＋通知／(b) Editing/Composing 中 Ctrl+Z=ブラウザ既定（親へ報告済み・オーケストレータ確定対象）。

### 2026-07-17（実装セッション）

- **Phase 0**（ステータス→進行中）: 🧪 scenarios.md 作成（Undo 条件マトリクス U-1〜12・E2E UE-1〜8・不変 IV-1/2）。フル委譲=オーケストレータ確認で合意扱い。
- **設計自己完結記録（📐）**:
  - **逆値捕捉**: 確定単位 chokepoint `submitSetCells` で submit 直前に **view（committed＋own pending）** から前値を読む（InverseSeed 不採用＝両モード同一経路）。`recordUndoEntry` が standalone=即時確定 revision／collab=opId 後追い ACK で記録。
  - **beforeRevision の正しさ（R-07 の要）**: 補償 op の beforeRevision は「元操作確定時 revision の凍結」ではなく **ownedRevision マップ（自分の最後の確定 op がそのセルへ付与した revision）**。ownedRevision は**自分の op の正確な ACK revision**で更新（collab=own echo が運ぶ `envelope.revision`＝`session-sync` の own-echo 検出。committed 事後読取を使わないのは同一 echo batch の他者 op を owned と誤認しないため）。→ 連続同一セル編集の自傷 reject を回避しつつ他者変更は OCC で弾く。
  - **pending/直列化**: `pendingCount===0` を Undo/Redo の必要条件（「pending op は undo 対象外」＋「in-flight 補償の直列化」を同時に満たす）。
  - **拒否経路**: 補償 reject＝スタック除去＋`undo-blocked`/`redo-blocked`（既定案 a）。元 op reject＝スタック除去（AC5）。
- **Phase 1（TDD）**: `undo-stack.ts`（純ロジック）＋`undo-stack.test.ts`（20 件）Green。ADR-0024 起票。
- **Phase 2（配線・E2E）**: `mount-controller.ts`（chokepoint 逆値捕捉・submitCompensation・performUndo/Redo・keydown 配線・observer の rejected→undo-blocked 写像・standalone 即時確定・debug API）／`session-sync.ts`（own echo 検出 `onOwnSetCellsCommitted`）／`integration-editor.ts`（KeydownInterceptInput 修飾キー）／`error-codes.ts`。E2E: standalone 5・collab 3・invariant 3。全 green（unit 947・playground E2E 49・showcase 3・invariants 49）。
- **付随修正（DD-020-2 アーカイブの取り残し）**: `packages/core/src/clipboard-text.test.ts` の fixture 参照を `doc/DD/DD-020-2/` → `doc/archived/DD/DD-020-2/`（6fdf753 の移設で dangling→main が既に red だったため是正）。
- **Codexレビュー（effort high・uncommitted 全差分）: findings 5件 → 全反映**（詳細は下記 Codex 節）。
- **要判断/停止事由**: なし（protocol 無変更で完遂＝③前提を満たす）。実機統合・features.json available 化・Manual Gate は親 DD-020 Phase 4 へ引き継ぎ。

---

## Codexレビュー記録（effort high・本子DD全差分〔uncommitted〕）

依頼書/結果=`doc/archived/DD/DD-020-3/codex-review-request.md`・`codex-review-result.md`。findings 5件を到達性×実害で仕分け＝**全て妥当・全反映**（false-positive/到達不能なし）。

| # | 指摘 | 判定 | 対応 |
|---|------|------|------|
| P1a | queued edits の逆値: 直前の own pending 楽観編集を committed が含まず、undo が 1 編集を飛ばしうる | **妥当＝反映** | 逆値捕捉を committed→**view（committed＋own pending）**へ（`GridBackendSession.viewDocument` 追加）。※同一セルの重複 pending 編集は現行 OCC が 2 つ目を reject する（DD-020-2 既知境界）ため飛ばしの主経路は境界化されるが、逆値は「利用者が見た値=view」が正＝防御的に正す |
| P1b | 補償 opId 紐づけ前に `submitLocalOperation` が同期 reject → observer が limbo を拾えず永久 busy＋誤コード | **妥当＝反映** | `submitCompensation` に**実行前 OCC 検査**（`validateOperation(committed, op)`。undo は pendingCount===0 でのみ発火＝committed が唯一の検証基底ゆえ同期 reject を正確に予測）。違反なら submit せず `blockInFlightCompensation()`→undo-blocked。E2E UE-8 で busy 未残留を実証 |
| P1c | standalone `setData` 差し替え後、旧文書の逆値を新文書へ適用しサイレント上書き/削除 ID で throw | **妥当＝反映** | `applyStandaloneData` で `undoCtrl.clear()`（履歴・ownedRevision・in-flight 全消去）。E2E UE-7 で実証 |
| P2a | user op が submit 中に同期 reject されると未記録のまま `onRejected` が空振り→直後に既 reject op を記録＋redo 誤破棄（AC5 違反） | **妥当＝反映** | `recordUndoEntry`（collab）は submit 後に opId が `pendingOperationIds()` に残った op のみ記録（同期 reject 済みは記録せず redo も破棄しない） |
| P2b | `cellKey` の区切りにリテラル U+0000 が混入しファイルが binary 判定→差分が隠れる | **妥当＝反映** | 区切りをソース上は escape `\0`（実行時は同一の NUL 区切り）へ。file は text 判定に復帰 |

---

## DA批判レビュー記録

### Phase 0/1 DA批判レビュー（undo-stack ロジック）

**DA観点:** 補償の beforeRevision がサイレント上書き（R-07）を許す revision ずれは無いか。連続編集・連打・pending 中で状態機械が壊れないか。

| # | 発見した問題/改善点 | 重要度 | 再現手順（高/中は必須） | DA観点 | 対応 |
|---|-------------------|--------|----------------------|--------|------|
| 1 | 「元操作確定時 revision の凍結」だと同一セル 2 回編集→2 回 Undo で自分の補償が revision を bump し 2 回目が自傷 reject | 中 | A を編集→編集→Undo→Undo（2 回目 reject） | 暗黙の前提（凍結） | ✅修正済（ownedRevision を自分の補償 ACK で追従＝U-9。他者変更は依然 OCC で弾く） |
| 2 | committed 事後読取で ownedRevision を取ると、同一 echo batch の他者 op の revision を owned と誤認しサイレント上書き | 高 | 追いつき中に own op@R と他者@R+1 が同一 batch | 並行処理・R-07 | ✅回避（own echo が運ぶ `envelope.revision` を使う＝session-sync の clientId 一致検出。committed 事後読取をしない） |
| 3 | noop 補償（before===after のみ）が collab で echo されず in-flight が永久 busy | 中 | 変化なしセルのみの op | エッジケース | ✅対応（recordUserOp で before===after を filter・空なら記録しない＝U-3） |

### Phase 2 DA批判レビュー（配線・E2E）

**DA観点:** 同期 reject・文書差し替え・IME 位相分岐で undo が壊れる/データを失う経路は無いか。

| # | 発見した問題/改善点 | 重要度 | 再現手順（高/中は必須） | DA観点 | 対応 |
|---|-------------------|--------|----------------------|--------|------|
| 1 | 補償の同期 reject で limbo 永久 busy（Undo/Redo が以後不能） | 高 | 他者変更受信済みで Ctrl+Z | 依存関係（ClientSession 同期発火） | ✅修正済（実行前 OCC 検査で submit 前に block・Codex P1b・UE-8） |
| 2 | standalone setData 後の Undo が新文書をサイレント上書き/throw | 高 | 確定→setData→Ctrl+Z | データ整合性 | ✅修正済（setData で clear・Codex P1c・UE-7） |
| 3 | Composing 中の Ctrl+Z が draft を巻き戻す（IME 破壊） | 高 | 変換中に Ctrl+Z | 依存関係（CG-1） | ✅確認済（decideUndoRedoKey が Navigation×非 composing のみ・UE-4＋invariant 掃引で固定） |
