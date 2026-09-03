# DD-041 コードレビュー依頼（Codex CLI・effort medium）

## 背景

Canvas 描画のスプレッドシート基盤。`overlay-layer` は選択枠・ドラッグ範囲・他ユーザーの Presence を描く。
固定行列（frozen panes）があるため、描画は 4 象限の pane（corner / top / left / body）ごとに clip する規約。

**バグ**: `drawPresence` のうち、Presence の**選択範囲ハイライトだけ**が pane ごとに clip されており、
**activeCell 枠と名前タグは「ヘッダーを除いた全セル領域」1 枚の clip（`contentClip`）**で描かれていた。
`cellRect()` はスクロール行列に対し `- scrollLeft / - scrollTop` した座標を返すため、固定帯の裏へ回った
他者のセル矩形が固定ペインの内側に落ち、固定列・固定行の上へ枠と名前タグが重なる。

**修正**: 単一セルを半開区間 range `[r, r+1) × [c, c+1)` として既存の `rangePiecesAcrossPanes()` に通し、
返ってきた piece の `rect` / `clip` で描く（選択ハイライトと同一経路）。`contentClip` は用途が消えたので削除。

**ユーザー確定事項（レビュー対象外）**: 名前タグは枠と同じ clip に入れ、pane 境界で欠けてよい。

## 変更差分

- `packages/render/src/overlay-layer.ts` — 本体修正
- `packages/render/src/overlay-layer.dd041.test.ts`（新規） — ctx スパイの unit 5 件
- `apps/playground/e2e/presence-frozen-panes.spec.ts`（新規） — overlay canvas の実ピクセルで検証する E2E
- `apps/playground/e2e/integration-helpers.ts` — 証跡パスヘルパー追加のみ
- `CHANGELOG.md` / `doc/DD/DD-041_*.md` — 記録

## 評価基準（この順で見てほしい）

1. **正しさ**: pane 分割の適用に抜け・重複はないか。特に
   - 単一セルが複数 pane にまたがることはない前提は正しいか（`panes()` の range は互いに素か）
   - overscan により body の可視 range が固定境界の外側まで広がることが、単一セルの pane 帰属判定を誤らせないか
   - `frozenRow/Col = 0` のときに描画が修正前と厳密に同一か（clip 矩形・座標とも）
2. **書き方**: 既存コード（`drawSelection` / `drawDrag`）との一貫性、命名、コメントの過不足。
   `headerWidth` / `headerHeight` を「公開 deps の形を壊さないため受け取りだけ止めた」判断の妥当性
3. **テストの質**: unit が「修正前なら落ちる」ことを実際に担保しているか。ctx スパイの前提
   （`globalAlpha` で選択ハイライトとタグ下地を判別する等）に脆さはないか。E2E のピクセル検証が
   フレーキーになりうる箇所（DPR・待ち合わせ・B 自身の選択位置の選び方）はないか
4. **見落とし**: 同じ「pane 境界を跨ぐ単一 clip」の誤りが他に残っていないか

## 対象外（指摘不要）

- 名前タグの見た目の仕様（pane 境界で欠けること・セル内側へ寄せる案）は決定済み
- `OverlayLayerDeps` から `headerWidth` / `headerHeight` を削除する API 変更（`.d.ts` snapshot 不変が AC）
- 既存の Presence 配信プロトコル・presence-adapter・presence-sim（本 DD は描画のみ）
- 日本語コメントの文体・Canvas 描画の性能最適化
