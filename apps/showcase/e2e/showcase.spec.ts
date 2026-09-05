// showcase 起動＋主要導線 smoke（DD-017-2 AC3/AC4/AC5/AC7）。
// カタログ表示（features.json → DOM 導通）→「デモを見る」→ グリッド接続まで通す。
import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

const WS_ORIGIN = 'http://127.0.0.1:8801'; // playwright.config.ts の WS_PORT と一致させる

interface FeatureEntry {
  id: string;
  title: string;
  status: string;
  demo?: string;
}
// Node ESM の JSON import は import attribute が必要で Playwright の transpile と相性が悪いため fs で読む
const features = (
  JSON.parse(readFileSync(new URL('../src/features.json', import.meta.url), 'utf8')) as {
    features: FeatureEntry[];
  }
).features;

test('カタログ: features.json の全機能がカードとして描画される（3区分・AC5 導通）', async ({ page }) => {
  await page.goto('/index.html');

  await expect(page.locator('h1')).toContainText('Nanairo Sheet');

  // features.json を1件変えれば期待値も変わる＝データ→表示の導通そのものを検証する
  for (const status of ['available', 'planned', 'out-of-scope'] as const) {
    const expected = features.filter((f) => f.status === status);
    const cards = page.locator(`#grid-${status} .card`);
    await expect(cards).toHaveCount(expected.length);
  }

  // 代表カードの title/summary が features.json 由来で表示される
  const first = features.find((f) => f.status === 'available')!;
  await expect(page.locator(`[data-feature-id="${first.id}"] h3`)).toContainText(first.title);

  // 「デモを見る」リンクが demo 付き機能の数だけある
  const demoCount = features.filter((f) => f.demo !== undefined).length;
  await expect(page.locator('#grid-available a.demo')).toHaveCount(demoCount);
});

test('デモ: カタログ→デモページ遷移でグリッドが接続・描画される（AC4）', async ({ page }) => {
  await page.goto(`/demo.html?scenario=collab&server=${WS_ORIGIN}`);

  // シナリオパネルが表示される
  await expect(page.locator('#scenario-title')).toContainText('リアルタイム共同編集');
  await expect(page.locator('#scenario-steps li').first()).toBeVisible();

  // Facade mount → /config → WS 接続 → オンライン表示（50,000行シードの bootstrap 込み）
  await expect(page.locator('#conn')).toHaveClass(/online/, { timeout: 30_000 });

  // Facade が container 内に Canvas を構築している
  await expect(page.locator('#stage canvas').first()).toBeVisible();
});

test('デモ: 全シナリオのページが開けてパネルが表示される（AC4）', async ({ page }) => {
  for (const feature of features) {
    if (feature.demo === undefined) continue;
    const scenarioId = /scenario=([a-z-]+)$/.exec(feature.demo)![1]!;
    await page.goto(`/demo.html?scenario=${scenarioId}&server=${WS_ORIGIN}`);
    await expect(page.locator('#scenario-title')).not.toBeEmpty();
    await expect(page.locator('#stage canvas').first()).toBeVisible({ timeout: 30_000 });
  }
});

test('DD-047: matrix-viewの実シードIDで行帯・行列罫線が描かれる', async ({ page }) => {
  await page.goto(`/demo.html?scenario=matrix-view&server=${WS_ORIGIN}`);
  await expect(page.locator('#conn')).toHaveClass(/online/);
  await expect(page.locator('textarea.int-cell-editor')).toBeAttached();
  const pixel = (x: number, y: number) => page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('.nsheet-stage canvas') as HTMLCanvasElement;
    return Array.from(canvas.getContext('2d')!.getImageData(x, y, 1, 1).data).slice(0, 3).join(',');
  }, { x, y });
  await expect.poll(() => pixel(532, 100)).toBe('148,163,184');
  // onlineは初期replayより先に届く。実データ描画後にscrollが成立したことを確認する。
  await expect.poll(() => page.evaluate(() => {
    const s = document.querySelector('.nsheet-scroller');
    if (!(s instanceof HTMLElement)) return -1;
    s.scrollTop = 500;
    return s.scrollTop;
  })).toBe(500);
  await expect.poll(() => pixel(600, 184)).toBe('100,116,139');
  expect(await pixel(600, 190)).toBe('229,231,235');
});
