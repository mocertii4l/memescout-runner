import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/index.js';
import { buildMarketState, leanState, imbalance } from '../state/snapshot.js';
import { batteries } from '../questions/index.js';
import { choice, noul, validateBattery } from '../questions/types.js';
import { createRiskEngine, costBps, exitRule, cancelReplaceBurn } from '../risk/engine.js';
import { createDecider } from '../judge/ladder.js';
import { JudgeError } from '../judge/errors.js';
import { createJudge } from '../judge/server.js';
import { createJudgeClient } from '../judge/client.js';
import { createMockJev, fromWire } from '../judge/jev-client.js';
import { createBench } from '../book/bench.js';
import { createBook } from '../book/book.js';
import { createFunnel } from '../filter/funnel.js';
import { createPaperBroker } from '../broker/paper.js';
import { brier, buckets, fitPlatt } from '../reports/calibration.js';
import { createLogger } from '../logs/logger.js';
import { gamblerPolicy } from '../policy/gambler.js';
import { housePolicy } from '../policy/house.js';
import { spyPolicy } from '../policy/spy.js';

const cfg = loadConfig();
const SECRET = 'x'.repeat(40);

test('every Choice carries an "other" option and batteries validate', () => {
  for (const b of Object.values(batteries)) for (const q of b.questions) if (q.type === 'choice') assert.ok(q.options.includes('other'), q.id);
  assert.ok(choice('c', 'Pick one?', ['a', 'b']).options.includes('other'));
});

test('battery validation rejects compound judgments and single-option choices', () => {
  assert.throws(() => validateBattery({ name: 't', questions: [noul('n', 'Is it trending and low risk and strong?')] }), /more than one judgment/);
  assert.throws(() => validateBattery({ name: 't', questions: [choice('c', 'Which?', ['only'])] }), /single real option/);
});

test('state uses only data from before the decision; missing stays null', () => {
  const raw = { asOf: 1000, book: { ts: 1500, bids: [[1, 1]], asks: [[1.1, 1]] }, bars: [{ ts: 900, close: 1, high: 1, low: 1 }, { ts: 1200, close: 99, high: 99, low: 99 }] };
  const s = buildMarketState(raw);
  assert.equal(s.mid, null, 'future book must be ignored');
  assert.equal(s.ret_bps.b5, null);
  const lean = leanState(s, ['mid', 'not_a_field'], 400);
  assert.deepEqual(lean, { mid: null, not_a_field: null });
  assert.throws(() => leanState({ big: 'x'.repeat(3000) }, ['big'], 400), /token budget/);
  assert.equal(imbalance({ bids: [[1, 3]], asks: [[2, 1]] }), 0.5);
});

test('risk engine: version pin, leverage, economics, position caps', () => {
  const risk = createRiskEngine(cfg);
  const ok = { market: 'M', side: 'buy', notional_usd: 100, leverage: 1, expected_edge_bps: 100 };
  assert.equal(risk.check(ok, { positions: {}, model_version: cfg.model_version_pin }).allowed, true);
  assert.match(risk.check(ok, { positions: {}, model_version: 'jev-latest' }).vetoes[0], /model_version/);
  assert.match(risk.check({ ...ok, leverage: 20 }, { positions: {}, model_version: cfg.model_version_pin }).vetoes.join(), /leverage/);
  assert.match(risk.check({ ...ok, expected_edge_bps: 1 }, { positions: {}, model_version: cfg.model_version_pin }).vetoes.join(), /economics/);
  assert.match(risk.check(ok, { positions: { M: 200 }, model_version: cfg.model_version_pin }).vetoes.join(), /max_position/);
  assert.match(risk.check(ok, { positions: {}, model_version: cfg.model_version_pin, mid: 5, range: { low: 1, high: 2 } }).vetoes.join(), /range_guard/);
});

test('minimum fee makes small tickets uneconomic ($20 vs $0.95 = 475 bps per side)', () => {
  const c = costBps(20, { ...cfg.risk, min_fee_usd: 0.95, gas_usd_per_order: 0 });
  assert.equal(Math.round(c), 950);
});

test('daily loss limit halts the desk until a human resumes it', () => {
  const risk = createRiskEngine(cfg);
  risk.recordPnl(-cfg.risk.daily_loss_limit_usd);
  assert.equal(risk.halted, 'daily_loss');
  const v = risk.check({ market: 'M', side: 'buy', notional_usd: 10, expected_edge_bps: 999 }, { positions: {}, model_version: cfg.model_version_pin });
  assert.match(v.vetoes[0], /desk_halted/);
});

