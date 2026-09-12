# DD-050: 厳格な consumer 設定での型検査（consumer 駆動: 広島空港 H9）

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-12 | 2026-09-12 | 完了 | 厳格な consumer 設定（2フラグ）での SDK 内の型エラー 38件→0件・CI に検査を追加。alpha.7（882a56d）を生成し独立 consumer 検証 PASS・広島 DD-005-3 へ引き渡し |

> アプローチ: 標準（型のための修正が中心。修正後の不変は既存の全回帰で担保し、厳格設定の型検査を機械検証として足す）
> リスク: なし（認可・DBスキーマ・外部I/F・機密情報に触れない）

```text
Risk Class: B（型のための修正が中心。公開型は変えず、内部型の optional に undefined を許す拡張・同値な書き換え・不変条件の型ガードのみ）
Risk Triggers: collab/session.ts・server/{sequencer,room,snapshot}.ts への型ガード追加（正常系の挙動を変えないことが前提。変える必要が出たら停止して A へ昇格）／公開 .d.ts snapshot の差分
Human Spec Gate: done（2026-09-12・ユーザーの実施指示を受けて論点 1〜4 を推奨案で確定。論点 4 の運用規則は決定事項 D4）
Codex: medium（2026-09-12 ユーザー指示で実行。マージ可・指摘なし。DD-050/codex-review-*.md）
Manual Gate: なし（型検査と既存の全回帰で判定できる）
External Review: なし
Evidence Level: minimal
```

## 目的

consumer が自分の tsconfig で `exactOptionalPropertyTypes`・`noUncheckedIndexedAccess` を使っていても、
SDK の TS ソース（`types: ./src/index.ts`）が型エラーにならないようにする（要件メモ H9 の**軽い案**）。
ビルド済みの `.d.ts` を配る**本命**は DD-031（配布昇格）の範囲で、本DDでは扱わない。

## 背景・課題

- 要件の正本: 広島リポ `doc/DD/DD-005/sdk-requirements.md` H9。乖離したらメモ側が勝つ（DD-035 と同運用）
- SDK は TS ソース配布なので、consumer の tsc は SDK のソースも consumer の設定で型検査する（`skipLibCheck` は `.d.ts` にしか効かない）
- 実測（2026-09-12・alpha.5 の tarball を広島モックへ install し、Facade 3つ〔grid・react・server-hono〕の入口から tsc）:

| consumer の設定 | エラー |
|---|---|
| 2フラグなし（spreadjs の `tsconfig.base.json` と同じ） | 0 件 |
| `exactOptionalPropertyTypes` のみ | 18 件 |
| `noUncheckedIndexedAccess` のみ | 15 件 |
| 両方 | 35 件（collab 9・server-hono 8・grid 7・server 7・ime 2・react 2） |

- consumer の実害: 広島モックは `npm run build` の型検査が落ちるため、SDK 内のエラーを別に数えて失敗させないスクリプト
  （広島 `mock/scripts/typecheck.mjs`）でしのいでいる。松下は client の tsconfig にこの2フラグが無いので顕在化していない
- 既存の検査で拾えない理由: `npm run typecheck` は各 workspace の tsconfig（2フラグなし）で回る。`consumer-harness`（pack→install→tsc）も
  tsconfig に2フラグが無く、CI（`.github/workflows/ci.yml`）にも入っていない
- `.d.ts` 配布は `doc/plan/phase2-dd-roadmap.md` の **DD-031**（registry・dist・versioning・リネームの不可逆な配布判断）に予約済み。
  前倒しはその判断を伴うので、本DDは「ソースのまま厳格設定でも通る」までに絞る

エラーの位置（`packages/` 以下・行番号は alpha.5〔`e52944c`〕時点。DD-049 の実装で collab・grid の行はずれる）:

| ファイル | 行 | コード |
|---|---|---|
| `collab/src/session.ts` | 254・598・818・932・966・968・972 | TS2375・TS2345・TS2532・TS18048 |
| `grid/src/border-rules.ts` | 74・81 | TS2379 |
| `grid/src/display-format.ts` | 232・238 | TS2375 |
| `grid/src/ime-editing-session.ts`・`integration-editor.ts`・`select-editor.ts` | 176・239・346 | TS2375・TS2379 |
| `ime/src/event-recorder.ts` | 119・127 | TS2375 |
| `react/src/index.ts` | 286・294 | TS2375 |
| `server/src/oplog-store.ts`・`presence.ts` | 171・75 | TS2345・TS2375 |
| `server/src/room.ts`・`sequencer.ts`・`snapshot.ts` | 330・331・205・136 | TS2532・TS2345 |
| `server-hono/src/index.ts` | 175 | TS2379 |
| `server-hono/src/server.ts` | 588・711・716・786・818・984・1187 | TS2379・TS2345・TS2322・TS2375 |

