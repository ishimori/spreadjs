import { devicePixelOffset, normalizeDpr } from '@nanairo-sheet/render';

/** stage の論理座標は保ち、base/overlay の表示だけを同じ実画素へそろえる。 */
export function createCanvasLayout(
  stage: HTMLElement,
  canvases: readonly HTMLCanvasElement[],
  onDprChange: () => void,
): { sync(): void } {
  let previousDpr = normalizeDpr(window.devicePixelRatio);
  let previousX: number | undefined;
  let previousY: number | undefined;
  let previousLeft: number | undefined;
  let previousTop: number | undefined;
  return {
    sync(): void {
      const dpr = normalizeDpr(window.devicePixelRatio);
      if (dpr !== previousDpr) {
        previousDpr = dpr;
        onDprChange(); // CSS サイズが同じでも backing store と文字測定を更新する。
      }
      // ResizeObserver は位置だけの変化を拾わない。既存 rAF の先頭で 1 回だけ読む。
      const rect = stage.getBoundingClientRect();
      const x = devicePixelOffset(rect.left, dpr);
      const y = devicePixelOffset(rect.top, dpr);
      if (x === previousX && y === previousY && rect.left === previousLeft && rect.top === previousTop) return;
      previousX = x;
      previousY = y;
      previousLeft = rect.left;
      previousTop = rect.top;
      for (const canvas of canvases) {
        // Chrome では端数原点への translate だけだと画素のずれが残る。
        // 一度 viewport の (0,0) を描画原点にしてから整数実画素へ移すと、
        // 移動後も bitmap が 1:1 で合成される（DD-058 Phase 0 の実測）。
        // left/top と transform の合計による実際の移動量は最大半画素。
        canvas.style.left = `${-rect.left}px`;
        canvas.style.top = `${-rect.top}px`;
        canvas.style.transform = `translate(${rect.left+x}px, ${rect.top+y}px)`;
      }
    },
  };
}
