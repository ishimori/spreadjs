# DD-066 / hiroshima-keikaku: alpha.20 引き渡し（2026-11-08）

## 配布物

- ディレクトリ: `C:/repo/spreadjs/release/0.1.0-alpha.20/`（10 tarball・manifest・本書と同じ README）
- ZIP: `C:/repo/spreadjs/release/nanairo-sheet-0.1.0-alpha.20.zip`
- package 版: `0.1.0-alpha.20`（10 package 同一版）。API 版: `0.1.0-experimental`。公開 API の変更なし
- 生成元: `76c4986`。manifest の `gitCommit`・`closureDirty=false` と SHA-256 で照合する

## alpha.19 からの変更

- 結合セルを選ぶとき、内側に残っていた1セルぶんの枠を解消。自動 focus なしの初期表示も範囲全体を囲む
- スクロールで結合の上端・左端が固定帯の下へ隠れても、枠をデータ領域内へ収める。左上の1セルだけが隠れても、結合の残りが見えれば枠とfocusを保つ
- 結合の外へ移ると通常セルの枠へ戻る。通常セルの編集・IME・wrap・候補欄・日付の配置は従来どおり
- DD-065 の内部整理（mount の機能別分割・部品単体テスト・サイズのガード）も同梱。利用側の API・結合指定の形式は変わらない

## 取り込みと確認

既存の `prototype/vendor/nanairo-sheet/` の10 tarballを alpha.20 の同名packageへ差し替え、`prototype/package.json` の `file:` を新しい版へ向けて依存を入れ直す。lockfile を一律に削除せず、通常の依存更新手順を使う。

- 入力シートで、No・科目・内容などの3行結合の枠が全体の1つだけになること
- 初期表示、固定した属性列での縦横スクロール、結合から隣のセルへ移る操作を確認すること
- 隣の編集セルで実 Microsoft IME を使い、変換窓の位置と確定を確認すること
- singlefile 化した HTML でも同じ見え方になること

SDK 側では合成 composition と実物ブラウザー E2E、公開面だけを読む独立 consumer-harness を確認する。詳細なコマンド・結果・Before/After・ZIPのSHA-256は DD-066 の `verification.md` を参照。

## 未確認範囲

- 実 Microsoft IME の変換窓の位置（SDK側は合成イベントのみ）
- consumer（hiroshima-keikaku）への実際の取り込みと入力シートでの確認（DD-066 AC6。consumer側の後続作業）

consumer リポジトリはこの作業では変更していない。
