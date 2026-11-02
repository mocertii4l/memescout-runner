import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../logs/logger.js';
import { aggregate } from '../dashboard/aggregate.js';
import { createDashboard } from '../dashboard/server.js';

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'dash-'));
  let t = Date.parse('2026-10-31T12:00:00Z');
  const log = createLogger({ dir, now: () => t });
  log.decision({ bot: 'gambler', lead_id: 'G-1', policy: { intent: 'enter', why: ['ok'] }, answers: { rug: { type: 'noul', p: 0.1 } }, latency_ms: 80, model_version: 'jev-1.13.0' });
  log.decision({ bot: 'launch', lead_id: 'S-1', market: 'Mint1', fallback: 'hold', kind: 'deadline' });
  log.trade({ bot: 'gambler', market: 'SYN', status: 'filled', side: 'buy', realized_usd: -0.1, fee_usd: 0.1 });
  t += 60000;
  log.trade({ bot: 'gambler', market: 'SYN', status: 'filled', side: 'sell', realized_usd: 2.1, fee_usd: 0.1 });
  log.rejection({ bot: 'launch', id: 'Mint2', check: 'whale' });
  log.status('desk', { runner: 'synthetic', mode: 'paper', open: [] });
  return dir;
}

test('aggregate builds KPIs, cumulative PnL and filters by bot', () => {
  const dir = seed();
  const a = aggregate({ dir, day: '2026-10-31' });
  assert.equal(a.kpis.decisions, 2);
  assert.equal(a.kpis.fallbacks, 1);
  assert.equal(a.kpis.pnl_usd, 2);
  assert.deepEqual(a.pnl.gambler.map((p) => p[1]), [-0.1, 2]);
  assert.deepEqual(a.rejections_by_check, [['whale', 1]]);
  assert.equal(a.statuses[0].runner, 'synthetic');
  assert.equal(aggregate({ dir, day: '2026-10-31', bot: 'launch' }).kpis.decisions, 1);
});

test('login: password hashing, sessions, lockout, and protected API', async () => {
  const { hashPassword, verifyPassword, createAuth } = await import('../dashboard/auth.js');
  assert.throws(() => hashPassword('short'), /at least 10/);
  const hash = hashPassword('correct horse battery');
  assert.ok(!hash.includes('correct'));
  assert.ok(verifyPassword('correct horse battery', hash));
  assert.ok(!verifyPassword('wrong password!!', hash));

  const dir = seed();
  const auth = createAuth({ user: 'mocertii', passwordHash: hash, maxFailures: 3 });
  const srv = createDashboard({ auth, dir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const login = (u, p, extra = {}) => fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra }, body: new URLSearchParams({ username: u, password: p }) });
  try {
    assert.equal((await fetch(base + '/api/summary')).status, 401);
    const page = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(page.status, 303); assert.equal(page.headers.get('location'), '/login');
    assert.match(await (await fetch(base + '/login')).text(), /Sign in/);

    const bad = await login('mocertii', 'nope nope nope');
    assert.equal(bad.headers.get('location'), '/login?e=invalid');
    assert.equal(bad.headers.get('set-cookie'), null);

    const evil = await login('mocertii', 'correct horse battery', { origin: 'https://evil.example' });
    assert.equal(evil.status, 403, 'cross-origin login post is refused');

    const ok = await login('mocertii', 'correct horse battery');
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    const sid = cookie.split(';')[0];
    const api = await fetch(base + '/api/summary?day=2026-10-31', { headers: { cookie: sid } });
    assert.equal(api.status, 200);
    const body = await api.json();
    assert.equal(body.kpis.decisions, 2);
    assert.equal(body.viewer.user, 'mocertii');
    assert.ok(body.account.equity_usd > 0);

    await fetch(base + '/logout', { method: 'POST', redirect: 'manual', headers: { cookie: sid } });
    assert.equal((await fetch(base + '/api/summary', { headers: { cookie: sid } })).status, 401, 'session ends at logout');

    await login('x', 'y'); await login('x', 'y'); await login('x', 'y');
    const locked = await login('mocertii', 'correct horse battery');
    assert.equal(locked.headers.get('location'), '/login?e=locked', 'too many failures locks the client out, even with the right password');
  } finally { srv.close(); }
});

test('headline PnL uses the pessimistic ledger; optimistic is shown as a ceiling; spot-checks summarized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-'));
  const t = Date.parse('2026-10-31T12:00:00Z');
  const log = createLogger({ dir, now: () => t });
  log.trade({ bot: 'launch', ledger: 'optimistic', status: 'filled', side: 'sell', realized_usd: 5 });
  log.trade({ bot: 'launch', ledger: 'pessimistic', status: 'filled', side: 'sell', realized_usd: 1 });
  log.trade({ bot: 'launch', ledger: 'pessimistic', status: 'failed', side: 'buy', realized_usd: -0.15 });
  log.spotcheck({ bot: 'launch', market: 'M', side: 'buy', real_median_price_sol: 1, optimistic_bps: 200, pessimistic_bps: -300 });
  log.spotcheck({ bot: 'launch', market: 'N', side: 'buy', real_median_price_sol: 1, optimistic_bps: 400, pessimistic_bps: 50 });
  const a = aggregate({ dir, day: '2026-10-31' });
  assert.equal(a.kpis.pnl_usd, 0.85);
  assert.equal(a.kpis.pnl_optimistic_usd, 5);
  assert.equal(a.kpis.fills, 1);
  assert.equal(a.kpis.failed_tx, 1);
  assert.equal(a.spotcheck.median_optimistic_bps, 300);
  assert.equal(a.spotcheck.pessimistic_too_kind_share, 0.5);
});
