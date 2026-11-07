// DD-047: 可視境界だけを解決し、全paneの背景・文字の後に描く。gridの公開型へ依存しない。
// DD-064: 結合範囲の中を通る区間は描かない（範囲の外周の線は描く）。
import type { MergeIndex } from '@nanairo-sheet/selection';

import { normalizeDpr } from './dpi';
import type { FrameViewport } from './base-layer';
import type { IndexRange } from './viewport';

export interface BoundaryBorder {
  readonly color: string;
  readonly width: number;
  readonly style?: 'solid' | 'dotted' | 'dashed';
}

export function isPatternBorder(border: BoundaryBorder | undefined): boolean {
  return border?.style === 'dotted' || border?.style === 'dashed';
}

export interface BorderLayerDeps {
  readonly rowBorder?: (boundaryIndex: number) => BoundaryBorder | undefined;
  readonly columnBorder?: (boundaryIndex: number) => BoundaryBorder | undefined;
  /** 結合範囲（DD-064・base-layer と同じもの）。範囲の中を通る区間を抜く。未指定・0 件なら現行と同じ。 */
  readonly mergedRanges?: () => MergeIndex | undefined;
}

/** 幅も位置もdevice整数へ。奇数幅は境界の右/下側へ0.5 device px寄せる。 */
export function borderBand(position: number, width: number, dpr: number): { start: number; size: number } {
  const d = normalizeDpr(dpr);
  const pixels = Math.max(1, Math.round(width * d));
  return { start: (Math.round(position * d) - Math.floor(pixels / 2)) / d, size: pixels / d };
}

/** [from, to) から skips（[start, end) の区間）を除いた残りの区間（DD-064・昇順）。skips が空なら [[from, to]]。 */
export function subtractIntervals(
  from: number,
  to: number,
  skips: readonly (readonly [number, number])[],
): Array<[number, number]> {
  if (skips.length === 0) {
    return to > from ? [[from, to]] : [];
  }
  const sorted = [...skips].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  let cursor = from;
  for (const [start, end] of sorted) {
    if (end <= cursor) {
      continue;
    }
    if (start >= to) {
      break;
    }
    if (start > cursor) {
      out.push([cursor, Math.min(start, to)]);
    }
    cursor = Math.max(cursor, end);
    if (cursor >= to) {
      break;
    }
  }
  if (cursor < to) {
    out.push([cursor, to]);
  }
  return out;
}

interface Line {
  readonly horizontal: boolean;
  readonly position: number;
  readonly clipStart: number;
  readonly clipEnd: number;
  readonly border: BoundaryBorder;
  /** 境界の index（横線＝その上の行の次の行・縦線＝その左の列の次の列）。DD-064 の結合の内側の判定に使う。 */
  readonly boundary: number;
}

