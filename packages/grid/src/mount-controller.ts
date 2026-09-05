// grid Facade の mount 配線（旧 apps/playground/src/integration/main.ts を昇華）。
//
// pocb の Canvas 基盤（render）を使い、値の源を ClientSession（共同編集の唯一の正本）→ DocumentView（読み取り
// アダプター）に置く。IME は編集状態機械＋常駐 textarea（integration-editor）。挙動は main.ts と等価に保ちつつ、
// ①DOM は container 内に構築（dom-scaffold・D4）②SessionEvent を GridEvent へ写像して購読者へ配信③readout 表示は
// 持たず、代わりに destroy() で全リソース（RAF/interval/listener/ResizeObserver/WS/canvas/textarea）を解放する
// （再mountで leak しない・AC2）④E2E 用 introspection は debugRegistry 経由（test-support）で露出する。

import { SETCELLS_MAX_CELLS, cloneCellScalar, documentHash, displayRowOrder, getCell, parseClipboardText, validateOperation } from '@nanairo-sheet/core';
import type { DeleteRowsOperation, InsertRowsOperation, SetCellsChange, SetCellsOperation, SheetDocument } from '@nanairo-sheet/core';
import { createColumnId, createDocumentId, createRowId } from '@nanairo-sheet/types';
import type { ColumnId, OperationId, RowId } from '@nanairo-sheet/types';
import type { Clock, IdGenerator, PresenceUpdate, SessionEvent } from '@nanairo-sheet/collab';
import {
  BADGE_TEXT_PADDING,
  CELL_TEXT_LINE_HEIGHT,
  CELL_TEXT_PADDING,
  backingSize,
  captureAnchor,
  columnLabel,
  correctScroll,
  createBaseLayer,
  createOverlayLayer,
  createTextMetricsCache,
  createViewportTransform,
} from '@nanairo-sheet/render';
import type { CellRect, FrameViewport, OverlayFrame, TextMetricsCache, ViewportTransform } from '@nanairo-sheet/render';
import { singleCell } from '@nanairo-sheet/selection';
import type { CellRange } from '@nanairo-sheet/selection';
import type { CellPosition, GridLayout } from '@nanairo-sheet/ime';

import { BrowserWebSocketTransport } from './browser-transport';
import { cellScalarToDisplay } from './document-view';
import { computeEditorPlacement } from './editor-placement';
import type { PlacementConfig } from './editor-placement';
import { captureEditStartRevision, draftToScalar, isRowLive } from './commit-bridge';
import { ColumnTypeConfigError, createColumnTypeRegistry, isAbsoluteHttpUrl } from './column-types';
import type { ColumnTypeRegistry } from './column-types';
import { FormatRuleConfigError, compileColumnBackgrounds, compileFormatRules, compileRowBackgrounds } from './format-rules';
import type { CompiledColumnBackgrounds, CompiledColumnFormats, CompiledRowBackgrounds } from './format-rules';
import { BorderConfigError, compileBorders, normalizeCanvasBorderColor, type CompiledBorders } from './border-rules';
import { DisplayConfigError, compileDisplayFormats } from './display-format';
import type { CompiledColumnDisplay } from './display-format';
import { shouldArmLinkCandidate } from './link-column';
import { createSelectDropdown, decideSelectKey, filterOptionsByPrefix } from './select-editor';
import type { SelectDropdown } from './select-editor';
import { createDatePicker, decideDateKey } from './date-editor';
import type { DatePicker } from './date-editor';
import type { EditingDocumentPort } from './ime-editing-session';
import { createIntegrationEditor } from './integration-editor';
import type { IntegrationEditor } from './integration-editor';
import { createLoadMetrics } from './initial-load-metrics';
import { toPresenceUsers } from './presence-adapter';
import { createSessionSync } from './session-sync';
import { buildScaffold } from './dom-scaffold';
import { buildRangeClear } from './range-ops';
import {
  buildPaste,
  serializeSelectionToTsv,
  shouldInterceptClipboard,
} from './clipboard-controller';
import type { ClipboardDocumentPort, PasteRect } from './clipboard-controller';
import { autoFitColumnWidth, computeAutoFitContentWidth, computeResizeSize, resizeHitTest } from './resize-interaction';
import type { ResizeTarget } from './resize-interaction';
import { createSelectionController, decideNavigationIntercept } from './selection-controller';
import {
  partitionReadOnlyColumnChanges,
  partitionReadOnlyRowChanges,
  shouldSuppressReadonlyKey,
  touchesReadOnlyColumn,
  touchesReadOnlyRow,
} from './readonly-policy';
import { decideRowStructureKey, rebaseRowIndex, resolveDeleteTargets } from './row-operations';
import { createUndoController, decideUndoRedoKey } from './undo-stack';
import type { UndoPatch } from './undo-stack';
import { GridBootError, toGridConflictCode } from './error-codes';
import type { GridConflictCode } from './error-codes';
import { createDiagnosticSink } from './diagnostics';
import { debugRegistry } from './internal';
import type { GridDebugApi, GridDebugCellAddress } from './internal';
import { createStandaloneSession } from './standalone-session';
import type { StandaloneSession } from './standalone-session';
import { validateStandaloneOptions } from './standalone-options';
import type { GridBackend } from './grid-backend';
import type {
  GridCollaborationMountOptions,
  GridConnectionState,
  GridEvent,
  GridInstance,
  GridMountOptions,
  GridMountTarget,
  GridRowStructureChange,
  GridStandaloneData,
  GridStandaloneMountOptions,
} from './index';

const HEADER_WIDTH = 52;
const HEADER_HEIGHT = 24;
const ROW_HEIGHT = 22;
const COL_WIDTH = 80;
const TICK_INTERVAL_MS = 1_000;
// リンク列 dblclick の2打目抑止窓（ms・DD-027-2）。同一セルでこの間隔内の連打は「2打目」と見なし link-open を再発火しない
// （実ブラウザーは PointerEvent.detail>=2 が主判定・本窓は detail=0 固定の synthetic 環境を補完する）。標準 dblclick 相当。
const LINK_DBLCLICK_MS = 400;
// セル文字フォント（base-layer 描画・自動行高の測定で共有する。両者で一致していないと wrap 行数がずれる・DD-012-5）。
const CELL_FONT = '13px system-ui, sans-serif';
// 列ヘッダーフォント（base-layer と一致。auto-fit のヘッダーラベル幅測定に使う・DD-027-3）。
const HEADER_FONT = '12px system-ui, sans-serif';
// auto-fit の非空セル走査上限（DD-027-3・C級）。50k 行列の単発 dblclick でも予算内に収めるため、これを超えたら
// それまでの最大幅を採用して打ち切る（診断 info）。
const AUTO_FIT_MAX_SCAN = 10_000;
// DD-035 R6: 命令 API（scrollToRow/setActiveCell）の保留上限（構造 flush 待ち・初回描画待ち）。
const PENDING_COMMANDS_MAX = 64;

interface ResolvedConfig {
  documentId: string;
  columnOrder: string[];
}

