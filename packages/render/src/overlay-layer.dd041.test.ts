// DD-041 unit: Presence の activeCell 枠・名前タグを pane 境界で clip する契約。
//
// 症状は「他ユーザーの activeCell が固定帯の裏へ回ったとき、その枠と名前タグが固定ペインの上へ重なる」。
// Presence の**選択範囲ハイライトは pane 分割済みで正しく**、枠とタグだけが content 全域の単一 clip で
// 描かれていた（DD-039 のヘッダー帯と同根・別箇所）。
//
// Canvas の実描画は目視できないため、ctx を「clip 矩形と描画呼び出しを記録するスタブ」に差し替え、
// **各描画がどの clip の内側で呼ばれたか**（＝実際に塗られうる範囲）を検証する。
// テストが意味を持つ条件（＝修正前なら落ちること）も同時に固定する: シナリオには
// 「viewport 座標が固定帯の内側へ落ちる Presence の activeCell」が必ず存在することを assert している。

import { describe, expect, it } from 'vitest';

import { createColumnId, createRowId, type ColumnId, type RowId } from '@nanairo-sheet/types';

import { createAxis } from './axis';
import { snapToDevice } from './dpi';
import { createOverlayLayer, PRESENCE_PALETTE } from './overlay-layer';
import type { PresenceUser } from './presence-sim';
import { createViewportTransform } from './viewport';

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 描画呼び出し 1 回分の記録（描画時に有効だった最内 clip 付き）。 */
interface DrawCall {
  readonly kind: 'strokeRect' | 'fillRect' | 'fillText';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly text?: string;
  readonly fillStyle: string;
  readonly strokeStyle: string;
  readonly globalAlpha: number;
  /** その時点で有効だった最内 clip（未 clip なら null）。 */
  readonly clip: Rect | null;
}

/**
 * clip の入れ子を追跡する ctx スタブ。save/restore で clip スタックを出し入れし、
 * 各描画には「その時点の最内 clip」を紐づけて記録する。
 */
function createCtxStub(): { ctx: CanvasRenderingContext2D; calls: DrawCall[]; clips: Rect[] } {
  const calls: DrawCall[] = [];
  const clips: Rect[] = [];
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
    globalAlpha: 1,
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
    setLineDash: () => {},
    clearRect: () => {},
    measureText: (text: string) => ({ width: text.length * 7 }),
    strokeRect(x: number, y: number, w: number, h: number) {
      calls.push({ kind: 'strokeRect', x, y, w, h, ...styles(), clip: current() });
    },
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ kind: 'fillRect', x, y, w, h, ...styles(), clip: current() });
    },
    fillText(text: string, x: number, y: number) {
      calls.push({ kind: 'fillText', x, y, w: 0, h: 0, text, ...styles(), clip: current() });
    },
  };
  const styles = (): Pick<DrawCall, 'fillStyle' | 'strokeStyle' | 'globalAlpha'> => ({
    fillStyle: String(ctx.fillStyle),
    strokeStyle: String(ctx.strokeStyle),
    globalAlpha: ctx.globalAlpha,
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, clips };
}

const HEADER_W = 52;
const HEADER_H = 24;
const ROW_H = 22;
const COL_W = 80;
const VIEW_W = 600;
const VIEW_H = 300;
const ROW_COUNT = 60;
const COL_COUNT = 30;
const NAME = '田中';
const COLOR = PRESENCE_PALETTE[1];

function presenceAt(row: number, col: number): PresenceUser {
  return {
    id: 'u1',
    displayName: NAME,
    colorKey: 1,
    activeRow: row,
    activeCol: col,
    // 選択範囲は activeCell と同一セル（枠・タグとの取り違えは globalAlpha で判別する）。
    selRowStart: row,
    selRowEnd: row + 1,
    selColStart: col,
    selColEnd: col + 1,
  };
}

function setup(options: {
  frozenColCount: number;
  frozenRowCount: number;
  scrollLeft: number;
  scrollTop: number;
  presences: readonly PresenceUser[];
  /** overscan を入れると固定境界の外側の行/列も body 範囲へ入る（漏れの主因のひとつ）。 */
  overscan?: number;
}): {
  calls: DrawCall[];
  clips: Rect[];
  bodyOriginX: number;
  bodyOriginY: number;
  cellRect: (row: number, col: number) => { x: number; y: number };
} {
  const { ctx, calls, clips } = createCtxStub();
  const rowAxis = createAxis<RowId>({
    ids: Array.from({ length: ROW_COUNT }, (_v, i) => createRowId(`r${i}`)),
    defaultSize: ROW_H,
  });
  const colAxis = createAxis<ColumnId>({
    ids: Array.from({ length: COL_COUNT }, (_v, i) => createColumnId(`c${i}`)),
    defaultSize: COL_W,
  });
  const layer = createOverlayLayer({ ctx, headerWidth: HEADER_W, headerHeight: HEADER_H });
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
  layer.draw({
    transform,
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    dpr: 1,
    selection: null,
    dragRange: null,
    presences: options.presences,
  });
  return {
    calls,
    clips,
    bodyOriginX: HEADER_W + transform.frozenWidth(),
    bodyOriginY: HEADER_H + transform.frozenHeight(),
    cellRect: (row, col) => transform.cellRect(row, col),
  };
}

/** activeCell の枠（Presence 色の strokeRect）。 */
const isFrame = (c: DrawCall): boolean => c.kind === 'strokeRect' && c.strokeStyle === COLOR;
/** 名前タグの下地（Presence 色・不透明の fillRect。選択ハイライトは alpha 0.1 なので混ざらない）。 */
const isTagBox = (c: DrawCall): boolean =>
  c.kind === 'fillRect' && c.fillStyle === COLOR && c.globalAlpha === 1;
