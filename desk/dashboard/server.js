// Read-only dashboard. Serves the page, a login page and one JSON endpoint built from the desk's logs.
// Login: DASHBOARD_USER + DASHBOARD_PASSWORD_HASH (make the hash with `npm run dashboard:password`).
// Binds to 127.0.0.1 by default; binding anywhere else requires login to be configured.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { aggregate } from './aggregate.js';
import { createAuth, readCookie } from './auth.js';

const PAGE = fileURLToPath(new URL('./index.html', import.meta.url));
const LOGIN = fileURLToPath(new URL('./login.html', import.meta.url));
const COOKIE = 'desk_session';

export function createDashboard({ auth = createAuth({ user: process.env.DASHBOARD_USER?.trim(), passwordHash: process.env.DASHBOARD_PASSWORD_HASH?.trim() }), dir, trustProxy = process.env.DASHBOARD_TRUST_PROXY === '1', secureCookie = process.env.DASHBOARD_SECURE_COOKIE === '1' } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const base = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'no-store', 'x-frame-options': 'DENY' };
    const html = { ...base, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'" };
    const send = (status, headers, body = '') => { res.writeHead(status, headers); res.end(body); };
    const redirect = (to, extra = {}) => send(303, { ...base, location: to, ...extra });
    const client = (trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
    const https = secureCookie || req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
    const cookie = (value, maxAge) => `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${https ? '; Secure' : ''}`;

    // CSRF: SameSite=Strict cookies plus an Origin check on every POST.
    if (req.method === 'POST' && req.headers.origin) {
      let host; try { host = new URL(req.headers.origin).host; } catch {}
      if (host !== req.headers.host) return send(403, base, 'bad origin');
    }

    // Unauthenticated liveness probe for the host. Reveals nothing about the desk.
    if (url.pathname === '/healthz' && req.method === 'GET') return send(200, { ...base, 'content-type': 'text/plain' }, 'ok');

    if (url.pathname === '/login') {
      if (!auth.enabled) return redirect('/');
      if (req.method === 'GET') return send(200, html, readFileSync(LOGIN));
      if (req.method !== 'POST') return send(405, base);
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) return send(413, base); }
      const form = new URLSearchParams(body);
      const r = auth.login(form.get('username'), form.get('password'), client);
      if (!r.ok) { await new Promise((ok) => setTimeout(ok, 400)); return redirect(`/login?e=${r.reason}`); }
      return redirect('/', { 'set-cookie': cookie(r.token, Math.floor(auth.ttlMs / 1000)) });
    }
    if (url.pathname === '/logout') {
      if (req.method !== 'POST') return send(405, base);
      auth.logout(readCookie(req, COOKIE));
      return redirect(auth.enabled ? '/login' : '/', { 'set-cookie': cookie('', 0) });
    }

    const session = auth.enabled ? auth.check(readCookie(req, COOKIE)) : { user: 'local' };
    if (!session) return url.pathname.startsWith('/api/') ? send(401, { ...base, 'content-type': 'application/json' }, '{"error":"login_required"}') : redirect('/login');
    if (req.method !== 'GET') return send(405, base);

    if (url.pathname === '/' || url.pathname === '/index.html') return send(200, html, readFileSync(PAGE));
    if (url.pathname === '/api/summary') {
      try {
        const body = aggregate({ day: url.searchParams.get('day') || undefined, bot: url.searchParams.get('bot') || 'all', ...(dir ? { dir } : {}) });
        body.viewer = { user: session.user, login: auth.enabled };
        return send(200, { ...base, 'content-type': 'application/json' }, JSON.stringify(body));
      } catch { return send(500, base, '{"error":"aggregate_failed"}'); }
    }
    send(404, base);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.DASHBOARD_HOST || '127.0.0.1';
  const port = Number(process.env.PORT || process.env.DASHBOARD_PORT || 8080);
  const server = createDashboard();
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!local && !(process.env.DASHBOARD_USER && process.env.DASHBOARD_PASSWORD_HASH)) {
    throw new Error('Binding beyond localhost requires DASHBOARD_USER and DASHBOARD_PASSWORD_HASH (run: npm run dashboard:password).');
  }
  server.listen(port, host, () => console.log(`dashboard on http://${host}:${port} · login ${process.env.DASHBOARD_USER ? 'required' : 'off (localhost only)'}`));
}
