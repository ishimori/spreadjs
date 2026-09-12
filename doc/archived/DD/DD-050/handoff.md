# DD-050 / alpha.7 引き渡し（広島空港 DD-005-3 向け）

## 配布物

- SDK 版: `0.1.0-alpha.7`、API 版: `0.1.0-experimental`（変更なし）。
- 配布ディレクトリ: `C:/repo/spreadjs/release/0.1.0-alpha.7/`（10 tarball＋`manifest.json`＋`README.md`）。
- 配布用 ZIP: `C:/repo/spreadjs/release/nanairo-sheet-0.1.0-alpha.7.zip`（350,358 bytes / 12 entries）。
  ZIP SHA-256: `c1f98424ea05ac5691083bfaa5154c6d7108279d4dedff677b2735a886199500`
- 実装コミット: `d06975a`、配布ソース: `882a56d`（版更新）。tarball の SHA-256・bytes は配布 manifest（[凍結コピー](release-manifest.json)）が正本。
- alpha.6 からの差分は DD-050 の修正だけ（公開 API・公開型の変更なし）。alpha.6 の口（`onAccepted`・`remote-change`・`presence`）はそのまま使える。
- npm registry への公開・GitHub への push・広島リポへの適用は未実施。

## 広島 要件メモとの対応

| 要件 | 対応 |
|---|---|
| H9 厳格な tsconfig での SDK 内の型エラー | `exactOptionalPropertyTypes`・`noUncheckedIndexedAccess` を有効にしても SDK ソースの型エラーは 0 件（軽い案＝ソースのまま直す）。spreadjs の CI（`npm run typecheck:consumer-strict`）で再発を防ぐ。ビルド済み .d.ts の配布（本命案）は DD-031 |

## 更新手順（広島メモ「持ち込み後の作業」）

1. `mock/vendor/nanairo-sheet/*.tgz` を alpha.7 の 10 tarball に差し替える（既存 vendor・lockfile は戻せる状態で保存）。
2. `mock/node_modules/@nanairo-sheet` と `mock/package-lock.json` を消して `npm --prefix mock install`。
3. `mock/scripts/typecheck.mjs` を実行し、「nanairo-sheet 内」の件数が 0 になることを確認する（DD-050 の受け入れ基準 5）。
   0 になったら、SDK 内のエラーを数えて build の失敗から除外している回避を外し、通常の型検査へ戻せるかを判断する。
4. 本番 build を通し、DD-005-3 に記録する。

## 制約

- 対象は上の 2 フラグ。他の厳格フラグ（`noPropertyAccessFromIndexSignature` 等）を有効にすると、SDK 内で型エラーになりうる。
- spreadjs 側の検査は TypeScript 5.9。広島の TypeScript の版が大きく違うと結果が一致しないことがある（計測コマンドを再現するときは `--target` を明示する）。
- react は、未指定の props を grid の mount オプションへ `undefined` のキーとして渡さず、キーごと省くようにした（grid 側の扱いは未指定と同じ）。

検証結果は [validation.md](validation.md)、Codex レビューは [依頼](codex-review-request.md)・[結果](codex-review-result.md)。