TS2375・TS2379 は `exactOptionalPropertyTypes`（optional へ undefined を渡している）、TS2532・TS18048 と一部の TS2345 は
`noUncheckedIndexedAccess`（配列・Map の取り出しが undefined でありうる）由来。

## 検討内容（Human Spec Gate）

| # | 論点 | 選択肢 | 推奨と理由 |
|---|------|--------|-----------|
| 1 | 直し方 | (a) ソースを厳格設定でも通るように直す / (b) `.d.ts` を生成して配る（DD-031 の前倒し） / (c) 何もしない（consumer が回避する） | **(a)**。35件はほぼ型だけの修正で済み、配布の不可逆判断に触れない。(c) は consumer ごとに回避策を持たせ、2件目以降にも同じ回避を強いる |
| 2 | 厳格設定をどこで守るか | (a) `tsconfig.base.json` に2フラグを足し、全 workspace（テスト・apps 含む）で守る / (b) Facade の入口から辿れるソースだけを、2フラグ付きの専用設定で検査する（`tsconfig.consumer-strict.json`＋`npm run typecheck:consumer-strict`） / (c) `consumer-harness` の tsconfig に2フラグを足す | **(b)**。(a) はテスト・apps まで直す必要があり規模が読めない。(c) は pack→install を伴って遅く、CI に入っていない。(b) は consumer が実際に読むソースだけを対象にでき、CI に1ステップ足すだけで済む。(a) は後から段階的に広げる選択肢として残す |
| 3 | `noUncheckedIndexedAccess` の直し方（sequencer・room・snapshot・session） | (a) 既存の不変条件で値があると保証されている箇所は、理由コメント付きで取り出して検査し、無ければ内部エラーとして throw する / (b) `!`（非 null アサーション）で黙らせる | **(a)**。(b) は型検査を通すためだけに保証を消す。(a) の throw は不変条件が破れたときだけ発火し、正常系は変えない（既存の不変条件テスト・E2E が無修正で通ることで確かめる） |
| 4 | 公開型への影響 | (a) 公開型の optional に undefined を許す（受け取れる値が広がるだけ） / (b) 内部の呼び出し側で undefined を渡さない形（条件付きスプレッド）に直し、公開型は変えない | **箇所ごとに (b) を優先**。公開型を変える必要がある箇所だけ (a) にし、契約 snapshot の差分が拡張だけであることを目視して CHANGELOG に書く |

## 決定事項

2026-09-12、ユーザーの実施指示を受けて論点 1〜4 を推奨案で確定した。

| # | 決定 | 内容 |
|---|------|------|
| D1 | 論点1 = (a) | SDK のソースを厳格設定でも通るように直す。`.d.ts` 配布（DD-031）には触れない |
| D2 | 論点2 = (b) | `tsconfig.consumer-strict.json`（`tsconfig.base.json` を継承し、2フラグ・lib `ES2022`/`DOM`/`DOM.Iterable`・types `node`・`files` に Facade 3 つの入口）とルート script `typecheck:consumer-strict`（`tsc -p`）。CI の checks に `npm run typecheck` の直後の1ステップとして足す |
| D3 | 論点3 = (a) | `!` は使わない（規約 P03）。**添字をなくす**（`entries()`・`reduceRight`・反転コピー）、**取り出した値の undefined 判定へ置き換える**（`findIndex` の -1 判定・非空検査済みの `ids[0]`）、**空なら内部エラーを throw**（呼び出し側が 1 件以上で呼ぶ `operationsMessage`・`primaryRejectCode`）の3形で直す |
| D4 | 論点4 = (b) を優先 | **公開型（Facade が export する型）は変えない**。SDK 内の呼び出し側で undefined を落とす（react `toMountOptions` は `omitUndefined` で値が undefined のキーを落として grid へ渡す／grid `border-rules.ts` の内部 Map は関数ローカルの型）。**内部型**（core・collab・server・ime と Facade 内の非公開型）は、既に undefined を素通ししている実態に合わせて `?: T \| undefined` へ広げ、実行時の値の形（キーの有無）を変えない。キーを省く形にしないのは、ime の trace テストが `'key' in trace` でキーの有無を検査しているため。公開型を広げる (a) は不要だった |
| D5 | 配布 | ユーザー指示（2026-09-12「コミットして新しいターボールを生成してください」）で `0.1.0-alpha.7` として配布する。alpha.6 は DD-049 の配布として本DD の編集より前に生成済みで、本DD の変更を含まない |