test('exit on a number, and close anyway when data stops after retries', () => {
  assert.equal(exitRule({ volume6hUsd: 10, dailyVolumeUsd: 1000, dataOk: true }, cfg.risk).exit, true);
  assert.equal(exitRule({ volume6hUsd: 250, dailyVolumeUsd: 1000, dataOk: true }, cfg.risk).exit, false);
  assert.equal(exitRule({ dataOk: false, retries: 1 }, cfg.risk).retry, true);
  assert.equal(exitRule({ dataOk: false, retries: 2 }, cfg.risk).exit, true);
  assert.equal(cancelReplaceBurn({ blocksPerHour: 12000, gasUsdPerCancelReplace: 0.01, expectedFillsPerHour: 20, spreadCaptureUsdPerFill: 0.5 }).viable, false);
});

test('fallback ladder: deadline → hold, malformed never retried, rate limit backs off, repeated errors halt', async () => {
  const slow = createDecider({ judge: () => new Promise((r) => setTimeout(() => r({}), 200)), deadlineMs: 20 });
  assert.deepEqual(await slow.decide('gambler', {}), { ok: false, fallback: 'hold', kind: 'deadline' });

  let calls = 0;
  const bad = createDecider({ judge: async () => { calls++; throw new JudgeError('malformed', 'x'); }, deadlineMs: 100 });
  assert.equal((await bad.decide('gambler', {})).fallback, 'halt');
  await bad.decide('gambler', {});
  assert.equal(calls, 1, 'malformed battery must not be retried');

  let t = 0;
  const limited = createDecider({ judge: async () => { throw new JudgeError('rate_limited', 'x', { retryAfterMs: 5000 }); }, deadlineMs: 100, now: () => t });
  assert.equal((await limited.decide('house', {})).kind, 'rate_limited');
  assert.equal((await limited.decide('house', {})).kind, 'backoff');

  const down = createDecider({ judge: async () => { throw new JudgeError('unavailable', 'x'); }, deadlineMs: 100, haltAfter: 3 });
  assert.equal((await down.decide('spy', {})).fallback, 'safe_state');
  await down.decide('spy', {});
  assert.equal((await down.decide('spy', {})).fallback, 'halt');
  assert.equal(down.halted, 'repeated_errors');
});

