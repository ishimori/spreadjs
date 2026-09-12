import { describe, expect, it } from 'vitest';

import { computePopupPlacement } from './popup-placement';

const AREA = { width: 1000, height: 600 };

function cellAt(x: number, y: number): { x: number; y: number; width: number; height: number } {
  return { x, y, width: 80, height: 22 };
}

describe('computePopupPlacement: 縦の置き方（DD-055 論点1）', () => {
  it('下の余白に入りきるなら従来どおりセルの真下に開き、下の余白を高さの上限にする', () => {
    expect(
      computePopupPlacement({ cellRect: cellAt(100, 200), popupWidth: 120, popupHeight: 150, visibleArea: AREA }),
    ).toEqual({ direction: 'down', left: 100, top: 222, maxHeight: 378 });
  });

  it('下の余白に入りきらず上の余白のほうが広ければ、候補欄の下端をセルの上端に揃えて上に開く', () => {
    // セルの下端 572 → 下の余白 28・上の余白 550。
    expect(
      computePopupPlacement({ cellRect: cellAt(100, 550), popupWidth: 120, popupHeight: 150, visibleArea: AREA }),
    ).toEqual({ direction: 'up', left: 100, top: 400, maxHeight: 550 });
  });

  it('入りきらなくても下の余白が上と同じなら下に開き、下の余白の高さに収める', () => {
    // 可視域 300: セルの上端 139 → 上の余白 139・下の余白 300-161=139。
    expect(
      computePopupPlacement({
        cellRect: cellAt(0, 139),
        popupWidth: 80,
        popupHeight: 220,
        visibleArea: { width: 500, height: 300 },
      }),
    ).toEqual({ direction: 'down', left: 0, top: 161, maxHeight: 139 });
  });

  it('上下どちらの余白も足りなければ広い側に開き、高さはその余白に収める（上に開くときは収めた高さの分だけ上へ置く）', () => {
    // 可視域 300: セルの上端 160 → 上の余白 160・下の余白 118。
    expect(
      computePopupPlacement({
        cellRect: cellAt(0, 160),
        popupWidth: 80,
        popupHeight: 220,
        visibleArea: { width: 500, height: 300 },
      }),
    ).toEqual({ direction: 'up', left: 0, top: 0, maxHeight: 160 });
  });

  it('下端は渡された可視域（横スクロールバーを除いた高さ）で判定する', () => {
    // stage の高さなら入る位置（615-462=153≥150）でも、可視域 600 では下の余白 138 → 上に開く。
    expect(
      computePopupPlacement({ cellRect: cellAt(0, 440), popupWidth: 80, popupHeight: 150, visibleArea: AREA }).direction,
    ).toBe('up');
  });

  it('セルが可視域の下端からはみ出していれば下の余白は 0 として扱う', () => {
    expect(
      computePopupPlacement({ cellRect: cellAt(0, 590), popupWidth: 80, popupHeight: 72, visibleArea: AREA }),
    ).toEqual({ direction: 'up', left: 0, top: 518, maxHeight: 590 });
  });
});

describe('computePopupPlacement: 向きの保持（DD-055 論点2）', () => {
  it('上向きを渡すと、下に入りきる位置へスクロールしても上向きのまま下端をセルの上端に揃える', () => {
    expect(
      computePopupPlacement({
        cellRect: cellAt(100, 300),
        popupWidth: 120,
        popupHeight: 72,
        visibleArea: AREA,
        direction: 'up',
      }),
    ).toEqual({ direction: 'up', left: 100, top: 228, maxHeight: 300 });
  });

  it('上向きのまま候補が絞り込まれて低くなっても、下端はセルの上端から離れない', () => {
    const cellRect = cellAt(100, 550);
    const tall = computePopupPlacement({ cellRect, popupWidth: 120, popupHeight: 72, visibleArea: AREA, direction: 'up' });
    const short = computePopupPlacement({ cellRect, popupWidth: 120, popupHeight: 25, visibleArea: AREA, direction: 'up' });
    expect(tall.top + 72).toBe(550);
    expect(short.top + 25).toBe(550);
  });

  it('下向きを渡すと、下端近くへスクロールしても上へ開き直さず下の余白の高さへ縮める', () => {
    expect(
      computePopupPlacement({
        cellRect: cellAt(100, 550),
        popupWidth: 120,
        popupHeight: 150,
        visibleArea: AREA,
        direction: 'down',
      }),
    ).toEqual({ direction: 'down', left: 100, top: 572, maxHeight: 28 });
  });
});

describe('computePopupPlacement: 横のはみ出し（DD-055 論点3）', () => {
  it('可視域の右端を越えるなら右端に揃うまで左へずらす', () => {
    expect(
      computePopupPlacement({ cellRect: cellAt(900, 100), popupWidth: 224, popupHeight: 200, visibleArea: AREA }).left,
    ).toBe(776);
  });

  it('右端を越えなければセルの左端のまま', () => {
    expect(
      computePopupPlacement({ cellRect: cellAt(776, 100), popupWidth: 224, popupHeight: 200, visibleArea: AREA }).left,
    ).toBe(776);
  });

  it('候補欄が可視域より広いときは左端 0 でクランプする', () => {
    expect(
      computePopupPlacement({ cellRect: cellAt(300, 100), popupWidth: 1200, popupHeight: 200, visibleArea: AREA }).left,
    ).toBe(0);
  });
});