### 着手時点の計測と仕分け（📐 実装前詳細化）

着手時点（`0f8cfe9`・DD-049 込み）で 38 件（起票時 35 件＋DD-049 で増えた `server-hono/src/server.ts` の 3 件）。
正常系の分岐を変える必要がある箇所は 0 件のため、Risk A への昇格は不要と判断した。

| 分類 | 件数 | 箇所 | 直し方 |
|---|---|---|---|
| 型の宣言だけ（実行時コード不変） | 18 | collab `session.ts` 2・server `presence.ts` 1・grid `border-rules.ts` 2・`display-format.ts` 2・`ime-editing-session.ts` 1・`integration-editor.ts` 1・`select-editor.ts` 1・ime `event-recorder.ts` 2・server-hono `index.ts` 1・`server.ts` 5 | D4 の内部型の拡張、またはローカル型の変更 |
| 呼び出し側で undefined を落とす（公開型を守る） | 2 | react `index.ts` 2 | D4 の `omitUndefined` |
| 同値な書き換え | 15 | collab `session.ts` 7・server-hono `server.ts` 5・server `oplog-store.ts` 1・`snapshot.ts` 2 | D3 の「添字をなくす」「undefined 判定へ置き換える」 |
| 不変条件ガード（空なら throw） | 3 | server `room.ts` 2・`sequencer.ts` 1 | D3 の throw。正常系では発火しない |

TS は 1 つの代入エラーで 1 プロパティしか報告しないため、実際に直した optional の受け渡しは件数より多い
（react の mount オプション一式・`StartServerOptions` の全項目・`ImeEditingSessionConfig` の callback 3 つなど）。

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | `npm run typecheck:consumer-strict`（Facade 3つの入口・2フラグ付き）→ エラー 0 件 | Phase 2 🔬 |
| 2 | 既存の `npm run typecheck`・`npm run lint`（boundary 含む）・`npm test`（invariants/contract 込み）・E2E が無修正で green | Phase 3 全回帰 |
| 3 | CI（`.github/workflows/ci.yml`）に厳格設定の型検査が入り、違反を足すと落ちる | Phase 2 🔬（わざと違反を1つ入れて失敗を確認し、戻す） |
| 4 | 公開 .d.ts snapshot の差分が拡張だけで、CHANGELOG に記載がある | Phase 3 contract test＋目視 |
| 5 | 作り直した tarball を広島モックへ入れると、広島 `mock/scripts/typecheck.mjs` の「nanairo-sheet 内」の件数が 0 になる | consumer 側（広島 DD-005-3）で確認 |

## タスク一覧

### Phase 1: 仕様確認（Human Spec Gate）
- [x] 論点 1〜4 を確定（決定事項 D1〜D4）
- [x] 📐 実装前詳細化: 着手時点（DD-049 の変更を含む）で計測し直し、各エラーを「型だけで直る」「実行時の分岐が要る」に仕分ける（後者があれば A 昇格の要否をユーザーへ） → 38 件・実行時の分岐が要る箇所 0 件
- [x] 🔬 機械検証: `bash scripts/dd-health.sh --dd DD-050 --new` → ⚠️なし

### Phase 2: 厳格設定の型検査を作って 0 件にする
- [x] `tsconfig.consumer-strict.json`（新規。`tsconfig.base.json` を継承し2フラグ・lib・types を足す。対象は Facade 3つの入口）とルート script `typecheck:consumer-strict`
- [x] `packages/{collab,grid,ime,react,server,server-hono}/src` のエラーを修正（`core/src/protocol.ts` も含む）
- [x] `.github/workflows/ci.yml` の checks に `npm run typecheck:consumer-strict` を追加
- [x] 🔬 機械検証: `npm run typecheck:consumer-strict` → 0 件／わざと違反を1つ入れて失敗することを確認して戻す

