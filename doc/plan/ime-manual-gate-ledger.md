# 実機 IME 実行記録台帳（Tier 1 Manual Gate・S2-4 後半）

> **正本**: Tier 1（Win Chrome/Edge×日本語IME）**実機 IME 実行**の変更トリガー定義・最小シナリオ・実行記録の常設台帳
> （cg-ledger / kpi-ledger の先例に倣う。起票: DD-028・2026-07-16）。
> 憲章 §15 S2-4「主要ブラウザー/IME 回帰が継続実行される」のうち、**CI が代弁できない実IME 部分**の担保。
> CI（`.github/workflows/ci.yml`・DD-028）の E2E は synthetic composition であり**実IME ではない** —
> **synthetic と実IME を混同しない**（Stage 1 §2.3 継承・DD-012-1 CG-1 の教訓）。DD-032（Stage 2 移行判定）が
> S2-4 判定時に本台帳の履歴を一括参照する。

## 1. 実行トリガー定義（いつ実機 IME を実行するか）

| # | トリガー | 義務 | 実行タイミング |
|---|---|---|---|
| **T1** | **IME 経路の変更**: IME 状態機械・常駐 textarea・focus/selection 管理・composition イベント処理・確定値の commit-bridge 経路のいずれかを変更した DD | **推奨（DDのクローズはブロックしない）** | 実施できるなら当該 DD の作業中に（IME=Microsoft IME 最小必須〔§2〕・正味目安 5〜10分）。**未実施でも DD はクローズしてよい**＝`dd-risk-class-header.md`「Manual Gate の扱い」。未実施なら §3 に「未実施」行を残し、DD の `## 既知の未保証境界` へ1行移送する |
| **T2** | **Beta リリースゲート**: DD-031（配布昇格）前・DD-032（Stage 2 移行判定）前 | **必須（ブロックする）** | 各1回（変更が無くても実行し、判定時点の実機証拠を確保する。**IME 2種必須**=Microsoft IME＋Google 日本語入力〔§2〕）。T1 を非ブロッキングにしたぶんの実機カバレッジは、ここで必ず回収する |
| **T3** | Tier 1 ブラウザー（Chrome/Edge）のメジャー更新を検知した時 | 任意（推奨） | 更新後の作業の任意タイミング（順序A/B の観測が変わりうるため記録価値が高い） |

- トリガー判定は DD 起票時の Risk Triggers 欄で行う（`dd-risk-class-header.md` の IME 経路項目と同一語彙）。
- T1 に該当しない DD は実機実行不要（synthetic E2E＋不変条件 green で足りる）。**実行しないことは欠測ではない**
  （トリガー方式＝Stage 1 §2.3 の性能予算と同じ考え方。実行機会が無かった旨を DD-032 判定時に本台帳へ明示する）。

## 2. Tier 1 最小シナリオ（5点・1回の実機実行で全点を通す）

環境: **Windows 11 × Chrome / Edge（Tier 1 両ブラウザー必須）× 日本語 IME**。
IME のカバレッジ（憲章 §20.2 の Tier 1 IME は Microsoft IME と Google 日本語入力の**2種**）:
- **T1（変更トリガー）= Microsoft IME を最小必須**（Stage 1〜現在の全実機実績と同一基準。1回の正味 5〜10分を維持
  =Manual Gate を水増ししない。Google 日本語入力の併走は任意・推奨）。
- **T2（Beta リリースゲート）= 両 IME 必須**（Microsoft IME＋Google 日本語入力。宣言済み Tier 1 IME を
  **Beta 前に必ず実機通過**させる＝T1 の最小化で生じるカバレッジ不足をリリースゲートで回収する。Codex P2・DD-028）。

確定 Enter の**順序A/B の観測**（keydown Enter `isComposing` の値・`compositionend` との前後関係）を記録に含める。

| # | シナリオ | 期待結果 |
|---|---|---|
| S1 | **変換確定**: セルへ「かき」→スペース変換→「柿」→Enter 確定→矢印移動 | 確定値=変換後文字列・移動先で編集状態が正しく終了 |
| S2 | **無変換確定**: ひらがなのまま Enter 確定（変換を経ない） | 確定値=入力ひらがな・二重確定なし |
| S3 | **F2 再編集キャレット**: 既存値セルで F2→キャレットを先頭へ→追記→確定 | キャレット位置どおりの合成結果（DD-012-3 回帰: 末尾近似上書きなし） |
| S4 | **確定直後連続入力**: 確定 Enter の直後に間を置かず次の文字入力を開始 | **先頭文字欠落 0**（CG-1 の中核基準） |
| S5 | **Esc 取消**: 変換中に Esc → 編集キャンセル | draft が破棄されセル値が元のまま・以降の入力が正常 |

- 5点は「最小」。当該 DD の変更点に固有の再現手順（バグ修正の報告手順等）があれば追加して記録する。
- 判定は目視＋必要に応じ trace 採取（`judge-ime-trace.mjs`〔DD-012-1〕が使える場合は機械判定を併用）。

## 3. 記録様式・実行記録（追記式）

