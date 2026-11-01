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
import { spotPriceSol, curveProgress, isSolQuotedCurve } from './feeds/pumpcurve.js';
import { RISKY_TOKEN_EXTENSIONS } from './feeds/solana-rpc.js';
import { rowsFor } from './outcomes/resolvers.js';
import { fetchRealTrades, compareFill } from './feeds/spotcheck.js';
import { createNotifier, fmt as alertFmt } from './alerts/notify.js';
import { readStream } from './reports/read.js';
import { isMain, flag } from './config/main.js';

const TOTAL_SUPPLY = 1_000_000_000;

function mergeDeep(a, b) {
  if (typeof a !== 'object' || a === null || Array.isArray(a) || typeof b !== 'object' || b === null || Array.isArray(b)) return b ?? a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (!k.startsWith('_')) out[k] = mergeDeep(a[k], v);
  return out;
}

/** Share read-only RPC lookups between profiles so running both doesn't double the load. */
export function createCachedRpc(rpc, { ttlMs = 2500, now = () => Date.now() } = {}) {
  const cache = new Map();
  const wrap = (name) => async (key) => {
    const k = name + ':' + key, hit = cache.get(k);
    if (hit && now() - hit.at < ttlMs) { if (hit.error) throw hit.error; return hit.value; }
    let value, error;
    try { value = await rpc[name](key); } catch (e) { error = e; }
    cache.set(k, { at: now(), value, error }); // errors too: a rate limit shouldn't be hit twice by two profiles
    if (error) throw error;
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return value;
  };
  return { ...rpc, mintInfo: wrap('mintInfo'), curve: wrap('curve'), largestHolders: wrap('largestHolders') };
}
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

