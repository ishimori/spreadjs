// 描画（overlay・base の描画層、viewport transform、再描画、可視域への追従、canvas のレイアウト、構造 flush、rAF ループ）。
// DD-065 区画⑨。overlay は mount 時に作り、base は backend の結線時（attach）に DocumentView へ束縛して作る。

import {
  backingSize,
  captureAnchor,
  correctScroll,
  createOverlayLayer,
  createViewportTransform,
  mergedCellRect,
  normalizeDpr,
} from '@nanairo-sheet/render';
import type { FrameViewport, OverlayFrame, ViewportTransform } from '@nanairo-sheet/render';
import type { CellPosition } from '@nanairo-sheet/ime';
import { expandRangeToMerges, singleCell } from '@nanairo-sheet/selection';
import type { CellRange } from '@nanairo-sheet/selection';

import { createCanvasLayout } from '../canvas-layout';
import type { GridScaffold } from '../dom-scaffold';
import type { PlacementConfig } from '../editor-placement';
import type { GridBackend } from '../grid-backend';
import type { LoadMetrics } from '../initial-load-metrics';
import type { IntegrationEditor } from '../integration-editor';
import type { VisibleArea } from '../popup-placement';
import { toPresenceUsers } from '../presence-adapter';
import type { SelectionController } from '../selection-controller';
import type { MountBaseLayer } from './base-layer-options';
import { COL_WIDTH, HEADER_WIDTH } from './constants';
import type { RebaseState } from './edit-submit';
import type { MountMerges } from './merges';

export interface RenderDeps {
  readonly scaffold: Pick<GridScaffold, 'stage' | 'baseCanvas' | 'overlayCanvas' | 'scroller' | 'spacer' | 'baseCtx' | 'overlayCtx'>;
  readonly headerHeight: number;
  readonly frozenRowCount: number;
  readonly frozenColCount: number;
  readonly wrapEnabled: boolean;
  readonly metrics: LoadMetrics;
  readonly selectionCtrl: SelectionController;
  readonly merges: Pick<MountMerges, 'current' | 'any' | 'isMergedCellIndex' | 'isMergedCellId' | 'resolve' | 'normalizeActiveCell'>;
  backend(): GridBackend | undefined;
  editor(): IntegrationEditor | undefined;
  isDestroyed(): boolean;
  /** backend の結線時に base-layer を作る（mount 時に解釈した設定へ束縛する）。 */
  createBaseLayer(backend: GridBackend): MountBaseLayer;
  /** 毎フレーム: 候補欄・日付カレンダーの位置を scroll・構造 Op に追従させる（候補欄 → 日付の順）。 */
  refreshPopupPlacement(transform: ViewportTransform): void;
  /** 開いている候補欄・日付カレンダーを閉じる。 */
  closePopups(): void;
  syncCellLock(): void;
  /** 初回のデータ描画の直後に 1 回だけ（未知の行の診断・アクティブセルのロックの確定）。 */
  onFirstDataDrawn(): void;
  captureRebaseState(): RebaseState | null;
  applyRebaseState(state: RebaseState | null): void;
  /** 構造 flush の後に保留中の命令を新 Axis で適用する。 */
  drainPendingCommands(): void;
}

export interface MountRender {
  currentTransform(): ViewportTransform | undefined;
  placementConfig(): PlacementConfig;
  /** 本体の可視域（stage 座標の幅・高さ。ネイティブスクロールバーを除く）。 */
  visibleArea(): VisibleArea;
  viewportSize(): { readonly width: number; readonly height: number };
  /** 指定セルが body viewport の外にあれば最小スクロールで可視域へ入れる（Excel 準拠の scroll-follow）。 */
  ensureCellVisible(cell: CellPosition, axes?: 'both' | 'vertical' | 'horizontal'): void;
  ensureActiveCellVisible(): void;
  syncSpacer(): void;
  syncLayout(): void;
  /** 構造 Op の flush（scroll anchor 捕捉 → rowAxis 再構築 → K3 再ベース → scroll 補正）。 */
  flushStructural(view: GridBackend['view']): void;
  isFirstDataDrawn(): boolean;
  /** onChange: 明示レンジが無いときに描くアクティブセルの単一セル（shadow）。 */
  setActiveShadow(cell: CellPosition): void;
  /** focus(): 初回描画の前（editor 未生成・初回配置前）なら保留し、初回の配置の後に適用する（P2-3）。 */
  focusOrDefer(): void;
  /** backend へ結線する（wrap 列の自動行高から結合範囲を外し、base-layer を作る）。 */
  attach(backend: GridBackend): void;
  /** canvas のレイアウト追従（DPR の変化・ResizeObserver）を始める。 */
  observeLayout(): void;
  /** 初回の配置と rAF ループを始める。 */
  start(): void;
  /** destroy: rAF ループを止める。 */
  stopLoop(): void;
  /** destroy: ResizeObserver を外す。 */
  disconnectLayout(): void;
}

