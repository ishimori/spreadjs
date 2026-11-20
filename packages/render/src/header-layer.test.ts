// DD-070-6 unit: 見出しの印の配置（純粋関数）と描画（並べ替えの三角・絞り込みのボタン・まとまりの開閉）。印を指定しない
// 見出しは従来と同一の描画になること（キャプションの位置・幅）も固定する。

import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId, type ColumnId, type RowId } from '@nanairo-sheet/types';

import { createAxis } from './axis';
import { createBaseLayer, type ColumnGroupBand } from './base-layer';
import { createChunkStore } from './chunk-store';
import { columnGroupMarkLayout, columnHeaderMarkLayout, columnHeaderMarkWidth, type ColumnGroupMark, type ColumnHeaderMark } from './header-layer';
import { createViewportTransform } from './viewport';

type Call =
  | { readonly kind: 'fillRect'; readonly style: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  | { readonly kind: 'strokeRect'; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  | { readonly kind: 'fillText'; readonly text: string; readonly x: number; readonly y: number }
  | { readonly kind: 'fill'; readonly style: string; readonly points: ReadonlyArray<readonly [number, number]> };

function createCtxStub(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  let fillStyle = '';
  let path: Array<readonly [number, number]> = [];
  const ctx = {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      fillStyle = String(value);
    },
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save: () => {},
    restore: () => {},
    beginPath() {
      path = [];
    },
    closePath: () => {},
    rect: () => {},
    clip: () => {},
    moveTo(x: number, y: number) {
      path.push([x, y]);
    },
    lineTo(x: number, y: number) {
      path.push([x, y]);
    },
    arcTo: () => {},
    fill() {
      calls.push({ kind: 'fill', style: fillStyle, points: [...path] });
    },
    stroke: () => {},
    clearRect: () => {},
    setLineDash: () => {},
    measureText: (text: string) => ({ width: text.length * 7 }),
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ kind: 'fillRect', style: fillStyle, x, y, w, h });
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      calls.push({ kind: 'strokeRect', x, y, w, h });
    },
    fillText(text: string, x: number, y: number) {
      calls.push({ kind: 'fillText', text, x, y });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const HEADER_W = 52;
const HEADER_H = 24;
const COL_W = 80;

function draw(options: {
  marks?: Record<number, ColumnHeaderMark>;
  captions?: Record<number, string>;
  groups?: ColumnGroupBand;
  groupMarks?: Record<number, ColumnGroupMark>;
  headerHeight?: number;
  colWidth?: number;
}): Call[] {
  const { ctx, calls } = createCtxStub();
  const headerHeight = options.headerHeight ?? HEADER_H;
  const rowAxis = createAxis<RowId>({ ids: [createRowId('r0')], defaultSize: 22 });
  const colAxis = createAxis<ColumnId>({ ids: Array.from({ length: 4 }, (_v, i) => createColumnId(`c${i}`)), defaultSize: options.colWidth ?? COL_W });
  const captions = options.captions;
  const marks = options.marks;
  const groupMarks = options.groupMarks;
  const layer = createBaseLayer({
    ctx,
    store: createChunkStore(),
    headerWidth: HEADER_W,
    headerHeight,
    frozenColCount: 0,
    ...(captions !== undefined ? { columnHeaderLabel: (col: number) => captions[col] ?? `C${col}` } : {}),
    ...(marks !== undefined ? { columnHeaderMark: (col: number) => marks[col] } : {}),
    ...(options.groups !== undefined ? { columnGroupBand: options.groups } : {}),
    ...(groupMarks !== undefined ? { columnGroupMark: (index: number) => groupMarks[index] } : {}),
  });
  const transform = createViewportTransform({
    rowAxis,
    colAxis,
    headerWidth: HEADER_W,
    headerHeight,
    frozenRowCount: 0,
    frozenColCount: 0,
    viewportWidth: 500,
    viewportHeight: 200,
    scrollLeft: 0,
    scrollTop: 0,
    overscanX: 0,
    overscanY: 0,
  });
  layer.draw({ transform, viewportWidth: 500, viewportHeight: 200, dpr: 1 });
  return calls;
}

const texts = (calls: readonly Call[]) => calls.filter((c): c is Extract<Call, { kind: 'fillText' }> => c.kind === 'fillText');
const fillsAt = (calls: readonly Call[], style: string) => calls.filter((c): c is Extract<Call, { kind: 'fill' }> => c.kind === 'fill' && c.style === style);

describe('DD-070-6 columnHeaderMarkLayout', () => {
  const rect = { x: 100, y: 0, width: 80, height: 24 };

  it('印が無ければ従来どおり矩形の中央・左右の余白を除いた幅', () => {
    expect(columnHeaderMarkLayout(rect, undefined, 5)).toEqual({ labelCenterX: 140, labelMaxWidth: 70 });
    expect(columnHeaderMarkLayout(rect, {}, 5)).toEqual({ labelCenterX: 140, labelMaxWidth: 70 });
  });

  it('右から絞り込みのボタン、その左に並べ替えの三角。名前は残りの幅の中央', () => {
    const layout = columnHeaderMarkLayout(rect, { sort: 'asc', filter: 'available' }, 5);
    expect(layout.filter).toEqual({ x: 161, y: 5, width: 14, height: 14 });
    expect(layout.sort).toEqual({ x: 150, y: 9.5, width: 8, height: 5 });
    expect(layout.labelMaxWidth).toBe(147 - 105);
    expect(layout.labelCenterX).toBe((105 + 147) / 2);
  });

  it('低い見出しではボタンを見出しの高さに収める', () => {
    expect(columnHeaderMarkLayout({ x: 0, y: 0, width: 80, height: 12 }, { filter: 'active' }, 5).filter).toEqual({ x: 67, y: 2, width: 8, height: 8 });
  });
});

describe('DD-070-6 columnGroupMarkLayout', () => {
  it('印があれば名前の左に開閉の印、名前は残りの幅の中央。無ければ従来どおり', () => {
    const rect = { x: 52, y: 0, width: 160, height: 22 };
    expect(columnGroupMarkLayout(rect, undefined, 5)).toEqual({ labelCenterX: 132, labelMaxWidth: 150 });
    const layout = columnGroupMarkLayout(rect, { collapsed: true }, 5);
    expect(layout.toggle).toEqual({ x: 57, y: 7, width: 8, height: 8 });
    expect(layout.labelCenterX).toBe((68 + 207) / 2);
  });
});

describe('DD-070-6 見出しの印の描画', () => {
  it('印を指定しない見出しは従来どおり（列記号を各列の中央に描き、三角もボタンも描かない）', () => {
    const calls = draw({});
    const headers = texts(calls).filter((t) => t.y === HEADER_H / 2 && t.x > HEADER_W);
    expect(headers.map((t) => [t.text, t.x])).toEqual([
      ['A', HEADER_W + 40],
      ['B', HEADER_W + 120],
      ['C', HEADER_W + 200],
      ['D', HEADER_W + 280],
    ]);
    expect(calls.some((c) => c.kind === 'fill' || c.kind === 'strokeRect')).toBe(false);
  });

  it('▲（昇順）・▼（降順）の三角と、絞り込みのボタン（available＝枠・active＝塗り）を右端に描き、名前は印を除いた幅の中央', () => {
    const calls = draw({
      captions: { 0: '品名', 1: '比率' },
      marks: { 0: { sort: 'asc' }, 1: { sort: 'desc', filter: 'active' }, 2: { filter: 'available' } },
    });
    const name0 = texts(calls).find((t) => t.text === '品名')!;
    expect(name0.x).toBeLessThan(HEADER_W + 40); // 三角の分だけ左へ
    const up = fillsAt(calls, '#555555').find((f) => f.points[0]![0] < HEADER_W + COL_W && f.points.length === 3)!;
    expect(up.points[0]![1]).toBeLessThan(up.points[1]![1]); // 頂点が上＝▲
    expect(calls.some((c) => c.kind === 'fillRect' && c.style === '#1a73e8')).toBe(true); // 絞り込み中のボタンの塗り
    expect(fillsAt(calls, '#ffffff').length).toBe(1); // 塗ったボタンの白い ▼
    expect(calls.filter((c) => c.kind === 'strokeRect').length).toBe(1); // 押せるボタンの枠（c2）
  });

  it('まとまりの印があれば上の段の名前の左に ▸（閉じている）を描き、無ければ描かない', () => {
    const groups: ColumnGroupBand = {
      height: 22,
      groups: [
        { colStart: 0, colEnd: 2, caption: 'Supplier' },
        { colStart: 2, colEnd: 4, caption: 'SDS' },
      ],
    };
    const calls = draw({ groups, groupMarks: { 0: { collapsed: true } }, headerHeight: 44 });
    const toggles = calls.filter((c): c is Extract<Call, { kind: 'fill' }> => c.kind === 'fill');
    expect(toggles).toHaveLength(1);
    const [first, second, third] = toggles[0]!.points;
    expect(second![0]).toBeGreaterThan(first![0]); // 頂点が右＝▸
    expect(third![0]).toBe(first![0]);
    const supplier = texts(calls).find((t) => t.text === 'Supplier')!;
    const sds = texts(calls).find((t) => t.text === 'SDS')!;
    expect(supplier.x).toBeGreaterThan(HEADER_W + COL_W); // 印の分だけ右へ
    expect(sds.x).toBe(HEADER_W + COL_W * 3); // 印の無いまとまりは従来どおり中央
  });
});

describe('DD-070-6 見出しの印（Codex の指摘）', () => {
  it('P2: 狭い列では余白の内側に収まらない印を省く（ボタンを優先し、次に三角。隣の見出しへ描かない）', () => {
    const narrow = columnHeaderMarkLayout({ x: 0, y: 0, width: 20, height: 24 }, { sort: 'asc', filter: 'available' }, 5);
    expect(narrow.filter).toBeUndefined(); // 14px のボタンは 20-10=10px に入らない
    expect(narrow.sort).toEqual({ x: 7, y: 9.5, width: 8, height: 5 }); // 三角だけは入る
    const tiny = columnHeaderMarkLayout({ x: 0, y: 0, width: 12, height: 24 }, { sort: 'asc', filter: 'available' }, 5);
    expect(tiny.filter).toBeUndefined();
    expect(tiny.sort).toBeUndefined();
    const fits = columnHeaderMarkLayout({ x: 0, y: 0, width: 40, height: 24 }, { sort: 'asc', filter: 'available' }, 5);
    expect(fits.filter).toBeDefined();
    expect(fits.sort).toBeDefined(); // 5..35 にボタン 14＋間 3＋三角 8 が入る
    expect(fits.sort!.x).toBeGreaterThanOrEqual(5);
  });

  it('P2: 印の幅（列幅の自動調整が見出しの名前に足す）', () => {
    expect(columnHeaderMarkWidth(undefined)).toBe(0);
    expect(columnHeaderMarkWidth({ sort: 'asc' })).toBe(8 + 3);
    expect(columnHeaderMarkWidth({ sort: 'asc', filter: 'active' })).toBe(14 + 3 + 8 + 3);
  });

  it('P3: 押せるボタンの枠は当たり判定の矩形の内側に描く', () => {
    const calls = draw({ marks: { 0: { filter: 'available' } } });
    const frame = calls.find((c): c is Extract<Call, { kind: 'strokeRect' }> => c.kind === 'strokeRect')!;
    const layout = columnHeaderMarkLayout({ x: HEADER_W, y: 0, width: COL_W, height: HEADER_H }, { filter: 'available' }, 5);
    expect(frame.x).toBeGreaterThanOrEqual(layout.filter!.x);
    expect(frame.y).toBeGreaterThanOrEqual(layout.filter!.y);
    expect(frame.x + frame.w).toBeLessThanOrEqual(layout.filter!.x + layout.filter!.width);
    expect(frame.y + frame.h).toBeLessThanOrEqual(layout.filter!.y + layout.filter!.height);
  });

  it('P2: 印のある見出しで省略記号も入らない幅なら名前を描かない（印と重ねない）', () => {
    const calls = draw({ captions: { 0: 'とても長い見出し' }, marks: { 0: { filter: 'available', sort: 'asc' } }, colWidth: 36 });
    expect(texts(calls).some((t) => t.text.includes('…') && t.x < HEADER_W + 36)).toBe(false);
  });
});