/** GridMountOptions を受けて grid を container へ配線し、GridInstance を返す（同期 return・boot は非同期進行）。 */
export function createGridController(target: GridMountTarget, options: GridMountOptions): GridInstance {
  const scaffold = buildScaffold(target.container);
  const { stage, baseCanvas, overlayCanvas, scroller, spacer, baseCtx, overlayCtx } = scaffold;

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
  // boot（microtask）完了前に setData が呼ばれたときの保留データ（Codex[P1]: mount 直後の同期 setData を捨てない）。
  let pendingStandaloneData: GridStandaloneData | undefined;
  let editor: IntegrationEditor | undefined;
  let browserTransport: BrowserWebSocketTransport | undefined;
  // DD-027-1: 列タイプメタの Internal registry（columnOrder 解決後に生成・fail-fast）と選択式ドロップダウン。
  let columnTypeRegistry: ColumnTypeRegistry | undefined;
  let selectDropdown: SelectDropdown | undefined;
  // DD-027-3: セル書式のプリコンパイル済み解決器（columnOrder 解決後に生成・fail-fast）。書式なしなら hasAny()=false で
  // base-layer への束縛を省き描画コスト増をゼロにする。
  let compiledFormats: CompiledColumnFormats | undefined;
  // DD-036 C2: 静的列背景（columnBackgrounds）のプリコンパイル済み解決器（columnOrder 解決後に生成・fail-fast）。
  // hasAny()=false なら base-layer への columnBackground 束縛を省き列バンド描画そのものを行わない（現行描画と一致）。
  let compiledBackgrounds: CompiledColumnBackgrounds | undefined;
  // DD-045: 静的行背景。hasAny()=false なら rowBackground フックを束縛せず、描画コスト増ゼロ。
  let compiledRowBackgrounds: CompiledRowBackgrounds | undefined;
  let compiledBorders: CompiledBorders | undefined;
  let rowBordersChecked = false;
  // DD-033-2: 列見出しキャプション＋表示書式のプリコンパイル済み解決器（columnOrder 解決後に生成・fail-fast）。
  // hasAny()=false（両オプション未指定）なら base-layer への columnHeaderLabel/formatCellText フック束縛を省く。
  let compiledDisplay: CompiledColumnDisplay | undefined;
  // 選択式ドロップダウンの制御は attachBackendRendering 内で backend/editor を閉じ込めた関数として定義し、
  // createGridController 直下の handler（dblclick・pointerdown・redraw）からは以下の ref 経由で呼ぶ。
  let openSelectForActive: (() => void) | undefined;
  let isSelectColumnIndex: ((colIndex: number) => boolean) | undefined;
  let closeSelectDropdown: (() => void) | undefined;
  let refreshSelectPlacement: ((transform: ViewportTransform) => void) | undefined;
  // DD-035 R2: 日付カレンダー（select と同方式の ref。attachBackendRendering 内で backend/editor を閉じ込めて定義する）。
  let datePicker: DatePicker | undefined;
  let closeDatePicker: (() => void) | undefined;
  let openDateForActive: (() => void) | undefined;
  /** 列 index が「dblclick で開く日付列」か（dblclick 分岐用。openOn='icon' の列は従来どおり textarea 編集）。 */
  let isDblclickDateColumnIndex: ((colIndex: number) => boolean) | undefined;
  let refreshDatePlacement: ((transform: ViewportTransform) => void) | undefined;
  let baseLayer: ReturnType<typeof createBaseLayer> | undefined;
  let dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  let viewportWidth = 0;
  let viewportHeight = 0;
  let selection: CellRange | null = null;
  // 矩形範囲選択の所有者（DD-020-1 案X）。activeCell の所有は editor-state-machine のまま・レンジのみここが持つ。
  const selectionCtrl = createSelectionController();
  // Undo/Redo スタックの所有者（DD-020-3）。確定単位（1 op）ごとに逆値を保持し補償 SetCells を生成する。
  const undoCtrl = createUndoController();
  let firstDataDrawn = false;
  let lastSessionEvent: SessionEvent | undefined;
  let resolvedDocumentId = options.documentId;
  let hasEverConnected = false; // 一度でも接続確立したか（初回接続失敗のみ connect error として通知・P1-2）
  let focusRequested = false; // boot 完了前の focus() 要求（初回配置後に適用・P2-3）
  // DD-035 R6: 命令 API（scrollToRow/setActiveCell）の保留キュー。boot 未完了・初回描画前・構造 dirty 中
  // （setData／行挿入削除の直後で rowAxis が未再構築）は RowId→index が旧 Axis を指し、しかも masterLoop の
  // scroll anchor 補正が直後に scrollTop を上書きするため、次の構造 flush（補正の後）まで保留して適用する。
  // これにより `setData(...)` → 直後の `scrollToRow(newId)` が成立する（松下 DD-012-1 の実測課題）。
  let pendingCommands: Array<() => void> = [];

  // ---- 購読・後始末 ----
  const listeners = new Set<(event: GridEvent) => void>();
  if (options.onEvent !== undefined) {
    listeners.add(options.onEvent);
  }
  const abort = new AbortController();
  const { signal } = abort;
  let rafId = 0;
  let intervalId = 0;
  let destroyed = false;

  // 診断ログ hook（opt-in・既定無出力）。GridEvent（consumer 契約）とは別系統の障害切り分け用。
  const diag = createDiagnosticSink(options.onDiagnostic);

  // DD-033-1: 表示専用モード（readOnly）。mount 時固定・両モード共通。boolean 単値ゆえ構成不整合が無く fail-fast なし。
  // TS 型（boolean|undefined）が正規経路を強制するが、JS 経路の非 boolean は `=== true` の厳密判定で編集可能側へ倒し、
  // undefined 以外の非 boolean は mount 時に診断 warn（readonly-invalid・公開 error code へは追加しない・決定事項）。
  const rawReadOnly: unknown = options.readOnly;
  const readOnly = rawReadOnly === true;
  if (rawReadOnly !== undefined && typeof rawReadOnly !== 'boolean') {
    diag.emit('warn', 'readonly-invalid', `readOnly は boolean が必要（受領: ${typeof rawReadOnly}）→ 編集可能として扱う`);
  }
  if (readOnly) {
    // mount 時に1件（E2E/障害切り分けの確認点・決定事項）。抑止発動ごとの readonly-blocked とは別。
    diag.emit('info', 'readonly-mode', '表示専用モード（readOnly=true）でマウント: 文書変更を抑止し閲覧系のみ許可');
  }

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

  function emit(event: GridEvent): void {
    for (const listener of [...listeners]) {
      listener(event);
    }
  }

  function toGridEvent(event: SessionEvent): GridEvent {
    switch (event.type) {
      case 'connection':
        return { type: 'connection', state: event.state, pendingCount: event.pendingCount };
      case 'pending':
        return { type: 'pending', pendingCount: event.pendingCount };
      case 'rejected':
        return {
          type: 'rejected',
          pendingCount: event.pendingCount,
          conflict: {
            operationId: String(event.entry.operationId),
            reason: event.entry.reason,
            // 内部 RejectCode を素通しせず公開語彙へ写像する（R7・未知は 'unknown'）。
            code: toGridConflictCode(event.entry.reason, event.entry.code),
          },
        };
      case 'divergence':
        return {
          type: 'divergence',
          serverRevision: event.serverRevision,
          committedRevision: event.committedRevision,
        };
    }
  }

  // ---- 描画層（overlay は即時・base は接続後の DocumentView へ束縛するため遅延生成）----
  const overlayLayer = createOverlayLayer({
    ctx: overlayCtx,
    headerWidth: HEADER_WIDTH,
    headerHeight: HEADER_HEIGHT,
  });

  function overscanY(): number {
    return viewportHeight * 0.6;
  }
  function overscanX(): number {
    return COL_WIDTH * 3;
  }

  function currentTransform(): ViewportTransform | undefined {
    if (sync === undefined) {
      return undefined;
    }
    return createViewportTransform({
      rowAxis: sync.view.rowAxis,
      colAxis: sync.view.colAxis,
      headerWidth: HEADER_WIDTH,
      headerHeight: HEADER_HEIGHT,
      frozenRowCount,
      frozenColCount,
      viewportWidth,
      viewportHeight,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop,
      overscanX: overscanX(),
      overscanY: overscanY(),
    });
  }

  function placementConfig(): PlacementConfig {
    return {
      headerWidth: HEADER_WIDTH,
      headerHeight: HEADER_HEIGHT,
      viewportWidth,
      viewportHeight,
      frozenRowCount,
      frozenColCount,
    };
  }

  function frameViewport(transform: ViewportTransform): FrameViewport {
    return { transform, viewportWidth, viewportHeight, dpr };
  }

  function overlayFrame(transform: ViewportTransform): OverlayFrame {
    return {
      transform,
      viewportWidth,
      viewportHeight,
      dpr,
      // 明示レンジ（DD-020-1）があればそれを、無ければ activeCell の単一セル（onChange が更新する shadow）を描く。
      selection: selectionCtrl.getRange() ?? selection,
      dragRange: selectionCtrl.getDragRange(),
      presences: sync !== undefined ? toPresenceUsers(sync.session.knownPresences(), sync.view) : [],
    };
  }

  function redraw(): void {
    const transform = currentTransform();
    if (transform === undefined || baseLayer === undefined) {
      return;
    }
    baseLayer.draw(frameViewport(transform));
    overlayLayer.draw(overlayFrame(transform));
    editor?.refreshPlacement(transform, placementConfig());
    // DD-027-1: 選択式ドロップダウン（listbox）と ▼ インジケーターを scroll/構造Op に追従させる。
    refreshSelectPlacement?.(transform);
    // DD-035 R2: 日付カレンダー（ポップオーバー）と 📅 インジケーターも同様に追従させる。
    refreshDatePlacement?.(transform);
  }

  /**
   * 指定セルが body viewport の外にあれば最小スクロールで可視域へ入れる（Excel 準拠の scroll-follow）。
   * activeCell 移動（onChange）と Shift+矢印の focus 端拡張（DD-020-1）で呼ぶ。可視セルなら何もしない
   * （クリックで勝手にスクロールしない）。scroller.scrollTop/Left への代入は同期反映され、scroll イベント→
   * 再描画で追従する。
   */
  function ensureCellVisible(cell: CellPosition, axes: 'both' | 'vertical' | 'horizontal' = 'both'): void {
    const transform = currentTransform();
    if (transform === undefined) {
      return;
    }
    const rect = transform.cellRect(cell.row, cell.col);
    const bodyOriginX = HEADER_WIDTH + transform.frozenWidth();
    const bodyOriginY = HEADER_HEIGHT + transform.frozenHeight();
    // 固定行/列のセルはスクロール非依存ゆえ追従不要（body セルのみ）。
    // DD-036 C4: 軸指定（scrollToRow=縦のみ / scrollToColumn=横のみ）。既定 'both' は従来と同一挙動。
    if (axes !== 'horizontal' && cell.row >= frozenRowCount) {
      if (rect.y < bodyOriginY) {
        scroller.scrollTop += rect.y - bodyOriginY; // 上へはみ出し → スクロールアップ（負）
      } else if (rect.y + rect.height > viewportHeight) {
        scroller.scrollTop += rect.y + rect.height - viewportHeight; // 下へはみ出し → スクロールダウン
      }
    }
    if (axes !== 'vertical' && cell.col >= frozenColCount) {
      if (rect.x < bodyOriginX) {
        scroller.scrollLeft += rect.x - bodyOriginX;
      } else if (rect.x + rect.width > viewportWidth) {
        scroller.scrollLeft += rect.x + rect.width - viewportWidth;
      }
    }
  }

  function ensureActiveCellVisible(): void {
    if (editor === undefined) {
      return;
    }
    ensureCellVisible(editor.session.getActiveCell());
  }

  // ---- DD-035 R6: 命令 API（scrollToRow / setActiveCell）----
  /** 命令を即時実行できる状態か（backend 配線済み・初回描画済み・構造 dirty なし）。 */
  function canRunCommandsNow(): boolean {
    return sync !== undefined && firstDataDrawn && !sync.view.hasStructuralDirty();
  }

  /**
   * 列方向の命令（scrollToColumn）を即時実行できる状態か（DD-036・Codex P2）。
   * 行方向と違い**初回描画（firstDataDrawn）を条件にしない**: 行が 0 件の文書では `markFirstDataDraw` が永遠に
   * 立たず、列だけを持つ空シートで `scrollToColumn` がキューに残り続けるため。列 Axis と viewport の寸法が
   * 揃っていれば横スクロールは成立する。
   */
  function canRunColumnCommandsNow(): boolean {
    return (
      sync !== undefined &&
      !sync.view.hasStructuralDirty() &&
      sync.view.colAxis.count() > 0 &&
      viewportWidth > 0
    );
  }

  /**
   * 命令を即時実行するか、次の構造 flush 後まで保留する（保留中の複数命令は呼び出し順に適用する）。
   * 保留は上限（PENDING_COMMANDS_MAX）で古い順に捨てる: 空文書（初回描画が起きない）や boot 失敗のまま利用側が
   * 呼び続けても無限に溜めない（最後の要求だけ意味を持つ操作なので古いものは安全に捨てられる）。
   */
  function runOrDefer(command: () => void, canRunNow: () => boolean = canRunCommandsNow): void {
    if (destroyed) {
      return;
    }
    // Codex P1: 構造 dirty（setData／行挿入削除の直後）なら次 rAF を待たず**同期的に**構造 flush してから適用する。
    // 保留のままだと、その間に届いた利用者入力（ボタン→insertRows→setActiveCell 直後の打鍵）が旧アクティブセルで
    // BeginEdit し、保留命令の pointerdownCell がそれを旧セルへ確定してしまう（誤セル確定）。
    if (sync !== undefined && firstDataDrawn && sync.view.hasStructuralDirty()) {
      flushStructural(sync.view);
    }
    if (canRunNow()) {
      command();
      return;
    }
    if (pendingCommands.length >= PENDING_COMMANDS_MAX) {
      pendingCommands.shift();
      diag.emit('warn', 'command-queue-overflow', `命令 API の保留が上限 ${PENDING_COMMANDS_MAX} を超えたため最古の要求を破棄`);
    }
    pendingCommands.push(command);
  }

  /**
   * masterLoop が構造 flush（scroll anchor 補正含む）の後に呼ぶ: 保留命令を新 Axis で適用する。
   * DD-036（Codex P2）: 行が 0 件のままでも列命令は成立するため、行 ready・列 ready のどちらかで drain する
   * （個々の命令は自分の前提が崩れていれば内部で no-op＋診断する）。
   */
  function drainPendingCommands(): void {
    if (pendingCommands.length === 0 || !(canRunCommandsNow() || canRunColumnCommandsNow())) {
      return;
    }
    const commands = pendingCommands;
    pendingCommands = [];
    for (const command of commands) {
      command();
    }
  }

  /**
   * scrollToRow の実体（可視化のみ・横スクロールは動かさない）。
   * DD-036 C4: 軸指定 'vertical' で明示する（従来の「col: 0 は固定列だから横が動かない」という暗黙前提を廃止＝
   * `frozenColumnCount: 0` でも横スクロールが動かない）。
   */
  function performScrollToRow(rowId: string): void {
    const backend = sync;
    if (backend === undefined) {
      return;
    }
    const row = backend.view.rowIndexOf(createRowId(rowId));
    if (row < 0) {
      diag.emit('warn', 'scroll-row-unknown', `scrollToRow: 未知の行 rowId=${rowId}（tombstone/未注入）→ 無視`);
      return;
    }
    ensureCellVisible({ row, col: 0 }, 'vertical');
    backend.view.markViewportDirty();
    diag.emit('info', 'scroll-to-row', `scrollToRow: rowId=${rowId} index=${row}`);
  }

  /** scrollToColumn の実体（DD-036 C4・performScrollToRow の鏡像。縦スクロールは動かさない）。 */
  function performScrollToColumn(columnId: string): void {
    const backend = sync;
    if (backend === undefined) {
      return;
    }
    const col = backend.view.colIndexOf(createColumnId(columnId));
    if (col < 0) {
      diag.emit('warn', 'scroll-column-unknown', `scrollToColumn: 未知の列 columnId=${columnId} → 無視`);
      return;
    }
    ensureCellVisible({ row: 0, col }, 'horizontal');
    backend.view.markViewportDirty();
    diag.emit('info', 'scroll-to-column', `scrollToColumn: columnId=${columnId} index=${col}`);
  }

  /**
   * setActiveCell の実体。セルクリック（scroller pointerdown）と同じ経路: 開いている選択式/日付ポップアップを閉じ、
   * 明示レンジを解除し、editor.pointerdownCell（編集中は確定して移動・composition 中は pendingNavigation・常駐 textarea へ
   * focus）→ 可視化。activeCell の所有は editor-state-machine のまま（無改変・I-3）。
   */
  function performSetActiveCell(rowId: string, columnId: string): void {
    const backend = sync;
    if (backend === undefined || editor === undefined) {
      return;
    }
    const row = backend.view.rowIndexOf(createRowId(rowId));
    const col = backend.view.colIndexOf(createColumnId(columnId));
    if (row < 0 || col < 0) {
      diag.emit(
        'warn',
        'active-cell-unknown',
        `setActiveCell: 未知のセル rowId=${rowId} columnId=${columnId}（row=${row} col=${col}）→ 無視`,
      );
      return;
    }
    closeSelectDropdown?.();
    closeDatePicker?.();
    selectionCtrl.clear();
    editor.pointerdownCell({ row, col });
    ensureCellVisible({ row, col }); // composition 中は activeCell が動かない（pendingNavigation）が可視化はしておく
    backend.view.markViewportDirty();
    diag.emit('info', 'set-active-cell', `setActiveCell: rowId=${rowId} columnId=${columnId} → (${row},${col})`);
  }

  function provisionCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
    const backing = backingSize({ width: viewportWidth, height: viewportHeight }, dpr);
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${viewportHeight}px`;
    canvas.width = backing.width;
    canvas.height = backing.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function syncSpacer(): void {
    const transform = currentTransform();
    if (transform === undefined) {
      return;
    }
    spacer.style.width = `${transform.scrollableWidth()}px`;
    spacer.style.height = `${transform.scrollableHeight()}px`;
  }

  function syncLayout(): void {
    dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    viewportWidth = Math.max(0, Math.floor(stage.clientWidth));
    viewportHeight = Math.max(0, Math.floor(stage.clientHeight));
    provisionCanvas(baseCanvas, baseCtx);
    provisionCanvas(overlayCanvas, overlayCtx);
    baseLayer?.textCache.clear();
    // DPR・Web font 変更で行分割キャッシュが消える → 折り返し行数が変わりうるため自動行高を再計算する（D5 ③相当）。
    if (wrapEnabled) {
      sync?.view.onTextMetricsChanged();
    }
    syncSpacer(); // 自動行高変化で総サイズが変わる → spacer を更新

    sync?.view.markViewportDirty();
  }

  function markFirstDataDraw(): void {
    if (!firstDataDrawn && sync !== undefined && sync.view.rowAxis.count() > 0) {
      firstDataDrawn = true;
      metrics.mark('firstDraw');
      metrics.mark('firstOperable');
      validateReadOnlyRowsOnce(); // DD-036 C3: 未知 rowId の診断 warn（初回描画後に 1 回だけ）
      validateRowBackgroundsOnce(); // DD-045: 未知 RowId の診断 warn（初回描画後に 1 回だけ）
      if (!rowBordersChecked && compiledBorders !== undefined && sync !== undefined) {
        rowBordersChecked = true;
        const unknown = compiledBorders.rowIds.filter((id) => sync?.view.rowIndexOf(createRowId(id)) === -1);
        if (unknown.length > 0) diag.emit('warn', 'row-border-unknown', `rowBorders: 未知の行 ${unknown.join(', ')} → 到着後に適用`);
      }
      syncCellLock(); // DD-036（Codex P2）: 初回データ描画時点の activeCell（0,0）のロックを確定させる
      if (focusRequested) {
        focusRequested = false;
        editor?.focus(); // boot 前に要求された focus を初回配置後に適用する（P2-3）
      }
    }
  }

  /**
   * 構造Op の flush: scroll anchor 捕捉 → rowAxis 再構築 → K3 再ベース → scroll 補正（画面が跳ばないように・§13.4）。
   * masterLoop（rAF）が呼ぶほか、DD-035 R6 の命令 API（scrollToRow/setActiveCell）が構造 dirty 中に呼ばれたとき
   * **同期的に**呼ぶ（次 rAF まで保留すると、その間の利用者入力が旧アクティブセルへ届き誤セル確定になる＝Codex P1）。
   */
  function flushStructural(view: NonNullable<typeof sync>['view']): void {
    const hasBodyRows = view.rowAxis.count() > frozenRowCount;
    const anchor = hasBodyRows
      ? captureAnchor({
          rowAxis: view.rowAxis,
          colAxis: view.colAxis,
          frozenRowCount,
          frozenColCount,
          scrollTop: scroller.scrollTop,
          scrollLeft: scroller.scrollLeft,
        })
      : null;
    // K3（DD-021-3）: 再構築の**前**に「今どの RowId を指しているか」を旧 Axis から採取する（activeCell・選択端）。
    const rebase = captureRebaseState();
    const result = view.flush();
    if (result.structuralRebuilt) {
      metrics.mark('axisBuilt');
    }
    // rowAxis 再構築後に activeCell/選択レンジを RowId で新 index へ引き直す（表示 index ずれの是正）。
    applyRebaseState(rebase);
    syncSpacer();
    if (anchor !== null) {
      const corrected = correctScroll({
        rowAxis: view.rowAxis,
        colAxis: view.colAxis,
        frozenRowCount,
        frozenColCount,
        anchor,
      });
      scroller.scrollTop = corrected.scrollTop;
      scroller.scrollLeft = corrected.scrollLeft;
    }
    if (result.needsRedraw) {
      redraw();
      markFirstDataDraw();
    }
    // DD-036（Codex P2）: 構造変更で activeCell の**行 index が変わらないまま指す行が入れ替わる**ことがある
    // （readOnly 行を削除して下の可編集行が同じ index に来る等）。この経路は applyRebaseState が editor を触らない
    // ＝onChange が起きないため、ここで必ずロックを取り直す（未指定なら即 return・同値なら DOM を書かない）。
    syncCellLock();
  }

  function masterLoop(): void {
    const view = sync?.view;
    if (view !== undefined) {
      if (view.hasStructuralDirty()) {
        flushStructural(view);
      } else {
        const result = view.flush();
        if (result.needsRedraw) {
          // 自動行高が変わると総サイズ（totalSize）が変わるため spacer を同期する（末尾まで scroll 可能に維持）。
          if (wrapEnabled) {
            syncSpacer();
          }
          redraw();
          markFirstDataDraw();
        }
      }
      // DD-035 R6: 構造 flush（scroll anchor 補正・再ベース）の**後**に保留命令を適用する（新 Axis で RowId を解決）。
      drainPendingCommands();
    }
    if (!destroyed) {
      rafId = requestAnimationFrame(masterLoop);
    }
  }

  // ---- ポインター（選択・ダブルクリックで編集・ヘッダー境界リサイズ）----
  function stageLocal(event: PointerEvent): { x: number; y: number } {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  // 列幅・行高リサイズのドラッグ状態（DD-012-4）。null=非リサイズ。対象は index ではなく Id で保持し、
  // ドラッグ中に他クライアントの構造Op で Axis が作り直されても正しい列/行を追い続ける（Codex[P2]）。
  // originalSize は pointercancel/capture 喪失時に開始時サイズへ戻すため（D2 は pointerup のみ確定・Codex[P2]）。
  type ResizeDrag =
    | { readonly axis: 'column'; readonly columnId: ColumnId; readonly pointerId: number; readonly originalSize: number }
    | {
        readonly axis: 'row';
        readonly rowId: RowId;
        readonly pointerId: number;
        readonly originalSize: number;
        // 開始時の手動 override 状態（DD-012-5 Codex P2）。取消時に実効 px でなくこの状態へ戻す
        // （自動高を誤って手動化しない＝以後の自動縮小を殺さない）。undefined=開始時は手動 override 無し。
        readonly originalManual: number | undefined;
      };
  let resizeDrag: ResizeDrag | null = null;

  // 範囲選択ドラッグの追跡（DD-020-1）。null=非ドラッグ。矩形自体は selectionCtrl が持ち、ここは
  // 「どの pointer のドラッグか」だけを持つ（マルチタッチの誤更新防止・resizeDrag と同型）。
  let selectionDrag: { readonly pointerId: number } | null = null;

  // DD-027-2: ハイパーリンク列のクリック候補追跡（候補追跡方式・📐）。pointerdown で武装（arm）→ ドラッグで開始セルを
  // 離れたら破棄 → pointerup で生存していれば link-open を発火する。既存経路（activeCell 移動・ドラッグ選択・編集確定）は
  // 無変更のまま上乗せする（T1 非該当）。value は pointerdown 時点で捕捉（pointerup 時に行が消えていてもその値で発火してよい）。
  let linkCandidate:
    | { readonly pointerId: number; readonly rowId: RowId; readonly columnId: ColumnId; readonly value: string; readonly cell: CellPosition }
    | null = null;
  // dblclick 2打目の抑止（📐「detail===1」の実ブラウザー/synthetic 両対応）。直近 link-open 発火の論理セル（rowId/columnId）と
  // 時刻を記録し、同一セルで既定間隔内の連打は「2打目」と見なして武装しない。実ブラウザーは detail>=2 が主判定で、
  // 本 time-guard は detail 非供給（synthetic）環境の補完に**限定**する（Fable P2: detail>=1 の正当な2回目クリックを握り潰さない）。
  // キーは行 index でなく rowId/columnId（Fable P2: 発火直後のリモート行挿入/削除で index がずれても別セルを誤抑止しない）。
  let lastLinkFire: { rowId: RowId; columnId: ColumnId; time: number } | null = null;

  /** 列 index がリンク列か（列単位・hover cursor と候補武装で共有・DD-027-2）。registry 未生成/列消失は false。 */
  function isLinkColumnIndex(colIndex: number): boolean {
    if (columnTypeRegistry === undefined || sync === undefined) {
      return false;
    }
    const colId = sync.view.columnIdAt(colIndex);
    return colId !== undefined && columnTypeRegistry.isLinkColumn(String(colId));
  }

  // ---- DD-035 R4: 列単位 readOnly（readOnlyColumns）の判定（入口・chokepoint・textarea ロックで共有）----
  /** readOnlyColumns が 1 つでもあるか（無ければ以下の判定は全て即 false＝現行経路のコスト増ゼロ）。 */
  function hasReadOnlyColumns(): boolean {
    return columnTypeRegistry?.hasAnyReadOnlyColumn() === true;
  }
  /** ColumnId 文字列が readOnly 列か（SetCells フィルタ・chokepoint 用）。 */
  function isReadOnlyColumnId(columnId: string): boolean {
    return columnTypeRegistry?.isReadOnlyColumn(columnId) === true;
  }
  /** 列 index が readOnly 列か（dblclick・キー裁定・インジケーター用）。registry 未生成/列消失は false。 */
  function isReadOnlyColumnIndex(colIndex: number): boolean {
    if (!hasReadOnlyColumns() || sync === undefined) {
      return false;
    }
    const colId = sync.view.columnIdAt(colIndex);
    return colId !== undefined && isReadOnlyColumnId(String(colId));
  }
  // ---- DD-036 C3: 行単位 readOnly（readOnlyRows）の判定（列版と同型・mount 固定・未知 rowId は warn のみ）----
  // 列（columnOrder で mount 時に全 ID が既知）と違い行 ID は初期データ到着前に検証できないため registry へは
  // 載せず、ここで Set を持つ（重複は集合として吸収＝fail-fast しない・契約 §3）。
  const readOnlyRowSet = new Set<string>((options.readOnlyRows ?? []).map((r) => String(r)));
  /** readOnlyRows が 1 つでもあるか（無ければ以下の判定は全て即 false＝現行経路のコスト増ゼロ）。 */
  function hasReadOnlyRows(): boolean {
    return readOnlyRowSet.size > 0;
  }
  /** RowId 文字列が readOnly 行か（SetCells フィルタ・chokepoint 用）。 */
  function isReadOnlyRowId(rowId: string): boolean {
    return readOnlyRowSet.has(rowId);
  }
  /** 行 index が readOnly 行か（dblclick・キー裁定・インジケーター用）。行消失は false。 */
  function isReadOnlyRowIndex(rowIndex: number): boolean {
    if (!hasReadOnlyRows() || sync === undefined) {
      return false;
    }
    const rowId = sync.view.rowIdAt(rowIndex);
    return rowId !== undefined && isReadOnlyRowId(String(rowId));
  }
  /** readOnly 列/行が 1 つでも指定されているか（未指定なら以下の分岐は一切コストを持たない）。 */
  function hasReadOnlyCells(): boolean {
    return hasReadOnlyColumns() || hasReadOnlyRows();
  }
  /**
   * アクティブセルが readOnly 列 **または** readOnly 行にあるか（textarea のロック・入口抑止の共通条件）。
   * DD-035 R4（列）と DD-036 C3（行）の和。
   */
  function isActiveCellReadOnly(): boolean {
    if (editor === undefined) {
      return false;
    }
    const active = editor.session.getActiveCell();
    return isReadOnlyColumnIndex(active.col) || isReadOnlyRowIndex(active.row);
  }
  /**
   * 未知 rowId の診断 warn（DD-036 C3・契約 §3）。行 ID は mount 時点では検証できないため、**初回描画の直後に 1 回だけ**
   * 現在の行 Axis と突き合わせる（それ以降の行削除・tombstone では警告しない＝実行時に警告を出し続けない）。
   * 未知でも mount は成功する（列の fail-fast とは扱いを分ける）。
   */
  let readOnlyRowsChecked = false;
  function validateReadOnlyRowsOnce(): void {
    const backend = sync;
    if (readOnlyRowsChecked || !hasReadOnlyRows() || backend === undefined) {
      return;
    }
    readOnlyRowsChecked = true;
    const unknown = [...readOnlyRowSet].filter((rowId) => backend.view.rowIndexOf(createRowId(rowId)) < 0);
    if (unknown.length > 0) {
      diag.emit(
        'warn',
        'readonly-row-unknown',
        `readOnlyRows: 未知の行 ${unknown.join(', ')}（初回描画時点の文書に存在しない）→ 該当 RowId が現れれば読み取り専用になる`,
      );
    }
  }
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
  /** アクティブセルのロックを常駐 textarea へ同期する（activeCell 移動のたびに呼ぶ・同値なら無操作）。 */
  function syncCellLock(): void {
    if (editor !== undefined && hasReadOnlyCells()) {
      editor.setInputLock(isActiveCellReadOnly());
    }
  }
  /**
   * 範囲操作（貼り付け・範囲クリア・cut）の SetCells から readOnly 列への変更を除く（論点4: スキップして他列へ適用）。
   * 全件スキップなら null（呼び出し側は no-op）。上限/はみ出し検査は矩形全体で先に済んでいる（事後フィルタ）。
   */
  function filterReadOnlyCells(op: SetCellsOperation, label: string): SetCellsOperation | null {
    if (!hasReadOnlyCells()) {
      return op;
    }
    let changes: readonly SetCellsChange[] = op.changes;
    if (hasReadOnlyColumns()) {
      const partition = partitionReadOnlyColumnChanges(changes, isReadOnlyColumnId);
      if (partition.skipped > 0) {
        diag.emit(
          'info',
          'readonly-column-skipped',
          `${label}: readOnly 列のセル ${partition.skipped} 件をスキップ（残り ${partition.kept.length} 件）`,
        );
      }
      changes = partition.kept;
    }
    // DD-036 C3: 行版を続けて適用する（和＝列 or 行のどちらかに該当するセルがスキップされる）。
    if (hasReadOnlyRows()) {
      const partition = partitionReadOnlyRowChanges(changes, isReadOnlyRowId);
      if (partition.skipped > 0) {
        diag.emit(
          'info',
          'readonly-row-skipped',
          `${label}: readOnly 行のセル ${partition.skipped} 件をスキップ（残り ${partition.kept.length} 件）`,
        );
      }
      changes = partition.kept;
    }
    return changes.length === 0 ? null : { ...op, changes: [...changes] };
  }

  /**
   * pointerdown 時点の状態でリンク候補を武装（arm）できるか判定して候補を組む（純関数 shouldArmLinkCandidate に委譲）。
   * **pointerdownCell を呼ぶ前の位相**で評価する（編集中クリックは従来経路＝発火なし・AC8）。値/行ID/列IDは
   * pointerdown 時点で捕捉する（pointerup 時に行が消えていてもその値で発火してよい＝navigate しない通知のみ・📐）。
   */
  function computeLinkArm(
    cell: CellPosition,
    event: PointerEvent,
  ): { pointerId: number; rowId: RowId; columnId: ColumnId; value: string; cell: CellPosition } | null {
    if (columnTypeRegistry === undefined || sync === undefined || editor === undefined) {
      return null;
    }
    const rowId = sync.view.rowIdAt(cell.row);
    const columnId = sync.view.columnIdAt(cell.col);
    if (rowId === undefined || columnId === undefined) {
      return null;
    }
    const value = sync.view.cellDisplay(rowId, columnId);
    const armed = shouldArmLinkCandidate({
      button: event.button,
      pointerType: event.pointerType,
      isPrimaryClick: isPrimaryClickPress(rowId, columnId, event),
      isLinkColumn: columnTypeRegistry.isLinkColumn(String(columnId)),
      valueNonEmpty: value !== '',
      phase: editor.session.getPhase(),
      composing: editor.session.isComposing(),
      shiftKey: event.shiftKey,
    });
    return armed ? { pointerId: event.pointerId, rowId, columnId, value, cell } : null;
  }

  /**
   * 単クリック/連打の1打目か（dblclick の2打目以降を除外・📐 の detail===1 相当）。実ブラウザーは
   * `PointerEvent.detail`（1打目=1・2打目=2+）が権威判定＝そのまま通す。`detail===0`（synthetic・Playwright は
   * detail 非供給）のときだけ直近 link-open 発火セル（rowId/columnId）＋既定間隔（LINK_DBLCLICK_MS）で dblclick 2打目を
   * 補完判定する（Fable P2: detail>=1 の正当な2回目クリックを time-guard で握り潰さない）。
   */
  function isPrimaryClickPress(rowId: RowId, columnId: ColumnId, event: PointerEvent): boolean {
    if (event.detail >= 2) {
      return false; // 実ブラウザーの dblclick 2打目
    }
    if (
      event.detail === 0 &&
      lastLinkFire !== null &&
      lastLinkFire.rowId === rowId &&
      lastLinkFire.columnId === columnId &&
      performance.now() - lastLinkFire.time < LINK_DBLCLICK_MS
    ) {
      return false; // detail 非供給環境（synthetic）の連打2打目（同一論理セル・既定間隔内）
    }
    return true;
  }

  /** pointercancel/capture 喪失で候補を破棄する（同一 pointer のときだけ）。 */
  function discardLinkCandidate(pointerId: number): void {
    if (linkCandidate !== null && linkCandidate.pointerId === pointerId) {
      linkCandidate = null;
    }
  }

  /**
   * pointerup（finishSelectionDrag(confirm=true) の直後）で候補が生きていれば link-open を発火する（📐）。
   * SDK は navigate しない（通知のみ）。列 `defaultOpen:true` のときだけ絶対 http/https URL を window.open で開く
   * （不正 URL は open せず診断 warn・link-open は常に発火）。
   */
  function maybeEmitLinkOpen(pointerId: number): void {
    if (linkCandidate === null || linkCandidate.pointerId !== pointerId) {
      return;
    }
    const candidate = linkCandidate;
    linkCandidate = null;
    lastLinkFire = { rowId: candidate.rowId, columnId: candidate.columnId, time: performance.now() }; // dblclick 2打目抑止の基準（📐・Fable P2）
    const rowId = String(candidate.rowId);
    const columnId = String(candidate.columnId);
    diag.emit('info', 'link-open', `link-open row=${rowId} col=${columnId}`);
    emit({ type: 'link-open', rowId, columnId, value: candidate.value });
    const linkType = columnTypeRegistry?.getLinkType(columnId);
    if (linkType?.defaultOpen === true) {
      if (isAbsoluteHttpUrl(candidate.value)) {
        window.open(candidate.value, '_blank', 'noopener,noreferrer');
      } else {
        diag.emit(
          'warn',
          'link-open-blocked',
          `defaultOpen: http/https の絶対 URL でないため open しない（link-open は発火済み）: 「${candidate.value}」`,
        );
      }
    }
  }

  /**
   * 範囲選択ドラッグ終了。confirm=true（pointerup）は矩形を明示レンジへ確定する（同一セルなら単一選択のまま）。
   * confirm=false（pointercancel/capture 喪失）はドラッグを破棄する（確定済みレンジは変更しない）。
   */
  function finishSelectionDrag(pointerId: number, confirm: boolean): void {
    if (selectionDrag === null || selectionDrag.pointerId !== pointerId) {
      return;
    }
    selectionDrag = null; // release より先に null 化（release が誘発する lostpointercapture の二重処理を無効化）
    if (scroller.hasPointerCapture(pointerId)) {
      scroller.releasePointerCapture(pointerId);
    }
    if (confirm) {
      selectionCtrl.endDrag();
    } else {
      selectionCtrl.cancelDrag();
    }
    sync?.view.markViewportDirty();
  }

  function resizeHit(transform: ViewportTransform, x: number, y: number): ResizeTarget | null {
    if (sync === undefined) {
      return null;
    }
    return resizeHitTest(transform, x, y, {
      headerWidth: HEADER_WIDTH,
      headerHeight: HEADER_HEIGHT,
      rowCount: sync.view.rowAxis.count(),
      colCount: sync.view.colAxis.count(),
    });
  }

  /**
   * リサイズ終了。emitLayout=true（pointerup）は override のみを含む layout を 1 度だけ発火する（D2）。
   * emitLayout=false（pointercancel/capture 喪失）は確定せず開始時サイズへ戻す（途中状態を保存しない）。
   */
  function finishResize(pointerId: number, emitLayout: boolean): void {
    if (resizeDrag === null || resizeDrag.pointerId !== pointerId) {
      return;
    }
    const drag = resizeDrag;
    resizeDrag = null; // release より先に null 化（release が誘発する lostpointercapture の二重処理を無効化）
    if (scroller.hasPointerCapture(pointerId)) {
      scroller.releasePointerCapture(pointerId);
    }
    scroller.style.cursor = '';
    if (sync === undefined) {
      return;
    }
    if (emitLayout) {
      // 列幅変更の確定で、wrap 列の折り返し行数が変わりうる → 自動行高を一括再計算する（D5 トリガー③）。
      // ドラッグ中（live）は再計算せず確定時のみ（batch を毎 move 走らせない・perf）。
      if (wrapEnabled && drag.axis === 'column') {
        sync.view.recomputeAllAutoRowHeights();
        syncSpacer();
      }
      emit({
        type: 'layout',
        columnWidths: sync.view.columnWidthOverrideRecord(),
        rowHeights: sync.view.rowHeightOverrideRecord(),
      });
    } else {
      // 途中状態を破棄して開始時サイズへ戻す（cancel/capture 喪失は確定ではない）。
      if (drag.axis === 'column') {
        sync.view.setColumnWidth(drag.columnId, drag.originalSize);
      } else {
        // 行は「開始時の手動 override 状態」へ戻す（自動高を手動化しない・Codex P2）。
        sync.view.restoreRowHeight(drag.rowId, drag.originalManual);
      }
      syncSpacer();
    }
  }

  /**
   * ダブルクリック auto-fit（DD-027-3・C級・AC6/AC7）。対象列の非空セルを走査し、text-cache 最大幅＋列ヘッダー
   * ラベル幅から clamp 内の列幅を求めて setColumnWidth → layout イベント発火（DD-012-4 D2 の保存契約を維持）。
   * **wrap 列は対象外**（折り返し前提の列に内容 fit は無意味＝診断 info・無変更）。走査は 10,000 非空セルで打ち切り
   * （それまでの最大値を採用＋診断 info・50k 行列の単発操作でも予算内）。バッジ指定値はチップ幅で見積もる。
   */
  function performAutoFitColumn(colIndex: number): void {
    const backend = sync;
    if (backend === undefined) {
      return;
    }
    const columnId = backend.view.columnIdAt(colIndex);
    if (columnId === undefined) {
      return;
    }
    if (wrapColumnStrings.has(String(columnId))) {
      diag.emit('info', 'auto-fit-skip-wrap', `auto-fit: wrap 列 ${String(columnId)} は対象外（無変更・DD-027-3）`);
      return;
    }
    const rowCount = backend.view.rowAxis.count();
    // 非空セル値を **AUTO_FIT_MAX_SCAN+1 件まで**収集して打ち切る（visitor が false を返すと queryRange が中断＝
    // 50k 行列でも定数コスト・予算保護・Fable P2）。measure と truncated 判定は純関数 computeAutoFitContentWidth が担う。
    const values: string[] = [];
    backend.view.store.queryRange(0, rowCount, colIndex, colIndex + 1, (_row, _col, value) => {
      values.push(value);
      if (values.length > AUTO_FIT_MAX_SCAN) {
        return false; // 打ち切り判定に十分な件数を確保したら即中断
      }
    });
    const scan = computeAutoFitContentWidth(
      values,
      // DD-033-2: 内容幅は **display**（描画テキスト）で測る（描画と測定の一致・DD-027-3 Fable P3 の教訓踏襲）。
      // 判定（バッジ match）は raw のまま。書式のない列は formatText が raw を返すため現行と一致（AC9）。
      (value) => cellTextCache.measureWidth(compiledDisplay?.formatText(String(columnId), value) ?? value, CELL_FONT),
      // バッジ指定値は丸角チップ幅（テキスト＋左右パディング）で見積もる（描画の drawBadgeCell と整合）。match は raw。
      (value) => (compiledFormats?.getStyle(String(columnId), value)?.badge === true ? BADGE_TEXT_PADDING * 2 : 0),
      AUTO_FIT_MAX_SCAN,
    );
    const width = autoFitColumnWidth({
      maxContentWidth: scan.maxContentWidth,
      // DD-033-2: ヘッダー幅はキャプション（指定時）で測る（未指定は列記号 A/B/…）。base-layer と同じ headerFont・描画と一致。
      headerLabelWidth: cellTextCache.measureWidth(
        compiledDisplay?.captionFor(String(columnId)) ?? columnLabel(colIndex),
        HEADER_FONT,
      ),
      padding: CELL_TEXT_PADDING * 2,
    });
    backend.view.setColumnWidth(columnId, width);
    // 列幅変更で wrap 列の折り返し行数が変わりうる（他の wrap 列は本列に依存しないが finishResize と同経路で保守的に再計算）。
    if (wrapEnabled) {
      backend.view.recomputeAllAutoRowHeights();
    }
    syncSpacer();
    // DD-012-4 D2: override のみを含む layout を発火（利用側保存契約を維持＝F5 復元に載る）。
    emit({
      type: 'layout',
      columnWidths: backend.view.columnWidthOverrideRecord(),
      rowHeights: backend.view.rowHeightOverrideRecord(),
    });
    diag.emit(
      'info',
      'auto-fit',
      `auto-fit col=${String(columnId)} width=${width} scanned=${scan.scanned}${scan.truncated ? ` (打ち切り>${AUTO_FIT_MAX_SCAN})` : ''}`,
    );
  }

  scroller.addEventListener(
    'pointermove',
    (event) => {
      if (sync === undefined) {
        return;
      }
      const { x, y } = stageLocal(event);
      if (resizeDrag !== null) {
        if (event.pointerId !== resizeDrag.pointerId) {
          return; // active pointer 以外の move は無視（マルチタッチでの誤リサイズ防止・Codex[P2]）
        }
        // 新サイズを Axis へ反映（markViewportDirty → rAF でライブ再描画）。editor へは流さない（D5）。
        // 対象の左端/上端は現在 transform から毎回再解決する（scroll・構造Op に追従・Codex[P2]）。
        const transform = currentTransform();
        if (transform === undefined) {
          return;
        }
        if (resizeDrag.axis === 'column') {
          const idx = sync.view.colIndexOf(resizeDrag.columnId);
          if (idx < 0) {
            return; // 対象列が消えた（防御）
          }
          const edge = transform.columnHeaderRect(idx).x;
          sync.view.setColumnWidth(resizeDrag.columnId, computeResizeSize('column', x, edge));
        } else {
          const idx = sync.view.rowIndexOf(resizeDrag.rowId);
          if (idx < 0) {
            return;
          }
          const edge = transform.rowHeaderRect(idx).y;
          sync.view.setRowHeight(resizeDrag.rowId, computeResizeSize('row', y, edge));
        }
        syncSpacer(); // 総サイズが変わる → spacer を同期（末尾までスクロール可能に・Codex[P1]）
        return;
      }
      if (selectionDrag !== null) {
        if (event.pointerId !== selectionDrag.pointerId) {
          return; // active pointer 以外の move は無視（マルチタッチでの誤更新防止）
        }
        const transform = currentTransform();
        if (transform === undefined) {
          return;
        }
        // viewport 外は直近 focus を保持する（autoscroll 対象外=既定案・Codex[P1]）。pointer capture 中は
        // 外へ出ても move が届き、hitTest は右/下端の**外側**も Axis 上のセルへ解決してしまうため、
        // 境界内のときだけ hit を解決する（不可視セルへ範囲が伸び、Delete で画面外の値を消す事故を防ぐ）。
        const inViewport = x >= 0 && y >= 0 && x < viewportWidth && y < viewportHeight;
        const hit = inViewport ? transform.hitTest(x, y) : null;
        // DD-027-2[Fable P1]: ドラッグで pointer が開始セルの外（別セル・ヘッダー・viewport 外）へ動いたらリンク候補を
        // 破棄する（=ドラッグ選択・発火なし・AC3）。selection の viewport 境界ガードより前で判定するため、
        // ヘッダーへの離脱や高速フリックでの格子外離脱でも確実に破棄される（旧実装は cell hit ブロック内でのみ破棄し
        // ヘッダー/viewport 外離脱が抜けていた）。
        if (
          linkCandidate !== null &&
          (hit === null ||
            hit.area !== 'cell' ||
            hit.rowIndex !== linkCandidate.cell.row ||
            hit.colIndex !== linkCandidate.cell.col)
        ) {
          linkCandidate = null;
        }
        // セル領域のみ focus を更新する（ヘッダー上・viewport 外は直近セルを保持）。
        if (hit !== null && hit.area === 'cell') {
          selectionCtrl.updateDrag({ row: hit.rowIndex, col: hit.colIndex });
          sync.view.markViewportDirty();
        }
        return;
      }
      // 非ドラッグ: ヘッダー境界上でのみ resize カーソルへ切替（セル領域は cheap に既定へ戻す）。
      if (x >= HEADER_WIDTH && y >= HEADER_HEIGHT) {
        // DD-027-2: リンク列が 1 つでもあるときだけ列単位で cursor:pointer 判定（無ければ cheap path 不変・予算保護・AC9）。
        if (columnTypeRegistry?.hasAnyLinkColumn() === true) {
          const transform = currentTransform();
          const hit = transform?.hitTest(x, y);
          const desired = hit !== undefined && hit.area === 'cell' && isLinkColumnIndex(hit.colIndex) ? 'pointer' : '';
          if (scroller.style.cursor !== desired) {
            scroller.style.cursor = desired;
          }
          return;
        }
        if (scroller.style.cursor !== '') {
          scroller.style.cursor = '';
        }
        return;
      }
      const transform = currentTransform();
      if (transform === undefined) {
        return;
      }
      const rz = resizeHit(transform, x, y);
      scroller.style.cursor = rz === null ? '' : rz.axis === 'column' ? 'col-resize' : 'row-resize';
    },
    { signal },
  );

  scroller.addEventListener(
    'pointerup',
    (event) => {
      finishResize(event.pointerId, true);
      finishSelectionDrag(event.pointerId, true);
      // DD-027-2: 選択ドラッグ確定の直後に、リンク候補が生きていれば link-open を発火する（同一セルクリック＝📐）。
      maybeEmitLinkOpen(event.pointerId);
    },
    { signal },
  );
  scroller.addEventListener(
    'pointercancel',
    (event) => {
      finishResize(event.pointerId, false);
      finishSelectionDrag(event.pointerId, false);
      discardLinkCandidate(event.pointerId); // DD-027-2: 取消はリンク候補も破棄（発火しない）
    },
    { signal },
  );
  scroller.addEventListener(
    'lostpointercapture',
    (event) => {
      finishResize(event.pointerId, false);
      finishSelectionDrag(event.pointerId, false);
      discardLinkCandidate(event.pointerId); // DD-027-2: capture 喪失はリンク候補も破棄
    },
    { signal },
  );

  scroller.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || sync === undefined || editor === undefined) {
        return;
      }
      if (resizeDrag !== null || selectionDrag !== null) {
        return; // ドラッグ中の追加 pointerdown は無視（capture 漏れ・状態上書き防止・Codex[P2]）
      }
      // DD-027-1: 選択式ドロップダウン表示中の外クリック（候補は自前 pointerdown で処理済み＝ここへ来ない）は
      // 取消（文書無変更・focus は textarea のまま・AC3）。続けて通常のセル選択も行う（Excel 風）。
      // Fable P3: この dismiss クリックがリンクセルに当たっても link-open は発火させない（ポップアップの打ち消しと
      // リンク起動を1クリックで兼ねさせない）。close する前に open 状態を捕捉し、後段の候補武装を抑止する。
      const selectDropdownWasOpen = selectDropdown?.isOpen() === true;
      if (selectDropdownWasOpen) {
        closeSelectDropdown?.();
      }
      // DD-035 R2: 日付カレンダー表示中の外クリックも取消（日クリックはポップオーバー側の pointerdown で処理済み＝ここへ来ない）。
      const datePickerWasOpen = datePicker?.isOpen() === true;
      if (datePickerWasOpen) {
        closeDatePicker?.();
      }
      const transform = currentTransform();
      if (transform === undefined) {
        return;
      }
      const { x, y } = stageLocal(event);
      // ヘッダー境界のリサイズを先取りする（editor へイベントを流さない＝D5・IME 不変）。
      const rz = resizeHit(transform, x, y);
      if (rz !== null) {
        event.preventDefault();
        if (rz.axis === 'column') {
          const columnId = sync.view.columnIdAt(rz.index);
          if (columnId === undefined) {
            return;
          }
          resizeDrag = { axis: 'column', columnId, pointerId: event.pointerId, originalSize: sync.view.colAxis.size(rz.index) };
        } else {
          const rowId = sync.view.rowIdAt(rz.index);
          if (rowId === undefined) {
            return;
          }
          resizeDrag = {
            axis: 'row',
            rowId,
            pointerId: event.pointerId,
            originalSize: sync.view.rowAxis.size(rz.index),
            // 取消復元用に開始時の手動 override 値（無ければ undefined）を捕捉する（Codex P2）。
            originalManual: sync.view.rowHeightOverrideRecord()[String(rowId)],
          };
        }
        scroller.setPointerCapture(event.pointerId);
        scroller.style.cursor = rz.axis === 'column' ? 'col-resize' : 'row-resize';
        return;
      }
      const hit = transform.hitTest(x, y);
      if (hit.area !== 'cell') {
        editor.pointerdownCell(null);
        return;
      }
      // 常駐 textarea をキーボード入力の受け口として保持する。scroller は非フォーカサブルなため、
      // mousedown 既定挙動が focus を body へ奪い、直後の pointerdownCell の textarea.focus() を打ち消す。
      // これを止めないとクリック後の矢印キーが scroller のネイティブスクロールへ流れ、カレントセルが動かない。
      event.preventDefault();
      const cell = { row: hit.rowIndex, col: hit.colIndex };
      // Shift+クリック（Navigation・非 composition 限定）: anchor=activeCell 固定でレンジ拡張（DD-020-1 AC2）。
      // activeCell は動かさない（editor.pointerdownCell を呼ばない）。編集中/変換中は前段消費せず従来経路
      // （確定して移動 / pendingNavigation）のまま＝IME・編集の挙動保存（案X）。
      if (event.shiftKey && !editor.session.isComposing() && editor.session.getPhase() === 'Navigation') {
        selectionCtrl.extendTo(editor.session.getActiveCell(), cell);
        editor.focus(); // 入力受け口（常駐 textarea）を保持（以降の Shift+矢印を受けられるように）
        sync.view.markViewportDirty();
        return;
      }
      // DD-027-2: リンク候補の武装判定は pointerdownCell を呼ぶ前の位相で行う（編集中クリックは従来経路＝発火なし・AC8）。
      // Fable P3: 選択式ドロップダウンの dismiss クリック（selectDropdownWasOpen）はリンク武装しない。
      const linkArm = selectDropdownWasOpen || datePickerWasOpen ? null : computeLinkArm(cell, event);
      // 通常クリック: 明示レンジを解除（同一セル再クリックでも単一選択へ戻す・AC4）→ activeCell 移動。
      selectionCtrl.clear();
      editor.pointerdownCell(cell);
      // pointerdownCell 処理後に Navigation なら（元から Navigation / 編集は確定済み）ドラッグ選択を開始する。
      // composition 中は開始しない（クリックは pendingNavigation 経路のまま・composition を乱さない・AC7）。
      if (!editor.session.isComposing() && editor.session.getPhase() === 'Navigation') {
        selectionDrag = { pointerId: event.pointerId };
        selectionCtrl.beginDrag(cell);
        scroller.setPointerCapture(event.pointerId);
      }
      // 候補は既存処理の後に記録する（既存経路は無変更のまま上乗せ・pointerup で発火）。編集中クリックは linkArm=null。
      linkCandidate = linkArm;
      sync.view.markViewportDirty();
    },
    { signal },
  );

  scroller.addEventListener(
    'dblclick',
    (event) => {
      if (sync === undefined || editor === undefined) {
        return;
      }
      const transform = currentTransform();
      if (transform === undefined) {
        return;
      }
      const rect = stage.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      // DD-027-3: 列境界のダブルクリック → auto-fit（現状ヘッダー境界 dblclick は未使用＝既存 doubleClickCell と衝突しない）。
      // resizeHitTest を先取りし、列境界なら auto-fit して return（セル編集 dblclick へ流さない）。行境界は対象外（無処理）。
      const rz = resizeHit(transform, localX, localY);
      if (rz !== null && rz.axis === 'column') {
        event.preventDefault();
        performAutoFitColumn(rz.index);
        return;
      }
      const hit = transform.hitTest(localX, localY);
      if (hit.area === 'cell') {
        // DD-033-1: readOnly はセル編集（doubleClickCell）・選択式ドロップダウンを開かない（入口抑止）。
        // 列境界 dblclick の auto-fit（上の分岐）は閲覧系ゆえ維持する（要確認4・view-local layout）。
        if (readOnly) {
          diag.emit('info', 'readonly-blocked', 'readOnly: ダブルクリック編集を抑止（閲覧専用）');
          return;
        }
        // DD-035 R4: readOnly 列のセルは編集 UI（textarea・ドロップダウン・カレンダー）を一切開かない（入口抑止）。
        if (isReadOnlyRowIndex(hit.rowIndex)) {
          diag.emit('info', 'readonly-row-blocked', `readOnlyRows: 行 ${String(sync.view.rowIdAt(hit.rowIndex))} のダブルクリック編集を抑止`);
          return;
        }
        if (isReadOnlyColumnIndex(hit.colIndex)) {
          diag.emit('info', 'readonly-column-blocked', `readOnlyColumns: 列 ${String(sync.view.columnIdAt(hit.colIndex))} のダブルクリック編集を抑止`);
          return;
        }
        // DD-027-1 / DD-037: 選択式列は textarea 編集ではなくドロップダウンを開く（AC1）。自由入力併存列
        // （allowFreeText:true）も対象＝候補は明示操作で開き、自由入力は印字文字から始める（DD-037 決定①）。
        // 先に activeCell を対象セルへ合わせてから開く（openSelectForActive は activeCell を読む）。
        if (isSelectColumnIndex?.(hit.colIndex) === true) {
          editor.pointerdownCell({ row: hit.rowIndex, col: hit.colIndex });
          openSelectForActive?.();
          return;
        }
        // DD-035 R2: 日付列（openOn='dblclick'）は textarea 編集ではなくカレンダーを開く。openOn='icon' は従来どおり。
        if (isDblclickDateColumnIndex?.(hit.colIndex) === true) {
          editor.pointerdownCell({ row: hit.rowIndex, col: hit.colIndex });
          openDateForActive?.();
          return;
        }
        editor.doubleClickCell({ row: hit.rowIndex, col: hit.colIndex });
      }
    },
    { signal },
  );

  scroller.addEventListener(
    'scroll',
    () => {
      sync?.view.markViewportDirty();
    },
    { signal },
  );

  const resizeObserver = new ResizeObserver(() => {
    syncLayout();
  });
  resizeObserver.observe(stage);

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
      compiledFormats = compileFormatRules(options.columnFormats, columnOrder);
      // DD-036 C2: 静的列背景をプリコンパイル（fail-fast・未知列/空色 → column-types-invalid＝columnFormats と同経路）。
      compiledBackgrounds = compileColumnBackgrounds(options.columnBackgrounds, columnOrder);
      // DD-045: 静的行背景をプリコンパイル（空色は fail-fast、RowId の存在は初回描画後に warn）。
      compiledRowBackgrounds = compileRowBackgrounds(options.rowBackgrounds);
      compiledBorders = compileBorders(options.rowBorders, options.columnBorders, columnOrder, (color) => normalizeCanvasBorderColor(baseCtx, color));
      // DD-033-2: 列見出しキャプション＋表示書式をプリコンパイル（fail-fast）。wrap/link 併用検査は wrapColumnStrings と
      // 直前に生成した columnTypeRegistry を渡して同所で実施する。不正は column-display-invalid へ写像する（別 code）。
      compiledDisplay = compileDisplayFormats(options.columnDisplayFormats, options.columnCaptions, columnOrder, {
        isWrapColumn: (columnId) => wrapColumnStrings.has(columnId),
        isLinkColumn: (columnId) => columnTypeRegistry?.isLinkColumn(columnId) === true,
      });
      return true;
    } catch (error) {
      // DD-027-1/2: columnTypes 不正 ／ DD-027-3: columnFormats 不正 は column-types-invalid へ、
      // DD-033-2: columnCaptions/columnDisplayFormats 不正 は column-display-invalid へ（意味を分けて障害切り分けを濁さない）。
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

    sync = createSessionSync({
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
              diag.emit('warn', 'rejected', `code=${block} op=${String(event.entry.operationId)}`);
              emit({
                type: 'rejected',
                pendingCount: event.pendingCount,
                conflict: { operationId: String(event.entry.operationId), reason: 'rejected', code: block },
              });
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
        },
      },
      rowHeight: ROW_HEIGHT,
      colWidth: COL_WIDTH,
      ...(options.columnWidths !== undefined ? { columnWidths: options.columnWidths } : {}),
      ...(options.rowHeights !== undefined ? { rowHeights: options.rowHeights } : {}),
      // DD-012-5: wrap 列・行分割キャッシュ・フォント・行高を DocumentView へ渡す（自動行高の計算基盤）。
      ...(wrapEnabled ? { wrapColumns } : {}),
      wrapCache: cellTextCache,
      cellFont: CELL_FONT,
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
    });

    attachBackendRendering();
  }

  /**
   * SetCells を backend へ submit する **確定単位 chokepoint**（DD-020-2 → DD-020-3 引き継ぎ）。
   * 1 利用者操作 = 1 SetCells の全経路がここを通る: ①IME 単一セル確定（ime-editing-session の submit）
   * ②範囲クリア（performRangeClear）③貼り付け（performPaste）④cut のクリア（performCut）。
   * DD-020-3（Undo/Redo）は submit 直前にここで committed から逆値を捕捉する hook を挿す（単一記録点）。
   * 単独モードは submitLocalOperation 内で cell-commit を通知する（onCellCommit→emit・DD-024 決定②）。
   * ローカル楽観適用の直後に、変更行の自動行高を再計算する（D5 トリガー②＝ローカル・SetCells のみ）。
   */
  function submitSetCells(op: SetCellsOperation): OperationId | void {
    const backend = sync;
    if (backend === undefined) {
      return;
    }
    // DD-033-1（統合レビュー P2-2）: readOnly は undo 捕捉より前に破棄する。submitToBackend（絶対防衛線）だけだと
    // op は破棄されるのに undo エントリが積まれ canUndo=false（AC2）が破れる（standalone は submit 結果を見ず記録するため）。
    if (readOnly) {
      diag.emit('warn', 'readonly-blocked', 'readOnly: submitSetCells で SetCells を破棄（undo 記録前）');
      return;
    }
    // DD-036 C3: readOnly 行版の保証層（列版と同型・undo 記録前）。
    if (hasReadOnlyRows() && touchesReadOnlyRow(op.changes, isReadOnlyRowId)) {
      diag.emit('warn', 'readonly-row-blocked', 'readOnlyRows: submitSetCells で readOnly 行への SetCells を破棄（undo 記録前）');
      return;
    }
    // DD-035 R4: readOnly 列への変更を含む SetCells は op 全体を破棄する（保証層・undo 記録前）。範囲操作は
    // filterReadOnlyCells で事前にスキップ済みのため、ここへ到達するのは入口をすり抜けた経路＝warn。
    if (hasReadOnlyColumns() && touchesReadOnlyColumn(op.changes, isReadOnlyColumnId)) {
      diag.emit('warn', 'readonly-column-blocked', 'readOnlyColumns: submitSetCells で readOnly 列への SetCells を破棄（undo 記録前）');
      return;
    }
    // DD-020-3: submit 直前に **view（committed＋own pending）** から逆値（前値）を捕捉する（単一記録点＝両モード同一経路）。
    // committed ではなく view を使うのは、直前の未 ACK 楽観編集を飛ばさないため（Codex P1: 連続編集の逆値正しさ）。
    const patches = captureUndoPatches(backend.session.viewDocument, op);
    const id = submitToBackend(backend, op);
    recordUndoEntry(backend, patches, id);
    return id;
  }

  /** SetCells を backend へ submit し wrap 行高を再計算する低レベル経路（元操作・補償操作の両方が使う）。 */
  function submitToBackend(backend: GridBackend, op: SetCellsOperation): OperationId | void {
    // DD-033-1: 絶対防衛線（chokepoint）。readOnly では SetCells 系（IME 確定・paste・cut・範囲クリア・Undo/Redo
    // 補償）の唯一の submit 点である本関数で op を破棄する＝入口抑止をすり抜けた synthetic 経路や将来の編集入口でも
    // 文書 Operation 送信ゼロを構造的に保証する（共同編集の受信専用化・AC5）。入口ガード（perform*・interceptKeydown）で
    // 通常はここへ到達しないため diag は warn（到達自体が想定外＝障害切り分けの手掛かり）。
    if (readOnly) {
      diag.emit('warn', 'readonly-blocked', 'readOnly: submitToBackend で SetCells を破棄（絶対防衛線・送信ゼロ）');
      return;
    }
    // DD-036 C3: 絶対防衛線の行版（列版と同型・Undo/Redo 補償を含む全 SetCells が通る）。
    if (hasReadOnlyRows() && touchesReadOnlyRow(op.changes, isReadOnlyRowId)) {
      diag.emit('warn', 'readonly-row-blocked', 'readOnlyRows: submitToBackend で readOnly 行への SetCells を破棄（絶対防衛線）');
      return;
    }
    // DD-035 R4: 絶対防衛線（Undo/Redo 補償を含む全 SetCells）。readOnly 列への変更を含めば op 全体を破棄する。
    if (hasReadOnlyColumns() && touchesReadOnlyColumn(op.changes, isReadOnlyColumnId)) {
      diag.emit('warn', 'readonly-column-blocked', 'readOnlyColumns: submitToBackend で readOnly 列への SetCells を破棄（絶対防衛線）');
      return;
    }
    const id = backend.session.submitLocalOperation(op);
    if (wrapEnabled) {
      backend.view.recomputeAutoRowHeightsForRows(op.changes.map((c) => c.rowId));
    }
    return id;
  }

  /** op の各対象セルについて submit 直前 view の値を逆値（before）・op の設定値を順値（after）として組む（DD-020-3）。 */
  function captureUndoPatches(source: SheetDocument, op: SetCellsOperation): UndoPatch[] {
    return op.changes.map((change) => ({
      rowId: change.rowId,
      columnId: change.columnId,
      before: cloneCellScalar(getCell(source, change.rowId, change.columnId)?.value ?? { kind: 'blank' }),
      after: cloneCellScalar(change.value),
    }));
  }

  /** committed のセル lastChangedRevision（未書込=0）。standalone 即時確定 revision の読取に使う（DD-020-3）。 */
  function cellRevision(committed: SheetDocument, rowId: RowId, columnId: ColumnId): number {
    return getCell(committed, rowId, columnId)?.lastChangedRevision ?? 0;
  }

  /**
   * 元操作の undo エントリを記録する。standalone は即時確定 revision で ownedRevision を確定・collab は opId で後追い ACK。
   * collab で submit が同期 reject された op（rebuildView が編集開始 revision の stale を submit 中に判定）は pending に
   * 残らない → **undo エントリに入れない**（AC5・Codex P2: 誤記録＋redo 誤破棄を防ぐ）。
   */
  function recordUndoEntry(backend: GridBackend, patches: UndoPatch[], id: OperationId | void): void {
    if (patches.length === 0) {
      return;
    }
    if (isStandalone) {
      const first = patches[0]!;
      undoCtrl.recordUserOp(null, patches, cellRevision(backend.session.committedDocument, first.rowId, first.columnId));
      return;
    }
    if (id !== undefined && backend.session.pendingOperationIds().some((p) => String(p) === String(id))) {
      undoCtrl.recordUserOp(id, patches, null);
    }
  }

  // ---- 行操作（Insert/Delete）公開層（DD-021-1）----
  /** 行構造変更を利用側へ通知する（両モード共通・standalone の保存材料。cell-commit はセル値専用のまま）。 */
  function emitRowStructureChange(change: GridRowStructureChange): void {
    emit({ type: 'row-structure-change', change });
  }

  /**
   * 行操作の実行前拒否の通知（DD-020 の notifyPreExecutionReject と同型）。診断は常に出す。公開 rejected は
   * **共同編集モードのみ**発火する（standalone は client 実行前拒否を server 競合経路へ混ぜない＝DD-024 契約・
   * consumer が collab 競合と誤認しないため）。operationId は空＝未 submit。
   */
  function notifyRowReject(code: GridConflictCode, diagCode: string, detail: string): void {
    diag.emit('warn', diagCode, detail);
    if (isStandalone) {
      return;
    }
    emit({
      type: 'rejected',
      pendingCount: sync?.session.pendingCount ?? 0,
      conflict: { operationId: '', reason: 'rejected', code },
    });
  }

  /**
   * 行挿入（公開 API・ショートカット共有）。afterRowId 直後へ count 行を挿入する。新 RowId は crypto.randomUUID。
   * count≦0/非整数・未知アンカーは submit せず実行前拒否（AC8）。楽観適用直後に row-structure-change を発火する。
   */
  function performInsertRows(afterRowId: string | null, count: number): void {
    // DD-033-1: readOnly は行挿入を抑止（公開 API・ショートカット共有＝1箇所で両方止まる・入口＝chokepoint 兼用）。
    if (readOnly) {
      diag.emit('info', 'readonly-blocked', 'readOnly: insertRows を抑止（文書無変更）');
      return;
    }
    const backend = sync;
    if (backend === undefined) {
      return; // boot 未完了 → 黙って無視（既存 API 流儀）
    }
    // stopped（再接続窓超過で終端）セッションへの submit は throw する（collab session 契約）。公開 API・
    // ショートカットは「同期 throw しない」契約のため no-op＋診断にする（performUndo/Redo と同型・Fable P2）。
    if (backend.session.isStopped) {
      diag.emit('warn', 'insert-session-stopped', 'insertRows: セッション停止中（stopped）のため無視');
      return;
    }
    // 上限は SetCells のセル数上限と同値を流用（1 op の実行前ガード・R-08 と同型）。上限なしだと
    // count=2^32 で Array.from が同期 RangeError・1e8 程度でも UI フリーズ/巨大 envelope 送信になる（Fable P2）。
    if (!Number.isInteger(count) || count <= 0 || count > SETCELLS_MAX_CELLS) {
      notifyRowReject(
        'row-count-invalid',
        'insert-count-invalid',
        `insertRows: count=${count}（1〜${SETCELLS_MAX_CELLS} の整数が必要）`,
      );
      return;
    }
    const anchor = afterRowId === null ? null : createRowId(afterRowId);
    const rowIds = Array.from({ length: count }, () => crypto.randomUUID());
    const op: InsertRowsOperation = {
      type: 'insertRows',
      afterRowId: anchor,
      rows: rowIds.map((id) => ({ rowId: createRowId(id) })),
    };
    // アンカー検証は view（committed＋own pending）に対して行う（own 楽観挿入直後のアンカーも有効）。
    // UUID 採番ゆえ duplicate-row は起きず、違反は unknown-anchor のみ→公開 row-anchor-unknown へ写す。
    if (validateOperation(backend.session.viewDocument, op).length > 0) {
      notifyRowReject('row-anchor-unknown', 'insert-anchor-unknown', `insertRows: 未知アンカー afterRowId=${afterRowId}`);
      return;
    }
    backend.session.submitLocalOperation(op);
    // 構造 dirty を確実に立てて楽観再描画する（standalone は submit 内で既に立つ・冪等。collab は server echo を待たず即描画）。
    backend.view.noteOperation(op);
    emitRowStructureChange({ kind: 'insert', afterRowId, rowIds });
  }

  /**
   * 行削除（公開 API・ショートカット共有）。実在（非 tombstone）行のみ tombstone 化し row-structure-change を発火する。
   * 対象皆無は実行前拒否（AC8）。削除後、アクティブ行が消えていれば最近傍生存行（下優先→上）へ縮退する（親④・AC5）。
   */
  function performDeleteRows(requested: readonly string[]): void {
    // DD-033-1: readOnly は行削除を抑止（公開 API・ショートカット共有＝入口＝chokepoint 兼用）。
    if (readOnly) {
      diag.emit('info', 'readonly-blocked', 'readOnly: deleteRows を抑止（文書無変更）');
      return;
    }
    const backend = sync;
    if (backend === undefined) {
      return;
    }
    if (backend.session.isStopped) {
      diag.emit('warn', 'delete-session-stopped', 'deleteRows: セッション停止中（stopped）のため無視');
      return;
    }
    const oldOrder = displayRowOrder(backend.session.viewDocument).map(String);
    const targets = resolveDeleteTargets(oldOrder, requested);
    if (targets.length === 0) {
      notifyRowReject('row-delete-empty', 'delete-empty', `deleteRows: 削除対象なし（要求 ${requested.length} 件）`);
      return;
    }
    const op: DeleteRowsOperation = { type: 'deleteRows', rowIds: targets.map((id) => createRowId(id)) };
    backend.session.submitLocalOperation(op);
    backend.view.noteOperation(op);
    emitRowStructureChange({ kind: 'delete', rowIds: targets });
    // activeCell / 選択の縮退は masterLoop の構造 flush で一本化して行う（K3 再ベース・親④・DD-021-3）。
    // ローカル/リモート問わず「構造変更前に指していた RowId」を新 Axis へ引き直すため、ここでは個別処理しない。
  }

  // ---- K3 選択・activeCell 再ベース（DD-021-3・案b＝grid 層 hook・状態機械無変更）----
  /** 構造 flush 前に採取する再ベース材料（旧表示行順・再ベース対象の activeCell）。 */
  interface RebaseState {
    readonly oldOrder: string[];
    /** activeCell（Navigation 位相かつ非 composition のときのみ＝編集中は editingTarget placement が追従・I-3）。 */
    readonly active: CellPosition | undefined;
  }

  /** 現在の（再構築前の）表示行 Axis の RowId 列（文字列）。 */
  function currentAxisRowIds(): string[] {
    if (sync === undefined) {
      return [];
    }
    const axis = sync.view.rowAxis;
    const ids: string[] = [];
    const count = axis.count();
    for (let i = 0; i < count; i += 1) {
      ids.push(String(axis.getId(i)));
    }
    return ids;
  }

  /**
   * 構造 flush の**前**に、現在指している RowId を旧 Axis から採取する（K3）。初回 bootstrap 構築（firstDataDrawn=false）
   * や空 Axis は再ベースしない（新規構築であり「指していた行」が無い）。編集中/変換中は activeCell を対象にしない
   * （editingTarget ベースの placement が編集セルを追従・pointerdownCell は commit を誘発するため触らない・I-3）。
   */
  function captureRebaseState(): RebaseState | null {
    if (sync === undefined || !firstDataDrawn) {
      return null;
    }
    const oldOrder = currentAxisRowIds();
    if (oldOrder.length === 0) {
      return null;
    }
    const eligibleActive =
      editor !== undefined && !editor.session.isComposing() && editor.session.getPhase() === 'Navigation';
    return { oldOrder, active: eligibleActive ? editor!.session.getActiveCell() : undefined };
  }

  /**
   * 構造 flush の**後**に、採取した RowId を新 Axis の index へ引き直して activeCell/選択レンジを補正する（K3）。
   * activeCell 行が削除されていれば最近傍生存行（下優先→上・親④）へ縮退、生存行皆無なら選択解除。列は不変。
   */
  function applyRebaseState(state: RebaseState | null): void {
    if (state === null || sync === undefined) {
      return;
    }
    const newOrder = currentAxisRowIds();
    // 選択レンジ（明示レンジがあるときだけ効く）。両端を RowId で追従し、生存行皆無なら単一選択へ縮退。
    if (selectionCtrl.rebaseRows((row) => rebaseRowIndex(state.oldOrder, newOrder, row))) {
      sync.view.markViewportDirty();
    }
    const active = state.active;
    if (active === undefined || editor === undefined || active.row >= state.oldOrder.length) {
      return;
    }
    // flush 前後で phase は不変だが防御的に再確認（editing/composing へ遷移していたら触らない・I-3）。
    if (editor.session.isComposing() || editor.session.getPhase() !== 'Navigation') {
      return;
    }
    const newRow = rebaseRowIndex(state.oldOrder, newOrder, active.row);
    if (newRow === null) {
      editor.pointerdownCell(null); // 生存行なし → 選択解除
      return;
    }
    if (newRow === active.row) {
      return; // index 不変（挿入が下・削除が下）→ カーソルを触らない
    }
    diag.emit('info', 'rebase-active-cell', `K3: activeCell 行 ${active.row}→${newRow}（RowId 追従）`);
    editor.pointerdownCell({ row: newRow, col: active.col });
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
    baseLayer = createBaseLayer({
      ctx: baseCtx,
      store: backend.view.store,
      headerWidth: HEADER_WIDTH,
      headerHeight: HEADER_HEIGHT,
      // DD-012-5: 共有キャッシュ・wrap 判定・pane 境界・折り返し行高を渡す（オーバーフロー／折り返し描画）。
      cellFont: CELL_FONT,
      textCache: cellTextCache,
      frozenColCount,
      lineHeight: CELL_TEXT_LINE_HEIGHT,
      isWrapColumn: (colIndex) => {
        if (!wrapEnabled) {
          return false;
        }
        const id = backend.view.columnIdAt(colIndex);
        return id !== undefined && wrapColumnStrings.has(String(id));
      },
      // DD-027-2: リンク列はリンク色＋下線・自セル内クリップで描く（列単位・registry 判定）。リンク列が無ければ常に false。
      isLinkColumn: (colIndex) => isLinkColumnIndex(colIndex),
      // DD-027-3: セル書式の解決フック。書式が 1 つも無ければ束縛せず描画コスト増ゼロ（可視非空セルの O(1) lookup）。
      ...(compiledFormats?.hasAny() === true
        ? {
            getCellStyle: (colIndex: number, value: string) => {
              const id = backend.view.columnIdAt(colIndex);
              return id === undefined ? undefined : compiledFormats?.getStyle(String(id), value);
            },
          }
        : {}),
      // DD-036 C2: 静的列背景のフック（列単位・値を見ない）。指定が 1 列も無ければ束縛せず列バンド描画を行わない。
      ...(compiledBackgrounds?.hasAny() === true
        ? {
            columnBackground: (colIndex: number) => {
              const id = backend.view.columnIdAt(colIndex);
              return id === undefined ? undefined : compiledBackgrounds?.getBackground(String(id));
            },
          }
        : {}),
      // DD-045: row index から現在の RowId を毎描画時に解決し、行挿入・削除後も同じ行実体へ追従する。
      ...(compiledBorders?.hasRows === true ? {
        rowBorder: (index: number) => compiledBorders?.row(
          index > 0 ? backend.view.rowIdAt(index - 1) : undefined,
          backend.view.rowIdAt(index),
        ),
      } : {}),
      ...(compiledBorders?.hasColumns === true ? {
        columnBorder: (index: number) => compiledBorders?.column(
          index > 0 ? backend.view.columnIdAt(index - 1) : undefined,
          backend.view.columnIdAt(index),
        ),
      } : {}),
      ...(compiledRowBackgrounds?.hasAny() === true
        ? {
            rowBackground: (rowIndex: number) => {
              const id = backend.view.rowIdAt(rowIndex);
              return id === undefined ? undefined : compiledRowBackgrounds?.getBackground(String(id));
            },
          }
        : {}),
      // DD-033-2: 列見出しキャプション＋表示書式のフック。両オプション未指定（hasAny()=false）なら束縛せず現行描画と
      // 完全一致（AC9）。判定は raw・描画は display（columnHeaderLabel=ヘッダー・formatCellText=セル）。
      ...(compiledDisplay?.hasAny() === true
        ? {
            columnHeaderLabel: (colIndex: number) => {
              const id = backend.view.columnIdAt(colIndex);
              const caption = id === undefined ? undefined : compiledDisplay?.captionFor(String(id));
              return caption ?? columnLabel(colIndex);
            },
            formatCellText: (colIndex: number, rawValue: string) => {
              const id = backend.view.columnIdAt(colIndex);
              return id === undefined ? rawValue : (compiledDisplay?.formatText(String(id), rawValue) ?? rawValue);
            },
          }
        : {}),
    });

    // ---- IME×backend の結線（値の源は backend.session／backend.view）----
    const docPort: EditingDocumentPort = {
      getCommittedDocument: () => backend.session.committedDocument,
      displayText: (rowId, columnId) => backend.view.cellDisplay(rowId, columnId),
      rowIdAt: (index) => backend.view.rowIdAt(index),
      colIdAt: (index) => backend.view.columnIdAt(index),
      rowIndexOf: (rowId) => backend.view.rowIndexOf(rowId),
      colIndexOf: (columnId) => backend.view.colIndexOf(columnId),
    };

    // DD-020-2 clipboard: docPort（範囲読み取り）＋表示 Axis の寸法（貼り付けはみ出し判定の境界）。
    const clipPort: ClipboardDocumentPort = {
      getCommittedDocument: () => backend.session.committedDocument,
      displayText: (rowId, columnId) => backend.view.cellDisplay(rowId, columnId),
      rowIdAt: (index) => backend.view.rowIdAt(index),
      colIdAt: (index) => backend.view.columnIdAt(index),
      rowCount: () => backend.view.rowAxis.count(),
      colCount: () => backend.view.colAxis.count(),
    };

    /**
     * 実行前拒否（上限超過・はみ出し）の通知（範囲クリア／paste／cut 共有）。診断は常に出す。公開 rejected は
     * **共同編集モードのみ**発火する: standalone は DD-024 契約（ClientSession/transport 非生成＝
     * connection/pending/rejected/divergence 非発火）を守り、client 側実行前拒否を server 競合の rejected 経路へ
     * 混ぜない（consumer が collab 競合と誤認しないため。standalone は診断のみ・Codex[P2]）。operationId は空＝未 submit。
     */
    const notifyPreExecutionReject = (code: GridConflictCode, diagCode: string, detail: string): void => {
      diag.emit('warn', diagCode, detail);
      if (isStandalone) {
        return;
      }
      emit({
        type: 'rejected',
        pendingCount: backend.session.pendingCount,
        conflict: { operationId: '', reason: 'rejected', code },
      });
    };

    /**
     * 範囲クリア（DD-020-1 AC5/AC6）: 明示レンジを 1 つの原子的 SetCells（非空セルのみ・beforeRevision 付き）
     * で blank 化する。生成・上限検査は range-ops（純粋関数）・submit は IME 確定と同じ共有経路（submitSetCells）。
     * 上限超過は submit せず notifyPreExecutionReject（共同編集は rejected code=range-too-large・standalone は診断のみ）。
     * レンジは維持する（AC5: Delete は解除トリガーではない／AC6: 縮めて再実行できる）。
     * （arrow 式: 上の backend undefined ガード後の narrowing を閉包へ効かせる＝hoist される function 宣言にしない）
     */
    const performRangeClear = (): void => {
      if (readOnly) {
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
          const op = filterReadOnlyCells(outcome.operation, '範囲クリア');
          if (op === null) {
            return;
          }
          submitSetCells(op);
          // 前段消費のため editor onChange（markViewportDirty）が走らない → 楽観適用の再描画をここで要求する。
          backend.view.markCellDirty();
          return;
        }
      }
    };

    // ---- DD-020-2 clipboard（copy/cut/paste）----
    // 裁定: Navigation 位相かつ非 composing のみグリッド Command 化（親 D5）。編集/変換中はブラウザ既定
    // （textarea 内テキスト編集）へ委譲し、composition の value/selection に介入しない（I-3）。
    const clipboardActive = (): boolean =>
      editor !== undefined && shouldInterceptClipboard(editor.session.getPhase(), editor.session.isComposing());

    /** copy: 選択範囲（未選択時は activeCell 単一）の表示文字列を TSV 化して返す（書き出しは integration-editor）。 */
    const performCopy = (): string | null => {
      if (editor === undefined || !clipboardActive()) {
        return null; // 非 Navigation → ブラウザ既定（textarea copy）
      }
      const range = selectionCtrl.selectedRange(editor.session.getActiveCell());
      return serializeSelectionToTsv(clipPort, range);
    };

    /**
     * cut（親④）: copy＋即時範囲クリア（移動セマンティクスにしない）。クリアが上限超過なら**cut 全体を拒否**し
     * （copy もしない＝クリップボード不変）通知する。クリア対象が全空でも copy は成立させる（TSV を返す）。
     */
    const performCut = (): string | null => {
      if (readOnly) {
        // cut は copy＋クリア＝文書変更系ゆえ全抑止（clipboard も変更しない・null=ブラウザ既定は readOnly textarea で no-op）。
        diag.emit('info', 'readonly-blocked', 'readOnly: cut を抑止（文書無変更・クリップボード不変）');
        return null;
      }
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
      const tsv = serializeSelectionToTsv(clipPort, range);
      if (outcome.kind === 'submit') {
        // DD-035 R4: cut のクリアは readOnly 列をスキップ（copy＝TSV は全列そのまま＝閲覧系）。
        const op = filterReadOnlyCells(outcome.operation, 'cut');
        if (op !== null) {
          submitSetCells(op);
          backend.view.markCellDirty();
        }
      }
      return tsv;
    };

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
    const selectPastedRect = (rect: PasteRect): void => {
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
        closeSelectDropdown?.();
        closeDatePicker?.();
        editor.pointerdownCell(topLeft); // onChange → syncWithEditor が既存レンジを解除する（この後に張り直す）
      }
      // 1×1 の貼り付けは setRange が単一選択へ正規化する（明示レンジを作らない＝見た目不変・AC3）。
      // out-of-bounds を通過した矩形なので表示 Axis 内が保証され、境界クランプは不要。
      selectionCtrl.extendTo(topLeft, bottomRight);
    };

    /**
     * paste: text/plain → parse → 敷き詰め/はみ出し全体拒否/上限/型変換 → 原子 SetCells（buildPaste）。
     * Navigation では**必ず消費**（true 返却＝preventDefault）する。消費しないと browser 既定が textarea へ
     * ペーストテキストを流し込み Navigation の input が編集を開始してしまう（グリッド paste 意図と乖離）。
     * 成功時は貼付範囲を選択レンジにする（selectPastedRect・DD-038）。
     */
    const performPaste = (text: string): boolean => {
      if (readOnly) {
        // 消費（true=preventDefault）して readOnly textarea への流し込みも止める（文書無変更）。
        diag.emit('info', 'readonly-blocked', 'readOnly: paste を抑止（文書無変更）');
        return true;
      }
      if (editor === undefined || !clipboardActive()) {
        return false; // 編集/変換中は textarea へテキスト挿入（ブラウザ既定）
      }
      const matrix = parseClipboardText(text);
      const range = selectionCtrl.selectedRange(editor.session.getActiveCell());
      const outcome = buildPaste(clipPort, matrix, range);
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
          const op = filterReadOnlyCells(outcome.operation, '貼り付け');
          if (op === null) {
            return true; // DD-038 決定⑦: 文書無変更 → 選択も activeCell も動かさない（拒否・noop と同じ扱い）
          }
          // DD-038（Codex P2）: 選択遷移は submit の**前**に完了させる。単独モードは submitLocalOperation の
          // 内側から cell-commit を同期発火し（standalone-session）、共同編集も pending 通知で同様に再入しうる。
          // その購読者が公開 API（setActiveCell / setData）を呼んだ場合、submit の後に選択を動かすと consumer の
          // 変更を上書きしてしまう（setData なら更新前 Axis の矩形を選ぶ）。先に選んでおけば「最後に書いた側が勝つ」。
          selectPastedRect(outcome.rect); // 貼付範囲を選択レンジにする（Excel 準拠・書き込みが起きる経路でのみ）
          submitSetCells(op);
          backend.view.markCellDirty();
          return true;
        }
      }
    };
    // ---- DD-020-3 Undo/Redo（補償 SetCells・親③）----
    /**
     * 補償 SetCells（undo/redo が生成した逆/順値の op）を submit する。**submitSetCells とは別経路**で、
     * 新規 undo エントリを積まない（積むと無限記録＋redo 破壊になる）。standalone は即時確定ゆえ committed から
     * revision を読んで即解決し、collab は operationId を紐づけて ACK/reject を待つ（onCommitted/onRejected）。
     */
    const submitCompensation = (op: SetCellsOperation): void => {
      // 事前 OCC 検査（Codex P1）: undo/redo は pendingCount===0 でのみ発火＝committed が唯一の検証基底ゆえ、
      // validateOperation(committed, op) が submitLocalOperation の同期 reject を正確に予測する。違反があれば submit せず
      // block 確定する（opId 紐づけ前に同期 reject が observer を発火させ limbo を永久 busy にする問題を回避）。
      // server だけが知る競合（ローカル未反映＝offline reconnect 等）は submit 後（opId 紐づけ済み）の async reject が拾う。
      if (validateOperation(backend.session.committedDocument, op).length > 0) {
        notifyCompensationBlocked(undoCtrl.blockInFlightCompensation(), '');
        backend.view.markCellDirty();
        return;
      }
      const id = submitToBackend(backend, op);
      backend.view.markCellDirty(); // 前段消費で editor onChange が走らない → 楽観適用の再描画をここで要求
      if (isStandalone) {
        const first = op.changes[0]!;
        undoCtrl.resolveCompensationCommitted(cellRevision(backend.session.committedDocument, first.rowId, first.columnId));
      } else if (id !== undefined) {
        undoCtrl.setCompensationOperationId(id);
      } else {
        undoCtrl.abortInFlightCompensation(); // collab で opId 取得不可（stopped 等）→ in-flight を巻き戻す
      }
    };

    /** 補償拒否（pre-check stale）の通知。共同編集のみ公開 rejected を発火する（standalone は診断のみ＝DD-024 契約）。 */
    const notifyCompensationBlocked = (block: 'undo-blocked' | 'redo-blocked' | undefined, operationId: string): void => {
      if (block === undefined) {
        return;
      }
      diag.emit('warn', 'undo-blocked', `${block} op=${operationId}（実行前 OCC 拒否）`);
      if (!isStandalone) {
        emit({ type: 'rejected', pendingCount: backend.session.pendingCount, conflict: { operationId, reason: 'rejected', code: block } });
      }
    };

    /** Ctrl/Cmd+Z: 直前の確定操作を補償 SetCells で戻す（空/pending/in-flight/stopped は no-op）。 */
    const performUndo = (): void => {
      if (readOnly) {
        diag.emit('info', 'readonly-blocked', 'readOnly: Undo を抑止（文書無変更）');
        return;
      }
      if (backend.session.isStopped) {
        return;
      }
      const built = undoCtrl.beginUndo(backend.session.pendingCount);
      if (built !== null) {
        submitCompensation(built.operation);
      }
    };

    /** Ctrl+Y / Ctrl+Shift+Z: Undo の逆（元値の再適用）。 */
    const performRedo = (): void => {
      if (readOnly) {
        diag.emit('info', 'readonly-blocked', 'readOnly: Redo を抑止（文書無変更）');
        return;
      }
      if (backend.session.isStopped) {
        return;
      }
      const built = undoCtrl.beginRedo(backend.session.pendingCount);
      if (built !== null) {
        submitCompensation(built.operation);
      }
    };

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
            notifyPreExecutionReject(
              'value-not-allowed',
              'value-not-allowed',
              `選択式列 ${columnId} に非候補値「${text}」が入力されました（未 submit・文書無変更・DD-027-1）`,
            );
            return; // 未 submit（op を捨てる・ドラフト復元はしない＝📐）
          }
        }
      }
      return submitSetCells(op);
    };

    // 候補 UI の対象セル判定（アクティブセルの前段裁定・dblclick 分岐・▼ 表示で共有）。
    // DD-037 決定①: `allowFreeText` の値によらず選択式列なら候補 UI を出す（候補 UI の可否と commit 検証の
    // 厳格さを分離した）。キー裁定での差（印字文字を奪うか）は allowsFreeTextIndex 側で表現する。
    const isSelectCellIndex = (colIndex: number): boolean => {
      const registry = columnTypeRegistry;
      if (registry === undefined) {
        return false;
      }
      const colId = backend.view.columnIdAt(colIndex);
      return colId !== undefined && registry.showsSuggestions(String(colId));
    };

    /** 列 index で自由入力が許可されているか（DD-037・印字文字を textarea 編集へ流すかの判定）。 */
    const allowsFreeTextIndex = (colIndex: number): boolean => {
      const registry = columnTypeRegistry;
      if (registry === undefined) {
        return true;
      }
      const colId = backend.view.columnIdAt(colIndex);
      return colId === undefined || registry.allowsFreeText(String(colId));
    };

    // ドロップダウンを開いた時点の対象セル（beforeRevision 凍結・確定で OCC 裁定に使う・📐）。
    let selectOpenTarget:
      | { readonly rowId: RowId; readonly columnId: ColumnId; readonly beforeRevision: number; readonly currentValue: string }
      | null = null;

    /**
     * 開いているドロップダウンの種類（DD-037 決定①③）。
     * - `'picker'`: Navigation で明示操作（F2 / Enter / Alt+↓ / ダブルクリック）から開いた従来のドロップダウン。
     *   ↑↓/Enter/Esc/Tab を奪い、他キーは握り潰す（DD-027-1 の挙動そのまま）。
     * - `'suggest'`: 自由入力併存列（allowFreeText:true）の**編集中**に draft の前方一致で自動表示する候補リスト。
     *   **キーを一切奪わない**（decideSelectKey は非 Navigation 位相で必ず 'none'）＝印字・IME・キャレット移動・
     *   Enter/Tab の確定はすべて従来の editor 経路のまま流れる。表示だけの passive なオーバーレイ。
     */
    let selectOpenMode: 'picker' | 'suggest' | null = null;

    /**
     * suggest モードで最後に適用した絞り込みの識別子（`columnId\u0000draft`）。`refreshSelectPlacement` は毎フレーム
     * 走るため、これが同じ間は listbox の DOM 再構築（`setOptions`→`replaceChildren`）を省く（60fps の無駄な
     * 再構築＝ちらつき・hover/スクロール状態のリセットを避ける）。閉じるたびに null へ戻す。
     */
    let suggestFilterKey: string | null = null;

    const openSelect = (): void => {
      if (readOnly) {
        // 選択式列のドロップダウンは開かない（要確認2・文書変更経路の入口）。
        diag.emit('info', 'readonly-blocked', 'readOnly: 選択式ドロップダウンを抑止');
        return;
      }
      if (isActiveCellReadOnly()) {
        diag.emit('info', 'readonly-column-blocked', 'readOnlyColumns/readOnlyRows: 選択式ドロップダウンを抑止');
        return;
      }
      if (editor === undefined || selectDropdown === undefined || columnTypeRegistry === undefined) {
        return;
      }
      // composition 中・非 Navigation は開かない（IME 経路無改変・I-3）。
      if (editor.session.isComposing() || editor.session.getPhase() !== 'Navigation') {
        return;
      }
      const active = editor.session.getActiveCell();
      const rowId = backend.view.rowIdAt(active.row);
      const columnId = backend.view.columnIdAt(active.col);
      if (rowId === undefined || columnId === undefined) {
        return;
      }
      const options = columnTypeRegistry.getSelectOptions(String(columnId));
      if (options === undefined) {
        return;
      }
      const currentValue = backend.view.cellDisplay(rowId, columnId);
      const beforeRevision = captureEditStartRevision(backend.session.committedDocument, rowId, columnId);
      selectOpenTarget = { rowId, columnId, beforeRevision, currentValue };
      // 画面外セルで F2 等を押したとき、まず可視域へスクロールしてから配置する（1フレームのちらつき解消・Fable 5 P3-7）。
      ensureActiveCellVisible();
      const transform = currentTransform();
      const placement = transform === undefined ? null : computeEditorPlacement(transform, active.row, active.col, placementConfig());
      selectDropdown.open({
        rect: placement !== null && placement.visible ? placement.rect : null,
        options,
        currentValue,
      });
      selectOpenMode = 'picker';
      backend.view.markViewportDirty();
    };

    const cancelSelect = (): void => {
      if (selectDropdown === undefined || !selectDropdown.isOpen()) {
        return;
      }
      selectDropdown.close();
      selectOpenTarget = null;
      selectOpenMode = null;
      suggestFilterKey = null;
      backend.view.markViewportDirty();
    };

    const confirmSelect = (): void => {
      if (selectDropdown === undefined || !selectDropdown.isOpen() || selectOpenTarget === null) {
        return;
      }
      const target = selectOpenTarget; // Escape 投入より前に確保する（以降の副作用で null 化されても安全）
      // DD-037: suggest モード（編集中の候補リスト）から候補をクリックで確定するときは、先に編集セッションを
      // 取り消す。そうしないと編集中の draft が後から commit されて候補の確定を上書きしてしまう。
      // 状態機械の公開入口（handleEvent）へ Escape を投げるだけ＝editor-state-machine・IME は無改変（I-3）。
      // 変換中は IME を最優先して何もしない（確定は変換確定後の操作で行う）。
      if (selectOpenMode === 'suggest' && editor !== undefined) {
        if (editor.session.isComposing()) {
          return;
        }
        if (editor.session.getPhase() !== 'Navigation') {
          editor.session.handleEvent({ type: 'keydown', key: 'Escape', isComposing: false, shiftKey: false });
        }
      }
      const value = selectDropdown.confirmValue(); // 内部で close 済み
      selectOpenTarget = null;
      selectOpenMode = null;
      backend.view.markViewportDirty();
      // 無変更判定は open 時スナップショットでなく**確定時点**の表示値と比較する（Fable 5 P2-4）: open 中に
      // リモート/ローカルで値が変わった後に「元の値」を選ぶとサイレント no-op になる事故を防ぐ。
      const currentNow = backend.view.cellDisplay(target.rowId, target.columnId);
      if (value === null || value === currentNow) {
        return; // 候補なし or 確定時点で既に同値 → 文書を触らない
      }
      // 確定前に対象行の生存を確認する（表示中にリモート/ローカルで削除された場合の実行前拒否・📐）。
      if (!isRowLive(backend.session.committedDocument, target.rowId)) {
        notifyRowReject('row-unavailable', 'select-row-deleted', `選択確定対象の行が削除済み: row=${String(target.rowId)}`);
        return;
      }
      const op: SetCellsOperation = {
        type: 'setCells',
        conflictPolicy: 'reject-overlap',
        changes: [
          {
            rowId: target.rowId,
            columnId: target.columnId,
            beforeRevision: target.beforeRevision, // 開いた時点で凍結（OCC は既存 reject 経路が裁く）
            value: draftToScalar(value),
          },
        ],
      };
      submitSetCells(op); // 既存 chokepoint（Undo 記録・cell-commit 通知・自動行高が既存経路で成立）
      backend.view.markCellDirty();
    };

    // 選択式ドロップダウンは選択式列があるときだけ配線する（無ければ overhead ゼロ）。
    if (columnTypeRegistry?.hasAnySelectColumn() === true) {
      selectDropdown = createSelectDropdown({ host: stage, onConfirm: () => confirmSelect() });
    }

    // ---- DD-035 R2 日付列（カレンダー・ポップオーバー・editor 経路無改変）----
    /** 列 index が日付列か（readOnly 列・グリッド readOnly は開けない側で除外する）。 */
    const isDateCellIndex = (colIndex: number): boolean => {
      const registry = columnTypeRegistry;
      if (registry === undefined) {
        return false;
      }
      const colId = backend.view.columnIdAt(colIndex);
      return colId !== undefined && registry.isDateColumn(String(colId));
    };
    /** 列 index の日付列 openOn（既定 'dblclick'）。日付列でなければ undefined。 */
    const dateOpenOnOf = (colIndex: number): 'dblclick' | 'icon' | undefined => {
      const colId = backend.view.columnIdAt(colIndex);
      const type = colId === undefined ? undefined : columnTypeRegistry?.getDateType(String(colId));
      return type === undefined ? undefined : (type.openOn ?? 'dblclick');
    };

    // カレンダーを開いた時点の対象セル（beforeRevision 凍結・確定で OCC 裁定に使う・select と同型）。
    let dateOpenTarget: { readonly rowId: RowId; readonly columnId: ColumnId; readonly beforeRevision: number } | null = null;

    const openDate = (): void => {
      if (readOnly) {
        diag.emit('info', 'readonly-blocked', 'readOnly: 日付カレンダーを抑止');
        return;
      }
      if (isActiveCellReadOnly()) {
        diag.emit('info', 'readonly-column-blocked', 'readOnlyColumns/readOnlyRows: 日付カレンダーを抑止');
        return;
      }
      if (editor === undefined || datePicker === undefined || columnTypeRegistry === undefined) {
        return;
      }
      // composition 中・非 Navigation は開かない（IME 経路無改変・I-3）。
      if (editor.session.isComposing() || editor.session.getPhase() !== 'Navigation') {
        return;
      }
      const active = editor.session.getActiveCell();
      if (!isDateCellIndex(active.col)) {
        return;
      }
      const rowId = backend.view.rowIdAt(active.row);
      const columnId = backend.view.columnIdAt(active.col);
      if (rowId === undefined || columnId === undefined) {
        return;
      }
      cancelSelect(); // 併存しない（同一列に両型は無いが防御）
      const currentValue = backend.view.cellDisplay(rowId, columnId);
      const beforeRevision = captureEditStartRevision(backend.session.committedDocument, rowId, columnId);
      dateOpenTarget = { rowId, columnId, beforeRevision };
      ensureActiveCellVisible();
      const transform = currentTransform();
      const placement = transform === undefined ? null : computeEditorPlacement(transform, active.row, active.col, placementConfig());
      datePicker.open({ rect: placement !== null && placement.visible ? placement.rect : null, currentValue });
      diag.emit('info', 'date-open', `date: カレンダーを開く row=${String(rowId)} col=${String(columnId)} current=「${currentValue}」`);
      backend.view.markViewportDirty();
    };

    const cancelDate = (): void => {
      if (datePicker === undefined || !datePicker.isOpen()) {
        return;
      }
      datePicker.close();
      dateOpenTarget = null;
      backend.view.markViewportDirty();
    };

    /**
     * カレンダーの確定（日クリック・Enter・「今日」・「クリア」=''）。閉じてから既存 chokepoint（submitSetCells）へ流す＝
     * Undo 記録・cell-commit 通知・OCC（開いた時点の beforeRevision を凍結）が既存経路で成立する（confirmSelect と同型）。
     * 確定時点で同値なら文書を触らず、対象行が削除済みなら実行前拒否（row-unavailable）。
     */
    const confirmDate = (value: string): void => {
      if (datePicker === undefined || !datePicker.isOpen() || dateOpenTarget === null) {
        return;
      }
      const target = dateOpenTarget;
      datePicker.close();
      dateOpenTarget = null;
      backend.view.markViewportDirty();
      const currentNow = backend.view.cellDisplay(target.rowId, target.columnId);
      if (value === currentNow) {
        return;
      }
      if (!isRowLive(backend.session.committedDocument, target.rowId)) {
        notifyRowReject('row-unavailable', 'date-row-deleted', `日付確定対象の行が削除済み: row=${String(target.rowId)}`);
        return;
      }
      const op: SetCellsOperation = {
        type: 'setCells',
        conflictPolicy: 'reject-overlap',
        changes: [
          {
            rowId: target.rowId,
            columnId: target.columnId,
            beforeRevision: target.beforeRevision,
            value: draftToScalar(value), // 'YYYY-MM-DD' → kind:'date'（ADR-0012 正準）／'' → blank（クリア）
          },
        ],
      };
      submitSetCells(op);
      backend.view.markCellDirty();
    };

    // カレンダーは日付列があるときだけ配線する（無ければ overhead ゼロ）。
    if (columnTypeRegistry?.hasAnyDateColumn() === true) {
      datePicker = createDatePicker({
        host: stage,
        onConfirm: (value) => confirmDate(value),
        onIndicatorClick: () => openDate(),
      });
    }
    closeDatePicker = cancelDate;
    openDateForActive = openDate;
    isDblclickDateColumnIndex = (colIndex) => dateOpenOnOf(colIndex) === 'dblclick' && !isReadOnlyColumnIndex(colIndex);
    refreshDatePlacement = (transform: ViewportTransform): void => {
      if (datePicker === undefined || editor === undefined) {
        return;
      }
      // open 中に IME composition が始まる/非 Navigation へ遷移したら閉じる（select と同じ毎フレーム防御）。
      if (datePicker.isOpen() && (editor.session.isComposing() || editor.session.getPhase() !== 'Navigation')) {
        cancelDate();
      }
      // 📅 インジケーター: アクティブセルが日付列 & Navigation & 非 composition & 開ける状態（readOnly/列 readOnly でない）。
      const active = editor.session.getActiveCell();
      const showIndicator =
        !readOnly &&
        isDateCellIndex(active.col) &&
        !isActiveCellReadOnly() && // DD-035 R4 / DD-036 C3: readOnly 列・行では開けないため affordance も出さない
        !editor.session.isComposing() &&
        editor.session.getPhase() === 'Navigation';
      let indicatorRect: CellRect | null = null;
      if (showIndicator) {
        const ip = computeEditorPlacement(transform, active.row, active.col, placementConfig());
        indicatorRect = ip.visible ? ip.rect : null;
      }
      let openRect: CellRect | null = null;
      if (datePicker.isOpen() && dateOpenTarget !== null) {
        const r = backend.view.rowIndexOf(dateOpenTarget.rowId);
        const c = backend.view.colIndexOf(dateOpenTarget.columnId);
        if (r < 0 || c < 0) {
          diag.emit('warn', 'date-target-removed', `日付カレンダーの対象セルが消失したため閉じる: row=${String(dateOpenTarget.rowId)} col=${String(dateOpenTarget.columnId)}`);
          cancelDate();
        } else {
          const op = computeEditorPlacement(transform, r, c, placementConfig());
          if (op.visible) {
            openRect = op.rect;
          } else {
            cancelDate(); // 画面外スクロール → 閉じる
          }
        }
      }
      datePicker.refresh({ openRect, indicatorRect });
    };

    // createGridController 直下の handler（dblclick・pointerdown・redraw）から呼ぶための ref を公開する。
    openSelectForActive = openSelect;
    isSelectColumnIndex = isSelectCellIndex;
    closeSelectDropdown = cancelSelect;
    /**
     * DD-037 決定③: 自由入力併存列（allowFreeText:true）の**編集中**に、draft の前方一致で候補リストを自動表示する
     * （suggest モード）。候補 0 件になったら閉じる＝自由入力の邪魔をしない。
     *
     * **キーを一切奪わない**のが本モードの契約: `decideSelectKey` は非 Navigation 位相で必ず 'none' を返すため、
     * 印字・IME 変換・キャレット移動・Enter/Tab の確定はすべて従来の editor 経路のまま流れる。ゆえに変換中
     * （composition）に出したままでも状態不整合が起きない（picker と違い入力の所有権を持たないため）。
     * ハイライトは付けずに開く＝Enter は候補でなく入力文字列を確定する（決定④）。候補の選択はクリック
     * （listbox の pointerdown → confirmSelect）で行う。
     */
    const syncSuggestList = (): void => {
      if (selectDropdown === undefined || editor === undefined || columnTypeRegistry === undefined) {
        return;
      }
      const active = editor.session.getActiveCell();
      const eligible =
        editor.session.getPhase() !== 'Navigation' && // 編集中だけ（Navigation の候補は picker が担当）
        !readOnly &&
        isSelectCellIndex(active.col) &&
        allowsFreeTextIndex(active.col) && // 厳格モードは picker が開くため suggest は出さない
        !isActiveCellReadOnly();
      if (!eligible) {
        if (selectOpenMode === 'suggest') {
          cancelSelect(); // 編集終了・対象外セルへ移動 → 候補リストを畳む
        }
        return;
      }
      if (selectOpenMode === 'picker') {
        return; // 明示操作で開いた picker を優先（編集中に picker は開かないが防御）
      }
      const rowId = backend.view.rowIdAt(active.row);
      const columnId = backend.view.columnIdAt(active.col);
      if (rowId === undefined || columnId === undefined) {
        return;
      }
      const options = columnTypeRegistry.getSelectOptions(String(columnId));
      if (options === undefined) {
        return;
      }
      const draft = editor.session.getDraft();
      const filterKey = `${String(columnId)}\u0000${draft}`;
      if (selectOpenMode === 'suggest' && filterKey === suggestFilterKey) {
        return; // draft も対象列も変わっていない → listbox の再構築は不要（毎フレーム呼ばれるため必須の間引き）
      }
      const filtered = filterOptionsByPrefix(options, draft);
      if (filtered.length === 0) {
        if (selectOpenMode === 'suggest') {
          cancelSelect(); // 候補 0 件 → 閉じる（決定③・suggestFilterKey も null へ戻る）
        }
        return;
      }
      if (selectOpenMode === 'suggest') {
        selectDropdown.setOptions(filtered); // 開いたまま絞り込み（ハイライトは解除される）
        suggestFilterKey = filterKey;
        return;
      }
      // 初回表示: 対象セルを凍結して開く（rect は本フレームの placement 更新で入る）。
      selectOpenTarget = {
        rowId,
        columnId,
        beforeRevision: captureEditStartRevision(backend.session.committedDocument, rowId, columnId),
        currentValue: backend.view.cellDisplay(rowId, columnId),
      };
      selectOpenMode = 'suggest';
      suggestFilterKey = filterKey;
      selectDropdown.open({ rect: null, options: filtered, currentValue: '', highlight: false });
      backend.view.markViewportDirty();
    };

    refreshSelectPlacement = (transform: ViewportTransform): void => {
      if (selectDropdown === undefined || editor === undefined) {
        return;
      }
      // Fable 5 P2-2: open 中に IME composition が始まる/非 Navigation へ遷移したら閉じる（keydown consume では
      // compositionstart は止められない＝状態不整合→自傷 cell-conflict を防ぐ）。毎フレームの防御。
      // DD-037: 対象は picker（入力の所有権を持つドロップダウン）だけ。suggest は編集中/変換中に出ているのが
      // 正常な状態で、キーを奪わないため同じ不整合は起こらない。
      if (
        selectOpenMode === 'picker' &&
        selectDropdown.isOpen() &&
        (editor.session.isComposing() || editor.session.getPhase() !== 'Navigation')
      ) {
        cancelSelect();
      }
      syncSuggestList();
      // ▼ インジケーター: アクティブセルが選択式列 & Navigation & 非 composition のとき（発見性・in-scope 小）。
      const active = editor.session.getActiveCell();
      const showIndicator =
        isSelectCellIndex(active.col) &&
        !isActiveCellReadOnly() && // DD-035 R4 / DD-036 C3: readOnly 列・行では開けないため affordance も出さない
        !editor.session.isComposing() &&
        editor.session.getPhase() === 'Navigation';
      let indicatorRect: CellRect | null = null;
      if (showIndicator) {
        const ip = computeEditorPlacement(transform, active.row, active.col, placementConfig());
        indicatorRect = ip.visible ? ip.rect : null;
      }
      // open 中の listbox 位置: 開いた対象セルの現在 index を引き直す。対象行/列が消えたら閉じて診断、
      // 画面外へスクロールしたら閉じる（📐 エッジ・Fable 5 P2-2 の同経路）。
      let openRect: CellRect | null = null;
      if (selectDropdown.isOpen() && selectOpenTarget !== null) {
        const r = backend.view.rowIndexOf(selectOpenTarget.rowId);
        const c = backend.view.colIndexOf(selectOpenTarget.columnId);
        if (r < 0 || c < 0) {
          // 対象行/列が削除された → 閉じて診断（📐「閉じて診断」）。確定は起きない
          // （confirmSelect の isRowLive はサブフレーム race に対する残余防御）。
          diag.emit('warn', 'select-target-removed', `選択式ドロップダウンの対象セルが消失したため閉じる: row=${String(selectOpenTarget.rowId)} col=${String(selectOpenTarget.columnId)}`);
          cancelSelect();
        } else {
          const op = computeEditorPlacement(transform, r, c, placementConfig());
          if (op.visible) {
            openRect = op.rect;
          } else {
            cancelSelect(); // 画面外スクロール → 閉じる（composition 不在ゆえ textarea の I-3 問題なし）
          }
        }
      }
      selectDropdown.refresh({ openRect, indicatorRect });
    };

    const editorLayout: GridLayout = {
      get rowCount() {
        return backend.view.rowAxis.count();
      },
      get columnCount() {
        return backend.view.colAxis.count();
      },
      rowHeaderWidth: HEADER_WIDTH,
      columnHeaderHeight: HEADER_HEIGHT,
      cellWidth: COL_WIDTH,
      cellHeight: ROW_HEIGHT,
    };
    editor = createIntegrationEditor({
      host: stage,
      document: docPort,
      submit: editorSubmit,
      // DD-033-1: 表示専用モードは常駐 textarea へ readOnly 属性＋編集 DOM イベントの dispatch 抑止（分岐追加のみ）。
      readOnly,
      // DD-035 R4: アクティブセルが readOnly 列にある間、編集 DOM イベントの dispatch を論理遮断する（物理遮断＝readOnly 属性は
      // onChange の syncColumnLock が同期）。DD-035 R6（Codex P1）: 命令 API が初回描画前で保留中の間も入力を遮断する
      // （保留の適用先が確定する前の打鍵を旧セルへ確定させない）。readOnlyColumns 未指定かつ保留なしなら常に false。
      isInputLocked: () => pendingCommands.length > 0 || isActiveCellReadOnly(),
      // DD-027-1（Fable 5 P3-9）: grid 外クリック等で常駐 textarea が blur したら選択式ドロップダウンを閉じる。
      // 候補クリックは listbox の pointerdown preventDefault で focus を保持するため blur せず、確定を妨げない。
      // DD-035 R2: 日付カレンダーも同様に閉じる。
      onBlur: () => {
        cancelSelect();
        cancelDate();
      },
      layout: editorLayout,
      onPresenceChange: (update: PresenceUpdate) => {
        backend.session.sendPresence(update);
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
        syncCellLock(); // DD-035 R4 / DD-036 C3: activeCell の列・行に応じて textarea の readOnly 属性を同期（非 composing 時のみ）
        ensureActiveCellVisible(); // アクティブセルを可視域へ（scrollTop/Left を同期更新しうる）
        // DD-020-1 AC4: activeCell 移動・編集開始で明示レンジを単一選択へ戻す（不変条件は controller が判定）。
        selectionCtrl.syncWithEditor(editor.session.getActiveCell(), editor.session.getPhase());
        selection = singleCell(editor.session.getActiveCell());
        const transform = currentTransform(); // 上の scroll 反映後の transform で配置する
        if (transform !== undefined) {
          editor.refreshPlacement(transform, placementConfig());
        }
        backend.view.markViewportDirty();
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
          readOnly &&
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
          hasReadOnlyCells() &&
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
          diag.emit(
            'info',
            isReadOnlyRowIndex(current.session.getActiveCell().row) ? 'readonly-row-blocked' : 'readonly-column-blocked',
            `readOnlyColumns/readOnlyRows: 編集キー「${input.key}」を抑止`,
          );
          return true;
        }
        // DD-035 R2: 日付カレンダーの前段裁定。open 中は矢印/PageUp/Down/Enter/Esc/Tab を消費し他キーを握り潰す。
        // 閉じている日付セルでは Alt+↓（常時）・F2/Enter（openOn='dblclick'）で開く。印字文字は 'none'＝手入力併存。
        // composition 中・非 Navigation では decideDateKey が必ず 'none'（I-3）。readOnly/列 readOnly は openDate 側で抑止。
        if (datePicker !== undefined) {
          const active = current.session.getActiveCell();
          const openOn = dateOpenOnOf(active.col);
          const decision = decideDateKey({
            key: input.key,
            ctrlKey: input.ctrlKey,
            metaKey: input.metaKey,
            altKey: input.altKey,
            shiftKey: input.shiftKey,
            eventComposing: input.isComposing,
            sessionComposing: current.session.isComposing(),
            phase: current.session.getPhase(),
            isOpen: datePicker.isOpen(),
            isDateCell: openOn !== undefined && !readOnly && !isActiveCellReadOnly(),
            openOn: openOn ?? 'dblclick',
          });
          switch (decision) {
            case 'open':
              openDate();
              return true;
            case 'move-left':
              datePicker.moveDays(-1);
              return true;
            case 'move-right':
              datePicker.moveDays(1);
              return true;
            case 'move-up':
              datePicker.moveDays(-7);
              return true;
            case 'move-down':
              datePicker.moveDays(7);
              return true;
            case 'prev-month':
              datePicker.moveMonths(-1);
              return true;
            case 'next-month':
              datePicker.moveMonths(1);
              return true;
            case 'confirm': {
              const value = datePicker.highlightedValue();
              if (value === null) {
                cancelDate();
              } else {
                confirmDate(value);
              }
              return true;
            }
            case 'cancel':
              cancelDate();
              return true;
            case 'consume':
              return true;
            case 'none':
              break;
          }
        }
        // DD-027-1: 選択式ドロップダウンの前段裁定（最優先）。open 中は ↑↓/Enter/Esc/Tab を消費し他キーを握り潰す。
        // 閉じている選択式セルでは編集開始キー（F2/Enter/Alt+↓）でドロップダウンを開く。印字文字も開くのは
        // 厳格モード（allowFreeText:false）だけで、自由入力併存列では textarea 編集へ流す（DD-037 決定①）。
        // composition 中・非 Navigation では decideSelectKey が必ず 'none'＝IME 経路無改変（I-3）。
        if (selectDropdown !== undefined) {
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
            isOpen: selectDropdown.isOpen(),
            // DD-035 R4: readOnly 列の選択式セルは「非選択式」として裁定する（Enter=下移動等の閲覧系キーを奪わない。
            // 編集開始キーは readonly 裁定/列ロックが遮断済み）。
            isSelectCell: isSelectCellIndex(active.col) && !isActiveCellReadOnly(),
            // DD-037 決定①: 自由入力併存列では印字文字を奪わない（textarea 編集を開始させる）。
            allowsFreeText: allowsFreeTextIndex(active.col),
          });
          switch (decision) {
            case 'open':
              openSelect();
              return true;
            case 'move-down':
              selectDropdown.highlightNext();
              backendNow.view.markViewportDirty();
              return true;
            case 'move-up':
              selectDropdown.highlightPrev();
              backendNow.view.markViewportDirty();
              return true;
            case 'confirm':
              confirmSelect();
              return true;
            case 'cancel':
              cancelSelect();
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
      wrapCache: cellTextCache,
      cellFont: CELL_FONT,
      lineHeight: CELL_TEXT_LINE_HEIGHT,
      // 確定通知（決定②「通知のみ」）: 表示文字列 batch を cell-commit イベントへ写して購読者へ配信する。
      onCellCommit: (changes) => {
        emit({ type: 'cell-commit', changes });
      },
    });
    sync = standalone;
    attachBackendRendering();
    // boot 前に呼ばれた setData（キャッシュ済みデータの mount 直後注入等）を適用する（Codex[P1]）。
    if (pendingStandaloneData !== undefined) {
      const data = pendingStandaloneData;
      pendingStandaloneData = undefined;
      applyStandaloneData(data);
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
    if (editor === undefined || editor.session.isComposing()) {
      return;
    }
    // 新文書（差し替え直後・Axis は次 flush で再構築される）から行数・列数を読む。
    const doc = standalone.session.committedDocument;
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
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    focus() {
      // boot 完了前（editor 未生成 or 初回配置前）の focus 要求は保持し、初回描画後に適用する（P2-3）。
      if (firstDataDrawn && editor !== undefined) {
        editor.focus();
      } else {
        focusRequested = true;
      }
    },
    setData(data: GridStandaloneData) {
      // 単独モード専用（DD-024・決定③）。
      if (standalone !== undefined) {
        applyStandaloneData(data);
        return;
      }
      // 単独モードだが boot（microtask）未完了 → 保留し構築後に適用する（Codex[P1]・mount 直後注入を捨てない）。
      if (isStandalone && !destroyed) {
        pendingStandaloneData = data; // 複数回呼ばれたら最後の 1 回を採用（最新状態）
        return;
      }
      // 共同編集モードでは no-op（診断のみ）。
      diag.emit('warn', 'setData', 'setData は単独モード専用（共同編集モードでは無視）');
    },
    insertRows(options: { readonly afterRowId: string | null; readonly count?: number }) {
      performInsertRows(options.afterRowId, options.count ?? 1);
    },
    deleteRows(rowIds: readonly string[]) {
      performDeleteRows(rowIds);
    },
    scrollToRow(rowId: string) {
      runOrDefer(() => performScrollToRow(rowId));
    },
    scrollToColumn(columnId: string) {
      // DD-036（Codex P2）: 行 0 件でも成立するよう列用の ready 条件で判定する（保留キューは行命令と共有）。
      runOrDefer(() => performScrollToColumn(columnId), canRunColumnCommandsNow);
    },
    setActiveCell(rowId: string, columnId: string) {
      runOrDefer(() => performSetActiveCell(rowId, columnId));
    },
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      pendingCommands = []; // DD-035 R6: 保留中の命令は破棄（rAF ループ停止後に走らせない）
      diag.emit('info', 'destroy', 'grid を破棄しリソースを解放');
      cancelAnimationFrame(rafId);
      window.clearInterval(intervalId);
      abort.abort(); // scroller listeners を解放
      resizeObserver.disconnect();
      editor?.destroy(); // 常駐 textarea/badge・editor listeners を解放
      selectDropdown?.destroy(); // DD-027-1: listbox・▼ インジケーターを除去
      datePicker?.destroy(); // DD-035 R2: ポップオーバー・📅 インジケーターを除去
      browserTransport?.close(); // WS を閉じ再接続タイマーを解放
      scaffold.dispose(); // container から stage を除去
      debugRegistry.delete(instance);
      listeners.clear();
    },
  };

  // ---- E2E 用 introspection（test-support 経由）----
  const debugApi: GridDebugApi = {
    ready: () => sync !== undefined && firstDataDrawn && sync.view.rowAxis.count() > 1,
    online: () => sync?.session.isOnline ?? false,
    connectionState: () =>
      isStandalone
        ? 'standalone'
        : sync === undefined
          ? 'offline'
          : sync.session.isStopped
            ? 'stopped'
            : sync.session.isOnline
              ? 'online'
              : 'offline',
    lastEventType: () => lastSessionEvent?.type ?? '',
    rowCount: () => sync?.view.rowAxis.count() ?? 0,
    committedRevision: () => sync?.session.committedDocument.revision ?? 0,
    committedHash: () => (sync === undefined ? '' : documentHash(sync.session.committedDocument)),
    pendingCount: () => sync?.session.pendingCount ?? 0,
    conflictCount: () => sync?.session.conflictQueue.length ?? 0,
    divertedCount: () => editor?.session.divertedDrafts().length ?? 0,
    knownPresenceCount: () => sync?.session.knownPresences().length ?? 0,
    bootstrapRevision: () => sync?.session.bootstrapRevision ?? 0,
    appliedServerOpCount: () => sync?.session.appliedServerOpCount ?? 0,
    presences: () =>
      (sync?.session.knownPresences() ?? []).map((p) => ({
        displayName: p.displayName,
        activeCell: toAddress(p.activeCell),
        editingCell: toAddress(p.editingCell),
        selectionRanges: p.selectionRanges.map((r) => ({
          startRowId: String(r.startRowId),
          startColumnId: String(r.startColumnId),
          endRowId: String(r.endRowId),
          endColumnId: String(r.endColumnId),
        })),
      })),
    isConflicting: () => editor?.session.isConflicting() ?? false,
    isTargetLost: () => editor?.session.isTargetLost() ?? false,
    isComposing: () => editor?.session.isComposing() ?? false,
    draft: () => editor?.session.getDraft() ?? '',
    activeCell: () => editor?.session.getActiveCell() ?? { row: 0, col: 0 },
    selectionRange: () => selectionCtrl.getRange(),
    dragRange: () => selectionCtrl.getDragRange(),
    // DD-027-1: 選択式ドロップダウンの観測（開閉・候補・ハイライト）。
    selectOpen: () => selectDropdown?.isOpen() ?? false,
    selectOptions: () => [...(selectDropdown?.options() ?? [])],
    selectHighlightedIndex: () => selectDropdown?.highlightedIndex() ?? -1,
    selectHighlightedValue: () => selectDropdown?.highlightedValue() ?? null,
    // DD-035 R2: 日付カレンダーの観測（開閉・ハイライト・表示月）。
    dateOpen: () => datePicker?.isOpen() ?? false,
    dateHighlightedValue: () => datePicker?.highlightedValue() ?? null,
    dateViewMonth: () => datePicker?.viewMonth() ?? null,
    // DD-020-3: Undo/Redo 可否・深さ（pending が読めないときは undo 不可側に倒す）。
    canUndo: () => undoCtrl.canUndo(sync?.session.pendingCount ?? 1),
    canRedo: () => undoCtrl.canRedo(sync?.session.pendingCount ?? 1),
    undoDepth: () => undoCtrl.undoDepth(),
    redoDepth: () => undoCtrl.redoDepth(),
    editingTarget: () => {
      const t = editor?.session.getEditingTarget() ?? null;
      return t === null ? null : { rowId: String(t.rowId), columnId: String(t.columnId) };
    },
    rowIdAt: (index) => {
      const id = sync?.view.rowIdAt(index);
      return id === undefined ? undefined : String(id);
    },
    colIdAt: (index) => {
      const id = sync?.view.columnIdAt(index);
      return id === undefined ? undefined : String(id);
    },
    rowIndexOf: (rowId) => sync?.view.rowIndexOf(createRowId(rowId)) ?? -1,
    cellRectAt: (row, col) => currentTransform()?.cellRect(row, col) ?? null,
    // DD-035 R6: scrollToRow の観測（scroller の実 scrollTop/Left）。
    scrollTop: () => scroller.scrollTop,
    scrollLeft: () => scroller.scrollLeft,
    columnHeaderRectAt: (col) => currentTransform()?.columnHeaderRect(col) ?? null,
    rowHeaderRectAt: (row) => currentTransform()?.rowHeaderRect(row) ?? null,
    columnWidthOverrides: () => sync?.view.columnWidthOverrideRecord() ?? {},
    rowHeightOverrides: () => sync?.view.rowHeightOverrideRecord() ?? {},
    committedCell: (rowId, columnId) => {
      if (sync === undefined) {
        return '';
      }
      const record = getCell(sync.session.committedDocument, createRowId(rowId), createColumnId(columnId));
      return record === undefined ? '' : cellScalarToDisplay(record.value);
    },
    committedCellKind: (rowId, columnId) => {
      if (sync === undefined) {
        return 'blank';
      }
      const record = getCell(sync.session.committedDocument, createRowId(rowId), createColumnId(columnId));
      return record === undefined ? 'blank' : record.value.kind;
    },
    displayCell: (rowId, columnId) =>
      sync === undefined ? '' : sync.view.cellDisplay(createRowId(rowId), createColumnId(columnId)),
    // DD-033-2: base-layer が実際に描く display テキスト（raw→表示書式適用後）。canvas 文字は DOM から読めないため、
    // 描画経路と同じ compiledDisplay.formatText を通した結果を E2E に露出する（判定は raw・描画は display の検証用）。
    cellRenderText: (rowId, columnId) => {
      if (sync === undefined) {
        return '';
      }
      const raw = sync.view.cellDisplay(createRowId(rowId), createColumnId(columnId));
      return compiledDisplay?.formatText(columnId, raw) ?? raw;
    },
    // DD-033-2: 列ヘッダーに描く見出し（キャプション指定列はキャプション・未指定列は列記号 A/B/…）。
    columnHeaderText: (col) => {
      const id = sync?.view.columnIdAt(col);
      const caption = id === undefined ? undefined : compiledDisplay?.captionFor(String(id));
      return caption ?? columnLabel(col);
    },
    // DD-033-1（統合レビュー P3-1）: debug API（test-support）も readOnly では文書 Operation を送信しない。
    // 行操作は submitToBackend を通らず session.submitLocalOperation 直呼びのため、素通しだと
    // 「送信ゼロの構造的保証」の唯一の例外になる（perform* 先頭ガードの設計規約に合わせる）。
    submitInsertRowsAfter: (afterRowId, newRowId) => {
      if (sync === undefined) {
        return;
      }
      if (readOnly) {
        diag.emit('warn', 'readonly-blocked', 'readOnly: debug submitInsertRowsAfter を破棄');
        return;
      }
      const op: InsertRowsOperation = {
        type: 'insertRows',
        afterRowId: afterRowId === null ? null : createRowId(afterRowId),
        rows: [{ rowId: createRowId(newRowId) }],
      };
      sync.session.submitLocalOperation(op);
    },
    submitDeleteRow: (rowId) => {
      if (sync === undefined) {
        return;
      }
      if (readOnly) {
        diag.emit('warn', 'readonly-blocked', 'readOnly: debug submitDeleteRow を破棄');
        return;
      }
      const op: DeleteRowsOperation = { type: 'deleteRows', rowIds: [createRowId(rowId)] };
      sync.session.submitLocalOperation(op);
    },
    simulateDrop: () => {
      browserTransport?.dropForTest();
    },
    simulateReconnect: () => {
      browserTransport?.resumeReconnectForTest();
    },
  };
  debugRegistry.set(instance, debugApi);

  function toAddress(cell: { rowId: RowId; columnId: ColumnId } | undefined): GridDebugCellAddress | null {
    return cell === undefined ? null : { rowId: String(cell.rowId), columnId: String(cell.columnId) };
  }

  // ---- 起動（rAF ループ・tick interval・boot）----
  syncLayout();
  rafId = requestAnimationFrame(masterLoop);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
