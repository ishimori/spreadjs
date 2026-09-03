// overlay レイヤー描画（計画書 §12.1）: 選択枠・ドラッグ範囲・Presence（他者の activeCell 枠＋
// selection＋名前タグ）。base とは別 Canvas で、選択・Presence 変更時に base を再描画しない。
// 座標は base と同じ ViewportTransform を使い、base/overlay のセル位置を一致させる。
//
// 固定行列をまたぐ範囲（選択・Presence）は 4 象限 pane ごとに分割し、各 pane の clip 内で描く
// （固定側始点とスクロール側終点を単一矩形で結ぶと横スクロールで幅が負になり表示が消えるため。Codex 指摘）。
// **単一セルの描画（Presence の activeCell 枠・名前タグ）も同じ経路を通す**。content 全域を 1 枚で clip
// すると、固定帯の裏へ回った他者のセルが固定ペインの上へ描かれる（DD-041。DD-039 と同根）。
// Canvas API 依存の描画アダプタ。単体検証は座標側（viewport）と RenderScheduler の振り分けで担保する。

import type { FrameViewport } from './base-layer';
import { deviceLineWidth, snapToDevice } from './dpi';
import type { PresenceUser } from './presence-sim';
import type { CellRange } from '@nanairo-sheet/selection';
import type { CellRect, ViewportTransform } from './viewport';

/** Presence の色パレット（colorKey で参照）。 */
export const PRESENCE_PALETTE = [
  '#d93025',
  '#1a73e8',
  '#188038',
  '#e37400',
  '#9334e6',
  '#00897b',
  '#c5221f',
  '#7b5800',
] as const;

export interface OverlayLayerColors {
  readonly selectionStroke: string;
  readonly selectionFill: string;
  readonly dragStroke: string;
}

export const DEFAULT_OVERLAY_COLORS: OverlayLayerColors = {
  selectionStroke: '#1a73e8',
  selectionFill: 'rgba(26,115,232,0.12)',
  dragStroke: '#0b57d0',
};

export interface OverlayLayerDeps {
  readonly ctx: CanvasRenderingContext2D;
  readonly headerWidth: number;
  readonly headerHeight: number;
  readonly colors?: OverlayLayerColors;
}

export interface OverlayFrame extends FrameViewport {
  readonly selection: CellRange | null;
  readonly dragRange: CellRange | null;
  readonly presences: readonly PresenceUser[];
}

export interface OverlayLayer {
  draw(frame: OverlayFrame): void;
}

/** 範囲を pane と交差させて得た、pane clip 付きの矩形片。 */
interface RangePiece {
  readonly rect: CellRect;
  readonly clip: CellRect;
}

/** range を各 pane と交差させ、pane ごとに 1 つの矩形片へ変換する（空交差は除外）。 */
function rangePiecesAcrossPanes(transform: ViewportTransform, range: CellRange): RangePiece[] {
  const pieces: RangePiece[] = [];
  for (const pane of transform.panes()) {
    const rowStart = Math.max(range.rowStart, pane.rows.start);
    const rowEnd = Math.min(range.rowEnd, pane.rows.end);
    const colStart = Math.max(range.colStart, pane.cols.start);
    const colEnd = Math.min(range.colEnd, pane.cols.end);
    if (rowEnd <= rowStart || colEnd <= colStart) {
      continue;
    }
    // pane 内なので frozen/scroll が混ざらず cellRect は単調（幅が負にならない）。
    const tl = transform.cellRect(rowStart, colStart);
    const br = transform.cellRect(rowEnd - 1, colEnd - 1);
    pieces.push({
      rect: { x: tl.x, y: tl.y, width: br.x + br.width - tl.x, height: br.y + br.height - tl.y },
      clip: pane.clip,
    });
  }
  return pieces;
}

