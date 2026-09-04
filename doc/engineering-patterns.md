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

## 9. 実 IME・実 Excel の Manual Gate は OS レベル自動化で代行できる（「実物が動いた」証明とセットで）

- **症状**: 実 IME（Microsoft IME）の Manual Gate は「Playwright/CDP は OS IME を通せない」ため人手に残り続ける（synthetic composition は実 IME ではない＝台帳の区別必須）。実 Excel round-trip も同様。
- **原因**: CDP のキー入力・`WScript SendKeys`（Unicode 直接挿入）は OS 入力キュー→IME 変換パイプラインをバイパスする。
- **正しいやり方**: user32 `SendInput` を **`KEYEVENTF_SCANCODE`**（拡張キーは `+EXTENDEDKEY`）で送ると OS 入力キュー→**実 IME** を通る。ローマ字スキャンコードを送り、**ページ側の `isComposing`/draft/変換候補の観測で「実 IME の composition が実際に起きた」ことを証明してから**判定する（証明できなければ実機扱いにしない）。IME ON は Zenkaku/Hankaku（scan 0x29）トグル＋composition 検知のリトライで確立。前面化に Alt 空打ちを使うと Chrome のメニューバーへフォーカスが移る副作用がある（SetForegroundWindow 後は ESC＋ページ実クリックでフォーカスを戻し、到達観測してから送信する。DD-033 T1 代行の実例）。観測した順序A/B が既存実機知見と一致することも実起動の裏付けになる。**実機固有挙動に注意**: MS-IME は変換中の Ctrl 押下で変換を**自己確定**する（synthetic の期待をそのまま assert すると偽陰性になる）。実 Excel は COM 自動化（`Range.Copy`/`Paste`）で「実 Excel が書く実ペイロード」を使えるが、**クリップボードの stale 内容による偽合格**（コピー元アプリのデータがそのまま貼り戻る循環）を防ぐため、被験システムの出力にしか現れない証拠（例: グリッドの正準化日付 `2026-07-17` vs Excel の `2026/7/17`）で真正性を検査する。代行した事実と方式は DD・台帳に「実IME（自動駆動・代行）」と明記し、人手目視と混同させない。
- **元DD**: DD-020 Manual Gate M1〜M3・DD-021 M1〜M2＋ime-manual-gate-ledger 5点（2026-07-17・ユーザー指示による Claude 代行）

## 10. 共有 collab 文書を変更する E2E は「使ったら元に戻す（net-zero）」— さもないと後続 spec を決定的に汚染する

- **症状**: 個別 spec は単独 green なのに、`npm run test:e2e`（全スイート連結）だと後続の多数 spec が `openClient` の行数ゲート（`rowCount >= 50000`）で `Received: 49999` で落ちる／リンク列 spec の「クリック→link-open」が発火しないなど、**先行 spec に依存した決定的失敗**が出る（単独再実行では passing なので「flake」と誤認しやすい）。
- **原因**: playground/showcase の E2E は 1 つの **server-hono の共有 collab 文書**（50,000 行シード）へ全 spec がぶら下がる。ある spec が `deleteRows`（行数が 50000→49999 に減ったまま）や `seed（cell 値を残置）` して**元に戻さない**と、その変更が文書に残り、後続 spec の前提（初期状態）を崩す。行数ゲートだけでなく「あるセルが空である前提」も崩れる（例: 先行 spec が (8,4) に値を残す → 後続のリンク列 spec が (8,4) を選択した瞬間に link-open が誘発され、synthetic 環境の二度押しガードで本命クリックが抑止される）。webServer は reuse されるため、汚染は同一 run 内の後続へ波及する。
- **正しいやり方**: 共有文書を構造変更（insert/delete 行）または特定セルを seed する spec は、**その spec 内で net-zero に戻す**。行削除したら `insertRows` で本数を戻し、seed したセルは `finally` で `clearCell` する（`expect.poll` で復元を確認してから context.close）。構造を大量に変える spec はさらに `zz-` prefix でスイート最後に隔離する（DD-021 教訓#3）。**「単独 green・連結で赤」を見たら flake と決めつけず、先行 spec の共有文書残置を疑う**（最初に落ちる spec ではなく、汚染した spec を特定する）。
- **元DD**: DD-027（親 Phase 4 統合検証で発覚。DD-027-1 の行削除テストを `insertRows` 復元・DD-027-3 の書式 seed セルを `clearCell` 後始末して 98/98 green 化。DD-021 教訓#3 の再確認）

