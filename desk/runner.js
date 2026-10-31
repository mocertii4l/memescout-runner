// The desk loop. Code calculates the state → judge answers the battery → policy applies thresholds
// → risk engine checks → paper broker executes (paper mode) or nothing executes (shadow mode).
//
// SEAT PREAMBLE (applies to every seat that judges anything):
//   You don't form opinions about trades. You build a state, call the judge once and act on the numbers.
//   If the judge is unreachable, nothing passes on your say-so.
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config/index.js';
import { buildMarketState, leanState } from './state/snapshot.js';
import { batteries } from './questions/index.js';
import { policies } from './policy/index.js';
import { avellanedaStoikov, gridLevels } from './policy/house.js';
import { createRiskEngine, costBps } from './risk/engine.js';
import { createPaperBroker } from './broker/paper.js';
import { createBook } from './book/book.js';
import { createBench } from './book/bench.js';
import { createFunnel } from './filter/funnel.js';
import { createLogger } from './logs/logger.js';
import { createDecider } from './judge/ladder.js';
import { createJudgeClient, createLocalJudge } from './judge/client.js';
import { createMockJev } from './judge/jev-client.js';
import { createMarketFeed, createWalletFeed } from './feeds/synthetic.js';
import { rowsFor, horizonBars, gamblerLabels, houseLabels, spyLabels } from './outcomes/resolvers.js';

const RULEBOOK_SETUP = 'Pullback to rising short-term trend: b60 and b20 returns positive, b5 slightly negative, imbalance turning positive, spread tight.';

