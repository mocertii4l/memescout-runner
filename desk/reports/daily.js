// Daily summary: decisions, trades, PnL after fees, every risk veto that fired, every fallback.
import { readStream } from './read.js';

export function dailySummary(day) {
  const decisions = readStream('decisions', { day });
  const trades = readStream('trades', { day });
  const vetoes = readStream('vetoes', { day });
  const rejections = readStream('rejections', { day });
  const events = readStream('events', { day });
  const count = (xs, f) => xs.reduce((m, x) => { const k = f(x); if (k != null) m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const lat = decisions.map((d) => d.latency_ms).filter(Number.isFinite).sort((a, b) => a - b);
  const pct = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : null);
  return {
    day,
    decisions: decisions.length,
    by_bot: count(decisions, (d) => d.bot),
    intents: count(decisions, (d) => d.policy ? `${d.bot}:${d.policy.intent}` : `${d.bot}:fallback_${d.fallback}`),
    latency_ms: { p50: pct(0.5), p95: pct(0.95), max: lat.at(-1) ?? null },
    model_versions: count(decisions, (d) => d.model_version),
    paper_fills: trades.filter((t) => t.status === 'filled').length,
    paper_fees_usd: +trades.reduce((s, t) => s + (t.fee_usd ?? 0), 0).toFixed(2),
    pnl_after_fees_usd: +trades.reduce((s, t) => s + (t.realized_usd ?? t.pnl_usd ?? 0), 0).toFixed(2),
    risk_vetoes: count(vetoes.flatMap((v) => v.vetoes ?? [v.veto ?? v.halt]), (v) => String(v).split(':')[0]),
    funnel_rejections: count(rejections, (r) => `${r.stage}:${r.check}`),
    fallbacks: count(events.filter((e) => e.type === 'judge_error' || e.type === 'deadline_missed'), (e) => e.kind ?? e.type),
    alerts: events.filter((e) => e.type === 'alert').map((e) => e.msg),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const day = process.argv[2] || new Date().toISOString().slice(0, 10);
  console.log(JSON.stringify(dailySummary(day), null, 2));
}
