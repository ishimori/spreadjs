// grid Facade の mount 配線（旧 apps/playground/src/integration/main.ts を昇華）。
//
// pocb の Canvas 基盤（render）を使い、値の源を ClientSession（共同編集の唯一の正本）→ DocumentView（読み取り
// アダプター）に置く。IME は編集状態機械＋常駐 textarea（integration-editor）。挙動は main.ts と等価に保ちつつ、
// ①DOM は container 内に構築（dom-scaffold・D4）②SessionEvent を GridEvent へ写像して購読者へ配信③readout 表示は
// 持たず、代わりに destroy() で全リソース（RAF/interval/listener/ResizeObserver/WS/canvas/textarea）を解放する
// （再mountで leak しない・AC2）④E2E 用 introspection は debugRegistry 経由（test-support）で露出する。

import { displayRowOrder } from '@nanairo-sheet/core';
import type { SetCellsOperation } from '@nanairo-sheet/core';
import { createColumnId, createDocumentId, createRowId } from '@nanairo-sheet/types';
import type { ColumnId, OperationId } from '@nanairo-sheet/types';
import type { ClientSession, Clock, IdGenerator, PresenceUpdate, SessionEvent } from '@nanairo-sheet/collab';
import { CELL_TEXT_LINE_HEIGHT, createTextMetricsCache } from '@nanairo-sheet/render';
import type { TextMetricsCache } from '@nanairo-sheet/render';
import { EMPTY_MERGE_INDEX, moveAcrossMerges, stepAcrossMerges } from '@nanairo-sheet/selection';
import type { MergeMoveDirection } from '@nanairo-sheet/selection';
import type { GridLayout } from '@nanairo-sheet/ime';

import { BrowserWebSocketTransport } from './browser-transport';
import { cellScalarToDisplay } from './document-view';
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
import { decideSelectKey } from './select-editor';
import { decideDateKey } from './date-editor';
import { createIntegrationEditor } from './integration-editor';
import { compileAppearance } from './appearance';
import type { IntegrationEditor } from './integration-editor';
import { createLoadMetrics } from './initial-load-metrics';
import { toGridRemoteChange } from './remote-change';
import { createSessionSync } from './session-sync';
import { buildScaffold } from './dom-scaffold';
import { createSelectionController, decideNavigationIntercept } from './selection-controller';
import { shouldSuppressReadonlyKey } from './readonly-policy';
import { decideRowStructureKey } from './row-operations';
import { createUndoController, decideUndoRedoKey } from './undo-stack';
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
import { COL_WIDTH, HEADER_HEIGHT, HEADER_WIDTH, ROW_HEIGHT, TICK_INTERVAL_MS, errorMessage } from './mount/constants';
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


interface ResolvedConfig {
  documentId: string;
  columnOrder: string[];
}

