# DD-041: Presence の activeCell 枠・名前タグの pane clip 漏れ

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-03 | 2026-09-03 | 検討中 | 不具合修正。他ユーザーの activeCell 枠と名前タグが pane ごとに clip されておらず、固定ペインの上へはみ出しうる。DD-039（ヘッダー帯の clip 漏れ）の実読中に発見した**同根・別箇所**。論点①（名前タグを pane 内で切るか）だけユーザー確認が要る |

> アプローチ: バグ修正・ライトパス（原因は実読で特定済み・変更は 1 関数内・unit で完結。guides.md §1）
> リスク: なし（描画層のみ。認可・DBスキーマ・外部I/F・機密情報に触れない）

```text
Risk Class: B（描画層のみ。公開 API・Command/Event・protocol・永続化に触れない）
Risk Triggers: なし（overlay-layer の clip 矩形の差し替えだけ。IME・editor・sequencer・snapshot は無改変）
Human Spec Gate: required（論点① = 名前タグの見え方はユーザー判断。それ以外は自明）
Codex: medium（実装完了後にユーザー指示で CLI 実行）
Manual Gate: あり・クローズ非ブロック（M1=2 タブで固定列ありの Presence 表示）。未実施なら「既知の未保証境界」へ移送
External Review: なし
Evidence Level: standard
```

## 概要

| Bug# | 概要 | 重要度 |
|------|------|--------|
| 041 | 他ユーザーの **activeCell 枠＋名前タグ**が pane 境界を無視して描かれ、固定ペイン（固定列・固定行）の上へ重なる | LOW（表示のみ・共同編集時のみ・値/編集/計算に影響なし） |

- Presence の**選択範囲ハイライトは正しい**（`rangePiecesAcrossPanes` で pane ごとに clip 済み）。壊れているのは枠とタグだけ
- 発生条件は「固定行列を使う」×「他ユーザーが固定帯の裏へ回った位置を選択中」。`frozenColumnCount` を consumer が実際に使い始めた（DD-036）ため、**到達可能性が上がった**
- 症状は未観測（実機報告ではなく実読による発見）。再現手順は Phase 0 で確定する

## 原因分析

`packages/render/src/overlay-layer.ts` の `drawPresence` は、選択範囲だけ `rangePiecesAcrossPanes()`（pane ごとの clip）で描き、
**activeCell 枠と名前タグは `contentClip`（ヘッダーを除いた全セル領域 1 枚）**で描いている。
`transform.cellRect(activeRow, activeCol)` はスクロール行列に対して `- scrollLeft / - scrollTop` された座標を返すため、
固定帯の裏へ回ったセルの矩形が固定ペインの内側に落ち、そのまま上書きされる。
名前タグは `tagY = active.y - tagHeight` とセルの上へ出るので、固定行帯の上にも乗りうる。

> DD-039（ヘッダー帯）と同じ「pane 境界を跨ぐ単一 clip」の誤り。セル本体（`drawPane`）・選択枠・ドラッグ枠は pane ごとに clip していて正しい

## 検討内容

| # | 論点 | 選択肢 | 推奨と理由 |
|---|------|--------|-----------|
| 1 | 名前タグの扱い | (a) 枠もタグも pane clip で切る（タグは pane 上端で欠ける）/ (b) 枠だけ pane clip・タグは現行の content clip のまま / (c) タグをセル内側へ寄せて pane 内に必ず収める | **(a)**。viewport 上端では現状すでに content clip でタグが欠けており、pane 境界でも同じ見え方になるだけ＝一貫する。(b) は「枠のない名前タグが固定ペインに浮く」という別の不整合を作る。(c) は見た目の変更が大きく、別 DD で扱うべき UI 改善 |
| 2 | 実装 | (a) 単一セル range を `rangePiecesAcrossPanes()` に通して piece の clip を使う（選択ハイライトと同じ経路）/ (b) activeCell の属する pane を自前で判定する | **(a)**。既存関数がそのまま使える（`CellRange` は半開区間なので `{rowStart: r, rowEnd: r+1, colStart: c, colEnd: c+1}`）。pane 判定ロジックを二重に持たない |
| 3 | 可視範囲外の Presence | (a) piece が 0 個なら何も描かない | **(a)**。現行も content clip で見えないため**見た目は不変**。無駄な描画が減る副次効果のみ |