export function createDesk({ mode = 'shadow', cfg = loadConfig(), judge, logger = createLogger(), bots = ['gambler', 'house', 'spy'] } = {}) {
  if (!['shadow', 'paper'].includes(mode)) throw new Error(`unknown mode ${mode}; live is not available in this skeleton`);
  const log = logger;
  const risk = createRiskEngine(cfg, { onVeto: (v) => log.veto(v) });
  const broker = createPaperBroker({ feeBps: cfg.risk.fee_bps, minFeeUsd: cfg.risk.min_fee_usd, onFill: (f) => log.trade({ mode, ...f }) });
  // One position at a time per directional bot. While a bot's position is open, that bot's scan doesn't run.
  const books = { gambler: createBook(), spy: createBook() };
  const bench = createBench(cfg.bench_ttl_ms);
  const decider = createDecider({ judge, deadlineMs: cfg.decision_deadline_ms, haltAfter: cfg.risk.consecutive_error_halt, onEvent: (e) => log.event(e) });
  const feed = createMarketFeed({ blockMs: cfg.block_ms });
  const wallets = createWalletFeed();
  const pending = []; // decisions awaiting their outcome
  let tick = 0, lastSnap = null;
  const grid = { active: false, range: null };
  const counters = { decisions: 0, holds: 0, would_trade: 0, trades: 0, vetoes: 0, fallbacks: 0 };

  const shadowPositions = {}; // what shadow mode *would* hold, so risk checks stay realistic
  const positionsUsd = () => {
    if (mode === 'shadow') return { ...shadowPositions };
    const out = {};
    for (const [m, p] of Object.entries(broker.positions())) out[m] = p.qty * (lastSnap ? lastSnap.bars.at(-1).close : p.avg);
    return out;
  };

  async function ask(bot, state, lead_id) {
    const decision_id = randomUUID();
    const res = await decider.decide(bot, state);
    counters.decisions++;
    if (!res.ok) {
      counters.fallbacks++;
      log.decision({ decision_id, lead_id, bot, mode, state, fallback: res.fallback, kind: res.kind });
      if (res.fallback === 'safe_state' || res.fallback === 'halt') await safeState(`${bot}:${res.kind}`);
      if (res.fallback === 'halt') risk.halt(`judge_${res.kind}`);
      return { decision_id, ok: false };
    }
    return { decision_id, ok: true, answers: res.response.answers, model_version: res.response.model_version, latency_ms: res.latency_ms };
  }

  async function safeState(reason) {
    // Pull every resting quote; flatten paper inventory. Reversible and logged — no human needed.
    if (grid.active) { await broker.cancelAll(); grid.active = false; }
    log.event({ type: 'safe_state', reason });
  }

  async function execute(order, ctx, decision) {
    const verdict = risk.check(order, ctx);
    if (!verdict.allowed) { counters.vetoes++; return { executed: false, vetoes: verdict.vetoes }; }
    if (mode === 'shadow') { counters.would_trade++; shadowPositions[order.market] = (shadowPositions[order.market] ?? 0) + (order.side === 'buy' ? 1 : -1) * order.notional_usd; return { executed: false, would: true }; }
    const res = await broker.place({ ...order, client_id: decision.decision_id });
    // Confidence is not permission: check the outcome in code.
    if (res.status === 'filled') counters.trades++;
    return { executed: res.status === 'filled' || res.status === 'resting', result: res };
  }

  // ---------------------------------------------------------------- Gambler
  async function gamblerTick(snap) {
    const book = books.gambler;
    const full = { ...buildMarketState({ ...snap, position: broker.position(snap.market) }), rulebook_setup: RULEBOOK_SETUP };
    const pos = book.open?.bot === 'gambler' ? book.open : null;
    if (pos) return gamblerManage(pos, full);
    const state = leanState(full, batteries.gambler.reads, cfg.state_token_budget);
    const lead_id = `G-${tick}`;
    const d = await ask('gambler', state, lead_id);
    if (!d.ok) return;
    const intent = policies.gambler(d.answers, state, cfg);
    const cost = costBps(cfg.gambler.ticket_usd, cfg.risk);
    let exec = null;
    if (intent.intent === 'enter') {
      const p = d.answers.action.p;
      // Edge estimate is code: payoff-weighted, can only veto — size never scales with p.
      const edge = p * cfg.gambler.take_bps - (1 - p) * cfg.gambler.stop_bps;
      const order = { market: snap.market, side: intent.side, notional_usd: intent.notional_usd, type: 'market', leverage: 1, expected_edge_bps: edge };
      exec = await execute(order, { positions: positionsUsd(), model_version: d.model_version, mid: full.mid }, d);
      if (exec.executed || exec.would) book.claim({ lead_id, bot: 'gambler', market: snap.market, side: intent.side, entry: full.mid, notional_usd: intent.notional_usd, stop_bps: intent.stop_bps, take_bps: intent.take_bps, entry_fee: exec.result?.fee_usd ?? 0 });
    } else counters.holds++;
    log.decision({ decision_id: d.decision_id, lead_id, bot: 'gambler', mode, state, answers: d.answers, model_version: d.model_version, latency_ms: d.latency_ms, policy: intent, exec });
    pending.push({ bot: 'gambler', decision_id: d.decision_id, resolveAt: tick + horizonBars, state, snap, answers: d.answers, cost });
  }

  async function gamblerManage(pos, full) {
    const dir = pos.side === 'buy' ? 1 : -1;
    const moveBps = (Math.log(full.mid / pos.entry) * 1e4) * dir;
    const reason = moveBps <= -pos.stop_bps ? 'stop' : moveBps >= pos.take_bps ? 'take' : null;
    if (!reason) return;
    // EXIT seat: arithmetic only. Doesn't re-read the answers that opened the trade.
    if (mode === 'paper') {
      const res = await broker.place({ market: pos.market, side: pos.side === 'buy' ? 'sell' : 'buy', notional_usd: Math.abs(broker.position(pos.market).qty) * full.mid, type: 'market', client_id: `exit-${pos.lead_id}` });
      if (res.status === 'filled') risk.recordPnl(res.realized_usd - pos.entry_fee);
    } else {
      const pnl = (moveBps / 1e4) * pos.notional_usd - (costBps(pos.notional_usd, cfg.risk) / 1e4) * pos.notional_usd;
      risk.recordPnl(pnl);
      delete shadowPositions[pos.market];
      log.trade({ mode, shadow_exit: true, lead_id: pos.lead_id, reason, pnl_usd: pnl });
    }
    log.event({ type: 'exit', lead_id: pos.lead_id, reason, move_bps: moveBps });
    books.gambler.release(pos.lead_id, 'EXIT');
  }

  // ---------------------------------------------------------------- House
  async function houseTick(snap) {
    const full = buildMarketState({ ...snap, position: broker.position('HOUSE-' + snap.market) });
    if (!grid.range) { const b = snap.bars.slice(-120); grid.range = { low: Math.min(...b.map((x) => x.low)), high: Math.max(...b.map((x) => x.high)) }; }
    const vol6 = snap.bars.slice(-60).reduce((s, b) => s + b.volume, 0), volAll = snap.bars.slice(-240).reduce((s, b) => s + b.volume, 0);
    const extra = {
      range_low: grid.range.low, range_high: grid.range.high,
      to_edge_bps: full.mid ? Number((Math.min(full.mid - grid.range.low, grid.range.high - full.mid) / full.mid * 1e4).toFixed(1)) : null,
      fill_rate_per_min: null, // unknown until the paper broker has history — stays null, not 0
      volume_pace_ratio: volAll ? Number((vol6 / (volAll / 4)).toFixed(2)) : null,
    };
    const state = leanState({ ...full, ...extra }, batteries.house.reads, cfg.state_token_budget);
    const lead_id = `H-${tick}`;
    const d = await ask('house', state, lead_id);
    if (!d.ok) return;
    const intent = policies.house(d.answers, state, cfg);
    let exec = null;
    if (intent.intent === 'quote' && !grid.active) {
      const sigma = ((full.rvol_bps ?? 10) / 1e4) * full.mid / Math.sqrt(cfg.block_ms / 1000);
      const as = avellanedaStoikov({ mid: full.mid, inventory: broker.position('HOUSE-' + snap.market).qty, sigma, gamma: cfg.house.as_gamma, kappa: cfg.house.as_kappa, horizonS: cfg.house.as_horizon_s });
      const levels = gridLevels({ center: as.reservation, levels: intent.levels, stepBps: intent.step_bps });
      const placed = [];
      for (const l of levels) {
        // Grid edge per round trip = one step; must clear fees + gas or the risk engine says no.
        const order = { market: 'HOUSE-' + snap.market, side: l.side, notional_usd: intent.level_size_usd, type: 'limit', price: l.price, post_only: true, leverage: 1, expected_edge_bps: intent.step_bps };
        const r = await execute(order, { positions: {}, model_version: d.model_version, mid: full.mid, range: grid.range }, d);
        placed.push(r.executed || r.would ? 'ok' : r.vetoes?.[0]);
      }
      grid.active = placed.some((p) => p === 'ok');
      if (mode === 'shadow') counters.would_trade -= placed.filter((p) => p === 'ok').length - (grid.active ? 1 : 0); // count a grid once
      exec = { grid: placed };
    } else if (['pause', 'pull', 'kill'].includes(intent.intent) && grid.active) {
      await broker.cancelAll('HOUSE-' + snap.market); grid.active = false;
      if (intent.intent === 'kill') grid.range = null;
      exec = { cancelled: true };
    } else if (intent.intent !== 'quote') counters.holds++;
    // Range guard (code, not model): price leaves the band → the grid stops.
    if (grid.active && (full.mid < grid.range.low || full.mid > grid.range.high)) { await broker.cancelAll('HOUSE-' + snap.market); grid.active = false; grid.range = null; log.veto({ veto: 'range_guard', mid: full.mid }); }
    log.decision({ decision_id: d.decision_id, lead_id, bot: 'house', mode, state, answers: d.answers, model_version: d.model_version, latency_ms: d.latency_ms, policy: intent, exec });
    pending.push({ bot: 'house', decision_id: d.decision_id, resolveAt: tick + horizonBars, state, snap, answers: d.answers });
  }

  // ---------------------------------------------------------------- Spy
  const funnel = createFunnel({
    cfg, bench, enrich: (t) => wallets.enrich(t), logRejection: (r) => log.rejection(r),
    judgeCandidate: async (c) => {
      const state = leanState({
        wallet_win_rate: round(c.wallet.win_rate, 3), wallet_realized_pnl_usd: round(c.wallet.pnl, 0), wallet_median_hold_s: round(c.wallet.median_hold_s, 0),
        wallet_size_cv: round(c.wallet.size_cv, 2), wallet_early_count: c.wallet.early_count, wallet_trades: c.wallet.trades,
        move_size_usd: round(c.move.size_usd, 0), move_vs_median_size: round(c.move.vs_median, 2), move_side: c.move.side,
        token_top10_pct: round(c.top10_pct, 1), token_liquidity_usd: round(c.liquidity_usd, 0), token_age_s: c.age_s,
        token_flags: Object.entries(c.flags ?? {}).filter(([, v]) => v === true).map(([k]) => k),
      }, batteries.spy.reads, cfg.state_token_budget);
      const d = await ask('spy', state, c.lead_id);
      if (!d.ok) return { pass: false, reason: 'judge_unavailable' };
      const intent = policies.spy(d.answers, state, cfg);
      log.decision({ decision_id: d.decision_id, lead_id: c.lead_id, bot: 'spy', mode, state, answers: d.answers, model_version: d.model_version, latency_ms: d.latency_ms, policy: intent, token: c.id });
      pending.push({ bot: 'spy', decision_id: d.decision_id, resolveAt: tick, state, answers: d.answers, truth: c._truth });
      return { pass: intent.intent === 'enter', reason: (d.answers.rug?.p ?? 1) > cfg.spy.max_rug_prob ? 'jev_rug' : 'jev_not_worth_it', sort_key: (d.answers.wallet_kind?.probs?.skilled ?? 0), intent, decision: d, state };
    },
  });

  async function spyTick() {
    const book = books.spy;
    if (book.open) { // EXIT seat for the spy: time stop in this skeleton; swap for exitRule() on real volume data
      if (tick - book.open.tick >= cfg.spy.max_hold_ticks) { log.event({ type: 'exit', lead_id: book.open.lead_id, reason: 'time_stop' }); book.release(book.open.lead_id, 'EXIT'); }
      return; // one position at a time: no scan while one is open
    }
    const now = Date.now();
    const cands = Array.from({ length: 8 }, () => wallets.next()).map(({ wallet, token, move }) => ({ ...token, wallet, move }));
    const { pick, stats } = await funnel.run(cands);
    log.event({ type: 'funnel', stats });
    if (!pick) return; // no trade is a result
    const { intent, decision } = pick.verdict;
    const order = { market: pick.id, side: intent.side, notional_usd: intent.notional_usd, type: 'market', leverage: 1, expected_edge_bps: 50 };
    // Spy trades are synthetic tokens; the paper broker has no book for them, so spy stays shadow-only here.
    const v = risk.check(order, { positions: positionsUsd(), model_version: decision.model_version });
    log.trade({ mode: 'shadow', bot: 'spy', lead_id: pick.lead_id, token: pick.id, order, allowed: v.allowed, vetoes: v.vetoes, age_ms: Date.now() - now });
    if (v.allowed) { counters.would_trade++; book.claim({ lead_id: pick.lead_id, bot: 'spy', market: pick.id, tick }); }
    else counters.vetoes++;
  }

  // ---------------------------------------------------------------- outcomes
  function resolveOutcomes(snapNow) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (p.resolveAt > tick) continue;
      pending.splice(i, 1);
      let labels = {};
      if (p.bot === 'gambler') labels = gamblerLabels(p.state, p.snap, snapNow, p.cost);
      else if (p.bot === 'house') labels = houseLabels(p.state, p.snap, snapNow);
      else if (p.bot === 'spy') labels = spyLabels(p.truth);
      const rows = [];
      for (const [qid, label] of Object.entries(labels)) {
        if (p.bot === 'spy' && qid === 'wallet_kind') { const a = p.answers.wallet_kind; if (a) rows.push({ question: 'wallet_kind=skilled', p: a.probs.skilled, y: p.truth.wallet_skilled ? 1 : 0 }); continue; }
        rows.push(...rowsFor(qid, p.answers[qid], label));
      }
      for (const r of rows) log.outcome({ decision_id: p.decision_id, bot: p.bot, ...r });
    }
  }

  async function step() {
    tick++;
    const snap = feed.step();
    lastSnap = snap;
    broker.onBook(snap.market, snap.book);
    broker.onBook('HOUSE-' + snap.market, snap.book);
    if (risk.halted) { if (tick % 50 === 0) log.event({ type: 'halted', reason: risk.halted, msg: 'Desk halted. Waiting for a human to review and resume.' }); resolveOutcomes(snap); return; }
    const jobs = [];
    if (bots.includes('gambler')) jobs.push(gamblerTick(snap));
    if (bots.includes('house') && tick % 5 === 0) jobs.push(houseTick(snap));
    if (bots.includes('spy') && tick % 25 === 0) jobs.push(spyTick());
    await Promise.all(jobs);
    resolveOutcomes(snap);
  }

  return { step, counters, risk, broker, books, get tick() { return tick; } };
}

