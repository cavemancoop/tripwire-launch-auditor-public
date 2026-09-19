/**
 * M9 — a liveness endpoint for the worker process. The loops themselves
 * (watcher, commit, metabolism, deep-dive, scorer, telegram, alerts) need no
 * public port to do their job; this exists only so Railway (or a human) has
 * something to probe, dependency-free like apps/web/server.mjs.
 */
import { createServer, type Server } from 'node:http';

export function startHealthServer(port: number): Server {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true, service: 'launch-auditor-worker' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[health] worker health server listening on :${port}`);
  });
  return server;
}
