// grid Facade の mount 配線（旧 apps/playground/src/integration/main.ts を昇華）。
//
// pocb の Canvas 基盤（render）を使い、値の源を ClientSession（共同編集の唯一の正本）→ DocumentView（読み取り
// アダプター）に置く。IME は編集状態機械＋常駐 textarea（integration-editor）。挙動は main.ts と等価に保ちつつ、
// ①DOM は container 内に構築（dom-scaffold・D4）②SessionEvent を GridEvent へ写像して購読者へ配信③readout 表示は
// 持たず、代わりに destroy() で全リソース（RAF/interval/listener/ResizeObserver/WS/canvas/textarea）を解放する
// （再mountで leak しない・AC2）④E2E 用 introspection は debugRegistry 経由（test-support）で露出する。

import { SETCELLS_MAX_CELLS, cloneCellScalar, documentHash, displayRowOrder, getCell, parseClipboardText, validateOperation } from '@nanairo-sheet/core';
import type { DeleteRowsOperation, InsertRowsOperation, SetCellsOperation, SheetDocument } from '@nanairo-sheet/core';
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
import { FormatRuleConfigError, compileFormatRules } from './format-rules';
import type { CompiledColumnFormats } from './format-rules';
import { DisplayConfigError, compileDisplayFormats } from './display-format';
import type { CompiledColumnDisplay } from './display-format';
import { shouldArmLinkCandidate } from './link-column';
import { createSelectDropdown, decideSelectKey } from './select-editor';
import type { SelectDropdown } from './select-editor';
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
import type { ClipboardDocumentPort } from './clipboard-controller';
import { autoFitColumnWidth, computeAutoFitContentWidth, computeResizeSize, resizeHitTest } from './resize-interaction';
import type { ResizeTarget } from './resize-interaction';
import { createSelectionController, decideNavigationIntercept } from './selection-controller';
import { shouldSuppressReadonlyKey } from './readonly-policy';
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
  const wsUrl = serverOrigin === '' ? '' : `${serverOrigin.replace(/^http/, 'ws')}/ws`;

  const frozenRowCount = 1;
  const frozenColCount = 1;
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
  // DD-033-2: 列見出しキャプション＋表示書式のプリコンパイル済み解決器（columnOrder 解決後に生成・fail-fast）。
  // hasAny()=false（両オプション未指定）なら base-layer への columnHeaderLabel/formatCellText フック束縛を省く。
  let compiledDisplay: CompiledColumnDisplay | undefined;
  // 選択式ドロップダウンの制御は attachBackendRendering 内で backend/editor を閉じ込めた関数として定義し、
  // createGridController 直下の handler（dblclick・pointerdown・redraw）からは以下の ref 経由で呼ぶ。
  let openSelectForActive: (() => void) | undefined;
  let isSelectColumnIndex: ((colIndex: number) => boolean) | undefined;
  let closeSelectDropdown: (() => void) | undefined;
  let refreshSelectPlacement: ((transform: ViewportTransform) => void) | undefined;
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
  }

  /**
   * 指定セルが body viewport の外にあれば最小スクロールで可視域へ入れる（Excel 準拠の scroll-follow）。
   * activeCell 移動（onChange）と Shift+矢印の focus 端拡張（DD-020-1）で呼ぶ。可視セルなら何もしない
   * （クリックで勝手にスクロールしない）。scroller.scrollTop/Left への代入は同期反映され、scroll イベント→
   * 再描画で追従する。
   */
  function ensureCellVisible(cell: CellPosition): void {
    const transform = currentTransform();
    if (transform === undefined) {
      return;
    }
    const rect = transform.cellRect(cell.row, cell.col);
    const bodyOriginX = HEADER_WIDTH + transform.frozenWidth();
    const bodyOriginY = HEADER_HEIGHT + transform.frozenHeight();
    // 固定行/列のセルはスクロール非依存ゆえ追従不要（body セルのみ）。
    if (cell.row >= frozenRowCount) {
      if (rect.y < bodyOriginY) {
        scroller.scrollTop += rect.y - bodyOriginY; // 上へはみ出し → スクロールアップ（負）
      } else if (rect.y + rect.height > viewportHeight) {
        scroller.scrollTop += rect.y + rect.height - viewportHeight; // 下へはみ出し → スクロールダウン
      }
    }
    if (cell.col >= frozenColCount) {
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
      if (focusRequested) {
        focusRequested = false;
        editor?.focus(); // boot 前に要求された focus を初回配置後に適用する（P2-3）
      }
    }
  }

  function masterLoop(): void {
    const view = sync?.view;
    if (view !== undefined) {
      if (view.hasStructuralDirty()) {
        // 構造Op: scroll anchor 捕捉 → rowAxis 再構築 → scroll 補正（画面が跳ばないように・§13.4）。
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
      const linkArm = selectDropdownWasOpen ? null : computeLinkArm(cell, event);
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
        // DD-027-1: 選択式列（allowFreeText:false）は textarea 編集ではなくドロップダウンを開く（AC1）。
        // 先に activeCell を対象セルへ合わせてから開く（openSelectForActive は activeCell を読む）。
        if (isSelectColumnIndex?.(hit.colIndex) === true) {
          editor.pointerdownCell({ row: hit.rowIndex, col: hit.colIndex });
          openSelectForActive?.();
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
    const response = await fetch(`${serverOrigin}/config`, { signal });
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
      columnTypeRegistry = createColumnTypeRegistry(options.columnTypes, columnOrder, wrapColumnStrings);
      // DD-027-3: セル書式ルールをプリコンパイル（fail-fast）。不正は columnTypes と同じ column-types-invalid へ写像する。
      compiledFormats = compileFormatRules(options.columnFormats, columnOrder);
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
        case 'submit':
          submitSetCells(outcome.operation);
          // 前段消費のため editor onChange（markViewportDirty）が走らない → 楽観適用の再描画をここで要求する。
          backend.view.markCellDirty();
          return;
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
        submitSetCells(outcome.operation);
        backend.view.markCellDirty();
      }
      return tsv;
    };

    /**
     * paste: text/plain → parse → 敷き詰め/はみ出し全体拒否/上限/型変換 → 原子 SetCells（buildPaste）。
     * Navigation では**必ず消費**（true 返却＝preventDefault）する。消費しないと browser 既定が textarea へ
     * ペーストテキストを流し込み Navigation の input が編集を開始してしまう（グリッド paste 意図と乖離）。
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
        case 'submit':
          submitSetCells(outcome.operation);
          backend.view.markCellDirty();
          return true;
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

    // 選択式列の判定（アクティブセルの前段裁定・dblclick 分岐・▼ 表示で共有）。allowFreeText:true 列は
    // 従来どおり textarea 編集（ドロップダウンを強制しない・AC5）＝ここでは select 対象にしない。
    const isSelectCellIndex = (colIndex: number): boolean => {
      const registry = columnTypeRegistry;
      if (registry === undefined) {
        return false;
      }
      const colId = backend.view.columnIdAt(colIndex);
      return colId !== undefined && registry.isSelectColumn(String(colId)) && !registry.allowsFreeText(String(colId));
    };

    // ドロップダウンを開いた時点の対象セル（beforeRevision 凍結・確定で OCC 裁定に使う・📐）。
    let selectOpenTarget:
      | { readonly rowId: RowId; readonly columnId: ColumnId; readonly beforeRevision: number; readonly currentValue: string }
      | null = null;

    const openSelect = (): void => {
      if (readOnly) {
        // 選択式列のドロップダウンは開かない（要確認2・文書変更経路の入口）。
        diag.emit('info', 'readonly-blocked', 'readOnly: 選択式ドロップダウンを抑止');
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
      backend.view.markViewportDirty();
    };

    const cancelSelect = (): void => {
      if (selectDropdown === undefined || !selectDropdown.isOpen()) {
        return;
      }
      selectDropdown.close();
      selectOpenTarget = null;
      backend.view.markViewportDirty();
    };

    const confirmSelect = (): void => {
      if (selectDropdown === undefined || !selectDropdown.isOpen() || selectOpenTarget === null) {
        return;
      }
      const target = selectOpenTarget;
      const value = selectDropdown.confirmValue(); // 内部で close 済み
      selectOpenTarget = null;
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

    // createGridController 直下の handler（dblclick・pointerdown・redraw）から呼ぶための ref を公開する。
    openSelectForActive = openSelect;
    isSelectColumnIndex = isSelectCellIndex;
    closeSelectDropdown = cancelSelect;
    refreshSelectPlacement = (transform: ViewportTransform): void => {
      if (selectDropdown === undefined || editor === undefined) {
        return;
      }
      // Fable 5 P2-2: open 中に IME composition が始まる/非 Navigation へ遷移したら閉じる（keydown consume では
      // compositionstart は止められない＝状態不整合→自傷 cell-conflict を防ぐ）。毎フレームの防御。
      if (selectDropdown.isOpen() && (editor.session.isComposing() || editor.session.getPhase() !== 'Navigation')) {
        cancelSelect();
      }
      // ▼ インジケーター: アクティブセルが選択式列 & Navigation & 非 composition のとき（発見性・in-scope 小）。
      const active = editor.session.getActiveCell();
      const showIndicator =
        isSelectCellIndex(active.col) && !editor.session.isComposing() && editor.session.getPhase() === 'Navigation';
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
      // DD-027-1（Fable 5 P3-9）: grid 外クリック等で常駐 textarea が blur したら選択式ドロップダウンを閉じる。
      // 候補クリックは listbox の pointerdown preventDefault で focus を保持するため blur せず、確定を妨げない。
      onBlur: () => cancelSelect(),
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
        // DD-027-1: 選択式ドロップダウンの前段裁定（最優先）。open 中は ↑↓/Enter/Esc/Tab を消費し他キーを握り潰す。
        // 閉じている選択式セル（allowFreeText:false）では編集開始キー（F2/Enter/Alt+↓/印字文字）でドロップダウンを開く。
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
            isSelectCell: isSelectCellIndex(active.col),
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
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      diag.emit('info', 'destroy', 'grid を破棄しリソースを解放');
      cancelAnimationFrame(rafId);
      window.clearInterval(intervalId);
      abort.abort(); // scroller listeners を解放
      resizeObserver.disconnect();
      editor?.destroy(); // 常駐 textarea/badge・editor listeners を解放
      selectDropdown?.destroy(); // DD-027-1: listbox・▼ インジケーターを除去
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
