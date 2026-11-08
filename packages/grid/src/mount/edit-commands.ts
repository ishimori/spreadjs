// 編集の命令（範囲クリア・clipboard の copy/cut/paste・Undo/Redo の補償・実行前拒否の通知）。DD-065 区画⑦の後半。
// 生成は mount 時、backend への結線は attach で行う。結線前の操作は何もしない（従来は attachBackendRendering の中だけにあった）。

import { parseClipboardText, validateOperation } from '@nanairo-sheet/core';
import type { SetCellsOperation } from '@nanairo-sheet/core';
import type { MergeIndex } from '@nanairo-sheet/selection';

import { buildPaste, serializeSelectionToTsv, shouldInterceptClipboard } from '../clipboard-controller';
import type { ClipboardDocumentPort, PasteRect } from '../clipboard-controller';
import type { DiagnosticSink } from '../diagnostics';
import type { GridConflictCode } from '../error-codes';
import type { GridBackend } from '../grid-backend';
import type { EditingDocumentPort } from '../ime-editing-session';
import type { GridEvent } from '../index';
import type { IntegrationEditor } from '../integration-editor';
import { buildRangeClear } from '../range-ops';
import type { SelectionController } from '../selection-controller';
import type { UndoController } from '../undo-stack';
import type { CellLock } from './cell-lock';
import type { EditSubmit } from './edit-submit';

export interface EditCommandsDeps {
  readonly diag: DiagnosticSink;
  readonly isStandalone: boolean;
  readonly stringColumnStrings: ReadonlySet<string>;
  readonly selectionCtrl: SelectionController;
  readonly undoCtrl: UndoController;
  readonly cellLock: Pick<CellLock, 'filterReadOnlyCells'>;
  readonly editSubmit: Pick<EditSubmit, 'submitSetCells' | 'submitToBackend' | 'cellRevision' | 'rejectInvalidCells'>;
  readonly merges: { any(): boolean; current(): MergeIndex };
  emit(event: GridEvent): void;
  editor(): IntegrationEditor | undefined;
  isReadOnly(): boolean;
  /** 開いている候補欄・日付カレンダーを閉じる（アクティブセルを動かす時の規約）。 */
  closePopups(): void;
}

export interface EditCommands {
  /** backend へ結線する（範囲の読み取り・貼り付けの境界・コピーの書き出しのポートを作る）。 */
  attach(backend: GridBackend): void;
  /** IME の編集セッションが文書を読むポート（attach 後に有効）。 */
  documentPort(): EditingDocumentPort;
  /** 実行前拒否（上限超過・はみ出し・非候補値）の通知。共同編集モードだけ公開 rejected を出す。 */
  notifyPreExecutionReject(code: GridConflictCode, diagCode: string, detail: string): void;
  performRangeClear(): void;
  performCopy(): string | null;
  performCut(): string | null;
  performPaste(text: string): boolean;
  performUndo(): void;
  performRedo(): void;
}

