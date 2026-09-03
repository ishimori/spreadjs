# DD-041: Presence の activeCell 枠・名前タグの pane clip 漏れ

| 作成日 | 更新日 | ステータス | 補足 |
|--------|--------|-----------|------|
| 2026-09-03 | 2026-09-04 | 完了 | 不具合修正。他ユーザーの activeCell 枠と名前タグを pane ごとの clip へ差し替えた（論点①=(a) で確定）。unit 5 件＋E2E 1 件で固定し、修正前は E2E で固定帯に 1,028 ピクセルの漏れ・修正後 0 を実測。Manual Gate M1 は E2E が自動化したため実機確認不要 |

> アプローチ: バグ修正・ライトパス（原因は実読で特定済み・変更は 1 関数内・unit で完結。guides.md §1）
> リスク: なし（描画層のみ。認可・DBスキーマ・外部I/F・機密情報に触れない）

```text
Risk Class: B（描画層のみ。公開 API・Command/Event・protocol・永続化に触れない）
Risk Triggers: なし（overlay-layer の clip 矩形の差し替えだけ。IME・editor・sequencer・snapshot は無改変）
Human Spec Gate: required（論点① = 名前タグの見え方はユーザー判断。それ以外は自明）
Codex: medium（実装完了後にユーザー指示で CLI 実行）
Manual Gate: あり・クローズ非ブロック（M1=2 タブで固定列ありの Presence 表示）。未実施なら「既知の未保証境界」へ移送
External Review: なし
Evidence Level: standard
```

## 概要

| Bug# | 概要 | 重要度 |
|------|------|--------|
| 041 | 他ユーザーの **activeCell 枠＋名前タグ**が pane 境界を無視して描かれ、固定ペイン（固定列・固定行）の上へ重なる | LOW（表示のみ・共同編集時のみ・値/編集/計算に影響なし） |

- Presence の**選択範囲ハイライトは正しい**（`rangePiecesAcrossPanes` で pane ごとに clip 済み）。壊れているのは枠とタグだけ
- 発生条件は「固定行列を使う」×「他ユーザーが固定帯の裏へ回った位置を選択中」。`frozenColumnCount` を consumer が実際に使い始めた（DD-036）ため、**到達可能性が上がった**
- 症状は未観測（実機報告ではなく実読による発見）。再現手順は Phase 0 で確定する

## 原因分析

`packages/render/src/overlay-layer.ts` の `drawPresence` は、選択範囲だけ `rangePiecesAcrossPanes()`（pane ごとの clip）で描き、
**activeCell 枠と名前タグは `contentClip`（ヘッダーを除いた全セル領域 1 枚）**で描いている。
`transform.cellRect(activeRow, activeCol)` はスクロール行列に対して `- scrollLeft / - scrollTop` された座標を返すため、
固定帯の裏へ回ったセルの矩形が固定ペインの内側に落ち、そのまま上書きされる。
名前タグは `tagY = active.y - tagHeight` とセルの上へ出るので、固定行帯の上にも乗りうる。

> DD-039（ヘッダー帯）と同じ「pane 境界を跨ぐ単一 clip」の誤り。セル本体（`drawPane`）・選択枠・ドラッグ枠は pane ごとに clip していて正しい

## 検討内容

| # | 論点 | 選択肢 | 推奨と理由 |
|---|------|--------|-----------|
| 1 | 名前タグの扱い | (a) 枠もタグも pane clip で切る（タグは pane 上端で欠ける）/ (b) 枠だけ pane clip・タグは現行の content clip のまま / (c) タグをセル内側へ寄せて pane 内に必ず収める | **(a)**。viewport 上端では現状すでに content clip でタグが欠けており、pane 境界でも同じ見え方になるだけ＝一貫する。(b) は「枠のない名前タグが固定ペインに浮く」という別の不整合を作る。(c) は見た目の変更が大きく、別 DD で扱うべき UI 改善 |
| 2 | 実装 | (a) 単一セル range を `rangePiecesAcrossPanes()` に通して piece の clip を使う（選択ハイライトと同じ経路）/ (b) activeCell の属する pane を自前で判定する | **(a)**。既存関数がそのまま使える（`CellRange` は半開区間なので `{rowStart: r, rowEnd: r+1, colStart: c, colEnd: c+1}`）。pane 判定ロジックを二重に持たない |
| 3 | 可視範囲外の Presence | (a) piece が 0 個なら何も描かない | **(a)**。現行も content clip で見えないため**見た目は不変**。無駄な描画が減る副次効果のみ |

## 修正方針

`drawPresence` の activeCell 枠・名前タグの `withClip(clip, …)` を、選択ハイライトと同じ `rangePiecesAcrossPanes()` 経由の
pane clip へ差し替える（論点①(a)・②(a)）。`contentClip` の用途がなくなるなら関数ごと削除する。

