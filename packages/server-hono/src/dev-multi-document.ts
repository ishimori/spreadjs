// DD-043 複数文書 serve の dev / E2E 用起動スクリプト（公開 API serve() の consumer として書く）。
//
// 松下③（納入計画）の年度別 board を模した 2 文書を 1 プロセスで serve する:
//   doc-a … 汎用の 3 列（col-a/col-b/col-c）
//   doc-b … 年度の日付が列になる board（列構成が文書ごとに違うことの実演）
// resolver は起動時の固定リストを引くだけ（v1・ADR-0025 決定1）。無限 Book 化はこの中身の差し替えで到達する。
//
// 起動: `npm run dev:multi-document --workspace packages/server-hono`（PORT で待受ポートを上書き）

import process from 'node:process';

import { serve } from './index';
import type { ServeDocumentConfig } from './index';

const DEFAULT_PORT = 8801; // 単一文書 dev（8787）・統合 E2E（8799）と非衝突

const DOCUMENTS: Record<string, ServeDocumentConfig> = {
  'doc-a': { columnOrder: ['col-a', 'col-b', 'col-c'], seedRows: 5 },
  'doc-b': { columnOrder: ['2026-04-01', '2026-04-02', '2026-04-03'], seedRows: 5 },
};

const envPort = process.env.PORT;
const port = envPort === undefined ? DEFAULT_PORT : Number(envPort);

serve({
  port,
  documents: {
    documentIds: Object.keys(DOCUMENTS),
    resolve: (documentId) => DOCUMENTS[documentId] ?? null,
  },
  onDiagnostic: (entry) => {
    if (entry.level === 'error' || entry.level === 'warn') {
      process.stderr.write(`[${entry.level}] ${entry.code}: ${entry.message}\n`);
    }
  },
})
  .then((server) => {
    process.stdout.write(
      `multi-document server listening on ${server.url} (documents=${server.documentIds.join(', ')})\n`,
    );
    process.stdout.write(`open: ${server.url}/config?documentId=doc-b\n`);
    const shutdown = (): void => {
      void server.stop().then(() => {
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `multi-document server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
