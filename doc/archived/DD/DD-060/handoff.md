# DD-059・DD-060 / OFIC O1・O2: alpha.15 引き渡し（2026-10-22）

## 配布物

- ディレクトリ: `C:/repo/spreadjs/release/0.1.0-alpha.15/`（10 tarball＋manifest＋本書と同じ README）
- ZIP: `C:/repo/spreadjs/release/nanairo-sheet-0.1.0-alpha.15.zip`（SHA-256 は DD-060 本文のログに記録）
- package 版: `0.1.0-alpha.15`（10 package 同一版）。API 版: `0.1.0-experimental`（公開 `.d.ts` の差分は追加のみ）
- 生成元: `dae8d1187ac1fabb768bc4c63a8f327c00fa9eb7`。manifest は `closureDirty=false`（`gitDirty=true` は DD 文書など配布外の変更による）

`build-release.sh --skip-verify` で pack した（直前に unit 1504 件・typecheck・consumer-strict・lint・build・playground E2E 266 件・showcase E2E 5 件が green）。
`verify-manifest.mjs` で 10 tarball の SHA-256・版を照合し、pack 内容は 115 files・全 entrypoint あり・tsconfig/test/spec なし。
独立 consumer-app（この配布ディレクトリの tarball だけで install）の型検査・server lifecycle・production build・E2E 10 件と、consumer-harness の pack→install→tsc が green。

## alpha.14 からの変更

### O1: 負の数の表示書式（DD-059）

`columnDisplayFormats` の number に `negative: { style?, color? }` を足した。描画だけを変え、cell-commit・コピー・`setRows` で受け渡す値は `-1234` のまま。

```ts
// #,##0_);[Red](#,##0) 相当。-1234 → (1,234) を赤字、正の数と 0 は右に ")" 1文字分あけて一の位をそろえる
amount: { type: 'number', grouping: true, decimals: 0, negative: { style: 'parentheses', color: '#c00' } }
// ▲1,234 は style: 'triangle'。style を省くと従来どおり -1,234（color だけの指定もできる）
```

- `columnFormats` の `textColor` が一致したセルは、そちらの色が負の数の色より優先される
- 0 に丸まる負数（decimals 0 の -0.4）は `0` と表示し、括弧・赤字にしない（Excel は `(0)` の赤字。SDK の既知の差）

### O2: セルの状態表示（DD-060）

単独モードの行データに `cellStatus`（ColumnId → `{ level: 'error' | 'warning'; message? }`）を足した。SDK は値を検証しない。
consumer が `onCellCommit` で検証し、`ref.setRows` で印を付け外しする。

- `error` = 赤枠＋薄赤の背景、`warning` = 橙枠＋薄黄の背景。空のセルにも付く。色は固定
- `setRows` で `cellStatus` を渡した行は、その行の状態が**丸ごと置き換わる**（同じ行の他の列の状態も含めて渡す）。`{}` で消える
- `cellStatus` を省略した `setRows`（OFIC の小計の差し替えのような `cells` だけの更新）では、状態は残る
- `initialData` にも書ける。`setData` では作り直す
- 状態は文書のデータではない。cell-commit・コピー・Undo に混ざらず、利用者がセルを編集しても消えない（検証し直して付け外しする）
- `message` は描かない。`onEvent` で受ける `cell-hover` イベントの `status` に載るので、ツールチップは `event.rect`（グリッド内の座標）の位置に consumer が出す。ホバー中のセルの状態が変わると、同じセルのまま出し直される
- 型 `GridCellStatus` は `@nanairo-sheet/grid` から import する（`GridStandaloneRow` と同じ）
- 不正な `level` は無視され、`onDiagnostic` に `cell-status-invalid` が出る

```ts
import type { GridCellStatus } from '@nanairo-sheet/grid';

const statuses = new Map<string, Record<string, GridCellStatus>>(); // 行ごとの全状態を consumer が持つ

function onCommit(changes: readonly GridCellCommitChange[]) {
  const touched = new Set<string>();
  for (const { rowId, columnId, value } of changes) {
    const row = { ...statuses.get(rowId) };
    const message = validate(columnId, value); // 業務の検証（AS400 の桁・数値・小数）
    if (message === null) delete row[columnId];
    else row[columnId] = { level: 'error', message };
    statuses.set(rowId, row);
    touched.add(rowId);
  }
  sheetRef.current?.setRows([...touched].map((rowId) => ({ rowId, cellStatus: statuses.get(rowId) ?? {} })));
}

// <NanairoSheetView onEvent={(e) => { if (e.type === 'cell-hover') setTooltip(e.status === undefined ? null : { text: e.status.message, rect: e.rect }); }} />
```

確定そのものを止める機能はない。申請の前に、状態の付いたセルが残っていないかを consumer が確かめて止める（現行のエラー一覧と同じ判断）。

## 取り込み手順（OFIC リポ側）

1. `vendor/nanairo-sheet/` の alpha.14 の 10 tarball を、本ディレクトリの alpha.15 の 10 tarball へ一括で置き換える（`formula` は配布対象外）。manifest の SHA-256 と照合する
2. `package.json` の `file:vendor/nanairo-sheet/…-0.1.0-alpha.14.tgz` 10 本を alpha.15 へ書き換えて install し、lock とインストールされた版を確認する
3. 型検査・build・既存の入力画面（Entry・Plan・AllocationBase）の入力と保存を確認する
4. O1: 先方の帳票で `#,##0_);[Red](#,##0)` の欄を `negative: { style: 'parentheses', color: … }` にし、損益・費用部門の負の値が括弧付きの赤字で、正の数と一の位がそろうことを見る
5. O2: 表の下のエラー一覧（当面の回避策）に加えて、または置き換えて、エラーのセルに `cellStatus` を付ける。ホバーでメッセージが出ること、小計の差し替え（`cells` だけの `setRows`）で印が消えないこと、`rowBorders` の太い線の内側に枠が見えることを見る
6. OFIC DD-004 の「spreadjs DD-059・DD-060 は未着手（当面は回避策）」を更新する

## 完了境界

SDK の実装・Codex レビューと修正・自己レビュー・機械検証・配布物の作成まで完了。OFIC の実取り込み・実画面での見え方・商談デモ（2026-11-09）での確認、push、registry publish は未実施。

検証の詳細は SDK リポの `doc/archived/DD/DD-060_セル入力の検証とエラー表示.md`（検証・既知の未保証境界・ログ）と `doc/archived/DD/DD-059_負の数の表示書式.md` を参照。
