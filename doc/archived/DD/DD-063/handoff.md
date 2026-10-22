# DD-061〜063 / OFIC O2 の範囲外の対応: alpha.16 引き渡し（2026-10-22）

## 配布物

- ディレクトリ: `C:/repo/spreadjs/release/0.1.0-alpha.16/`（10 tarball＋manifest＋本書と同じ README）
- ZIP: `C:/repo/spreadjs/release/nanairo-sheet-0.1.0-alpha.16.zip`（SHA-256 は DD-063 本文のログに記録）
- package 版: `0.1.0-alpha.16`（10 package 同一版）。API 版: `0.1.0-experimental`（公開 `.d.ts` の差分は追加のみ）
- 生成元: `d9c9ab69015c336529360cd3f45c5ccddf92df0c`。manifest は `closureDirty=false`（`gitDirty=true` は DD 文書など配布外の変更による）

`build-release.sh --skip-verify` で pack した（直前に unit 1526 件・typecheck・consumer-strict・lint・build・playground E2E 279 件・showcase E2E 5 件が green）。
`verify-manifest.mjs` で 10 tarball の SHA-256・版を照合し、pack 内容は 116 files・全 entrypoint あり・tsconfig/test/spec なし。
独立 consumer-app（この配布ディレクトリの tarball だけで install）の型検査・server lifecycle・production build・E2E 10 件と、consumer-harness の pack→install→tsc が green。

## alpha.15 からの変更

alpha.15（DD-059 負の数の表示書式・DD-060 セルの状態表示）に、DD-060 で範囲外とした3つを足した。

| DD | 追加 | 使い方 |
|---|---|---|
| DD-061 | 状態表示の色 | mount オプション／React props `cellStatusColors: { error?: { frame?, background? }; warning?: {…} }`。省略は既定色 |
| DD-062 | 両モード共通の付け外し | `grid.setCellStatus([{ rowId, cellStatus }])`／React の `ref.setCellStatus`。行を丸ごと置き換え・`{}` で消す。共同編集モードでも使え、状態は各クライアントの画面だけに持つ |
| DD-063 | 確定前の検証 | mount オプション／React props `validateCell: ({ rowId, columnId, value }) => string \| null`。文字列を返すとその値の確定を止め（入力を捨てる）、`cell-invalid` イベントで通知。貼り付けは 1 件でも不正なら全体を拒否 |

- 単独モードの `setRows`／`setData` の `cellStatus`（alpha.15）の挙動は変わらない（`setCellStatus` と同じ置き場を使う）
- `validateCell` は空にする確定（Delete・範囲クリア・cut）・Undo/Redo・`setRows`/`setData`・リモートの変更では呼ばれない。例外を投げたら通す（診断 `validate-cell-threw`）
- 詳細は quick-start「セルの状態表示」「確定前の検証」と CHANGELOG `[0.1.0-alpha.16]`

## OFIC での取り込み（実施済み・2026-10-22）

OFIC DD-005（`C:/repo/ofic_bi_tool/doc/DD/DD-005_負の数の赤字とセルのエラー表示.md`）で取り込んだ。

1. `vendor/nanairo-sheet/` の alpha.14 の 10 tarball を alpha.16 へ置き換え、manifest の SHA-256 と照合（10 件一致）。`package.json` の `file:` を書き換えて install（10 package 変更・`node_modules` の版も alpha.16）
2. `npm run check`（Lint・型検査・テスト 50 件・ビルド）が green
3. 実画面（開発サーバー）で確認:
   - 負の数が括弧付きの赤字（報告入力の売上総利益・営業利益、按分の基準の本部内取引など）。正の数は右に `)` 1文字分あいて一の位がそろう
   - 報告入力で「abc」・9桁を入れると、そのセル（と桁あふれになった計算行）に赤枠と薄赤の背景が付き、ホバーでメッセージのツールチップ。表の下のエラー一覧にも出て申請できない
   - タブの切り替えで印が付け直され、値を直すと印も一覧からも消える。組織を切り替えても古い印は残らない
4. OFIC は確定前の検証（`validateCell`）を使わない（現行 Excel は入力を止めずに申請時に検査するため。OFIC DD-005 の決定事項）

## 完了境界

SDK の実装・Codex レビューと修正・自己レビュー・機械検証・配布物の作成と、OFIC への取り込み・画面の確認まで完了。実 IME（MS-IME）での `validateCell` の拒否の確認、商談デモ（2026-11-09）での確認、push、registry publish は未実施。
