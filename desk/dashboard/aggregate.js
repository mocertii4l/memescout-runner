// Turns the JSONL logs into one JSON payload for the dashboard. Read-only: never writes, never trades.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStream, LOG_DIR } from '../reports/read.js';
import { calibrationReport } from '../reports/calibration.js';
import { loadConfig } from '../config/index.js';

// Explore profiles (e.g. launch_loose) are shown for comparison but never counted in the account.
const isExplore = (r) => /^launch_/.test(r.bot ?? '') || /^solana-/.test(r.runner ?? '');
const botOf = (r) => r.bot ?? (String(r.market ?? '').startsWith('HOUSE-') ? 'house' : 'gambler');

export function availableDays(dir = LOG_DIR) {
  if (!existsSync(dir)) return [];
  return [...new Set(readdirSync(dir).map((f) => f.match(/-(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1]).filter(Boolean))].sort().reverse();
}

export function readStatuses(dir = LOG_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^status-.*\.json$/.test(f)).map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean);
}

export function aggregate({ day, bot = 'all', dir = LOG_DIR, now = Date.now(), cfg = loadConfig() } = {}) {
  day ??= availableDays(dir)[0] ?? new Date(now).toISOString().slice(0, 10);
  const keep = (r) => bot === 'all' || botOf(r) === bot;
  const decisions = readStream('decisions', { dir, day }).filter(keep);
  const trades = readStream('trades', { dir, day }).filter(keep);
  const vetoes = readStream('vetoes', { dir, day }).filter(keep);
  const rejections = readStream('rejections', { dir, day }).filter(keep);
  const events = readStream('events', { dir, day }).filter(keep);
  const outcomes = readStream('outcomes', { dir, day }).filter(keep);
  const spotchecks = readStream('spotchecks', { dir, day }).filter(keep);
  // The optimistic ledger is a ceiling shown for comparison; headline numbers use everything else.
  const counted = (t) => t.ledger !== 'optimistic';

  // Cumulative realized PnL after fees, per bot, from paper fills.
  const pnl = {};
  const fills = trades.filter((t) => ['filled', 'failed', 'written_off'].includes(t.status) || t.shadow_exit).sort((a, b) => a.ts - b.ts);
  for (const t of fills) {
    if (t.ledger === 'optimistic' && isExplore(t)) continue; // explore desks: pessimistic line only, to keep the chart readable
    const b = botOf(t) + (t.ledger === 'optimistic' ? ':optimistic' : '');
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
  const totalPnl = Object.entries(pnl).filter(([k]) => !k.endsWith(':optimistic') && !k.startsWith('launch_')).reduce((s, [, xs]) => s + (xs.at(-1)?.[1] ?? 0), 0);
  const optimisticPnl = Object.entries(pnl).filter(([k]) => !k.startsWith('launch_')).reduce((s, [k, xs]) => s + (k.endsWith(':optimistic') || !pnl[k + ':optimistic'] ? (xs.at(-1)?.[1] ?? 0) : 0), 0);
  const fees = trades.filter(counted).reduce((s, t) => s + (t.fee_usd ?? (t.fee_sol != null && t.sol_usd ? t.fee_sol * t.sol_usd : 0)), 0);

  return {
    generated_at: now, day, bot, days: availableDays(dir),
    statuses,
    kpis: {
      pnl_usd: +totalPnl.toFixed(2),
      pnl_optimistic_usd: +optimisticPnl.toFixed(2),
      has_two_ledgers: Object.keys(pnl).some((k) => k.endsWith(':optimistic')),
      fees_usd: +fees.toFixed(2),
      decisions: decisions.length,
      fills: trades.filter((t) => t.status === 'filled' && counted(t)).length,
      failed_tx: trades.filter((t) => t.status === 'failed').length,
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
      ts: t.ts, bot: botOf(t), ledger: t.ledger ?? null, market: t.market ?? t.token ?? null, side: t.side ?? t.order?.side ?? null, status: t.status ?? (t.shadow ? 'shadow' : t.shadow_exit ? 'shadow_exit' : t.allowed === false ? 'vetoed' : ''),
      price: t.fill_price ?? t.fill_price_sol ?? null, notional_usd: t.notional_usd ?? t.order?.notional_usd ?? null, realized_usd: t.realized_usd ?? t.pnl_usd ?? null, fee_usd: t.fee_usd ?? null,
    })),
    spotcheck: summarizeSpotchecks(spotchecks),
    account: account({ dir, statuses, cfg, now, keep }),
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

function summarizeSpotchecks(rows) {
  const ok = rows.filter((r) => r.real_median_price_sol > 0);
  const med = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const share = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.filter((x) => x > 0).length / v.length : null; };
  return {
    checked: rows.length,
    with_real_trades: ok.length,
    median_optimistic_bps: med(ok.map((r) => r.optimistic_bps)),
    median_pessimistic_bps: med(ok.map((r) => r.pessimistic_bps)),
    // Share of fills where even the pessimistic ledger did BETTER than real traders — it isn't pessimistic enough.
    pessimistic_too_kind_share: share(ok.map((r) => r.pessimistic_bps)),
    recent: rows.slice(-25).reverse().map((r) => ({ ts: r.fill_ts ?? r.ts, market: r.market, side: r.side, optimistic_bps: r.optimistic_bps, pessimistic_bps: r.pessimistic_bps, real_median_price_sol: r.real_median_price_sol, optimistic_price_sol: r.optimistic_price_sol, pessimistic_price_sol: r.pessimistic_price_sol, n: r.real_trades_in_window })),
  };
}

