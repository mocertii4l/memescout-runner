// Spy on real Solana launches. Paper only: reads PumpPortal's creation stream and Solana RPC, never signs.
//
// SEAT PREAMBLE: You don't form opinions about trades. You build a state, call the judge once and act on
// the numbers. If the judge is unreachable, nothing passes on your say-so.
//
//   PumpPortal subscribeNewToken ─► pending launches (aged 45s–5min)
//     ─► funnel: bench → free cut (event data) → enrich (RPC: mint, curve, holders) → hard facts → Jev (≤3) → pick
//     ─► policy ─► risk engine ─► curve paper broker ─► EXIT seat polls the curve (take / stop / time / graduated / no data)
import { loadConfig } from './config/index.js';
import { leanState } from './state/snapshot.js';
import { batteries } from './questions/index.js';
import { launchPolicy } from './policy/launch.js';
import { createRiskEngine } from './risk/engine.js';
import { createCurvePaperBroker } from './broker/paper-curve.js';
import { createBook } from './book/book.js';
import { createBench } from './book/bench.js';
import { createFunnel } from './filter/funnel.js';
import { createLogger } from './logs/logger.js';
import { createDecider } from './judge/ladder.js';
import { createJudgeClient, createLocalJudge } from './judge/client.js';
import { createMockJev } from './judge/jev-client.js';
import { connectPumpPortal } from './feeds/pumpportal.js';
import { createRpc, solUsd } from './feeds/solana-rpc.js';
import { spotPriceSol, curveProgress } from './feeds/pumpcurve.js';
import { rowsFor } from './outcomes/resolvers.js';
import { fetchRealTrades, compareFill } from './feeds/spotcheck.js';

const TOTAL_SUPPLY = 1_000_000_000;
const MIGRATION_RESERVE = 206_900_000; // tokens the curve account keeps for migration

/** Holder stats excluding the bonding curve's own token account. */
export function holderStats(holders, curve) {
  if (!holders?.length) return { top10_pct: null, largest_holder_pct: null, holders_seen: 0, curve_account_found: false };
  const expectedCurve = curve?.realTokenReserves != null ? Number(curve.realTokenReserves) / 1e6 + MIGRATION_RESERVE : null;
  let idx = expectedCurve ? holders.findIndex((h) => Math.abs(h.amount - expectedCurve) / expectedCurve < 0.01) : -1;
  const found = idx >= 0;
  if (!found) idx = 0; // fall back: the curve is almost always the largest holder during bonding
  const rest = holders.filter((_, i) => i !== idx).filter((h) => h.amount > 0);
  const pct = (x) => Number(((x / TOTAL_SUPPLY) * 100).toFixed(2));
  return { top10_pct: pct(rest.slice(0, 10).reduce((s, h) => s + h.amount, 0)), largest_holder_pct: pct(rest[0]?.amount ?? 0), holders_seen: rest.length, curve_account_found: found };
}

export function buildLaunchState(c, now = Date.now()) {
  return {
    age_s: Math.round((now - c.received_at) / 1000),
    market_cap_usd: c.market_cap_usd ?? null,
    curve_progress_pct: c.curve ? Number((curveProgress(c.curve) * 100).toFixed(1)) : null,
    sol_inflow: c.sol_inflow ?? null,
    inflow_sol_per_min: c.sol_inflow != null ? Number((c.sol_inflow / Math.max(1, (now - c.received_at) / 60000)).toFixed(2)) : null,
    creator_initial_buy_pct: c.creator_initial_buy_pct ?? null,
    largest_holder_pct: c.holders?.largest_holder_pct ?? null,
    top10_pct: c.holders?.top10_pct ?? null,
    holders_seen: c.holders?.holders_seen ?? null,
  };
}

