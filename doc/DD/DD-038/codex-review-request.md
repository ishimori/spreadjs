# DD-038 レビュー依頼: 貼り付け後の選択レンジ

## 対象差分

コミット `b74576e`「DD-038: 貼り付け後の選択レンジ（Excel 準拠・consumer 駆動: 松下 生産納期 P1）実装完了」の全差分。

| ファイル | 変更 |
|---|---|
| `packages/grid/src/clipboard-controller.ts` | `PasteRect` 型を新設し、`buildPaste` の `submit` 結果に貼付矩形 `rect` を追加（純関数のまま） |
| `packages/grid/src/mount-controller.ts` | `selectPastedRect` を新設し、`performPaste` の `case 'submit'` の書き込み成功後に 1 回呼ぶ |
| `packages/grid/src/clipboard-controller.test.ts` | rect の unit（R-1〜R-6）を追加 |
| `apps/playground/e2e/clipboard.spec.ts` | E2E CL-8〜CL-13 を追加（既存 CL-1〜CL-7 は無修正） |
| `apps/playground/e2e/paste-selection.spec.ts` | 新設。単独ハーネス（4 列 × 15 行）で端・readOnly の境界を検証（PS-1〜PS-5） |
| `CHANGELOG.md` / `apps/showcase/src/features.json` | 挙動変更の記録・機能カタログ更新 |

## この変更が実現すること

貼り付けが成立した直後に、**貼付範囲を選択レンジにし、アクティブセルを矩形の左上へ移す**（Excel 準拠）。
consumer（松下 生産納期）のユーザー指摘「範囲選択してコピーし、起点セルで貼り付けても、どこに貼られたのか分からない」の解消。

公開 API の追加・変更はない（`tests/contract` の `.d.ts` snapshot 差分ゼロ。`clipboard-controller.ts` は
`packages/grid/src/index.ts` から再輸出されておらず `PasteOutcome` / `PasteRect` は grid の内部型）。

## 設計上の前提（レビュー時に踏まえてほしい既存契約）

1. **selection-controller の不変条件**（`packages/grid/src/selection-controller.ts` 冒頭コメント）:
   明示レンジは「anchor === activeCell（値一致）かつ phase === 'Navigation'」の間だけ存在する。
   editor の `onChange` が毎回 `syncWithEditor` を呼び、破れていればレンジを解除する（DD-020-1 AC4）。
2. **貼付アンカーは矩形の左上**（`range.rowStart` / `colStart`）であり、**activeCell と一致するとは限らない**。
   右下から左上へドラッグして範囲選択した場合、選択 anchor = activeCell = 右下・矩形の左上は別セルになる。
   ゆえに activeCell を左上へ移さずに `extendTo` すると不変条件が破れ、次の editor イベントで選択が消える。
   これが `selectPastedRect` で `pointerdownCell` → `extendTo` の順に呼んでいる理由。
3. **`performPaste` は前段消費**のため、貼り付け直後に editor の `onChange` は走らない
   （既存コードのコメントに記載）。楽観適用の再描画は `markCellDirty` で明示要求している。
4. **readOnly のスキップは `filterReadOnlyCells`（呼び出し側・後段）** が行い、`buildPaste` は関知しない。
   `rect` は「どこへ貼ろうとしたか」であり、スキップされた行・列も jagged で欠けたセルも矩形に含む（仕様）。
5. `out-of-bounds` は `buildPaste` が矩形全体を事前拒否するため、`submit` に到達した矩形は常に表示 Axis 内。

## 評価してほしい観点（優先順）

1. **正当性・破綻**: `selectPastedRect` の呼び出し位置と順序に穴はないか。
   - 書き込みが成立しなかった経路（`too-large` / `out-of-bounds` / `noop` / `filterReadOnlyCells` が `null`）で
     選択・activeCell が動かないことがコード上保証されているか
   - `editor.pointerdownCell` を paste 経路から呼ぶことによる副作用の見落とし
     （フォーカス・編集状態機械・IME・ポップアップ・スクロール・presence 送出など）
   - `submitSetCells` と `selectPastedRect` と `markCellDirty` の**順序**は妥当か。再入・非同期の割り込みで壊れないか
   - 矩形の右下算出（`anchor + target - 1`）の off-by-one、および `extendTo` の半開区間との整合
2. **既存契約の非破壊**: cut / copy / 範囲クリア / Undo・Redo / リモート適用 / 再ベース（DD-021-3）への影響。
   IME 不変（I-3）に触れていないか
3. **コーディング規約への適合**: `doc/templates/coding-standards.md` を基準に評価してほしい。
   命名・責務境界（純関数である `clipboard-controller` に状態や DOM を持ち込んでいないか）・
   コメントが「なぜ」を書けているか・既存コードの書き方との一貫性
4. **テストの十分性と書き方**: 追加した unit / E2E が、この変更で壊れうる箇所を実際に押さえているか。
   特に「(b) activeCell を動かさない実装だったら落ちるか」が担保されているか。
   逆に、過剰・重複・脆いテスト（タイミング依存・ハーネス依存）があれば指摘してほしい
5. **見落としている境界**: 列の挿入・削除、行 0 件、貼付矩形が巨大、編集中/変換中、readOnly グリッド全体、
   単一セル選択と明示レンジの往復など

## 対象外（指摘不要）

- **仕様の是非**: 「貼り付け後に選択を動かすべきか」「アクティブセルを左上へ移すべきか」「readOnly スキップ分も
  矩形に含めるべきか」「全件スキップ時に動かさないのが正しいか」は **Human Spec Gate でユーザーが確定済み**
  （`doc/DD/DD-038_貼り付け後の選択レンジ.md` の「決定事項」）。仕様論ではなく**実装の書き方**を見てほしい
- **スコープ外と明記した機能**: 貼り付け確定の通知イベント（consumer 側が不要と確定）、`GridConflict` への
  拒否詳細の追加、コピー元のマーチングアンツ演出
- **DD 運用・ドキュメント体裁**: DD テンプレート、ステータス語彙、アーカイブ、CHANGELOG の書式そのもの
- **既存 DD の決定の蒸し返し**: DD-020-1（選択の不変条件・Delete でレンジ維持）、DD-020-2（jagged 欠けセルを
  書かない＝決定(d)・全体拒否）、DD-035 R4 / DD-036 C3（readOnly のスキップ方式）は確定事項として扱う
- **既存の未修正箇所**: 本差分が触っていない箇所の一般的な改善提案（本差分が新たに悪化させた場合を除く）

## 出力形式

指摘ごとに **重大度（P1: 直すべき欠陥 / P2: 直した方がよい / P3: 好みの範囲）** を付け、
**根拠となるファイル・行**と**具体的な修正案**を添えてほしい。指摘が無い観点は「問題なし」と明示してほしい。
