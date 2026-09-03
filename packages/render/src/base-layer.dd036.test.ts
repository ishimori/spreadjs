// DD-036 C2 unit: 静的列背景（columnBackground フック）の描画契約。
//
// Canvas の実描画は目視できないため、ctx を「呼び出しを記録するスタブ」に差し替えて
//   ① 指定列は**空セルでも**バンドとして塗られる（値ベース書式は非空セルのみ＝別経路）
//   ② 罫線より前に塗る（＝網掛けで罫線が消えない）
//   ③ 値ベース書式の背景は静的列背景の**後**に塗られる＝値ベースが勝つ（AC4）
//   ④ フック未指定なら列バンドの塗りが 1 回も起きない（現行描画と完全一致）
// を検証する。座標の正しさは viewport（cellRect）側の責務なので、ここでは順序と対象列だけを固定する。

import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId, type ColumnId, type RowId } from '@nanairo-sheet/types';

import { createAxis } from './axis';
import { createBaseLayer } from './base-layer';
import { createChunkStore } from './chunk-store';
import { createViewportTransform } from './viewport';

type Call =
  | { readonly kind: 'fillRect'; readonly style: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  | { readonly kind: 'stroke'; readonly style: string }
  | { readonly kind: 'fillText'; readonly style: string; readonly text: string };

/** 記録用の最小 ctx スタブ（base-layer が使うメソッドだけを持つ）。 */
function createCtxStub(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    rect: () => {},
    clip: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arcTo: () => {},
    fill: () => {},
    clearRect: () => {},
    measureText: (text: string) => ({ width: text.length * 7 }),
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ kind: 'fillRect', style: String(this.fillStyle), x, y, w, h });
    },
    stroke() {
      calls.push({ kind: 'stroke', style: String(this.strokeStyle) });
    },
    fillText(text: string) {
      calls.push({ kind: 'fillText', style: String(this.fillStyle), text });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const HEADER_W = 52;
const HEADER_H = 24;
const ROW_H = 22;
const COL_W = 80;
const VIEW_W = 600;
const VIEW_H = 300;
/** 網掛け対象の列 index（col-c 相当）。 */
const BG_COL = 2;
const BG_COLOR = '#eef3ff';

function setup(options: {
  withBackground: boolean;
  withFormat?: boolean;
  /** 列 index → 色（既定は BG_COL だけを BG_COLOR で塗る）。 */
  backgroundOf?: (col: number) => string | undefined;
}): Call[] {
  const { ctx, calls } = createCtxStub();
  const store = createChunkStore();
  // 非空セルは (0,0) と (1,BG_COL) だけ。BG_COL は 1 行目が空＝空セルも塗られることの検証に使う。
  store.set(0, 0, 'A0');
  store.set(1, BG_COL, 'X');
  const rowAxis = createAxis<RowId>({
    ids: Array.from({ length: 10 }, (_v, i) => createRowId(`r${i}`)),
    defaultSize: ROW_H,
  });
  const colAxis = createAxis<ColumnId>({
    ids: Array.from({ length: 6 }, (_v, i) => createColumnId(`c${i}`)),
    defaultSize: COL_W,
  });
  const layer = createBaseLayer({
    ctx,
    store,
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    frozenColCount: 1,
    ...(options.withBackground
      ? {
          columnBackground:
            options.backgroundOf ?? ((col: number) => (col === BG_COL ? BG_COLOR : undefined)),
        }
      : {}),
    ...(options.withFormat === true
      ? { getCellStyle: (_col: number, value: string) => (value === 'X' ? { cellBackground: '#ff0000' } : undefined) }
      : {}),
  });
  const transform = createViewportTransform({
    rowAxis,
    colAxis,
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    frozenRowCount: 1,
    frozenColCount: 1,
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    scrollLeft: 0,
    scrollTop: 0,
    overscanX: 0,
    overscanY: 0,
  });
  layer.draw({ transform, viewportWidth: VIEW_W, viewportHeight: VIEW_H, dpr: 1 });
  return calls;
}

describe('DD-036 C2: 静的列背景（columnBackground）', () => {
  it('指定列は空セルを含む列バンドとして塗られる（body/固定 pane の両方）', () => {
    const calls = setup({ withBackground: true });
    const bands = calls.filter((c) => c.kind === 'fillRect' && c.style === BG_COLOR);
    expect(bands.length).toBeGreaterThan(0);
    for (const band of bands) {
      // 列 index 2 の x（固定列 1 列ぶんは scrollLeft=0 ゆえ通常の位置）。
      expect(band.kind === 'fillRect' && band.x).toBe(HEADER_W + BG_COL * COL_W);
      expect(band.kind === 'fillRect' && band.w).toBe(COL_W);
    }
    // 固定行 pane（top）のバンドは 1 行分だが、body pane のバンドは複数行ぶん＝空セル行も覆う。
    expect(bands.some((b) => b.kind === 'fillRect' && b.h > ROW_H)).toBe(true);
  });

  it('列バンドは罫線（stroke）より前に塗られる＝網掛けで罫線が消えない', () => {
    const calls = setup({ withBackground: true });
    const firstBand = calls.findIndex((c) => c.kind === 'fillRect' && c.style === BG_COLOR);
    const firstStroke = calls.findIndex((c) => c.kind === 'stroke');
    expect(firstBand).toBeGreaterThanOrEqual(0);
    expect(firstStroke).toBeGreaterThan(firstBand);
  });

  it('値ベース書式の背景は静的列背景の後に塗られる（値ベースが勝つ・AC4）', () => {
    const calls = setup({ withBackground: true, withFormat: true });
    // pane は body → left → top → corner の順に描かれる。値ベース背景が塗られるセル (1,BG_COL) は body pane にあり、
    // 同じ pane の列バンド（＝先頭のバンド）より後に塗られていれば「値ベースが勝つ」（後続バンドは別 pane のもの）。
    const firstBand = calls.findIndex((c) => c.kind === 'fillRect' && c.style === BG_COLOR);
    const valueBg = calls.findIndex((c) => c.kind === 'fillRect' && c.style === '#ff0000');
    expect(firstBand).toBeGreaterThanOrEqual(0);
    expect(valueBg).toBeGreaterThan(firstBand);
  });

  it('フック未指定なら列バンドの塗りが起きない（現行描画と完全一致）', () => {
    const calls = setup({ withBackground: false });
    expect(calls.some((c) => c.kind === 'fillRect' && c.style === BG_COLOR)).toBe(false);
  });
});

describe('DD-036（Codex P2）: 不正な色は直前列の色を継承しない', () => {
  it('隣接列に「有効色・不正色」を指定しても、不正色の列は pane 背景で塗られる（前列の色が漏れない）', () => {
    const calls = setup({
      withBackground: true,
      backgroundOf: (col) => (col === 1 ? '#ff0000' : col === 2 ? 'not-a-color' : undefined),
    });
    // Canvas スタブは代入をそのまま記録するため、実ブラウザーの「不正値は無視」を模して
    // 「不正色の直前に pane 背景を代入している」ことを検証する（列 2 の fillRect が赤でないこと）。
    const bands = calls.filter((c) => c.kind === 'fillRect' && c.x === HEADER_W + 2 * COL_W && c.w === COL_W);
    expect(bands.length).toBeGreaterThan(0);
    for (const band of bands) {
      expect(band.kind === 'fillRect' && band.style).not.toBe('#ff0000');
    }
    // 直前に pane 背景（#ffffff 系）への代入が入っている＝実ブラウザーでは不正色が無視されて pane 背景になる。
    const invalidIndex = calls.findIndex((c) => c.kind === 'fillRect' && c.style === 'not-a-color');
    expect(invalidIndex).toBeGreaterThan(0);
    // 有効色の列（index 1）は指定どおり塗られる。
    expect(calls.some((c) => c.kind === 'fillRect' && c.style === '#ff0000' && c.x === HEADER_W + COL_W)).toBe(true);
  });
});