export function createRender(deps: RenderDeps): MountRender {
  const { stage, baseCanvas, overlayCanvas, scroller, spacer, baseCtx, overlayCtx } = deps.scaffold;
  const { headerHeight, frozenRowCount, frozenColCount, wrapEnabled, metrics, selectionCtrl, merges } = deps;
  let baseLayer: MountBaseLayer | undefined;
  let dpr = normalizeDpr(window.devicePixelRatio);
  let viewportWidth = 0;
  let viewportHeight = 0;
  // 明示レンジが無いときに描くアクティブセルの単一セル（onChange が更新する shadow）。
  let selection: CellRange | null = null;
  let firstDataDrawn = false;
  let focusRequested = false; // boot 完了前の focus() 要求（初回配置後に適用・P2-3）
  let rafId = 0;
  let canvasLayout: ReturnType<typeof createCanvasLayout> | undefined;
  let resizeObserver: ResizeObserver | undefined;

  const overlayLayer = createOverlayLayer({
    ctx: overlayCtx,
    headerWidth: HEADER_WIDTH,
    headerHeight,
  });

  function overscanY(): number {
    return viewportHeight * 0.6;
  }
  function overscanX(): number {
    return COL_WIDTH * 3;
  }

  function currentTransform(): ViewportTransform | undefined {
    const sync = deps.backend();
    if (sync === undefined) {
      return undefined;
    }
    return createViewportTransform({
      rowAxis: sync.view.rowAxis,
      colAxis: sync.view.colAxis,
      headerWidth: HEADER_WIDTH,
      headerHeight,
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
      headerHeight,
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
    const currentMerges = merges.current();
    const sync = deps.backend();
    return {
      transform,
      viewportWidth,
      viewportHeight,
      dpr,
      // 明示レンジ（DD-020-1）があればそれを、無ければ activeCell の単一セル（onChange が更新する shadow）を描く。
      // DD-064: 単一セルが結合の左上なら枠は結合範囲全体（明示レンジ・ドラッグは selection-controller が広げ済み）。
      selection: selectionCtrl.getRange() ?? (selection === null ? null : expandRangeToMerges(currentMerges, selection)),
      dragRange: selectionCtrl.getDragRange(),
      presences: sync !== undefined ? toPresenceUsers(sync.session.knownPresences(), sync.view) : [],
      ...(currentMerges.size > 0 ? { mergedRanges: currentMerges } : {}),
    };
  }

  /**
   * DD-064: 結合を今の行の並びに張り直す（描画の直前にだけ呼ぶ＝setData・setMergedCells の呼ぶ順によらない・contract §1.2）。
   * 張った結合が変わったら、wrap 列の自動行高を測り直し（結合範囲のセルは測らない）、アクティブセルを結合の左上へ寄せ、
   * textarea のロックを取り直す。
   */
  function refreshMerges(): void {
    if (merges.resolve()) {
      afterMergesChanged();
    }
  }

  /** DD-064: 張った結合が変わった後の追従（wrap 列の自動行高・アクティブセルの左上への正規化・textarea のロック）。 */
  function afterMergesChanged(): void {
    const sync = deps.backend();
    if (wrapEnabled && sync !== undefined) {
      sync.view.recomputeAllAutoRowHeights();
      syncSpacer();
    }
    // Codex P2: 開いている候補欄・カレンダーのセルが結合範囲になったら閉じる（開いたままだと確定で読むだけのセルへ書ける）。
    // どちらもアクティブセル（編集中は編集セル）に開くので、アクティブセルで判定する。確定の時にも対象を確かめる（二重の防御）。
    const active = deps.editor()?.session.getActiveCell();
    if (active !== undefined && merges.isMergedCellIndex(active.row, active.col)) {
      deps.closePopups();
    }
    merges.normalizeActiveCell();
    deps.syncCellLock();
  }

  function redraw(): void {
    if (deps.backend() === undefined || baseLayer === undefined) {
      return;
    }
    refreshMerges(); // DD-064: 描く前に結合を今の行に張る（アクティブセルの正規化で scroll が動きうるので transform より先）
    const transform = currentTransform();
    if (transform === undefined) {
      return;
    }
    baseLayer.draw(frameViewport(transform));
    overlayLayer.draw(overlayFrame(transform));
    deps.editor()?.refreshPlacement(transform, placementConfig());
    // DD-027-1・DD-035 R2: 選択式ドロップダウン（▼）と日付カレンダー（📅）を scroll/構造Op に追従させる。
    deps.refreshPopupPlacement(transform);
  }

  /**
   * activeCell 移動（onChange）と Shift+矢印の focus 端拡張（DD-020-1）で呼ぶ。可視セルなら何もしない
   * （クリックで勝手にスクロールしない）。scroller.scrollTop/Left への代入は同期反映され、scroll イベント→
   * 再描画で追従する。
   */
  function ensureCellVisible(cell: CellPosition, axes: 'both' | 'vertical' | 'horizontal' = 'both'): void {
    const transform = currentTransform();
    if (transform === undefined) {
      return;
    }
    // DD-064: 結合の左上なら範囲全体を見せる（範囲が可視域より大きければ上端・左端を優先する）。
    const merge = merges.any() ? merges.current().at(cell.row, cell.col) : undefined;
    const rect = merge !== undefined ? mergedCellRect(transform, merge) : transform.cellRect(cell.row, cell.col);
    const bodyOriginX = HEADER_WIDTH + transform.frozenWidth();
    const bodyOriginY = headerHeight + transform.frozenHeight();
    // 固定行/列のセルはスクロール非依存ゆえ追従不要（body セルのみ）。
    // DD-036 C4: 軸指定（scrollToRow=縦のみ / scrollToColumn=横のみ）。既定 'both' は従来と同一挙動。
    // DD-046: stageにはネイティブスクロールバーも含まれる。文字が隠れない可視域へ収める。
    const { width: visibleWidth, height: visibleHeight } = visibleArea();
    if (axes !== 'horizontal' && cell.row >= frozenRowCount) {
      if (rect.y < bodyOriginY) {
        scroller.scrollTop += rect.y - bodyOriginY; // 上へはみ出し → スクロールアップ（負）
      } else if (rect.y + rect.height > visibleHeight) {
        const down = rect.y + rect.height - visibleHeight;
        scroller.scrollTop += merge === undefined ? down : Math.min(down, rect.y - bodyOriginY);
      }
    }
    if (axes !== 'vertical' && cell.col >= frozenColCount) {
      if (rect.x < bodyOriginX) {
        scroller.scrollLeft += rect.x - bodyOriginX;
      } else if (rect.x + rect.width > visibleWidth) {
        const right = rect.x + rect.width - visibleWidth;
        scroller.scrollLeft += merge === undefined ? right : Math.min(right, rect.x - bodyOriginX);
      }
    }
  }

  function ensureActiveCellVisible(): void {
    const editor = deps.editor();
    if (editor === undefined) {
      return;
    }
    ensureCellVisible(editor.session.getActiveCell());
  }

  /**
   * DD-046・DD-055: 本体の可視域（stage 座標の幅・高さ）。stage にはネイティブスクロールバーも含まれるため scroller の
   * client 寸法で制限する（初期レイアウトで 0 なら stage の寸法）。セルの追従と、候補欄・wrap 列の編集欄を収める先に使う。
   */
  function visibleArea(): VisibleArea {
    return {
      width: Math.min(viewportWidth, scroller.clientWidth || viewportWidth),
      height: Math.min(viewportHeight, scroller.clientHeight || viewportHeight),
    };
  }

  function provisionCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
    const backing = backingSize({ width: viewportWidth, height: viewportHeight }, dpr);
    // DD-058: 表示サイズも実画素の整数にそろえ、bitmap を 1:1 で合成する。
    canvas.style.width = `${backing.width / dpr}px`;
    canvas.style.height = `${backing.height / dpr}px`;
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
    dpr = normalizeDpr(window.devicePixelRatio);
    viewportWidth = Math.max(0, Math.floor(stage.clientWidth));
    viewportHeight = Math.max(0, Math.floor(stage.clientHeight));
    provisionCanvas(baseCanvas, baseCtx);
    provisionCanvas(overlayCanvas, overlayCtx);
    baseLayer?.textCache.clear();
    // DPR・Web font 変更で行分割キャッシュが消える → 折り返し行数が変わりうるため自動行高を再計算する（D5 ③相当）。
    if (wrapEnabled) {
      deps.backend()?.view.onTextMetricsChanged();
    }
    syncSpacer(); // 自動行高変化で総サイズが変わる → spacer を更新

    deps.backend()?.view.markViewportDirty();
  }

  function markFirstDataDraw(): void {
    const sync = deps.backend();
    if (!firstDataDrawn && sync !== undefined && sync.view.rowAxis.count() > 0) {
      firstDataDrawn = true;
      metrics.mark('firstDraw');
      metrics.mark('firstOperable');
      deps.onFirstDataDrawn();
      if (focusRequested) {
        focusRequested = false;
        deps.editor()?.focus(); // boot 前に要求された focus を初回配置後に適用する（P2-3）
      }
    }
  }

  /**
   * 構造Op の flush: scroll anchor 捕捉 → rowAxis 再構築 → K3 再ベース → scroll 補正（画面が跳ばないように・§13.4）。
   * masterLoop（rAF）が呼ぶほか、DD-035 R6 の命令 API（scrollToRow/setActiveCell）が構造 dirty 中に呼ばれたとき
   * **同期的に**呼ぶ（次 rAF まで保留すると、その間の利用者入力が旧アクティブセルへ届き誤セル確定になる＝Codex P1）。
   */
  function flushStructural(view: GridBackend['view']): void {
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
    const rebase = deps.captureRebaseState();
    const result = view.flush();
    if (result.structuralRebuilt) {
      metrics.mark('axisBuilt');
    }
    // DD-064: 再ベースの前に結合を新しい行 Axis へ張り直す（古い索引のままだと、再ベース先の正規化が古い行 index で左上を
    // 選び、挿入された別の行へ寄せてしまう）。追従（正規化・ロック）は再ベースの後に行う。
    const mergesChanged = merges.resolve();
    // rowAxis 再構築後に activeCell/選択レンジを RowId で新 index へ引き直す（表示 index ずれの是正）。
    deps.applyRebaseState(rebase);
    if (mergesChanged) {
      afterMergesChanged();
    }
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
    deps.syncCellLock();
  }

  function masterLoop(): void {
    canvasLayout?.sync();
    const view = deps.backend()?.view;
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
      deps.drainPendingCommands();
    }
    if (!deps.isDestroyed()) {
      rafId = requestAnimationFrame(masterLoop);
    }
  }

  return {
    currentTransform,
    placementConfig,
    visibleArea,
    viewportSize: () => ({ width: viewportWidth, height: viewportHeight }),
    ensureCellVisible,
    ensureActiveCellVisible,
    syncSpacer,
    syncLayout,
    flushStructural,
    isFirstDataDrawn: () => firstDataDrawn,
    setActiveShadow(cell) {
      selection = singleCell(cell);
    },
    focusOrDefer() {
      const editor = deps.editor();
      if (firstDataDrawn && editor !== undefined) {
        editor.focus();
      } else {
        focusRequested = true;
      }
    },
    attach(backend) {
      // DD-064: wrap 列の自動行高から結合範囲のセルを外す（範囲の文字で行の高さを伸ばさない＝Excel と同じ）。結合が変わるたびに
      // refreshMerges が全行を測り直す。wrap 列が無ければ自動行高そのものが無いので何もしない。
      if (wrapEnabled) {
        backend.view.setAutoHeightSkip((rowId, columnId) => merges.isMergedCellId(rowId, columnId));
      }
      baseLayer = deps.createBaseLayer(backend);
    },
    observeLayout() {
      const layout = createCanvasLayout(stage, [baseCanvas, overlayCanvas], syncLayout);
      canvasLayout = layout;
      const observer = new ResizeObserver(() => {
        syncLayout();
        layout.sync();
      });
      resizeObserver = observer;
      observer.observe(stage);
    },
    start() {
      syncLayout();
      canvasLayout?.sync();
      rafId = requestAnimationFrame(masterLoop);
    },
    stopLoop() {
      cancelAnimationFrame(rafId);
    },
    disconnectLayout() {
      resizeObserver?.disconnect();
    },
  };
}
