// grid Facade の mount 配線（旧 apps/playground/src/integration/main.ts を昇華）。
//
// pocb の Canvas 基盤（render）を使い、値の源を ClientSession（共同編集の唯一の正本）→ DocumentView（読み取り
// アダプター）に置く。IME は編集状態機械＋常駐 textarea（integration-editor）。挙動は main.ts と等価に保ちつつ、
// ①DOM は container 内に構築（dom-scaffold・D4）②SessionEvent を GridEvent へ写像して購読者へ配信③readout 表示は
// 持たず、代わりに destroy() で全リソース（RAF/interval/listener/ResizeObserver/WS/canvas/textarea）を解放する
// （再mountで leak しない・AC2）④E2E 用 introspection は debugRegistry 経由（test-support）で露出する。

import { displayRowOrder } from '@nanairo-sheet/core';
import { createColumnId, createDocumentId, createRowId } from '@nanairo-sheet/types';
import type { ColumnId } from '@nanairo-sheet/types';
import type { ClientSession, Clock, IdGenerator, SessionEvent } from '@nanairo-sheet/collab';
import { CELL_TEXT_LINE_HEIGHT, createTextMetricsCache } from '@nanairo-sheet/render';
import type { TextMetricsCache } from '@nanairo-sheet/render';

import { BrowserWebSocketTransport } from './browser-transport';
import { ColumnTypeConfigError, createColumnTypeRegistry } from './column-types';
import type { ColumnTypeRegistry } from './column-types';
import { FormatRuleConfigError, compileColumnBackgrounds, compileFormatRules, compileRowBackgrounds } from './format-rules';
import type { CompiledColumnBackgrounds, CompiledColumnFormats, CompiledRowBackgrounds } from './format-rules';
import { BorderConfigError, compileBorders, normalizeCanvasBorderColor, type CompiledBorders } from './border-rules';
import { DisplayConfigError, compileDisplayFormats } from './display-format';
import type { CompiledColumnDisplay } from './display-format';
import { MergedCellsConfigError } from './merged-cell-spec';
import { compileColumnGroups } from './column-groups';
import type { CompiledColumnGroup } from './column-groups';
import { compileAppearance } from './appearance';
import { createLoadMetrics } from './initial-load-metrics';
import { toGridRemoteChange } from './remote-change';
import { createSessionSync } from './session-sync';
import { buildScaffold } from './dom-scaffold';
import { createSelectionController } from './selection-controller';
import { createUndoController } from './undo-stack';
import { GridBootError, toCompensationConflictCode } from './error-codes';
import { createDiagnosticSink } from './diagnostics';
import { debugRegistry } from './internal';
import { cellStatusInvalidMessage, createCellStatusStore, validateCellStatusColors } from './cell-status';
import { createStandaloneSession } from './standalone-session';
import type { StandaloneSession } from './standalone-session';
import { validateStandaloneOptions } from './standalone-options';
import type { GridBackend } from './grid-backend';
import type {
  GridCellStatusColors,
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
  GridStandaloneMountOptions,
  GridStandaloneRow,
} from './index';
import { COL_WIDTH, HEADER_HEIGHT, ROW_HEIGHT, TICK_INTERVAL_MS, errorMessage } from './mount/constants';
import { createDebugApi } from './mount/debug-api';
import { createEvents, toGridEvent } from './mount/events';
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


interface ResolvedConfig {
  documentId: string;
  columnOrder: string[];
}

