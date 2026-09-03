# showcase — SDK紹介サイト・機能カタログ＋動作デモ

SDK の「いま何ができるか／これから何ができるか／何を意図的にやらないか」を1画面で見せる紹介サイトと、
その場で触れる動作デモ。上司・ステークホルダー・導入候補プロジェクト向けの進捗可視化が目的（DD-017-2）。

- `index.html` — 機能カタログ（`src/features.json` から描画。3区分: 提供中／開発予定／対象外）
- `demo.html` — 動作デモ（`@nanairo-sheet/grid` **Facade のみ**でグリッドを組み込む＝consumer 実装の実例）
- この app は SDK 内部パッケージを import しない（boundary lint R1 対象。Facade 経由のみ）

## 起動

```bash
bash scripts/dev-start.sh --showcase
# → 紹介サイト: http://localhost:5886/
#    server-hono: :9499（50,000行シード＋ファイル永続化 .dev-persistence/showcase）
```

- デモデータをリセット: 停止後に `rm -rf .dev-persistence/showcase`
- server のみ再起動（復元・再接続デモ用）: `bash scripts/dev-kill.sh --server` → `bash scripts/dev-start.sh --showcase --server-only`

## 5分デモ台本（上司向け・そのまま実行する手順）

事前準備（デモ前に1度）:

```bash
bash scripts/dev-kill.sh
rm -rf .dev-persistence/showcase   # まっさらな状態から始める場合
bash scripts/dev-start.sh --showcase
```

ブラウザで http://localhost:5886/ を開いておく。

| 時間 | 見せる内容 | 操作 |
|------|-----------|------|
| 0:00 | **全体像**: 提供中／開発予定／対象外の3区分 | カタログを上から下へスクロール。「緑=検証済みで今日触れる、黄=Stage 2 で作る、グレー=意図的にやらない」と説明 |
| 1:00 | **日本語入力** | 「日本語入力」カードの「デモを見る」→ セルに日本語を変換しながら連続入力 |
| 2:00 | **5万行スクロール** | シナリオ切替「大量データの高速表示」→ ホイールで一気にスクロール |
| 2:30 | **共同編集** | シナリオ切替「リアルタイム共同編集」→「別ウィンドウで開く」で2画面を並べ、片方の編集が即時反映されるのを見せる |
| 3:30 | **切断・再接続** | 別ターミナルで `bash scripts/dev-kill.sh --server` → オフライン表示のまま編集（未送信カウント増）→ `bash scripts/dev-start.sh --showcase --server-only` → 自動再送で「未送信 0」に戻る |
| 4:30 | **保存と復元** | そのままページを再読込し、切断中の編集も含めて全データが残っていることを見せる |
| 5:00 | **今後の見通し** | カタログへ戻り「開発予定（Stage 2）」の4機能と「対象外」を示して締める |

補足デモ（時間があれば）: シナリオ切替「明細閲覧ビュー（表示専用）」で、表示専用モード（readOnly）＋業務名の列見出し＋数値/日付の表示書式＋値の装飾を併用した BI 明細レコード閲覧を見せられます（DD-033・編集は抑止され、コピーは生の値のまま）。

トラブル時: ポートが塞がっていたら `bash scripts/dev-kill.sh` を先に実行。デモが不安定なら
`npm run test:e2e:showcase`（起動＋主要導線 smoke）で機械確認できる。

## features.json の更新義務（腐った紹介サイトを防ぐ）

機能一覧・ステータスの表示データは `src/features.json` **1ファイルだけ**で管理する（HTML へ手書きしない）。

- **機能に関わる DD を完了（アーカイブ）したら、`src/features.json` の該当エントリを更新する**
  （例: DD-019 完了 → `presence` を `planned` → `available` に変更し、demo リンクとシナリオを追加）
- 正本はあくまで `doc/plan/phase1-dd-roadmap.md` §4・`doc/plan/stage2-backlog.md`・roadmap §6（本ファイルは表示用写像。`source` で対応を保つ）
- 整合性は `src/features.test.ts`（`npm test` に含まれる）が機械検証する
  （DD-009〜022 の網羅・3区分・デモリンクとシナリオの対応）

## テスト

```bash
npm test                     # features.json 整合性 smoke を含む（vitest）
npm run test:e2e:showcase    # 実ブラウザー smoke: カタログ描画・デモ遷移・グリッド接続（Playwright）
```