## 対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `packages/render/src/overlay-layer.ts` | `drawPresence` の枠・タグを pane ごとの clip で描く。未使用になれば `contentClip` を削除 |
| `packages/render/src/overlay-layer.dd041.test.ts`（新規） | ctx スパイで「固定側 clip の内側に、スクロール行列の Presence の枠・タグが描かれない」ことを固定 |

## 受け入れ基準

| # | 基準（操作 → 期待結果） | 検証方法 |
|---|------------------------|---------|
| 1 | 固定列ありで、他ユーザーの activeCell が固定帯の裏へ回る位置にあるとき、**固定ペインの上に枠・名前タグが描かれない** | unit（ctx スパイ: clip 矩形と描画座標） |
| 2 | 固定行ありでも同じ（縦方向） | unit |
| 3 | 固定行列 0 のとき、描画結果が修正前と同一（clip 矩形・座標とも）。ただし**可視 index 範囲の外にあるセル**は除く（→ 既知の未保証境界） | unit |
| 4 | Presence の選択範囲ハイライト・自分の選択枠・ドラッグ枠に変化がない | 既存の全回帰 |
| 5 | activeCell が可視範囲外の Presence で、描画が増えも減りもしない（見た目不変） | unit |
| 6 | 公開 .d.ts snapshot に差分なし・boundary lint new=0 | contract test ＋ lint |

## タスク一覧

### Phase 0: 再現とユーザー確認（ゲート）
- [x] 👀 **ユーザー確認**: 論点①（名前タグを pane 境界で切ってよいか）→ **(a) 枠もタグも pane clip で切る**（2026-09-04 回答）
- [x] 再現条件を確定: 固定 5 列・A は scrollLeft=0 で列 8 を選択・B だけ 6 列分右へスクロール → B の座標系で列 8 が固定帯の内側へ落ちる。専用 E2E `apps/playground/e2e/presence-frozen-panes.spec.ts` として固定した（既存 integration-scenario は固定列を使わないため別ファイル）
- [x] 📸 修正前エビデンス（`test-results/dd-evidence/DD-041/`）: `dd041-before-leak.png` ＋ `before-e2e-red.txt`（固定帯に overlay 不透明ピクセル **1,028 個**）／`before-unit-red.txt`（unit 5 件中 4 件 red）

### Phase 1: 修正とテスト
- [x] `packages/render/src/overlay-layer.ts`: `drawPresence` の枠・タグを `rangePiecesAcrossPanes()` の pane clip で描く。用途の消えた `contentClip` は削除（`headerWidth`/`headerHeight` は公開 deps の形を保つため受け取りだけ止めた）
- [x] 横展開確認: `overlay-layer.ts` の clip 経路は `withClip` 1 本のみになり、呼び出しは全て pane clip（`ctx.clip()` の残りは base-layer のヘッダー帯で、DD-036/039 で pane 分割済み）
- [x] `overlay-layer.dd041.test.ts` を追加（AC1・2・3・5 ＋ 選択ハイライト不変の 5 件）
- [x] 🔬 機械検証: `npm test`（1,221 件）/ `npm run typecheck` / `npm run lint`（boundary new=0）→ 全 green

### Phase 2: エビデンスと仕上げ
- [x] 📸 修正後エビデンス（同条件）: `dd041-after-fixed.png` ＋ `after-e2e-green.txt`（固定帯の不透明ピクセル **0 個**）／`after-unit-green.txt`（unit 5/5 green）
- [x] `CHANGELOG.md` の Fixed へ記載
- [x] 🔬 機械検証: Presence 経路の E2E（既存 `integration-scenario.spec.ts` ＋ 新規 `presence-frozen-panes.spec.ts`）→ green

### 完了前チェック
- [x] 受け入れ基準を 1 項目ずつ照合（AC1〜6・下記ログ参照）
- [x] 😈 セルフレビュー 1 巡（＋Codex medium レビュー 1 巡・`DD-041/codex-review-result.md`）
- [x] 🔬 全回帰 1 回: `npm test`（1,221 件）/ `npm run typecheck` / `npm run lint`（boundary new=0）/ `npm run test:e2e`（155 件）→ 全 green

## 既知の未保証境界

