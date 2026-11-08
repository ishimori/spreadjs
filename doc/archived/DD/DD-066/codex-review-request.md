# DD-066 Phase 0 レビュー依頼（2026-11-08）

ユーザーが DD 起票時に明示した Phase 0 のレビューを、再開後の成果物に対して実施する。SDK の実装はまだ変更していない。

## 対象

- `doc/DD/DD-066_結合したセルを選んだときの二重の枠（consumer 駆動・DD-064 の取りこぼし）.md`
- `doc/DD/DD-066/cause-analysis.md`
- `doc/DD/DD-066/bug-report.md`
- 裏付け: 同フォルダの `reproduction.json` と `before-*.png`（7枚）

DD-065 は 7951231 で完了。今回の未コミット差分は DD-066 の調査・記録だけ。SDK のコード修正・テストの追加・実装・配布はレビュー対象外で、変更しないでください。

## 背景と確認してほしい点

3行×1列などの結合を選ぶと、Canvas の選択は範囲全体だが textarea の枠が1セルのまま残る。合意済みの修正方針は Navigation 中の textarea を結合全体の矩形へ置き、pane の中へ clip する方式。Phase 0 のユーザーレビュー（再現と原因の合意）を終えてから実装に入る。

1. コードと原因分析の一致。特に「focus が無いと overlay が描かれない」という起票時の説明を、「selection shadow の初期反映前」へ直した根拠が十分か
2. 80×22 の textarea と80×66 の結合範囲、固定帯の上端46と約34.667の位置、左上セルは不可視だが結合の下部は可視、固定列の横スクロールの数値がコードと一致するか
3. 採用済みの案で初期表示・クリック後・blur・可視判定・ヘッダー／固定帯へのはみ出しを扱えるか。実装前に決めるべき条件や回帰シナリオの不足
4. SDK 公開 API・IME 状態機械・文書・protocol を変えず、通常の1セルの挙動と wrap／候補欄／日付を保持する範囲になっているか

参照すべき実装は `packages/grid/src/editor-placement.ts`、`integration-editor.ts`、`ime-editing-session.ts`、`mount/editor-wiring.ts`、`mount/render.ts`、`mount/merges.ts` と `packages/render/src/overlay-layer.ts`。必要な部分だけを読んでください。alpha.19 の bd2985f と editor-placement/integration-editor/overlay-layer は同一であることを確認済み。

文書・エビデンスのみのレビューなので、テストの再実行やサーバーの起動は不要。具体的な問題だけを P1/P2/P3 と対象文書・段落・コードの根拠つきで挙げ、問題が見つからなければその旨を記録してください。結果は日本語でお願いします。