test('judge service: refuses aliases, enforces desk secret, returns answers raw', async () => {
  assert.throws(() => createJudge({ ask: async () => ({}), deskSecret: SECRET, model: 'jev-latest' }), /Pin an exact/);
  assert.throws(() => createJudge({ ask: async () => ({}), deskSecret: 'short', model: 'jev-1.13.0' }), /DESK_SECRET/);
  const server = createJudge({ ask: createMockJev({ latencyMs: 1 }), deskSecret: SECRET, model: 'jev-1.13.0' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const good = createJudgeClient({ url, deskSecret: SECRET });
    const res = await good('gambler', { mid: 1, imbalance: 0.4 }, { deadlineMs: 1000 });
    assert.equal(res.model_version, 'jev-1.13.0');
    assert.ok(res.answers.regime.probs.trending >= 0);
    assert.equal(res.intent, undefined, 'judge makes no trading decision');
    await assert.rejects(createJudgeClient({ url, deskSecret: 'y'.repeat(40) })('gambler', {}, { deadlineMs: 1000 }), (e) => e.kind === 'auth');
    await assert.rejects(good('nope', {}, { deadlineMs: 1000 }), (e) => e.kind === 'malformed');
  } finally { server.close(); }
});

test('wire normalizer keeps missing answers null', () => {
  const qs = batteries.house.questions;
  const out = fromWire({ model_version: 'jev-1.13.0', answers: [{ name: 'toxic_flow', probability: 0.3 }] }, qs);
  assert.equal(out.answers.toxic_flow.p, 0.3);
  assert.equal(out.answers.volume_alive, null);
});

test('policies: size from config, unknown is its own consequence', () => {
  const ga = { regime: { pick: 'trending', p: 0.8 }, setup: { expected: 2.5 }, action: { pick: 'long', p: 0.95 }, exec_degraded: { p: 0.1 }, buy_pressure: { p: 0.9 } };
  assert.equal(gamblerPolicy(ga, {}, cfg).notional_usd, cfg.gambler.ticket_usd);
  assert.equal(gamblerPolicy({ ...ga, exec_degraded: null }, {}, cfg).intent, 'hold');
  assert.equal(housePolicy({ volume_alive: null }, {}, cfg).intent, 'pull');
  assert.equal(housePolicy({ volume_alive: { p: 0.9 }, range_state: { probs: { breaking_out: 0.6 } } }, {}, cfg).intent, 'pause');
  const sa = { wallet_kind: { pick: 'unknown', p: 0.9 }, consistent: { p: 0.9 }, mirror: { pick: 'full' }, rug: { p: 0.05 } };
  assert.equal(spyPolicy(sa, {}, cfg).notional_usd, cfg.spy.partial_ticket_usd * cfg.spy.unknown_ticket_scale);
});

test('bench by reason: honeypots stay benched forever, too_young expires', () => {
  let t = 0;
  const bench = createBench({ honeypot: -1, too_young: 1000, default: 500 }, { now: () => t });
  bench.bench('A', 'honeypot'); bench.bench('B', 'too_young');
  t = 5000;
  assert.equal(bench.isBenched('A'), 'honeypot');
  assert.equal(bench.isBenched('B'), null);
});

test('book: one position at a time; only EXIT/RISK may free it', () => {
  const book = createBook();
  book.claim({ lead_id: 'L1' });
  assert.equal(book.canScan, false);
  assert.throws(() => book.claim({ lead_id: 'L2' }), /busy/);
  assert.throws(() => book.release('L1', 'SEARCH'), /only EXIT/);
  assert.throws(() => book.release('L9', 'EXIT'), /mismatch/);
  assert.ok(book.release('L1', 'EXIT'));
});

test('funnel: hard facts kill before Jev is asked; every rejection logged with its check', async () => {
  const rejections = [];
  let jevCalls = 0;
  const funnel = createFunnel({
    cfg, bench: createBench(cfg.bench_ttl_ms), logRejection: (r) => rejections.push(r),
    enrich: async (c) => ({ flags: { honeypot: c.id === 'HP' }, top10_pct: 20 }),
    judgeCandidate: async (c) => { jevCalls++; return { pass: true, sort_key: c.liquidity_usd }; },
  });
  const base = { volume_5m_usd: 5000, age_s: 600 };
  const { pick } = await funnel.run([
    { id: 'POOR', liquidity_usd: 10, ...base }, { id: 'HP', liquidity_usd: 9e5, ...base },
    { id: 'A', liquidity_usd: 9000, ...base }, { id: 'B', liquidity_usd: 20000, ...base },
  ]);
  assert.equal(pick.id, 'B');
  assert.equal(jevCalls, 2, 'only survivors of the cheap checks reach Jev');
  assert.deepEqual(rejections.map((r) => [r.id, r.check]), [['POOR', 'low_liquidity'], ['HP', 'honeypot']]);
});

test('paper broker fills market orders at the touch and rests post-only limits', async () => {
  const b = createPaperBroker({ feeBps: 10, startingCashUsd: 1000 });
  b.onBook('M', { bids: [[99, 1]], asks: [[101, 1]] });
  const r = await b.place({ market: 'M', side: 'buy', notional_usd: 101, type: 'market', client_id: 'x' });
  assert.equal(r.fill_price, 101);
  assert.equal((await b.place({ market: 'M', side: 'buy', notional_usd: 50, type: 'limit', price: 101, post_only: true })).status, 'rejected');
  assert.equal((await b.place({ market: 'M', side: 'buy', notional_usd: 50, type: 'limit', price: 98, post_only: true })).status, 'resting');
  assert.equal(b.onBook('M', { bids: [[97, 1]], asks: [[98, 1]] }).length, 1);
});

test('calibration math', () => {
  assert.equal(brier([{ p: 1, y: 1 }, { p: 0, y: 0 }]), 0);
  assert.equal(brier([{ p: 0.5, y: 1 }]), 0.25);
  const bs = buckets([{ p: 0.85, y: 1 }, { p: 0.82, y: 0 }]);
  assert.equal(bs[8].count, 2); assert.equal(bs[8].hit_rate, 0.5);
  const over = Array.from({ length: 200 }, (_, i) => ({ p: 0.9, y: i % 2 })); // says 0.9, right 50%
  const { a, b } = fitPlatt(over);
  const q = 1 / (1 + Math.exp(-(a * Math.log(0.9 / 0.1) + b)));
  assert.ok(Math.abs(q - 0.5) < 0.05, `platt should pull 0.9 toward 0.5, got ${q}`);
});

test('logger redacts secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-'));
  createLogger({ dir }).event({ type: 'x', api_key: 'sk-123', nested: { deskSecret: 'abc' } });
  const line = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8');
  assert.ok(!line.includes('sk-123') && !line.includes('abc'));
});
