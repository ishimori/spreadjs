// grid Facade の mount 配線（旧 apps/playground/src/integration/main.ts を昇華）。
//
// pocb の Canvas 基盤（render）を使い、値の源を ClientSession（共同編集の唯一の正本）→ DocumentView（読み取り
// アダプター）に置く。IME は編集状態機械＋常駐 textarea（integration-editor）。挙動は main.ts と等価に保ちつつ、
// ①DOM は container 内に構築（dom-scaffold・D4）②SessionEvent を GridEvent へ写像して購読者へ配信③readout 表示は
// 持たず、代わりに destroy() で全リソース（RAF/interval/listener/ResizeObserver/WS/canvas/textarea）を解放する
// （再mountで leak しない・AC2）④E2E 用 introspection は debugRegistry 経由（test-support）で露出する。

import { createTextMetricsCache } from '@nanairo-sheet/render';
import type { TextMetricsCache } from '@nanairo-sheet/render';

import { createLoadMetrics } from './initial-load-metrics';
import { buildScaffold } from './dom-scaffold';
import { createSelectionController } from './selection-controller';
import { createUndoController } from './undo-stack';
import { createDiagnosticSink } from './diagnostics';
import { debugRegistry } from './internal';
import { createCellStatusStore } from './cell-status';
import type {
  GridCellStatusRow,
  GridCollaborationMountOptions,
  GridConnectionState,
  GridFlushOptions,
  GridFlushResult,
  GridInstance,
  GridMergedCell,
  GridMountOptions,
  GridMountTarget,
  GridPresenceUser,
  GridStandaloneData,
  GridStandaloneRow,
} from './index';
import { HEADER_HEIGHT } from './mount/constants';
import { createDebugApi } from './mount/debug-api';
import { createEvents } from './mount/events';
import { createCellLock } from './mount/cell-lock';
import { createMerges } from './mount/merges';
import { createReadOnlySwitch } from './mount/readonly-switch';
import { createDateWiring } from './mount/date-wiring';
import { createSelectWiring } from './mount/select-wiring';
import { createEditCommands } from './mount/edit-commands';
import { createEditSubmit } from './mount/edit-submit';
import { createCellHover } from './mount/hover';
import { createLinkClick } from './mount/link-click';
import { registerPointerInteraction } from './mount/pointer';
import { createMountBaseLayer } from './mount/base-layer-options';
import { createCommands } from './mount/commands';
import { createRender } from './mount/render';
import { createEditorWiring } from './mount/editor-wiring';
import { createKeyboard } from './mount/keyboard';
import { createMountConfig } from './mount/config';
import { createLifecycle } from './mount/lifecycle';
/** GridMountOptions を受けて grid を container へ配線し、GridInstance を返す（同期 return・boot は非同期進行）。 */
export function createGridController(target: GridMountTarget, options: GridMountOptions): GridInstance {
  const scaffold = buildScaffold(target.container);
  const { stage, scroller, baseCtx } = scaffold;

  // モード判別（DD-024・決定①）。標準は共同編集（mode 省略時）。単独モードは serverUrl/WS を使わない。
  const isStandalone = options.mode === 'standalone';
  // server 系フィールドは共同編集モードでのみ意味を持つ（単独モードでは未参照・空文字で安全化）。
  const collabOptions = isStandalone ? undefined : (options as GridCollaborationMountOptions);
  const serverOrigin = collabOptions?.serverUrl ?? '';
  const displayName = collabOptions?.displayName ?? `user-${Math.floor(Math.random() * 1000)}`;
  const clientId = collabOptions?.clientId ?? crypto.randomUUID(); // 再接続で不変（S-J4）
  // DD-043: documentId 指定時は `?documentId=` を付けて**接続が文書を名乗る**（複数文書 serve の宛先＝将来の
  // 複数サーバー振り分けの routing キーも兼ねる・ADR-0025）。未指定はサーバーの既定文書へ繋ぐ（従来どおり）。
  const documentQuery =
    collabOptions?.documentId !== undefined ? `?documentId=${encodeURIComponent(collabOptions.documentId)}` : '';
  const wsUrl = serverOrigin === '' ? '' : `${serverOrigin.replace(/^http/, 'ws')}/ws${documentQuery}`;

  const metrics = createLoadMetrics();

  // DD-012-5: 折り返し（wrap）列（ColumnId 文字列）。mount 時固定（D1・実行時切替は Stage 2）。
  const wrapColumns = options.wrapColumns ?? [];
  const wrapColumnStrings = new Set<string>(wrapColumns);
  const wrapEnabled = wrapColumnStrings.size > 0;
  // RC12（DD-052-2）: 文字列として保つ列（ColumnId 文字列）。mount 時固定（wrapColumns と同運用）。
  const stringColumns = options.stringColumns ?? [];
  const stringColumnStrings = new Set<string>(stringColumns);
  // RC14（DD-052-3）: 行操作ショートカット自体の有効・無効（既定 true）。公開 API insertRows/deleteRows は対象外。
  const rowOperationsEnabled = options.rowOperations ?? true;
  // DD-064 K4: 2段の見出し（columnGroups が 1 件以上なら上の段 HEADER_HEIGHT＋下の段 HEADER_HEIGHT）。mount 時固定。
  // 形の検査は列の並びが分かる boot で行う（不正なら配線しない）ので、ここでは件数だけで高さを決める。
  const groupBandHeight = Array.isArray(options.columnGroups) && options.columnGroups.length > 0 ? HEADER_HEIGHT : 0;
  const headerHeight = HEADER_HEIGHT + groupBandHeight;
  // 行分割・文字測定の共有キャッシュ（base-layer 描画と自動行高計算で共有し line 数を一致させる・D4）。
  // measure は baseCtx.measureText（描画と同一フォント計測）。base-layer とキャッシュを共有する。
  const cellTextCache: TextMetricsCache = createTextMetricsCache((text, font) => {
    baseCtx.font = font;
    return baseCtx.measureText(text).width;
  });

  // ---- 組み立てが持つもの（状態の多くは各部品の中にある。持ち主の一覧は DD-065/diagnosis.md §10）----
  // DD-060/062: セルの状態表示の置き場（view-local・両モード共通）。単独モードは列が mount 時に確定するので未知列を
  // 入力時に落とし、共同編集モードは列がサーバーの文書から来るのでそのまま持って描画時に解決する。
  // 列の集合は最初に使うときに作る: mount の同期部分で作ると、JS の consumer が配列でない columnOrder を渡したときに
  // ここで例外になり、boot の検証（standalone-options-invalid の config エラー）へ届かない（Codex P2）。
  const standaloneColumns: unknown = options.mode === 'standalone' ? options.columnOrder : undefined;
  let standaloneColumnSet: ReadonlySet<unknown> | undefined;
  const cellStatusStore = createCellStatusStore(
    options.mode === 'standalone'
      ? (columnId) => (standaloneColumnSet ??= new Set(Array.isArray(standaloneColumns) ? standaloneColumns : [])).has(columnId)
      : undefined,
  );
  // 矩形範囲選択の所有者（DD-020-1 案X）。activeCell の所有は editor-state-machine のまま・レンジのみここが持つ。
  // DD-064: 直前に描いた結合範囲で範囲を広げる（mergeRegistry は下で生成。呼ばれるのは配線後なので前方参照で足りる）。
  const selectionCtrl = createSelectionController({ merges: () => merges.current() });
  // Undo/Redo スタックの所有者（DD-020-3）。確定単位（1 op）ごとに逆値を保持し補償 SetCells を生成する。
  const undoCtrl = createUndoController();

  // ---- 購読・後始末（購読と通知は mount/events.ts）----
  const events = createEvents({
    clientId,
    displayName,
    onEvent: options.onEvent,
    isDestroyed: () => destroyed,
    collabSession: () => lifecycle.collabSession(),
  });
  const emit = events.emit;
  const abort = new AbortController();
  const { signal } = abort;
  let destroyed = false;

  // 診断ログ hook（opt-in・既定無出力）。GridEvent（consumer 契約）とは別系統の障害切り分け用。
  const diag = createDiagnosticSink(options.onDiagnostic);
  // DD-064: 結合（view-local）は mount/merges.ts。張れない・壊れた理由は診断 warn（1 つの指定につき 1 回）。
  const merges = createMerges({
    diag,
    backend: () => lifecycle.backend(),
    editor: () => editorWiring.get(),
    frozenRowCount: () => frozenRowCount,
    frozenColCount: () => frozenColCount,
  });
  const { current: currentMerges } = merges;

  // DD-033-1・DD-056 H12: 読み取り専用の切り替え（setReadOnly・flush・変換の終わり待ち）は mount/readonly-switch.ts。
  // 生成時に mount オプションの readOnly を検査して診断を出す（readonly-invalid・readonly-mode）。
  const readonlySwitch = createReadOnlySwitch({
    diag,
    initialReadOnly: options.readOnly,
    isDestroyed: () => destroyed,
    backend: () => lifecycle.backend(),
    editor: () => editorWiring.get(),
    closePopups: () => {
      select.close();
      date.close();
    },
    syncCellLock: () => cellLock.syncCellLock(),
  });
  const { scheduleEditStateCheck } = readonlySwitch;
  // 読み取り専用の判定（列・行・セル・結合範囲）と、常駐 textarea のロックは mount/cell-lock.ts。
  const cellLock = createCellLock({
    diag,
    isStandalone,
    readOnlyRows: options.readOnlyRows,
    merges,
    backend: () => lifecycle.backend(),
    standalone: () => lifecycle.standalone(),
    editor: () => editorWiring.get(),
    registry: () => config.registry(),
  });
  const { validateReadOnlyRowsOnce, syncCellLock } = cellLock;
  // 送信の関所・Undo の記録・確定前の検証・行操作・再ベース（区画⑦の前半・mount/edit-submit.ts）。
  const editSubmit = createEditSubmit({
    diag,
    isStandalone,
    wrapEnabled,
    validateCell: options.validateCell,
    undoCtrl,
    selectionCtrl,
    readonlySwitch,
    cellLock,
    emit,
    isDestroyed: () => destroyed,
    backend: () => lifecycle.backend(),
    editor: () => editorWiring.get(),
    isFirstDataDrawn: () => render.isFirstDataDrawn(),
  });
  const { submitSetCells, notifyRowReject, performInsertRows, performDeleteRows } = editSubmit;
  // 範囲クリア・clipboard・Undo/Redo・実行前拒否の通知（区画⑦の後半・mount/edit-commands.ts）。結線は attachBackendRendering。
  const editCommands = createEditCommands({
    diag,
    isStandalone,
    stringColumnStrings,
    selectionCtrl,
    undoCtrl,
    cellLock,
    editSubmit,
    merges,
    emit,
    editor: () => editorWiring.get(),
    isReadOnly: () => readonlySwitch.isReadOnly(),
    closePopups: () => {
      select.close();
      date.close();
    },
  });
  // 選択式の候補欄（区画②・mount/select-wiring.ts）と日付カレンダー（区画③・mount/date-wiring.ts）。
  // 生成は今、backend への結線は attachBackendRendering（候補欄 → カレンダーの順に DOM を作る）。
  const select = createSelectWiring({
    host: stage,
    diag,
    stringColumnStrings,
    cellLock,
    merges,
    editor: () => editorWiring.get(),
    registry: () => config.registry(),
    appearance: () => config.appearance(),
    isReadOnly: () => readonlySwitch.isReadOnly(),
    ensureActiveCellVisible: () => render.ensureActiveCellVisible(),
    currentTransform: () => render.currentTransform(),
    placementConfig: () => render.placementConfig(),
    visibleArea: () => render.visibleArea(),
    submitSetCells,
    notifyRowReject,
  });
  const date = createDateWiring({
    host: stage,
    diag,
    stringColumnStrings,
    cellLock,
    merges,
    editor: () => editorWiring.get(),
    registry: () => config.registry(),
    isReadOnly: () => readonlySwitch.isReadOnly(),
    closeSelect: () => select.close(),
    ensureActiveCellVisible: () => render.ensureActiveCellVisible(),
    currentTransform: () => render.currentTransform(),
    placementConfig: () => render.placementConfig(),
    visibleArea: () => render.visibleArea(),
    submitSetCells,
    notifyRowReject,
  });

  // DD-036 C1: 固定行数/固定列数（mount オプション・既定 1＝DD-036 以前のハードコード値と完全一致）。view-local。
  // 受理形は 0 以上の有限整数。非整数・負・NaN・非 number は診断 warn（frozen-count-invalid）を出して既定 1 へ倒す
  // （readOnly の boolean 検証と同方針＝構成不整合ではないため mount は成功させる）。行数/列数の超過は
  // ViewportTransform 側が Math.min(count) で自クランプする（全行/全列が固定＝スクロール領域が空になるだけ）。
  function resolveFrozenCount(raw: unknown, label: string): number {
    if (raw === undefined) {
      return 1;
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      diag.emit(
        'warn',
        'frozen-count-invalid',
        `${label} は 0 以上の整数が必要（受領: ${String(raw)}）→ 既定 1 として扱う`,
      );
      return 1;
    }
    return raw;
  }
  const frozenRowCount = resolveFrozenCount(options.frozenRowCount, 'frozenRowCount');
  const frozenColCount = resolveFrozenCount(options.frozenColumnCount, 'frozenColumnCount');

  // ---- 描画（区画⑨・mount/render.ts・base-layer-options.ts）----
  const render = createRender({
    scaffold,
    headerHeight,
    frozenRowCount,
    frozenColCount,
    wrapEnabled,
    metrics,
    selectionCtrl,
    merges,
    backend: () => lifecycle.backend(),
    editor: () => editorWiring.get(),
    isDestroyed: () => destroyed,
    createBaseLayer: (backend) =>
      createMountBaseLayer(backend, {
        ctx: baseCtx,
        headerHeight,
        groupBandHeight,
        frozenColCount,
        wrapEnabled,
        wrapColumnStrings,
        cellTextCache,
        cellStatusStore,
        currentMerges,
        isLinkColumnIndex: (colIndex) => link.isLinkColumnIndex(colIndex),
        appearance: () => config.appearance(),
        formats: () => config.formats(),
        backgrounds: () => config.backgrounds(),
        rowBackgrounds: () => config.rowBackgrounds(),
        statusColors: () => config.statusColors(),
        borders: () => config.borders(),
        display: () => config.display(),
        columnGroups: () => config.columnGroups(),
      }),
    refreshPopupPlacement: (transform) => {
      select.refreshPlacement(transform);
      date.refreshPlacement(transform);
    },
    closePopups: () => {
      select.close();
      date.close();
    },
    syncCellLock,
    onFirstDataDrawn: () => {
      validateReadOnlyRowsOnce(); // DD-036 C3: 未知 rowId の診断 warn（初回描画後に 1 回だけ）
      config.validateRowBackgroundsOnce(); // DD-045: 未知 RowId の診断 warn（初回描画後に 1 回だけ）
      config.validateRowBordersOnce();
      syncCellLock(); // DD-036（Codex P2）: 初回データ描画時点の activeCell（0,0）のロックを確定させる
    },
    captureRebaseState: () => editSubmit.captureRebaseState(),
    applyRebaseState: (state) => editSubmit.applyRebaseState(state),
    drainPendingCommands: () => commands.drain(),
  });
  const { currentTransform, syncSpacer, syncLayout } = render;
  // 命令 API（scrollToRow・scrollToColumn・setActiveCell）と保留キュー（mount/commands.ts）。
  const commands = createCommands({
    diag,
    selectionCtrl,
    isDestroyed: () => destroyed,
    backend: () => lifecycle.backend(),
    editor: () => editorWiring.get(),
    isFirstDataDrawn: () => render.isFirstDataDrawn(),
    viewportWidth: () => render.viewportSize().width,
    currentMerges,
    closePopups: () => {
      select.close();
      date.close();
    },
    flushStructural: (view) => render.flushStructural(view),
    ensureCellVisible: (cell, axes) => render.ensureCellVisible(cell, axes),
  });
  // キー入力の裁定（区画①・mount/keyboard.ts）。優先順位は KEY_HANDLER_ORDER の 1 か所。
  const keyboard = createKeyboard({
    diag,
    rowOperationsEnabled,
    selectionCtrl,
    cellLock,
    merges,
    date,
    select,
    editor: () => editorWiring.get(),
    backend: () => lifecycle.backend(),
    isReadOnly: () => readonlySwitch.isReadOnly(),
    performUndo: () => editCommands.performUndo(),
    performRedo: () => editCommands.performRedo(),
    performInsertRows,
    performDeleteRows,
    performRangeClear: () => editCommands.performRangeClear(),
    ensureCellVisible: (cell) => render.ensureCellVisible(cell),
  });
  // editor（常駐 textarea＋IME）の結線（区画①・mount/editor-wiring.ts）。editor の状態の持ち主。
  const editorWiring = createEditorWiring({
    host: stage,
    diag,
    isStandalone,
    headerHeight,
    wrapColumnStrings,
    stringColumnStrings,
    selectionCtrl,
    keyboard,
    editCommands,
    select,
    date,
    events,
    readonlySwitch,
    cellLock,
    merges,
    emit,
    registry: () => config.registry(),
    appearance: () => config.appearance(),
    collabSession: () => lifecycle.collabSession(),
    hasPendingCommands: () => commands.hasPending(),
    submitSetCells,
    ensureActiveCellVisible: () => render.ensureActiveCellVisible(),
    currentTransform: () => render.currentTransform(),
    placementConfig: () => render.placementConfig(),
    visibleArea: () => render.visibleArea(),
    setActiveShadow: (cell) => render.setActiveShadow(cell),
  });

  // ---- ポインター（区画④・mount/pointer.ts・hover.ts・link-click.ts）----
  const hover = createCellHover({
    cellStatusStore,
    merges,
    emit,
    backend: () => lifecycle.backend(),
    currentTransform,
    runOrDefer: commands.runOrDefer,
  });
  const link = createLinkClick({
    diag,
    emit,
    backend: () => lifecycle.backend(),
    editor: () => editorWiring.get(),
    registry: () => config.registry(),
  });

  registerPointerInteraction({
    stage,
    scroller,
    signal,
    diag,
    headerHeight,
    groupBandHeight,
    wrapEnabled,
    wrapColumnStrings,
    cellTextCache,
    selectionCtrl,
    merges,
    cellLock,
    select,
    date,
    hover,
    link,
    emit,
    backend: () => lifecycle.backend(),
    editor: () => editorWiring.get(),
    registry: () => config.registry(),
    appearance: () => config.appearance(),
    display: () => config.display(),
    formats: () => config.formats(),
    columnGroups: () => config.columnGroups(),
    isReadOnly: () => readonlySwitch.isReadOnly(),
    currentTransform,
    syncSpacer,
    viewportSize: () => render.viewportSize(),
  });

  // canvas のレイアウト追従（DPR の変化・ResizeObserver。ポインターのリスナーの後に始めるのは従来どおり）。
  render.observeLayout();

  // ---- 設定の解釈と起動（区画⑥・mount/config.ts・lifecycle.ts）----
  const config = createMountConfig({
    options,
    wrapColumnStrings,
    frozenColCount,
    baseCtx,
    diag,
    merges,
    emit,
    backend: () => lifecycle.backend(),
  });
  const lifecycle = createLifecycle({
    options,
    isStandalone,
    serverOrigin,
    documentQuery,
    wsUrl,
    clientId,
    displayName,
    wrapEnabled,
    wrapColumns,
    stringColumns,
    stringColumnStrings,
    cellTextCache,
    signal,
    diag,
    metrics,
    undoCtrl,
    cellStatusStore,
    events,
    config,
    editSubmit,
    isDestroyed: () => destroyed,
    editor: () => editorWiring.get(),
    scheduleEditStateCheck,
    refreshHoverStatus: () => hover.refreshStatus(),
    attachBackend: attachBackendRendering,
  });

  /**
   * backend（共同編集 SessionSync / 単独 StandaloneSession）を描画層・IME へ結線する（DD-024 で boot から抽出）。
   * `sync` が設定済みであることを前提に、base-layer・docPort・editor を構築し syncLayout → backend.start() する。
   * 共同編集/単独で共有し、両者の差分は「どの backend を作るか」だけに閉じる（案B・contract §5）。
   */
  function attachBackendRendering(): void {
    const backend = lifecycle.backend();
    if (backend === undefined) {
      return;
    }
    // 結線の順番（DOM を作る順も従来どおり）: 描画層 → 編集の命令のポート → 候補欄 → 日付カレンダー → editor。
    render.attach(backend);
    editCommands.attach(backend);
    select.attach(backend);
    date.attach(backend);
    editorWiring.attach(backend);
    syncCellLock(); // DD-035 R4 / DD-036 C3: 初期 activeCell（0,0）のロックを同期
    syncLayout();
    backend.start();
  }

  // ---- 公開ハンドル ----
  const instance: GridInstance = {
    get documentId(): string {
      return lifecycle.documentId();
    },
    connectionState(): GridConnectionState {
      return lifecycle.connectionState();
    },
    subscribe(listener) {
      return events.subscribe(listener);
    },
    focus() {
      // boot 完了前（editor 未生成 or 初回配置前）の focus 要求は保持し、初回描画後に適用する（P2-3）。
      render.focusOrDefer();
    },
    setData(data: GridStandaloneData) {
      lifecycle.setData(data); // 単独モード専用（DD-024・決定③）。boot 前は呼ばれた順に保留する
    },
    setRows(rows: readonly GridStandaloneRow[]) {
      lifecycle.setRows(rows); // RC4（DD-052-4）: 単独モード専用（setData の部分更新版）
    },
    setCellStatus(rows: readonly GridCellStatusRow[]) {
      lifecycle.setCellStatus(rows); // DD-062: 両モード共通
    },
    setMergedCells(mergedCells: readonly GridMergedCell[]) {
      // DD-064: 両モード共通・view-local。列の並びが分かる前（boot 前）は最後の 1 回だけ保留して boot で適用する。
      // 張るのは次の描画の時（setData と同じ処理の中ならどちらを先に呼んでもよい・contract §1.2）。
      if (destroyed) {
        return;
      }
      merges.setFromCommand(mergedCells);
    },
    insertRows(options: { readonly afterRowId: string | null; readonly count?: number }) {
      performInsertRows(options.afterRowId, options.count ?? 1);
    },
    deleteRows(rowIds: readonly string[]) {
      performDeleteRows(rowIds);
    },
    scrollToRow(rowId: string) {
      commands.scrollToRow(rowId);
    },
    scrollToColumn(columnId: string) {
      commands.scrollToColumn(columnId);
    },
    setActiveCell(rowId: string, columnId: string) {
      commands.setActiveCell(rowId, columnId);
    },
    presences(): readonly GridPresenceUser[] {
      return events.currentPresenceUsers(); // DD-049 H5（単独モード・初回 join 前・destroy 後は空）
    },
    setReadOnly(next: boolean) {
      // DD-056 H12。JS 経路の非 boolean は mount オプションと同じく `=== true` の厳密判定で編集可能側へ倒し、診断 warn を出す。
      const raw: unknown = next;
      if (typeof raw !== 'boolean') {
        diag.emit('warn', 'readonly-invalid', `setReadOnly は boolean が必要（受領: ${typeof raw}）→ 編集可能として扱う`);
      }
      readonlySwitch.setReadOnly(raw === true);
    },
    pendingCount(): number {
      return destroyed ? 0 : (lifecycle.backend()?.session.pendingCount ?? 0); // DD-056 H12（単独モード・boot 前は 0）
    },
    flush(flushOptions?: GridFlushOptions): Promise<GridFlushResult> {
      return readonlySwitch.flush(flushOptions); // DD-056 H12
    },
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      // DD-056 H12: 判定の予約を取り消し、待っている flush を解決する（送り切っていれば flushed・残っていれば stopped）。
      readonlySwitch.dispose();
      commands.discard(); // DD-035 R6: 保留中の命令は破棄（rAF ループ停止後に走らせない）
      events.discardQueuedRemoteChanges(); // DD-049 H4: 未配布の remote-change は破棄（listener も下で解除する）
      diag.emit('info', 'destroy', 'grid を破棄しリソースを解放');
      render.stopLoop();
      lifecycle.stopTimers();
      abort.abort(); // scroller listeners を解放
      render.disconnectLayout();
      editorWiring.dispose(); // 常駐 textarea/badge・editor listeners を解放
      select.dispose(); // DD-027-1: listbox・▼ インジケーターを除去
      date.dispose(); // DD-035 R2: ポップオーバー・📅 インジケーターを除去
      lifecycle.closeTransport(); // WS を閉じ再接続タイマーを解放
      scaffold.dispose(); // container から stage を除去
      debugRegistry.delete(instance);
      events.clearListeners();
    },
  };

  // ---- E2E 用 introspection（test-support 経由・区画⑧は mount/debug-api.ts）----
  debugRegistry.set(
    instance,
    createDebugApi({
      isStandalone,
      headerHeight,
      scroller,
      diag,
      selectionCtrl,
      undoCtrl,
      backend: () => lifecycle.backend(),
      editor: () => editorWiring.get(),
      lastSessionEventType: () => lifecycle.lastSessionEventType(),
      isFirstDataDrawn: () => render.isFirstDataDrawn(),
      isReadOnly: () => readonlySwitch.isReadOnly(),
      currentTransform,
      display: () => config.display(),
      merges: currentMerges,
      select,
      date,
      transport: () => lifecycle.transport(),
    }),
  );

  // ---- 起動（rAF ループ・tick interval・boot）----
  render.start();
  lifecycle.start();

  return instance;
}

