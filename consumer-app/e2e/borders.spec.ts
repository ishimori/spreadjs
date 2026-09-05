import { expect, test } from '@playwright/test';

for (const facade of ['grid', 'react']) {
  for (const mode of ['standalone', 'collaboration']) {
    test(`DD-047 tarball ${facade}/${mode} 公開APIで罫線を描画`, async ({ page }) => {
      await page.goto(`/?borders&facade=${facade}&mode=${mode}&server=http://127.0.0.1:8791`);
      await expect(page.locator('textarea.int-cell-editor')).toBeAttached();
      await expect(page.locator('#status')).toHaveText(mode === 'standalone' ? 'standalone' : 'online');
      await expect.poll(() => page.evaluate(() => {
        const canvas = document.querySelector('.nsheet-stage canvas') as HTMLCanvasElement;
        return Array.from(canvas.getContext('2d')!.getImageData(212, 110, 1, 1).data).join(',');
      })).toBe('100,116,139,255');
      await expect.poll(() => page.evaluate(() => {
          const canvas = document.querySelector('.nsheet-stage canvas') as HTMLCanvasElement;
          return Array.from(canvas.getContext('2d')!.getImageData(170, 134, 1, 1).data).join(',');
      })).toBe('100,116,139,255');
    });
  }
}
