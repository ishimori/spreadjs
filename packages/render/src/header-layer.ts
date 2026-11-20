// 見出しの描画（列記号・列見出しのキャプション・2 段の見出しの上の段・行番号・左上のコーナー）と見出しの印（DD-070-6）。
// DD-070-6 で base-layer.ts から移した（中身は従来どおり。base-layer.ts はサイズのガードの超過を増やせないため）。
// 印（並べ替えの三角・絞り込みのボタン・まとまりの開閉）の配置は純粋関数で決め、grid の当たり判定も同じ関数を使う
// （描いた所と押せる所を食い違わせない）。印を指定しない列・まとまりは従来と同一の描画になる。

import { deviceLineWidth, snapToDevice } from './dpi';
import type { TextMetricsCache } from './text-cache';
import type { CellRect, PaneId, PaneRange } from './viewport';
import type { BaseLayerColors, ColumnGroupBand, ColumnGroupSpan, FrameViewport } from './base-layer';

/** 列の見出しの印（DD-070-6）。`sort` は並べ替えの向き、`filter` は絞り込みのボタン（available＝押せる・active＝絞り込み中）。 */
export interface ColumnHeaderMark {
  readonly sort?: 'asc' | 'desc';
  readonly filter?: 'available' | 'active';
}

/** 列のまとまり（2 段の見出しの上の段）の印（DD-070-6）。`collapsed` で ▸（閉じている）／▾（開いている）を描く。 */
export interface ColumnGroupMark {
  readonly collapsed: boolean;
}

