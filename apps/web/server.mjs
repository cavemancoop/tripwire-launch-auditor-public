#!/usr/bin/env node
/**
 * M8 — the dashboard is plain HTML/CSS/JS with no build step, so serving it
 * needs no framework either: node's own http + fs cover a handful of static
 * files. All real data comes from the api at request time via client-side
 * fetch() (see public/app.js) — this process never touches Postgres/Redis.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
// Railway (and most PaaS) inject $PORT and expect the service to bind to it;
// WEB_PORT is the local-dev override so it doesn't collide with the api/worker
// processes' own $PORT when all three run on one machine (`pnpm start`).
const PORT = Number(process.env.PORT || process.env.WEB_PORT || 3002);
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// The dashboard used to guess the api's address as `own-hostname:3000`, which
// only holds when everything runs on one machine. On Railway each service gets
// its own hostname, so the guess was always wrong and every visitor had to
// paste the URL in by hand before seeing any data. Serve it instead: set
// API_BASE_URL on this service and the page reads it at load.
const API_BASE_URL = process.env.API_BASE_URL || '';

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/config.json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ apiBase: API_BASE_URL }));
    return;
  }

  let rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  if (rel.startsWith('..')) rel = '/index.html'; // no path traversal out of public/

  let filePath = join(PUBLIC_DIR, rel);
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(PUBLIC_DIR, 'index.html'); // single-page app: unknown paths fall back
  }

  res.setHeader('Content-Type', TYPES[extname(filePath)] || 'application/octet-stream');
  createReadStream(filePath)
    .on('error', () => {
      res.statusCode = 404;
      res.end('not found');
    })
    .pipe(res);
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`launch-auditor-web listening on http://${HOST}:${PORT}`);
});
