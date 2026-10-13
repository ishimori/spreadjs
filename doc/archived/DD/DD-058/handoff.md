# DD-058 / 広島空港 H15: alpha.14 引き渡し（2026-10-14）

## 配布物

- ディレクトリ: `C:/repo/spreadjs/release/0.1.0-alpha.14/`
- ZIP: `C:/repo/spreadjs/release/nanairo-sheet-0.1.0-alpha.14.zip`
- ZIP SHA-256: `0998974cbcc8dcb4246acd565be63eeb4d65c47080a61015c438a061fdbee07c`（12 entriesを展開前の元ファイルとbyte単位で照合）。
- package版: `0.1.0-alpha.14`（10 package同一版）。API版: `0.1.0-experimental`、公開シグネチャ変更なし。
- 生成元: `f1a97c71abec385f7a97a434273b4453f6628da1`。
- manifest: `closureDirty=false`。`gitDirty=true`はDDエビデンス等の配布外変更による。

`build-release.sh --skip-verify`で、実施済みtypecheck/lint/unitを重複実行せずpackした。`verify-manifest.mjs`で10 tarballのSHA-256・bytes・版を照合し、pack内容も115 files・全entrypoint保持・tsconfig/test/spec混入なし。

独立consumer-appはこの配布ディレクトリのtarballを使って installし、公開面の型検査・server lifecycle・production build・E2E10件（synthetic入力・共同編集・destroy/remount）を全green。consumer-harnessのpack→install→tscもgreen。

## 取り込み手順（広島リポ側）

1. 現在の変更とSDKのvendor方式を確認し、manifestを照合して10 tarballすべてを一緒に取り込む。registry publishは不要。
2. consumerの依存/lockにalpha.14を反映し、install後の版とハッシュを確認する。インストールはconsumerの既存vendor運用に従う（ZIPにはmanifestのinstallコマンドがある）。
3. 型検査・build・既存PoCの入力/共同編集を確認する。
4. Windows表示スケール125%・Chrome拡大率100%で予算入力①を開く。文字/罫線がにじまないこと、通知帯などで位置が変わっても保持されること、選択枠・編集欄・ドロップダウンがセルと対応することを目視する。可能なら別DPIモニターへの移動も確認する。
5. 広島 `doc/poc/sdk-requirements.md` H15 の「取り込み結果」を更新する。ここでは広島のソース・データ・要件記録を変更していない。

## 完了境界

SDK実装・自己レビュー・機械検証・配布物作成まで完了。実機Chrome/GPU・Windows125%の目視、広島PoCの実取り込み/実入力画面/商談受入、push、registry publishは未実施。CanvasとDOMの文字AA方式の差は今回の対象外。

検証詳細: [verification.md](verification.md)、自己レビュー: [self-review.md](self-review.md)。
