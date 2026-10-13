import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

async function openFixture(page: Page): Promise<void> {
  await page.goto('/standalone.html?extracols=12');
  await page.waitForFunction(() => window.__integrationTestApi?.ready());
  await page.addStyleTag({ content: '#int-stage { position:fixed; left:17px; top:197.77px; width:1001px; height:501px; border:0; }' });
  await page.evaluate(() => document.fonts.ready);
  await nextFrame(page);
}

async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** toDataURL と full-page screenshot を同じ実画素で比較。DOM 編集欄・overlay は除く。 */
async function comparePixels(page: Page, name: string) {
  const hide = await page.addStyleTag({ content: '.nsheet-stage canvas:nth-of-type(2), .int-cell-editor, .int-conflict-badge { visibility:hidden !important; }' });
  const shot = await page.screenshot();
  const metrics = await page.evaluate(async (base64) => {
    const base = document.querySelector('.nsheet-stage canvas');
    if (!(base instanceof HTMLCanvasElement)) throw new Error('base canvas missing');
    const rect = base.getBoundingClientRect(), dpr = devicePixelRatio;
    const screenImage = new Image(), bitmapImage = new Image();
    screenImage.src = `data:image/png;base64,${base64}`;
    bitmapImage.src = base.toDataURL();
    await Promise.all([screenImage.decode(), bitmapImage.decode()]);
    const screenCanvas = document.createElement('canvas'), bitmapCanvas = document.createElement('canvas');
    screenCanvas.width = screenImage.width; screenCanvas.height = screenImage.height;
    bitmapCanvas.width = base.width; bitmapCanvas.height = base.height;
    const sc = screenCanvas.getContext('2d'), bc = bitmapCanvas.getContext('2d');
    if (sc === null || bc === null) throw new Error('2d context missing');
    sc.drawImage(screenImage, 0, 0);
    bc.fillStyle = 'white'; bc.fillRect(0, 0, base.width, base.height); bc.drawImage(bitmapImage, 0, 0);
    const margin = 4, x = Math.round(rect.left * dpr), y = Math.round(rect.top * dpr);
    // 左側だけでなく右端近くまで比較。stage の clip と scrollbar の領域は除く。
    const width = Math.min(base.width - 32, screenImage.width - x - 32);
    const height = Math.min(350, base.height - 32, screenImage.height - y - 32);
    const screen = sc.getImageData(x + margin, y + margin, width, height).data;
    const bitmap = bc.getImageData(margin, margin, width, height).data;
    if (!bitmap.some((value, index) => index % 4 !== 3 && value < 100)) throw new Error('fixture bitmap has no text');
    let total = 0, max = 0, differentPixels = 0;
    for (let i = 0; i < bitmap.length; i += 4) {
      let pixel = 0;
      for (let c = 0; c < 3; c++) { const delta = Math.abs((bitmap[i+c] ?? 0) - (screen[i+c] ?? 0)); total += delta; pixel += delta; max = Math.max(max, delta); }
      if (pixel > 0) differentPixels++;
    }
    return { dpr, x: rect.left * dpr, y: rect.top * dpr, width, height, mean: total / (width * height * 3), max, differentPixels };
  }, shot.toString('base64'));
  await hide.evaluate(el => el.remove());
  const dir = process.env.DD058_EVIDENCE_DIR;
  if (dir !== undefined) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `bug001-after-${name}.png`), shot);
    writeFileSync(join(dir, `bug001-after-${name}.json`), `${JSON.stringify(metrics, null, 2)}\n`);
  }
  expect(metrics.mean).toBeLessThanOrEqual(1);
  expect(metrics.max).toBeLessThanOrEqual(2); // 線も文字も各画素を保持する（全面平均だけでは薄い二重線を見逃す）。
  expect(metrics.x).toBeCloseTo(Math.round(metrics.x), 4);
  expect(metrics.y).toBeCloseTo(Math.round(metrics.y), 4);
  return metrics;
}

for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
  test(`DD-058 DPR ${dpr}: fractional origin / position-only move`, async ({ browser }) => {
    const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      await openFixture(page);
      await comparePixels(page, `${dpr}`);
      const size = await page.locator('.nsheet-stage').boundingBox();
      await page.locator('#int-stage').evaluate(el => { el.style.left = '17.375px'; el.style.top = '231.145px'; });
      await nextFrame(page);
      const movedSize = await page.locator('.nsheet-stage').boundingBox();
      expect(movedSize?.width).toBe(size?.width);
      expect(movedSize?.height).toBe(size?.height);
      await comparePixels(page, `${dpr}-moved`);
      // 両 canvas の原点が一致し、DOM 編集欄との移動差は実画素の半画素以内。
      const alignment = await page.evaluate(() => {
        const stage = document.querySelector('.nsheet-stage'), canvases = document.querySelectorAll('.nsheet-stage canvas');
        if (stage === null || canvases.length !== 2) throw new Error('scaffold missing');
        const s = stage.getBoundingClientRect(), a = canvases[0]?.getBoundingClientRect(), b = canvases[1]?.getBoundingClientRect();
        if (a === undefined || b === undefined) throw new Error('canvas missing');
        return { x: Math.abs(a.left-s.left)*devicePixelRatio, y: Math.abs(a.top-s.top)*devicePixelRatio, overlayX: a.left-b.left, overlayY: a.top-b.top };
      });
      expect(alignment.x).toBeLessThanOrEqual(0.501);
      expect(alignment.y).toBeLessThanOrEqual(0.501);
      expect(alignment.overlayX).toBe(0);
      expect(alignment.overlayY).toBe(0);
      // 同じ端数のまま整数 px 移動しても補正の相殺を更新する（キャッシュのキーの回帰）。
      await page.locator('#int-stage').evaluate(el => { el.style.left = '21.375px'; el.style.top = '235.145px'; });
      await nextFrame(page);
      await comparePixels(page, `${dpr}-integer-moved`);
    } finally { await context.close(); }
  });
}

test('DD-058 DPR only: backing store reprovision without CSS resize', async ({ browser }) => {
  const context = await browser.newContext({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await openFixture(page);
    await page.evaluate(() => {
      const stage = document.querySelector('.nsheet-stage');
      if (!(stage instanceof HTMLElement)) throw new Error('stage missing');
      stage.dataset.resizeCount = '0';
      new ResizeObserver(() => { stage.dataset.resizeCount = String(Number(stage.dataset.resizeCount) + 1); }).observe(stage);
    });
    await nextFrame(page);
    const count = await page.locator('.nsheet-stage').getAttribute('data-resize-count');
    const cdp = await context.newCDPSession(page);
    for (const dpr of [1.5, 2, 1.25]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: dpr, mobile: false });
      await expect.poll(() => page.locator('.nsheet-stage canvas').first().evaluate(el => el instanceof HTMLCanvasElement ? el.width : -1)).toBe(Math.round(1001*dpr));
      await comparePixels(page, `dpr-change-${dpr}`);
      expect(await page.locator('.nsheet-stage').getAttribute('data-resize-count')).toBe(count);
    }
  } finally { await context.close(); }
});