/** GridMountOptions を受けて grid を container へ配線し、GridInstance を返す（同期 return・boot は非同期進行）。 */
export function createGridController(target: GridMountTarget, options: GridMountOptions): GridInstance {
  let appearance = compileAppearance(undefined, [], () => true, () => undefined);
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

  // ---- 可変状態 ----
  // backend は共同編集（SessionSync）と単独（StandaloneSession）の共通面（GridBackend・DD-024）。
  let sync: GridBackend | undefined;
  // 単独モードの再注入（setData）用の具体参照。共同編集モードでは undefined のまま。
  let standalone: StandaloneSession | undefined;
  // boot（microtask）完了前に setData/setRows が呼ばれたときの保留分（Codex[P1]: mount 直後の同期呼び出しを
  // 捨てない）。DD-052-4（Codex P2）: setData 用・setRows 用に別々のキューへ分けると、2 つの API を跨いだ
  // 呼び出し順（例: setRows→setData の順で呼んだのに boot 側で setData を先に適用してしまう）が壊れるため、
  // 呼ばれた順そのままを 1 本の queue に積む（setData は都度フル置換なので複数回積んでも最終状態は変わらない）。
  // DD-062: setCellStatus も同じ queue に積む（boot 前の setData→setCellStatus の順を、保留した setData の
  // 作り直しで setCellStatus の状態が消える形へ逆転させない）。
  const pendingStandaloneCalls: Array<
    | { readonly kind: 'data'; readonly data: GridStandaloneData }
    | { readonly kind: 'rows'; readonly rows: readonly GridStandaloneRow[] }
    | { readonly kind: 'status'; readonly rows: readonly GridCellStatusRow[] }
  > = [];
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
  let browserTransport: BrowserWebSocketTransport | undefined;
  // DD-027-1: 列タイプメタの Internal registry（columnOrder 解決後に生成・fail-fast）と選択式ドロップダウン。
  let columnTypeRegistry: ColumnTypeRegistry | undefined;
  // DD-027-3: セル書式のプリコンパイル済み解決器（columnOrder 解決後に生成・fail-fast）。書式なしなら hasAny()=false で
  // base-layer への束縛を省き描画コスト増をゼロにする。
  let compiledFormats: CompiledColumnFormats | undefined;
  // DD-036 C2: 静的列背景（columnBackgrounds）のプリコンパイル済み解決器（columnOrder 解決後に生成・fail-fast）。
  // hasAny()=false なら base-layer への columnBackground 束縛を省き列バンド描画そのものを行わない（現行描画と一致）。
  let compiledBackgrounds: CompiledColumnBackgrounds | undefined;
  // DD-045: 静的行背景。hasAny()=false なら rowBackground フックを束縛せず、描画コスト増ゼロ。
  let compiledRowBackgrounds: CompiledRowBackgrounds | undefined;
  // DD-061: 状態表示の色の上書き（検証済みの写し・未指定なら undefined＝既定色）。
  let compiledStatusColors: GridCellStatusColors | undefined;
  let compiledBorders: CompiledBorders | undefined;
  let rowBordersChecked = false;
  // DD-033-2: 列見出しキャプション＋表示書式のプリコンパイル済み解決器（columnOrder 解決後に生成・fail-fast）。
  // hasAny()=false（両オプション未指定）なら base-layer への columnHeaderLabel/formatCellText フック束縛を省く。
  let compiledDisplay: CompiledColumnDisplay | undefined;
  // DD-064 K4: 2段の見出しのまとまり（列 index に解決済み・columnOrder 解決後に生成・fail-fast）。空なら 1 段。
  let compiledColumnGroups: readonly CompiledColumnGroup[] = [];
  // 矩形範囲選択の所有者（DD-020-1 案X）。activeCell の所有は editor-state-machine のまま・レンジのみここが持つ。
  // DD-064: 直前に描いた結合範囲で範囲を広げる（mergeRegistry は下で生成。呼ばれるのは配線後なので前方参照で足りる）。
  const selectionCtrl = createSelectionController({ merges: () => merges.current() });
  // Undo/Redo スタックの所有者（DD-020-3）。確定単位（1 op）ごとに逆値を保持し補償 SetCells を生成する。
  const undoCtrl = createUndoController();
  let lastSessionEvent: SessionEvent | undefined;
  let resolvedDocumentId = options.documentId;
  let hasEverConnected = false; // 一度でも接続確立したか（初回接続失敗のみ connect error として通知・P1-2）
  // DD-049 H4/H5: 共同編集モードの ClientSession（参加者一覧の join 判定・他者 presence の読取に使う）。単独モードは undefined。
  let collabSession: ClientSession | undefined;

  // ---- 購読・後始末（購読と通知は mount/events.ts）----
  const events = createEvents({
    clientId,
    displayName,
    onEvent: options.onEvent,
    isDestroyed: () => destroyed,
    collabSession: () => collabSession,
  });
  const emit = events.emit;
  const abort = new AbortController();
  const { signal } = abort;
  let intervalId = 0;
  let destroyed = false;

  // 診断ログ hook（opt-in・既定無出力）。GridEvent（consumer 契約）とは別系統の障害切り分け用。
  const diag = createDiagnosticSink(options.onDiagnostic);
  // DD-064: 結合（view-local）は mount/merges.ts。張れない・壊れた理由は診断 warn（1 つの指定につき 1 回）。
  const merges = createMerges({
    diag,
    backend: () => sync,
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
    backend: () => sync,
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
    backend: () => sync,
    standalone: () => standalone,
    editor: () => editorWiring.get(),
    registry: () => columnTypeRegistry,
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
    backend: () => sync,
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
    registry: () => columnTypeRegistry,
    appearance: () => appearance,
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
    registry: () => columnTypeRegistry,
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
    backend: () => sync,
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
        appearance: () => appearance,
        formats: () => compiledFormats,
        backgrounds: () => compiledBackgrounds,
        rowBackgrounds: () => compiledRowBackgrounds,
        statusColors: () => compiledStatusColors,
        borders: () => compiledBorders,
        display: () => compiledDisplay,
        columnGroups: () => compiledColumnGroups,
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
      validateRowBackgroundsOnce(); // DD-045: 未知 RowId の診断 warn（初回描画後に 1 回だけ）
      validateRowBordersOnce();
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
    backend: () => sync,
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
    backend: () => sync,
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
    registry: () => columnTypeRegistry,
    appearance: () => appearance,
    collabSession: () => collabSession,
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
    backend: () => sync,
    currentTransform,
    runOrDefer: commands.runOrDefer,
  });
  const link = createLinkClick({
    diag,
    emit,
    backend: () => sync,
    editor: () => editorWiring.get(),
    registry: () => columnTypeRegistry,
  });

  // DD-045: 行 ID は初期データ到着前に検証できないため、初回描画後に一度だけ未知 RowId を診断する。
  const rowBackgroundRowSet = new Set<string>(Object.keys(options.rowBackgrounds ?? {}));
  let rowBackgroundsChecked = false;
  function validateRowBackgroundsOnce(): void {
    const backend = sync;
    if (rowBackgroundsChecked || rowBackgroundRowSet.size === 0 || backend === undefined) {
      return;
    }
    rowBackgroundsChecked = true;
    const unknown = [...rowBackgroundRowSet].filter((rowId) => backend.view.rowIndexOf(createRowId(rowId)) < 0);
    if (unknown.length > 0) {
      diag.emit(
        'warn',
        'row-background-unknown',
        `rowBackgrounds: 未知の行 ${unknown.join(', ')}（初回描画時点の文書に存在しない）→ 該当 RowId が現れれば背景色を適用`,
      );
    }
  }

  // DD-045: rowBorders の未知 RowId も、初回描画後に一度だけ診断する。
  function validateRowBordersOnce(): void {
    if (!rowBordersChecked && compiledBorders !== undefined && sync !== undefined) {
      rowBordersChecked = true;
      const unknown = compiledBorders.rowIds.filter((id) => sync?.view.rowIndexOf(createRowId(id)) === -1);
      if (unknown.length > 0) diag.emit('warn', 'row-border-unknown', `rowBorders: 未知の行 ${unknown.join(', ')} → 到着後に適用`);
    }
  }

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
    backend: () => sync,
    editor: () => editorWiring.get(),
    registry: () => columnTypeRegistry,
    appearance: () => appearance,
    display: () => compiledDisplay,
    formats: () => compiledFormats,
    columnGroups: () => compiledColumnGroups,
    isReadOnly: () => readonlySwitch.isReadOnly(),
    currentTransform,
    syncSpacer,
    viewportSize: () => render.viewportSize(),
  });

  // canvas のレイアウト追従（DPR の変化・ResizeObserver。ポインターのリスナーの後に始めるのは従来どおり）。
  render.observeLayout();

  // ---- 起動 ----
  async function fetchConfig(): Promise<ResolvedConfig> {
    // destroy() で abort される（boot 進行中の /config を残さない・P2-2）。
    const response = await fetch(`${serverOrigin}/config${documentQuery}`, { signal });
    if (!response.ok) {
      throw new GridBootError('config-unavailable', `/config 取得失敗: ${response.status}`);
    }
    // HTTP 200 でも本文が不正 JSON なら「到達性」でなく「応答形式」の問題＝config-invalid（P2-3）。
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new GridBootError('config-invalid', `/config の JSON 解析失敗: ${errorMessage(error)}`);
    }
    if (
      typeof json !== 'object' ||
      json === null ||
      !('documentId' in json) ||
      !('columnOrder' in json) ||
      !Array.isArray((json as { columnOrder: unknown }).columnOrder)
    ) {
      throw new GridBootError('config-invalid', '/config の形式が不正');
    }
    const record = json as { documentId: string; columnOrder: string[] };
    return { documentId: record.documentId, columnOrder: record.columnOrder };
  }

  // D1: columnOrder は既定で /config から取得（明示指定で上書き可）。documentId も同様。
  async function resolveConfig(): Promise<ResolvedConfig> {
    if (options.columnOrder !== undefined && options.documentId !== undefined) {
      return { documentId: options.documentId, columnOrder: [...options.columnOrder] };
    }
    const fetched = await fetchConfig();
    return {
      documentId: options.documentId ?? fetched.documentId,
      columnOrder: options.columnOrder !== undefined ? [...options.columnOrder] : fetched.columnOrder,
    };
  }

  /**
   * DD-027-1: columnTypes（mount オプション）から Internal registry を生成する（両モード共通）。成功=true。
   * 不正設定（未知列・候補0件・重複・候補が非 round-trip・未対応 type〔DD-027-1〕／リンク列と wrapColumns の同一列併用
   * ＝wrap-link-conflict〔DD-027-2〕）は ColumnTypeConfigError を catch し、公開 error（phase=config・
   * code=column-types-invalid）＋診断で通知して false を返す（fail-fast・配線しない・AC8）。
   */
  function buildColumnTypeRegistry(columnOrder: readonly string[]): boolean {
    try {
      // DD-027-2: wrapColumns を渡してリンク列×折り返しの併用を fail-fast（wrap-link-conflict→column-types-invalid）。
      // DD-035 R4: readOnlyColumns も同じ registry で検証（未知列・重複 → column-types-invalid）・参照する（列タイプと直交）。
      columnTypeRegistry = createColumnTypeRegistry(options.columnTypes, columnOrder, wrapColumnStrings, options.readOnlyColumns);
      // DD-027-3: セル書式ルールをプリコンパイル（fail-fast）。不正は columnTypes と同じ column-types-invalid へ写像する。
      appearance = compileAppearance(options.appearance, columnOrder, (font) => {
        const probe = document.createElement('span');
        probe.style.font = font;
        return probe.style.font !== '';
      }, (color) => normalizeCanvasBorderColor(baseCtx, color));
      compiledFormats = compileFormatRules(options.columnFormats, columnOrder);
      // DD-036 C2: 静的列背景をプリコンパイル（fail-fast・未知列/空色 → column-types-invalid＝columnFormats と同経路）。
      compiledBackgrounds = compileColumnBackgrounds(options.columnBackgrounds, columnOrder);
      // DD-045: 静的行背景をプリコンパイル（空色は fail-fast、RowId の存在は初回描画後に warn）。
      compiledRowBackgrounds = compileRowBackgrounds(options.rowBackgrounds);
      // DD-061: 状態表示の色（未知のキー・空の色 → column-types-invalid＝rowBackgrounds と同経路）。
      compiledStatusColors = validateCellStatusColors(options.cellStatusColors);
      compiledBorders = compileBorders(options.rowBorders, options.columnBorders, columnOrder, (color) => normalizeCanvasBorderColor(baseCtx, color), options.defaultRowBorder);
      // DD-033-2: 列見出しキャプション＋表示書式をプリコンパイル（fail-fast）。wrap/link 併用検査は wrapColumnStrings と
      // 直前に生成した columnTypeRegistry を渡して同所で実施する。不正は column-display-invalid へ写像する（別 code）。
      compiledDisplay = compileDisplayFormats(options.columnDisplayFormats, options.columnCaptions, columnOrder, {
        isWrapColumn: (columnId) => wrapColumnStrings.has(columnId),
        isLinkColumn: (columnId) => columnTypeRegistry?.isLinkColumn(columnId) === true,
      });
      // DD-064 K4: 2段の見出しのまとまり（形の誤りは DisplayConfigError → column-display-invalid）。
      compiledColumnGroups = compileColumnGroups(options.columnGroups, columnOrder, frozenColCount);
      // DD-064: mount オプションの結合（形の誤りは 1 件でも fail-fast → merged-cells-invalid）。行に張るのは最初の描画の時。
      // boot 前に呼ばれた setMergedCells（最後の 1 回）は、この後に適用する（呼んだ側の指定が勝つ）。
      merges.applyMountOption(options.mergedCells, columnOrder);
      return true;
    } catch (error) {
      // DD-027-1/2: columnTypes 不正 ／ DD-027-3: columnFormats 不正 は column-types-invalid へ、
      // DD-033-2: columnCaptions/columnDisplayFormats 不正 は column-display-invalid へ（意味を分けて障害切り分けを濁さない）。
      if (error instanceof MergedCellsConfigError) {
        diag.emit('error', 'config-error', `merged-cells-invalid: ${error.message}`);
        emit({ type: 'error', phase: 'config', code: 'merged-cells-invalid', message: error.message });
        return false;
      }
      if (error instanceof BorderConfigError) {
        diag.emit('error', 'config-error', `border-config-invalid: ${error.message}`);
        emit({ type: 'error', phase: 'config', code: 'border-config-invalid', message: error.message });
        return false;
      }
      if (error instanceof ColumnTypeConfigError || error instanceof FormatRuleConfigError) {
        diag.emit('error', 'config-error', `column-types-invalid: ${error.message}`);
        emit({ type: 'error', phase: 'config', code: 'column-types-invalid', message: error.message });
        return false;
      }
      if (error instanceof DisplayConfigError) {
        diag.emit('error', 'config-error', `column-display-invalid: ${error.message}`);
        emit({ type: 'error', phase: 'config', code: 'column-display-invalid', message: error.message });
        return false;
      }
      throw error;
    }
  }

  async function boot(): Promise<void> {
    diag.emit('info', 'boot-start', `boot 開始（server=${serverOrigin}）`);
    let config: ResolvedConfig;
    try {
      config = await resolveConfig();
    } catch (error) {
      // destroy() 由来の AbortError は正常な後始末ゆえエラー通知しない（P2-2）。
      if (!destroyed) {
        // GridBootError は phase/code を保持する。それ以外（想定外）は config-unavailable 相当で通知。
        const code = error instanceof GridBootError ? error.code : 'config-unavailable';
        diag.emit('error', 'config-error', `${code}: ${errorMessage(error)}`);
        emit({ type: 'error', phase: 'config', code, message: errorMessage(error) });
      }
      return;
    }
    diag.emit('info', 'config-resolved', `documentId=${config.documentId} columns=${config.columnOrder.length}`);
    if (destroyed) {
      return; // boot 中に destroy された（wiring しない）
    }
    resolvedDocumentId = config.documentId;
    const columnOrder: ColumnId[] = config.columnOrder.map((c) => createColumnId(c));

    // DD-027-1: 列タイプメタの registry を columnOrder 解決後に生成する（未知列検証のため）。不正設定は
    // fail-fast＝公開 error（phase=config・code=column-types-invalid）を出して配線しない（AC8）。
    if (!buildColumnTypeRegistry(config.columnOrder)) {
      return;
    }

    const clock: Clock = { now: () => Date.now() };
    const idGenerator: IdGenerator = { next: () => crypto.randomUUID() };
    const transport = new BrowserWebSocketTransport(wsUrl, {
      onServerFrame: (info) => {
        metrics.recordFrame(info);
      },
      // 初回接続確立前の WS エラーは connect error として通知する（approved lifecycle mapping・P1-2）。
      // 接続確立後の一時エラーは reconnect の一部＝connection offline イベントで表現するため connect error にしない。
      logger: (message) => {
        diag.emit('warn', 'transport', message);
        if (!hasEverConnected && !destroyed) {
          emit({ type: 'error', phase: 'connect', code: 'connect-failed', message });
        }
      },
    });
    browserTransport = transport;

    const collabSync = createSessionSync({
      innerTransport: transport,
      sessionConfig: {
        clientId,
        userId: clientId,
        displayName,
        documentId: createDocumentId(config.documentId),
        columnOrder,
        clock,
        idGenerator,
        // イベント通知契約を GridEvent へ写像して購読者へ配信する（接続断/pending/reject/divergence を即時通知）。
        observer: (event) => {
          lastSessionEvent = event;
          if (event.type === 'connection' && event.state === 'online') {
            hasEverConnected = true; // 以降の transport エラーは connect error にしない（reconnect＝offline で表現）
          }
          if (event.type === 'rejected') {
            // DD-020-3: 補償 op（undo/redo）の reject は undo-blocked/redo-blocked へ写像して通知する
            // （エントリは onRejected 内で除去＝既定案 a）。元 op（未 ACK）の reject は onRejected が除去し undefined を返す
            // → 従来どおり cell-conflict 等へ写像して emit する（consumer は競合を従来語彙で受ける）。
            const block = undoCtrl.onRejected(event.entry.operationId);
            if (block !== undefined) {
              // DD-056 H11（Codex 設計レビュー P2-3）: 補償 op の認可拒否は undo-blocked/redo-blocked より permission-denied を優先する
              // （エントリの除去＝Undo 状態の後始末は onRejected で済んでいる）。
              const code = toCompensationConflictCode(block, event.entry.code);
              diag.emit('warn', 'rejected', `code=${code} op=${String(event.entry.operationId)}`);
              emit({
                type: 'rejected',
                pendingCount: event.pendingCount,
                conflict: { operationId: String(event.entry.operationId), reason: 'rejected', code },
              });
              scheduleEditStateCheck(); // DD-056 H12: 補償の拒否でも pending が変わる
              return;
            }
          }
          const gridEvent = toGridEvent(event);
          if (gridEvent.type === 'connection') {
            diag.emit('info', 'connection', `state=${gridEvent.state} pending=${gridEvent.pendingCount}`);
          } else if (gridEvent.type === 'rejected') {
            diag.emit('warn', 'rejected', `code=${gridEvent.conflict.code} op=${gridEvent.conflict.operationId}`);
          } else if (gridEvent.type === 'divergence') {
            diag.emit('warn', 'divergence', `server=${gridEvent.serverRevision} committed=${gridEvent.committedRevision}`);
          }
          emit(gridEvent);
          scheduleEditStateCheck(); // DD-056 H12: pending・接続の変化で flush の待ち合わせを判定し直す（待つものが無ければ無コスト）
        },
        // DD-049 H4: committed へ入った受理済み op を公開形へ写してキューに積む（配るのは settle＝描画の dirty 立ての後）。
        // 購読者が居なければ写像しない（未使用の consumer に表示文字列変換のコストを足さない）。
        onCommittedOperation: (event) => {
          if (!events.hasListeners()) {
            return;
          }
          const change = toGridRemoteChange(event.envelope, event.changeSet, clientId);
          if (change !== undefined) {
            events.queueRemoteChange(change);
          }
        },
      },
      rowHeight: ROW_HEIGHT,
      colWidth: COL_WIDTH,
      ...(options.columnWidths !== undefined ? { columnWidths: options.columnWidths } : {}),
      ...(options.rowHeights !== undefined ? { rowHeights: options.rowHeights } : {}),
      // DD-012-5: wrap 列・行分割キャッシュ・フォント・行高を DocumentView へ渡す（自動行高の計算基盤）。
      ...(wrapEnabled ? { wrapColumns } : {}),
      wrapCache: cellTextCache,
      cellFont: appearance.cellFont,
      columnFont: appearance.fontFor,
      lineHeight: CELL_TEXT_LINE_HEIGHT,
      onConnected: () => {
        metrics.mark('wsConnected');
      },
      onOperations: () => {
        metrics.mark('firstSync');
        editorWiring.get()?.session.noteServerUpdate();
      },
      // DD-020-3: 自分の SetCells op が committed へ確定した（own echo）→ Undo の ownedRevision を正確な revision で更新。
      onOwnSetCellsCommitted: (operationId, revision) => {
        undoCtrl.onCommitted(operationId, revision);
      },
      // DD-049: 1 サーバーメッセージの処理（適用・rollback/replay・描画の dirty 立て）が終わった時点で利用者向けイベントを配る
      // （listener から命令 API を呼んでも整合した状態を読む）。presence は一覧が変わりうるメッセージのときだけ再計算する。
      onServerMessageSettled: (message) => {
        events.flushRemoteChanges();
        if (
          message.type === 'welcome' ||
          message.type === 'presenceSnapshot' ||
          message.type === 'presenceDelta' ||
          message.type === 'presenceRemoved'
        ) {
          events.refreshPresence();
        }
      },
    });
    sync = collabSync;
    collabSession = collabSync.session;

    attachBackendRendering();
  }

  /**
   * backend（共同編集 SessionSync / 単独 StandaloneSession）を描画層・IME へ結線する（DD-024 で boot から抽出）。
   * `sync` が設定済みであることを前提に、base-layer・docPort・editor を構築し syncLayout → backend.start() する。
   * 共同編集/単独で共有し、両者の差分は「どの backend を作るか」だけに閉じる（案B・contract §5）。
   */
  function attachBackendRendering(): void {
    const backend = sync;
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

  /** 単独モードの backend を構築して結線する（同期・共同編集の boot に相当・DD-024）。 */
  function bootStandalone(): void {
    if (destroyed) {
      return;
    }
    const errorCode = validateStandaloneOptions(options);
    if (errorCode !== undefined) {
      diag.emit('error', 'config-error', `${errorCode}: 単独モードの options 検証に失敗`);
      emit({ type: 'error', phase: 'config', code: errorCode, message: `standalone options invalid (${errorCode})` });
      return; // 配線しない（rAF ループは sync=undefined で no-op）
    }
    const standaloneOptions = options as GridStandaloneMountOptions;
    // DD-027-1: 列タイプ registry を生成（fail-fast）。不正なら配線しない（AC8）。
    if (!buildColumnTypeRegistry(standaloneOptions.columnOrder)) {
      return;
    }
    resolvedDocumentId = standaloneOptions.documentId;
    diag.emit('info', 'standalone-boot', `columns=${standaloneOptions.columnOrder.length}`);
    standalone = createStandaloneSession({
      columnOrder: standaloneOptions.columnOrder,
      ...(standaloneOptions.initialData !== undefined ? { initialData: standaloneOptions.initialData } : {}),
      rowHeight: ROW_HEIGHT,
      colWidth: COL_WIDTH,
      ...(options.columnWidths !== undefined ? { columnWidths: options.columnWidths } : {}),
      ...(options.rowHeights !== undefined ? { rowHeights: options.rowHeights } : {}),
      ...(wrapEnabled ? { wrapColumns } : {}),
      ...(stringColumnStrings.size > 0 ? { stringColumns } : {}),
      wrapCache: cellTextCache,
      cellFont: appearance.cellFont,
      columnFont: appearance.fontFor,
      lineHeight: CELL_TEXT_LINE_HEIGHT,
      // RC13（DD-052-4）: submitSetCells が積んだ逆値パッチを、consumer 通知（onCellCommit）より前に記録する。
      beforeCellCommit: () => editSubmit.recordPendingStandaloneUndo(standalone),
      // 確定通知（決定②「通知のみ」）: 表示文字列 batch を cell-commit イベントへ写して購読者へ配信する。
      onCellCommit: (changes) => {
        emit({ type: 'cell-commit', changes });
      },
      // DD-060: 不正な level で無視したセルの診断（未知列は cells・readOnlyColumns と同じく静かにスキップ）。
      onCellStatusInvalid: (message) => {
        diag.emit('warn', 'cell-status-invalid', message);
      },
      // DD-062: 状態の置き場は setCellStatus と共有する（setData の作り直しは setCellStatus の分も含む）。
      cellStatusStore,
    });
    sync = standalone;
    attachBackendRendering();
    // boot 前に呼ばれた setData/setRows（キャッシュ済みデータの mount 直後注入等）を、呼ばれた順に適用する
    // （Codex[P1]・DD-052-4 Codex[P2]: setData/setRows のどちらから呼ばれても実際の呼び出し順を保つ）。
    while (pendingStandaloneCalls.length > 0) {
      const call = pendingStandaloneCalls.shift()!;
      if (call.kind === 'data') {
        applyStandaloneData(call.data);
      } else if (call.kind === 'rows') {
        applyStandaloneSetRows(call.rows);
      } else {
        applyCellStatus(call.rows);
      }
    }
  }

  /**
   * 単独モードの再注入を適用する（setData 経由）。文書差し替え後、IME state machine の activeCell が新しい行/列
   * 範囲外に取り残されると以後の入力/Delete が無効 RowId へ落ちて無言で失われるため、範囲外なら active cell を
   * クランプして再シートする（Codex[P2]）。合成中は I-3 を守って触らない（利用側は編集完了後の再注入を推奨）。
   */
  function applyStandaloneData(data: GridStandaloneData): void {
    if (standalone === undefined) {
      return;
    }
    standalone.setData(data);
    // 文書を丸ごと差し替えた → 旧文書に対する undo/redo 履歴・ownedRevision は無効（別文書の逆値を新文書へ適用すると
    // standalone は beforeRevision を無視するためサイレント上書き、削除 ID なら throw になる・Codex P1）。全消去する。
    undoCtrl.clear();
    clampActiveCellToDocument(standalone);
    // DD-060: 状態表示も作り直されたので、ホバー中のセルの状態が変わっていれば cell-hover を出し直す
    // （クランプの後に呼ぶ: 出し直しは構造 flush を同期で走らせうるため、クランプとの順序を従来どおりに保つ）。
    hover.refreshStatus();
  }

  /** setData 直後に activeCell が新文書の範囲外なら範囲内へ寄せる（applyStandaloneData の上記コメント参照）。 */
  function clampActiveCellToDocument(backend: StandaloneSession): void {
    const editor = editorWiring.get();
    if (editor === undefined || editor.session.isComposing()) {
      return;
    }
    // 新文書（差し替え直後・Axis は次 flush で再構築される）から行数・列数を読む。
    const doc = backend.session.committedDocument;
    const rowCount = displayRowOrder(doc).length;
    const colCount = doc.columnOrder.length;
    const active = editor.session.getActiveCell();
    if (active.row < rowCount && active.col < colCount) {
      return; // 範囲内 → active cell は触らない（周期リフレッシュでカーソルを飛ばさない）
    }
    if (rowCount === 0 || colCount === 0) {
      editor.pointerdownCell(null); // 空文書 → 選択解除
      return;
    }
    editor.pointerdownCell({ row: Math.min(active.row, rowCount - 1), col: Math.min(active.col, colCount - 1) });
  }

  /**
   * RC4（DD-052-4）: 行単位の部分更新（`setRows`）を適用する。`setData` と違い Undo を消さず、渡した行の
   * 変更セルだけを 1 Undo エントリとして記録する（新規行の挿入自体は行操作と同様 Undo 対象外）。readOnly は
   * `setData` と同様にバイパスする（プログラム的な再注入のため）。行が増えるだけで列は変わらないため、
   * `applyStandaloneData` と違い activeCell のクランプは不要（既存の選択が範囲外になることがない）。
   */
  function applyStandaloneSetRows(rows: readonly GridStandaloneRow[]): void {
    if (standalone === undefined) {
      return; // 共同編集モードは対象外（setData と同様の扱い）
    }
    const result = standalone.setRows(rows);
    if (result.changes.length > 0) {
      editSubmit.recordProgrammaticUndo(standalone, [...result.changes]);
    }
    // DD-060: 状態表示だけの変更は Undo に記録しない（文書のデータではない）。ホバー中のセルが変わっていれば出し直す。
    if (result.cellStatusUpdated) {
      hover.refreshStatus();
    }
  }

  /**
   * DD-062: 両モード共通の状態表示の付け外し（`setCellStatus`）を適用する。渡した行の状態を丸ごと置き換える
   * （`{}` で消す）。状態は view-local で文書・サーバー・Undo には触れない。描画中なら可視セルの再描画を要求し、
   * ホバー中のセルの状態が変わっていれば cell-hover を出し直す。
   */
  function applyCellStatus(rows: readonly GridCellStatusRow[]): void {
    // JS の consumer の不正な形（配列でない・行がオブジェクトでない・rowId が文字列でない）は例外にせず、その行だけ
    // 飛ばして診断する（Codex P2: 単独モードの boot 前は queue の再生ごと止まり、後続の setData/setRows まで失われる）。
    const list: unknown = rows;
    if (!Array.isArray(list)) {
      diag.emit('warn', 'cell-status-invalid', 'setCellStatus: rows は { rowId, cellStatus } の配列が必要（無視）');
      return;
    }
    const invalid: string[] = [];
    const malformed: number[] = [];
    let updated = false;
    list.forEach((row: unknown, index) => {
      const rowId: unknown = typeof row === 'object' && row !== null ? (row as { rowId?: unknown }).rowId : undefined;
      if (typeof rowId !== 'string') {
        malformed.push(index);
        return;
      }
      if (cellStatusStore.replaceRow(rowId, (row as { cellStatus?: unknown }).cellStatus, invalid)) {
        updated = true;
      }
    });
    if (malformed.length > 0) {
      diag.emit('warn', 'cell-status-invalid', `setCellStatus: rows[${malformed.join(', ')}] は { rowId, cellStatus } ではないため無視しました`);
    }
    if (invalid.length > 0) {
      diag.emit('warn', 'cell-status-invalid', cellStatusInvalidMessage(invalid));
    }
    if (updated) {
      sync?.view.markCellDirty();
      hover.refreshStatus();
    }
  }

  // ---- 公開ハンドル ----
  const instance: GridInstance = {
    get documentId(): string {
      return resolvedDocumentId ?? options.documentId ?? '';
    },
    connectionState(): GridConnectionState {
      // 単独モードは恒常的に非接続（DD-024・contract §4）。'offline'（一時切断）と区別する専用値。
      if (isStandalone) {
        return 'standalone';
      }
      if (sync === undefined) {
        return 'offline';
      }
      return sync.session.isStopped ? 'stopped' : sync.session.isOnline ? 'online' : 'offline';
    },
    subscribe(listener) {
      return events.subscribe(listener);
    },
    focus() {
      // boot 完了前（editor 未生成 or 初回配置前）の focus 要求は保持し、初回描画後に適用する（P2-3）。
      render.focusOrDefer();
    },
    setData(data: GridStandaloneData) {
      // 単独モード専用（DD-024・決定③）。
      if (standalone !== undefined) {
        applyStandaloneData(data);
        return;
      }
      // 単独モードだが boot（microtask）未完了 → 保留し構築後に順番どおり適用する（Codex[P1]・mount 直後注入を捨てない）。
      if (isStandalone && !destroyed) {
        pendingStandaloneCalls.push({ kind: 'data', data });
        return;
      }
      // 共同編集モードでは no-op（診断のみ）。
      diag.emit('warn', 'setData', 'setData は単独モード専用（共同編集モードでは無視）');
    },
    setRows(rows: readonly GridStandaloneRow[]) {
      // RC4（DD-052-4）: 単独モード専用（setData の部分更新版）。
      if (standalone !== undefined) {
        applyStandaloneSetRows(rows);
        return;
      }
      // 単独モードだが boot（microtask）未完了 → 保留し構築後に順番どおり適用する（setData と同じ理由・Codex[P1]）。
      if (isStandalone && !destroyed) {
        pendingStandaloneCalls.push({ kind: 'rows', rows });
        return;
      }
      diag.emit('warn', 'setRows', 'setRows は単独モード専用（共同編集モードでは無視）');
    },
    setCellStatus(rows: readonly GridCellStatusRow[]) {
      // DD-062: 両モード共通。単独モードの boot 前は setData/setRows と同じ queue に積んで呼び出し順を保つ
      // （保留した setData の作り直しで、先に付けた状態が消えないように）。共同編集モードはすぐ置き場へ書く。
      if (destroyed) {
        return;
      }
      if (isStandalone && standalone === undefined) {
        pendingStandaloneCalls.push({ kind: 'status', rows });
        return;
      }
      applyCellStatus(rows);
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
      return destroyed ? 0 : (sync?.session.pendingCount ?? 0); // DD-056 H12（単独モード・boot 前は 0）
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
      window.clearInterval(intervalId);
      abort.abort(); // scroller listeners を解放
      render.disconnectLayout();
      editorWiring.dispose(); // 常駐 textarea/badge・editor listeners を解放
      select.dispose(); // DD-027-1: listbox・▼ インジケーターを除去
      date.dispose(); // DD-035 R2: ポップオーバー・📅 インジケーターを除去
      browserTransport?.close(); // WS を閉じ再接続タイマーを解放
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
      backend: () => sync,
      editor: () => editorWiring.get(),
      lastSessionEventType: () => lastSessionEvent?.type ?? '',
      isFirstDataDrawn: () => render.isFirstDataDrawn(),
      isReadOnly: () => readonlySwitch.isReadOnly(),
      currentTransform,
      display: () => compiledDisplay,
      merges: currentMerges,
      select,
      date,
      transport: () => browserTransport,
    }),
  );

  // ---- 起動（rAF ループ・tick interval・boot）----
  render.start();
  if (isStandalone) {
    // 単独モード（DD-024）: WS/tick interval は不要（transport 無し）。backend 構築は microtask で行い、
    // mount() の同期 return 契約（イベントは return 後に届く）を共同編集経路と揃える。destroy 済みなら配線しない。
    queueMicrotask(() => {
      try {
        bootStandalone();
      } catch (error) {
        diag.emit('error', 'runtime-error', errorMessage(error));
        emit({ type: 'error', phase: 'runtime', code: 'runtime-fault', message: errorMessage(error) });
      }
    });
  } else {
    intervalId = window.setInterval(() => {
      // tick=再送/catch-up ポーリング、heartbeat=サーバー TTL（15秒）失効を防ぐ生存通知。offline 時は transport が drop。
      sync?.session.tick();
      sync?.session.sendHeartbeat();
    }, TICK_INTERVAL_MS);
    // boot は自前で config 失敗を error イベント化するが、config 以降の配線例外は runtime error として通知する
    // （旧 main.ts の `void boot().catch(...)` と等価・unhandled rejection を出さない）。
    void boot().catch((error) => {
      diag.emit('error', 'runtime-error', errorMessage(error));
      emit({ type: 'error', phase: 'runtime', code: 'runtime-fault', message: errorMessage(error) });
    });
  }

  return instance;
}

