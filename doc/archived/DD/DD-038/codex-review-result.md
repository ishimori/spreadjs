貼付矩形の計算、拒否・noop・readOnly 分岐、IME、再ベース、通常の選択順序には追加の問題を確認しませんでした。ただし同期イベントからの再入時に consumer の状態変更を上書きするため、現状の呼び出し順序には機能上の欠陥があります。

Review comment:

- [P2] 同期イベント後に利用側の選択変更を上書きしないでください — C:\repo\spreadjs\packages\grid\src\mount-controller.ts:2056-2057
  standalone では `submitSetCells` 内から `cell-commit` が同期発火するため、そのリスナーが公開 API の `setActiveCell` や `setData` を呼ぶと、復帰後の `selectPastedRect` が利用側の変更を上書きし、場合によっては更新前 Axis の矩形を選択します。共同編集でも pending 通知による同様の再入が可能です。選択遷移をイベント公開前に完了させるか、submit 中に activeCell・selection・Axis が変化した場合は後続の選択を行わないようにしてください。