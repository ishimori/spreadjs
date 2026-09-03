// DD-039 unit: ヘッダー帯（列記号・行番号）を pane 境界で clip する契約。
//
// 症状は「固定ペインの見出しに、固定帯の裏へ回ったスクロール側の見出しが重なって描かれる」。
// Canvas の実描画は目視できないため、ctx を「clip 矩形と fillText の座標を記録するスタブ」に差し替え、
// **各 fillText がどの clip の内側で呼ばれたか**（＝実際に塗られうる範囲）を検証する。
//
// テストが意味を持つ条件（＝修正前なら落ちること）も同時に固定する: シナリオには
// 「viewport X が固定帯の内側に落ちるスクロール列/行」が必ず存在することを assert している。
// 修正前はそれが固定帯と同じ単一 clip の中で描かれていた。

import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId, type ColumnId, type RowId } from '@nanairo-sheet/types';

import { createAxis } from './axis';
import { createBaseLayer, columnLabel } from './base-layer';
import { createChunkStore } from './chunk-store';
import { createViewportTransform } from './viewport';

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** fillText 1 回分の記録（描画時に有効だった最内 clip 付き）。 */
interface TextCall {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  /** その時点で有効だった最内 clip（未 clip なら null）。 */
  readonly clip: Rect | null;
}

/**
 * clip の入れ子を追跡する ctx スタブ。save/restore で clip スタックを出し入れし、
 * fillText には「その時点の最内 clip」を紐づけて記録する。
 */
function createCtxStub(): {
  ctx: CanvasRenderingContext2D;
  texts: TextCall[];
  clips: Rect[];
} {
  const texts: TextCall[] = [];
  const clips: Rect[] = [];
  /** save/restore の各段で「その段までに有効な最内 clip」を積む。 */
  const stack: (Rect | null)[] = [null];
  let pending: Rect | null = null;
  const current = (): Rect | null => stack[stack.length - 1] ?? null;
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save() {
      stack.push(current());
    },
    restore() {
      if (stack.length > 1) {
        stack.pop();
      }
    },
    beginPath() {
      pending = null;
    },
    closePath: () => {},
    rect(x: number, y: number, w: number, h: number) {
      pending = { x, y, w, h };
    },
    clip() {
      if (pending !== null) {
        clips.push(pending);
        stack[stack.length - 1] = pending;
      }
    },
    moveTo: () => {},
    lineTo: () => {},
    arcTo: () => {},
    fill: () => {},
    stroke: () => {},
    clearRect: () => {},
    fillRect: () => {},
    measureText: (text: string) => ({ width: text.length * 7 }),
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, clip: current() });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, clips };
}

const HEADER_W = 52;
const HEADER_H = 24;
const ROW_H = 22;
const COL_W = 80;
const VIEW_W = 600;
const VIEW_H = 300;
const ROW_COUNT = 60;
const COL_COUNT = 30;

function setup(options: {
  frozenColCount: number;
  frozenRowCount: number;
  scrollLeft: number;
  scrollTop: number;
  /** overscan を入れると固定境界の外側の列/行も body 範囲へ入る（漏れの主因のひとつ）。 */
  overscan?: number;
}): { texts: TextCall[]; clips: Rect[]; frozenWidth: number; frozenHeight: number } {
  const { ctx, texts, clips } = createCtxStub();
  const store = createChunkStore();
  const rowAxis = createAxis<RowId>({
    ids: Array.from({ length: ROW_COUNT }, (_v, i) => createRowId(`r${i}`)),
    defaultSize: ROW_H,
  });
  const colAxis = createAxis<ColumnId>({
    ids: Array.from({ length: COL_COUNT }, (_v, i) => createColumnId(`c${i}`)),
    defaultSize: COL_W,
  });
  const layer = createBaseLayer({
    ctx,
    store,
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    frozenColCount: options.frozenColCount,
  });
  const overscan = options.overscan ?? 0;
  const transform = createViewportTransform({
    rowAxis,
    colAxis,
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    frozenRowCount: options.frozenRowCount,
    frozenColCount: options.frozenColCount,
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    scrollLeft: options.scrollLeft,
    scrollTop: options.scrollTop,
    overscanX: overscan,
    overscanY: overscan,
  });
  layer.draw({ transform, viewportWidth: VIEW_W, viewportHeight: VIEW_H, dpr: 1 });
  return {
    texts,
    clips,
    frozenWidth: transform.frozenWidth(),
    frozenHeight: transform.frozenHeight(),
  };
}

/** 列記号ヘッダーの描画（y=ヘッダー帯の中央・テキストが列記号）。 */
const isColHeader = (t: TextCall): boolean => t.y === HEADER_H / 2;
/** 行番号ヘッダーの描画（x=行番号帯の中央）。 */
const isRowHeader = (t: TextCall): boolean => t.x === HEADER_W / 2;