/** DD-064: キー → 結合を 1 セルとして動く方向（状態機械の keyToDirection と同じ対応。Shift＋矢印は範囲の拡張なので対象外）。 */
function mergeMoveDirectionOf(key: string, shiftKey: boolean): MergeMoveDirection | null {
  switch (key) {
    case 'ArrowUp':
      return shiftKey ? null : 'up';
    case 'ArrowDown':
      return shiftKey ? null : 'down';
    case 'ArrowLeft':
      return shiftKey ? null : 'left';
    case 'ArrowRight':
      return shiftKey ? null : 'right';
    case 'Enter':
      return shiftKey ? 'up' : 'down';
    case 'Tab':
      return shiftKey ? 'left' : 'right';
    default:
      return null;
  }
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
  let editor: IntegrationEditor | undefined;
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
    editor: () => editor,
    frozenRowCount: () => frozenRowCount,
    frozenColCount: () => frozenColCount,
  });
  const { current: currentMerges, any: hasMergedCells, isMergedCellIndex } = merges;

  // DD-033-1・DD-056 H12: 読み取り専用の切り替え（setReadOnly・flush・変換の終わり待ち）は mount/readonly-switch.ts。
  // 生成時に mount オプションの readOnly を検査して診断を出す（readonly-invalid・readonly-mode）。
  const readonlySwitch = createReadOnlySwitch({
    diag,
    initialReadOnly: options.readOnly,
    isDestroyed: () => destroyed,
    backend: () => sync,
    editor: () => editor,
    closePopups: () => {
      select.close();
      date.close();
    },
    syncCellLock: () => cellLock.syncCellLock(),
  });
  const { isDeferredLockIdle, scheduleEditStateCheck } = readonlySwitch;
  // 読み取り専用の判定（列・行・セル・結合範囲）と、常駐 textarea のロックは mount/cell-lock.ts。
  const cellLock = createCellLock({
    diag,
    isStandalone,
    readOnlyRows: options.readOnlyRows,
    merges,
    backend: () => sync,
    standalone: () => standalone,
    editor: () => editor,
    registry: () => columnTypeRegistry,
  });
  const {
    isReadOnlyRowIndex,
    hasReadOnlyCells,
    isActiveCellReadOnly,
    validateReadOnlyRowsOnce,
    syncCellLock,
  } = cellLock;
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
    editor: () => editor,
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
    editor: () => editor,
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
    editor: () => editor,
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
    editor: () => editor,
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
    editor: () => editor,
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
  const { currentTransform, placementConfig, visibleArea, ensureCellVisible, ensureActiveCellVisible, syncSpacer, syncLayout } = render;
  // 命令 API（scrollToRow・scrollToColumn・setActiveCell）と保留キュー（mount/commands.ts）。
  const commands = createCommands({
    diag,
    selectionCtrl,
    isDestroyed: () => destroyed,
    backend: () => sync,
    editor: () => editor,
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
    editor: () => editor,
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
    editor: () => editor,
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
        editor?.session.noteServerUpdate();
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
    // 描画層（base-layer）を backend へ結線する（区画⑨）。
    render.attach(backend);

    // ---- 編集の命令（区画⑦・mount/edit-commands.ts）を backend へ結線する ----
    editCommands.attach(backend);
    const docPort = editCommands.documentPort();
    const { performRangeClear, performCopy, performCut, performPaste, performUndo, performRedo } = editCommands;

    // ---- DD-027-1 選択式入力列（列タイプメタ・ドロップダウン・editor 経路 validator）----
    /**
     * editor 経路（IME/textarea 確定）の commit を validator でラップする（決定②・📐）。非候補（allowFreeText:false
     * 選択式列）は **未 submit**（文書無変更）＋ `value-not-allowed` 通知（共同編集のみ・standalone は診断のみ）＋
     * 診断（拒否値を含む＝サイレント失敗なし・AC4）。paste/範囲クリア/リモートは submitSetCells を直接呼ぶため
     * 本ラップを通らない＝保持される（AC6）。ドロップダウン確定は候補一致が保証されるため素通しする。
     */
    const editorSubmit = (op: SetCellsOperation): OperationId | void => {
      const registry = columnTypeRegistry;
      if (registry !== undefined) {
        for (const change of op.changes) {
          const columnId = String(change.columnId);
          const text = cellScalarToDisplay(change.value);
          if (!registry.validateEditorCommit(columnId, text).allowed) {
            // 既存の実行前拒否経路へ集約する（Fable 5 P3-8）: 診断＋公開 rejected（共同編集のみ・standalone は診断のみ）。
            editCommands.notifyPreExecutionReject(
              'value-not-allowed',
              'value-not-allowed',
              `選択式列 ${columnId} に非候補値「${text}」が入力されました（未 submit・文書無変更・DD-027-1）`,
            );
            return; // 未 submit（op を捨てる・ドラフト復元はしない＝📐）
          }
        }
      }
      // DD-056 H12: 変換の終わり待ちの間は「切り替えを頼まれた時点の編集」の確定だけを送信の関所で通す（1 回で消費する）。
      return readonlySwitch.runEditorCommit(() => submitSetCells(op, 'edit'));
    };

    // 選択式の候補欄 → 日付カレンダーの順に backend へ結線する（どちらも該当する列があるときだけ DOM を作る）。
    select.attach(backend);
    date.attach(backend);

    const editorLayout: GridLayout = {
      get rowCount() {
        return backend.view.rowAxis.count();
      },
      get columnCount() {
        return backend.view.colAxis.count();
      },
      rowHeaderWidth: HEADER_WIDTH,
      columnHeaderHeight: headerHeight,
      cellWidth: COL_WIDTH,
      cellHeight: ROW_HEIGHT,
    };
    editor = createIntegrationEditor({
      fontForColumn: appearance.fontFor,
      host: stage,
      document: docPort,
      submit: editorSubmit,
      // DD-033-1: 表示専用モードは常駐 textarea へ readOnly 属性＋編集 DOM イベントの dispatch 抑止（分岐追加のみ）。
      readOnly: readonlySwitch.isReadOnly(),
      // DD-035 R4: アクティブセルが readOnly 列にある間、編集 DOM イベントの dispatch を論理遮断する（物理遮断＝readOnly 属性は
      // onChange の syncColumnLock が同期）。DD-035 R6（Codex P1）: 命令 API が初回描画前で保留中の間も入力を遮断する
      // （保留の適用先が確定する前の打鍵を旧セルへ確定させない）。readOnlyColumns 未指定かつ保留なしなら常に false。
      // DD-056 H12（Codex 実装レビュー P1）: 変換の終わり待ちの間、切り替えを頼まれた時点の編集が終わったら新しい編集を始めさせない
      // （textarea の readOnly 属性は次の判定で付く。それまでの論理遮断）。
      isInputLocked: () => commands.hasPending() || isActiveCellReadOnly() || isDeferredLockIdle(),
      // DD-056 H12（Codex 実装レビュー P2）: 変換の終わり待ちの間は textarea の既定の cut も止める（readOnly 属性をまだ付けられないため）。
      isNativeEditBlocked: () => readonlySwitch.isDeferred(),
      // RC1・RC2（DD-052-1）: 折り返し（wrap）列は Alt+Enter でセル内改行・textarea が内容に応じて伸びる。
      isWrapColumn: (columnId) => wrapColumnStrings.has(columnId),
      // RC12（DD-052-2）: 文字列として保つ列は編集確定時の型変換をスキップする。
      isStringColumn: (columnId) => stringColumnStrings.has(columnId),
      // DD-055（RC17）: wrap 列の編集欄を可視域（スクロールバーを除く）の下端で縮める。
      visibleArea,
      // DD-027-1（Fable 5 P3-9）: grid 外クリック等で常駐 textarea が blur したら選択式ドロップダウンを閉じる。
      // 候補クリックは listbox の pointerdown preventDefault で focus を保持するため blur せず、確定を妨げない。
      // DD-035 R2: 日付カレンダーも同様に閉じる。
      onBlur: (target) => {
        if (!select.contains(target)) select.close();
        date.close();
      },
      layout: editorLayout,
      onPresenceChange: (update: PresenceUpdate) => {
        backend.session.sendPresence(update);
        // DD-049 H5: 自分のエントリは送った presence の activeCell を映す（単独モードは collabSession 無し＝一覧は常に空）。
        // 発火は editor の処理が終わった後（マイクロタスク）に遅らせる（理由は schedulePresenceRefresh を参照）。
        events.noteSelfActiveCell(update.activeCell);
        if (collabSession !== undefined) {
          events.schedulePresenceRefresh();
        }
      },
      // K4（DD-021-2・Fable P2）: 削除行への commit で draft を退避したことを利用側へ可視化する。
      // 公開語彙は既存 row-unavailable（=target-row-deleted の写像・error-codes.md）を使い、未 submit ゆえ
      // operationId は空文字（DD-020 実行前拒否と同規約）。standalone は診断のみ（DD-024 契約＝実行前拒否と同型）。
      onDivert: (draft) => {
        diag.emit('warn', 'draft-diverted', `commit 対象行が削除済みのため draft を退避: row=${draft.rowId} col=${draft.columnId}`);
        if (!isStandalone) {
          emit({
            type: 'rejected',
            pendingCount: backend.session.pendingCount,
            conflict: { operationId: '', reason: 'rejected', code: 'row-unavailable' },
          });
        }
      },
      onChange: () => {
        if (editor === undefined) {
          return;
        }
        // DD-064: 移動の結果（編集中の Enter・Tab・矢印での確定と移動を含む）が結合範囲の中なら左上へ寄せる。寄せた先の
        // onChange（入れ子）が以下を済ませるので、ここでは何もしない。
        if (merges.normalizeActiveCell()) {
          return;
        }
        syncCellLock(); // DD-035 R4 / DD-036 C3: activeCell の列・行に応じて textarea の readOnly 属性を同期（非 composing 時のみ）
        ensureActiveCellVisible(); // アクティブセルを可視域へ（scrollTop/Left を同期更新しうる）
        // DD-020-1 AC4: activeCell 移動・編集開始で明示レンジを単一選択へ戻す（不変条件は controller が判定）。
        selectionCtrl.syncWithEditor(editor.session.getActiveCell(), editor.session.getPhase());
        render.setActiveShadow(editor.session.getActiveCell());
        const transform = currentTransform(); // 上の scroll 反映後の transform で配置する
        if (transform !== undefined) {
          editor.refreshPlacement(transform, placementConfig());
        }
        backend.view.markViewportDirty();
        // DD-056 H12: 変換の終わり待ちの切り替え・flush の待ち合わせを、編集の変化を受けて macrotask で判定し直す（無ければ無コスト）。
        scheduleEditStateCheck();
      },
      // keydown 前段裁定（DD-020-1 案X）: Navigation 位相の Shift+矢印をレンジ拡張として消費する。
      // composition 中・編集中は decideNavigationIntercept が必ず 'none' を返し従来経路のまま（CG-1 資産無変更）。
      interceptKeydown: (input) => {
        const current = editor;
        const backendNow = sync;
        if (current === undefined || backendNow === undefined) {
          return false;
        }
        // DD-033-1: readOnly の入口抑止（最優先）。編集開始/セルクリアを起こすキー（F2/Delete/Backspace）を消費する。
        // 閲覧系（矢印・Shift+矢印・Ctrl+C・Escape・PageUp/Down）と composition/非 Navigation は素通し（純関数裁定・AC7）。
        if (
          readonlySwitch.isReadOnly() &&
          shouldSuppressReadonlyKey({
            key: input.key,
            ctrlKey: input.ctrlKey,
            metaKey: input.metaKey,
            altKey: input.altKey,
            shiftKey: input.shiftKey,
            eventComposing: input.isComposing,
            sessionComposing: current.session.isComposing(),
            phase: current.session.getPhase(),
          })
        ) {
          diag.emit('info', 'readonly-blocked', `readOnly: 編集キー「${input.key}」を抑止（閲覧専用）`);
          return true;
        }
        // DD-035 R4: readOnly 列の入口抑止（グリッド readOnly と同じ裁定・アクティブセルの列条件付き）。印字文字は
        // keydown では編集を起こさない（BeginEdit は input 経路）ため pass し、integration-editor の列ロック
        // （readOnly 属性＋dispatch 抑止）が編集開始を遮断する。
        // Codex P2: 明示レンジがあるときの Delete は範囲クリア（readOnly 列だけスキップして他列へ適用）へ流す。
        // アンカーが readOnly 列でも可編集列を含むレンジのクリアは契約どおり成立させる。
        const rangeDelete = input.key === 'Delete' && selectionCtrl.getRange() !== null;
        if (
          (hasReadOnlyCells() || hasMergedCells()) &&
          !rangeDelete &&
          isActiveCellReadOnly() &&
          shouldSuppressReadonlyKey({
            key: input.key,
            ctrlKey: input.ctrlKey,
            metaKey: input.metaKey,
            altKey: input.altKey,
            shiftKey: input.shiftKey,
            eventComposing: input.isComposing,
            sessionComposing: current.session.isComposing(),
            phase: current.session.getPhase(),
          })
        ) {
          const active = current.session.getActiveCell();
          // DD-064: 結合範囲（読むだけ）は専用の診断 code で区別する。
          if (isMergedCellIndex(active.row, active.col)) {
            diag.emit('info', 'merged-cell-blocked', `mergedCells: 結合範囲で編集キー「${input.key}」を抑止`);
            return true;
          }
          diag.emit(
            'info',
            isReadOnlyRowIndex(active.row) ? 'readonly-row-blocked' : 'readonly-column-blocked',
            `readOnlyColumns/readOnlyRows: 編集キー「${input.key}」を抑止`,
          );
          return true;
        }
        // DD-035 R2: 日付カレンダーの前段裁定。open 中は矢印/PageUp/Down/Enter/Esc/Tab を消費し他キーを握り潰す。
        // 閉じている日付セルでは Alt+↓（常時）・F2/Enter（openOn='dblclick'）で開く。印字文字は 'none'＝手入力併存。
        // composition 中・非 Navigation では decideDateKey が必ず 'none'（I-3）。readOnly/列 readOnly は openDate 側で抑止。
        if (date.isAttached()) {
          const active = current.session.getActiveCell();
          const openOn = date.openOnOf(active.col);
          const decision = decideDateKey({
            key: input.key,
            ctrlKey: input.ctrlKey,
            metaKey: input.metaKey,
            altKey: input.altKey,
            shiftKey: input.shiftKey,
            eventComposing: input.isComposing,
            sessionComposing: current.session.isComposing(),
            phase: current.session.getPhase(),
            isOpen: date.isOpen(),
            isDateCell: openOn !== undefined && !readonlySwitch.isReadOnly() && !isActiveCellReadOnly(),
            openOn: openOn ?? 'dblclick',
          });
          switch (decision) {
            case 'open':
              date.open();
              return true;
            case 'move-left':
              date.moveDays(-1);
              return true;
            case 'move-right':
              date.moveDays(1);
              return true;
            case 'move-up':
              date.moveDays(-7);
              return true;
            case 'move-down':
              date.moveDays(7);
              return true;
            case 'prev-month':
              date.moveMonths(-1);
              return true;
            case 'next-month':
              date.moveMonths(1);
              return true;
            case 'confirm': {
              const value = date.highlightedValue();
              if (value === null) {
                date.close();
              } else {
                date.confirm(value);
              }
              return true;
            }
            case 'cancel':
              date.close();
              return true;
            case 'consume':
              return true;
            case 'none':
              break;
          }
        }
        // DD-027-1/057: 選択式ドロップダウンの前段裁定（最優先）。厳格モードは文字/Backspace で候補を選ぶ。
        // 閉じている選択式セルでは編集開始キー（F2/Enter/Alt+↓）でドロップダウンを開く。印字文字も開くのは
        // 厳格モード（allowFreeText:false）だけで、自由入力併存列では textarea 編集へ流す（DD-037 決定①）。
        // composition 中・非 Navigation では decideSelectKey が必ず 'none'＝IME 経路無改変（I-3）。
        if (select.isAttached()) {
          const active = current.session.getActiveCell();
          const decision = decideSelectKey({
            key: input.key,
            ctrlKey: input.ctrlKey,
            metaKey: input.metaKey,
            altKey: input.altKey,
            shiftKey: input.shiftKey,
            eventComposing: input.isComposing,
            sessionComposing: current.session.isComposing(),
            phase: current.session.getPhase(),
            isOpen: select.isOpen(),
            // DD-035 R4: readOnly 列の選択式セルは「非選択式」として裁定する（Enter=下移動等の閲覧系キーを奪わない。
            // 編集開始キーは readonly 裁定/列ロックが遮断済み）。
            isSelectCell: select.isSelectColumnIndex(active.col) && !isActiveCellReadOnly(),
            // DD-037 決定①: 自由入力併存列では印字文字を奪わない（textarea 編集を開始させる）。
            allowsFreeText: select.allowsFreeText(active.col),
          });
          switch (decision) {
            case 'open':
              select.open(input.key.length === 1 ? input.key : undefined);
              return true;
            case 'type':
              select.typeCharacter(input.key);
              backendNow.view.markViewportDirty();
              return true;
            case 'backspace':
              select.backspace();
              backendNow.view.markViewportDirty();
              return true;
            case 'move-down':
              select.highlightNext();
              backendNow.view.markViewportDirty();
              return true;
            case 'move-up':
              select.highlightPrev();
              backendNow.view.markViewportDirty();
              return true;
            case 'confirm':
              select.confirm();
              return true;
            case 'cancel':
              select.close();
              return true;
            case 'consume':
              return true;
            case 'none':
              break;
          }
        }
        // DD-020-3: Ctrl/Cmd+Z=Undo・Ctrl+Y/Ctrl+Shift+Z=Redo（Navigation 位相かつ非 composing のみ・親 (b)）。
        // Editing/Composing 中は decideUndoRedoKey が 'none' を返しブラウザ既定（textarea 内テキスト undo）へ委譲する（I-3）。
        const undoRedo = decideUndoRedoKey({
          key: input.key,
          ctrlKey: input.ctrlKey,
          metaKey: input.metaKey,
          shiftKey: input.shiftKey,
          altKey: input.altKey,
          eventComposing: input.isComposing,
          sessionComposing: current.session.isComposing(),
          phase: current.session.getPhase(),
        });
        if (undoRedo === 'undo') {
          performUndo();
          return true; // Navigation の Ctrl+Z は消費（空でも textarea 既定 undo にしない）
        }
        if (undoRedo === 'redo') {
          performRedo();
          return true;
        }
        // DD-021-1: Ctrl+Shift+'+'=アクティブ行の上へ挿入・Ctrl+'-'=選択行削除（Navigation 位相かつ非 composing のみ・親⑦）。
        // Editing/Composing 中は decideRowStructureKey が 'none' を返しブラウザ既定へ委譲する（IME 不変条件・I-3）。
        const rowKey = decideRowStructureKey({
          key: input.key,
          ctrlKey: input.ctrlKey,
          metaKey: input.metaKey,
          shiftKey: input.shiftKey,
          altKey: input.altKey,
          eventComposing: input.isComposing,
          sessionComposing: current.session.isComposing(),
          phase: current.session.getPhase(),
          rowOperationsEnabled,
        });
        if (rowKey === 'insert') {
          // アクティブ行の**上**へ挿入 → afterRowId=直上行（先頭行なら null）。消費（ブラウザのズームを止める）。
          const active = current.session.getActiveCell();
          const prevId = active.row <= 0 ? undefined : backendNow.view.rowIdAt(active.row - 1);
          performInsertRows(prevId === undefined ? null : String(prevId), 1);
          return true;
        }
        if (rowKey === 'delete') {
          // 選択範囲（無ければ activeCell）の行帯 [rowStart,rowEnd) を RowId 列へ解決して削除。消費。
          const range = selectionCtrl.selectedRange(current.session.getActiveCell());
          const rowIds: string[] = [];
          for (let r = range.rowStart; r < range.rowEnd; r += 1) {
            const id = backendNow.view.rowIdAt(r);
            if (id !== undefined) {
              rowIds.push(String(id));
            }
          }
          performDeleteRows(rowIds);
          return true;
        }
        // DD-064: 結合を 1 つのセルとして動く（Navigation の矢印・Tab・Enter。Shift＋矢印は下の範囲の拡張）。状態機械が動かす先
        // （1 セル先）と違うときだけ消費して、その先へ移す（結合の左上から下・右は範囲の外へ・結合の中へ入ったら左上）。
        // 同じなら状態機械へ流す（結合が無ければ常に同じ＝従来経路のまま）。変換中・編集中は対象外（I-3・編集中の確定と
        // 移動の先は onChange の正規化が左上へ寄せる）。
        if (hasMergedCells() && !input.isComposing && !current.session.isComposing() && current.session.getPhase() === 'Navigation') {
          const direction = mergeMoveDirectionOf(input.key, input.shiftKey);
          if (direction !== null) {
            const active = current.session.getActiveCell();
            const bounds = { rowCount: backendNow.view.rowAxis.count(), colCount: backendNow.view.colAxis.count() };
            const target = moveAcrossMerges(currentMerges(), active, direction, bounds);
            const plain = stepAcrossMerges(EMPTY_MERGE_INDEX, active, direction, bounds);
            if (target.row !== plain.row || target.col !== plain.col) {
              // 動くときだけ明示レンジを解く（グリッドの端で結合の外へ出られないときは、端での通常の矢印と同じく何も変えない）。
              if (target.row !== active.row || target.col !== active.col) {
                selectionCtrl.clear();
                current.pointerdownCell(target);
              }
              backendNow.view.markViewportDirty();
              return true;
            }
          }
        }
        const decision = decideNavigationIntercept({
          key: input.key,
          shiftKey: input.shiftKey,
          eventComposing: input.isComposing,
          sessionComposing: current.session.isComposing(),
          phase: current.session.getPhase(),
          hasRange: selectionCtrl.getRange() !== null,
        });
        switch (decision.action) {
          case 'none':
            return false;
          case 'clear-range':
            // Escape: レンジ解除のみ。キー自体は状態機械へも流す（Navigation の Escape は no-op＝挙動保存）。
            selectionCtrl.clear();
            backendNow.view.markViewportDirty();
            return false;
          case 'delete-range':
            // Delete（レンジあり）: 範囲クリア＝原子 SetCells（AC5/AC6）。消費して状態機械の単一セル
            // Delete（S-A4）にしない。レンジ無しの Delete は 'none' で従来経路のまま。
            performRangeClear();
            return true;
          case 'extend': {
            const focus = selectionCtrl.extendByArrow(current.session.getActiveCell(), decision.direction, {
              rowCount: backendNow.view.rowAxis.count(),
              colCount: backendNow.view.colAxis.count(),
            });
            ensureCellVisible(focus); // focus 端を可視域へ（Excel 準拠の scroll-follow）
            backendNow.view.markViewportDirty();
            return true; // 消費（状態機械の Move にしない）
          }
        }
      },
      // DD-020-2 clipboard 裁定（Navigation 位相のみ）。composition/編集中は各 perform が null/false を返す。
      onClipboardCopy: performCopy,
      onClipboardCut: performCut,
      onClipboardPaste: performPaste,
    });

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
      editor?.destroy(); // 常駐 textarea/badge・editor listeners を解放
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
      editor: () => editor,
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

