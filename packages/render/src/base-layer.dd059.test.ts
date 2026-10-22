// DD-059 unit: 描画テキストの装飾（cellTextDecoration フック）＝負の数の色と括弧表記の右余白。
//
// ctx を「呼び出しを記録するスタブ」に差し替えて
//   ① 装飾の文字色で数値を描く（右寄せは維持）・既定は従来どおり数値色
//   ② 文字色の優先順位は getCellStyle の textColor ＞ 装飾の textColor ＞ 既定色（バッジの文字も同じ）
//   ③ 不正な色は既定色で描く（直前に塗った背景色を文字色として引き継がない。左外からはみ出す文字も同じ）
//   ④ 右余白は数値セルの右端を余白文字の幅だけあけ、使える幅も同じだけ狭める（非数値セルには効かない）
//   ⑤ フック未指定なら現行描画と同じ位置・色
// を検証する。表示上の正負の判定と書式文字列は grid の display-format（単体テスト）が持つ。

import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId, type ColumnId, type RowId } from '@nanairo-sheet/types';

import { createAxis } from './axis';
import { CELL_TEXT_PADDING, DEFAULT_BASE_COLORS, createBaseLayer, type BaseLayerDeps } from './base-layer';
import { createChunkStore } from './chunk-store';
import { createViewportTransform } from './viewport';

interface TextCall {
  readonly text: string;
  readonly x: number;
  readonly style: string;
  readonly align: string;
}

/** 記録用の最小 ctx スタブ。fillStyle は Canvas 2D と同じく構文不正な色（'not-a-color'）の代入を無視する。 */
function createCtxStub(): { ctx: CanvasRenderingContext2D; texts: TextCall[] } {
  const texts: TextCall[] = [];
  let fillStyle = '';
  const ctx = {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      if (value !== 'not-a-color') fillStyle = String(value);
    },
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
    fillRect: () => {},
    stroke: () => {},
    // 1 文字 7px（余白文字 `)` も 7px）。
    measureText: (text: string) => ({ width: text.length * 7 }),
    fillText(text: string, x: number) {
      texts.push({ text, x, style: String(this.fillStyle), align: String(this.textAlign) });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts };
}

const HEADER_W = 52;
const HEADER_H = 24;
const ROW_H = 22;
const COL_W = 80;
const VIEW_W = 600;
const VIEW_H = 300;
const PAD_WIDTH = 7; // `)` 1 文字分
const NEG_COLOR = '#cc0000';
const PAREN_COL = 1;

/** 列 index のセル矩形の右端（スクロール 0・固定なし）。 */
const rightEdge = (col: number): number => HEADER_W + (col + 1) * COL_W;
const leftEdge = (col: number): number => HEADER_W + col * COL_W;

/** grid 側の装飾フック相当: PAREN_COL の負の数は色、正の数と 0 は右余白（括弧表記の列）。 */
const NEGATIVE = Object.freeze({ textColor: NEG_COLOR });
const PAD = Object.freeze({ trailingPad: ')' });
const parenDecoration: NonNullable<BaseLayerDeps['cellTextDecoration']> = (col, raw) => {
  if (col !== PAREN_COL || !/^-?\d+(\.\d+)?$/.test(raw)) {
    return undefined;
  }
  return raw.startsWith('-') ? NEGATIVE : PAD;
};
/** grid 側の表示書式相当: 負の数を括弧で囲む。 */
const parenText = (col: number, raw: string): string =>
  col === PAREN_COL && raw.startsWith('-') && /^-\d/.test(raw) ? `(${raw.slice(1)})` : raw;

function draw(
  cells: ReadonlyArray<readonly [number, number, string]>,
  hooks: Partial<BaseLayerDeps>,
  scrollLeft = 0,
): TextCall[] {
  const { ctx, texts } = createCtxStub();
  const store = createChunkStore();
  for (const [row, col, value] of cells) {
    store.set(row, col, value);
  }
  const rowAxis = createAxis<RowId>({
    ids: Array.from({ length: 10 }, (_v, i) => createRowId(`r${i}`)),
    defaultSize: ROW_H,
  });
  const colAxis = createAxis<ColumnId>({
    ids: Array.from({ length: 6 }, (_v, i) => createColumnId(`c${i}`)),
    defaultSize: COL_W,
  });
  const layer = createBaseLayer({ ctx, store, headerWidth: HEADER_W, headerHeight: HEADER_H, ...hooks });
  const transform = createViewportTransform({
    rowAxis,
    colAxis,
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    frozenRowCount: 0,
    frozenColCount: 0,
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    scrollLeft,
    scrollTop: 0,
    overscanX: 0,
    overscanY: 0,
  });
  layer.draw({ transform, viewportWidth: VIEW_W, viewportHeight: VIEW_H, dpr: 1 });
  return texts;
}

const textOf = (texts: readonly TextCall[], text: string): TextCall => {
  const found = texts.find((t) => t.text === text);
  expect(found, `fillText("${text}") が描かれる`).toBeDefined();
  return found!;
};

