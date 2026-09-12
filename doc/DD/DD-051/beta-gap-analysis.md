# DD-051 Beta ゲートの現状評価（2026-09-12 時点）

> 起票時点の調査結果。判断は DD-051 本文の論点表で行う。数値・状況は 2026-09-12 に各リポジトリを読んだ結果。

## 1. ゲート策定時の想定と実態

| 観点 | 策定時の想定（DD-023・2026-07-16。憲章 §15/§16.1/§23） | 2026-09-12 の実態 |
|---|---|---|
| 開発体制 | 役割 8 種の分担（憲章 §23）。計画書は人月で見積もり | SDK と consumer を同じ 1 人＋AI エージェントが開発 |
| consumer | 別チームの社内アプリ（housing-e-kintai-next・ReadyCrew） | 松下 生産納期・広島空港。どちらも商談用デモ（松下は初回商談の議事録、広島 DD-005 は「初回商談の山場」） |
| 統合の速さ | KPI-5「基本業務入力画面の初期統合を 2 開発日以内」 | 広島 DD-005：起票 13:05 → 共同編集の実装＋E2E 14:05 → レビュー反映・完了 14:27（同日） |
| SDK の伝達経路 | docs site・サンプル・API リファレンス（憲章 §17） | CHANGELOG・quick-start・引き渡し文書・tarball 同梱のソースを AI が読む（広島要件メモの「現状」欄は CHANGELOG と `packages/*/src` を読んで作成） |

## 2. S2 ゲートと憲章 §26.3 の充足状況

| # | 条件 | 状況 | 残り |
|---|---|---|---|
| S2-1 | 2 つ以上の社内アプリで利用 | 松下で成立（DD-026）。2 件目の ReadyCrew（DD-030）は未着手で、`ready_crew_db` は SDK 未使用・最終コミット 2026-08-28。広島空港は 2026-09-12 に共同編集で統合済み（alpha.7 の取り込み待ち） | 2 件目の確定（論点 3） |
| S2-2 | 内部 import なし | boundary lint 常設で成立。ただし広島の E2E が grid の test-support（非公開契約）を import している | 論点 5 |
| S2-3 | API 差分監視と移行ガイド | DD-028 で成立（型 snapshot・migration dry-run） | なし |
| S2-4 | ブラウザー／IME 回帰の継続実行 | CI 常設（直近 success 2026-09-07）。実 IME 記録は台帳上すべて Microsoft IME | Beta リリースゲート T2（論点 1 で Microsoft IME のみに） |
| S2-5 | Testkit・診断ログ・サンプル | 診断フック（grid / server-hono の onDiagnostic）・エラーコード一覧（DD-017）・quick-start・紹介サイトあり。Testkit・構造化ログ・trace export・docs site は未着手（DD-029-2〜4） | 論点 5〜8 |
| S2-6 | Plugin/Adapter 境界の実案件検証 | 松下でストア注入・認証フック・サーバー起点操作・列タイプを配線。広島で onAccepted | 2 件目での検証（論点 3） |
| §26.3 | 社内 Beta までの製品化作業 | migration guide・deprecation policy・API 差分監視は済。bundle size budget・docs site・利用状況と統合工数の計測が未 | 論点 7〜9 |

## 3. 項目別の所見

### 3.1 Tier 1 IME（論点 1）

- 憲章 §20.2 は「初期候補」として Tier 1 に Microsoft IME と Google 日本語入力を挙げる。出所は計画書 §11.8 のテストマトリクス（同じ表の Firefox・macOS は既に対象外）。
- DD-002 で両 IME を対象にすることをユーザーが合意（2026-07-11）。2026-07-12 の Phase 6 で 4 環境合格。ただし申告ベースで、確定 Enter の順序 A/B は未記録・トレース未保存。
- DD-028 の Codex P2-2「宣言済みの IME が未検証のまま通過し得る」を受け、T1=Microsoft IME、T2=両 IME 必須とした。指摘は宣言と検証の不整合で、Google 日本語入力固有の不具合ではない。
- 以後の実 IME 記録は台帳上 10 DD 分で、すべて Microsoft IME。Google 日本語入力は開発 PC に未導入。
- consumer 向けの約束（quick-start）は「Windows Chrome / Edge」のみで、IME の種類を約束していない。
- エディターは `textarea.value` を確定値の正とし `keyCode` に依存しない（計画書 §11.5）。IME の種類に依存しない設計。
- 未確認: 松下・広島空港の業務利用者が使う IME。

### 3.2 Testkit（論点 5）

- grid の `./test-support` は package exports に載り tarball に同梱されるが、ファイル冒頭で「公開 API ではない」と宣言している。`scripts/consumer-app.sh` は consumer からの import を S1-3 不合格とする。
- 広島 `mock/src/coedit/SheetGrid.tsx` が `getDebugApi` を import し、`window.__coeditDebug` 経由で E2E（`mock/e2e/coedit.spec.ts`）がセル値・参加者一覧・未送信数を読む。React の handle が GridInstance を出さないための回り道。
- 松下には常設 E2E がない。エージェントが API の fetch とスクリーンショットで確認している（`.playwright-mcp/dd021-*.js.txt`）。

### 3.3 診断（論点 6）

- 既存: grid / server-hono の onDiagnostic、`doc/archived/DD/DD-017/error-codes.md`。
- 松下の診断系要望は具体的な口だった（DD-012 U6 poison の観測口、DD-014 D3 起動時検疫の警告、DD-016 P3 拒否理由の詳細）。汎用の構造化ログ・trace export の要望はない。
- 憲章 §17.1「機密セル値を出さない構造化ログ」は信頼境界に関わるため、診断メッセージへの混入点検だけは Beta 前に価値がある。

### 3.4 docs site（論点 7）

- 既存: `apps/showcase`（機能カタログ＋動作デモ）、`doc/quick-start.md`、各 DD の引き渡し文書。

### 3.5 KPI（論点 8）

- `doc/plan/kpi-ledger.md` §3.1 の実データは 1 行（KPI-4 松下＝採取不能）。KPI-1/5 は松下側 DD-012-2 で採取予定だったが、松下リポジトリに記録がない。
- 広島は SDK の初回導入で KPI-4/5 の対象だったが未採取。
- §3.4 consumer フィードバック欄は空。実質の記録は各 consumer の要件メモ（松下 DD-012/014/016/020、広島 DD-005 の `sdk-requirements.md`）。
- 台帳 §4-2 は「目標未達は Beta 宣言のブロッカーにしない。判定するのは計測・記録の実施」。

### 3.6 配布昇格 DD-031（論点 9）

- 憲章 §26.3（社内 Beta まで）に registry 昇格・dist 切替・リポジトリ名変更はない。Package registry とアクセス管理は Stage 4 の移行条件（§15）。
- P-06 versioning の期限は「Stage 2 前」、bundle size budget は §26.3。
- P-14 リネームはローカルパス・スクリプト・並行セッションへ波及する（roadmap §5）。

### 3.7 Beta 宣言の効果（論点 2）

- `doc/product/deprecation-policy.md` §2: Beta 以降、公開 Facade API の削除・非互換変更は「1 minor 共存・30 日・統合済み全 consumer の移行確認」の全充足後のみ。
- consumer は全て同一開発者のリポジトリで、現時点でこの約束の受益者はいない。
