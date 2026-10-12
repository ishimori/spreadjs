// DD-056 H11（操作ごとの書込の認可 authorizeOperation）の dev / E2E 用起動スクリプト（公開 API serve() の consumer として書く）。
//
// consumer が持つ「書込禁止中の文書」の集合を Set で模し、authorizeOperation で拒否する（広島空港 PoC の締切・確定の最小形）。
// E2E が禁止の前後を作れるよう、別ポートの制御口（POST /lock・POST /unlock・GET /health。`?documentId=` 省略時は既定文書）で
// 集合を切り替える。制御口は本スクリプトだけのもので、SDK の HTTP 面には足さない。
//
// 起動: `npm run dev:authorize --workspace packages/server-hono`（PORT で待受、CONTROL_PORT で制御口のポートを上書き）

import { createServer } from 'node:http';
import process from 'node:process';

import { serve } from './index';

const DEFAULT_PORT = 8803; // 単一文書 dev（8787）・統合 E2E（8799）・複数文書 E2E（8801）と非衝突

const port = Number(process.env.PORT ?? DEFAULT_PORT);
const controlPort = Number(process.env.CONTROL_PORT ?? port + 1);
const lockedDocuments = new Set<string>();

serve({
  port,
  seedRows: 5,
  authorizeOperation: ({ documentId }) => !lockedDocuments.has(documentId),
  onDiagnostic: (entry) => {
    if (entry.level === 'error' || entry.level === 'warn') {
      process.stderr.write(`[${entry.level}] ${entry.code}: ${entry.message}\n`);
    }
  },
})
  .then((server) => {
    const control = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const documentId = url.searchParams.get('documentId') ?? server.documentId;
      if (request.method === 'POST' && url.pathname === '/lock') {
        lockedDocuments.add(documentId);
        response.end(`locked ${documentId}`);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/unlock') {
        lockedDocuments.delete(documentId);
        response.end(`unlocked ${documentId}`);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        response.end('ok');
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    control.listen(controlPort, '127.0.0.1', () => {
      process.stdout.write(
        `authorize server listening on ${server.url} (documentId=${server.documentId}); control http://127.0.0.1:${controlPort}\n`,
      );
    });
    const shutdown = (): void => {
      control.close();
      void server.stop().then(() => {
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })
  .catch((error: unknown) => {
    process.stderr.write(`authorize server failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