/** 名前タグの文字。 */
const isTagText = (c: DrawCall): boolean => c.kind === 'fillText' && c.text === NAME;
/** 選択範囲の淡いハイライト（alpha 0.1）。 */
const isSelHighlight = (c: DrawCall): boolean => c.kind === 'fillRect' && c.globalAlpha === 0.1;

describe('DD-041: Presence の activeCell 枠・名前タグの pane clip', () => {
  it('固定列の上へ、固定帯の裏へ回った他者の枠・名前タグを描かない（横スクロール中）', () => {
    // 固定 3 列・scrollLeft=500。列 8 の viewport X は固定帯（52〜292）の内側 192 に落ちる。
    const { calls, bodyOriginX, cellRect } = setup({
      frozenColCount: 3,
      frozenRowCount: 0,
      scrollLeft: 500,
      scrollTop: 0,
      overscan: COL_W,
      presences: [presenceAt(2, 8)],
    });
    // 前提: この配置は「固定帯の内側へ落ちるスクロール列の activeCell」（＝修正前なら重なる）。
    expect(cellRect(2, 8).x).toBeLessThan(bodyOriginX);

    const frames = calls.filter(isFrame);
    const tagBoxes = calls.filter(isTagBox);
    const tagTexts = calls.filter(isTagText);
    expect(frames).toHaveLength(1);
    expect(tagBoxes).toHaveLength(1);
    expect(tagTexts).toHaveLength(1);

    // 本題: 枠もタグも body pane の clip の内側でだけ描かれる（固定帯は 1 ピクセルも塗られない）。
    for (const c of [...frames, ...tagBoxes, ...tagTexts]) {
      expect(c.clip).not.toBeNull();
      expect(c.clip?.x).toBe(bodyOriginX);
    }
  });

  it('固定行の上へ、固定帯の裏へ回った他者の枠・名前タグを描かない（縦スクロール中）', () => {
    // 固定 1 行・scrollTop=200。行 10 の viewport Y は固定帯（24〜46）の内側 44 に落ちる。
    const { calls, bodyOriginY, cellRect } = setup({
      frozenColCount: 0,
      frozenRowCount: 1,
      scrollLeft: 0,
      scrollTop: 200,
      overscan: ROW_H,
      presences: [presenceAt(10, 2)],
    });
    expect(cellRect(10, 2).y).toBeLessThan(bodyOriginY);

    const drawn = calls.filter((c) => isFrame(c) || isTagBox(c) || isTagText(c));
    expect(drawn).toHaveLength(3);
    for (const c of drawn) {
      expect(c.clip).not.toBeNull();
      expect(c.clip?.y).toBe(bodyOriginY);
    }
  });

  it('固定行列が 0 のときは修正前と同じ矩形・同じ座標で描く（見た目不変）', () => {
    const { calls, cellRect } = setup({
      frozenColCount: 0,
      frozenRowCount: 0,
      scrollLeft: 500,
      scrollTop: 200,
      presences: [presenceAt(12, 9)],
    });
    // 固定 0 の body pane clip は、修正前の content clip（ヘッダーを除いた全セル領域）と同一。
    const contentClip: Rect = {
      x: HEADER_W,
      y: HEADER_H,
      w: VIEW_W - HEADER_W,
      h: VIEW_H - HEADER_H,
    };
    const active = cellRect(12, 9);
    const frame = calls.find(isFrame);
    const tagBox = calls.find(isTagBox);
    const tagText = calls.find(isTagText);
    expect(frame?.clip).toEqual(contentClip);
    expect(tagBox?.clip).toEqual(contentClip);
    expect(tagText?.clip).toEqual(contentClip);
    // 座標も修正前と同一（枠＝セル矩形をデバイス格子へスナップ、タグ＝セルの真上 14px）。
    expect({ x: frame?.x, y: frame?.y, w: frame?.w, h: frame?.h }).toEqual({
      x: snapToDevice(active.x, 1),
      y: snapToDevice(active.y, 1),
      w: COL_W,
      h: ROW_H,
    });
    expect({ x: tagBox?.x, y: tagBox?.y }).toEqual({ x: active.x, y: active.y - 14 });
    expect({ x: tagText?.x, y: tagText?.y }).toEqual({ x: active.x + 4, y: active.y - 2 });
  });

  it('選択範囲ハイライトには手を入れない（pane 分割のまま・枠と同じ pane で描かれる）', () => {
    const { calls, bodyOriginX } = setup({
      frozenColCount: 3,
      frozenRowCount: 0,
      scrollLeft: 500,
      scrollTop: 0,
      overscan: COL_W,
      presences: [presenceAt(2, 8)],
    });
    const highlights = calls.filter(isSelHighlight);
    expect(highlights).toHaveLength(1);
    expect(highlights[0]?.clip?.x).toBe(bodyOriginX);
  });

  it('activeCell が可視範囲外の Presence では枠・タグを 1 つも描かない（見た目不変）', () => {
    // 行 55 は scrollTop=0・viewport 高 300 の可視範囲（overscan 0）より遥か下。
    const { calls } = setup({
      frozenColCount: 3,
      frozenRowCount: 1,
      scrollLeft: 0,
      scrollTop: 0,
      presences: [presenceAt(55, 20)],
    });
    expect(calls.filter(isFrame)).toHaveLength(0);
    expect(calls.filter(isTagBox)).toHaveLength(0);
    expect(calls.filter(isTagText)).toHaveLength(0);
  });
});