export function createSolanaDesk({ mode = 'paper', cfg = loadConfig(), judge, rpc = createRpc(), logger = createLogger(), getSolUsd = () => solUsd({ fallback: cfg.solana.sol_usd_fallback }), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), rand } = {}) {
  const S = cfg.solana;
  const riskCfg = { ...cfg, risk: { ...cfg.risk, ...S.risk_overrides } };
  const log = logger;
  const risk = createRiskEngine(riskCfg, { onVeto: (v) => log.veto({ bot: 'launch', ...v }) });
  // Two ledgers on every trade: optimistic is the ceiling, pessimistic is closer to a floor.
  // Risk limits and the headline PnL use the pessimistic one.
  const PS = S.pessimistic;
  const onFill = (f) => { log.trade({ bot: 'launch', mode, ...f }); if (f.ledger === 'optimistic' && f.status === 'filled') spotQueue.push({ ts: now(), at: now() + S.spotcheck.delay_ms, lead_id: f.client_id, mint: f.market, curveKey: f.curve, side: f.side, optimistic_price_sol: f.fill_price_sol }); };
  const broker = createCurvePaperBroker({ feeBps: riskCfg.risk.fee_bps, model: 'optimistic', onFill });
  const pessBroker = createCurvePaperBroker({ feeBps: riskCfg.risk.fee_bps, model: 'pessimistic', pess: PS, ...(rand ? { rand } : {}), onFill });
  const spotQueue = [];
  const book = createBook();
  const bench = createBench(cfg.bench_ttl_ms, { now });
  const decider = createDecider({ judge, deadlineMs: 2000, haltAfter: cfg.risk.consecutive_error_halt, onEvent: (e) => log.event({ bot: 'launch', ...e }) });
  const pending = new Map();
  const outcomeQueue = [];
  const stats = { realized_usd_optimistic: 0, pess_entry_failed: 0, pess_exit_failed: 0, written_off: 0, spotchecks: 0, launches_seen: 0, dropped: 0, expired: 0, scanned: 0, judged: 0, entries: 0, exits: 0, vetoes: 0, rejections: {}, realized_usd: 0 };
  let sol = { price: S.sol_usd_fallback, source: 'config_fallback' }, exitFailures = 0;

  function onLaunch(l) {
    stats.launches_seen++;
    if (pending.size >= S.max_pending) { pending.delete(pending.keys().next().value); stats.dropped++; }
    pending.set(l.mint, { ...l, lead_id: `S-${l.mint.slice(0, 8)}-${l.received_at.toString(36)}` });
  }

  const funnel = createFunnel({
    cfg: { ...cfg, funnel: { ...cfg.funnel, max_jev_candidates: S.max_jev_candidates } },
    bench,
    logRejection: (r) => { stats.rejections[r.check] = (stats.rejections[r.check] ?? 0) + 1; log.rejection({ bot: 'launch', market: r.id, ...r }); },
    freeCut: (c) => {
      const age = (now() - c.received_at) / 1000;
      if (age > S.max_age_s) return 'stale_signal';
      if (age < S.min_age_s) return 'too_young';
      if (!c.bonding_curve) return 'curve_missing';
      if ((c.creator_initial_buy_pct ?? 0) > S.max_creator_initial_buy_pct) return 'creator_heavy_buy';
      return null;
    },
    enrich: async (c) => {
      const [mint, curve, holders] = await Promise.all([rpc.mintInfo(c.mint), rpc.curve(c.bonding_curve), rpc.largestHolders(c.mint)]);
      const price = curve ? spotPriceSol(curve) : null;
      return {
        mint_info: mint, curve, holders: holderStats(holders, curve),
        price_sol: price,
        market_cap_usd: price != null ? Number((price * TOTAL_SUPPLY * sol.price).toFixed(0)) : null,
        sol_inflow: curve ? Number((Number(curve.realSolReserves) / 1e9 - (c.creator_initial_buy_sol ?? 0)).toFixed(3)) : null,
      };
    },
    hardFacts: (c) => {
      if (!c.mint_info) return 'enrich_failed';
      if (c.mint_info.mint_authority) return 'mint_authority_open';
      if (c.mint_info.freeze_authority) return 'freeze_authority_open';
      if (!c.curve) return 'curve_missing';
      if (c.curve.complete) return 'curve_complete';
      if ((c.market_cap_usd ?? 0) < S.min_market_cap_usd) return 'low_market_cap';
      if ((c.sol_inflow ?? 0) < S.min_inflow_sol) return 'no_inflow';
      if (c.holders.top10_pct == null || c.holders.top10_pct > S.max_top10_pct) return 'concentration';
      if (c.holders.largest_holder_pct > S.max_largest_holder_pct) return 'whale';
      return null;
    },
    rankKey: (c) => c.sol_inflow ?? 0,
    judgeCandidate: async (c) => {
      const state = leanState(buildLaunchState(c, now()), batteries.launch.reads, cfg.state_token_budget);
      const res = await decider.decide('launch', state);
      if (!res.ok) { log.decision({ bot: 'launch', mode, lead_id: c.lead_id, market: c.mint, state, fallback: res.fallback, kind: res.kind }); return { pass: false, reason: 'judge_unavailable' }; }
      stats.judged++;
      const answers = res.response.answers;
      const intent = launchPolicy(answers, state, S);
      log.decision({ bot: 'launch', mode, lead_id: c.lead_id, market: c.mint, state, answers, model_version: res.response.model_version, latency_ms: res.latency_ms, policy: intent, display: c._display });
      const t = now();
      outcomeQueue.push({ lead_id: c.lead_id, mint: c.mint, curveKey: c.bonding_curve, price0: c.price_sol, answers, momentumAt: t + cfg.solana.outcomes.momentum_horizon_ms, rugAt: t + cfg.solana.outcomes.rug_horizon_ms, minPrice: c.price_sol, done: {} });
      return { pass: intent.intent === 'enter', reason: intent.why.some((w) => w.startsWith('rug')) ? 'jev_rug' : 'jev_not_worth_it', sort_key: answers.quality?.expected ?? 0, intent, model_version: res.response.model_version, answers };
    },
  });

  async function scan() {
    if (risk.halted) return;
    if (!book.canScan) return; // one position at a time: no scan while one is open
    sol = await getSolUsd();
    const t = now();
    for (const l of [...pending.values()]) if ((t - l.received_at) / 1000 > S.max_age_s) { pending.delete(l.mint); stats.expired++; } // never replayed as new
    // Newest-first among those old enough: a launch close to max age is about to expire anyway.
    const batch = [...pending.values()].filter((l) => (t - l.received_at) / 1000 >= S.min_age_s).sort((a, b) => b.received_at - a.received_at).slice(0, S.max_enrich_per_cycle);
    for (const l of batch) pending.delete(l.mint);
    if (!batch.length) return;
    const cands = batch.map((l) => ({ ...l, creator_initial_buy_pct: l.creator_initial_buy_tokens != null ? (l.creator_initial_buy_tokens / TOTAL_SUPPLY) * 100 : null }));
    stats.scanned += cands.length;
    const { pick, stats: fs } = await funnel.run(cands);
    log.event({ bot: 'launch', type: 'funnel', stats: fs, sol_usd: sol });
    if (!pick) return; // no trade is a result
    const { intent, model_version } = pick.verdict;
    const order = { market: pick.mint, side: 'buy', notional_usd: intent.notional_usd, leverage: 1, expected_edge_bps: intent.expected_edge_bps };
    const v = risk.check(order, { positions: Object.fromEntries(Object.keys(broker.positions()).map((m) => [m, S.ticket_usd])), model_version });
    if (!v.allowed) { stats.vetoes++; return; }
    if (mode === 'shadow') { log.trade({ bot: 'launch', mode, shadow: true, lead_id: pick.lead_id, market: pick.mint, order }); return; }
    // Re-read the curve right before the paper fill so the price isn't stale by a whole scan.
    const fresh = await rpc.curve(pick.bonding_curve).catch(() => null);
    broker.onBook(pick.mint, fresh ?? pick.curve);
    const req = { ...order, sol_usd: sol.price, client_id: pick.lead_id, curve: pick.bonding_curve };
    const res = await broker.place(req);
    if (res.status !== 'filled') { log.event({ bot: 'launch', type: 'entry_rejected', lead_id: pick.lead_id, reason: res.reason }); return; }
    stats.entries++;
    book.claim({ lead_id: pick.lead_id, bot: 'launch', market: pick.mint, curveKey: pick.bonding_curve, entry_price_sol: res.fill_price_sol, opened_ms: now(), display: pick._display, pessExitFailures: 0 });
    // Pessimistic ledger: the same decision, filled after a delay on a re-read curve.
    await sleep(PS.entry_delay_ms);
    const later = await rpc.curve(pick.bonding_curve).catch(() => null);
    pessBroker.onBook(pick.mint, later ?? fresh ?? pick.curve);
    const pres = await pessBroker.place(req);
    if (pres.status === 'failed') { stats.pess_entry_failed++; risk.recordPnl(pres.realized_usd); stats.realized_usd += pres.realized_usd; }
    else if (pres.status === 'filled') { const sq = spotQueue.find((q) => q.lead_id === req.client_id && q.side === 'buy'); if (sq) sq.pessimistic_price_sol = pres.fill_price_sol; }
  }

  async function manageExit() {
    const p = book.open;
    if (!p) return;
    // EXIT seat: arithmetic only. It never re-reads the answers that opened the trade.
    let curve = null;
    try { curve = await rpc.curve(p.curveKey); exitFailures = 0; } catch { exitFailures++; }
    const R = riskCfg.risk;
    let reason = null;
    if (!curve) { if (exitFailures > R.exit_data_retries) reason = 'no_data_after_retries'; else return; }
    else {
      broker.onBook(p.market, curve);
      p.mark_price_sol = spotPriceSol(curve);
      const move = (Math.log(spotPriceSol(curve) / p.entry_price_sol)) * 1e4;
      reason = curve.complete ? 'graduated' : move >= S.take_bps ? 'take' : move <= -S.stop_bps ? 'stop' : now() - p.opened_ms >= S.max_hold_ms ? 'time_stop' : null;
    }
    if (!reason && !p.optimisticClosed) return;
    // A position you can't measure is a position you don't hold: close at the last known curve.
    // Graduated curves can't be sold on the curve in reality (liquidity moves to PumpSwap); paper closes at the final curve price and flags it.
    const sellReq = { market: p.market, side: 'sell', sol_usd: sol.price, client_id: `exit-${p.lead_id}`, curve: p.curveKey };
    if (!p.optimisticClosed) {
      const res = await broker.place(sellReq);
      if (res.status === 'filled') stats.realized_usd_optimistic += res.realized_usd;
      p.optimisticClosed = true; p.exitReason = reason;
      log.event({ bot: 'launch', type: 'exit', ledger: 'optimistic', lead_id: p.lead_id, market: p.market, reason, realized_usd: res.realized_usd ?? null });
    }
    // Pessimistic ledger exits after a delay, may fail and retry on the next poll, and is written off after N failures.
    if (pessBroker.position(p.market).tokens > 0) {
      await sleep(PS.exit_delay_ms);
      const later = await rpc.curve(p.curveKey).catch(() => null);
      pessBroker.onBook(p.market, later ?? curve);
      const pres = await pessBroker.place(sellReq);
      if (pres.status === 'failed') {
        stats.pess_exit_failed++;
        if (++p.pessExitFailures < PS.exit_max_failures) return; // book stays open until the pessimistic ledger is out
        const w = pessBroker.writeOff(p.market, sol.price);
        stats.written_off++; risk.recordPnl(w.realized_usd); stats.realized_usd += w.realized_usd;
        log.event({ bot: 'launch', type: 'exit', ledger: 'pessimistic', lead_id: p.lead_id, market: p.market, reason: 'written_off', realized_usd: w.realized_usd });
      } else if (pres.status === 'filled') {
        risk.recordPnl(pres.realized_usd); stats.realized_usd += pres.realized_usd;
        const sq = spotQueue.find((q) => q.lead_id === sellReq.client_id); if (sq) sq.pessimistic_price_sol = pres.fill_price_sol;
        log.event({ bot: 'launch', type: 'exit', ledger: 'pessimistic', lead_id: p.lead_id, market: p.market, reason: p.exitReason, realized_usd: pres.realized_usd });
      }
    }
    stats.exits++;
    book.release(p.lead_id, 'EXIT');
  }

  /** Compare each paper fill with what real traders paid on the same curve at the same moment. */
  async function runSpotchecks() {
    const t = now();
    for (let i = spotQueue.length - 1; i >= 0; i--) {
      const q = spotQueue[i];
      if (t < q.at) continue;
      spotQueue.splice(i, 1);
      if (!q.curveKey) continue;
      try {
        const real = await fetchRealTrades(rpc, { curveKey: q.curveKey, mint: q.mint, ts: q.ts, windowMs: S.spotcheck.window_ms, maxTx: S.spotcheck.max_tx });
        const cmp = compareFill(q, real, S.spotcheck.window_ms);
        stats.spotchecks++;
        log.spotcheck({ bot: 'launch', lead_id: q.lead_id, market: q.mint, side: q.side, fill_ts: q.ts, optimistic_price_sol: q.optimistic_price_sol, pessimistic_price_sol: q.pessimistic_price_sol ?? null, ...cmp });
      } catch (e) { log.event({ bot: 'launch', type: 'spotcheck_failed', lead_id: q.lead_id }); }
    }
  }

  async function resolveOutcomes() {
    await runSpotchecks();
    const t = now();
    for (const o of outcomeQueue) {
      const needMom = !o.done.momentum && t >= o.momentumAt, needRug = !o.done.rug && t >= o.rugAt;
      if (!needMom && !needRug) continue;
      const curve = await rpc.curve(o.curveKey).catch(() => null);
      if (!curve || o.price0 == null) continue;
      const price = spotPriceSol(curve);
      o.minPrice = Math.min(o.minPrice ?? price, price);
      if (needMom) { o.done.momentum = true; for (const r of rowsFor('momentum', o.answers.momentum, price > o.price0)) log.outcome({ bot: 'launch', lead_id: o.lead_id, market: o.mint, ...r }); }
      if (needRug) { o.done.rug = true; for (const r of rowsFor('rug', o.answers.rug, price < o.price0 * (1 - cfg.solana.outcomes.rug_drawdown))) log.outcome({ bot: 'launch', lead_id: o.lead_id, market: o.mint, ...r }); }
    }
    // Resolved, or unresolvable for 10 minutes past its horizon (logged as missing, never guessed).
    for (let i = outcomeQueue.length - 1; i >= 0; i--) {
      const o = outcomeQueue[i];
      if (o.done.momentum && o.done.rug) outcomeQueue.splice(i, 1);
      else if (t > o.rugAt + 600000) { log.event({ bot: 'launch', type: 'outcome_unresolved', lead_id: o.lead_id }); outcomeQueue.splice(i, 1); }
    }
  }

  function writeStatus(extra = {}) {
    const o = book.open;
    log.status('solana', { runner: 'solana', mode, feed: 'PumpPortal new tokens + Solana RPC', judge: process.env.JUDGE_URL ? 'http judge' : 'mock judge', model_pin: cfg.model_version_pin, halted: risk.halted || decider.halted || null, realized_today_usd: risk.realizedToday, realized_optimistic_usd: stats.realized_usd_optimistic, sol_usd: sol, pending: pending.size, counters: stats,
      ...(() => {
        // Open profit and risk on the pessimistic ledger (the one the headline uses).
        const pp = o ? pessBroker.position(o.market) : null;
        const mark = o?.mark_price_sol ?? o?.entry_price_sol;
        const costUsd = pp?.cost_sol ? pp.cost_sol * sol.price : 0;
        return { floating_usd: pp?.tokens && mark ? pp.tokens * mark * sol.price - costUsd : 0, exposure_usd: costUsd, open_risk_usd: (costUsd * S.stop_bps) / 1e4,
          limits: { daily_loss_limit_usd: riskCfg.risk.daily_loss_limit_usd, max_position_usd_total: riskCfg.risk.max_position_usd_total } };
      })(),
      open: o ? [{ bot: 'launch', lead_id: o.lead_id, market: o.market, symbol: o.display?.symbol ?? null, side: 'buy', entry_price_sol: o.entry_price_sol, held_s: Math.round((now() - o.opened_ms) / 1000) }] : [], ...extra });
  }

  return { onLaunch, scan, manageExit, resolveOutcomes, runSpotchecks, writeStatus, stats, risk, book, pending, broker, pessBroker };
}