export function drawBorders(
  ctx: CanvasRenderingContext2D,
  frame: FrameViewport,
  headerWidth: number,
  headerHeight: number,
  deps: BorderLayerDeps,
): void {
  if (deps.rowBorder === undefined && deps.columnBorder === undefined) return;
  const { transform, dpr } = frame;
  const panes = transform.panes();
  const body = panes.find((p) => p.pane === 'body');
  const corner = panes.find((p) => p.pane === 'corner');
  if (body === undefined || corner === undefined) return;
  const lines: Line[] = [];
  // 各軸は固定帯とスクロール帯に分ける。固定境界そのものは1回だけ全幅で描く。
  function collect(horizontal: boolean, frozen: IndexRange, scroll: IndexRange, start: number, viewportEnd: number, frozenSize: number, getBorder: ((index: number) => BoundaryBorder | undefined) | undefined): number {
    const rectAt = (index: number): { position: number; size: number } => {
      const r = horizontal ? transform.rowHeaderRect(index) : transform.columnHeaderRect(index);
      return horizontal ? { position: r.y, size: r.height } : { position: r.x, size: r.width };
    };
    let end = start;
    for (const range of [frozen, scroll]) {
      if (range.end > range.start) {
        const last = rectAt(range.end - 1);
        end = Math.max(end, last.position + last.size);
      }
    }
    end = Math.min(viewportEnd, end);
    if (getBorder === undefined) return end;
    const seam = start + frozenSize;
    function rangeLines(range: IndexRange, clipStart: number, clipEnd: number): void {
      if (range.end <= range.start || clipEnd <= clipStart) return;
      for (let index = range.start; index <= range.end; index += 1) {
        if (frozenSize > 0 && index === frozen.end) continue;
        const border = getBorder?.(index);
        if (border === undefined) continue;
        const rect = rectAt(index === range.end ? index - 1 : index);
        const position = rect.position + (index === range.end ? rect.size : 0);
        if (position + border.width < clipStart || position - border.width > clipEnd) continue;
        lines.push({ horizontal, position, clipStart, clipEnd, border, boundary: index });
      }
    }
    rangeLines(frozen, start, Math.min(seam, end));
    rangeLines(scroll, seam, end);
    if (frozenSize > 0 && seam <= end) {
      const border = getBorder(frozen.end);
      if (border !== undefined) lines.push({ horizontal, position: seam, clipStart: start, clipEnd: end, border, boundary: frozen.end });
    }
    return end;
  }
  const right = collect(false, corner.cols, body.cols, headerWidth, frame.viewportWidth, transform.frozenWidth(), deps.columnBorder);
  const bottom = collect(true, corner.rows, body.rows, headerHeight, frame.viewportHeight, transform.frozenHeight(), deps.rowBorder);
  if (right <= headerWidth || bottom <= headerHeight) return;
  // 太い線を後、同幅なら横を後。設定Recordの列挙順は描画順へ混入しない。
  lines.sort((a, b) => a.border.width - b.border.width || Number(a.horizontal) - Number(b.horizontal));
  // DD-064: 結合範囲の中を通る区間（長軸の [start, end)）。結合が無ければ常に空＝現行と同じ描画。
  const merges = deps.mergedRanges?.();
  const mergeIndex = merges !== undefined && merges.size > 0 ? merges : undefined;
  const seamX = headerWidth + transform.frozenWidth();
  const seamY = headerHeight + transform.frozenHeight();
  const firstVisibleRow = corner.rows.end > corner.rows.start ? corner.rows.start : body.rows.start;
  const firstVisibleCol = corner.cols.end > corner.cols.start ? corner.cols.start : body.cols.start;
  const mergeSkips = (line: Line): Array<[number, number]> => {
    if (mergeIndex === undefined) return [];
    const b = line.boundary;
    // 横線（行の境界 b）は行 b-1 と b の両方を含む結合、縦線（列の境界 b）は列 b-1 と b の両方を含む結合の中を通る。
    const query = line.horizontal
      ? { rowStart: b - 1, rowEnd: b + 1, colStart: firstVisibleCol, colEnd: body.cols.end }
      : { rowStart: firstVisibleRow, rowEnd: body.rows.end, colStart: b - 1, colEnd: b + 1 };
    const skips: Array<[number, number]> = [];
    for (const merge of mergeIndex.intersecting(query)) {
      if (line.horizontal ? !(merge.rowStart < b && b < merge.rowEnd) : !(merge.colStart < b && b < merge.colEnd)) continue;
      // 結合の長軸の区間。固定行列の帯の中に切り詰める（スクロールで固定帯の裏へ回った部分が、固定帯の線を消さないように）。
      if (line.horizontal) {
        const first = transform.columnHeaderRect(merge.colStart);
        const last = transform.columnHeaderRect(merge.colEnd - 1);
        const frozen = merge.colStart < corner.cols.end;
        const s = Math.max(first.x, frozen ? headerWidth : seamX);
        const e = Math.min(last.x + last.width, frozen ? seamX : right);
        if (e > s) skips.push([s, e]);
      } else {
        const first = transform.rowHeaderRect(merge.rowStart);
        const last = transform.rowHeaderRect(merge.rowEnd - 1);
        const frozen = merge.rowStart < corner.rows.end;
        const s = Math.max(first.y, frozen ? headerHeight : seamY);
        const e = Math.min(last.y + last.height, frozen ? seamY : bottom);
        if (e > s) skips.push([s, e]);
      }
    }
    return skips;
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(headerWidth, headerHeight, right - headerWidth, bottom - headerHeight);
  ctx.clip();
  for (const line of lines) {
    const band = borderBand(line.position, line.border.width, dpr);
    // 外周の1device px線もデータ内へ残す（外側だけに位置してclipで消えない）。
    const axisEnd = line.horizontal ? bottom : right;
    const d = normalizeDpr(dpr);
    const bandStart = line.position === axisEnd ? Math.min(band.start, (Math.floor(axisEnd * d) - 1) / d) : band.start;
    const start = Math.max(bandStart, line.clipStart);
    const end = Math.min(bandStart + band.size, line.clipEnd);
    if (end <= start) continue;
    ctx.fillStyle = line.border.color; // gridが実Canvasで検証・正規化済み
    const longStart = line.horizontal ? headerWidth : headerHeight;
    const longEnd = line.horizontal ? right : bottom;
    const segments = subtractIntervals(longStart, longEnd, mergeSkips(line));
    if (!isPatternBorder(line.border)) {
      for (const [s, e] of segments) {
        if (line.horizontal) ctx.fillRect(s, start, e - s, end - start);
        else ctx.fillRect(start, s, end - start, e - s);
      }
      continue;
    }
    // 長軸はデータ領域の画面原点からdevice整数で刻む。pane/scrollで位相を再開しない。
    // strokeのAAやlineCapに依存せず、最小1 device pxの四角い点を描く。
    const pixels = Math.round(band.size * d);
    const on = pixels * (line.border.style === 'dashed' ? 4 : 1);
    const period = on + pixels * 2;
    const origin = Math.round(longStart * d);
    const limit = longEnd * d;
    const whole = segments.length === 1 && segments[0]![0] === longStart && segments[0]![1] === longEnd;
    for (let position = origin; position < limit; position += period) {
      const dotStart = position / d;
      const dotEnd = Math.min(position + on, limit) / d;
      // DD-064: 結合の中の点は描かない（区間に入る部分だけ描く）。区間が線全体なら従来と同じ 1 回の fillRect。
      const pieces = whole ? [[dotStart, dotEnd] as const] : segments.map(([s, e]) => [Math.max(s, dotStart), Math.min(e, dotEnd)] as const);
      for (const [s, e] of pieces) {
        if (e <= s) continue;
        if (line.horizontal) ctx.fillRect(s, start, e - s, end - start);
        else ctx.fillRect(start, s, end - start, e - s);
      }
    }
  }
  ctx.restore();
}
