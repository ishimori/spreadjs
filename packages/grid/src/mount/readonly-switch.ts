// 読み取り専用の実行時切替（setReadOnly）・送り切り（flush）・変換の終わり待ち（DD-056 H12・contract.md §4）。
// DD-065 区画⑤の切り替え側。readOnly の状態の持ち主はこの部品だけで、ほかの部品は isReadOnly() などで読む。

import type { DiagnosticSink } from '../diagnostics';
import { decideFlush, resolveFlushTimeout, timeoutResult } from '../flush-state';
import type { GridBackend } from '../grid-backend';
import type { GridFlushOptions, GridFlushResult } from '../index';
import type { IntegrationEditor } from '../integration-editor';
import { errorMessage } from './constants';

/** GridInstance.flush の待ち合わせ 1 件（DD-056 H12）。 */
interface FlushWaiter {
  readonly resolve: (result: GridFlushResult) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * 呼んだ時点の編集（ime-editing-session の editingTarget の参照）。確定・取消・別セルへの移動で編集が入れ替われば null にする
   * （後から始まった別の編集には触れない・Codex 実装レビュー P2）。null なら確定を待つ編集はない。
   */
  editTarget: object | null;
}

export interface ReadOnlySwitchDeps {
  readonly diag: DiagnosticSink;
  /** mount オプションの readOnly（JS 経路の非 boolean も受ける）。 */
  readonly initialReadOnly: unknown;
  isDestroyed(): boolean;
  backend(): GridBackend | undefined;
  editor(): IntegrationEditor | undefined;
  /** 開いている候補欄・日付カレンダーを閉じる（選択式 → 日付の順）。 */
  closePopups(): void;
  /** アクティブセルのロックを常駐 textarea へ同期する。 */
  syncCellLock(): void;
}

export interface ReadOnlySwitch {
  isReadOnly(): boolean;
  /** 変換の終わり待ちの間か（textarea の既定の cut も止める）。 */
  isDeferred(): boolean;
  /** 変換の終わり待ちの間に、切り替えを頼まれた時点の編集を確定している最中か（送信の関所で通す判定）。 */
  isDeferredEditorCommit(): boolean;
  /** 変換の終わり待ちの間に、切り替えを頼まれた時点の編集が終わって Navigation へ戻ったか（新しい編集を始めさせない）。 */
  isDeferredLockIdle(): boolean;
  setReadOnly(next: boolean): void;
  flush(options: GridFlushOptions | undefined): Promise<GridFlushResult>;
  /** 状態の変化（pending・接続・編集）を受けた判定を macrotask へ予約する（待つものが無ければ何もしない）。 */
  scheduleEditStateCheck(): void;
  /**
   * editor 経路の確定を送る。変換の終わり待ちの間は「切り替えを頼まれた時点の編集」の確定 1 回だけを送信の関所で通す
   * （確定中の editingTarget は ime-editing-session が submit の後に外すため、ここで参照を比べられる）。
   */
  runEditorCommit<T>(submit: () => T): T;
  /** destroy: 判定の予約を取り消し、待っている flush を解決する（送り切っていれば flushed・残っていれば stopped）。 */
  dispose(): void;
}