## 11. 同一作業ツリーで並行セッションが動いている間は `git commit` を必ずパス指定で行う（共有 index 経由で他者の WIP を巻き込む）

- **症状**: 自分は `git add <自ファイル>` しかしていないのに、コミットに他セッションの WIP が大量混入する（例: 2ファイルのつもりが 49 ファイル・5,201 行）。コミットメッセージと内容が食い違い、並行作業者の成果が誤ったメッセージの下に入る。
- **原因**: `git commit`（パス指定なし）は**その時点の index 全体**をコミットする。index は作業ツリーで唯一の共有資源のため、2つのコミットの間に並行セッションが `git add` すると、自分のステージ内容に他者分が合成される。自分の add 操作が正しくても防げない。
- **正しいやり方**: 並行セッションの存在が疑われる間は `git commit -- <パス...>` で**コミット対象を明示**する（named-path commit は index の他エントリを無視する）。誤混入に気づいたら未 push なら `git reset --soft HEAD~1` → パス指定で再コミット（他者のステージ状態は保存される）。コミット直後の `--stat` でファイル数が想定と一致するかを毎回確認する。
- **元DD**: DD-020 起票時のスクショ誤混入（869dc21 で追跡除外）→ DD-034 で再発（reset --soft＋パス指定コミットで是正・本パターンへ昇格）

## 12. 「次フレームまで保留」する命令 API は、保留中に届く利用者入力が**旧状態**で処理される（同期 flush か入力遮断で塞ぐ）

- **症状**: `insertRows()` → `setActiveCell(newRowId)` を連続で呼ぶ UI（「行を追加」ボタン）で、直後の打鍵が**旧アクティブセル**へ確定する。E2E では稀に 1 回だけ再現し、単独再実行では通る（「flake」に見える）。
- **原因**: 構造変更（行挿入・setData）直後は行 Axis が未再構築のため、RowId→index を解決する命令を「次の rAF の構造 flush 後」に保留する設計にしていた。しかし常駐 textarea は旧セルにフォーカスしたままなので、保留の 1 フレーム（〜16ms）の間に届いた input が旧セルで BeginEdit し、保留命令の `pointerdownCell` がその draft を旧セルへ確定してから移動する。
- **正しいやり方**: 命令が「今の状態では解決できない」なら**その場で状態を進める**（構造 flush を同期実行してから適用＝呼び出しから戻った時点で成立）。同期実行できない区間（初回描画前など）が残るなら、その間は**入力を遮断**する（`isInputLocked` 相当）。「保留して後で適用」は、間に利用者入力が割り込める経路がないか必ず確認する。稀な E2E 失敗を「flake」で片付けず、フレーム境界の競合を疑う（Codex の指摘で確定）。
- **元DD**: DD-035 R6（Codex high P1・`flushStructural` の同期実行＋保留中 `isInputLocked`）

## 13. 区切り文字のつもりの制御文字がソースへ**生バイト**で入ると、grep が binary 扱いになり Edit も当たらなくなる

- **症状**: `grep -A` の出力から特定の 1 行だけが消え、末尾に `binary file matches (found "\0" byte around offset …)` が出る。その行を対象にした Edit は `String to replace not found` で失敗し続ける（画面上は正しく見えている）。
- **原因**: キャッシュキー等で `` `${a}\u0000${b}` `` のような区切りを書くつもりが、**エスケープ表記ではなく生の U+0000 そのもの**がファイルへ書き込まれていた。JS の文字列としては有効なので typecheck・lint・テストは全て通り、ツール側の表示でも見えないため気付けない。
- **正しいやり方**: ソースに書く制御文字は必ずエスケープ表記（`\u0000` の 6 文字）にする。混入を疑ったら `grep` の binary 警告を手掛かりにし、**是正はスクリプト経由で行う**（生の制御文字はツール入力のバリデーションで弾かれ、Edit の `old_string` にも書けない。`String.fromCharCode(0)` で構成した Node スクリプトで置換する）。区切りが本当に必要かも再検討する（多くの場合は普通の文字で足りる）。
- **元DD**: DD-037（suggest モードの絞り込みキャッシュキー。セルフレビューの grep で発覚）

