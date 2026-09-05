# DD-047 consumer引き渡し — 0.1.0-alpha.4

月の列、製品ブロック、集計行へ色と幅を指定した罫線を追加できます。

| 指定 | 用途 |
|---|---|
| `columnBorders[ColumnId].right / left` | 日付＋数量の2列を月単位で区切る |
| `rowBorders[RowId].top / bottom` | 製品ブロック・注文合計・月末在庫の上下を区切る |
| `rowBackgrounds / columnBackgrounds` | 既存の帯色と併用。罫線は背景の上に残る |

```ts
import type { GridBorder, GridRowBorders, GridColumnBorders } from '@nanairo-sheet/grid';

const monthLine: GridBorder = { color: '#94a3b8', width: 2 };
const totalLine: GridBorder = { color: '#64748b', width: 2 };
const columnBorders: Record<string, GridColumnBorders> = {
  'q_2026-09': { right: monthLine },
  'q_2026-10': { right: monthLine },
};
const rowBorders: Record<string, GridRowBorders> = {
  r26: { top: totalLine },
  r30: { top: totalLine, bottom: totalLine },
};
// mount({ container }, { ...既存options, rowBorders, columnBorders });
// <NanairoSheetView {...既存props} rowBorders={rowBorders} columnBorders={columnBorders} />
```

行IDはconsumerが実データの行区分から決めます。松下本体のファイル・vendor・DBは本DDで変更しません。

実線のみ、幅はCSS pxで0超〜8以下。mount時固定、Reactは同値なら再mountしません。書式の保存・共同編集は行いません。
未知列／不正色／不正幅は`border-config-invalid`、未知行は`row-border-unknown` warn後に遅延解決します。
同じ境界は太い線、同幅なら下行top／右列leftを優先。交点は太い線、同幅なら横線を優先します。
文字overflowは縦罫線で停止。ヘッダーは従来通りで、線はデータセル領域だけに描きます。

配布物はリポジトリの`release/0.1.0-alpha.4/`にある10 tarballとmanifestです。grid/reactだけでなくclosure全10件を同時に更新します。
consumerプロジェクトのvendorへ10件をコピーし、`npm install --no-audit --no-fund ./vendor/*.tgz`相当で導入します。
旧版の同名ファイル上書きは避け、lockfileの解決先がalpha.4になったことを確認してください。
SHA-256・サイズ・版数は`node scripts/release/verify-manifest.mjs release/0.1.0-alpha.4`で検証できます。

試験用consumerでは`?borders&facade=grid|react&mode=standalone|collaboration`で4経路を実行します。
Playgroundは`standalone.html?extracols=196&seedrows=60&frozencols=5&rowborder=r26:top:2:64748b;r30:top:2:64748b;r30:bottom:2:64748b&colborder=col-x1:right:2:94a3b8;col-x3:right:2:94a3b8`で空の未来月を含む例を再現できます。
Showcaseの「マトリクス型シート」デモにも同じAPIを接続済みです。