export function createSolanaDesk({ profile = 'strict', mode = 'paper', cfg: baseCfg = loadConfig(), judge, rpc = createRpc(), logger = createLogger(), getSolUsd = () => solUsd({ fallback: baseCfg.solana.sol_usd_fallback }), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), rand, notify = { send: async () => false } } = {}) {
  // Profiles are fully independent desks: own filters, book, bench, risk engine, ledgers and logs tag.
  // 'loose' only overrides thresholds; the scam checks (mint/freeze authority, graduated curve) are never relaxed.
  const cfg = profile === 'strict' ? baseCfg : { ...baseCfg, solana: mergeDeep(baseCfg.solana, baseCfg.solana_profiles?.[profile] ?? (() => { throw new Error(`unknown profile ${profile}`); })()) };
  const S = cfg.solana;
  const BOT = profile === 'strict' ? 'launch' : `launch_${profile}`;
  const STATUS = profile === 'strict' ? 'solana' : `solana-${profile}`;
  const riskCfg = { ...cfg, risk: { ...cfg.risk, ...S.risk_overrides } };
  const log = logger;
  const risk = createRiskEngine(riskCfg, { now, onVeto: (v) => { log.veto({ bot: BOT, ...v }); if (v.halt) notify.send(alertFmt.halt({ profile, why: `daily loss limit hit (${v.realizedToday?.toFixed?.(2)} USD)` }), { key: `halt-${profile}`, dedupeMs: 3600_000 }).catch(() => {}); } });
  // A restart must not reset the daily loss limit: replay today's realized P/L (pessimistic ledger) from the logs.
  try {
    const today = new Date(now()).toISOString().slice(0, 10);
    const done = readStream('trades', { dir: log.dir, day: today })
      .filter((t) => t.bot === BOT && t.ledger !== 'optimistic' && ['filled', 'failed', 'written_off'].includes(t.status) && Number.isFinite(t.realized_usd));
    const sum = done.reduce((x, t) => x + t.realized_usd, 0);
    if (done.length) { risk.recordPnl(sum); log.event({ bot: BOT, type: 'risk_restored', realized_today_usd: sum, trades: done.length, halted: risk.halted }); }
  } catch { /* no history yet */ }
  // Two ledgers on every trade: optimistic is the ceiling, pessimistic is closer to a floor.
  // Risk limits and the headline PnL use the pessimistic one.
  const PS = S.pessimistic;
  const onFill = (f) => { log.trade({ bot: BOT, mode, ...f }); if (f.ledger === 'optimistic' && f.status === 'filled') spotQueue.push({ ts: now(), at: now() + S.spotcheck.delay_ms, lead_id: f.client_id, mint: f.market, curveKey: f.curve, side: f.side, optimistic_price_sol: f.fill_price_sol }); };
  const broker = createCurvePaperBroker({ feeBps: riskCfg.risk.fee_bps, model: 'optimistic', onFill });
  const pessBroker = createCurvePaperBroker({ feeBps: riskCfg.risk.fee_bps, model: 'pessimistic', pess: PS, ...(rand ? { rand } : {}), onFill });
  const spotQueue = [];
  const book = createBook();
  const bench = createBench(cfg.bench_ttl_ms, { now });
  const decider = createDecider({ judge, deadlineMs: 2000, haltAfter: cfg.risk.consecutive_error_halt, onEvent: (e) => log.event({ bot: BOT, ...e }) });
  const pending = new Map();
  const outcomeQueue = [];
  const stats = { realized_usd_optimistic: 0, pess_entry_failed: 0, pess_exit_failed: 0, written_off: 0, spotchecks: 0, launches_seen: 0, dropped: 0, expired: 0, scanned: 0, judged: 0, entries: 0, exits: 0, vetoes: 0, rejections: {}, realized_usd: 0 };
  let sol = { price: S.sol_usd_fallback, source: 'config_fallback' }, exitFailures = 0;

  // Last N launches with what happened to each, for the dashboard's "Live launches" table.
  const recent = new Map();
  function track(mint, patch) {
    const cur = recent.get(mint);
    if (!cur && !patch.received_at) return;
    recent.set(mint, { ...(cur ?? {}), ...patch, updated_at: now() });
    if (recent.size > 60) recent.delete(recent.keys().next().value);
  }

  const creatorLaunches = new Map(); // creator -> recent launch timestamps
  function onLaunch(l) {
    stats.launches_seen++;
    if (l.creator) { const xs = (creatorLaunches.get(l.creator) ?? []).filter((x) => l.received_at - x < S.serial_window_ms); xs.push(l.received_at); creatorLaunches.set(l.creator, xs); l.creator_recent_launches = xs.length; if (creatorLaunches.size > 5000) creatorLaunches.delete(creatorLaunches.keys().next().value); }
    track(l.mint, { mint: l.mint, symbol: l._display?.symbol ?? '', name: l._display?.name ?? '', received_at: l.received_at, stage: 'waiting', detail: `checks after ${S.min_age_s}s` });
    if (pending.size >= S.max_pending) { pending.delete(pending.keys().next().value); stats.dropped++; }
    pending.set(l.mint, { ...l, lead_id: `${profile === 'strict' ? 'S' : 'SL'}-${l.mint.slice(0, 8)}-${l.received_at.toString(36)}` });
  }

  const TRANSIENT = new Set(['rpc_rate_limited', 'holders_unavailable', 'enrich_failed']);
  const scanning = new Map();
  const funnel = createFunnel({
    cfg: { ...cfg, funnel: { ...cfg.funnel, max_jev_candidates: S.max_jev_candidates } },
    bench,
    logRejection: (r) => {
      // Transient data problems are not a verdict on the token: requeue it while it is still young enough.
      if (TRANSIENT.has(r.check) && scanning.has(r.id)) {
        const l = scanning.get(r.id); l.retries = (l.retries ?? 0) + 1;
        if (l.retries <= S.max_transient_retries && (now() - l.received_at) / 1000 < S.max_age_s - 20) { pending.set(r.id, l); stats.requeued = (stats.requeued ?? 0) + 1; r.retry = l.retries; }
      } stats.rejections[r.check] = (stats.rejections[r.check] ?? 0) + 1; track(r.id, { stage: r.stage === 'jev' ? 'judged' : 'rejected', detail: r.check }); log.rejection({ bot: BOT, market: r.id, ...r }); },
    freeCut: (c) => {
      const age = (now() - c.received_at) / 1000;
      if (age > S.max_age_s) return 'stale_signal';
      if (age < S.min_age_s) return 'too_young';
      if (c.pool && c.pool !== 'pump') return 'not_pump_pool';
      if (!c.bonding_curve) return 'curve_missing';
      if (c.mayhem && !S.allow_mayhem) return 'mayhem_mode';
      if ((c.creator_recent_launches ?? 1) > S.max_launches_per_creator) return 'serial_launcher';
      if ((c.creator_initial_buy_pct ?? 0) > S.max_creator_initial_buy_pct) return 'creator_heavy_buy';
      return null;
    },
    enrich: async (c) => {
      const [mint, curve] = await Promise.all([rpc.mintInfo(c.mint), rpc.curve(c.bonding_curve)]);
      // Holder lookup is the heaviest call and the first the public RPC throttles. Its failure is its own reason,
      // so a rate limit never looks like a bad token (and never passes as a good one).
      let holders = null, holdersError = null;
      if (mint && curve && isSolQuotedCurve(curve)) { try { holders = await rpc.largestHolders(c.mint); } catch (e) { holdersError = e.rateLimited ? 'rate_limited' : 'error'; } }
      const price = curve ? spotPriceSol(curve) : null;
      return {
        mint_info: mint, curve, holders: holders ? holderStats(holders, curve) : null, holders_error: holdersError,
        price_sol: price,
        market_cap_usd: price != null ? Number((price * TOTAL_SUPPLY * sol.price).toFixed(0)) : null,
        sol_inflow: curve ? Number((Number(curve.realSolReserves) / 1e9 - (c.creator_initial_buy_sol ?? 0)).toFixed(3)) : null,
      };
    },
    hardFacts: (c) => {
      if (!c.mint_info) return 'enrich_failed';
      if (c.mint_info.mint_authority) return 'mint_authority_open';
      if (c.mint_info.freeze_authority) return 'freeze_authority_open';
      if (c.mint_info.extensions?.some((x) => RISKY_TOKEN_EXTENSIONS.includes(x))) return 'risky_token_extension';
      if (!c.curve) return 'curve_missing';
      if (c.curve.complete) return 'curve_complete';
      if (!isSolQuotedCurve(c.curve)) return 'non_sol_quote';
      if (!c.holders && !S.allow_unknown_holders) return c.holders_error === 'rate_limited' ? 'rpc_rate_limited' : 'holders_unavailable';
      if (!c.holders) return null; // unknown holders: allowed by this profile, judged with blank fields, half ticket (policy)
      if ((c.market_cap_usd ?? 0) < S.min_market_cap_usd) return 'low_market_cap';
      if (curveProgress(c.curve) * 100 > S.max_curve_progress_pct) return 'late_curve'; // seen live: 0 wins in 9 entries above 55%
      if ((c.sol_inflow ?? 0) < S.min_inflow_sol) return 'no_inflow';
      if (c.holders.top10_pct == null || c.holders.top10_pct > S.max_top10_pct) return 'concentration';
      if (c.holders.largest_holder_pct > S.max_largest_holder_pct) return 'whale';
      return null;
    },
    rankKey: (c) => c.sol_inflow ?? 0,
    judgeCandidate: async (c) => {
      // Never judge stale state: enrichment can be tens of seconds old when the RPC is slow (seen live: a token
      // dumped from 52 SOL to 1 SOL between enrichment and judgment). Re-read the curve and rebuild its fields.
      const freshCurve = await rpc.curve(c.bonding_curve).catch(() => null);
      if (freshCurve) {
        const fp = spotPriceSol(freshCurve);
        Object.assign(c, { curve: freshCurve, price_sol: fp, market_cap_usd: fp != null ? Number((fp * TOTAL_SUPPLY * sol.price).toFixed(0)) : null,
          sol_inflow: Number((Number(freshCurve.realSolReserves) / 1e9 - (c.creator_initial_buy_sol ?? 0)).toFixed(3)) });
        if (freshCurve.complete) return { pass: false, reason: 'curve_complete' };
        if (curveProgress(freshCurve) * 100 > S.max_curve_progress_pct) return { pass: false, reason: 'late_curve' };
        if ((c.sol_inflow ?? 0) < S.min_inflow_sol) return { pass: false, reason: 'no_inflow' };
      } else return { pass: false, reason: 'curve_missing' };
      c.judged_price_sol = c.price_sol;
      const state = leanState(buildLaunchState(c, now()), batteries.launch.reads, cfg.state_token_budget);
      const res = await decider.decide('launch', state);
      if (!res.ok) { log.decision({ bot: BOT, mode, lead_id: c.lead_id, market: c.mint, state, fallback: res.fallback, kind: res.kind }); return { pass: false, reason: 'judge_unavailable' }; }
      stats.judged++;
      const answers = res.response.answers;
      const intent = launchPolicy(answers, state, S);
      track(c.mint, { stage: intent.intent === 'enter' ? 'picked' : 'judged', detail: intent.why.join(', ') });
      log.decision({ bot: BOT, mode, lead_id: c.lead_id, market: c.mint, state, answers, model_version: res.response.model_version, latency_ms: res.latency_ms, policy: intent, display: c._display });
      const t = now();
      outcomeQueue.push({ lead_id: c.lead_id, mint: c.mint, curveKey: c.bonding_curve, price0: c.price_sol, answers, momentumAt: t + cfg.solana.outcomes.momentum_horizon_ms, rugAt: t + cfg.solana.outcomes.rug_horizon_ms, minPrice: c.price_sol, done: {} });
      return { pass: intent.intent === 'enter', reason: intent.why.some((w) => w.startsWith('rug')) ? 'jev_rug' : 'jev_not_worth_it', sort_key: answers.quality?.expected ?? 0, intent, model_version: res.response.model_version, answers };
    },
  });

  let confirming = null;
  async function scan() {
    const t = now();
    const why = risk.halted ? 'desk halted' : book.open ? 'not checked: a position was open' : 'not checked in time';
    for (const l of [...pending.values()]) if ((t - l.received_at) / 1000 > S.max_age_s) { pending.delete(l.mint); stats.expired++; track(l.mint, { stage: 'expired', detail: why }); } // never replayed as new
    if (risk.halted) return;
    if (!book.canScan) return; // one position at a time: no scan while one is open
    sol = await getSolUsd();
    if (confirming) return confirmPending(); // one pick at a time, including while it is being confirmed
    // Newest-first among those old enough: a launch close to max age is about to expire anyway.
    const batch = [...pending.values()].filter((l) => (t - l.received_at) / 1000 >= S.min_age_s).sort((a, b) => b.received_at - a.received_at).slice(0, S.max_enrich_per_cycle);
    for (const l of batch) pending.delete(l.mint);
    scanning.clear(); for (const l of batch) scanning.set(l.mint, l);
    if (!batch.length) return;
    const cands = batch.map((l) => ({ ...l, creator_initial_buy_pct: l.creator_initial_buy_tokens != null ? (l.creator_initial_buy_tokens / TOTAL_SUPPLY) * 100 : null }));
    stats.scanned += cands.length;
    const { pick, stats: fs } = await funnel.run(cands);
    log.event({ bot: BOT, type: 'funnel', stats: fs, sol_usd: sol });
    if (!pick) return; // no trade is a result
    if (!(S.confirm_ms > 0)) return enter(pick);
    // Confirmation: don't buy the spike. Hold the pick for one more look before entering (seen live: entries in
    // the first seconds after a hot judgment were mostly stopped out within 3-10 s).
    confirming = { pick, at: now() + S.confirm_ms, price0: pick.judged_price_sol };
    track(pick.mint, { stage: 'picked', detail: `confirming: re-check in ${Math.round(S.confirm_ms / 1000)}s` });
  }

  async function confirmPending() {
    const c = confirming; if (!c || now() < c.at) return;
    confirming = null;
    const { pick } = c;
    const fresh = await rpc.curve(pick.bonding_curve).catch(() => null);
    const drop = fresh ? Math.log(spotPriceSol(fresh) / c.price0) * 1e4 : null;
    const prog = fresh ? curveProgress(fresh) * 100 : null;
    const check = !fresh ? 'no_fresh_curve' : fresh.complete ? 'curve_complete' : drop < -S.confirm_max_drop_bps ? 'faded_before_entry' : prog > S.max_curve_progress_pct ? 'late_curve' : null;
    if (check) {
      stats.rejections[check] = (stats.rejections[check] ?? 0) + 1;
      log.rejection({ bot: BOT, market: pick.mint, lead_id: pick.lead_id, stage: 'confirm', check, move_bps: drop == null ? null : Math.round(drop) });
      track(pick.mint, { stage: 'rejected', detail: check === 'faded_before_entry' ? `price fell ${Math.round(-drop / 100)}% while confirming` : check.replaceAll('_', ' ') });
      return;
    }
    // Judged state is re-anchored to the confirmed price; the entry drift guard then checks the fill against it.
    pick.judged_price_sol = spotPriceSol(fresh);
    pick.curve = fresh;
    await enter(pick);
  }

  async function enter(pick) {
    const { intent, model_version } = pick.verdict;
    const order = { market: pick.mint, side: 'buy', notional_usd: intent.notional_usd, leverage: 1, expected_edge_bps: intent.expected_edge_bps };
    const v = risk.check(order, { positions: Object.fromEntries(Object.keys(broker.positions()).map((m) => [m, S.ticket_usd])), model_version });
    if (!v.allowed) { stats.vetoes++; return; }
    if (mode === 'shadow') { log.trade({ bot: BOT, mode, shadow: true, lead_id: pick.lead_id, market: pick.mint, order }); return; }
    // Re-read the curve right before the paper fill so the price isn't stale by a whole scan.
    const fresh = await rpc.curve(pick.bonding_curve).catch(() => null);
    if (!fresh) { log.event({ bot: BOT, type: 'entry_skipped', lead_id: pick.lead_id, reason: 'no_fresh_curve' }); track(pick.mint, { stage: 'rejected', detail: 'no fresh price at entry' }); return; }
    // The state you judged must still be the state you trade.
    const drift = Math.abs(Math.log(spotPriceSol(fresh) / pick.judged_price_sol)) * 1e4;
    if (!(drift <= S.max_state_drift_bps) || fresh.complete) {
      stats.rejections.state_changed = (stats.rejections.state_changed ?? 0) + 1;
      log.rejection({ bot: BOT, market: pick.mint, lead_id: pick.lead_id, stage: 'entry', check: 'state_changed', drift_bps: Math.round(drift) });
      track(pick.mint, { stage: 'rejected', detail: `price moved ${Math.round(drift / 100)}% since judged` });
      return;
    }
    broker.onBook(pick.mint, fresh);
    const req = { ...order, sol_usd: sol.price, client_id: pick.lead_id, curve: pick.bonding_curve };
    const res = await broker.place(req);
    if (res.status !== 'filled') { log.event({ bot: BOT, type: 'entry_rejected', lead_id: pick.lead_id, reason: res.reason }); return; }
    stats.entries++;
    track(pick.mint, { stage: 'bought', detail: `paper buy $${order.notional_usd}` });
    notify.send(alertFmt.entry({ profile, symbol: pick._display?.symbol, mint: pick.mint, usdIn: order.notional_usd })).catch(() => {});
    book.claim({ lead_id: pick.lead_id, bot: BOT, market: pick.mint, curveKey: pick.bonding_curve, entry_price_sol: res.fill_price_sol, opened_ms: now(), display: pick._display, pessExitFailures: 0 });
    // Pessimistic ledger: the same decision, filled after a delay on a re-read curve.
    await sleep(PS.entry_delay_ms);
    const later = await rpc.curve(pick.bonding_curve).catch(() => null);
    pessBroker.onBook(pick.mint, later ?? fresh ?? pick.curve);
    const pres = await pessBroker.place(req);
    if (pres.status === 'failed') { stats.pess_entry_failed++; risk.recordPnl(pres.realized_usd); stats.realized_usd += pres.realized_usd; if (book.open) book.open.pessRealized = pres.realized_usd; }
    else if (pres.status === 'filled') { const sq = spotQueue.find((q) => q.lead_id === req.client_id && q.side === 'buy'); if (sq) sq.pessimistic_price_sol = pres.fill_price_sol; }
  }

  /**
   * EXIT seat: arithmetic only. It never re-reads the answers that opened the trade.
   *   stop        −stop_bps from entry → close everything
   *   partial     +take_bps once → sell partial_fraction, let the rest run
   *   trailing    after the peak reached +trail_activate_bps, a fall of trail_bps from the peak → close the rest
   *   time_stop, graduated, no_data_after_retries → close everything
   * Each ledger (optimistic, pessimistic) executes the same decisions; the pessimistic one can fail and retry.
   */
  async function manageExit() {
    const p = book.open;
    if (!p) return;
    let curve = null;
    try { curve = await rpc.curve(p.curveKey); exitFailures = 0; } catch { exitFailures++; }
    const R = riskCfg.risk;
    let action = p.pendingAction ?? null; // a pessimistic sell that failed is retried with the same intent
    if (!action) {
      if (!curve) { if (exitFailures > R.exit_data_retries) action = { kind: 'full', reason: 'no_data_after_retries' }; else return; }
      else if (curve.complete) {
        // Graduated: the curve is drained and liquidity moved to PumpSwap. Selling into the drained curve would book
        // a fake -100% (seen live). Close at the last pre-graduation curve the brokers already hold, flagged.
        action = { kind: 'full', reason: 'graduated' };
      } else {
        broker.onBook(p.market, curve);
        const price = spotPriceSol(curve);
        p.mark_price_sol = price;
        const move = Math.log(price / p.entry_price_sol) * 1e4;
        p.peak_bps = Math.max(p.peak_bps ?? 0, move);
        const trailing = p.peak_bps >= S.trail_activate_bps && p.peak_bps - move >= S.trail_bps;
        if (move <= -S.stop_bps) action = { kind: 'full', reason: 'stop' };
        else if (!p.partialDone && move >= S.take_bps && S.partial_fraction > 0 && S.partial_fraction < 1) action = { kind: 'partial', reason: 'partial_take', fraction: S.partial_fraction };
        else if (!p.partialDone && move >= S.take_bps) action = { kind: 'full', reason: 'take' };
        else if (trailing) action = { kind: 'full', reason: 'trailing_stop' };
        else if (now() - p.opened_ms >= S.max_hold_ms) action = { kind: 'full', reason: 'time_stop' };
      }
    }
    if (!action) return;
    const fraction = action.kind === 'partial' ? action.fraction : 1;
    const sellReq = { market: p.market, side: 'sell', fraction, sol_usd: sol.price, client_id: `${action.kind === 'partial' ? 'partial' : 'exit'}-${p.lead_id}`, curve: p.curveKey };

    // Optimistic ledger: instant.
    if (p.optDoneFor !== action.reason && broker.position(p.market).tokens > 0) {
      const res = await broker.place(sellReq);
      if (res.status === 'filled') { stats.realized_usd_optimistic += res.realized_usd; p.optRealized = (p.optRealized ?? 0) + res.realized_usd; }
      p.optDoneFor = action.reason;
    }
    // Pessimistic ledger: delayed, re-read, can fail; the book stays open until it is done.
    if (pessBroker.position(p.market).tokens > 0) {
      await sleep(PS.exit_delay_ms);
      const later = await rpc.curve(p.curveKey).catch(() => null);
      pessBroker.onBook(p.market, [later, curve].find((c) => c && !c.complete) ?? null); // never a drained curve
      const pres = await pessBroker.place(sellReq);
      if (pres.status === 'failed') {
        stats.pess_exit_failed++;
        p.pessRealized = (p.pessRealized ?? 0) + pres.realized_usd; // the fee of the failed attempt
        if (++p.pessExitFailures < PS.exit_max_failures) { p.pendingAction = action; return; }
        const w = pessBroker.writeOff(p.market, sol.price);
        stats.written_off++; risk.recordPnl(w.realized_usd); stats.realized_usd += w.realized_usd;
        p.pessRealized += w.realized_usd;
        action = { kind: 'full', reason: 'written_off' };
      } else if (pres.status === 'filled') {
        risk.recordPnl(pres.realized_usd); stats.realized_usd += pres.realized_usd;
        p.pessRealized = (p.pessRealized ?? 0) + pres.realized_usd;
        const sq = spotQueue.find((q) => q.lead_id === sellReq.client_id); if (sq) sq.pessimistic_price_sol = pres.fill_price_sol;
      }
    }
    p.pendingAction = null; p.pessExitFailures = 0;
    if (action.kind === 'partial') {
      p.partialDone = true;
      log.event({ bot: BOT, type: 'partial_exit', lead_id: p.lead_id, market: p.market, reason: action.reason, fraction });
      track(p.market, { stage: 'bought', detail: `took ${Math.round(fraction * 100)}% profit, rest running` });
      return;
    }
    // One exit event per ledger with the whole trade's realized P/L (partials included), for win rate and history.
    log.event({ bot: BOT, type: 'exit', ledger: 'optimistic', lead_id: p.lead_id, market: p.market, reason: action.reason, realized_usd: p.optRealized ?? null });
    log.event({ bot: BOT, type: 'exit', ledger: 'pessimistic', lead_id: p.lead_id, market: p.market, reason: action.reason, realized_usd: p.pessRealized ?? 0 });
    stats.exits++;
    track(p.market, { stage: 'sold', detail: action.reason.replaceAll('_', ' ') });
    notify.send(alertFmt.exit({ profile, symbol: p.display?.symbol, mint: p.market, reason: action.reason, pess: p.pessRealized ?? 0, opt: p.optRealized ?? 0 })).catch(() => {});
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
        log.spotcheck({ bot: BOT, lead_id: q.lead_id, market: q.mint, side: q.side, fill_ts: q.ts, optimistic_price_sol: q.optimistic_price_sol, pessimistic_price_sol: q.pessimistic_price_sol ?? null, ...cmp });
      } catch (e) { log.event({ bot: BOT, type: 'spotcheck_failed', lead_id: q.lead_id }); }
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
      if (needMom) { o.done.momentum = true; for (const r of rowsFor('momentum', o.answers.momentum, price > o.price0)) log.outcome({ bot: BOT, lead_id: o.lead_id, market: o.mint, ...r }); }
      if (needRug) { o.done.rug = true; for (const r of rowsFor('rug', o.answers.rug, price < o.price0 * (1 - cfg.solana.outcomes.rug_drawdown))) log.outcome({ bot: BOT, lead_id: o.lead_id, market: o.mint, ...r }); }
    }
    // Resolved, or unresolvable for 10 minutes past its horizon (logged as missing, never guessed).
    for (let i = outcomeQueue.length - 1; i >= 0; i--) {
      const o = outcomeQueue[i];
      if (o.done.momentum && o.done.rug) outcomeQueue.splice(i, 1);
      else if (t > o.rugAt + 600000) { log.event({ bot: BOT, type: 'outcome_unresolved', lead_id: o.lead_id }); outcomeQueue.splice(i, 1); }
    }
  }

  function writeStatus(extra = {}) {
    const o = book.open;
    log.status(STATUS, { runner: STATUS, profile, mode, rpc: process.env.SOLANA_RPC_URL ? 'custom' : 'public', feed: 'PumpPortal new tokens + Solana RPC', judge: process.env.JUDGE_URL ? 'http judge' : 'mock judge', model_pin: cfg.model_version_pin, halted: risk.halted || decider.halted || null, realized_today_usd: risk.realizedToday, realized_optimistic_usd: stats.realized_usd_optimistic, sol_usd: sol, pending: pending.size, counters: stats,
      ...(() => {
        // Open profit and risk on the pessimistic ledger (the one the headline uses).
        const pp = o ? pessBroker.position(o.market) : null;
        const mark = o?.mark_price_sol ?? o?.entry_price_sol;
        const costUsd = pp?.cost_sol ? pp.cost_sol * sol.price : 0;
        return { floating_usd: pp?.tokens && mark ? pp.tokens * mark * sol.price - costUsd : 0, exposure_usd: costUsd, open_risk_usd: (costUsd * S.stop_bps) / 1e4,
          limits: { daily_loss_limit_usd: riskCfg.risk.daily_loss_limit_usd, max_position_usd_total: riskCfg.risk.max_position_usd_total } };
      })(),
      recent_launches: [...recent.values()].reverse().slice(0, 40),
      open: o ? [{ bot: BOT, lead_id: o.lead_id, market: o.market, symbol: o.display?.symbol ?? null, side: 'buy', entry_price_sol: o.entry_price_sol, held_s: Math.round((now() - o.opened_ms) / 1000) }] : [], ...extra });
  }

  return { profile, cfg, onLaunch, scan, confirmPending, manageExit, resolveOutcomes, runSpotchecks, writeStatus, stats, risk, book, pending, broker, pessBroker };
}