/**
 * The paper account across ALL days: start balance + realized (pessimistic / counted ledgers) + open profit.
 * Daily loss and exposure caps come from the runners' own risk engines (enforced).
 * Max-loss and drawdown alert levels are display-only.
 */
function account({ dir, statuses, cfg, now, keep }) {
  const A = cfg.account ?? { paper_start_usd: 1000, alert_max_loss_pct: 10, alert_drawdown_pct: 10 };
  const start = A.paper_start_usd;
  const all = readStream('trades', { dir }).filter(keep).filter((t) => t.ledger !== 'optimistic' && !isExplore(t));
  const realizedRows = all.filter((t) => (['filled', 'failed', 'written_off'].includes(t.status) || t.shadow_exit) && Number.isFinite(t.realized_usd ?? t.pnl_usd)).sort((a, b) => a.ts - b.ts);
  let bal = start;
  const curve = [[realizedRows[0]?.ts ?? now, start]];
  for (const t of realizedRows) { bal += t.realized_usd ?? t.pnl_usd; curve.push([t.ts, +bal.toFixed(4)]); }
  statuses = statuses.filter((s) => !isExplore(s));
  const live = statuses.filter((s) => now - s.ts < 180000);
  const floating = live.reduce((x, s) => x + (s.floating_usd ?? 0), 0);
  const exposure = live.reduce((x, s) => x + (s.exposure_usd ?? 0), 0);
  const openRisk = live.reduce((x, s) => x + (s.open_risk_usd ?? 0), 0);
  const equity = bal + floating;
  curve.push([now, +equity.toFixed(4)]);
  const peak = Math.max(start, ...curve.map((p) => p[1]));
  const dayStart = new Date(new Date(now).toISOString().slice(0, 10)).getTime();
  const realizedToday = realizedRows.filter((t) => t.ts >= dayStart).reduce((x, t) => x + (t.realized_usd ?? t.pnl_usd), 0);
  const exits = readStream('events', { dir }).filter(keep).filter((e) => e.type === 'exit' && e.ledger !== 'optimistic' && !isExplore(e) && Number.isFinite(e.realized_usd));
  const dailyLimit = statuses.reduce((x, s) => x + (s.limits?.daily_loss_limit_usd ?? 0), 0);
  const posCap = statuses.reduce((x, s) => x + (s.limits?.max_position_usd_total ?? 0), 0);
  const openCount = live.reduce((x, s) => x + (s.open?.filter((o) => o.note !== 'shadow').length ?? 0), 0);
  return {
    name: A.name ?? 'Paper desk', subtitle: A.subtitle ?? '', start_usd: start,
    equity_usd: equity, balance_usd: bal, floating_usd: floating, exposure_usd: exposure, free_usd: equity - exposure, leverage: 'none (1:1)',
    total_pnl_usd: equity - start, today_pnl_usd: realizedToday + floating, day_start_usd: equity - realizedToday - floating,
    closed_trades: exits.length, win_rate: exits.length ? exits.filter((e) => e.realized_usd > 0).length / exits.length : null, open_positions: openCount,
    peak_usd: peak, drawdown_usd: peak - equity, drawdown_pct: peak > 0 ? ((peak - equity) / peak) * 100 : 0,
    open_risk_usd: openRisk,
    limits: {
      daily_loss: { used_usd: Math.max(0, -(realizedToday + floating)), limit_usd: dailyLimit, enforced: true },
      exposure: { used_usd: exposure, limit_usd: posCap, enforced: true },
      max_loss: { used_usd: Math.max(0, start - equity), limit_usd: (start * A.alert_max_loss_pct) / 100, enforced: false },
      drawdown: { used_usd: peak - equity, limit_usd: (peak * A.alert_drawdown_pct) / 100, enforced: false },
    },
    equity_curve: curve.length > 1500 ? curve.filter((_, i) => i % Math.ceil(curve.length / 1500) === 0 || i === curve.length - 1) : curve,
  };
}
