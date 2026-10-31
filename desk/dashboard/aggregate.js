// Turns the JSONL logs into one JSON payload for the dashboard. Read-only: never writes, never trades.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStream, LOG_DIR } from '../reports/read.js';
import { calibrationReport } from '../reports/calibration.js';

const botOf = (r) => r.bot ?? (String(r.market ?? '').startsWith('HOUSE-') ? 'house' : 'gambler');

export function availableDays(dir = LOG_DIR) {
  if (!existsSync(dir)) return [];
  return [...new Set(readdirSync(dir).map((f) => f.match(/-(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1]).filter(Boolean))].sort().reverse();
}

export function readStatuses(dir = LOG_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^status-.*\.json$/.test(f)).map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean);
}

export function aggregate({ day, bot = 'all', dir = LOG_DIR, now = Date.now() } = {}) {
  day ??= availableDays(dir)[0] ?? new Date(now).toISOString().slice(0, 10);
  const keep = (r) => bot === 'all' || botOf(r) === bot;
  const decisions = readStream('decisions', { dir, day }).filter(keep);
  const trades = readStream('trades', { dir, day }).filter(keep);
  const vetoes = readStream('vetoes', { dir, day }).filter(keep);
  const rejections = readStream('rejections', { dir, day }).filter(keep);
  const events = readStream('events', { dir, day }).filter(keep);
  const outcomes = readStream('outcomes', { dir, day }).filter(keep);

  // Cumulative realized PnL after fees, per bot, from paper fills.
  const pnl = {};
  const fills = trades.filter((t) => t.status === 'filled' || t.shadow_exit).sort((a, b) => a.ts - b.ts);
  for (const t of fills) {
    const b = botOf(t);
    const v = t.realized_usd ?? t.pnl_usd ?? 0;
    const s = (pnl[b] ??= []);
    s.push([t.ts, +(((s.at(-1)?.[1]) ?? 0) + v).toFixed(4)]);
  }

  // Decisions per minute by intent.
  const perMin = new Map();
  for (const d of decisions) {
    const m = Math.floor(d.ts / 60000) * 60000;
    const k = d.policy ? (['enter', 'quote'].includes(d.policy.intent) ? 'act' : 'hold') : 'fallback';
    const row = perMin.get(m) ?? { t: m, act: 0, hold: 0, fallback: 0 };
    row[k]++; perMin.set(m, row);
  }

  const lat = decisions.map((d) => d.latency_ms).filter(Number.isFinite).sort((a, b) => a - b);
  const pct = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : null);
  const count = (xs, f) => Object.entries(xs.reduce((m, x) => { const k = f(x); if (k != null) m[k] = (m[k] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);

  const statuses = readStatuses(dir);
  const totalPnl = Object.values(pnl).reduce((s, xs) => s + (xs.at(-1)?.[1] ?? 0), 0);
  const fees = trades.reduce((s, t) => s + (t.fee_usd ?? (t.fee_sol != null && t.sol_usd ? t.fee_sol * t.sol_usd : 0)), 0);

  return {
    generated_at: now, day, bot, days: availableDays(dir),
    statuses,
    kpis: {
      pnl_usd: +totalPnl.toFixed(2),
      fees_usd: +fees.toFixed(2),
      decisions: decisions.length,
      fills: trades.filter((t) => t.status === 'filled').length,
      vetoes: vetoes.length,
      rejections: rejections.length,
      latency_p50: pct(0.5), latency_p95: pct(0.95),
      fallbacks: decisions.filter((d) => !d.policy).length,
      alerts: events.filter((e) => e.type === 'alert').length,
    },
    pnl,
    decisions_per_min: [...perMin.values()].sort((a, b) => a.t - b.t).slice(-120),
    intents: count(decisions, (d) => (d.policy ? `${botOf(d)} · ${d.policy.intent}` : `${botOf(d)} · fallback:${d.fallback}`)),
    rejections_by_check: count(rejections, (r) => r.check).slice(0, 12),
    vetoes_by_rule: count(vetoes.flatMap((v) => v.vetoes ?? [v.veto ?? v.halt]), (v) => String(v).split(':')[0]),
    model_versions: count(decisions, (d) => d.model_version),
    recent_decisions: decisions.slice(-40).reverse().map((d) => ({
      ts: d.ts, bot: botOf(d), lead_id: d.lead_id, market: d.market ?? d.token ?? null, intent: d.policy?.intent ?? `fallback:${d.fallback}`,
      why: d.policy?.why?.join(', ') ?? d.kind ?? '', latency_ms: d.latency_ms ?? null, model_version: d.model_version ?? null,
      answers: summarizeAnswers(d.answers), symbol: d.display?.symbol ?? null,
    })),
    recent_trades: trades.slice(-30).reverse().map((t) => ({
      ts: t.ts, bot: botOf(t), market: t.market ?? t.token ?? null, side: t.side ?? t.order?.side ?? null, status: t.status ?? (t.shadow ? 'shadow' : t.shadow_exit ? 'shadow_exit' : t.allowed === false ? 'vetoed' : ''),
      price: t.fill_price ?? t.fill_price_sol ?? null, notional_usd: t.notional_usd ?? t.order?.notional_usd ?? null, realized_usd: t.realized_usd ?? t.pnl_usd ?? null, fee_usd: t.fee_usd ?? null,
    })),
    recent_events: events.filter((e) => e.type !== 'funnel').slice(-30).reverse(),
    calibration: calibrationReport(outcomes.filter((r) => Number.isFinite(r.p))).filter((q) => q.n >= 5).sort((a, b) => b.n - a.n).slice(0, 8)
      .map(({ question, n, brier, base_rate, ece, buckets }) => ({ question, n, brier, base_rate, ece, buckets })),
  };
}

function summarizeAnswers(a) {
  if (!a) return null;
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (!v) out[k] = 'missing';
    else if (v.type === 'noul') out[k] = v.p?.toFixed(2);
    else if (v.type === 'choice') out[k] = `${v.pick} ${v.p?.toFixed(2)}`;
    else out[k] = v.expected?.toFixed(2);
  }
  return out;
}