// ---------------------------------------------------------------- entrypoint
if (isMain(import.meta.url)) {
  const cfg = loadConfig();
  const mode = flag('mode', 'DESK_MODE', 'paper');
  if (!['paper', 'shadow'].includes(mode)) throw new Error('paper or shadow only');
  const judge = process.env.JUDGE_URL
    ? createJudgeClient()
    : createLocalJudge({ ask: createMockJev({ version: cfg.model_version_pin }), model: cfg.model_version_pin, batteries });
  if (!process.env.JUDGE_URL) console.log('JUDGE_URL not set → in-process MOCK judge (heuristics, not Jev).');
  const loose = ['1', 'true', 'yes'].includes(String(flag('loose', 'DESK_LOOSE', '0')).toLowerCase()) || process.argv.includes('--loose');
  const rpc = createCachedRpc(createRpc());
  const notify = createNotifier({ log: (m) => console.log(m) });
  console.log(notify.enabled ? `alerts on: ${notify.channels.join(' + ')}` : 'alerts off (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID or DISCORD_WEBHOOK_URL to get phone alerts)');
  const desks = [createSolanaDesk({ profile: 'strict', mode, cfg, judge, rpc, notify })];
  if (loose) desks.push(createSolanaDesk({ profile: 'loose', mode, cfg, judge, rpc, notify }));
  const feed = connectPumpPortal({ onLaunch: (l) => { for (const d of desks) d.onLaunch(l); }, onStatus: (s) => console.log(new Date().toISOString(), s.type, s.retry_ms ?? '') });
  console.log(`solana launch desk mode=${mode} profiles=${desks.map((d) => d.profile).join('+')} rpc=${process.env.SOLANA_RPC_URL ? 'custom' : 'public mainnet'} — paper only, never signs`);
  let stopping = false;
  const stop = () => { stopping = true; feed.stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const loop = async (fn, ms, name) => { while (!stopping) { const t = Date.now(); try { await fn(); } catch (e) { console.log(`${name} error: ${e.message}`); } const end = Date.now() + Math.max(250, ms - (Date.now() - t)); while (!stopping && Date.now() < end) await new Promise((r) => setTimeout(r, Math.min(500, end - Date.now()))); } };
  let beats = 0, feedDownSince = null, feedAlerted = false, lastDay = new Date().toISOString().slice(0, 10);
  const watch = async () => {
    // Feed health → alert once when down 2+ min, once when back.
    const down = !feed.connected || !feed.lastMessageAt || Date.now() - feed.lastMessageAt > 120_000;
    if (down) { feedDownSince ??= Date.now(); if (!feedAlerted && Date.now() - feedDownSince > 120_000) { feedAlerted = true; notify.send(alertFmt.feed(false)).catch(() => {}); } }
    else { if (feedAlerted) notify.send(alertFmt.feed(true)).catch(() => {}); feedDownSince = null; feedAlerted = false; }
    // Daily summary at the UTC day change.
    const day = new Date().toISOString().slice(0, 10);
    if (day !== lastDay) {
      lastDay = day;
      notify.send(alertFmt.daily(desks.map((d) => `${d.profile}: ${d.stats.entries} buys · ${d.stats.exits} sells · ${d.stats.realized_usd >= 0 ? '+' : '-'}$${Math.abs(d.stats.realized_usd).toFixed(2)} pessimistic since start`))).catch(() => {});
    }
  };
  const heartbeat = async () => {
    await watch();
    for (const d of desks) d.writeStatus({ feed_connected: feed.connected, feed_last_message_at: feed.lastMessageAt });
    if ((beats = (beats + 1) % 6) !== 1) return; // status every 10 s, console line every minute
    for (const d of desks) {
      const s = d.stats, o = d.book.open;
      console.log(new Date().toISOString(), d.profile.padEnd(6), JSON.stringify({ seen: s.launches_seen, pending: d.pending.size, scanned: s.scanned, judged: s.judged, entries: s.entries, exits: s.exits, pnl_usd: +s.realized_usd.toFixed(2), open: o ? `${o.display?.symbol ?? ''} ${o.market.slice(0, 6)}…` : null, halted: d.risk.halted, top_rejections: Object.entries(s.rejections).sort((a, b) => b[1] - a[1]).slice(0, 4) }));
    }
  };
  await Promise.all([
    ...desks.flatMap((d) => [
      loop(d.scan, d.cfg.solana.scan_interval_ms, `${d.profile} scan`),
      loop(d.manageExit, d.cfg.solana.exit_poll_ms, `${d.profile} exit`),
      loop(d.resolveOutcomes, 15000, `${d.profile} outcomes`),
    ]),
    loop(heartbeat, 10000, 'heartbeat'),
  ]);
}