export function createReadOnlySwitch(deps: ReadOnlySwitchDeps): ReadOnlySwitch {
  const { diag } = deps;
  // DD-033-1: 表示専用モード（readOnly）。両モード共通。boolean 単値ゆえ構成不整合が無く fail-fast なし。
  // TS 型（boolean|undefined）が正規経路を強制するが、JS 経路の非 boolean は `=== true` の厳密判定で編集可能側へ倒し、
  // undefined 以外の非 boolean は mount 時に診断 warn（readonly-invalid・公開 error code へは追加しない・決定事項）。
  // DD-056 H12: mount 時の値は初期値で、実行中は GridInstance.setReadOnly で切り替える（開き直さない）。入口・送信の関所は
  // 呼ばれた時点の値を読む。
  const rawReadOnly = deps.initialReadOnly;
  let readOnly = rawReadOnly === true;
  // DD-056 H12: IME 変換中に setReadOnly(true) を受けたとき、変換が終わるまで textarea の読み取り専用化（と編集中セルの確定）を
  // 待つ印。待つ間も readOnly=true で文書を変える他の入口は止め、状態機械が出す編集中セルの確定（editorSubmit 経由）だけを
  // 送信の関所で通す（contract.md §4.3）。
  let readOnlyDeferred = false;
  // DD-056 H12（Codex 実装レビュー P1）: 終わり待ちの間に送信の関所を通してよいのは「切り替えを頼まれた時点の編集」の確定 1 回だけ。
  // 編集の同一性は ime-editing-session の editingTarget オブジェクトの参照（BeginEdit ごとに作り直される）で見分ける。
  let deferredLockEditTarget: object | null = null;
  // DD-056 H12: 上の許可を消費して submit している最中か（submitSetCells・submitToBackend の関所が見る）。
  let inDeferredLockCommit = false;
  // DD-056 H12: flush の待ち合わせ（呼び出しごとに 1 件）と、状態の変化を受けた判定の予約（macrotask・coalesce）。
  const flushWaiters = new Set<FlushWaiter>();
  let editStateCheckTimer: ReturnType<typeof setTimeout> | undefined;
  if (rawReadOnly !== undefined && typeof rawReadOnly !== 'boolean') {
    diag.emit('warn', 'readonly-invalid', `readOnly は boolean が必要（受領: ${typeof rawReadOnly}）→ 編集可能として扱う`);
  }
  if (readOnly) {
    // mount 時に1件（E2E/障害切り分けの確認点・決定事項）。抑止発動ごとの readonly-blocked とは別。
    diag.emit('info', 'readonly-mode', '表示専用モード（readOnly=true）でマウント: 文書変更を抑止し閲覧系のみ許可');
  }

  function isDeferredEditorCommit(): boolean {
    return readOnlyDeferred && inDeferredLockCommit;
  }

  /**
   * 進行中の編集の同一性（ime-editing-session の editingTarget の参照。BeginEdit ごとに作り直され、確定・取消・移動で null に戻る）。
   * 編集していなければ null。flush の待ち合わせと変換の終わり待ちの許可が「呼んだ時点の編集」を見分けるのに使う。
   */
  function currentEdit(): object | null {
    return deps.editor()?.session.getEditingTarget() ?? null;
  }

  /** IME 変換中か（textarea に触れてはいけない間・I-3）。 */
  function isComposingNow(): boolean {
    const editor = deps.editor();
    return editor !== undefined && (editor.session.isComposing() || editor.session.getPhase() === 'Composing');
  }

  /**
   * 変換の終わり待ちの間に、切り替えを頼まれた時点の編集が終わって Navigation へ戻ったか（Codex 実装レビュー P1）。true の間は
   * 新しい編集を始めさせない（editor の論理ロック＝isInputLocked。textarea の readOnly 属性は次の判定で付く）。
   */
  function isDeferredLockIdle(): boolean {
    const editor = deps.editor();
    return readOnlyDeferred && editor !== undefined && !isComposingNow() && editor.session.getPhase() === 'Navigation';
  }

  /**
   * 編集中のセルを「確定して移動しない」で確定し、候補欄を閉じる（実際の blur と同じ順序＝状態機械の確定 → 候補欄・contract.md §4.2）。
   * 変換確定の直後（EditingAwaitFinalInput）も確定する。変換中は何もせず false。確定した・確定するものが無ければ true。
   * IME イベントとは別のタスク（consumer の API 呼び出し・macrotask の判定）から呼ぶこと。
   */
  function commitInProgressEdit(): boolean {
    // DD-056（Codex 実装レビュー P1）: 接続が終端した後は確定しない（ClientSession.submitLocalOperation が throw する＝flush の reject や
    // macrotask の未捕捉例外になる）。編集はそのまま残し、確定できなかったとして扱う。
    if (deps.backend()?.session.isStopped === true) {
      return false;
    }
    const editor = deps.editor();
    if (editor !== undefined) {
      try {
        if (editor.commitEdit() === 'composing') {
          return false;
        }
      } catch (error) {
        diag.emit('error', 'commit-edit-failed', `編集中のセルの確定に失敗しました: ${errorMessage(error)}`);
        return false;
      }
    }
    deps.closePopups();
    return true;
  }

  /** 編集中のセルを確定してから、textarea まで含めて表示専用へ切り替える（変換中でないときに呼ぶ）。 */
  function applyReadOnlyLock(): void {
    // 先に確定する: 直接の呼び出しでは readOnly=false のまま通常経路で、変換の終わり待ちからは関所の許可つき（editorSubmit 経由）で送る。
    commitInProgressEdit();
    deps.closePopups(); // 接続の終端で確定しなかったときも候補欄は閉じる（閉じていれば何もしない）
    readOnlyDeferred = false;
    deferredLockEditTarget = null;
    readOnly = true;
    deps.editor()?.setReadOnly(true);
    deps.syncCellLock();
    deps.backend()?.view.markViewportDirty();
    diag.emit('info', 'readonly-mode', 'setReadOnly(true): 表示専用へ切り替え（開き直さない・未送信の操作は保持して送る）');
  }

  /** setReadOnly の実体（DD-056 H12・contract.md §4.3）。 */
  function setReadOnly(next: boolean): void {
    if (deps.isDestroyed()) {
      return;
    }
    if (next) {
      if (readOnly && !readOnlyDeferred) {
        return; // 既に表示専用
      }
      if (isComposingNow()) {
        if (!readOnlyDeferred) {
          // 文書を変える他の入口はすぐ止め、textarea は変換が終わってから（I-3）。変換の終わりは editor の変化で判定し直す。
          readOnly = true;
          readOnlyDeferred = true;
          // 送信の関所で通すのは、いま変換中の編集の確定 1 回だけ（Codex 実装レビュー P1）。
          deferredLockEditTarget = currentEdit();
          // 候補欄（選択式の候補リスト・日付）は今閉じる（textarea には触れない）。開いたままだと、変換の後の候補クリックが
          // 編集中の値を取り消してから読み取り専用で断られ、入力が失われる（Codex 実装レビュー P1）。
          deps.closePopups();
          deps.backend()?.view.markViewportDirty();
          diag.emit('info', 'readonly-deferred', 'setReadOnly(true): IME 変換中のため、変換が終わってから編集中のセルを確定して textarea を読み取り専用にする');
        }
        return;
      }
      applyReadOnlyLock();
      scheduleEditStateCheck(); // 確定した編集で flush の待ち合わせが解けうる
      return;
    }
    if (!readOnly) {
      return;
    }
    readOnly = false;
    readOnlyDeferred = false; // 変換の終わり待ちの切り替えは取り消す
    deferredLockEditTarget = null;
    deps.editor()?.setReadOnly(false);
    deps.syncCellLock();
    deps.backend()?.view.markViewportDirty();
    diag.emit('info', 'readonly-mode', 'setReadOnly(false): 編集可能へ切り替え');
  }

  /** 変換の終わり待ちの切り替えを、変換が終わっていれば完了させる（macrotask の判定から呼ぶ）。 */
  function evaluateDeferredReadOnly(): void {
    if (!readOnlyDeferred || deps.isDestroyed() || isComposingNow()) {
      return;
    }
    applyReadOnlyLock();
  }

  /** flush の待ち合わせ 1 件を解決する（二重解決しない）。 */
  function settleFlushWaiter(waiter: FlushWaiter, result: GridFlushResult): void {
    if (!flushWaiters.delete(waiter)) {
      return;
    }
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
    }
    waiter.resolve(result);
  }

  /** waiter が呼んだ時点の編集がまだ続いているか（確定・取消・移動で終わっていれば、後から始まった別の編集は待たない）。 */
  function isWaiterEditPending(waiter: FlushWaiter): boolean {
    return waiter.editTarget !== null && waiter.editTarget === currentEdit();
  }

  /**
   * flush の待ち合わせを判定する。接続の終端を先に見る（終端後は確定しない・Codex 実装レビュー P1）。呼んだ時点の編集が続いていれば
   * 確定を試み（変換中なら待つ）、終わっていれば後から始まった別の編集には触れない（Codex 実装レビュー P2）。
   */
  function evaluateFlushWaiters(): void {
    if (flushWaiters.size === 0) {
      return;
    }
    const stopped = deps.backend()?.session.isStopped === true;
    for (const waiter of flushWaiters) {
      if (!isWaiterEditPending(waiter)) {
        waiter.editTarget = null;
      }
    }
    // destroyed は使う時点で読む（確定の通知を受けた購読者がその場で destroy() を呼ぶことがある）。
    if (!deps.isDestroyed() && !stopped && [...flushWaiters].some((waiter) => waiter.editTarget !== null) && commitInProgressEdit()) {
      for (const waiter of flushWaiters) {
        waiter.editTarget = null;
      }
    }
    const pendingCount = deps.backend()?.session.pendingCount ?? 0;
    for (const waiter of [...flushWaiters]) {
      const result = decideFlush({ destroyed: deps.isDestroyed(), stopped, pendingCount, editPending: waiter.editTarget !== null });
      if (result !== undefined) {
        settleFlushWaiter(waiter, result);
      }
    }
  }

  /**
   * 状態の変化（pending・接続・編集）を受けた判定を macrotask へ予約する（coalesce）。ClientSession のメッセージ処理中・editor の
   * イベント処理中に確定を走らせない（再入しない）。同じタスクで続く IME イベント（最終 input 等）を先に処理させる（contract.md §4.2）。
   * 待つものが無ければ何もしない（通常の編集・受信にコストを足さない）。
   */
  function scheduleEditStateCheck(): void {
    if (editStateCheckTimer !== undefined || deps.isDestroyed() || (!readOnlyDeferred && flushWaiters.size === 0)) {
      return;
    }
    editStateCheckTimer = setTimeout(() => {
      editStateCheckTimer = undefined;
      if (deps.isDestroyed()) {
        return;
      }
      evaluateDeferredReadOnly();
      evaluateFlushWaiters();
    }, 0);
  }

  /** flush の実体（DD-056 H12・contract.md §4.4）。 */
  function flush(options: GridFlushOptions | undefined): Promise<GridFlushResult> {
    if (deps.isDestroyed()) {
      return Promise.resolve({ status: 'stopped', pendingCount: 0 });
    }
    const timeoutMs = resolveFlushTimeout(options?.timeoutMs);
    return new Promise<GridFlushResult>((resolve) => {
      const waiter: FlushWaiter = { resolve, timer: undefined, editTarget: currentEdit() };
      flushWaiters.add(waiter);
      waiter.timer = setTimeout(() => {
        settleFlushWaiter(
          waiter,
          timeoutResult({ pendingCount: deps.backend()?.session.pendingCount ?? 0, editPending: isWaiterEditPending(waiter) }),
        );
      }, timeoutMs);
      // 呼び出し時に 1 回判定する（consumer の API 呼び出し＝IME イベントとは別のタスクなので、ここで確定してよい）。
      evaluateDeferredReadOnly();
      evaluateFlushWaiters();
      scheduleEditStateCheck(); // 待ちが残れば、以後は状態の変化で判定し直す
    });
  }

  return {
    isReadOnly: () => readOnly,
    isDeferred: () => readOnlyDeferred,
    isDeferredEditorCommit,
    isDeferredLockIdle,
    setReadOnly,
    flush,
    scheduleEditStateCheck,
    runEditorCommit(submit) {
      const editor = deps.editor();
      const allowDuringDeferredLock =
        readOnlyDeferred &&
        deferredLockEditTarget !== null &&
        editor !== undefined &&
        editor.session.getEditingTarget() === deferredLockEditTarget;
      if (allowDuringDeferredLock) {
        deferredLockEditTarget = null;
      }
      inDeferredLockCommit = allowDuringDeferredLock;
      try {
        return submit();
      } finally {
        inDeferredLockCommit = false;
      }
    },
    dispose() {
      if (editStateCheckTimer !== undefined) {
        clearTimeout(editStateCheckTimer);
        editStateCheckTimer = undefined;
      }
      const pendingAtDestroy = deps.backend()?.session.pendingCount ?? 0;
      for (const waiter of [...flushWaiters]) {
        settleFlushWaiter(
          waiter,
          decideFlush({ destroyed: true, stopped: false, pendingCount: pendingAtDestroy, editPending: waiter.editTarget !== null }) ?? {
            status: 'stopped',
            pendingCount: pendingAtDestroy,
          },
        );
      }
    },
  };
}
