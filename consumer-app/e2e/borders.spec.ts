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

for (const facade of ['grid', 'react']) {
  for (const mode of ['standalone', 'collaboration']) {
    test(`DD-048 tarball ${facade}/${mode} 共通点線・追加行・setData・同値draft`, async ({ page }) => {
      await page.goto(`/?borders&patterns&facade=${facade}&mode=${mode}&server=http://127.0.0.1:8791`);
      const editor = page.locator('textarea.int-cell-editor');
      await expect(editor).toBeAttached();
      await expect(page.locator('#status')).toHaveText(mode === 'standalone' ? 'standalone' : 'online');
      const pixels = (y: number) => page.evaluate((y) => {
        const c = document.querySelector('.nsheet-stage canvas') as HTMLCanvasElement;
        return [160, 161].map((x) => Array.from(c.getContext('2d')!.getImageData(x, y, 1, 1).data).join(','));
      }, y);
      await expect.poll(() => pixels(68)).toEqual(['203,213,225,255', '255,255,255,255']);
      await editor.evaluate((e) => { e.dataset.dd048 = 'original'; });
      // 既存r5/row-6の個別線も移動するので、実際に挿入が成立したことを画素で確認する。
      const totalBorder = () => page.evaluate(() => { const c = document.querySelector('.nsheet-stage canvas') as HTMLCanvasElement; return Array.from(c.getContext('2d')!.getImageData(170, 156, 1, 1).data).join(','); });
      await page.getByRole('button', { name: '行を追加', exact: true }).click();
      await expect.poll(totalBorder).toBe('100,116,139,255');
      await expect.poll(() => pixels(68)).toEqual(['203,213,225,255', '255,255,255,255']);
      if (facade === 'react') {
        await editor.focus(); await page.keyboard.press('F2'); await page.keyboard.type('consumer-draft');
        const draft = await editor.inputValue();
        // focusを動かさずReactの再renderだけを起こす。
        await page.getByRole('button', { name: '同値で再描画' }).evaluate((b) => (b as HTMLButtonElement).click());
        await expect(editor).toHaveValue(draft);
        await expect(page.locator('#status')).toHaveText(mode === 'standalone' ? 'standalone' : 'online');
        await page.keyboard.press('Escape');
      }
      if (mode === 'standalone') {
        await page.getByRole('button', { name: 'データを差し替え' }).click();
        await expect.poll(() => pixels(45)).toEqual(['203,213,225,255', '248,251,255,255']);
        await expect.poll(() => totalBorder()).not.toBe('100,116,139,255');
      }
      await expect(editor).toHaveAttribute('data-dd048', 'original');
      if (mode === 'collaboration') {
        await page.getByRole('button', { name: '追加行を削除' }).click();
        await expect.poll(() => page.evaluate(() => { const c = document.querySelector('.nsheet-stage canvas') as HTMLCanvasElement; return Array.from(c.getContext('2d')!.getImageData(170, 134, 1, 1).data).join(','); })).toBe('100,116,139,255');
      }
    });
  }
}