### Phase 3: 回帰と配布
- [x] `tests/contract` snapshot 更新（差分が拡張だけであることを目視）・`CHANGELOG.md` → 公開 .d.ts snapshot は差分なし（更新不要）。CHANGELOG は 0.1.0-alpha.7 の Fixed に記載
- [x] tarball 再生成（`scripts/release/build-release.sh`）の要否と版をユーザーへ確認（DD-049 の配布と同じ版に載せるか） → alpha.6 は引き渡し済みのため alpha.7。実装 `d06975a`・版更新 `882a56d` の後に `release/0.1.0-alpha.7/` を生成（closureDirty=false）。verify-manifest／check-pack-contents（111 files）／consumer-app E2E 10/10／tarball 実体への厳格設定の型検査 0 件 PASS。[検証結果](DD-050/validation.md)・[引き渡し](DD-050/handoff.md)・[凍結 manifest](DD-050/release-manifest.json)
- [x] 🔬 機械検証（全回帰1回）: `npm run typecheck`・`npm run lint`・`npm test`・`npm run test:e2e`・`npm run test:e2e:showcase` → 全 green（1315 件・E2E 203 件・showcase 4 件）

### 完了前チェック
- [x] 受け入れ基準 1〜4 を照合（5 は consumer 側で確認） → AC1 0 件／AC2 全回帰 green（テスト・E2E は無修正）／AC3 違反を入れると exit 2／AC4 公開 .d.ts snapshot 差分なし・CHANGELOG 記載。AC5 は広島側（spreadjs 側では tarball 実体への厳格設定の型検査 0 件で代替確認）
- [x] 😈 セルフレビュー1巡（足した throw が正常系で発火しないか・公開型の変更が拡張だけか）

## 既知の未保証境界・既知制約

- `.d.ts` の配布は扱わない（DD-031）。consumer が別の厳格フラグ（例 `noPropertyAccessFromIndexSignature`）を使う場合は、また型エラーになりうる
- 計測は Facade 3つの入口から辿れるソースだけ。`grid/test-support` など公開契約でない入口は対象外
- 検査は spreadjs の TypeScript（ルートの devDependency・5.9）で行う。consumer の TypeScript の版が大きく違うと結果が一致しないことがある
  （例: TS 5.9 は `--target` を省くと ES5 になり、2フラグと無関係な反復・BigInt のエラーが出る）
- **配布**: 本DDの変更は `0.1.0-alpha.7`（`release/0.1.0-alpha.7/`・ソース `882a56d`）に含まれる。広島リポへの適用は広島側 DD-005-3 で行う（本DDでは未実施）
- **受け入れ基準 5**（広島 `mock/scripts/typecheck.mjs` で「nanairo-sheet 内」0 件）は広島側 DD-005-3 で確認する（本DDでは未実施）。
  spreadjs 側では alpha.7 の tarball 実体へ同じフラグの tsc を当てて 0 件を確認済み
- `scripts/release/build-release.sh` は closureDirty を冒頭で判定し、数分の検証ゲートの後に pack する。その間に packages/ が編集されると、
  中身が混ざった tarball でも closureDirty=false になる（alpha.7 は tarball とコミットの全ファイル照合で混入なしを確認。スクリプトの改修は未着手）

## ログ

### 2026-09-12
- 起票。広島空港モック（`C:/repo/hiroshima-airport` DD-005-2）の実装中に、SDK のソースがモックの厳格な tsconfig で型エラーになると分かり、
  要件メモ H9 として持ち込み。広島側セッションが起票を代行（以後は spreadjs 側のセッションで進める）
- 番号: DD-049 の子（DD-049-2）にはしなかった。DD-049 は共同編集のイベント系（Risk A・実装中）でテーマが違い、完了と配布が DD-049 に縛られるため。
  松下からの持ち込み（DD-035・037〜039）と同じく独立番号にした
- **DD-INDEX.md は再生成していない**。起票時点で DD-049 の実装が未コミットで INDEX も変更中のため、衝突を避けた。
  spreadjs 側のセッションで `bash scripts/dd-index-gen.sh` を回すこと
