/* global window, document, devicePixelRatio, requestAnimationFrame, Image, URL, console */
// DD-058 compositor experiment. Pauses only the grid rAF after first draw so
// each candidate can be measured independently, including on the fixed SDK.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const browser = await chromium.launch();
const results = [];
for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
  const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  let patches = 0;
  // ブラウザー内だけで DD-058 の配置呼び出しと CSS 指定を外す。
  // 作業ツリーや並行する回帰テストには触れず、修正前の描画経路を再現する。
  await page.route('**/packages/grid/src/*.ts*', async route => {
    const response = await route.fetch();
    let body = await response.text();
    if (route.request().url().includes('/mount-controller.ts')) {
      if (!body.includes('canvasLayout.sync();')) throw new Error('baseline patch target missing');
      body = body.replaceAll('canvasLayout.sync();','').replaceAll('${backing.width / dpr}px','${viewportWidth}px').replaceAll('${backing.height / dpr}px','${viewportHeight}px');
      patches++;
    }
    if (route.request().url().includes('/dom-scaffold.ts')) {
      const pattern = /canvas\.style\.imageRendering = ["']pixelated["'];?/;
      if (!pattern.test(body)) throw new Error('baseline CSS target missing');
      body = body.replace(pattern,'');
      patches++;
    }
    await route.fulfill({response,body});
  });
  await page.goto('http://localhost:5199/standalone.html');
  await page.waitForFunction(() => window.__integrationTestApi?.ready());
  if (patches !== 2) throw new Error(`baseline patch count ${patches}, expected 2`);
  await page.addStyleTag({ content: '#int-stage { position:fixed; left:17px; top:197.77px; width:1000px; height:500px; border:0; } .int-cell-editor, .int-conflict-badge { visibility:hidden; }' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const frame = window.requestAnimationFrame.bind(window);
    // ResizeObserver の再確保後に dirty viewport を描き切ってから止める。
    await new Promise(resolve => frame(() => frame(() => frame(resolve))));
    window.requestAnimationFrame = callback => frame(time => { if (callback.name !== 'masterLoop') callback(time); });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  for (const method of ['none', 'left-top', 'translate', 'pixelated', 'pixelated-translate', 'origin-zero']) {
    await page.evaluate(method => {
      const stage = document.querySelector('.nsheet-stage');
      const rect = stage.getBoundingClientRect(), d = devicePixelRatio;
      const x = Math.round(rect.left*d)/d - rect.left, y = Math.round(rect.top*d)/d - rect.top;
      for (const [i, canvas] of [...stage.querySelectorAll('canvas')].entries()) {
        canvas.style.visibility = i === 0 ? 'visible' : 'hidden';
        canvas.style.imageRendering = method.includes('pixelated') || method === 'origin-zero' ? 'pixelated' : 'auto';
        canvas.style.left = '0'; canvas.style.top = '0'; canvas.style.transform = '';
        if (method === 'left-top') { canvas.style.left = `${x}px`; canvas.style.top = `${y}px`; }
        if (method.endsWith('translate')) canvas.style.transform = `translate(${x}px,${y}px)`;
        if (method === 'origin-zero') {
          canvas.style.left = `${-rect.left}px`; canvas.style.top = `${-rect.top}px`;
          canvas.style.transform = `translate(${rect.left+x}px,${rect.top+y}px)`;
        }
      }
    }, method);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const shot = await page.screenshot();
    const metric = await page.evaluate(async base64 => {
      const base = document.querySelector('.nsheet-stage canvas'), rect = base.getBoundingClientRect(), d = devicePixelRatio;
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const screenshot = document.createElement('canvas'); screenshot.width = image.width; screenshot.height = image.height;
      const sc = screenshot.getContext('2d'); sc.drawImage(image,0,0);
      const bitmap = document.createElement('canvas'); bitmap.width = base.width; bitmap.height = base.height;
      const bc = bitmap.getContext('2d'); bc.fillStyle = 'white'; bc.fillRect(0,0,base.width,base.height); bc.drawImage(base,0,0);
      const w=600, h=200, margin=4;
      const screen = sc.getImageData(Math.round(rect.left*d)+margin,Math.round(rect.top*d)+margin,w,h).data;
      const data = bc.getImageData(margin,margin,w,h).data;
      let diff=0, max=0, mismatched=0;
      for(let i=0;i<data.length;i+=4) { let pixel=0; for(let c=0;c<3;c++) { const v=Math.abs(data[i+c]-screen[i+c]); diff+=v; max=Math.max(max,v); pixel+=v; } if(pixel) mismatched++; }
      if (!data.some((value,index)=>index%4 !== 3 && value < 100)) throw new Error('blank fixture bitmap');
      return { x:rect.left*d, y:rect.top*d, mean:diff/(w*h*3), max, mismatched };
    }, shot.toString('base64'));
    results.push({dpr,method,...metric});
    if (method === 'none' || method === 'origin-zero') writeFileSync(new URL(`bug001-${method === 'none' ? 'before' : 'candidate'}-${dpr}.png`,import.meta.url),shot);
  }
  await context.close();
}
const version = browser.version();
await browser.close();
writeFileSync(new URL('phase0.json',import.meta.url),JSON.stringify({browser:version,results},null,2));
console.table(results.map(({dpr,method,mean,max})=>({dpr,method,mean,max})));
