import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

// DD-002 Phase 5 / DD-005 Phase 4: E2E（Playwright）。
//
// 対象環境:
//   - PoC-A 環境（index.html = 20×10 グリッド + 常駐 textarea + 編集状態機械）… DD-002 の
//     basic-operations / synthetic-composition / regression。Vite のみで動く。
//   - 統合PoC 環境（poc-integration.html = ClientSession 単一正本 + Canvas + IME）… DD-005 の
//     integration-scenario。**実 WS サーバー（integration seed・50,000行×200列）** ＋ Vite の 2 サーバーが要る。
// vitest（src/**/*.test.ts, node 環境）とは分離する（命名 .test.ts / .spec.ts ＋ testDir=e2e/）。
//
// Vite は明示ポート 5199 + strictPort で起動し、ポート衝突時は黙って別ポートへ逃げず即失敗させる
// （baseURL とズレて検証が空振りするのを防ぐ）。ランタイム依存は増やさない（Playwright は devDependencies のみ）。

const PORT = 5199;
const BASE_URL = `http://localhost:${PORT}`;

// DD-005 統合 E2E 専用の WS サーバーポート。手動 dev（既定 8787）と衝突しない専用ポートを使い、
// 並行セッションの dev サーバーを誤って reuse しない（integration seed の有無で挙動が変わるため）。
// integration-scenario.spec.ts の WS_ORIGIN と一致させること（ズレたら接続失敗で即赤くなる）。
const WS_PORT = 8799;

// DD-043 複数文書 E2E 専用の WS サーバーポート（2 文書を 1 プロセスで serve）。統合 E2E（8799）とは
// 文書構成が違うため別プロセスで立てる。multi-document.spec.ts の WS_ORIGIN_MULTI と一致させること。
const MULTI_DOC_WS_PORT = 8801;

// 統合 E2E の WS サーバーは @nanairo-sheet/server-hono（DD-016 で collaboration-server を昇華）。
const serverHonoDir = fileURLToPath(new URL('../../packages/server-hono', import.meta.url));

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  // 共有状態（統合 E2E は 1 つの WS サーバー文書を共有する）を持つため直列実行し、決定的にする。
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  outputDir: 'test-results',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: [
    {
      // 設定ファイルの位置（apps/playground）が cwd。playground の `dev` = vite を明示ポートで起動。
      // 統合デモ（poc-integration.html）を readiness url にする（PoC-A の index.html は DD-016 で削除ゆえ '/' は 404）。
      command: `npm run dev -- --port ${PORT} --strictPort`,
      url: `${BASE_URL}/poc-integration.html`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // 統合 E2E 用の実 WS サーバー（`dev:integration` = 50,000行×200列シードを投入）。
      // PORT を専用ポートへ上書きし、health エンドポイントの応答で起動完了を待つ。
      // SEED_NONEMPTY で非空セル数を絞る: **行数 50,000 は保ったまま**初期 replay を軽くして E2E を安定・高速化する
      // （機能成立の検証がスコープ・データ密度検証は DD-004/006 担当。既定 dev:integration は 100,000 のまま）。
      command: 'npm run dev:integration',
      cwd: serverHonoDir,
      env: { PORT: String(WS_PORT), SEED_NONEMPTY: '3000' },
      url: `http://127.0.0.1:${WS_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // DD-043 複数文書 E2E 用サーバー（doc-a / doc-b を 1 プロセスで serve）。シードは小さく起動は速い。
      command: 'npm run dev:multi-document',
      cwd: serverHonoDir,
      env: { PORT: String(MULTI_DOC_WS_PORT) },
      url: `http://127.0.0.1:${MULTI_DOC_WS_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