- 計測の再現: 広島 `mock/` で `npx tsc --noEmit --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --lib ES2022,DOM,DOM.Iterable
  --moduleResolution bundler --module ESNext --verbatimModuleSyntax --isolatedModules --skipLibCheck --types node node_modules/@nanairo-sheet/{grid,react,server-hono}/src/index.ts`
- （spreadjs 側セッション）着手。ユーザーの実施指示を受けて Human Spec Gate の論点 1〜4 を推奨案で確定（決定事項 D1〜D4）。
  着手時点の計測は 38 件で、実行時の分岐が要る箇所は 0 件（決定事項の下の表）
- 並行セッション（DD-049 の alpha.6 配布）と作業ツリーを共有していた。alpha.6 の tarball（15:21:27〜45 生成・manifest `closureDirty: false`）は
  本DD の最初のソース編集（15:22:08）より前で、tarball 内に本DD の変更が無いことも確認した（`DD-050`・`omitUndefined` とも 0 件）
- 🔬 `npm run typecheck:consumer-strict` → 0 件。上の広島側の計測コマンドを spreadjs のソースへ当てても 0 件（`--target ES2022` を補う。
  TS 5.9 は省略時 ES5 で、反復・BigInt の別エラーになる）。`npm run typecheck`・`npm run lint`（boundary 新規違反 0）も green
- 🔬 AC3: `ConflictQueueEntry.code` を一時的に `?: RejectCode` へ戻すと、`npm run typecheck:consumer-strict` が TS2375 で exit 2（CI のステップが落ちる）。
  バックアップから同一内容（sha256 一致）へ戻し、再実行で exit 0
- 🔬 `npm test` 128 ファイル・1315 件 green。公開 .d.ts snapshot（`tests/contract`）は差分なし＝公開型は不変（AC4 の「拡張だけ」より強い「差分なし」）。
  CHANGELOG は Unreleased の Fixed に記載
- 😈 セルフレビュー: 追加した throw の呼び出し元は、`operationsMessage` が `missed.length > 0` の分岐内と `[outcome.envelope]`、`primaryRejectCode` が
  `violations.length > 0` の分岐内だけで、正常系・既存の異常系では空で呼ばれない。`reduceRight`・反転コピーは元のループと同じく末尾から適用する
- 🔬 E2E: playground 203 件・showcase 4 件 green（テストは無修正）。`bash scripts/doc-check.sh` OK
- Codex レビュー（medium・`--uncommitted`・`DD-050/codex-review-request.md` → `codex-review-result.md`）: 総評「マージ可」・findings 0 件。
  Codex 側でも差分を読み、厳格設定の型検査を実行して確認している。反映する修正なし
- DD-INDEX.md を再生成（起票時の申し送りを解消）。ステータスは確認待ち: コミットと、本DD を載せる配布の版の判断待ち
  （alpha.6 は DD-049 として引き渡し済みのため、載せるなら alpha.7 を想定）
- ユーザー指示「コミットして新しいターボールを生成してください」を受けて完了処理。実装をコミット（`d06975a`）→ 10 package と package-lock を
  `0.1.0-alpha.7` へ更新し CHANGELOG を確定（`882a56d`）→ `build-release.sh --out release/0.1.0-alpha.7`（gitDirty=false・closureDirty=false・unit 1,315 PASS）→
  verify-manifest／check-pack-contents（111 files）／`consumer-app.sh`（最終 tarball のみ・E2E 10/10）PASS → ZIP 化（350,358 bytes / 12 entries）。
  詳細は [validation.md](DD-050/validation.md)、引き渡しは [handoff.md](DD-050/handoff.md)
- tarball 実体の確認: 10 tarball の `src/`・`public/` 101 files を `882a56d` と照合して全一致。consumer-app に install した tarball 実体へ広島と同じフラグの
  tsc を当ててエラー 0 件（SDK ソース 93 files はすべて tarball の展開物から読み、リポジトリの packages/ は 0 files）
- 気付き: `build-release.sh` は closureDirty を冒頭で判定してから検証ゲート（数分）を挟んで pack するため、その間の packages/ の編集を検出できない
  （既知の未保証境界へ記載。改修は未着手）
- 完了時チェック: 知見を `doc/engineering-patterns.md` #23 へ昇格。本文と添付（Codex 依頼・結果・validation・handoff・release-manifest）を一緒にアーカイブし、
  DD-INDEX をスクリプト再生成、DOC-MAP に添付フォルダを追記
