// DD-047: 可視境界だけを解決し、全paneの背景・文字の後に描く。gridの公開型へ依存しない。
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
}

/** 幅も位置もdevice整数へ。奇数幅は境界の右/下側へ0.5 device px寄せる。 */
export function borderBand(position: number, width: number, dpr: number): { start: number; size: number } {
  const d = normalizeDpr(dpr);
  const pixels = Math.max(1, Math.round(width * d));
  return { start: (Math.round(position * d) - Math.floor(pixels / 2)) / d, size: pixels / d };
}

interface Line {
  readonly horizontal: boolean;
  readonly position: number;
  readonly clipStart: number;
  readonly clipEnd: number;
  readonly border: BoundaryBorder;
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
        lines.push({ horizontal, position, clipStart, clipEnd, border });
      }
    }
    rangeLines(frozen, start, Math.min(seam, end));
    rangeLines(scroll, seam, end);
    if (frozenSize > 0 && seam <= end) {
      const border = getBorder(frozen.end);
      if (border !== undefined) lines.push({ horizontal, position: seam, clipStart: start, clipEnd: end, border });
    }
    return end;
  }
  const right = collect(false, corner.cols, body.cols, headerWidth, frame.viewportWidth, transform.frozenWidth(), deps.columnBorder);
  const bottom = collect(true, corner.rows, body.rows, headerHeight, frame.viewportHeight, transform.frozenHeight(), deps.rowBorder);
  if (right <= headerWidth || bottom <= headerHeight) return;
  // 太い線を後、同幅なら横を後。設定Recordの列挙順は描画順へ混入しない。
  lines.sort((a, b) => a.border.width - b.border.width || Number(a.horizontal) - Number(b.horizontal));
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
    if (!isPatternBorder(line.border)) {
      if (line.horizontal) ctx.fillRect(headerWidth, start, right - headerWidth, end - start);
      else ctx.fillRect(start, headerHeight, end - start, bottom - headerHeight);
      continue;
    }
    // 長軸はデータ領域の画面原点からdevice整数で刻む。pane/scrollで位相を再開しない。
    // strokeのAAやlineCapに依存せず、最小1 device pxの四角い点を描く。
    const pixels = Math.round(band.size * d);
    const on = pixels * (line.border.style === 'dashed' ? 4 : 1);
    const period = on + pixels * 2;
    const origin = Math.round((line.horizontal ? headerWidth : headerHeight) * d);
    const limit = (line.horizontal ? right : bottom) * d;
    for (let position = origin; position < limit; position += period) {
      const size = Math.min(on, limit - position) / d;
      if (line.horizontal) ctx.fillRect(position / d, start, size, end - start);
      else ctx.fillRect(start, position / d, end - start, size);
    }
  }
  ctx.restore();
}