describe('DD-059: 負の数の色（cellTextDecoration.textColor）', () => {
  it('負の数は装飾の色で右寄せに描き、正の数は既定の数値色のまま', () => {
    const texts = draw(
      [
        [1, PAREN_COL, '-1234'],
        [2, PAREN_COL, '1234'],
      ],
      { formatCellText: parenText, cellTextDecoration: parenDecoration },
    );
    const negative = textOf(texts, '(1234)');
    expect(negative.style).toBe(NEG_COLOR);
    expect(negative.align).toBe('right');
    expect(textOf(texts, '1234').style).toBe(DEFAULT_BASE_COLORS.numberText);
  });

  it('columnFormats の textColor（getCellStyle）が装飾の色に勝つ（論点2）', () => {
    const texts = draw([[1, PAREN_COL, '-1234']], {
      formatCellText: parenText,
      cellTextDecoration: parenDecoration,
      getCellStyle: (_col, value) => (value === '-1234' ? { textColor: '#0000ff' } : undefined),
    });
    expect(textOf(texts, '(1234)').style).toBe('#0000ff');
  });

  it('不正な色は既定の数値色で描く（直前に塗ったセル背景色を文字色にしない）', () => {
    const texts = draw([[1, 2, '-5']], {
      cellTextDecoration: () => ({ textColor: 'not-a-color' }),
      getCellStyle: () => ({ cellBackground: '#00ff00' }),
    });
    expect(textOf(texts, '-5').style).toBe(DEFAULT_BASE_COLORS.numberText);
  });

  it('バッジの文字: style.textColor ＞ 装飾の色 ＞ 既定の文字色（不正な色はチップ色を引き継がない）', () => {
    const badge = (textColor?: string) =>
      draw([[1, PAREN_COL, '-1234']], {
        formatCellText: parenText,
        cellTextDecoration: parenDecoration,
        getCellStyle: () => ({ badge: true, badgeColor: '#ffff00', ...(textColor === undefined ? {} : { textColor }) }),
      });
    expect(textOf(badge(), '(1234)').style).toBe(NEG_COLOR);
    expect(textOf(badge('#ffffff'), '(1234)').style).toBe('#ffffff');
    const invalid = draw([[1, PAREN_COL, '-1234']], {
      formatCellText: parenText,
      cellTextDecoration: () => ({ textColor: 'not-a-color' }),
      getCellStyle: () => ({ badge: true, badgeColor: '#ffff00' }),
    });
    expect(textOf(invalid, '(1234)').style).toBe(DEFAULT_BASE_COLORS.cellText);
  });
});

describe('DD-059: 不正な文字色は既定色で描く（columnFormats の textColor も同じ経路）', () => {
  it('左外からはみ出す文字も、不正な textColor なら既定の文字色で描く（直前の pane 背景色にしない）', () => {
    // 横スクロール 100px で col 0 は可視外。col 0 の長文が空の col 1 以降へはみ出して描かれる（Pass 2）。
    const long = 'あいうえおかきくけこさしすせそ';
    const texts = draw([[1, 0, long]], { getCellStyle: () => ({ textColor: 'not-a-color' }) }, 100);
    expect(textOf(texts, long).style).toBe(DEFAULT_BASE_COLORS.cellText);
  });
});

describe('DD-059: 括弧表記の右余白（cellTextDecoration.trailingPad）', () => {
  it('正の数と 0 は右端を `)` 1 文字分あけ、負の数は右端まで寄せる（一の位がそろう）', () => {
    const texts = draw(
      [
        [1, PAREN_COL, '-1234'],
        [2, PAREN_COL, '1234'],
        [3, PAREN_COL, '0'],
      ],
      { formatCellText: parenText, cellTextDecoration: parenDecoration },
    );
    const right = rightEdge(PAREN_COL) - CELL_TEXT_PADDING;
    expect(textOf(texts, '(1234)').x).toBe(right);
    expect(textOf(texts, '1234').x).toBe(right - PAD_WIDTH);
    expect(textOf(texts, '0').x).toBe(right - PAD_WIDTH);
  });

  it('右余白のぶん使える幅も狭まる（余白なしで収まる 10 桁が省略記号で切られる）', () => {
    // 列幅 80・左右パディング 5 → 使える幅 70px。10 桁（70px）は余白なしなら収まり、余白 7px を引くと収まらない。
    const withPad = draw([[1, PAREN_COL, '1234567890']], { cellTextDecoration: parenDecoration });
    expect(withPad.some((t) => t.text.endsWith('…'))).toBe(true);
    const withoutPad = draw([[1, PAREN_COL, '1234567890']], {});
    expect(textOf(withoutPad, '1234567890').x).toBe(rightEdge(PAREN_COL) - CELL_TEXT_PADDING);
  });

  it('非数値セルには右余白を効かせない（左寄せのまま）', () => {
    const texts = draw([[1, PAREN_COL, 'abc']], {
      cellTextDecoration: () => PAD,
    });
    const text = textOf(texts, 'abc');
    expect(text.align).toBe('left');
    expect(text.x).toBe(leftEdge(PAREN_COL) + CELL_TEXT_PADDING);
  });

  it('フック未指定なら現行描画（右端まで寄せ・既定の数値色）', () => {
    const texts = draw([[2, PAREN_COL, '1234']], {});
    const text = textOf(texts, '1234');
    expect(text.x).toBe(rightEdge(PAREN_COL) - CELL_TEXT_PADDING);
    expect(text.style).toBe(DEFAULT_BASE_COLORS.numberText);
  });
});
