# エンジニアリングパターン集

> プロジェクト横断で効く落とし穴（gotcha）と定石を集約する。DDアーカイブ時に
> 「この知見は半年後の別の作業でも効くか？」で判定し、効くものをここへ昇格させる。
> 詳細は元DDが正本。ここは「再発防止のための気づきポイント」。

## 昇格の基準

| 昇格する | 昇格しない（DD本体に残すだけでよい） |
|---------|----------------------------------|
| DAで見つかった「同根パターン」（同じ罠が複数箇所にある） | そのDD限りの一回性の問題 |
| 言語・フレームワークの仕様に起因する罠（再発確実） | 実装中に自然に気付くレベルの規約 |
| 「正しいやり方」が自明でなく、毎回調べ直しになる定石 | Lintルール化できたもの（→ `lint-fix-hints.json` へ） |

## 書き方

1パターン = 1セクション。「症状 → 原因 → 正しいやり方 → 元DD」を5〜10行で。
コード例は ❌/✅ の対比で最小限に。

---

## 1. ユニット緑でも DOM 配線・ブラウザー既定挙動の実行時バグは出る（dev目視/E2E で裏取り）

- **症状**: vitest（node）が全 green なのに、実ブラウザーで①ロード時に `ReferenceError`（アプリが起動しない）②セルをクリックしても入力できない（`activeElement=BODY`）等が起きる。
- **原因**: node のユニットテストは (a) モジュール初期化順序（構築中コールバックが未代入 `const` を参照する TDZ）、(b) 実 DOM のイベント既定動作（非フォーカス要素への `mousedown` が focus を body へ移す）、(c) 実ブラウザーの focus/描画経路を再現しない。純粋ロジックが緑でも配線層（`main.ts` 等）の実行時経路は未検証のまま。
- **正しいやり方**: Canvas/DOM を伴う実装は「ユニット緑」で止めず、**dev目視スモーク（Playwright MCP）か E2E（@playwright/test）で「ロード時 console error/未捕捉例外 0」「主要操作（クリック→打鍵で編集開始）が実際に動く」を必ず確認**し、見つけた実行時バグは E2E 回帰として固定する。**⚠️ E2E で `textarea.focus()` を明示的に呼んでから操作すると、クリック→focus 保持の経路をバイパスして本バグを隠す**。focus 依存の挙動（矢印キーのセル移動・scroll-follow 等）は**実クリック（`locator.click()`）から driving して検証**すること。
- **元DD**: DD-002（TDZ初期化・canvas mousedown の既定フォーカス移動の2件を dev目視で発見 → `e2e/regression.spec.ts` へ回帰化）／**DD-016-3 で再発**（DD-016-1 の Facade 化で統合ページの scroller `pointerdown` が `preventDefault` を失い focus 奪取が復活。E2E が `ta.focus()` を明示呼びするため見逃していた＝実クリック driving で発見・修正。あわせて scroll-follow 未実装も判明）

## 2. `git mv` は直前の未stage編集を巻き込まない（DDアーカイブで「クローズ内容の取りこぼし」が再発）

- **症状**: DDアーカイブでヘッダ表を「完了」に編集 → `git mv` → コミット、としたのにコミット内容は編集前（「確認待ち」のまま）。コミット後に同ファイルへ未stageの `M` が残る。
- **原因**: `git mv` はindexのエントリ（stage済みblob）をリネームするだけで、作業ツリーの未stage変更を再stageしない。「編集 → git mv → commit」の順だと編集分が index に乗らない（status の `RM` が兆候）。
- **正しいやり方**: `git mv` の**後に** `git add <移動先ファイル>` を明示実行してからコミットする（編集→mv→**add**→commit）。コミット直前の `git status --short` で `RM` が残っていないことを確認する。
- **元DD**: DD-002（5569375 で修正）→ DD-008 で再発（b2e8c69 で修正・本パターンに昇格）

## 3. Facade package に内部 glue を内包すると R7（内部型漏洩）検査は「公開エントリ限定」でないと誤検出する

