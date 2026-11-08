// ポインター操作（選択・ダブルクリックで編集・見出しの境界のリサイズ・列幅の自動調整）。DD-065 区画④。
// リスナーは mount 時に scroller へ登録する（登録順は従来どおり: pointermove → pointerleave → pointerup → pointercancel →
// lostpointercapture → pointerdown → dblclick → scroll。登録順はハンドラの実行順を決める）。destroy の abort で解除される。

import { BADGE_TEXT_PADDING, CELL_TEXT_PADDING, columnLabel } from '@nanairo-sheet/render';
import type { TextMetricsCache, ViewportTransform } from '@nanairo-sheet/render';
import { mergeAnchorOf } from '@nanairo-sheet/selection';
import type { ColumnId, RowId } from '@nanairo-sheet/types';

import type { CompiledAppearance } from '../appearance';
import type { CompiledColumnGroup } from '../column-groups';
import type { ColumnTypeRegistry } from '../column-types';
import type { DiagnosticSink } from '../diagnostics';
import type { CompiledColumnDisplay } from '../display-format';
import type { CompiledColumnFormats } from '../format-rules';
import type { GridBackend } from '../grid-backend';
import type { GridEvent } from '../index';
import type { IntegrationEditor } from '../integration-editor';
import { autoFitColumnWidth, computeAutoFitContentWidth, computeResizeSize, resizeHitTest } from '../resize-interaction';
import type { ResizeTarget } from '../resize-interaction';
import type { SelectionController } from '../selection-controller';
import type { CellLock } from './cell-lock';
import { AUTO_FIT_MAX_SCAN, HEADER_WIDTH } from './constants';
import type { DateWiring } from './date-wiring';
import type { CellHover } from './hover';
import type { LinkClick } from './link-click';
import type { MountMerges } from './merges';
import type { SelectWiring } from './select-wiring';

