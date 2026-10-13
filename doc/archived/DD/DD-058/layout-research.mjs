/* global window, document, devicePixelRatio, requestAnimationFrame, URL, console */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 1.25, viewport: { width: 1376, height: 850 } });
const page = await context.newPage();
const historicalHtml = execFileSync('git', ['show', 'f091a5e:apps/playground/poc-b.html'], { encoding: 'utf8' });
await page.setContent(historicalHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''));
const historical = await page.locator('#pocb-base').evaluate(el => {
  const r = el.getBoundingClientRect();
  return { cssX: r.left, cssY: r.top, deviceX: r.left*devicePixelRatio, deviceY: r.top*devicePixelRatio };
});
await page.goto('http://localhost:5199/standalone.html?extracols=12');
await page.waitForFunction(() => window.__integrationTestApi?.ready());
const performance = await page.evaluate(async () => {
  const stage = document.querySelector('.nsheet-stage'), container = document.querySelector('#int-stage');
  const original = stage.getBoundingClientRect.bind(stage);
  let samples = [];
  stage.getBoundingClientRect = () => { const start = window.performance.now(); const rect = original(); samples.push(window.performance.now()-start); return rect; };
  const results = [];
  for (const mode of ['idle', 'moving']) {
    samples = [];
    for (let i=0;i<120;i++) {
      if (mode === 'moving') container.style.left = `${i%7/8}px`;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    const sorted = [...samples].sort((a,b)=>a-b);
    results.push({ mode, reads: samples.length, meanMs: samples.reduce((a,b)=>a+b,0)/samples.length, p95Ms:sorted[Math.floor(sorted.length*.95)], maxMs: sorted.at(-1) });
  }
  stage.getBoundingClientRect = original;
  return results;
});
const report = { browser: browser.version(), historical, performance };
writeFileSync(new URL('layout-research.json', import.meta.url), JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
await browser.close();