const round = (x, dp) => (Number.isFinite(x) ? Number(x.toFixed(dp)) : null);

// ---------------------------------------------------------------- entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const mode = process.env.DESK_MODE || cfg.mode_default;
  const ticks = Number(process.env.DESK_TICKS || 0); // 0 = run until stopped
  const judge = process.env.JUDGE_URL
    ? createJudgeClient()
    : createLocalJudge({ ask: createMockJev({ version: cfg.model_version_pin }), model: cfg.model_version_pin, batteries });
  if (!process.env.JUDGE_URL) console.log('JUDGE_URL not set → using in-process MOCK judge (no Jev calls).');
  const desk = createDesk({ mode, cfg, judge });
  console.log(`desk mode=${mode} block=${cfg.block_ms}ms deadline=${cfg.decision_deadline_ms}ms pin=${cfg.model_version_pin}`);
  let stopping = false;
  process.on('SIGINT', () => (stopping = true));
  process.on('SIGTERM', () => (stopping = true));
  while (!stopping && (!ticks || desk.tick < ticks)) {
    const started = Date.now();
    await desk.step();
    await new Promise((r) => setTimeout(r, Math.max(0, cfg.block_ms - (Date.now() - started))));
    if (desk.tick % 100 === 0) console.log(`tick ${desk.tick}`, JSON.stringify(desk.counters));
  }
  console.log('final', JSON.stringify({ ...desk.counters, realized_today_usd: desk.risk.realizedToday, halted: desk.risk.halted }));
}
