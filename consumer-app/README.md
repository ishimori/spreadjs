# consumer-app（独立 consumer 実アプリ相当）

> 設置: DD-016-2 Phase 3（要確認B 確定＝**リポジトリ内 `consumer-app/`**・npm workspaces 非登録＝boundary 検査対象外）。

Stage 1 SDK Alpha の公開 Facade（`@nanairo-sheet/grid`・`@nanairo-sheet/react`・`@nanairo-sheet/server-hono`）を、**monorepo の外にいる
利用者と同じ経路**（`npm pack` した tarball を install）で取り込み、**実挙動**（serve→mount→日本語入力→共同編集反映→
destroy→再mount で leak なし）まで実証する vanilla TS アプリ。

DD-047から罫線のReactサンプルも含む。`?borders&facade=grid|react&mode=standalone|collaboration`で4経路を確認する。
ホスト側の`react` / `react-dom`はconsumer自身の依存として同時に導入し、SDKのReact peerと同じruntimeを使う。

`consumer-harness/`（型疎通どまりの雛形）とは別物で、**実アプリ相当の実行**まで行う点が違う。

## S1-3（独立性）の担保

`bash scripts/consumer-app.sh` が以下を機械検査する（全て 0 でなければ FAIL）:

1. **内部パッケージ直接 import 禁止**（R1）: `@nanairo-sheet/{core,types,collab,server,render,selection,ime,formula}`。
2. **`@nanairo-sheet/*/test-support` import 禁止**（E2E introspection・非公開契約）。
3. **source path 直接参照 禁止**（`../../packages/...` 等）。
4. **workspace link 禁止**: `node_modules/@nanairo-sheet/*` が symlink なら FAIL（tarball 展開実体のみ許可）。
5. **未公開依存 0**: consumer-app/package.json は SDK/`file:`/`workspace:` 依存を宣言しない（tarball のみ）。
6. **workspaces 非登録**: ルート package.json の workspaces に含まれない。

さらに `scripts/consumer/check-closure.mjs` が、内部 package 相互の**実行時依存が dependencies に宣言済み**
（devDependencies に隠れて flat-install hoisting 頼みになっていない）ことを install 成否に依存せず静的検査する。

## pack 配布セット（要確認A=(a)・DD-044更新）

`@nanairo-sheet/*` は private・未 publish のため、Facade3（grid・react・server-hono）＋内部7（core・types・collab・render・
selection・ime・server）＝**10 tarball** を同時 install する（`doc/engineering-patterns.md` #4）。Reactはこのvanilla appでは
直接使わないが、React consumerを含む標準配布セットの欠落を検出するためinstall対象に含める。

## 実挙動 E2E（Phase 3・synthetic）

- **scenario.spec.ts**（AC1）: serve→2 client mount→日本語入力（synthetic composition）→共同編集反映（B の base canvas 変化）→
  connection/error イベント受信→destroy。
- **lifecycle.spec.ts**（AC2）: mount→destroy→再mount×5 で canvas/textarea/stage/WS/rAF/interval が解放され leak しないことを
  **公開 API＋外部計装のみ**で観測（test-support 不使用）。production `build`→`preview` 配信で dev artifact（HMR socket/interval）を排除して計測する。

> ⚠️ synthetic composition は実 IME 成立ではない。実 IME・確定 Enter 順 A/B・ブラウザー差の判定は **Phase 4 実機 Manual Gate**（CG-1）。

## 実行

```bash
bash scripts/consumer-app.sh   # closure 宣言検査→S1-3 検査→pack→install→tsc→server lifecycle→build→E2E
```

dev ツール（vite/tsx/playwright/tsc）はリポジトリルートの node_modules を流用し、`consumer-app/node_modules` には
SDK tarball のみを置く（SDK への依存面を Facade tarball だけに絞るため）。
