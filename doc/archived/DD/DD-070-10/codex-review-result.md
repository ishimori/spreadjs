通常の単一 core 内ではチャンク・行への書き込み前にコピーしていますが、古いスナップショットの編集が現在のセル値を変える経路と、別の core インスタンスでの replay が元文書の行軸を壊す経路を再現しました。どちらも操作ログや revision の更新を伴わず、文書の隔離を破ります。

Full review comments:

- [P1] スナップショットに渡すセル値を共有レコードから切り離す — C:\repo\spreadjs\packages\core\src\document.ts:113-113
  `serializeDocument` は `record.value` をそのまま返します。revision 2 のスナップショットを取得し、別セルを revision 3 で確定してから、古いスナップショット内の文字列セルの `.value` を変更すると、現在の文書のセル値まで変わり、`lastChangedRevision` は 2 のままでした。以前は次の確定の深い複製でこの参照が切れていました。サーバーの `RunningServer.snapshot()` や注入ストアにも同じ値が渡るため、fork は維持し、`serializeDocument`・`deserializeDocument` の境界で `cloneCellScalar` を使ってください。

- [P2] 行軸の共有判定を core のモジュールインスタンスに依存させない — C:\repo\spreadjs\packages\core\src\document.ts:94-95
  同じ版の core を二重にロードし、A の `applyOperation(setCells)` が返した文書を B の `replayAcceptedOperations(insertRows)` に渡すと、B の `sharedRowAxis` には登録がないため、A の元文書にも新しい行が入りました。元文書の `maxSlot` と revision は進まず、行の採番状態も不整合になります。共有の印を文書とともに引き継げる形にするか、replay が最初に行軸へ書く際にモジュール外の履歴によらず切り離してください。

- [P2] 読み取り側に共有中の可変な行配列と Map を渡さない — C:\repo\spreadjs\packages\core\src\document.ts:110-111
  共同編集で `setCells` が pending のとき、`ClientSession.viewDocument.rowOrder.reverse()` は型上そのまま呼べますが、今は `committedDocument` の行順まで変わり、pending が拒否されても戻りません。`rowMeta.delete()` にも同じ問題があります。また、fork 前に取得した `writableRowOrder` の戻り値を保持していれば、fork 後の共有判定を通らずに変更できます。読み取り側には readonly の行軸と `RowMeta` を公開し、可変な配列・Map を返す代わりに、変更の時点で切り離す内部操作に閉じ込めてください。

- [P2] 1 セル確定時の全チャンク索引コピーを避ける — C:\repo\spreadjs\packages\core\src\cell-store.ts:259-259
  `new Map(chunks)` は書き換えるチャンクだけでなく、割り当て済みチャンクの全エントリを毎回コピーします。例えば各 256 行に 1 セルだけある疎な表では、1 セル確定の費用は空でないセル数に比例し、`rebuildView` では pending 件数分この走査が繰り返されます。密な 5 万行の計測で速いこととは両立します。索引も更新経路だけをコピーする構造にするか、この費用を許容するなら性能保証を O(割り当て済みチャンク数) と明記し、疎な表でも計測してください。

- [P2] 文書の分岐テストで blank と削除済み行のセルも比較する — C:\repo\spreadjs\packages\core\src\fork.test.ts:129-129
  `docContents` がセル比較に使う `canonicalSerialize` は、blank レコードと tombstone 行の全セルを意図的に除外します。そのため、例えば別の枝への書き込みで blank の `lastChangedRevision` だけが変わっても、競合判定に使う値が壊れているのにテストは成功します。`serializeDocument(doc)` などで保存対象の全レコードを比較し、乱択ループの最後だけでなく、漏れが後続の上書きで消える前にも照合してください。

- [P3] fork と深い複製の比較から空チャンクの容量差を分離する — C:\repo\spreadjs\packages\core\src\fork.test.ts:46-46
  `storeContents` は `approxMemoryBytes()` も一致条件にしていますが、最後のセルを消したチャンクは `fork()` に残り、レコードから作り直す `clone()` には残りません。`chunkRows: 4` で 1 セルを登録し `deleteRow` してから分岐すると、どちらも空で正しいのに 32 バイト対 0 バイトになります。論理内容と件数は深い複製と比較し、文字数の計上は同じチャンク配置での増減として別に検証してください。