export function createEditCommands(deps: EditCommandsDeps): EditCommands {
  const { diag, isStandalone, selectionCtrl, undoCtrl, cellLock, editSubmit, merges } = deps;
  let backend: GridBackend | undefined;
  let docPort: EditingDocumentPort | undefined;
  let clipPort: ClipboardDocumentPort | undefined;
  let copyPort: ClipboardDocumentPort | undefined;

  /**
   * 実行前拒否（上限超過・はみ出し）の通知（範囲クリア／paste／cut 共有）。診断は常に出す。公開 rejected は
   * **共同編集モードのみ**発火する: standalone は DD-024 契約（ClientSession/transport 非生成＝
   * connection/pending/rejected/divergence 非発火）を守り、client 側実行前拒否を server 競合の rejected 経路へ
   * 混ぜない（consumer が collab 競合と誤認しないため。standalone は診断のみ・Codex[P2]）。operationId は空＝未 submit。
   */
  function notifyPreExecutionReject(code: GridConflictCode, diagCode: string, detail: string): void {
    diag.emit('warn', diagCode, detail);
    if (isStandalone || backend === undefined) {
      return;
    }
    deps.emit({
      type: 'rejected',
      pendingCount: backend.session.pendingCount,
      conflict: { operationId: '', reason: 'rejected', code },
    });
  }

  /**
   * 範囲クリア（DD-020-1 AC5/AC6）: 明示レンジを 1 つの原子的 SetCells（非空セルのみ・beforeRevision 付き）
   * で blank 化する。生成・上限検査は range-ops（純粋関数）・submit は IME 確定と同じ共有経路（submitSetCells）。
   * 上限超過は submit せず notifyPreExecutionReject（共同編集は rejected code=range-too-large・standalone は診断のみ）。
   * レンジは維持する（AC5: Delete は解除トリガーではない／AC6: 縮めて再実行できる）。
   */
  function performRangeClear(): void {
    if (backend === undefined || docPort === undefined) {
      return;
    }
    if (deps.isReadOnly()) {
      diag.emit('info', 'readonly-blocked', 'readOnly: 範囲クリアを抑止（文書無変更）');
      return;
    }
    const range = selectionCtrl.getRange();
    if (range === null) {
      return; // 裁定（delete-range）と実行の間に状態が変わった場合の防御（何もしない）
    }
    const outcome = buildRangeClear(docPort, range);
    switch (outcome.kind) {
      case 'noop':
        return; // 範囲内が全て空 → 変更なし（submit しない）
      case 'too-large':
        notifyPreExecutionReject(
          'range-too-large',
          'range-clear-too-large',
          `範囲 ${outcome.cellCount} セル > 上限 ${outcome.limit}（拒否）`,
        );
        return;
      case 'submit': {
        // DD-035 R4: readOnly 列のセルはスキップして他列だけクリアする（全件スキップなら no-op）。
        const op = cellLock.filterReadOnlyCells(outcome.operation, '範囲クリア');
        if (op === null) {
          return;
        }
        editSubmit.submitSetCells(op);
        // 前段消費のため editor onChange（markViewportDirty）が走らない → 楽観適用の再描画をここで要求する。
        backend.view.markCellDirty();
        return;
      }
    }
  }

  // ---- DD-020-2 clipboard（copy/cut/paste）----
  // 裁定: Navigation 位相かつ非 composing のみグリッド Command 化（親 D5）。編集/変換中はブラウザ既定
  // （textarea 内テキスト編集）へ委譲し、composition の value/selection に介入しない（I-3）。
  function clipboardActive(): boolean {
    const editor = deps.editor();
    return editor !== undefined && shouldInterceptClipboard(editor.session.getPhase(), editor.session.isComposing());
  }

  /** copy: 選択範囲（未選択時は activeCell 単一）の表示文字列を TSV 化して返す（書き出しは integration-editor）。 */
  function performCopy(): string | null {
    const editor = deps.editor();
    if (copyPort === undefined || editor === undefined || !clipboardActive()) {
      return null; // 非 Navigation → ブラウザ既定（textarea copy）
    }
    const range = selectionCtrl.selectedRange(editor.session.getActiveCell());
    return serializeSelectionToTsv(copyPort, range);
  }

  /**
   * cut（親④）: copy＋即時範囲クリア（移動セマンティクスにしない）。クリアが上限超過なら**cut 全体を拒否**し
   * （copy もしない＝クリップボード不変）通知する。クリア対象が全空でも copy は成立させる（TSV を返す）。
   */
  function performCut(): string | null {
    if (backend === undefined || docPort === undefined || copyPort === undefined) {
      return null;
    }
    if (deps.isReadOnly()) {
      // cut は copy＋クリア＝文書変更系ゆえ全抑止（clipboard も変更しない・null=ブラウザ既定は readOnly textarea で no-op）。
      diag.emit('info', 'readonly-blocked', 'readOnly: cut を抑止（文書無変更・クリップボード不変）');
      return null;
    }
    const editor = deps.editor();
    if (editor === undefined || !clipboardActive()) {
      return null;
    }
    const range = selectionCtrl.selectedRange(editor.session.getActiveCell());
    const outcome = buildRangeClear(docPort, range);
    if (outcome.kind === 'too-large') {
      notifyPreExecutionReject(
        'range-too-large',
        'cut-too-large',
        `cut 範囲 ${outcome.cellCount} セル > 上限 ${outcome.limit}（拒否）`,
      );
      return null; // クリップボードは変更しない（Navigation の空 textarea への既定 cut は no-op）
    }
    const tsv = serializeSelectionToTsv(copyPort, range);
    if (outcome.kind === 'submit') {
      // DD-035 R4: cut のクリアは readOnly 列をスキップ（copy＝TSV は全列そのまま＝閲覧系）。
      const op = cellLock.filterReadOnlyCells(outcome.operation, 'cut');
      if (op !== null) {
        editSubmit.submitSetCells(op);
        backend.view.markCellDirty();
      }
    }
    return tsv;
  }

  /**
   * DD-038: 貼り付け後に貼付矩形を選択レンジにする（Excel 準拠）。**書き込みが起きる submit 経路からのみ**呼ぶ
   * （拒否・noop・readOnly 全件スキップは文書無変更ゆえ選択も動かさない＝決定④⑦）。
   * 呼ぶのは submitSetCells の**前**（呼び出し側のコメント参照＝同期イベントからの再入で consumer の
   * setActiveCell / setData を上書きしないため）。
   *
   * **呼ぶ順序が本質**: 先に activeCell を矩形の左上へ移し、その後で extendTo する。selection-controller の
   * 不変条件は「明示レンジは anchor === activeCell（値一致）の間だけ存在する」で、onChange の syncWithEditor が
   * 破れを検出してレンジを解除する（DD-020-1 AC4）。そして**貼付アンカー（矩形の左上）は activeCell と一致するとは
   * 限らない**: 右下から左上へドラッグ選択した場合、選択 anchor = activeCell = 右下・矩形の左上は別セルになる
   * （rangeFromAnchorFocus が正規化するのは矩形であって anchor ではない）。左上へ寄せずに extendTo すると
   * anchor ≠ activeCell となり、貼った直後は見えていても次の editor イベントで選択が消える。
   * pointerdownCell が同期的に onChange を起こして既存レンジを解除するため、extendTo は必ずその後に呼ぶ。
   *
   * ポップアップを閉じるのは「activeCell を動かす時は開いているポップアップを閉じる」既存規約に合わせるため
   * （クリック経路・setActiveCell と同じ。開いていなければ no-op）。
   */
  function selectPastedRect(rect: PasteRect): void {
    const editor = deps.editor();
    if (editor === undefined) {
      return;
    }
    const topLeft = { row: rect.anchorRow, col: rect.anchorCol };
    const bottomRight = {
      row: rect.anchorRow + rect.targetRows - 1,
      col: rect.anchorCol + rect.targetCols - 1,
    };
    const active = editor.session.getActiveCell();
    if (active.row !== topLeft.row || active.col !== topLeft.col) {
      deps.closePopups();
      editor.pointerdownCell(topLeft); // onChange → syncWithEditor が既存レンジを解除する（この後に張り直す）
    }
    // 1×1 の貼り付けは setRange が単一選択へ正規化する（明示レンジを作らない＝見た目不変・AC3）。
    // out-of-bounds を通過した矩形なので表示 Axis 内が保証され、境界クランプは不要。
    selectionCtrl.extendTo(topLeft, bottomRight);
  }

  /**
   * paste: text/plain → parse → 敷き詰め/はみ出し全体拒否/上限/型変換 → 原子 SetCells（buildPaste）。
   * Navigation では**必ず消費**（true 返却＝preventDefault）する。消費しないと browser 既定が textarea へ
   * ペーストテキストを流し込み Navigation の input が編集を開始してしまう（グリッド paste 意図と乖離）。
   * 成功時は貼付範囲を選択レンジにする（selectPastedRect・DD-038）。
   */
  function performPaste(text: string): boolean {
    if (backend === undefined || clipPort === undefined) {
      return false;
    }
    if (deps.isReadOnly()) {
      // 消費（true=preventDefault）して readOnly textarea への流し込みも止める（文書無変更）。
      diag.emit('info', 'readonly-blocked', 'readOnly: paste を抑止（文書無変更）');
      return true;
    }
    const editor = deps.editor();
    if (editor === undefined || !clipboardActive()) {
      return false; // 編集/変換中は textarea へテキスト挿入（ブラウザ既定）
    }
    const matrix = parseClipboardText(text);
    const range = selectionCtrl.selectedRange(editor.session.getActiveCell());
    const outcome = buildPaste(clipPort, matrix, range, (columnId) => deps.stringColumnStrings.has(columnId));
    switch (outcome.kind) {
      case 'noop':
        return true; // 空 paste・全欠け → 消費のみ（textarea へ入れない）
      case 'too-large':
        notifyPreExecutionReject(
          'paste-too-large',
          'paste-too-large',
          `貼り付け ${outcome.cellCount} セル > 上限 ${outcome.limit}（拒否）`,
        );
        return true;
      case 'out-of-bounds':
        notifyPreExecutionReject(
          'paste-out-of-bounds',
          'paste-out-of-bounds',
          `貼り付け ${outcome.rows}×${outcome.cols} が行/列端を越える（拒否）`,
        );
        return true;
      case 'submit': {
        // DD-035 R4 / DD-036 C3: readOnly 列・行のセルはスキップして他へ貼り付ける（TSV 位置不変・全件スキップなら消費のみ）。
        const op = cellLock.filterReadOnlyCells(outcome.operation, '貼り付け');
        if (op === null) {
          return true; // DD-038 決定⑦: 文書無変更 → 選択も activeCell も動かさない（拒否・noop と同じ扱い）
        }
        // DD-063: 1 件でも validateCell が拒否したら全体を拒否する（全成功/全失敗・選択も動かさない＝決定⑦と同じ）。
        if (editSubmit.rejectInvalidCells(op, 'paste')) {
          return true;
        }
        // DD-038（Codex P2）: 選択遷移は submit の**前**に完了させる。単独モードは submitLocalOperation の
        // 内側から cell-commit を同期発火し（standalone-session）、共同編集も pending 通知で同様に再入しうる。
        // その購読者が公開 API（setActiveCell / setData）を呼んだ場合、submit の後に選択を動かすと consumer の
        // 変更を上書きしてしまう（setData なら更新前 Axis の矩形を選ぶ）。先に選んでおけば「最後に書いた側が勝つ」。
        selectPastedRect(outcome.rect); // 貼付範囲を選択レンジにする（Excel 準拠・書き込みが起きる経路でのみ）
        editSubmit.submitSetCells(op);
        backend.view.markCellDirty();
        return true;
      }
    }
  }

  // ---- DD-020-3 Undo/Redo（補償 SetCells・親③）----
  /**
   * 補償 SetCells（undo/redo が生成した逆/順値の op）を submit する。**submitSetCells とは別経路**で、
   * 新規 undo エントリを積まない（積むと無限記録＋redo 破壊になる）。standalone は即時確定ゆえ committed から
   * revision を読んで即解決し、collab は operationId を紐づけて ACK/reject を待つ（onCommitted/onRejected）。
   */
  function submitCompensation(sync: GridBackend, op: SetCellsOperation): void {
    // 事前 OCC 検査（Codex P1）: undo/redo は pendingCount===0 でのみ発火＝committed が唯一の検証基底ゆえ、
    // validateOperation(committed, op) が submitLocalOperation の同期 reject を正確に予測する。違反があれば submit せず
    // block 確定する（opId 紐づけ前に同期 reject が observer を発火させ limbo を永久 busy にする問題を回避）。
    // server だけが知る競合（ローカル未反映＝offline reconnect 等）は submit 後（opId 紐づけ済み）の async reject が拾う。
    if (validateOperation(sync.session.committedDocument, op).length > 0) {
      notifyCompensationBlocked(sync, undoCtrl.blockInFlightCompensation(), '');
      sync.view.markCellDirty();
      return;
    }
    const id = editSubmit.submitToBackend(sync, op);
    sync.view.markCellDirty(); // 前段消費で editor onChange が走らない → 楽観適用の再描画をここで要求
    if (isStandalone) {
      const first = op.changes[0]!;
      undoCtrl.resolveCompensationCommitted(editSubmit.cellRevision(sync.session.committedDocument, first.rowId, first.columnId));
    } else if (id !== undefined) {
      undoCtrl.setCompensationOperationId(id);
    } else {
      undoCtrl.abortInFlightCompensation(); // collab で opId 取得不可（stopped 等）→ in-flight を巻き戻す
    }
  }

  /** 補償拒否（pre-check stale）の通知。共同編集のみ公開 rejected を発火する（standalone は診断のみ＝DD-024 契約）。 */
  function notifyCompensationBlocked(sync: GridBackend, block: 'undo-blocked' | 'redo-blocked' | undefined, operationId: string): void {
    if (block === undefined) {
      return;
    }
    diag.emit('warn', 'undo-blocked', `${block} op=${operationId}（実行前 OCC 拒否）`);
    if (!isStandalone) {
      deps.emit({ type: 'rejected', pendingCount: sync.session.pendingCount, conflict: { operationId, reason: 'rejected', code: block } });
    }
  }

  /** Ctrl/Cmd+Z: 直前の確定操作を補償 SetCells で戻す（空/pending/in-flight/stopped は no-op）。 */
  function performUndo(): void {
    if (backend === undefined) {
      return;
    }
    if (deps.isReadOnly()) {
      diag.emit('info', 'readonly-blocked', 'readOnly: Undo を抑止（文書無変更）');
      return;
    }
    if (backend.session.isStopped) {
      return;
    }
    const built = undoCtrl.beginUndo(backend.session.pendingCount);
    if (built !== null) {
      submitCompensation(backend, built.operation);
    }
  }

  /** Ctrl+Y / Ctrl+Shift+Z: Undo の逆（元値の再適用）。 */
  function performRedo(): void {
    if (backend === undefined) {
      return;
    }
    if (deps.isReadOnly()) {
      diag.emit('info', 'readonly-blocked', 'readOnly: Redo を抑止（文書無変更）');
      return;
    }
    if (backend.session.isStopped) {
      return;
    }
    const built = undoCtrl.beginRedo(backend.session.pendingCount);
    if (built !== null) {
      submitCompensation(backend, built.operation);
    }
  }

  return {
    attach(next) {
      backend = next;
      const sync = next;
      // IME×backend の結線（値の源は backend.session／backend.view）。
      docPort = {
        getCommittedDocument: () => sync.session.committedDocument,
        displayText: (rowId, columnId) => sync.view.cellDisplay(rowId, columnId),
        rowIdAt: (index) => sync.view.rowIdAt(index),
        colIdAt: (index) => sync.view.columnIdAt(index),
        rowIndexOf: (rowId) => sync.view.rowIndexOf(rowId),
        colIndexOf: (columnId) => sync.view.colIndexOf(columnId),
      };
      // DD-020-2 clipboard: docPort（範囲読み取り）＋表示 Axis の寸法（貼り付けはみ出し判定の境界）。
      const readPort: ClipboardDocumentPort = {
        getCommittedDocument: () => sync.session.committedDocument,
        displayText: (rowId, columnId) => sync.view.cellDisplay(rowId, columnId),
        rowIdAt: (index) => sync.view.rowIdAt(index),
        colIdAt: (index) => sync.view.columnIdAt(index),
        rowCount: () => sync.view.rowAxis.count(),
        colCount: () => sync.view.colAxis.count(),
      };
      clipPort = readPort;
      // DD-064: コピー（cut の書き出しも）用のポート。結合範囲の左上以外のセルは空として書く（左上に値・残りは空＝Excel と同じ。
      // 範囲の中の他のセルに値があっても描いていないので書き出さない）。結合が無ければ clipPort と同じ値。
      copyPort = {
        ...readPort,
        displayText: (rowId, columnId) => {
          if (merges.any()) {
            const row = sync.view.rowIndexOf(rowId);
            const col = sync.view.colIndexOf(columnId);
            const merge = row >= 0 && col >= 0 ? merges.current().at(row, col) : undefined;
            if (merge !== undefined && (merge.rowStart !== row || merge.colStart !== col)) {
              return '';
            }
          }
          return sync.view.cellDisplay(rowId, columnId);
        },
      };
    },
    documentPort() {
      if (docPort === undefined) {
        throw new Error('edit-commands: attach の前に documentPort は使えない');
      }
      return docPort;
    },
    notifyPreExecutionReject,
    performRangeClear,
    performCopy,
    performCut,
    performPaste,
    performUndo,
    performRedo,
  };
}