## 14. 同期発火するイベントの購読者は公開 API を呼び返せる — view-local な状態遷移は**発火より前**に完了させる

- **症状**: SDK 内部の処理が「書き込み → イベント発火 → 内部状態の後始末」の順で書かれていると、購読者がそのイベントハンドラから公開 API を呼んだ場合に、**後始末が利用側の変更を上書きする**。文書を差し替える API（`setData` 等）を呼ばれた場合は、後始末が**更新前の index／Axis** を前提に動いてさらに壊れる。
- **原因**: イベントが非同期（次tick）だという思い込み。単独モードの `submitLocalOperation` は適用と同じ同期スタックで `cell-commit` を呼ぶため、`submit()` から戻った時点で利用側のコードが既に走り終えている。共同編集でも pending 通知で同型の再入が起きうる。テストは購読者を持たないか、持っても副作用を起こさないので緑のまま。
- **正しいやり方**: **利用者から見える状態（選択・アクティブセル・スクロール）の遷移は、イベントを発火させる書き込みより前に済ませる**。そうすれば「最後に書いた購読者が勝つ」という自然な意味になり、状態のスナップショット比較（「submit 中に変わっていたら諦める」）という機構を増やさずに済む。回帰テストは「イベントハンドラから公開 API を呼ぶ購読者」を仕込んで、その指定が残ることを検証する。
- **元DD**: DD-038（貼り付け後の選択レンジ。`selectPastedRect` を `submitSetCells` の後→前へ移動。Codex レビュー P2）

## 15. Canvas グリッドの E2E は「セルが実際に可視か」で結果が変わる — 座標系とハーネスの大きさを先に決める

- **症状**: 特定の行・列を対象にした E2E だけが落ちる／固まる。しかも失敗が**テストタイムアウト**として出るため、原因が実装なのかテストなのか切り分けられない。
- **原因**: 2つある。(a) `cellRectAt`（debug API）が返すのは**スクローラー要素の内部座標**で、`page.mouse` の**ビューポート絶対座標**とは見出しの高さ分ずれる。(b) `selectCell` / `cellRectAt` は**スクロールしない**ため、可視域外のセルを指定するとクリックが手前のセルへ落ちる。**どちらも例外にならず**、後続の `expect.poll` が永久に一致しない＝タイムアウトに化ける。
- **正しいやり方**: マウス座標は必ず `scroller.boundingBox()` を足して換算する（既存の `integration-helpers.cellCenter` が正典。自作しない）。**端（最下行・右端列）や境界を検証するテストは、行数・列数の小さいハーネスへ寄せる**（本リポジトリなら 50,000 行の統合モードではなく `standalone.html?seedrows=15`）。統合ハーネスの初期可視はおよそ 29 行しかない。加えて、2 ブラウザーコンテキストでは OS フォーカスを持てるページが 1 つだけなので `navigator.clipboard.readText()` が解決せず固まる — 複数クライアントの検証は合成 `ClipboardEvent` を使う。
- **元DD**: DD-038（`paste-selection.spec.ts` を単独ハーネスで新設。E2E の失敗3件はいずれも実装ではなくテスト側の原因だった）

## 16. 許可リストで「監視対象」を列挙する仕組みは、対象が消えたことを検知できない（存在確認をセットで置く）