- **可視 index 範囲の外にあるセルの名前タグは描かれない**（修正前は viewport へ食い込んだ分だけ描かれていた）。
  タグはセルの真上 14px に出るため、「セル自体は範囲外だがタグ矩形は viewport に掛かる」という細い帯が理論上ある。
  pane 帰属を**可視 index 範囲**で決める以上、この帯は落ちる。
  - **production では到達しない**: `mount-controller` の overscan は縦 `viewportHeight × 0.6`・横 `COL_WIDTH × 3` で、
    タグ高さ 14px を大きく超える。縦方向は到達不能。横方向は表示名が概ね 50 文字を超えると理論上掛かりうる。
  - **安易な救済はしない**: 「piece が 0 個なら従来の content clip で描く」フォールバックは、
    **`overscanX < frozenWidth` のとき（固定 4 列以上で成立する）** 範囲外のスクロール列が固定帯の内側へ落ち、
    本 DD が直したはみ出しをそのまま復活させる。厳密に救うには pane 帰属を幾何で自前判定する（論点②(b)）必要があり、
    pane 判定の二重持ちという当初の棄却理由に戻る。実害（名前タグの数 px の欠け）に見合わないため境界として残す

## Manual Gate（クローズ非ブロック・正味）

| # | 項目 | 正味 | 結果 |
|---|------|------|------|
| M1 | 2 タブ・固定列ありで、相手の Presence 枠・名前タグが固定ペインへはみ出さないこと | 0 分 | **E2E で自動化**（`presence-frozen-panes.spec.ts` が overlay の実ピクセルで検証。修正前 1,028px → 修正後 0px）。人手確認は不要 |

## ログ

### 2026-09-03
- 起票。**DD-039（固定ペインのヘッダー clip 漏れ）の 📐 実読中に発見した同根・別箇所**。DD-039 は AC5 で「Presence 不変」を掲げているためスコープに入れず、ユーザー指示で別 DD とした
- 実読で範囲を確定: `drawPresence` のうち**選択範囲ハイライトは pane 分割済みで正しい**。誤っているのは activeCell 枠と名前タグ（`contentClip` 1 枚）だけ
- 未観測（実機報告ではなく実読による発見）。重要度 LOW だが、DD-036 で `frozenColumnCount` が consumer に使われ始めたため到達可能性は上がっている

### 2026-09-04
- 👀 論点① をユーザー確認 → **(a) 枠もタグも pane clip で切る**（DD の推奨どおり）。以降ゲートなしで実装まで通した
- **修正**: `drawPresence` の枠・タグを、単一セル range `[r,r+1) × [c,c+1)` を `rangePiecesAcrossPanes()` に通した piece の clip で描く（論点②(a)）。用途の消えた `contentClip` を削除。`headerWidth`/`headerHeight` は `.d.ts` 契約（AC6）を守るため deps の形だけ残し、受け取りを止めた
- **再現の実証**: unit を先に書いて修正前に当て、5 件中 4 件 red を確認（`before-unit-red.txt`）。さらに E2E `presence-frozen-panes.spec.ts` を新設し、**B の固定帯の overlay 不透明ピクセルが修正前 1,028 個・修正後 0 個**を実測（`before-e2e-red.txt` / `after-e2e-green.txt` ＋ スクショ 2 枚）。修正を一時 revert して red を再確認する手順で「テストが空振りしていない」ことを 2 度確認した
- **Manual Gate M1 を E2E が代替**。人手の実機確認は不要（クローズ非ブロックの繰り越しも発生しない）
- 🤖 **Codex medium レビュー**（`DD-041/codex-review-request.md` / `codex-review-result.md`）: P2×3・P3×1。仕分けと反映:
  - **反映** P2「E2E が browser context を閉じておらず、直列実行の後続 spec へ接続と rAF を残す」→ `try/finally` で両 context を close
  - **反映** P2「固定 sleep 300ms 待ちだと、rAF スロットル時に *Presence を描く前の空の固定帯* を測って**不在アサートが素通りする**」→ 自分の指摘と同一。B の選択を別セルへ動かし、その枠が overlay に現れるまで poll する方式へ置換（overlay は 1 パスで選択と Presence を描くため、枠が見えれば同フレームの Presence も描き終わっている）。置換後も「修正を revert すると red（1,028px）」を再確認済み
  - **見送り（境界化）** P2「可視範囲外のセルでも、viewport へ食い込むタグは従来描かれていた」→ 指摘自体は正しい。ただし production の overscan では到達せず、安易なフォールバックは固定 4 列以上ではみ出しを復活させる。→ `## 既知の未保証境界` へ移送し、AC3 の文言も実際の保証範囲へ精密化した
  - **見送り** P3「`codex-review-request.md` を DOC-MAP へ登録すべき」→ 誤り。DD 添付は DOC-MAP の対象外で、`bash scripts/doc-check.sh` は green。既存のアーカイブ済み DD（DD-001〜005 等）も同ファイルを登録していない
- **AC 照合**: AC1（unit・固定列）/ AC2（unit・固定行）/ AC3（unit・clip 矩形と座標の一致。境界は上記）/ AC4（全回帰 1,221 件 ＋ E2E 155 件 green・Presence 選択ハイライトの不変を unit でも固定）/ AC5（unit・可視範囲外は 0 描画）/ AC6（`.d.ts` snapshot 差分なし・boundary new=0）→ **全て充足**