- **症状**: Facade package（`grid` 等）に mount 配線 glue（`document-view`・`session-sync` 等）を内包した途端、boundary lint の R7 が glue の `export function f(v: CellScalar)`（内部 core 型）を大量に「公開シグネチャ漏洩」と誤検出（新規違反 43 件）。
- **原因**: R7 の意図は「**公開面**（package.json の `exports` が指す `src/index.ts`）が内部型を露出しない」。だが検査を **全 facade ファイル**へ適用すると、公開されない内部実装（glue）の export まで対象化する。glue は core/collab/render を束ねる責務ゆえ内部型を使うのが正当。
- **正しいやり方**: R7 は **公開エントリ（`packages/<facade>/src/index.ts`）のみ**に適用する（check.mjs で `rel === owner.root + '/src/index.ts'` に限定）。公開型は Facade 自身で定義し内部型を写像する（例 `SessionEvent`→`GridEvent`）。二重化として公開 `.d.ts` を emit し内部 package specifier 0 を contract test で検証。`test-support.ts` は TEST_INFRA_FILES で除外。
- **元DD**: DD-016-1（grid/server-hono Facade 実装）

## 4. Facade の実行時依存は `dependencies` に置く（workspace symlink がテストで隠し、pack install で露見）

- **症状**: Facade の全テストが green なのに、`npm pack` した tarball を独立 consumer へ install すると module 解決に失敗（`Cannot find module '@nanairo-sheet/render'` 等）。
- **原因**: 実行時 import する `@nanairo-sheet/*` を `devDependencies` に置くと `npm pack`→install で omit される。workspace ルートの symlink がテストでは解決を肩代わりするため問題が隠れる（Codex 指摘）。
- **正しいやり方**: Facade が**実行時 import** する内部 package は `dependencies` に置く（`test-support.ts` だけが使う collab 等は devDep のまま）。private 内部 package を registry 非経由で consumer へ届けるには bundle（`bundledDependencies`）or 全 package を pack して同梱する（**配布戦略は DD-017 で「全 9 package pack tarball＋sha256 manifest」に正式確定**〔`scripts/release/build-release.sh`・ADR-0015 Accepted〕・pack 実証＝DD-016-2）。
- **元DD**: DD-016-1（Codex xhigh P1-1）→ DD-017 で配布経路確定

## 5. Windows のドライブレター casing 差で vite `html-inline-proxy` がルート workspace 経由 build だけ決定的に失敗する（「間欠 flake」に見える）

- **症状**: ルートの `npm run build`（npm workspaces 経由）が `[vite:html-inline-proxy] Could not load ...?html-proxy&inline-css...`（`No matching HTML proxy module found`）で失敗するのに、`cd apps/<app> && npx vite build` は常に green。再現が実行経路に依存するため「間欠 flake」と誤認しやすい。
- **原因**: git-bash 既定の**小文字ドライブ `c:`** がシェル cwd 経由で vite の `config.root` に流れる一方、**rollup はエントリ id を大文字 `C:` に正規化**する。`html-inline-proxy` は inline `<style>` の仮想 CSS モジュールキーを `entryId.replace(config.root, '')` で計算するため、add 時（小文字）と load 時（大文字）でキーが食い違い解決不能になる。乱数性はなく **cwd の casing で決まる決定的バグ**（直接実行が green なのは `cd` が casing を再正準化するため）。
- **正しいやり方**: vite.config の build input を **`realpathSync.native` でディスク上の正準 casing に揃えた絶対パス**に固定する（全区間 casing＋symlink を正規化・POSIX では no-op）。「実行経路によって挙動が変わる build 失敗」を見たら乱数 flake と決めつけず、**cwd/env（特に Windows のドライブレター casing）の差分**を先に疑う。
- **元DD**: DD-017-1（probe プラグインで `config.root` とエラーパスの casing 食い違いを実測して確定・ルート build 連続 8/8 green で是正確認）

## 6. 命令的ライブラリを React でラップする「latest-ref」は render 中ではなく `useLayoutEffect` で更新する（Concurrent React で未 commit render が漏れる）