- **症状**: 監視・検査の対象をパスや名前の配列で列挙している仕組みが、対象のリネーム・移動後も**エラーを出さずに通り続ける**。壊れていないように見えて、実は何も見ていない（偽陰性）。
- **原因**: 列挙側の API が「存在しない対象」を異常として扱わない。`git status --porcelain -- <存在しないパス>` は**エラーにならず exit 0 で空を返す**（実測）ため、`tsconfig.base.json` を改名しただけで監視から黙って外れ、汚れていても「clean」と判定される。
- **正しいやり方**: 許可リストを持つなら**各エントリの存在確認を必ずセットにする**（無ければ WARN）。対照的に、対象が消えたら**必ず落ちる**書き方なら確認は要らない（同スクリプトの `CLOSURE_PKGS` は tarball 名の完全一致で探すため、package を改名すると `tarball not found` で止まる＝安全側）。「消えたら落ちるか、消えたら黙るか」で許可リストを分類し、黙る側にだけ番人を置く。
- **元DD**: DD-040（`build-release.sh` の `CLOSURE_PATHSPEC`。セルフレビューで発見）

## 17. 「pane ごとに clip する」を描画の一部にだけ適用すると、overscan と境界にかかる要素で必ず漏れる

- **症状**: 固定行列（frozen pane）を使って横／縦スクロールすると、**固定ペインの上にスクロール側の要素が重なって描かれる**。セル本体は正しいのに、ヘッダーや overlay だけが壊れる。しかも既定値が小さい（固定 1 行 1 列・見出しは 1 文字）と何年も表面化しない。
- **原因**: 「pane ごとの clip」を `drawPane` にだけ実装し、ヘッダー帯・overlay を **1 枚の広い clip**（帯全体／ヘッダーを除く全セル領域）で描いていた。可視範囲の計算は `indexAt(frozenSize + scroll - overscan)` から始まるため、スクロール側の範囲には**固定境界に半分かかる要素**と**overscan 分の要素**が必ず入る。それらの viewport 座標（`offsetOf(i) - scroll`）は固定帯の内側に落ちるので、広い clip では素通りして上書きになる。**「範囲を絞れば座標は帯の外に出るはず」という思い込みが成立しない**のが肝。
- **正しいやり方**: 固定/スクロールの**両方の要素を描くコードは、例外なく pane 境界で clip を分ける**。既存の帯 clip は残したまま**内側に入れ子 clip** を張ると、背景・枠線・コーナーの描画列を動かさずに済み「修正前と同一」を差分の構造で担保できる（入れ子＝交差なので帯からはみ出さない）。固定サイズが 0 のときは入れ子を張らない分岐を 1 つ置く。新しい描画を足すときは「この描画は固定側とスクロール側の両方を描くか？」を先に自問する。
- **落とし穴（DD-041）**: pane 帰属を**可視 index 範囲**で決めると、範囲外の要素は「1 つも描かない」になる。ここで
  「交差が 0 個なら従来の広い clip で描く」フォールバックを足したくなるが、**`overscanX < frozenWidth` のとき
  （固定 4 列以上で成立する）はみ出しがそのまま復活する**。範囲外のスクロール列の viewport 座標が固定帯の内側へ
  落ちるのは、まさに範囲の外側でこそ起きるため。救済するなら pane 帰属を幾何で判定するしかなく、pane 判定の
  二重持ちに戻る。**素直に「範囲外は描かない」で確定し、欠ける端（例: セルは範囲外だが真上のタグが viewport に
  掛かる数 px）は既知の境界として DD へ残す**のが正解
- **元DD**: DD-039（`base-layer.ts drawHeaders` の列記号帯・行番号帯）。**同根が overlay にも実在**し、Presence の activeCell 枠・名前タグは DD-041 で対応（選択枠・ドラッグ枠は `rangePiecesAcrossPanes` を使っていて無事だった＝同じファイル内でも適用漏れは起きる）

## 18. 後追いで書いた回帰テストは「修正前のコードのコピー」に当てて red を確認する（Canvas 等、assert が空振りしやすい領域では必須）