## 修正方針

`drawPresence` の activeCell 枠・名前タグの `withClip(clip, …)` を、選択ハイライトと同じ `rangePiecesAcrossPanes()` 経由の
pane clip へ差し替える（論点①(a)・②(a)）。`contentClip` の用途がなくなるなら関数ごと削除する。

## 対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `packages/render/src/overlay-layer.ts` | `drawPresence` の枠・タグを pane ごとの clip で描く。未使用になれば `contentClip` を削除 |
| `packages/render/src/overlay-layer.dd041.test.ts`（新規） | ctx スパイで「固定側 clip の内側に、スクロール行列の Presence の枠・タグが描かれない」ことを固定 |

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | 固定列ありで、他ユーザーの activeCell が固定帯の裏へ回る位置にあるとき、**固定ペインの上に枠・名前タグが描かれない** | unit（ctx スパイ: clip 矩形と描画座標） |
| 2 | 固定行ありでも同じ（縦方向） | unit |
| 3 | 固定行列 0 のとき、描画結果が修正前と同一 | unit |
| 4 | Presence の選択範囲ハイライト・自分の選択枠・ドラッグ枠に変化がない | 既存の全回帰 |
| 5 | activeCell が可視範囲外の Presence で、描画が増えも減りもしない（見た目不変） | unit |
| 6 | 公開 .d.ts snapshot に差分なし・boundary lint new=0 | contract test ＋ lint |

## タスク一覧

### Phase 0: 再現とユーザー確認（ゲート）
- [ ] 👀 **ユーザー確認**: 論点①（名前タグを pane 境界で切ってよいか）
- [ ] playground の統合シナリオ（`apps/playground/e2e/integration-scenario.spec.ts` の Presence 経路）で、固定列ありの再現条件を確定
- [ ] 📸 修正前エビデンス: 固定ペインへはみ出した枠・タグのスクショを `DD-041/` へ

### Phase 1: 修正とテスト
- [ ] `packages/render/src/overlay-layer.ts`: `drawPresence` の枠・タグを `rangePiecesAcrossPanes()` の pane clip で描く
- [ ] 同根パターンの横展開確認（`overlay-layer.ts` 内に他の単一 clip 描画が残っていないか）
- [ ] `overlay-layer.dd041.test.ts` を追加（AC1・2・3・5）
- [ ] 🔬 機械検証: `npm test -w @nanairo-sheet/render` / `npm run typecheck` / `npm run lint` → green

### Phase 2: エビデンスと仕上げ
- [ ] 📸 修正後エビデンス（Phase 0 と同条件）を `DD-041/` へ
- [ ] `CHANGELOG.md` の Fixed へ記載
- [ ] 🔬 機械検証: Presence 経路の E2E（`apps/playground/e2e/integration-scenario.spec.ts`）→ green

### 完了前チェック
- [ ] 受け入れ基準を 1 項目ずつ照合
- [ ] 😈 セルフレビュー 1 巡
- [ ] 🔬 全回帰 1 回: `npm test` / `npm run typecheck` / `npm run lint` / `npm run test:e2e` → 全 green

## Manual Gate（クローズ非ブロック・正味）

| # | 項目 | 正味 | 結果 |
|---|------|------|------|
| M1 | 2 タブ・固定列ありで、相手の Presence 枠・名前タグが固定ペインへはみ出さないこと | 3 分 | 未実施 |

## ログ

### 2026-09-03
- 起票。**DD-039（固定ペインのヘッダー clip 漏れ）の 📐 実読中に発見した同根・別箇所**。DD-039 は AC5 で「Presence 不変」を掲げているためスコープに入れず、ユーザー指示で別 DD とした
- 実読で範囲を確定: `drawPresence` のうち**選択範囲ハイライトは pane 分割済みで正しい**。誤っているのは activeCell 枠と名前タグ（`contentClip` 1 枚）だけ
- 未観測（実機報告ではなく実読による発見）。重要度 LOW だが、DD-036 で `frozenColumnCount` が consumer に使われ始めたため到達可能性は上がっている
