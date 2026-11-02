// Daily summary, per desk and per ledger, so nothing is double counted.
//   headline = pessimistic ledger (what the risk engine uses); optimistic = the ceiling, for comparison.
import { readStream } from './read.js';
import { isMain } from '../config/main.js';

const DESK = (bot) => ({ launch: 'strict', launch_loose: 'loose', launch_ghost: 'strict (while halted, not counted)', launch_loose_ghost: 'loose (while halted, not counted)' })[bot] ?? bot ?? 'unknown';
const usd = (x) => Math.round(x * 100) / 100;

export function dailySummary(day) {
  const trades = readStream('trades', { day });
  const events = readStream('events', { day });
  const decisions = readStream('decisions', { day });
  const rejections = readStream('rejections', { day });
  const vetoes = readStream('vetoes', { day });
  const spot = readStream('spotchecks', { day });
  const desks = {};
  const D = (bot) => (desks[DESK(bot)] ??= { judged: 0, entered: 0, skipped: 0, closed_trades: 0, wins: 0, pessimistic_pnl_usd: 0, optimistic_pnl_usd: 0, fees_usd: 0, failed_tx: 0, written_off: 0, exit_reasons: {}, launches_rejected: 0, top_rejections: {}, lookup_retries: 0, daily_loss_halts: 0 });

  for (const d of decisions) { const x = D(d.bot); if (d.policy) { x.judged++; d.policy.intent === 'enter' ? x.entered++ : x.skipped++; } }
  for (const t of trades) {
    const x = D(t.bot);
    const fee = t.fee_usd ?? (t.fee_sol != null && t.sol_usd ? t.fee_sol * t.sol_usd : 0);
    if (t.ledger === 'optimistic') { if (Number.isFinite(t.realized_usd)) x.optimistic_pnl_usd += t.realized_usd; continue; }
    x.fees_usd += fee;
    if (Number.isFinite(t.realized_usd) && ['filled', 'failed', 'written_off'].includes(t.status)) x.pessimistic_pnl_usd += t.realized_usd;
    if (t.status === 'failed') x.failed_tx++;
    if (t.status === 'written_off') x.written_off++;
  }
  for (const e of events.filter((e) => e.type === 'exit' && e.ledger === 'pessimistic')) {
    const x = D(e.bot); x.closed_trades++; if (e.realized_usd > 0) x.wins++;
    x.exit_reasons[e.reason] = (x.exit_reasons[e.reason] ?? 0) + 1;
  }
  // Count each launch once, by the reason that finally rejected it; lookup retries are counted separately.
  const final = new Map();
  for (const r of rejections) {
    if (r.retry) { D(r.bot).lookup_retries++; continue; }
    final.set(`${r.bot}|${r.id ?? r.market}`, r);
  }
  for (const r of final.values()) { const x = D(r.bot); x.launches_rejected++; x.top_rejections[r.check] = (x.top_rejections[r.check] ?? 0) + 1; }
  for (const v of vetoes) if (v.halt === 'daily_loss') D(v.bot).daily_loss_halts++;

  for (const x of Object.values(desks)) {
    x.pessimistic_pnl_usd = usd(x.pessimistic_pnl_usd); x.optimistic_pnl_usd = usd(x.optimistic_pnl_usd); x.fees_usd = usd(x.fees_usd);
    x.win_rate = x.closed_trades ? `${Math.round((x.wins / x.closed_trades) * 100)}%` : '—';
    x.avg_pnl_per_trade_usd = x.closed_trades ? usd(x.pessimistic_pnl_usd / x.closed_trades) : null;
    x.top_rejections = Object.fromEntries(Object.entries(x.top_rejections).sort((a, b) => b[1] - a[1]).slice(0, 8));
    delete x.wins;
  }
  const ok = spot.filter((s) => s.real_median_price_sol > 0);
  const med = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? Math.round(s[s.length >> 1]) : null; };
  const lat = decisions.map((d) => d.latency_ms).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    day,
    note: 'P/L per desk: pessimistic = headline (fees, slippage, failed tx included). Optimistic = best-case ceiling. Judge = MOCK rules until a Jev key is set.',
    desks,
    spot_checks: { checked: spot.length, with_real_trades: ok.length, median_optimistic_flattery_bps: med(ok.map((s) => s.optimistic_bps)), median_pessimistic_flattery_bps: med(ok.map((s) => s.pessimistic_bps)) },
    judge_latency_ms: { p50: lat[lat.length >> 1] ?? null, max: lat.at(-1) ?? null },
    alerts: events.filter((e) => e.type === 'alert').map((e) => e.msg),
  };
}

if (isMain(import.meta.url)) {
  const day = process.argv[2] || new Date().toISOString().slice(0, 10);
  console.log(JSON.stringify(dailySummary(day), null, 2));
}
