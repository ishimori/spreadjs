# DD-054: React Facade へ alpha.8 の新オプションと setRows を写す（consumer 駆動: ReadyCrew RC15）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-13 | 2026-09-13 | 進行中 | consumer 駆動（ReadyCrew DD-124）。要件正本は ready_crew_db `doc/DD/DD-124/sdk-requirements.md` RC15。DD-052-2〜4 の React 写像漏れ。Phase 1〜2（写像・テスト・文書）完了、alpha.9配布待ち |

> アプローチ: TDD（Facade の props・handle の写像。既存の `nanairo-sheet-view.dd0NN.test.ts` と同じ形で先にテストを書く）
> リスク: なし（認可・DBスキーマ・外部I/F・機密情報に触れない）

```text
Risk Class: B（React Facade の写像追加のみ。grid の挙動・protocol・永続化は変えない。API の形は DD-052 論点6・8 で決定済み）
Risk Triggers: 公開 API（React props・ref handle）の追加（Experimental 0.x）
Human Spec Gate: skipped（DD-052 で決めた grid API をそのまま React へ写すだけ。写し方の論点は検討内容の推奨どおり）
Codex: 起票時 high（2026-09-13・ready_crew_db DD-124 と合わせて実行。指摘1件＝配布手順を反映）／実装後 medium
Manual Gate: なし（unit と consumer-harness で判定できる）
External Review: なし
Evidence Level: minimal
```

## 目的

alpha.8 で grid Facade に入った `stringColumns`（DD-052-2・RC12）・`rowOperations`（DD-052-3・RC14）・`GridInstance.setRows`（DD-052-4・RC4）を、React Facade（`<NanairoSheetView>`）の props と ref handle から使えるようにし、alpha.9 として配布する。

## 背景・課題

- 要件の正本: ready_crew_db `doc/DD/DD-124/sdk-requirements.md` RC15。乖離したらメモ側が勝つ（DD-035・DD-050 と同運用）
- ReadyCrew の商談進捗シートは `<NanairoSheetView mode="standalone">` で使っている。DD-124 Phase 4 で alpha.8 を取り込む前の確認で、React から RC12・RC14・RC4 を使えないことが分かった
- 事実（alpha.8・2026-09-13 確認）:
  - React Facade は grid へ渡す mount オプションを列挙して組み立てる（`packages/react/src/index.ts` の `toMountOptions` 284-331）。`stringColumns`・`rowOperations` は列挙に無く、props 型（`NanairoSheetViewCommonProps` 54-120）にも無い
  - 識別系の remount キー（`mountKeyOf` 213-242）にも無い
  - ref handle（`NanairoSheetViewHandle` 150-170・`useImperativeHandle` 374-443）に `setRows` が無い
  - 配布 tarball `release/0.1.0-alpha.8/nanairo-sheet-react-0.1.0-alpha.8.tgz` の `package/src/index.ts` でも `stringColumns`・`rowOperations`・`setRows` の出現は0件（grid の tarball には `stringColumns` がある）
  - React から使えるもの: 行データの `readOnlyColumns`（RC3・`initialData`／`setData` のデータに載る）、Alt+Enter とエディターの拡大（RC1・RC2・既存の `wrapColumns`）、`header-click`／`cell-hover`（RC5・RC6・`onEvent` の素通し）
  - `doc/quick-start.md` の3機能の説明は grid の `mount()` の例で書かれており、React で使えるとは書いていない（文書の誤りではない）
- DD-052-2〜4 の受け入れ基準は grid Facade を対象にしており、React Facade への写像は範囲に書かれていなかった。DD-035・DD-036・DD-049 は grid の追加と同じ DD で React へ写していた（`packages/react/src/nanairo-sheet-view.dd035/dd036/dd049.test.ts`）

## 検討内容

| # | 論点 | 選択肢 | 推奨と理由 |
|---|------|--------|-----------|
| 1 | props の分類（Facade 契約 §4） | (a) `stringColumns`・`rowOperations` を識別系（mount 固定・値で remount 判定） / (b) 初期値系（mount 後の変更は無視＋warn） | **(a)**。grid 側がどちらも mount 時固定（`wrapColumns` と同運用）。`stringColumns` は集合としてソートして比較（`readOnlyColumns` と同じ）、`rowOperations` は素の boolean |
| 2 | `setRows` の handle | (a) `setData` と同じく未 mount は warn して無視し、共同編集モードは grid 側の no-op＋warn に任せる / (b) Facade で mode を見て弾く | **(a)**。既存の handle（`setData`・`insertRows` 等）と同じ写像にそろえる |
| 3 | 今後の写像漏れの防止 | (a) grid の `GridCommonMountOptions`・`GridInstance` と React の props・handle のキーの対応を型レベルのテストで突き合わせる（対象外の項目は明示リスト） / (b) 手作業のまま | **(a) を本DDで入れる**（小さく書ける場合）。範囲が広がる場合は backlog へ記録して別DD |

## 決定事項

