// Deterministic state builder. Code owns every number; Jev only ever sees the result.
// Every field is computed from data stamped strictly before `asOf` — no lookahead.

const r = (x, dp = 6) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(dp)));

export function midPrice(book) {
  const bid = book?.bids?.[0]?.[0], ask = book?.asks?.[0]?.[0];
  return Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null;
}

export function spreadBps(book) {
  const bid = book?.bids?.[0]?.[0], ask = book?.asks?.[0]?.[0];
  const mid = midPrice(book);
  return mid ? ((ask - bid) / mid) * 1e4 : null;
}

/** Top-N depth imbalance in [-1, 1]; positive = more resting bids. */
export function imbalance(book, levels = 5) {
  const sum = (side) => (side ?? []).slice(0, levels).reduce((s, [, q]) => s + q, 0);
  const b = sum(book?.bids), a = sum(book?.asks);
  return b + a > 0 ? (b - a) / (b + a) : null;
}

/** Log return over the last `n` closes, in bps. */
export function returnBps(closes, n) {
  if (!closes || closes.length <= n) return null;
  const last = closes[closes.length - 1], prev = closes[closes.length - 1 - n];
  return prev > 0 ? Math.log(last / prev) * 1e4 : null;
}

/** Realized volatility (stdev of log returns) over the last `n` closes, in bps per bar. */
export function realizedVolBps(closes, n) {
  if (!closes || closes.length < n + 1) return null;
  const xs = closes.slice(-(n + 1));
  const rets = [];
  for (let i = 1; i < xs.length; i++) rets.push(Math.log(xs[i] / xs[i - 1]));
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const v = rets.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, rets.length - 1);
  return Math.sqrt(v) * 1e4;
}

export function drawdownPct(equityCurve) {
  if (!equityCurve?.length) return null;
  let peak = -Infinity;
  for (const e of equityCurve) peak = Math.max(peak, e);
  const last = equityCurve[equityCurve.length - 1];
  return peak > 0 ? ((peak - last) / peak) * 100 : null;
}

/**
 * Build the market snapshot.
 * @param {object} raw  { asOf, book:{ts,bids,asks}, bars:[{ts,close,high,low,volume}], funding, position:{qty,avgPrice}, equityCurve }
 */
export function buildMarketState(raw, { windows = [5, 20, 60], volWindow = 20, rangeWindow = 60 } = {}) {
  const asOf = raw.asOf;
  const bars = (raw.bars ?? []).filter((b) => b.ts < asOf); // strictly before the decision
  const book = raw.book && raw.book.ts < asOf ? raw.book : null; // stale-or-future book → missing, not guessed
  const closes = bars.map((b) => b.close);
  const recent = bars.slice(-rangeWindow);
  const hi = recent.length ? Math.max(...recent.map((b) => b.high)) : null;
  const lo = recent.length ? Math.min(...recent.map((b) => b.low)) : null;
  const mid = midPrice(book);
  const qty = raw.position?.qty ?? 0;
  return {
    mid: r(mid, 8),
    spread_bps: r(spreadBps(book), 2),
    imbalance: r(imbalance(book), 3),
    ret_bps: Object.fromEntries(windows.map((n) => [`b${n}`, r(returnBps(closes, n), 1)])),
    rvol_bps: r(realizedVolBps(closes, volWindow), 1),
    funding_bps: r(raw.funding ?? null, 2),
    to_high_bps: hi && mid ? r(((hi - mid) / mid) * 1e4, 1) : null,
    to_low_bps: lo && mid ? r(((mid - lo) / mid) * 1e4, 1) : null,
    inventory_usd: mid !== null ? r(qty * mid, 2) : null,
    drawdown_pct: r(drawdownPct(raw.equityCurve), 2),
  };
}

/** Rough token estimate (≈4 chars/token) used to keep the state lean. */
export function estimateTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

/** Pick only the fields a battery reads, and enforce the budget. Nulls stay null: missing is not neutral. */
export function leanState(full, fields, budget = 400) {
  const out = {};
  for (const f of fields) out[f] = full[f] === undefined ? null : full[f];
  const t = estimateTokens(out);
  if (t > budget) throw new Error(`state over token budget: ${t} > ${budget}`);
  return out;
}