export interface PointerDeps {
  readonly stage: HTMLElement;
  readonly scroller: HTMLElement;
  readonly signal: AbortSignal;
  readonly diag: DiagnosticSink;
  readonly headerHeight: number;
  /** DD-064 K4: 2段の見出しの上の段の高さ（1 段なら 0）。 */
  readonly groupBandHeight: number;
  readonly wrapEnabled: boolean;
  readonly wrapColumnStrings: ReadonlySet<string>;
  readonly cellTextCache: TextMetricsCache;
  readonly selectionCtrl: SelectionController;
  readonly merges: Pick<MountMerges, 'current' | 'isMergedCellIndex'>;
  readonly cellLock: Pick<CellLock, 'isReadOnlyRowIndex' | 'isReadOnlyColumnIndex' | 'isReadOnlyCellIndex'>;
  readonly select: Pick<SelectWiring, 'isOpen' | 'close' | 'open' | 'isSelectColumnIndex' | 'isSearchableSelectColumnIndex'>;
  readonly date: Pick<DateWiring, 'isOpen' | 'close' | 'open' | 'isDblclickDateColumnIndex'>;
  readonly hover: CellHover;
  readonly link: LinkClick;
  emit(event: GridEvent): void;
  backend(): GridBackend | undefined;
  editor(): IntegrationEditor | undefined;
  registry(): ColumnTypeRegistry | undefined;
  appearance(): CompiledAppearance;
  display(): CompiledColumnDisplay | undefined;
  formats(): CompiledColumnFormats | undefined;
  columnGroups(): readonly CompiledColumnGroup[];
  isReadOnly(): boolean;
  currentTransform(): ViewportTransform | undefined;
  syncSpacer(): void;
  viewportSize(): { readonly width: number; readonly height: number };
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

type Hit = ReturnType<ViewportTransform['hitTest']>;

/** scroller へポインター操作のリスナーを登録する（mount 時に 1 回）。 */
export function registerPointerInteraction(deps: PointerDeps): void {
  const { stage, scroller, signal, diag, selectionCtrl, merges, cellLock, select, date, hover, link } = deps;
  let resizeDrag: ResizeDrag | null = null;
  // 範囲選択ドラッグの追跡（DD-020-1）。null=非ドラッグ。矩形自体は selectionCtrl が持ち、ここは
  // 「どの pointer のドラッグか」だけを持つ（マルチタッチの誤更新防止・resizeDrag と同型）。
  let selectionDrag: { readonly pointerId: number } | null = null;
  // DD-057: 検索付きの候補欄をクリックで開く候補（pointerdown で武装し、同じセルの pointerup で開く）。
  let searchSelectCandidate: { pointerId: number; row: number; col: number } | null = null;

  function stageLocal(event: PointerEvent): { x: number; y: number } {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /**
   * 範囲選択ドラッグ終了。confirm=true（pointerup）は矩形を明示レンジへ確定する（同一セルなら単一選択のまま）。
   * confirm=false（pointercancel/capture 喪失）はドラッグを破棄する（確定済みレンジは変更しない）。
   */
  function finishSelectionDrag(pointerId: number, confirm: boolean): void {
    if (selectionDrag === null || selectionDrag.pointerId !== pointerId) {
      return;
    }
    searchSelectCandidate = null;
    selectionDrag = null; // release より先に null 化（release が誘発する lostpointercapture の二重処理を無効化）
    if (scroller.hasPointerCapture(pointerId)) {
      scroller.releasePointerCapture(pointerId);
    }
    if (confirm) {
      selectionCtrl.endDrag();
    } else {
      selectionCtrl.cancelDrag();
    }
    deps.backend()?.view.markViewportDirty();
  }

  /** DD-064 K4: 列 index を含むまとまり（無ければ undefined）。 */
  function columnGroupAt(colIndex: number): CompiledColumnGroup | undefined {
    return deps.columnGroups().find((group) => colIndex >= group.colStart && colIndex < group.colEnd);
  }
  /** DD-064 K4: (列, y) が 2段の見出しの上の段の、まとまりの名前の上か（まとめていない列は 2 段ぶんが列の見出し）。 */
  function isGroupBandHit(colIndex: number, y: number): boolean {
    return deps.groupBandHeight > 0 && y < deps.groupBandHeight && columnGroupAt(colIndex) !== undefined;
  }

  function resizeHit(transform: ViewportTransform, x: number, y: number): ResizeTarget | null {
    const sync = deps.backend();
    if (sync === undefined) {
      return null;
    }
    const target = resizeHitTest(transform, x, y, {
      headerWidth: HEADER_WIDTH,
      headerHeight: deps.headerHeight,
      rowCount: sync.view.rowAxis.count(),
      colCount: sync.view.colAxis.count(),
    });
    // DD-064 K4: 上の段では、まとまりの中の列の境界（列 index とその右の列が同じまとまり）では列幅を変えない
    // （境界の線が描かれていない所で掴めないように）。まとまりの端の境界・下の段は従来どおり。
    if (target !== null && target.axis === 'column' && deps.groupBandHeight > 0 && y < deps.groupBandHeight) {
      const group = columnGroupAt(target.index);
      if (group !== undefined && target.index + 1 < group.colEnd) {
        return null;
      }
    }
    return target;
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
    const sync = deps.backend();
    if (sync === undefined) {
      return;
    }
    if (emitLayout) {
      // 列幅変更の確定で、wrap 列の折り返し行数が変わりうる → 自動行高を一括再計算する（D5 トリガー③）。
      // ドラッグ中（live）は再計算せず確定時のみ（batch を毎 move 走らせない・perf）。
      if (deps.wrapEnabled && drag.axis === 'column') {
        sync.view.recomputeAllAutoRowHeights();
        deps.syncSpacer();
      }
      deps.emit({
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
      deps.syncSpacer();
    }
  }

  /**
   * ダブルクリック auto-fit（DD-027-3・C級・AC6/AC7）。対象列の非空セルを走査し、text-cache 最大幅＋列ヘッダー
   * ラベル幅から clamp 内の列幅を求めて setColumnWidth → layout イベント発火（DD-012-4 D2 の保存契約を維持）。
   * **wrap 列は対象外**（折り返し前提の列に内容 fit は無意味＝診断 info・無変更）。走査は 10,000 非空セルで打ち切り
   * （それまでの最大値を採用＋診断 info・50k 行列の単発操作でも予算内）。バッジ指定値はチップ幅で見積もる。
   */
  function performAutoFitColumn(colIndex: number): void {
    const backend = deps.backend();
    if (backend === undefined) {
      return;
    }
    const columnId = backend.view.columnIdAt(colIndex);
    if (columnId === undefined) {
      return;
    }
    if (deps.wrapColumnStrings.has(String(columnId))) {
      diag.emit('info', 'auto-fit-skip-wrap', `auto-fit: wrap 列 ${String(columnId)} は対象外（無変更・DD-027-3）`);
      return;
    }
    const rowCount = backend.view.rowAxis.count();
    // 非空セル値を **AUTO_FIT_MAX_SCAN+1 件まで**収集して打ち切る（visitor が false を返すと queryRange が中断＝
    // 50k 行列でも定数コスト・予算保護・Fable P2）。measure と truncated 判定は純関数 computeAutoFitContentWidth が担う。
    const values: string[] = [];
    const currentMerges = merges.current();
    backend.view.store.queryRange(0, rowCount, colIndex, colIndex + 1, (row, col, value) => {
      // DD-064: 結合範囲の左上以外（描かない値）と、2 列以上にまたがる結合の値（この列 1 本の幅で測る意味が無い）は測らない。
      const merge = currentMerges.size > 0 ? currentMerges.at(row, col) : undefined;
      if (merge !== undefined && (merge.rowStart !== row || merge.colStart !== col || merge.colEnd - merge.colStart > 1)) {
        return;
      }
      values.push(value);
      if (values.length > AUTO_FIT_MAX_SCAN) {
        return false; // 打ち切り判定に十分な件数を確保したら即中断
      }
    });
    const display = deps.display();
    const formats = deps.formats();
    const appearance = deps.appearance();
    const scan = computeAutoFitContentWidth(
      values,
      // DD-033-2: 内容幅は **display**（描画テキスト）で測る（描画と測定の一致・DD-027-3 Fable P3 の教訓踏襲）。
      // 判定（バッジ match）は raw のまま。書式のない列は formatText が raw を返すため現行と一致（AC9）。
      // DD-059: 括弧表記の列の正の数と 0 は描画で右に `)` 1文字分をあける＝その幅も足す（バッジは余白なしで描く）。
      (value) => {
        const id = String(columnId);
        const width = deps.cellTextCache.measureWidth(display?.formatText(id, value) ?? value, appearance.fontFor(id));
        const pad = display?.decorationFor(id, value)?.trailingPad;
        if (pad === undefined || formats?.getStyle(id, value)?.badge === true) {
          return width;
        }
        return width + deps.cellTextCache.measureWidth(pad, appearance.fontFor(id));
      },
      // バッジ指定値は丸角チップ幅（テキスト＋左右パディング）で見積もる（描画の drawBadgeCell と整合）。match は raw。
      (value) => (formats?.getStyle(String(columnId), value)?.badge === true ? BADGE_TEXT_PADDING * 2 : 0),
      AUTO_FIT_MAX_SCAN,
    );
    const width = autoFitColumnWidth({
      maxContentWidth: scan.maxContentWidth,
      // DD-033-2: ヘッダー幅はキャプション（指定時）で測る（未指定は列記号 A/B/…）。base-layer と同じ headerFont・描画と一致。
      headerLabelWidth: deps.cellTextCache.measureWidth(
        display?.captionFor(String(columnId)) ?? columnLabel(colIndex),
        appearance.headerFont,
      ),
      padding: CELL_TEXT_PADDING * 2,
    });
    backend.view.setColumnWidth(columnId, width);
    // 列幅変更で wrap 列の折り返し行数が変わりうる（他の wrap 列は本列に依存しないが finishResize と同経路で保守的に再計算）。
    if (deps.wrapEnabled) {
      backend.view.recomputeAllAutoRowHeights();
    }
    deps.syncSpacer();
    // DD-012-4 D2: override のみを含む layout を発火（利用側保存契約を維持＝F5 復元に載る）。
    deps.emit({
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

  // ---- pointermove（リサイズのドラッグ・範囲選択のドラッグ・ホバーとカーソル）----
  /** リサイズのドラッグ中: 新サイズを Axis へ反映する（markViewportDirty → rAF でライブ再描画）。editor へは流さない（D5）。 */
  function moveResize(sync: GridBackend, drag: ResizeDrag, event: PointerEvent, x: number, y: number): void {
    if (event.pointerId !== drag.pointerId) {
      return; // active pointer 以外の move は無視（マルチタッチでの誤リサイズ防止・Codex[P2]）
    }
    // 対象の左端/上端は現在 transform から毎回再解決する（scroll・構造Op に追従・Codex[P2]）。
    const transform = deps.currentTransform();
    if (transform === undefined) {
      return;
    }
    if (drag.axis === 'column') {
      const idx = sync.view.colIndexOf(drag.columnId);
      if (idx < 0) {
        return; // 対象列が消えた（防御）
      }
      const edge = transform.columnHeaderRect(idx).x;
      sync.view.setColumnWidth(drag.columnId, computeResizeSize('column', x, edge));
    } else {
      const idx = sync.view.rowIndexOf(drag.rowId);
      if (idx < 0) {
        return;
      }
      const edge = transform.rowHeaderRect(idx).y;
      sync.view.setRowHeight(drag.rowId, computeResizeSize('row', y, edge));
    }
    deps.syncSpacer(); // 総サイズが変わる → spacer を同期（末尾までスクロール可能に・Codex[P1]）
  }

  /** 範囲選択のドラッグ中: セル領域のときだけ focus を更新する（ヘッダー上・viewport 外は直近セルを保持）。 */
  function moveSelection(sync: GridBackend, drag: { readonly pointerId: number }, event: PointerEvent, x: number, y: number): void {
    if (event.pointerId !== drag.pointerId) {
      return; // active pointer 以外の move は無視（マルチタッチでの誤更新防止）
    }
    const transform = deps.currentTransform();
    if (transform === undefined) {
      return;
    }
    // viewport 外は直近 focus を保持する（autoscroll 対象外=既定案・Codex[P1]）。pointer capture 中は
    // 外へ出ても move が届き、hitTest は右/下端の**外側**も Axis 上のセルへ解決してしまうため、
    // 境界内のときだけ hit を解決する（不可視セルへ範囲が伸び、Delete で画面外の値を消す事故を防ぐ）。
    const viewport = deps.viewportSize();
    const inViewport = x >= 0 && y >= 0 && x < viewport.width && y < viewport.height;
    const hit = inViewport ? transform.hitTest(x, y) : null;
    // DD-064: 候補（リンク・検索付き候補）は結合の左上で持つので、ポインタのセルも左上へ寄せて比べる（範囲の中の移動は
    // 別のセルへの移動と見なさない）。
    const hitCell = hit?.area === 'cell' ? mergeAnchorOf(merges.current(), { row: hit.rowIndex, col: hit.colIndex }) : null;
    // DD-027-2[Fable P1]: ドラッグで pointer が開始セルの外（別セル・ヘッダー・viewport 外）へ動いたらリンク候補を破棄する（AC3）。
    link.dropIfLeft(hitCell);
    if (searchSelectCandidate !== null && (hitCell === null || hitCell.row !== searchSelectCandidate.row || hitCell.col !== searchSelectCandidate.col)) searchSelectCandidate = null;
    if (hit !== null && hit.area === 'cell') {
      selectionCtrl.updateDrag({ row: hit.rowIndex, col: hit.colIndex });
      sync.view.markViewportDirty();
    }
  }

  /** 非ドラッグ: セル領域はホバー通知とリンク列の cursor、見出しの境界の上でだけ resize カーソル。 */
  function hoverAndCursor(x: number, y: number): void {
    if (x >= HEADER_WIDTH && y >= deps.headerHeight) {
      const hasLinkColumns = deps.registry()?.hasAnyLinkColumn() === true;
      // RC6（DD-052-5）: セルホバー通知。既存の link 列 cursor 判定と hitTest を共有する（二重計算しない）。
      const transformForHover = deps.currentTransform();
      const hoverHit = transformForHover?.hitTest(x, y);
      hover.update(hoverHit?.area === 'cell' ? hoverHit : null);
      // DD-027-2: リンク列が 1 つでもあるときだけ列単位で cursor:pointer 判定（無ければ cheap path 不変・予算保護・AC9）。
      if (hasLinkColumns) {
        const desired = hoverHit !== undefined && hoverHit.area === 'cell' && link.isLinkColumnIndex(hoverHit.colIndex) ? 'pointer' : '';
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
    hover.update(null); // RC6: ヘッダー/コーナー領域はホバー対象外
    const transform = deps.currentTransform();
    if (transform === undefined) {
      return;
    }
    const rz = resizeHit(transform, x, y);
    scroller.style.cursor = rz === null ? '' : rz.axis === 'column' ? 'col-resize' : 'row-resize';
  }

  scroller.addEventListener(
    'pointermove',
    (event) => {
      const sync = deps.backend();
      if (sync === undefined) {
        return;
      }
      const { x, y } = stageLocal(event);
      if (resizeDrag !== null) {
        moveResize(sync, resizeDrag, event, x, y);
        return;
      }
      if (selectionDrag !== null) {
        moveSelection(sync, selectionDrag, event, x, y);
        return;
      }
      hoverAndCursor(x, y);
    },
    { signal },
  );

  // RC6（DD-052-5）: ポインタがグリッド外へ出たらホバーを終了する（出しっぱなしを防ぐ）。
  scroller.addEventListener('pointerleave', () => hover.update(null), { signal });

  scroller.addEventListener(
    'pointerup',
    (event) => {
      const candidate = searchSelectCandidate;
      const point = stageLocal(event);
      const hit = deps.currentTransform()?.hitTest(point.x, point.y);
      // DD-064: 候補は結合の左上で持つ（ポインタのセルも左上へ寄せて比べる）。
      const upCell = hit?.area === 'cell' ? mergeAnchorOf(merges.current(), { row: hit.rowIndex, col: hit.colIndex }) : undefined;
      const openSearch = candidate?.pointerId === event.pointerId && upCell !== undefined
        && upCell.row === candidate.row && upCell.col === candidate.col;
      finishResize(event.pointerId, true);
      finishSelectionDrag(event.pointerId, true);
      if (openSearch) select.open();
      // DD-027-2: 選択ドラッグ確定の直後に、リンク候補が生きていれば link-open を発火する（同一セルクリック＝📐）。
      link.fire(event.pointerId);
    },
    { signal },
  );
  scroller.addEventListener(
    'pointercancel',
    (event) => {
      finishResize(event.pointerId, false);
      finishSelectionDrag(event.pointerId, false);
      link.discard(event.pointerId); // DD-027-2: 取消はリンク候補も破棄（発火しない）
    },
    { signal },
  );
  scroller.addEventListener(
    'lostpointercapture',
    (event) => {
      finishResize(event.pointerId, false);
      finishSelectionDrag(event.pointerId, false);
      link.discard(event.pointerId); // DD-027-2: capture 喪失はリンク候補も破棄
    },
    { signal },
  );

  // ---- pointerdown（ポップアップの取消・見出しの境界のリサイズ・見出しのクリック・セルの選択とドラッグの開始）----
  /**
   * DD-027-1: 選択式ドロップダウン表示中の外クリック（候補は自前 pointerdown で処理済み＝ここへ来ない）は
   * 取消（文書無変更・focus は textarea のまま・AC3）。続けて通常のセル選択も行う（Excel 風）。
   * Fable P3: この dismiss クリックがリンクセルに当たっても link-open は発火させない（ポップアップの打ち消しと
   * リンク起動を1クリックで兼ねさせない）。close する前に open 状態を捕捉し、後段の候補武装を抑止する。
   * DD-035 R2: 日付カレンダー表示中の外クリックも取消（日クリックはポップオーバー側の pointerdown で処理済み＝ここへ来ない）。
   */
  function dismissPopups(): { readonly selectWasOpen: boolean; readonly dateWasOpen: boolean } {
    const selectWasOpen = select.isOpen();
    if (selectWasOpen) {
      select.close();
    }
    const dateWasOpen = date.isOpen();
    if (dateWasOpen) {
      date.close();
    }
    return { selectWasOpen, dateWasOpen };
  }

  /** ヘッダー境界のリサイズを先取りする（editor へイベントを流さない＝D5・IME 不変）。境界の上なら true。 */
  function beginResize(sync: GridBackend, transform: ViewportTransform, event: PointerEvent, x: number, y: number): boolean {
    const rz = resizeHit(transform, x, y);
    if (rz === null) {
      return false;
    }
    event.preventDefault();
    if (rz.axis === 'column') {
      const columnId = sync.view.columnIdAt(rz.index);
      if (columnId === undefined) {
        return true;
      }
      resizeDrag = { axis: 'column', columnId, pointerId: event.pointerId, originalSize: sync.view.colAxis.size(rz.index) };
    } else {
      const rowId = sync.view.rowIdAt(rz.index);
      if (rowId === undefined) {
        return true;
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
    return true;
  }

  /** セルの外（見出し・コーナー）の pointerdown。 */
  function pointerdownOutsideCells(sync: GridBackend, editor: IntegrationEditor, hit: Hit, y: number): void {
    // RC5（DD-052-5）: 列見出しのクリック通知（並べ替えは行わない・行番号ヘッダー/コーナーは対象外）。
    // DD-064 K4: 2段の見出しの上の段（まとまりの名前）のクリックは通知しない（列の見出しではない）。
    if (hit.area === 'column-header' && !isGroupBandHit(hit.colIndex, y)) {
      const columnId = sync.view.columnIdAt(hit.colIndex);
      if (columnId !== undefined) {
        deps.emit({ type: 'header-click', columnId: String(columnId) });
      }
    }
    editor.pointerdownCell(null);
  }

  /** セルの pointerdown（Shift+クリックの範囲拡張・アクティブセルの移動・ドラッグ選択の開始・リンク候補の武装）。 */
  function pointerdownCell(
    sync: GridBackend,
    editor: IntegrationEditor,
    event: PointerEvent,
    hit: Hit,
    dismissed: { readonly selectWasOpen: boolean; readonly dateWasOpen: boolean },
  ): void {
    // 常駐 textarea をキーボード入力の受け口として保持する。scroller は非フォーカサブルなため、
    // mousedown 既定挙動が focus を body へ奪い、直後の pointerdownCell の textarea.focus() を打ち消す。
    // これを止めないとクリック後の矢印キーが scroller のネイティブスクロールへ流れ、カレントセルが動かない。
    event.preventDefault();
    const hitCell = { row: hit.rowIndex, col: hit.colIndex };
    // DD-064: 結合範囲の中のクリックは左上のセルとして扱う（アクティブセル・ドラッグの起点・リンク候補）。
    const cell = mergeAnchorOf(merges.current(), hitCell);
    // Shift+クリック（Navigation・非 composition 限定）: anchor=activeCell 固定でレンジ拡張（DD-020-1 AC2）。
    // activeCell は動かさない（editor.pointerdownCell を呼ばない）。編集中/変換中は前段消費せず従来経路
    // （確定して移動 / pendingNavigation）のまま＝IME・編集の挙動保存（案X）。
    if (event.shiftKey && !editor.session.isComposing() && editor.session.getPhase() === 'Navigation') {
      // DD-064: 範囲は selection-controller が結合を含むまで広げる（焦点はクリックしたセルのまま）。
      selectionCtrl.extendTo(editor.session.getActiveCell(), hitCell);
      editor.focus(); // 入力受け口（常駐 textarea）を保持（以降の Shift+矢印を受けられるように）
      sync.view.markViewportDirty();
      return;
    }
    // DD-027-2: リンク候補の武装判定は pointerdownCell を呼ぶ前の位相で行う（編集中クリックは従来経路＝発火なし・AC8）。
    // Fable P3: 選択式ドロップダウンの dismiss クリック（selectWasOpen）はリンク武装しない。
    const linkArm = dismissed.selectWasOpen || dismissed.dateWasOpen ? null : link.computeArm(cell, event);
    // 通常クリック: 明示レンジを解除（同一セル再クリックでも単一選択へ戻す・AC4）→ activeCell 移動。
    selectionCtrl.clear();
    editor.pointerdownCell(cell);
    // pointerdownCell 処理後に Navigation なら（元から Navigation / 編集は確定済み）ドラッグ選択を開始する。
    // composition 中は開始しない（クリックは pendingNavigation 経路のまま・composition を乱さない・AC7）。
    if (!editor.session.isComposing() && editor.session.getPhase() === 'Navigation') {
      searchSelectCandidate = !dismissed.selectWasOpen && !dismissed.dateWasOpen && !event.ctrlKey && !event.metaKey && !event.altKey
        && select.isSearchableSelectColumnIndex(cell.col)
        ? { pointerId: event.pointerId, row: cell.row, col: cell.col } : null;
      selectionDrag = { pointerId: event.pointerId };
      selectionCtrl.beginDrag(cell);
      scroller.setPointerCapture(event.pointerId);
      // RC6（DD-052-5・Codex P2）: 範囲選択ドラッグ中は pointermove 中の hover 更新を呼ばない分岐へ入るため、
      // ドラッグ開始時点で明示的にホバーを終了させる（consumer のツールチップが開始セルに残り続けるのを防ぐ）。
      hover.update(null);
    }
    // 候補は既存処理の後に記録する（既存経路は無変更のまま上乗せ・pointerup で発火）。編集中クリックは linkArm=null。
    link.setCandidate(linkArm);
    sync.view.markViewportDirty();
  }

  scroller.addEventListener(
    'pointerdown',
    (event) => {
      const sync = deps.backend();
      const editor = deps.editor();
      if (event.button !== 0 || sync === undefined || editor === undefined) {
        return;
      }
      if (resizeDrag !== null || selectionDrag !== null) {
        return; // ドラッグ中の追加 pointerdown は無視（capture 漏れ・状態上書き防止・Codex[P2]）
      }
      const dismissed = dismissPopups();
      const transform = deps.currentTransform();
      if (transform === undefined) {
        return;
      }
      const { x, y } = stageLocal(event);
      if (beginResize(sync, transform, event, x, y)) {
        return;
      }
      const hit = transform.hitTest(x, y);
      if (hit.area !== 'cell') {
        pointerdownOutsideCells(sync, editor, hit, y);
        return;
      }
      pointerdownCell(sync, editor, event, hit, dismissed);
    },
    { signal },
  );

  scroller.addEventListener(
    'dblclick',
    (event) => {
      const sync = deps.backend();
      const editor = deps.editor();
      if (sync === undefined || editor === undefined) {
        return;
      }
      const transform = deps.currentTransform();
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
        if (deps.isReadOnly()) {
          diag.emit('info', 'readonly-blocked', 'readOnly: ダブルクリック編集を抑止（閲覧専用）');
          return;
        }
        // DD-035 R4: readOnly 列のセルは編集 UI（textarea・ドロップダウン・カレンダー）を一切開かない（入口抑止）。
        if (cellLock.isReadOnlyRowIndex(hit.rowIndex)) {
          diag.emit('info', 'readonly-row-blocked', `readOnlyRows: 行 ${String(sync.view.rowIdAt(hit.rowIndex))} のダブルクリック編集を抑止`);
          return;
        }
        if (cellLock.isReadOnlyColumnIndex(hit.colIndex)) {
          diag.emit('info', 'readonly-column-blocked', `readOnlyColumns: 列 ${String(sync.view.columnIdAt(hit.colIndex))} のダブルクリック編集を抑止`);
          return;
        }
        // RC3（DD-052-3・Codex P2）: 行データ指定のセル単位 readOnly も同じ入口抑止に含める（列/行版のみ判定
        // していたため、行データで readOnly にしたセルを dblclick で開けてしまっていた）。
        if (cellLock.isReadOnlyCellIndex(hit.rowIndex, hit.colIndex)) {
          diag.emit('info', 'readonly-cell-blocked', `readOnlyColumns（行データ指定）: セル row=${String(sync.view.rowIdAt(hit.rowIndex))} col=${String(sync.view.columnIdAt(hit.colIndex))} のダブルクリック編集を抑止`);
          return;
        }
        // DD-064: 結合範囲は読むだけ（K3）。編集 UI（textarea・候補欄・カレンダー）を開かない。
        if (merges.isMergedCellIndex(hit.rowIndex, hit.colIndex)) {
          const anchor = mergeAnchorOf(merges.current(), { row: hit.rowIndex, col: hit.colIndex });
          diag.emit('info', 'merged-cell-blocked', `mergedCells: 結合範囲（左上 row=${String(sync.view.rowIdAt(anchor.row))} col=${String(sync.view.columnIdAt(anchor.col))}）のダブルクリック編集を抑止`);
          return;
        }
        // DD-027-1 / DD-037: 選択式列は textarea 編集ではなくドロップダウンを開く（AC1）。自由入力併存列
        // （allowFreeText:true）も対象＝候補は明示操作で開き、自由入力は印字文字から始める（DD-037 決定①）。
        // 先に activeCell を対象セルへ合わせてから開く（select.open は activeCell を読む）。
        if (select.isSelectColumnIndex(hit.colIndex)) {
          editor.pointerdownCell({ row: hit.rowIndex, col: hit.colIndex });
          select.open();
          return;
        }
        // DD-035 R2: 日付列（openOn='dblclick'）は textarea 編集ではなくカレンダーを開く。openOn='icon' は従来どおり。
        if (date.isDblclickDateColumnIndex(hit.colIndex)) {
          editor.pointerdownCell({ row: hit.rowIndex, col: hit.colIndex });
          date.open();
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
      deps.backend()?.view.markViewportDirty();
    },
    { signal },
  );
}
