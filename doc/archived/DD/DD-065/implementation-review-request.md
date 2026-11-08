# DD-065 実装レビュー依頼

2026-11-08。ユーザーの「実装が終わったら Codex にレビュー依頼、指摘は妥当性を判断して修正」の指示に基づく。

## 背景と対象

mount-controller.ts の肥大化を解消し、配線を部品単体でテストできるようにする内部リファクタリング。公開 API・挙動・protocol は変えない。Claude が区画①まで実装した後に SessionLimit となり、Codex が区画⑥（起動・設定）の整理と検証を引き継いだ。

- 比較元: `6968e66`（DD-064 完了・alpha.19 配布後）
- 変更: `scripts/size-guard/`、lint/CI/ガードテスト、`packages/grid/src/mount-controller.ts`、`packages/grid/src/mount/`、flush 中 destroy の E2E を含む DD-065 の差分全体
- **除外**: DD-066 本体と DD-066 の INDEX 行。別セッションが起票・調査したもの。既存の結合セルの二重枠の挙動も本 DD で直さない
- DD 本体: `doc/DD/DD-065_grid の mount 配線の分割と再肥大の防止.md`
- 設計・状態の持ち主・テスト対応: `doc/DD/DD-065/diagnosis.md`（§9〜13 は実装の記録）

`git diff 6968e66...HEAD` を読み、移動元（6968e66 の mount-controller.ts）と移動先を照合してください。レビュー依頼時に記録類の未コミット差分が残っていても、実行コードはすべて HEAD にあります。記録類は現在のファイルも参照して構いません。コードは変更しないでください。

## 確認してほしい点

1. 元の挙動との一致。イベントと DOM listener の登録順、同期処理・microtask・rAF の順序、公開エラーの分類が変わっていないか
2. 相互依存を getter で渡す際に、初期化前の参照・値の固定・後から生成される部品の欠落がないか。「生成 → 結線 → backend.start()」の順序
3. キー入力 8 段の優先順位と、consume / pass / continue の戻り値。composition・readOnly・結合・範囲の境界
4. 起動前の setData / setRows / setCellStatus と命令キュー、単独／共同編集の違い、再注入と Undo。flush 中 destroy の解決・タイマー・WS・DOM の解放
5. 各状態の所有が部品内に閉じているか。循環した実行時 import・巨大な共有 state・no-op スタブが増えていないか
6. ガードが新規超過・増加・baseline の引き上げ／追加を検出し、DD と理由のある例外だけを許すか。CI の比較元の妥当性
7. 実物の mount を通さない React の mock テストと、部品単体テスト・E2E の役割の区別。重要な配線のテスト不足

既存テストの期待値は変更していません。単体全体 1,665 件、型検査（通常・consumer-strict）、lint、build は成功。E2E とブラウザー操作の詳細は検証記録を参照。実 Microsoft IME は未実施で、synthetic composition のみです。

## 結果

修正が必要な具体的な不具合だけを P1/P2/P3 とファイル・行番号・再現条件・根拠つきで列挙してください。移動前にも存在した問題は区別し、好みのスタイル提案だけは findings に含めないでください。問題が見つからなければその旨と、確認できなかった範囲を記録してください。
