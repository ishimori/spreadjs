# DD-064 公開 API 契約（セルの結合・2段の見出し）

> 決定事項（論点1〜12・2026-11-08 に推奨案で確定）を実装できる粒度まで落とした正本。DD-036/contract.md と同じ形式。
> Experimental 0.x（ADR-0015）。どちらも **view-local**（文書の状態・Operation・protocol・snapshot・hash は変えない）。
> 要件の出所: hiroshima-keikaku `doc/DD/DD-001-15/sdk-requirements.md` の K1〜K4（K5 は対象外）。

## 1. 結合の指定（`mergedCells`・`setMergedCells`）

```ts
/** 結合する範囲（DD-064）。左上のセルと、そこから下・右へ何行・何列を1つにするかで指定する。 */
export interface GridMergedCell {
  readonly rowId: string;
  readonly columnId: string;
  /** 左上の行を含む行数（1 以上の整数・省略は 1）。 */
  readonly rowSpan?: number;
  /** 左上の列を含む列数（1 以上の整数・省略は 1）。 */
  readonly columnSpan?: number;
}

interface GridCommonMountOptions {
  /** 結合する範囲（両モード・初期値。実行中は setMergedCells で置き換える）。 */
  readonly mergedCells?: readonly GridMergedCell[];
}

interface GridInstance {
  /** 結合を丸ごと置き換える（両モード・[] で全部外す・同じ内容なら何もしない）。 */
  setMergedCells(mergedCells: readonly GridMergedCell[]): void;
}
```

### 1.1 形の検査（列だけで決まる誤り）

次のどれかに当たる指定は「形の誤り」とする。

- 配列でない／要素がオブジェクトでない
- `rowId`・`columnId` が空でない文字列でない
- `rowSpan`・`columnSpan` が 1 以上の整数でない（省略は 1）
- 1×1（`rowSpan` も `columnSpan` も 1）
- 未知の列（`columnOrder` に無い）／列の範囲が右端の列を越える
- 固定列（`frozenColumnCount`）の境界をまたぐ（左上の列が固定側で、右端の列がスクロール側）
- 同じ左上（`rowId`＋`columnId`）の指定が2つ以上ある（2つ目以降が誤り）

扱い:

- **mount オプション**: 1件でもあれば fail-fast（`error` phase=`config`・code=`merged-cells-invalid`・配線しない）。列の並びが分かった時点（単独モードは boot、共同編集モードは `/config` の後）で検査する（既存の列設定と同じ経路）。
- **`setMergedCells`**: throw しない（既存の命令と同じ）。誤りの指定だけ捨てて診断 warn（code=`merged-cells-invalid`・どの番号の指定か・理由）を出し、残りは張る。配列でなければ何も変えずに warn。

### 1.2 張る（描画の時の解決）

- 結合を行に張るのは**次の描画の時**。`setData`・`setRows`・`setMergedCells`・行の挿入・削除は、同じ処理（同じタスク）の中ならどの順で呼んでも結果は同じ。描画の前の判定（クリック・キー）は、直前に描いた時の結合で行う（画面と食い違わない）。
- 張る時に、その時の行の並びで左上の行から `rowSpan` 行ぶんの**行 ID を覚え**、以後はその行で持つ（固定 ID・開発計画 §12.7）。列は固定なので index で持つ。
- **保留**: 左上の行が無い／左上から下に `rowSpan` 行ない → 張らずに保留し、診断 warn（code=`merged-cell-unresolved`）を1回出す。行が届いたら（共同編集モードの初回 snapshot・`setRows` の追加・リモートの挿入）その時に張る。
- **張らない（毎回判定）**: 固定行（`frozenRowCount`）の境界をまたぐ／先に並んだ指定の結合と重なる → その結合は描かず、診断 warn（code=`merged-cell-conflict`）を1回出す。条件が解ければ描く。重なりは指定の順で先の方が勝つ。
- **壊れた**: 覚えた行のどれかが無い・並びが変わった・間に行が入った（行の挿入・削除・`setData` の入れ直し・リモートの行操作）→ その結合を捨て、診断 warn（code=`merged-cell-broken`）を1回出す。捨てた結合は `setMergedCells` で指定し直すまで戻らない。範囲の上・下に行が入っても壊れない（範囲は行と一緒に動く）。
- 診断は1つの指定につき理由ごとに1回。`setMergedCells` で置き換えると数え直す。置き換える前に描画が無かった古い指定は判定しない（`setData` の直後に `setMergedCells` を呼ぶ consumer に古い指定の warn を出さない）。

