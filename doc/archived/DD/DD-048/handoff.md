# DD-048 / alpha.5 引き渡し

## 配布物

- SDK版: `0.1.0-alpha.5`、API版: `0.1.0-experimental`。
- 配布ディレクトリ: `C:/repo/spreadjs/release/0.1.0-alpha.5/`。
- 10 package（grid/react/server-hono/core/types/collab/render/selection/ime/server）のtarballと`manifest.json`を一式で扱う。formulaは含まない。
- 実装コミット: `e52944c`。正式成果物のSHA-256・bytes・完全なコミットIDは配布manifestが正本。
- npm registryへの公開、GitHubへのpush、松下リポジトリへの適用は未実施。

## 松下 管理表①への導入例

既存の`columnBorders`・固定列・背景設定を渡している`NanairoSheetView`へ次のpropを追加する。
初期行のRowIdを列挙する必要はない。grid `mount`も同名のオプション。

```tsx
<NanairoSheetView
  {...existingSheetProps}
  defaultRowBorder={{ color: '#cbd5e1', width: 1, style: 'dotted' }}
/>
```

個別罫線にも`style: 'dotted' | 'dashed'`を使える。省略・`solid`は実線。
個別top/bottomを太い線→同幅なら下行topの順で解決し、明示線がない境界だけ共通線を使う。
共通線より細い明示線も優先する。縦線同士は太い線→同幅なら右列left、交点は太い線→同幅なら横線。

共通線は全データ行の下端（最終行を含む）に付き、ローカル/リモートの行増減・standaloneの`setData`後も追従する。
0行・先頭行上端・見出し・行番号帯・データ外の空白には適用しない。
設定は表示専用・mount時固定。文書、保存、コピーTSV、共同編集protocolは変わらない。

## 更新手順

1. consumerの既存vendor・lockfileを戻せる状態で保存し、alpha.5の10tarballをconsumerのvendorへ一式コピーする。
2. consumerでその10tarballを同時にinstallする。`manifest.json`のinstall例はtarballと同じ作業ディレクトリを前提とするため、consumerから実行する場合は各パスへvendorディレクトリを付ける。
3. consumerの型検査・本番buildを実行する。`#/production-orders`へ上記propを追加する。
4. 管理表①で点線、既存縦罫線、No〜品名の固定、追加行、スクロール、実機拡大率を確認し、consumer DD-025に結果を記録する。

## 制約

- 線幅w=max(1, round(width×DPR)) device px。dottedは四角い点w＋隙間2w、dashedは線長4w＋隙間2w。任意dash配列は未提供。
- 位相はデータ領域の画面左端/上端を原点に固定し、固定paneやscrollで周期を再開しない。外周は最低1device pxを内側へ残す。
- Reactは同値設定（キー順、style省略/solidを含む）で再mountしない。値が変わる設定変更は再mountとなる。動的setterは未提供。
- Undo/Redoは既存のセル値編集が対象。行追加・削除自体のUndo/Redoは未提供。
- 単一Windows/Chromium環境の自動試験・画素検査を実施。人手による実機拡大率での視認性確認、松下実画面の適用・受け入れは未実施。

検証結果は [validation.md](validation.md)、仕様は [e2e-scenarios.md](e2e-scenarios.md) を参照。

配布用ZIP: C:/repo/spreadjs/release/nanairo-sheet-0.1.0-alpha.5.zip（338543 bytes）。10tarball＋manifest＋READMEを含む。ZIP内のtarballもmanifestのSHA-256と一致確認済み。

ZIP SHA-256: `c6bb86ce268035aae95607594928759ffc6decaf9e178a4278246b9f9d79cc1d`
