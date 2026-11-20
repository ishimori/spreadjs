# Codexレビュー依頼: DD-070-6（見出しの印と位置）

## 背景

`c:\repo\spreadjs` は業務Webアプリへ組み込むTypeScript製スプレッドシート型入力基盤（Canvas グリッド・依存ゼロのコア＋React ラッパー）。consumer が自前で行う並べ替え・絞り込み・列のまとまりの折りたたみを見出しで見せられるよう、見出しの印と、押した場所の通知を足した。

DD 本文: `doc/DD/DD-070-6_見出しの印と位置.md`（決定事項 1〜8）。手引き: `doc/quick-start.md` の「見出しの印と位置」。仕様は確定済みで、本レビューの対象は**実装が決定事項どおり正しく作られているか**。

## レビュー対象差分

コミットの変更すべて（DD 文書と本依頼書は対象外）。

## 決定事項（要点）

1. 列の見出しの印 `{ sort?: 'asc'|'desc'; filter?: 'available'|'active' }`。mount オプション `columnHeaderMarks`・命令 `setColumnHeaderMarks`（丸ごと置き換え・`{}` で消す）。view-local・両モード・開き直さない。React は prop の変化で setter
2. 描画: 見出しの右端に、右から絞り込みのボタン（available＝枠と ▼・active＝塗りと白い ▼）、その左に並べ替えの三角。名前は印を除いた幅の中央に置き、収まらなければ省略記号
3. まとまりの印 `{ collapsed }`。`GridColumnGroup.id`（既定は caption）。`columnGroupMarks`・`setColumnGroupMarks`。上の段の名前の左に ▾／▸
4. `header-click` に `rect`（見出しのセルの viewport 矩形。2 段の見出しでまとめた列は下の段）と `target`（'filter'＝ボタンの上・'caption'）
5. 新しいイベント `column-group-click { groupId, caption, columnIds, rect }`（上の段のクリック）
6. 印の配置は render の純粋関数で決め、描画と grid の当たり判定の両方で使う
7. 不正な項目・未知の列はその項目だけ捨てて診断 warn。例外にしない
8. 見出しの描画を `render/src/header-layer.ts` へ移す（中身は従来どおり）

## 実装の要点

- `packages/render/src/header-layer.ts`（新規）: 移した見出しの描画・`columnHeaderMarkLayout`・`columnGroupMarkLayout`・印の描画。`base-layer.ts` から呼ぶ（`columnLabel` は再 export）
- `packages/grid/src/header-marks.ts`（新規）: 置き場と検査
- `packages/grid/src/mount/base-layer-options.ts`: 描画のフック（ID → 印を描画のたびに引く）
- `packages/grid/src/mount/pointer.ts`: `header-click` の `rect`・`target`、`column-group-click`
- `packages/grid/src/column-groups.ts`: `id`・`columnIds` を解決
- `packages/grid/src/index.ts`・`mount-controller.ts`・`packages/react/src/index.ts`: 公開面と配線
- テスト: render `header-layer.test.ts`・grid `header-marks.test.ts`・`column-groups.test.ts`・E2E `apps/playground/e2e/header-marks.spec.ts`

## 評価基準（この観点で見てほしい）

1. **移したリファクタの同一性（最重要）**: 印の無い見出しの描画（列記号・キャプションの fitText と位置・2 段の見出し・固定列の境界の clip・行番号・コーナー・境界線）の呼び出しの列と状態（fillStyle・font・textAlign）が移す前と同じか
2. **描画と当たり判定の一致**: 固定列・横スクロール・2 段の見出し・狭い列・DPR で、描いたボタンの位置と `target: 'filter'` になる位置が一致するか。印が名前に重ならないか
3. **置き場**: 丸ごと置き換え・不正値の扱い・未知の列の検査の時点（boot 前・共同編集の /config 前）、描き直しの要求、destroy 後
4. **イベント**: `rect` の座標系（他のイベントの rect と同じ stage 座標か）、上の段のクリックで `header-click` を出さないこと、まとめていない列の見出し（2 段ぶんの高さ）のクリック
5. **React**: prop の参照比較・開き直さないこと・未 mount 時

## 対象外

- 仕様の当否（印の形・色・大きさ）
- 既存の他の機能

## 出力形式

指摘ごとに「重要度（P1/P2/P3）・ファイルと行・何が起きるか（具体的な条件）・直し方」。指摘が無ければ「指摘なし」と書く。