### 1.3 `setMergedCells`

- 全体を置き換える（`[]` で全部外す）。今の指定と同じ内容（順も同じ・省略した span は 1 として比べる）なら何もしない。
- boot 前に呼んでもよい（列の並びが分かった後に形を検査して適用する。最後に呼んだものが勝つ）。destroy 後は何もしない。
- 読み取り専用（`readOnly`）でも使える（表示の設定）。

## 2. 結合したセルの振る舞い（K3・論点2）

結合範囲のセル（左上を含む）は**読むだけ**。

- **入口の抑止**: アクティブセルが結合の左上にある間、編集開始（印字キー・F2・ダブルクリック・IME）・Delete／Backspace・選択式の候補欄・日付のカレンダーを開かない。常駐 textarea は `readOnly` 属性になる（`readOnlyColumns` の列ロックと同じ機構）。抑止したキー・ダブルクリックは診断 info（code=`merged-cell-blocked`）。
- **範囲の操作**: 貼り付け・範囲の消去（Delete）・cut の消去は、結合範囲のセルだけを飛ばして残りへ適用する（TSV の位置はずらさない・全部飛ばしたら何もしない）。診断 info（code=`merged-cell-skipped`）。
- **通すもの**: Undo／Redo・`setData`・`setRows`・リモートの変更・サーバー起点の操作（送信直前の保証層には入れない。表示の設定なので、結合の前に入れた値の Undo を止めない）。
- 範囲の中の左上以外のセルに値があっても描かない（コピーも空）。値は消さない（結合を外せばまた見える）。

## 3. 選択・移動（K1・論点3）

- **左上への正規化**: 結合の中のセルを選んだら（クリック・ダブルクリック・`setActiveCell`・移動の結果・行の構造変更での再ベース）、アクティブセルを左上へ移す。選択の枠は範囲全体に描く。`setActiveCell` で結合の中を指したときも左上になる。
- **矢印キー・Tab・Enter**（Navigation の間）: 範囲を1つのセルとして動く。左上から下・右へ動くと範囲の外（範囲の次の行・列）へ出る。外へ出られない（グリッドの端）ときは動かない。結合の中へ入ったら左上になる。編集中の Enter／Tab／矢印で確定して動いた先が結合の中でも左上になる。
- **範囲の選択**（Shift＋矢印・Shift＋クリック・ドラッグ）: 選んだ矩形が結合にかかったら、かかった結合を全部含むまで広げる（Excel と同じ）。Shift＋矢印は、今の端（焦点）が結合の中なら、その結合の端から1つ外へ動く（押すたびに見える範囲が変わる）。広げた結果が1つの結合そのものなら単一選択として扱う。
- **ホバー**（`cell-hover`）: 結合の中では左上のセルの `rowId`・`columnId` と、範囲全体の `rect` を出す。範囲の中を動いても出し直さない。
- **リンク列**: 結合の左上がリンク列なら、範囲のどこをクリックしても左上の値で `link-open` を出す（範囲の中のドラッグは別のセルへの移動と見なさない）。
- **Presence**: 他の参加者のアクティブセルが結合の中にあれば、枠と名前タグを範囲全体に描く（各クライアントの結合の指定で描く）。

## 4. コピー・貼り付け・消去（論点2・3）

- **コピー**（cut の書き出しも同じ）: 範囲に含まれる結合は、左上に値・残りは空の TSV にする。
- **貼り付けの起点**: 選択の左上。選択は結合を含むまで広げてあるので、起点は結合の左上か結合の外のセル。1×1 の値を複数セルの選択へ敷き詰めるときも、結合範囲のセルは飛ばす。
- **範囲の消去・cut の消去**: 結合範囲のセルは飛ばす（§2）。

## 5. 描画（論点6）

- 結合範囲を1つの大きなセルとして描く。範囲の中のグリッド線と、`rowBorders`・`columnBorders`・`defaultRowBorder` の範囲の中の部分は描かない（範囲の外周の線は描く）。
- 背景・文字・書式・状態表示は左上のセルのもの（行の背景 → 列の背景の順で左上の行・列のものを使い、状態表示・値ベースの書式の背景はその上に乗る）。
- 文字はふつうのセルと同じ決まりで範囲の中に描く: 縦の中央、数値は右寄せ、折り返しの列で2行以上になる文字は上から。範囲に収まらない文字は … で切り、右隣へはみ出さない。範囲の左のセルの文字も結合の手前で止まる（結合は空セルとして扱わない）。
- 結合範囲の文字で行の高さを自動で伸ばさない（折り返しの列でも。Excel と同じ）。列の幅の自動調整（境界のダブルクリック）では、結合範囲の左上以外のセルと、2列以上にまたがる結合の値は測らない。
- 範囲の上の端が隠れても、文字は範囲と一緒に動く（見える所へ寄せない）。固定 pane とスクロール側にまたがる結合は無い（§1）ので、pane ごとの clip（DD-039・DD-041）はそのまま効く。
- `frozenRowCount` の既定は 1（先頭のデータ行が固定）。先頭の行から結合するときは `frozenRowCount: 0` にする（そのままだと固定行の境界をまたぐので張られない・§1.2）。

