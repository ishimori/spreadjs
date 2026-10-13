// grid Facade の DOM scaffold（D4: Facade が container 内部に Canvas/scroller/spacer を構築する）。
//
// consumer は size 済みの container を 1 つ渡すだけでよい。旧 poc-integration.html の #int-stage/#int-base/
// #int-overlay/#int-scroller/#int-spacer 構造（§13.1: DOM viewport〔native scroll〕＋ spacer ＋ viewport 同サイズ
// 固定 Canvas）を Facade が動的に生成する。常駐 textarea・競合 badge は integration-editor が stage 上へ生成する。

export interface GridScaffold {
  readonly stage: HTMLDivElement;
  readonly baseCanvas: HTMLCanvasElement;
  readonly overlayCanvas: HTMLCanvasElement;
  readonly scroller: HTMLDivElement;
  readonly spacer: HTMLDivElement;
  readonly baseCtx: CanvasRenderingContext2D;
  readonly overlayCtx: CanvasRenderingContext2D;
  /** container から scaffold DOM を除去する（destroy 用）。 */
  dispose(): void;
}

function require2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('@nanairo-sheet/grid: Canvas 2D コンテキストを取得できません');
  }
  return ctx;
}

/** container 内へ stage（position:relative）＋ base/overlay canvas ＋ scroller>spacer を構築する。 */
export function buildScaffold(container: HTMLElement): GridScaffold {
  const stage = document.createElement('div');
  stage.className = 'nsheet-stage';
  stage.style.position = 'relative';
  stage.style.width = '100%';
  stage.style.height = '100%';
  stage.style.overflow = 'hidden';

  const baseCanvas = document.createElement('canvas');
  const overlayCanvas = document.createElement('canvas');
  for (const canvas of [baseCanvas, overlayCanvas]) {
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.display = 'block';
    // DD-058: bitmap は DPR で描画済み。合成時の再補間を抑える（原点補正と併用）。
    canvas.style.imageRendering = 'pixelated';
  }

  const scroller = document.createElement('div');
  scroller.className = 'nsheet-scroller';
  scroller.style.position = 'absolute';
  scroller.style.inset = '0';
  scroller.style.overflow = 'auto';

  const spacer = document.createElement('div');
  spacer.className = 'nsheet-spacer';
  spacer.style.width = '1px';
  spacer.style.height = '1px';
  scroller.appendChild(spacer);

  stage.appendChild(baseCanvas);
  stage.appendChild(overlayCanvas);
  stage.appendChild(scroller);
  container.appendChild(stage);

  return {
    stage,
    baseCanvas,
    overlayCanvas,
    scroller,
    spacer,
    baseCtx: require2dContext(baseCanvas),
    overlayCtx: require2dContext(overlayCanvas),
    dispose: () => {
      stage.remove();
    },
  };
}
