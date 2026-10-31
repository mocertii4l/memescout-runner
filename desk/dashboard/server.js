// Read-only dashboard. Serves one page and one JSON endpoint built from the desk's logs.
// Binds to 127.0.0.1 by default. Binding anywhere else requires DASHBOARD_TOKEN.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { aggregate } from './aggregate.js';

const PAGE = fileURLToPath(new URL('./index.html', import.meta.url));
const eq = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());

export function createDashboard({ token = process.env.DASHBOARD_TOKEN, dir } = {}) {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const headers = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
    if (token) {
      const given = (req.headers.authorization ?? '').replace(/^Bearer /, '') || url.searchParams.get('token') || '';
      if (!eq(given, token)) { res.writeHead(401, headers); return res.end('unauthorized'); }
    }
    if (req.method !== 'GET') { res.writeHead(405, headers); return res.end(); }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:" });
      return res.end(readFileSync(PAGE));
    }
    if (url.pathname === '/api/summary') {
      try {
        const body = aggregate({ day: url.searchParams.get('day') || undefined, bot: url.searchParams.get('bot') || 'all', ...(dir ? { dir } : {}) });
        res.writeHead(200, { ...headers, 'content-type': 'application/json' });
        return res.end(JSON.stringify(body));
      } catch (e) { res.writeHead(500, headers); return res.end(JSON.stringify({ error: 'aggregate_failed' })); }
    }
    res.writeHead(404, headers); res.end();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.DASHBOARD_HOST || '127.0.0.1';
  const port = Number(process.env.PORT || process.env.DASHBOARD_PORT || 8080);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !(process.env.DASHBOARD_TOKEN?.length >= 24)) {
    throw new Error('Binding beyond localhost requires DASHBOARD_TOKEN (24+ chars). The dashboard shows your trading logs.');
  }
  createDashboard().listen(port, host, () => console.log(`dashboard on http://${host}:${port}${process.env.DASHBOARD_TOKEN ? '/?token=…' : ''}`));
}