export function createOverlayLayer(deps: OverlayLayerDeps): OverlayLayer {
  // headerWidth/headerHeight は DD-041 で未使用になった（clip は全て pane 側が持つ）が、
  // 公開 deps の形は base-layer と揃えたまま保つ（.d.ts 契約を壊さない）。
  const { ctx } = deps;
  const colors = deps.colors ?? DEFAULT_OVERLAY_COLORS;

  const withClip = (clip: CellRect, draw: () => void): void => {
    if (clip.width <= 0 || clip.height <= 0) {
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.width, clip.height);
    ctx.clip();
    draw();
    ctx.restore();
  };

  const drawSelection = (frame: OverlayFrame): void => {
    if (frame.selection === null) {
      return;
    }
    for (const piece of rangePiecesAcrossPanes(frame.transform, frame.selection)) {
      withClip(piece.clip, () => {
        ctx.fillStyle = colors.selectionFill;
        ctx.fillRect(piece.rect.x, piece.rect.y, piece.rect.width, piece.rect.height);
        ctx.strokeStyle = colors.selectionStroke;
        ctx.lineWidth = Math.max(2 * deviceLineWidth(frame.dpr), 1.5);
        ctx.strokeRect(
          snapToDevice(piece.rect.x, frame.dpr),
          snapToDevice(piece.rect.y, frame.dpr),
          piece.rect.width,
          piece.rect.height,
        );
      });
    }
  };

  const drawDrag = (frame: OverlayFrame): void => {
    if (frame.dragRange === null) {
      return;
    }
    for (const piece of rangePiecesAcrossPanes(frame.transform, frame.dragRange)) {
      withClip(piece.clip, () => {
        ctx.strokeStyle = colors.dragStroke;
        ctx.lineWidth = deviceLineWidth(frame.dpr);
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(
          snapToDevice(piece.rect.x, frame.dpr),
          snapToDevice(piece.rect.y, frame.dpr),
          piece.rect.width,
          piece.rect.height,
        );
        ctx.setLineDash([]);
      });
    }
  };

  const drawPresence = (frame: OverlayFrame): void => {
    for (const user of frame.presences) {
      const color = PRESENCE_PALETTE[user.colorKey % PRESENCE_PALETTE.length] ?? '#888';
      // 選択範囲の淡いハイライト（pane 分割）。
      const selRange: CellRange = {
        rowStart: user.selRowStart,
        rowEnd: user.selRowEnd,
        colStart: user.selColStart,
        colEnd: user.selColEnd,
      };
      for (const piece of rangePiecesAcrossPanes(frame.transform, selRange)) {
        withClip(piece.clip, () => {
          ctx.globalAlpha = 0.1;
          ctx.fillStyle = color;
          ctx.fillRect(piece.rect.x, piece.rect.y, piece.rect.width, piece.rect.height);
          ctx.globalAlpha = 1;
        });
      }
      // activeCell 枠＋名前タグ。単一セルも「所属 pane と交差させて得た clip」で描く（DD-041）。
      // content 全域の単一 clip だと、固定帯の裏へ回った他者のセル矩形が固定ペインの内側に落ち、
      // 枠とタグが固定行列の上へ重なる（選択ハイライトと同じ経路に揃え、pane 判定を二重に持たない）。
      // 半開区間なので単一セルは [r, r+1) × [c, c+1)。可視範囲外なら piece は 0 個＝何も描かない。
      const activeRange: CellRange = {
        rowStart: user.activeRow,
        rowEnd: user.activeRow + 1,
        colStart: user.activeCol,
        colEnd: user.activeCol + 1,
      };
      for (const piece of rangePiecesAcrossPanes(frame.transform, activeRange)) {
        const active = piece.rect;
        withClip(piece.clip, () => {
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(2 * deviceLineWidth(frame.dpr), 1.5);
          ctx.strokeRect(
            snapToDevice(active.x, frame.dpr),
            snapToDevice(active.y, frame.dpr),
            active.width,
            active.height,
          );
          ctx.textBaseline = 'bottom';
          ctx.textAlign = 'left';
          ctx.font = '11px system-ui, sans-serif';
          const label = user.displayName;
          const tagWidth = ctx.measureText(label).width + 8;
          const tagHeight = 14;
          const tagY = active.y - tagHeight;
          ctx.fillStyle = color;
          ctx.fillRect(active.x, tagY, tagWidth, tagHeight);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(label, active.x + 4, tagY + tagHeight - 2);
        });
      }
    }
  };

  return {
    draw(frame) {
      ctx.clearRect(0, 0, frame.viewportWidth, frame.viewportHeight);
      drawSelection(frame);
      drawDrag(frame);
      drawPresence(frame);
    },
  };
}