- 論点1〜3: 推奨どおり（Human Spec Gate skipped の範囲。論点3 が広がる場合はログに理由を残して backlog へ）

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | `<NanairoSheetView mode="standalone" stringColumns={['phone']}>` で `09012345678` を確定・貼り付け・`setData` しても、`onCellCommit` の値と表示が文字列のまま | `packages/react/src/nanairo-sheet-view.dd054.test.ts` |
| 2 | `rowOperations={false}` で Ctrl+Shift+'+'／Ctrl+'-' が行を増減しない。未指定は従来どおり増減する | 同上 |
| 3 | `stringColumns`・`rowOperations` の値が変わると remount し、同じ値の新しい配列リテラルでは remount しない | 同上 |
| 4 | `ref.setRows(rows)` が grid の `setRows` を呼ぶ（言及しない行と Undo 履歴を保つ）。未 mount では warn して無視する | 同上 |
| 5 | grid の mount オプション・`GridInstance` の公開メソッドのうち React に無いものがテストで検出される（論点3 を入れた場合） | 同上（型レベルのテスト） |
| 6 | 型検査・lint・全テスト・厳格設定の consumer 型検査・consumer-harness が通る | `npm run typecheck`・`npm run lint`・`npm test`・`npm run typecheck:consumer-strict`・`npm run consumer-harness` |
| 7 | CHANGELOG・quick-start §4c・`apps/showcase/src/features.json` の react 説明に反映し、alpha.9 を配布して ReadyCrew DD-124 へ引き渡す | Phase 2 目視・`release/0.1.0-alpha.9/manifest.json` |

## タスク一覧

### Phase 1: 写像とテスト
- [x] `packages/react/src/nanairo-sheet-view.dd054.test.ts`: 受け入れ基準1〜5のテストを先に書く（Red）
- [x] `packages/react/src/index.ts`: props 型・`mountKeyOf`・`toMountOptions` に `stringColumns`・`rowOperations`、`NanairoSheetViewHandle`・`useImperativeHandle` に `setRows`（Green）
- [x] 🔬 機械検証: `npm test`・`npm run typecheck`・`npm run lint` → パス（`tests/contract/facade-surface.test.ts` の react 公開宣言 snapshot を更新）

### Phase 2: 文書と配布
- [x] `CHANGELOG.md`（alpha.9）・`doc/quick-start.md` §4c・`apps/showcase/src/features.json` の react 説明を更新
- [ ] 配布 closure 10 package（`packages/{grid,react,server-hono,core,types,collab,render,selection,ime,server}/package.json`）の `version` と `package-lock.json` の該当エントリを `0.1.0-alpha.9` へ上げる（`scripts/release/build-release.sh` は採番せず既存の版を読むだけで、版がそろっていなければ停止する＝同 109-121）
- [ ] `bash scripts/release/build-release.sh --out release/0.1.0-alpha.9` で配布物を生成し（既定の出力先は `release/` 直下＝同 23・30-35）、ReadyCrew DD-124 への引き渡し（版・変更点）を本DDのログへ記録
- [ ] 🔬 機械検証: `npm run typecheck:consumer-strict`・`npm run consumer-harness` → パス／`release/0.1.0-alpha.9/manifest.json` の `version` が `0.1.0-alpha.9`

### 完了前チェック
- [ ] 受け入れ基準を1項目ずつ照合（未達成があれば理由をログへ）
- [ ] 😈 セルフレビュー1巡（「どこが壊れるか」を探す。読み返す価値のある所見のみログへ。深掘りが要る場合の手法: doc/da-method.md）
- [ ] 🔬 全回帰1回（`npm run typecheck`・`npm run lint`・`npm test` → 全パス）

## ログ

### 2026-09-13
- DD作成。ready_crew_db のセッションが起票を代行（DD-124 Phase 4 の取り込み前確認で発見。要件メモ RC15）。以後は spreadjs 側のセッションで進める
- Codex レビュー（起票時・high・ready_crew_db `doc/DD/DD-124/codex-review-result-rc15.md`）: 事実記述（行番号・配布 tarball）・写像漏れの範囲・Risk B／Gate skipped・論点の推奨は指摘なし
- 採用 P2 配布手順に版の更新と出力先が無く、`release/0.1.0-alpha.9/manifest.json` を生成できない → Phase 2 に10 package と lock の版更新タスクを足し、コマンドを `--out release/0.1.0-alpha.9` 付きで明記（`build-release.sh` 23・30-35・109-121 で確認）
- Phase 1〜2 実装完了。`packages/react/src/index.ts`: `stringColumns`（集合＝ソートして正準化・readOnlyColumns と同じ）・`rowOperations`（素の boolean）を props/`mountKeyOf`/`toMountOptions` へ、`setRows` を `NanairoSheetViewHandle`/`useImperativeHandle` へ追加（他の命令 API と同型: 未 mount は `handle-before-mount` warn）
- 論点3（型レベルの網羅性チェック）を採用: `GridCommonMountOptions` の全キーが対応する props 名（`columnWidths`→`initialColumnWidths` 等の改名は明示マップ）で `NanairoSheetViewCommonProps` に存在すること、`GridInstance` の全メンバーが除外リスト（`documentId`・`subscribe`・`destroy`＝理由付き）を除いて `NanairoSheetViewHandle` に存在することを、`npm run typecheck` で強制する。実装中に2回とも意図的に欠落させて型エラーが該当キー名入りで出ることを確認済み（例: `Type "stringColumns" does not satisfy the constraint never`）。ハマった点: (1) homomorphic mapped type が optional 修飾を引き継ぐため `[K in keyof T]:` だけだと union に undefined が混入する→`-?` で除去、(2) noUnusedLocals/noUnusedParameters を満たすため、型だけの named type alias ではなく「呼ばれない関数の引数型」として埋め込み `void fn;` で参照した
- 🔬 機械検証: `npm test`（129ファイル・1363件）・`npm run typecheck`・`npm run typecheck:consumer-strict`・`npm run lint` 全パス。`tests/contract/facade-surface.test.ts` の react 公開宣言 snapshot 差分（3点の追加のみ）を確認して更新
- `CHANGELOG.md`（[Unreleased]→alpha.9予定）・`doc/quick-start.md` §4c（識別系props一覧・命令API一覧）・`apps/showcase/src/features.json`（react エントリ）を更新