describe('DD-039: ヘッダー帯の pane clip', () => {
  it('固定列の見出しの上へスクロール列の見出しを描かない（横スクロール中）', () => {
    // 固定 3 列・scrollLeft=500（＝列 6 の途中）。overscan で境界の外側の列も body に入る。
    const { texts, frozenWidth } = setup({
      frozenColCount: 3,
      frozenRowCount: 1,
      scrollLeft: 500,
      scrollTop: 0,
      overscan: COL_W,
    });
    const boundary = HEADER_W + frozenWidth;
    const frozenLabels = new Set([columnLabel(0), columnLabel(1), columnLabel(2)]);
    const colHeaders = texts.filter(isColHeader);
    expect(colHeaders.length).toBeGreaterThan(frozenLabels.size);

    const scrollHeaders = colHeaders.filter((t) => !frozenLabels.has(t.text));
    // 前提: このシナリオには「固定帯の内側へ落ちるスクロール列の見出し」が実在する（＝修正前なら重なる）。
    expect(scrollHeaders.some((t) => t.x < boundary)).toBe(true);

    // 本題: スクロール列の見出しは必ず固定境界より右の clip の内側でだけ描かれる。
    for (const t of scrollHeaders) {
      expect(t.clip).not.toBeNull();
      expect(t.clip?.x).toBe(boundary);
    }
    // 逆向き: 固定帯の clip の中で描かれるのは固定列の見出しだけ。
    const inFrozenBand = colHeaders.filter((t) => t.clip?.x === HEADER_W && t.clip?.w === frozenWidth);
    expect(inFrozenBand.map((t) => t.text)).toEqual([columnLabel(0), columnLabel(1), columnLabel(2)]);
  });

  it('固定行の行番号の上へスクロール行の行番号を描かない（縦スクロール中）', () => {
    // 固定 1 行・scrollTop=200（＝行 9 の途中）。既定値のまま出荷済みの consumer で起きている条件。
    const { texts, frozenHeight } = setup({
      frozenColCount: 1,
      frozenRowCount: 1,
      scrollLeft: 0,
      scrollTop: 200,
      overscan: ROW_H,
    });
    const boundary = HEADER_H + frozenHeight;
    const rowHeaders = texts.filter(isRowHeader);
    const scrollRows = rowHeaders.filter((t) => t.text !== '1');
    expect(scrollRows.length).toBeGreaterThan(0);
    // 前提: 固定行帯の内側へ落ちるスクロール行の番号が実在する。
    expect(scrollRows.some((t) => t.y < boundary)).toBe(true);

    for (const t of scrollRows) {
      expect(t.clip).not.toBeNull();
      expect(t.clip?.y).toBe(boundary);
    }
    const inFrozenBand = rowHeaders.filter((t) => t.clip?.y === HEADER_H && t.clip?.h === frozenHeight);
    expect(inFrozenBand.map((t) => t.text)).toEqual(['1']);
  });

  it('固定行列が 0 のときは入れ子 clip を張らない（現行と同一の描画）', () => {
    const { texts, clips } = setup({
      frozenColCount: 0,
      frozenRowCount: 0,
      scrollLeft: 500,
      scrollTop: 200,
      overscan: 0,
    });
    // ヘッダー帯の clip は上帯・左帯の 2 枚だけ（＝修正前と同じ枚数・同じ矩形）。
    const bandClips = clips.filter((c) => c.y === 0 || c.x === 0);
    expect(bandClips).toContainEqual({ x: HEADER_W, y: 0, w: VIEW_W - HEADER_W, h: HEADER_H });
    expect(bandClips).toContainEqual({ x: 0, y: HEADER_H, w: HEADER_W, h: VIEW_H - HEADER_H });
    expect(bandClips.filter((c) => c.y === 0 && c.h === HEADER_H)).toHaveLength(1);
    expect(bandClips.filter((c) => c.x === 0 && c.w === HEADER_W)).toHaveLength(1);
    // 見出しは帯 clip の内側にだけ存在する（固定側の入れ子が増えていない）。
    for (const t of texts.filter(isColHeader)) {
      expect(t.clip).toEqual({ x: HEADER_W, y: 0, w: VIEW_W - HEADER_W, h: HEADER_H });
    }
  });

  it('スクロール位置 0 の初期表示では固定・スクロールの見出しが過不足なく描かれる（既定 1/1）', () => {
    const { texts, frozenWidth } = setup({
      frozenColCount: 1,
      frozenRowCount: 1,
      scrollLeft: 0,
      scrollTop: 0,
      overscan: 0,
    });
    const colHeaders = texts.filter(isColHeader);
    // 先頭列は固定帯、以降は連続してスクロール帯（重複・欠落なし）。
    expect(colHeaders[0]?.text).toBe(columnLabel(0));
    expect(colHeaders[0]?.clip).toEqual({ x: HEADER_W, y: 0, w: frozenWidth, h: HEADER_H });
    const labels = colHeaders.map((t) => t.text);
    expect(new Set(labels).size).toBe(labels.length);
    for (let i = 0; i < labels.length; i += 1) {
      expect(labels[i]).toBe(columnLabel(i));
    }
  });
});