// ---------------------------------------------------------------- entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const mode = process.env.DESK_MODE || 'paper';
  if (!['paper', 'shadow'].includes(mode)) throw new Error('paper or shadow only');
  const judge = process.env.JUDGE_URL
    ? createJudgeClient()
    : createLocalJudge({ ask: createMockJev({ version: cfg.model_version_pin }), model: cfg.model_version_pin, batteries });
  if (!process.env.JUDGE_URL) console.log('JUDGE_URL not set → in-process MOCK judge (heuristics, not Jev).');
  const desk = createSolanaDesk({ mode, cfg, judge });
  const feed = connectPumpPortal({ onLaunch: desk.onLaunch, onStatus: (s) => console.log(new Date().toISOString(), s.type, s.retry_ms ?? '') });
  console.log(`solana launch desk mode=${mode} rpc=${process.env.SOLANA_RPC_URL ? 'custom' : 'public mainnet'} — paper only, never signs`);
  let stopping = false;
  const stop = () => { stopping = true; feed.stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const loop = async (fn, ms, name) => { while (!stopping) { const t = Date.now(); try { await fn(); } catch (e) { console.log(`${name} error: ${e.message}`); } const end = Date.now() + Math.max(250, ms - (Date.now() - t)); while (!stopping && Date.now() < end) await new Promise((r) => setTimeout(r, Math.min(500, end - Date.now()))); } };
  const heartbeat = async () => {
    desk.writeStatus({ feed_connected: feed.connected, feed_last_message_at: feed.lastMessageAt });
    const s = desk.stats, o = desk.book.open;
    console.log(new Date().toISOString(), JSON.stringify({ seen: s.launches_seen, pending: desk.pending.size, scanned: s.scanned, judged: s.judged, entries: s.entries, exits: s.exits, pnl_usd: +s.realized_usd.toFixed(2), open: o ? `${o.display?.symbol ?? ''} ${o.market.slice(0, 6)}…` : null, halted: desk.risk.halted, top_rejections: Object.entries(s.rejections).sort((a, b) => b[1] - a[1]).slice(0, 4) }));
  };
  await Promise.all([
    loop(desk.scan, cfg.solana.scan_interval_ms, 'scan'),
    loop(desk.manageExit, cfg.solana.exit_poll_ms, 'exit'),
    loop(desk.resolveOutcomes, 15000, 'outcomes'),
    loop(heartbeat, 10000, 'heartbeat'),
  ]);
}
