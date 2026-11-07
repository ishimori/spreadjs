# DD-064 / hiroshima-keikaku K1〜K4: alpha.19 引き渡し（2026-11-08）

## 配布物

- ディレクトリ: `C:/repo/spreadjs/release/0.1.0-alpha.19/`（10 tarball＋`manifest.json`＋本書と同じ README）
- ZIP: `C:/repo/spreadjs/release/nanairo-sheet-0.1.0-alpha.19.zip`（SHA-256 は DD-064 本文のログに記録）
- package 版: `0.1.0-alpha.19`（10 package 同一版）。API 版: `0.1.0-experimental`（公開 `.d.ts` の差分は追加のみ。`GridErrorCode` の union に `merged-cells-invalid` が増えた）
- 生成元: `bd2985fc14d98935f8bf8f1ba547567f3b79691e`。manifest は `closureDirty=false`（`gitDirty=true` は DD 文書など配布外の変更による）
- 取り込み: `prototype/vendor/nanairo-sheet/*.tgz` を alpha.19 の 10 個に差し替え、`prototype/package.json` の `file:` の向き先を変えて入れ直す（前回PoC の DD-005 と同じ手順。版番号が変わるので lock は消さない）

`build-release.sh --skip-verify` で pack した（直前に同じコミットで unit 1,586 件・typecheck・consumer-strict・lint・build・playground E2E 289 件・showcase E2E 5 件が green）。
`verify-manifest.mjs` で 10 tarball の SHA-256・版を照合し、pack 内容は 121 files・全 entrypoint あり・tsconfig/test/spec なし。
consumer-harness（pack→install→tsc）と、独立 consumer-app（この配布の tarball だけで install）の型検査・server lifecycle・E2E 10 件が green。

## alpha.18 からの変更（K1〜K4）

### K1〜K3: セルの結合（`mergedCells`・`setMergedCells`）

左上のセル（`rowId`・`columnId`）と行数・列数（`rowSpan`・`columnSpan`・省略は 1）で範囲を渡すと、1 つのセルとして描く。

```tsx
// 明細ごとの 3 行（予算・実績＋見通し・差異）で、属性の列を 3 行にまたがって結合する
const mergedCells = useMemo(
  () => details.flatMap((d) => ATTRIBUTE_COLUMNS.map((columnId) => ({ rowId: `${d.id}:budget`, columnId, rowSpan: 3 }))),
  [details],
);
<NanairoSheetView ref={ref} mode="standalone" columnOrder={columns} frozenRowCount={0} frozenColumnCount={8}
  initialData={{ rows }} mergedCells={mergedCells} rowOperations={false} />
```

- **値は左上のセル**のもの（背景・書式・状態表示も左上）。範囲の中の他の行の値は描かない（コピーも空）。属性は明細の最初の行（`:budget`）に入れればよい（つなぎで最初の行だけに出していた形のまま）
- **読むだけ**（K3）: 範囲の中は編集・Delete・候補欄・カレンダーを開かない。Excel から範囲を貼ると、結合範囲のセルだけ飛ばして残りへ入る
- **選択・移動**（K1）: 範囲の中をクリックすると左上を選び、枠は範囲全体。矢印キー・Tab・Enter は範囲を 1 つのセルとして動く。Shift＋矢印・ドラッグの範囲は結合を含むまで広がる。`cell-hover` は左上のセルと範囲全体の `rect`
- **行を入れ直すとき**（K2）: `ref.setData({ rows })` と同じ commit で `mergedCells` も新しい行に合わせて変える（React は値が変わっても開き直さず grid の `setMergedCells` を呼ぶ）。結合は次の描画の時の行に張るので、どちらが先でもよい。毎 render 新しい配列を渡すと毎回張り直すので、行と一緒に `useMemo` する
- **`frozenRowCount={0}` が要る**: 既定の 1 だと先頭のデータ行が固定され、先頭の明細の 3 行結合が固定行の境界をまたいで張られない（`onDiagnostic` に `merged-cell-conflict`）。固定列（`frozenColumnCount`）の境界をまたぐ結合は mount 時にエラー
- 行が無い・重なる・行の挿入で壊れた結合は描かず、`onDiagnostic` に warn（`merged-cell-unresolved`・`merged-cell-conflict`・`merged-cell-broken`）。指定の形の誤り（未知の列など）は mount 時に `onError`（code=`merged-cells-invalid`）
- 結合範囲の文字で行の高さを自動で伸ばさない（`wrapColumns` の列でも。Excel と同じ）。収まらない文字は … で切る
- 縦に動かして結合の上の端が隠れたとき、文字は範囲と一緒に動く（見える所へ寄せない）

### K4: 2段の見出し（`columnGroups`）

```tsx
columnGroups={[
  { caption: '上期', columnIds: ['m04', 'm05', 'm06', 'm07', 'm08', 'm09'] },
  { caption: '下期', columnIds: ['m10', 'm11', 'm12', 'm01', 'm02', 'm03'] },
]}
```

- 見出しが 48px（24＋24）になり、まとめた列は上の段にまとまりの名前・下の段に列の名前（`columnCaptions` か A/B/C）、まとめていない列（属性・区分・年計など）は 2 段ぶんの高さに名前
- 列は `columnOrder` で隣り合うこと・固定列の境界をまたがないこと（誤りは mount 時に `onError`・code=`column-display-invalid`）
- 上の段のクリックは `header-click` を出さない（下の段と、まとめていない列の見出しは従来どおり出す）。mount 固定（値が変われば開き直す）

### K5（セル単位の読み取り専用）

対象外（consumer の「範囲外でよい」どおり）。つなぎ（`validateCell` での拒否と、消去を `cell-commit` で戻す）のまま。

## consumer 側で確かめること（sdk-requirements.md「consumer 側で確かめること」）

- 固定した属性の列（`frozenColumnCount`）の中の結合を、横・縦に動かして崩れないこと（SDK の E2E では確認済み・実画面で）
- `vite-plugin-singlefile` で 1 ファイルの HTML にまとめても動くこと
- 実 IME: 結合範囲の隣のセルへ矢印キーで移って、日本語入力を始められること（SDK では synthetic の確認だけ）

## 既知の未保証境界

- 実 IME（Microsoft IME）での確認は未実施（Manual Gate・DD-064 の既知の未保証境界）
- consumer の試作への取り込みと画面での確認は未実施（AC8・hiroshima-keikaku DD-001-15 側）