- **synthetic/実IME 区別列は必須**（synthetic E2E の green を実IME 実績として書かない）。本台帳に記録するのは
  原則**実IME** の実行。参考として synthetic を書く場合は区別列で明示する。
- 証跡はスクリーンショット・trace JSON・DD ログ行のいずれか（当該 DD の添付フォルダが置き場）。

| 日付 | トリガー | DD | 環境（OS/ブラウザー版/IME） | 区別 | シナリオ・結果 | 順序A/B 観測 | 証跡 |
|---|---|---|---|---|---|---|---|
| 2026-07-13 | T1（IME 状態機械の実抽出・CG-1 解除ゲート） | DD-012-1 | Win11 / Chrome 150・Edge 150 / Microsoft IME | **実IME** | 候補ウィンドウ経由の連続入力 20 セッション（Chrome 6＋Edge 14）→ **先頭欠落 0・PASS**（S4 相当を機械判定） | 順序B に統一・**順序A は実機 0 件**（Chromium 150 で構造的に不発→synthetic 担保へ再定義） | `doc/archived/DD/DD-012-1/`（trace 3本＋`cg1-judge-result.json`=verdict PASS） |
| 2026-07-15 | T1（compositionend 確定値経路のバグ修正） | DD-012-3 | Win11 / Chrome 150 / Microsoft IME | **実IME** | S3 相当（柿食えば→F2→先頭へ「いいい」→確定→セル外）→ 「いいい柿食えば」で **OK**（ユーザー実施） | 順序B（前提変わらず） | DD-012-3 本文ログ（2026-07-15） |
| 2026-07-16 | T1（単独グリッドモード=確定値 commit-bridge 新経路） | DD-024 | Win11 / Chrome / Microsoft IME | **実IME** | S1/S4 相当＋保存契約（日本語IME入力→cell-commit→利用側保存→F5 復元）→ **OK**（ユーザー実施・正味約10分） | 順序B（前提変わらず） | DD-024 本文ログ（2026-07-16）・synthetic E2E 証跡は `doc/archived/DD/DD-024/` |
| 2026-07-16 | T1（React Facade=mount/イベント写像の新経路） | DD-025 | Win11 / Chrome / Microsoft IME | **実IME** | S1 相当＋React 経路（日本語IME確定→onCellCommit・ref.setData 再注入・unmount/再mount・StrictMode）→ **OK**（ユーザー実施・console クリーン） | 順序B（前提変わらず） | DD-025 本文ログ（2026-07-16） |
| 2026-07-17 | T1（DD-021-2=ime-editing-session 反応変更〔K4〕・DD-020-2=常駐 textarea clipboard 経路） | DD-020・DD-021 | Win11 / Chromium（Playwright bundle・headed） / Microsoft IME | **実IME（自動駆動・Claude 代行）**: OS SendInput スキャンコード→実 MS-IME 経由。isComposing/draft/変換候補の観測で実起動を確認（人手目視ではない・ユーザー指示による代行） | §2 の **S1〜S5 全 PASS**（S1 変換確定「書き」／S2 無変換「にほん」／S3 F2+HOME 先頭追記「いいいにほん」＝DD-012-3 回帰なし／S4 確定直後連続入力 先頭欠落0／S5 Esc 取消→以降正常）＋DD 固有: **DD-020 M3**=変換中の実 Ctrl+C/V でグリッド paste 不発・draft 非喪失（MS-IME は Ctrl 押下で変換を自己確定する実機挙動を観測＝ブラウザ/IME 既定・グリッド不介入で契約どおり）／**DD-021 M1(K4)**=変換中の対象行リモート削除で編集継続（composition/draft 無傷・isTargetLost 表示）→確定 commit で退避＋公開 `row-unavailable` 通知・削除行へ commit なし | **順序B×6・順序A×0**（DD-012-1 の実機知見「Chromium で順序A 構造的不発」と一致） | `doc/archived/DD/DD-020/manual-gate-m3-ime-clipboard.png`・`doc/archived/DD/DD-021/manual-gate-m1-ime-row-deleted.png`・`ime-ledger-5point.png`（各DD添付） |
| 2026-07-23 | T1（DD-033-1=integration-editor〔常駐 textarea〕へ readOnly 分岐追加） | DD-033 | Win11 Pro 26100 / Chromium 149（Playwright bundle・headed） / Microsoft IME | **実IME（自動駆動・Claude 代行）**: OS SendInput KEYEVENTF_SCANCODE→実 MS-IME 経由（engineering-patterns §7・DD-020/021 と同手法）。probe composition・変換候補ウィンドウのスクショ・順序B 一致で実起動を証明（ユーザー指示による代行） | §2 の **S1〜S5 全 PASS**（S1 変換確定「下記」〔候補ウィンドウ経由〕／S2 無変換「にほん」二重確定なし／S3 F2+Home 先頭追記「いいいにほん」＝DD-012-3 回帰なし／S4 確定直後 45ms 連続入力 先頭欠落0／S5 Esc 2段取消→セル値不変・以降正常）＋DD 固有: **readOnly（?readonly=1）で IME ON のままローマ字送出 → keydown 4件到達（到達証明）・composition 0・draft 空・編集 UI 非表示・cell-commit 0**（textarea readOnly 属性による物理遮断＝readOnly=false 経路は S1〜S5 で無回帰を同時実証） | **順序B×7・順序A×0**（DD-012-1 の実機知見と一致） | `doc/archived/DD/DD-033/manual-gate-t1-ime-observations.json`・`manual-gate-t1-ime-5point.png`（DD-033 添付） |
| 2026-09-03 | T1（DD-035=integration-editor〔常駐 textarea〕へ列単位 readOnly の動的ロック分岐追加・日付カレンダー〔別 DOM〕新設） | DD-035 | Win11 Pro 26200 / Chromium 149.0.7827（Playwright bundle・headed） / Microsoft IME | **実IME（自動駆動・Claude 代行）**: OS SendInput KEYEVENTF_SCANCODE→実 MS-IME 経由（engineering-patterns #9・DD-033 と同手法）。probe composition（「a」→isComposing/draft「あ」・3 試行で確立）・keydown `Process`(isComposing=true) 系列・変換候補（「かき」→「夏季」）・予測候補ウィンドウのスクショで実起動を証明（ユーザー指示による代行） | §2 の **S1〜S5 全 PASS**（S1 変換確定「夏季」〔候補経由・committed=変換後・移動先で編集終了〕／S2 無変換「にほｎ」二重確定なし〔MS-IME のローマ字規則で末尾 n が ｎ のまま＝IME 挙動・契約外〕／S3 F2+Home 先頭追記「いいいにほｎ」＝DD-012-3 回帰なし／S4 確定直後の連続入力「ねこ」→「とり」先頭欠落 0／S5 Esc 2 段取消→セル値不変・以降「あ」入力正常）＋DD 固有: **T1**=readOnly 列（col-b）で IME ON のままローマ字送出 → keydown 4 件到達（到達証明）・composition 0・draft 空・textarea.readOnly=true・committedHash 不変・cell-commit 0、←で隣の可編集列へ移ると textarea.readOnly=false・「かき」composition 成立／**M1**=日付列で F2→カレンダー→実 →→Enter で 2026-07-31→2026-08-01 確定、カレンダー表示中に実 IME 入力開始→カレンダーが閉じ手入力（「あ」composing）へ・Esc 2 段で文書無変更 | **順序B×10・順序A×0**（IME 確定 Enter は keydown `Process` isComposing=true → compositionend の順。DD-012-1 の実機知見と一致） | `doc/archived/DD/DD-035/manual-gate-t1-ime-observations.json`・`manual-gate-t1-ime-trace.json`・`manual-gate-t1-s1-converting.png`・`manual-gate-t1-readonly-column.png`・`manual-gate-m1-calendar-open.png`・`manual-gate-m1-ime-during-calendar.png`・`manual-gate-t1-ime-5point.png` |

