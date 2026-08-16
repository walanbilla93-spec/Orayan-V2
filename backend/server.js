'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { routes } = require('./routes/api');
const logger = require('./lib/logger');
const engine = require('./lib/engine');
const bybit = require('./lib/bybit');

const PORT = Number(process.env.PORT) || 8080;
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limitBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_e) {
        reject(new Error('Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(FRONTEND_DIR, rel);

  // Never serve outside the frontend directory, whatever the URL claims.
  if (!full.startsWith(FRONTEND_DIR)) {
    return send(res, 403, { error: 'Forbidden' });
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return send(res, 404, { error: 'Not found' });
  }
  const ext = path.extname(full).toLowerCase();
  const data = fs.readFileSync(full);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  // The UI is served from the same origin, so CORS is only needed for external tooling.
  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
  }

  if (url.pathname.startsWith('/api/')) {
    const handler = routes[key];
    if (!handler) return send(res, 404, { error: `No route for ${key}` });
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const query = Object.fromEntries(url.searchParams.entries());
      const result = await handler({ body, query, req });
      return send(res, 200, result, { 'Access-Control-Allow-Origin': '*' });
    } catch (e) {
      logger.error('http', `${key} failed`, { error: e.message });
      return send(res, 500, { error: e.message }, { 'Access-Control-Allow-Origin': '*' });
    }
  }

  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  logger.info('server', `Orayan II listening on http://localhost:${PORT}`);
  if (!bybit.keySet()) {
    logger.warn('server',
      'BYBIT_API_KEY / BYBIT_API_SECRET are not set. Paper mode works fully; live mode and account balance will not.');
  }
});

// Never leave positions unmanaged because of an unhandled rejection.
process.on('unhandledRejection', (e) => {
  logger.error('process', 'Unhandled promise rejection', { error: e?.message, stack: e?.stack });
});
process.on('uncaughtException', (e) => {
  logger.error('process', 'Uncaught exception — stopping the engine', { error: e?.message, stack: e?.stack });
  try { engine.stop(); } catch (_e) { /* best effort */ }
});

function shutdown(sig) {
  logger.warn('server', `${sig} received — stopping the engine. Open positions are left as they are.`);
  try { engine.stop(); } catch (_e) { /* best effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