- **症状**: React Facade（`<NanairoSheetView>` 等）が最新 callback/props を `ref` に保持して非 remount で差し替える設計で、`startTransition`/Suspense を使う consumer だと、破棄された（未 commit の）render の callback が現行の命令的インスタンス（grid 等）に呼ばれる。例: 文書 B への遷移が保留中に、画面に残る文書 A の `cell-commit` が **B 用の onCellCommit** を呼び、A の編集を B へ保存し得る。
- **原因**: 「最新 ref」を **render 本体で `ref.current = props` 代入**すると、Concurrent React が投機的に準備して**commit しない**render でも共有 ref を上書きする。commit 済みの現行ツリーが持つ命令的リソースは、その汚れた ref を読む。
- **正しいやり方**: latest-ref の更新は **`useLayoutEffect`（commit 後に同期実行）** で行い、render では代入しない。commit された render の値だけが ref に載る。同様に、初期値系の「変更検知」は大きなデータの毎 render 直列化（`JSON.stringify`）を避け **参照比較（`Object.is`）** にする。命令的リソースへ渡す購読/診断 hook は「安定ラッパーが最新 ref を読む」形にし、購読は mount 時 1 本＋cleanup で解除（StrictMode の mount→cleanup→mount に耐える）。
  ```tsx
  // ❌ render 中に代入（未 commit render が漏れる）
  callbacksRef.current = { onCellCommit: props.onCellCommit };
  // ✅ commit 後に反映
  useLayoutEffect(() => { callbacksRef.current = { onCellCommit: props.onCellCommit }; });
  ```
- **元DD**: DD-025（React Facade。Codex[high] P1a/P1b で発見 → useLayoutEffect＋参照比較へ。将来の `@nanairo-sheet/element`・他フレームワークラッパーでも同型）

## 7. 挿入順 `JSON.stringify` の checksum は「キー順を保持しない保存先」（Postgres jsonb 等）で必ず壊れる

- **症状**: ファイルでは通っていた persisted snapshot の checksum 検証が、保存先を利用側 DB（jsonb）に差し替えた途端「checksum 不一致（破損の疑い）」で再起動 fail-fast する。データは壊れていない。
- **原因**: checksum の元文字列を `JSON.stringify(obj)`（プロパティ挿入順）で作っていた。jsonb はキーを長さ→バイト順に並べ替えて格納するため、往復すると同値 JSON でも文字列が変わる。同じ罠は「一度オブジェクトに展開して保存する」経路すべて（ORM の Json 型・別言語の dict）で再発する。
- **正しいやり方**: 保存先を跨ぐ checksum/hash は **正準直列化（全階層のキーを昇順・配列順は保持・undefined は省略）** で作る。既存フォーマットがあれば version を上げ、旧 version は旧算法で読む（読込互換のみ・書込は新算法）。テストは「キー順を逆にした JSON でも一致する」を固定する。
  ```ts
  // ❌ 挿入順依存
  sha256(JSON.stringify({ formatVersion, documentId, revision, createdAt, snapshot }));
  // ✅ 正準化（深いキー順ソート）
  sha256(canonicalJson({ formatVersion, documentId, revision, createdAt, snapshot }));
  ```
- **元DD**: DD-026-1（consumer の `sheet_snapshots.data jsonb` を成立させるため persisted snapshot format v2 へ。`packages/server/src/snapshot-store.ts`）

## 8. 「revision 0 ＝ 空文書」の暗黙前提は、状態を外部から供給した瞬間に破れる（bootstrap が送られない）

- **症状**: 初期文書を外部（DB）から revision 0 で供給すると、fresh join したクライアントが空グリッドのままになる。エラーは出ない（サーバーは非空・クライアントは空のまま「同期済み」）。
- **原因**: protocol の bootstrap 判定が `frontier > 0` を「送る価値がある＝非空」の代用にしていた（server `shouldBootstrap`・client `willReceiveBootstrap`・`handleBootstrap` の `revision <= committed` ガード）。空文書しか revision 0 に存在しない時代の前提が、初期文書の外部供給（oplog に載せない）で崩れた。
- **正しいやり方**: 「送る/受ける」の判定は **revision ではなく内容（文書が非空か）と受信状態（未 bootstrap か）** で行う。server は fresh join に対し非空なら bootstrap@0 を送り、client は committed 0 かつ未 bootstrap のときだけ受理する（重複は無視）。空文書@0 の挙動は不変にして後方互換テストを残す。外部供給した状態は oplog だけでは再構築できないため、**listen 前に snapshot@0 を durable 化**する。
- **元DD**: DD-026-1（`packages/server/src/room.ts`・`packages/collab/src/session.ts`。`restoreFrom` にも同じ潜在問題があった＝seed 済み snapshot しか使っていなかったため未露見）

<!-- 以降、パターンを追記していく。番号は通し番号 -->
