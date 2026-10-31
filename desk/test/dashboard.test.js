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

test('dashboard requires its token when one is set, and is read-only', async () => {
  const dir = seed();
  const srv = createDashboard({ token: 't'.repeat(30), dir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/summary')).status, 401);
    const ok = await fetch(base + '/api/summary?day=2026-10-31&token=' + 't'.repeat(30));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).kpis.decisions, 2);
    assert.equal((await fetch(base + '/api/summary?token=' + 't'.repeat(30), { method: 'POST' })).status, 405);
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