- **症状**: バグを直した**後**に書いた回帰テストが緑になる。だが、そのテストが本当にバグを検出できるのか誰も確かめていない。Canvas 描画・ピクセル比較・スパイの記録検証は、対象領域や記録項目を 1 つ間違えるだけで**何も見ていないのに緑**になる（偽陰性）。
- **原因**: TDD なら red → green の順で自動的に担保されることが、バグ修正の後追いテストでは抜け落ちる。とくに ctx スタブは「記録していない呼び出し」を黙って捨てるため、検証したい情報（どの clip の内側で描かれたか等）を記録し損ねても失敗しない。
- **正しいやり方**: 修正前の実装を `git show HEAD:path/to/impl.ts > path/to/impl-baseline.tmp.ts` で**同じディレクトリへ**コピーし（相対 import がそのまま解決する）、テストのコピーの import 先を sed で差し替えて実行 → **落ちること**を確認してから両方消す。E2E は実装ファイルを一時的に `git show HEAD:` で上書きして走らせ、退避しておいたコピーで復元する（実行後に `diff -q` で同一性を確認）。加えてテスト側に「バグの前提条件が実在すること」（例: 固定帯の内側に落ちるスクロール列が実際にある）を assert しておくと、シナリオが将来ずれて空振りに戻るのを防げる。
- **元DD**: DD-039（unit 3/4・E2E 2/2 が修正前コードで fail することを実証。「固定 0 なら現行と同一」の 1 件だけは修正前後とも pass ＝ その AC の意味どおり）

## 19. 宛先・身元のような「サーバーが権威を持つフィールド」は握手だけでなく**毎メッセージ**検証する

- **症状**: 接続時（handshake / join）に申告値を検証しているので安心していると、**確立後のメッセージが別の宛先を名乗って**素通りする。その場では動いてしまい、壊れるのは**次回起動の復旧時**（保存済みログの整合検査で全件突き合わせが失敗し、その文書・その集約が丸ごと立ち上がらない）。時間差があるため、原因の特定が極端に難しい。
- **原因**: ルーティング（どの部屋へ届けるか）は接続時に確定するのに、**記録される値**（envelope の documentId 等）は毎メッセージ運ばれてくる。中核ロジック（Room / Sequencer）は「自分がどの文書か」を持たない設計なので、申告値をそのまま記録してしまう。認証済み identity を毎メッセージ上書きする経路が既にあっても、宛先フィールドが同じ扱いになっているとは限らない。
- **正しいやり方**: **記録・永続化される申告フィールドは、ルーティングの結果を正として毎メッセージ照合する**。厳しくできる経路（新機能・明示指定）は不一致で切断し、後方互換を守りたい既存経路は**サーバー値へ正規化して受理**する（受理挙動を変えずに汚染だけ塞ぐ）。警告診断は接続あたり 1 回に絞る（毎 op 出すと診断が溢れる）。設計時の自問は「**この申告値は保存されるか？　保存されるなら、握手の 1 回だけで守れているか？**」。
- **元DD**: DD-043（`/ws?documentId=` で宛先を決める複数文書 serve。join だけ検証していたため、正しく join した接続が後から別文書 ID の envelope を送ると oplog が汚染され、次回起動で当該文書が検疫される経路が残っていた。Codex レビュー P1 で発覚）

## 20. 後始末のループは 1 件の失敗で打ち切らない（残りのリソースが閉じ残り、外側の teardown まで巻き添えになる）

- **症状**: 停止処理が例外で終わり、**プロセスが終了しない／ポートが解放されない**。単体だったものを N 個に増やした瞬間に顕在化する（1 個のときは「失敗したら諦める」で実害が見えなかった）。
- **原因**: `for (const x of xs) await x.close()` は最初の reject でループごと抜ける。後続リソースはもちろん、その後に続く外側の後始末（socket 破棄・server.close）も実行されない。閉じる対象が**利用側から注入された実装**（consumer の DB ハンドル等）なら、close が失敗するのは異常系ではなく想定内。
- **正しいやり方**: 後始末は**全件試行してから失敗をまとめて報告**する（`failures.push(...)` → 最後に 1 つの Error）。外側の teardown は失敗を変数に退避して**最後まで進めてから** rethrow する。起動途中の失敗経路では、後始末の失敗で**元の失敗を隠さない**（記録だけして元の例外を投げる）。
- **元DD**: DD-043（複数文書 serve で `closeRuntimes` が 1 文書目の close 失敗で中断し、残りの文書・認証待ち socket・ws・http server が閉じ残っていた。Codex レビュー P1 で発覚）

<!-- 以降、パターンを追記していく。番号は通し番号 -->
