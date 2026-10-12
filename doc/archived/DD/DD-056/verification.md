# DD-056 検証記録（2026-10-12）

## 中断からの復旧

H12の修正2ファイルが失敗確認用にHEADへ戻された状態でSessionLimitに達した。ユーザーが示した退避先の
`mount-controller.ts`・`integration-editor.ts`を確認して復元し、`b4db4f7`にコミットした。
IME状態機械（packages/ime）は変更していない。

前セッションの引継ぎ証跡では、修正を戻すと新規E2E⑦〜⑪が各々redになった。これは本セッションで再実行した結果ではない。
本セッションでは復元後の全11件とReact1件がgreenであることを確認した。

| 回帰 | 修正前の引継ぎ結果 | 修正後 |
|---|---|---|
| ⑦ 切替後の別セル編集を送らない | 別セルにafter-lockの値が入った | PASS |
| ⑧ 候補クリックでdraftを失わない | 変換値が残らず空になった | PASS |
| ⑨ flushの呼出時の編集だけを確定 | 別セルの編集まで終了した | PASS |
| ⑩ 変換待ちのcutを止める | defaultPrevented=false | PASS |
| ⑪ stopped後の確定・未捕捉例外を防ぐ | ClientSession stopped例外でevaluate失敗 | PASS |

## 機械検証

| 範囲 | 結果 |
|---|---|
| 全workspace typecheck | PASS |
| consumer-strict（exactOptionalPropertyTypes・noUncheckedIndexedAccess） | PASS |
| lint＋境界検査 | PASS・新規違反0 |
| grid/react/server/server-hono unit | 68ファイル787件PASS |
| 全unit/invariants/contract（H13のレビュー修正を含む） | 135ファイル1441件PASS |
| H12・Reactの対象E2E | 12件PASS |
| 全playground E2E（サーバーを立ち上げ直して実行） | 初回249件PASS・5.2分、H13レビュー修正後も249件PASS・4.8分 |
| H13の公開型snapshot | メソッド2つの追加とimport・JSDocの同期。既存シグネチャの削除・変更なし |
| doc-check | PASS（親・子3件と添付のアーカイブ後にも確認済み） |

このWindows環境はNodeの最初のlistenに約10秒かかるため、unitは
`npm test -- --testTimeout=40000 --hookTimeout=40000`で実行した（DD-056-1で既存HEADにも同じ制約を確認済み）。
syntheticのgreenを実OS IMEの確認として扱わない。

## alpha.11（H11・H12）

- 生成コミット: `be4b938b2843450de2a8cbf092b8b5273778e5b6`。専用チェックアウトを作り、未コミットのH13を含めず生成した。
- 配布元はclosure宣言・typecheck・consumer-strict・lintと全unit133ファイル1421件PASS。
- 上記ゲートを別途通したため、`build-release.sh --skip-verify --out C:/repo/spreadjs/release/0.1.0-alpha.11`でpackした。
- 10tarball・114files、テスト/spec・monorepo tsconfig混入なし、全entrypointあり。manifestのclosureDirty=false。
  gitDirty=trueはsnapshotファイルの改行正規化だけ（git diffに内容差分なし・closure外）。
- SHA-256同一性検査PASS。実tarballを独立consumerへinstallし、型検査・server lifecycle・production build・E2E10件PASS。
- ZIP: `C:/repo/spreadjs/release/nanairo-sheet-0.1.0-alpha.11.zip`（12entries＝10tarball・manifest・README）。
- 配布・unit・consumerのログは`release/dd056-alpha11-*.log`。専用チェックアウトの成果物はこのroot releaseへ保存し、作業用worktreeはアーカイブする。

## alpha.12（H11〜H13）

- 実装 `31b0f16` のxhighレビュー3件（P1×1・P2×2）は全採用。診断後の撤去・接続メタの再確認、復旧callback前の追加追跡、close失敗後の後始末保持と再試行を `68d377c` で修正した。
- 回帰5件は修正前にred、修正後にgreen。最終の全workspace typecheck・consumer-strict・lint・unit135ファイル1441件・全playground E2E249件PASS。
- `68d377c` から10tarball＋manifestを再生成（前の候補を置き換えた）。全ゲートを別途検証済みのためpackは `--skip-verify`。closureDirty=false、gitDirty=trueは完了記録等のclosure外の差分だけ。
- pack内容検査は10tarball・114files PASS。SHA-256同一性検査PASS。tarballのserver.ts・persistent-room.tsは修正済みソースと一致することを内容比較で確認した。
- 最終tarballを独立consumerへinstallし、型検査・server lifecycle・production build・E2E10件PASS（48.8秒）。独立consumer-harnessもfresh pack→install→tsc PASS。
- ZIP: `C:/repo/spreadjs/release/nanairo-sheet-0.1.0-alpha.12.zip`（12entries・388,058 bytes）。alpha.11のZIPは383,060 bytes。
- 再生成・最終unit/typecheck/E2E・consumer/harnessのログは`release/dd056-*.log`。レビュー生ログは削除し、依頼と結果のみDD添付に保存した。

## 受け入れ基準の照合（親DD）

| AC | 根拠 |
|---|---|
| 1〜4 H11 | sequencer・Room・serve.authorizeのunitと実WS、2ブラウザーauthorize-operation E2E。拒否の巻戻し・revision/oplog非進行・復帰・throw/thenable・再送・サーバー起点操作を確認 |
| 5・6 H12 | readonly-switch-flush E2E11件・ime-editing-session・flush-state unit。編集保持・変換待ち・候補/cut遮断・対象追跡・timeout/stopped |
| 7 React | nanairo-sheet-view.dd056 unit5件・react-facade-readonly E2E。readOnly変更で開き直さず、他の識別系は従来どおり |
| 8 H13 | lifecycle unit11件・bridge8件、PersistentRoom unit。追加・撤去・収束・再送拒否・保存/通知の完了待ち・復旧・callback再入・close失敗 |
| 9 回帰 | 最終unit1441件・playground E2E249件・型検査・consumer-strict・lint。公開シグネチャは追加のみ（JSDocも同期） |
| 10 文書 | JSDoc・CHANGELOG・quick-start・features.json・stage2-backlog §3.7・公開コード一覧・ADR-0025を同期。handoffを作成 |

## 未確認範囲

- 実機Microsoft IME×ChromeのT1は未実施。変換確定直後のflush・setReadOnly・セル内外クリックの実機確認はDD-056-2の未保証境界とIME台帳へ記録した。
- 広島空港consumerへの取り込み・予算業務シナリオ・実画面・商談受入は未実施。handoff.mdを引き渡しに使う。
- Git push・registry publishは実施していない。配布はローカルのpack closure方式。