## 6. 2段の見出し（`columnGroups`・K4・論点5）

```ts
/** 列のまとまり（2段の見出しの上の段・DD-064）。 */
export interface GridColumnGroup {
  /** 上の段に出す名前（空・空白だけは不可）。 */
  readonly caption: string;
  /** まとめる列（columnOrder の中で隣り合う 1 列以上。並べる順は問わない）。 */
  readonly columnIds: readonly string[];
}

interface GridCommonMountOptions {
  /** 列のまとまり（両モード・mount 時固定・表示だけ）。 */
  readonly columnGroups?: readonly GridColumnGroup[];
}
```

- 1件以上あれば見出しを2段にする（24px＋24px＝48px）。空の配列・省略は今と同じ1段（24px）。
- まとめた列は、上の段にまとまりの名前（まとまりの幅の中央・収まらなければ …）、下の段に列の名前（`columnCaptions` か A/B/C）を出す。まとめていない列は2段ぶんの高さの中央に列の名前を出す。まとまりの下と左右に区切りの線を引く。
- **形の誤り**（mount 時に fail-fast・`error` phase=`config`・code=`column-display-invalid`＝`columnCaptions` と同じ）: 配列でない／要素がオブジェクトでない／`caption` が空・空白だけ／`columnIds` が空の配列・文字列の配列でない／未知の列／同じまとまりの中で列が重複／列が隣り合っていない／まとまり同士が同じ列を持つ／固定列の境界をまたぐ。
- **クリック**: 上の段（まとまりの名前）をクリックしても `header-click` を出さない。まとめていない列の見出しと下の段は今と同じく出す。
- **列幅の変更**: 下の段とまとめていない列の境界は今と同じ。上の段では、まとまりの中の列の境界では変えられない（まとまりの端の境界では変えられる）。
- 固定列の境界をまたぐまとまりは無いので、まとまりの名前は DD-039 の pane ごとの clip の中に収まる（DD-042 と同じ現象は起きない・論点12）。

## 7. React Facade（AC7）

| props | 写像 | 変わったとき |
|---|---|---|
| `mergedCells` | mount オプション `mergedCells` | **開き直さない**。値（参照）が変わったら同じ instance の `setMergedCells` を呼ぶ（`readOnly` と同じ）。handle には `setMergedCells` を出さない（props と食い違うため） |
| `columnGroups` | mount オプション `columnGroups` | 識別系（値で直列化して比べ、変わったら開き直す・`columnCaptions` と同じ） |

## 8. 診断コード

| code | level | いつ |
|---|---|---|
| `merged-cells-invalid` | warn | `setMergedCells` の形の誤り（捨てた指定の番号と理由） |
| `merged-cell-unresolved` | warn | 左上の行が無い・下に行が足りない（保留。行が届けば張る） |
| `merged-cell-conflict` | warn | 固定行の境界をまたぐ・先の結合と重なる（描かない） |
| `merged-cell-broken` | warn | 張った範囲の行が欠けた・間に行が入った・並びが変わった（捨てる） |
| `merged-cell-blocked` | info | 結合範囲で編集を始めるキー・ダブルクリックを止めた |
| `merged-cell-skipped` | info | 貼り付け・範囲の消去・cut で結合範囲のセルを飛ばした |

公開エラーコード（`GRID_ERROR_CODES`）に `merged-cells-invalid`（mount オプションの形の誤り・config phase）を足す。`columnGroups` の誤りは既存の `column-display-invalid`。

## 9. 対象外（この DD では決めない・作らない）

- 利用者が画面で結合・解除する操作（MergeCells／UnmergeCells の Operation）と、文書の状態としての結合の共有（ADR-019・D-17 は Open のまま）
- 結合したセルの編集（値は左上のセル）・結合範囲の縮小／拡大の規則
- 結合範囲の高さに合わせた行の高さの自動調整
- セル単位の読み取り専用（K5）
- 2段の見出しの実行時の切り替え・3段以上