/** 列 index → A, B, ..., Z, AA, ... の列記号（DD-027-3・auto-fit のヘッダー幅測定と実描画で共有＝Fable P3）。 */
export function columnLabel(col: number): string {
  let n = col;
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/** 印の大きさ（CSS px）。 */
const FILTER_BUTTON_SIZE = 14;
const SORT_MARK_WIDTH = 8;
const SORT_MARK_HEIGHT = 5;
const GROUP_MARK_SIZE = 8;
const MARK_GAP = 3;
/** 絞り込み中のボタンの塗り（固定色）。 */
const FILTER_ACTIVE_FILL = '#1a73e8';
const FILTER_ACTIVE_GLYPH = '#ffffff';

/** 列の見出しの印の配置（DD-070-6）。`label` は名前を描く範囲（中央の x と最大の幅）。 */
export interface ColumnHeaderMarkLayout {
  readonly labelCenterX: number;
  readonly labelMaxWidth: number;
  readonly sort?: CellRect;
  readonly filter?: CellRect;
}

/**
 * 列の見出しの印の配置。`rect` は列の名前を描く段（2 段の見出しでまとめた列は下の段）の矩形、`padding` は左右の余白。
 * 右から絞り込みのボタン、その左に並べ替えの三角。名前は印を除いた幅の中央。印が無ければ従来どおり矩形の中央・全幅。
 */
export function columnHeaderMarkLayout(rect: CellRect, mark: ColumnHeaderMark | undefined, padding: number): ColumnHeaderMarkLayout {
  let right = rect.x + rect.width - padding;
  let filter: CellRect | undefined;
  let sort: CellRect | undefined;
  if (mark?.filter !== undefined) {
    const size = Math.max(0, Math.min(FILTER_BUTTON_SIZE, rect.height - 4));
    filter = { x: right - size, y: rect.y + (rect.height - size) / 2, width: size, height: size };
    right = filter.x - MARK_GAP;
  }
  if (mark?.sort !== undefined) {
    sort = { x: right - SORT_MARK_WIDTH, y: rect.y + (rect.height - SORT_MARK_HEIGHT) / 2, width: SORT_MARK_WIDTH, height: SORT_MARK_HEIGHT };
    right = sort.x - MARK_GAP;
  }
  if (filter === undefined && sort === undefined) {
    return { labelCenterX: rect.x + rect.width / 2, labelMaxWidth: Math.max(0, rect.width - padding * 2) };
  }
  const left = rect.x + padding;
  return {
    labelCenterX: (left + right) / 2,
    labelMaxWidth: Math.max(0, right - left),
    ...(sort !== undefined ? { sort } : {}),
    ...(filter !== undefined ? { filter } : {}),
  };
}

/** まとまりの印の配置（DD-070-6）。`rect` は上の段のまとまりの矩形。開閉の印は名前の左。印が無ければ従来どおり。 */
export function columnGroupMarkLayout(
  rect: CellRect,
  mark: ColumnGroupMark | undefined,
  padding: number,
): { readonly labelCenterX: number; readonly labelMaxWidth: number; readonly toggle?: CellRect } {
  if (mark === undefined) {
    return { labelCenterX: rect.x + rect.width / 2, labelMaxWidth: Math.max(0, rect.width - padding * 2) };
  }
  const toggle = { x: rect.x + padding, y: rect.y + (rect.height - GROUP_MARK_SIZE) / 2, width: GROUP_MARK_SIZE, height: GROUP_MARK_SIZE };
  const left = toggle.x + toggle.width + MARK_GAP;
  const right = rect.x + rect.width - padding;
  return { labelCenterX: (left + right) / 2, labelMaxWidth: Math.max(0, right - left), toggle };
}

export interface HeaderLayerDeps {
  readonly ctx: CanvasRenderingContext2D;
  readonly headerWidth: number;
  readonly headerHeight: number;
  readonly headerFont: string;
  readonly colors: BaseLayerColors;
  readonly textCache: TextMetricsCache;
  /** セル文字の左右の余白（base-layer の CELL_TEXT_PADDING）。 */
  readonly cellPadding: number;
  readonly columnHeaderLabel?: (colIndex: number) => string;
  readonly columnGroupBand?: ColumnGroupBand;
  /** DD-070-6: 列の見出しの印（未指定・undefined の列は従来どおり）。 */
  readonly columnHeaderMark?: (colIndex: number) => ColumnHeaderMark | undefined;
  /** DD-070-6: まとまりの印（columnGroupBand.groups の番号 → 印）。 */
  readonly columnGroupMark?: (groupIndex: number) => ColumnGroupMark | undefined;
}

function findPane(panes: readonly PaneRange[], id: PaneId): PaneRange {
  const found = panes.find((p) => p.pane === id);
  if (found === undefined) {
    throw new Error(`pane ${id} が見つからない`);
  }
  return found;
}

export function createHeaderLayer(deps: HeaderLayerDeps): { draw(frame: FrameViewport): void } {
  const { ctx, headerWidth, headerHeight, headerFont, colors, textCache } = deps;
  const CELL_PADDING = deps.cellPadding;
  const columnHeaderLabelFn = deps.columnHeaderLabel;
  const columnHeaderMarkFn = deps.columnHeaderMark;
  const columnGroupMarkFn = deps.columnGroupMark;

  // DD-039: ヘッダー帯の中を pane 境界で切り分けるための入れ子 clip。帯の clip の内側で呼ぶため
  // 交差＝帯からはみ出さない。幅・高さが 0 以下の側は clip を張らずスキップする（drawPane と同じガード）
  // ＝固定行列が 0 のときスクロール側の矩形は帯 clip と一致し、現行と同一の描画に落ちる。
  const withBandClip = (x: number, y: number, width: number, height: number, draw: () => void): void => {
    if (width <= 0 || height <= 0) {
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    draw();
    ctx.restore();
  };

  // DD-064 K4: 2段の見出し。上の段の高さ（0＝1段）と、列 index → まとまり（列は mount 時に固定＝作成時に引く表を作る）。
  const groupBandHeight =
    deps.columnGroupBand !== undefined && deps.columnGroupBand.groups.length > 0 ? deps.columnGroupBand.height : 0;
  const groupOfColumn = new Map<number, ColumnGroupSpan>();
  for (const group of deps.columnGroupBand?.groups ?? []) {
    for (let col = group.colStart; col < group.colEnd; col += 1) {
      groupOfColumn.set(col, group);
    }
  }

  /** 三角を塗る（DD-070-6）。`dir` は頂点の向き。 */
  const fillTriangle = (box: CellRect, dir: 'up' | 'down' | 'right'): void => {
    ctx.beginPath();
    if (dir === 'up') {
      ctx.moveTo(box.x + box.width / 2, box.y);
      ctx.lineTo(box.x + box.width, box.y + box.height);
      ctx.lineTo(box.x, box.y + box.height);
    } else if (dir === 'down') {
      ctx.moveTo(box.x, box.y);
      ctx.lineTo(box.x + box.width, box.y);
      ctx.lineTo(box.x + box.width / 2, box.y + box.height);
    } else {
      ctx.moveTo(box.x, box.y);
      ctx.lineTo(box.x + box.width, box.y + box.height / 2);
      ctx.lineTo(box.x, box.y + box.height);
    }
    ctx.closePath();
    ctx.fill();
  };

  /** 列の見出しの印を描く（DD-070-6）。fillStyle は呼び出し側で headerText に戻す。 */
  const drawColumnMarks = (layout: ColumnHeaderMarkLayout, mark: ColumnHeaderMark, dpr: number): void => {
    if (layout.sort !== undefined) {
      ctx.fillStyle = colors.headerText;
      fillTriangle(layout.sort, mark.sort === 'asc' ? 'up' : 'down');
    }
    const button = layout.filter;
    if (button !== undefined && button.width > 0) {
      const glyph = { x: button.x + button.width * 0.25, y: button.y + button.height * 0.38, width: button.width * 0.5, height: button.height * 0.3 };
      if (mark.filter === 'active') {
        ctx.fillStyle = FILTER_ACTIVE_FILL;
        ctx.fillRect(button.x, button.y, button.width, button.height);
        ctx.fillStyle = FILTER_ACTIVE_GLYPH;
      } else {
        ctx.strokeStyle = colors.headerText;
        ctx.lineWidth = deviceLineWidth(dpr);
        ctx.strokeRect(snapToDevice(button.x, dpr), snapToDevice(button.y, dpr), button.width, button.height);
        ctx.fillStyle = colors.headerText;
      }
      fillTriangle(glyph, 'down');
    }
    ctx.fillStyle = colors.headerText;
  };

  return {
    draw(frame) {
      const { transform, viewportWidth, dpr } = frame;
      const panes = transform.panes();
      const body = findPane(panes, 'body');
      const corner = findPane(panes, 'corner');

      // 列記号ヘッダー（上帯）。
      ctx.save();
      ctx.beginPath();
      ctx.rect(headerWidth, 0, Math.max(0, viewportWidth - headerWidth), headerHeight);
      ctx.clip();
      ctx.fillStyle = colors.headerBackground;
      ctx.fillRect(headerWidth, 0, viewportWidth, headerHeight);
      ctx.fillStyle = colors.headerText;
      ctx.font = headerFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const drawColHeader = (col: number): void => {
        const rect = transform.columnHeaderRect(col);
        // DD-064 K4: まとめた列は下の段の中央、まとめていない列は 2 段ぶんの中央（1 段なら従来どおり見出しの中央）。
        const grouped = groupBandHeight > 0 && groupOfColumn.has(col);
        const labelY = grouped ? groupBandHeight + (headerHeight - groupBandHeight) / 2 : headerHeight / 2;
        // DD-070-6: 印のある列は、名前を印を除いた幅の中央に置き、印を右端に描く（印の無い列は従来と同一）。
        const mark = columnHeaderMarkFn?.(col);
        if (mark !== undefined && (mark.sort !== undefined || mark.filter !== undefined)) {
          const top = grouped ? groupBandHeight : 0;
          const layout = columnHeaderMarkLayout({ x: rect.x, y: top, width: rect.width, height: headerHeight - top }, mark, CELL_PADDING);
          const label = columnHeaderLabelFn === undefined ? columnLabel(col) : columnHeaderLabelFn(col);
          const text = textCache.fitText(label, headerFont, layout.labelMaxWidth);
          ctx.font = headerFont;
          ctx.fillText(text, layout.labelCenterX, labelY);
          drawColumnMarks(layout, mark, dpr);
          return;
        }
        // DD-033-2: キャプションフック未指定なら現行どおり列記号を素描画する（既存 consumer と完全一致・AC9）。
        if (columnHeaderLabelFn === undefined) {
          ctx.fillText(columnLabel(col), rect.x + rect.width / 2, labelY);
          return;
        }
        // キャプションは自ヘッダーセル幅で fitText クリップ（長い業務名が隣接ヘッダーへ重ならない・AC2）。中央寄せは維持。
        const label = columnHeaderLabelFn(col);
        const text = textCache.fitText(label, headerFont, Math.max(0, rect.width - CELL_PADDING * 2));
        ctx.font = headerFont; // fitText の measure コールバックが ctx.font を触るため描画前に復帰させる。
        ctx.fillText(text, rect.x + rect.width / 2, labelY);
      };
      /**
       * DD-064 K4: 帯（固定列・スクロール列のどちらか）の列範囲に交わるまとまりの名前と区切りの線を描く。まとまりは
       * 固定列の境界をまたがない（grid が保証）ので、帯の clip の中に収まる。名前はまとまりの幅の中央（範囲と一緒に動く）。
       */
      const drawColumnGroups = (colStart: number, colEnd: number): void => {
        if (groupBandHeight <= 0 || colEnd <= colStart) {
          return;
        }
        (deps.columnGroupBand?.groups ?? []).forEach((group, groupIndex) => {
          if (group.colEnd <= colStart || group.colStart >= colEnd) {
            return;
          }
          const first = transform.columnHeaderRect(group.colStart);
          const last = transform.columnHeaderRect(group.colEnd - 1);
          const x = first.x;
          const width = last.x + last.width - first.x;
          // DD-070-6: 印のあるまとまりは名前の左に ▾／▸ を描き、名前は残りの幅の中央（印が無ければ従来どおり）。
          const groupMark = columnGroupMarkFn?.(groupIndex);
          const layout = columnGroupMarkLayout({ x, y: 0, width, height: groupBandHeight }, groupMark, CELL_PADDING);
          const text = textCache.fitText(group.caption, headerFont, layout.labelMaxWidth);
          ctx.font = headerFont;
          ctx.fillStyle = colors.headerText;
          ctx.fillText(text, layout.labelCenterX, groupBandHeight / 2);
          if (layout.toggle !== undefined && groupMark !== undefined) {
            fillTriangle(layout.toggle, groupMark.collapsed ? 'right' : 'down');
          }
          // 区切り: まとまりの下（上の段と下の段の間）と、まとまりの左右（上の段だけ）。
          ctx.strokeStyle = colors.gridLine;
          ctx.lineWidth = deviceLineWidth(dpr);
          ctx.beginPath();
          const y = snapToDevice(groupBandHeight, dpr);
          ctx.moveTo(x, y);
          ctx.lineTo(x + width, y);
          for (const edge of [x, x + width]) {
            const ex = snapToDevice(edge, dpr);
            ctx.moveTo(ex, 0);
            ctx.lineTo(ex, groupBandHeight);
          }
          ctx.stroke();
        });
      };
      const drawScrollColHeaders = (): void => {
        for (let col = body.cols.start; col < body.cols.end; col += 1) {
          drawColHeader(col);
        }
        drawColumnGroups(body.cols.start, body.cols.end);
      };
      // DD-039: 固定列の見出しとスクロール列の見出しを pane 境界で切り分ける。scrollColRange() は
      // 固定境界に半分かかる列と overscan 分の列を含むため、単一 clip だとそれらが固定帯の内側へ描かれる。
      const frozenW = transform.frozenWidth();
      if (frozenW <= 0) {
        // 固定列なし＝スクロール側の矩形が帯 clip と一致するので入れ子を張らない（現行と同一の描画）。
        drawScrollColHeaders();
      } else {
        withBandClip(headerWidth, 0, frozenW, headerHeight, () => {
          for (let col = corner.cols.start; col < corner.cols.end; col += 1) {
            drawColHeader(col);
          }
          drawColumnGroups(corner.cols.start, corner.cols.end);
        });
        withBandClip(headerWidth + frozenW, 0, viewportWidth - headerWidth - frozenW, headerHeight, drawScrollColHeaders);
      }
      ctx.restore();

      // 行番号ヘッダー（左帯）。
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, headerHeight, headerWidth, Math.max(0, frame.viewportHeight - headerHeight));
      ctx.clip();
      ctx.fillStyle = colors.headerBackground;
      ctx.fillRect(0, headerHeight, headerWidth, frame.viewportHeight);
      ctx.fillStyle = colors.headerText;
      ctx.font = headerFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const drawRowHeader = (row: number): void => {
        const rect = transform.rowHeaderRect(row);
        ctx.fillText(String(row + 1), headerWidth / 2, rect.y + rect.height / 2);
      };
      const drawScrollRowHeaders = (): void => {
        for (let row = body.rows.start; row < body.rows.end; row += 1) {
          drawRowHeader(row);
        }
      };
      // DD-039: 行番号も同型（固定行の番号にスクロール行の番号が重なるのを pane 境界で止める）。
      const frozenH = transform.frozenHeight();
      if (frozenH <= 0) {
        drawScrollRowHeaders();
      } else {
        withBandClip(0, headerHeight, headerWidth, frozenH, () => {
          for (let row = corner.rows.start; row < corner.rows.end; row += 1) {
            drawRowHeader(row);
          }
        });
        withBandClip(0, headerHeight + frozenH, headerWidth, frame.viewportHeight - headerHeight - frozenH, drawScrollRowHeaders);
      }
      ctx.restore();

      // 左上コーナー。
      ctx.fillStyle = colors.headerBackground;
      ctx.fillRect(0, 0, headerWidth, headerHeight);
      // ヘッダー境界線（device snap）。
      ctx.strokeStyle = colors.gridLine;
      ctx.lineWidth = deviceLineWidth(dpr);
      ctx.beginPath();
      const hx = snapToDevice(headerWidth, dpr);
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, frame.viewportHeight);
      ctx.stroke();
    },
  };
}