> 遡及初期行について: 上 4 行は Stage 1〜Stage 2 序盤の実機実績の遡及記録（DD-028 要確認⑤・ユーザー確定）。
> 記録粒度は当時の DD 記録に依るため、シナリオ列は「相当」表記で対応付けている。以降の新規行は §2 の 5 点を
> 明示的に通して記録する。

## 4. 運用ルール

1. **T1 DD の起票者は Manual Gate として本台帳への記録タスクを DD に組み込む**（kpi-ledger §2 と同じ防御。
   タスク文面例: 「🖐️ 実機 IME 実行（ime-manual-gate-ledger.md §2 の 5 点＋変更固有手順）→ §3 へ 1 行追記」）。
   **ただし T1 は DD のクローズをブロックしない** — 実施できないまま他の受け入れ基準を満たしたら、
   §3 へ「未実施」行を残し、DD の `## 既知の未保証境界` へ1行移送してクローズする
   （`dd-risk-class-header.md`「Manual Gate の扱い」・2026-09-03 決定）。**「確認待ち」で保持しない。**
2. 記録は 1 実行 = 1 行（ブラウザーごとに分ける必要はない。環境列に両方書けばよい）。
3. **実行した結果 FAIL した場合**は当該 DD を完了にせず、修正後に再実行・再記録する（FAIL 行も消さず残す＝履歴）。
   未実施（そもそも実行していない）と FAIL は別物 — 未実施はクローズ可、FAIL はブロックする。
4. 実IME の重大回帰（確定文字の欠落/重複/順序崩れ）を検出したら、本台帳の記録に加えて
   `kpi-ledger.md` §3.1（KPI-7）へも記録する（リリース前検出=pass の証拠になる）。

## 参照

- CG-1 実機ゲートの定義・解除経緯: `doc/plan/cg-ledger.md`・`doc/archived/DD/DD-012-1_入力縦切り.md`
- CI（synthetic E2E・継続実行）: `.github/workflows/ci.yml`（DD-028）
- S2-4 ハードゲート: `doc/plan/phase2-dd-roadmap.md` §0
- Tier 1 環境定義: 製品憲章 §20
