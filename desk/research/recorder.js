// Research recorder: records the price path of every plausible pump.fun launch from creation, without trading,
// so strategies can be backtested on hundreds of tokens a day instead of the few dozen the desk can trade.
// Cost: one getMultipleAccounts call per 100 tracked curves every 5 s, plus one holder lookup per token that
// reaches 1 SOL of real buying. Output: logs/data/research-YYYY-MM-DD.jsonl, one line per finished token.
import { spotPriceSol, isSolQuotedCurve } from '../feeds/pumpcurve.js';
import { RISKY_TOKEN_EXTENSIONS } from '../feeds/solana-rpc.js';
import { holderStats } from './holders.js';

const sig = (x, n = 5) => (Number.isFinite(x) ? Number(x.toPrecision(n)) : null);

export function createRecorder({ rpc, log, now = () => Date.now(), opts = {} } = {}) {
  const O = { sample_ms: 5000, dense_s: 180, sparse_every_s: 15, max_age_s: 1200, dead_after_s: 180, dead_sol: 0.3, holders_min_sol: 1, holders_from_s: 40, max_tracked: 600, max_creator_buy_pct: 20, keep_min_inflow: 0.5, quiet_after_s: 90, quiet_sol: 0.2, ...opts };
  const tracked = new Map();
  const creators = new Map();
  const stats = { started: 0, finished: 0, skipped: 0, ends: {} };

  function onLaunch(l) {
    // Same free cuts both desks use; recording obviously-excluded tokens would only cost RPC and disk.
    const creatorCount = l.creator ? (creators.get(l.creator) ?? []).filter((t) => l.received_at - t < 600_000).length + 1 : 1;
    if (l.creator) { creators.set(l.creator, [...(creators.get(l.creator) ?? []).filter((t) => l.received_at - t < 600_000), l.received_at]); if (creators.size > 5000) creators.delete(creators.keys().next().value); }
    const creatorPct = l.creator_initial_buy_tokens != null ? (l.creator_initial_buy_tokens / 1e9) * 100 : 0;
    if ((l.pool && l.pool !== 'pump') || l.mayhem || !l.bonding_curve || creatorCount > 2 || creatorPct > O.max_creator_buy_pct || tracked.size >= O.max_tracked) { stats.skipped++; return; }
    tracked.set(l.mint, { m: l.mint, k: l.bonding_curve, t0: l.received_at, cb: sig(creatorPct, 3), cbs: l.creator_initial_buy_sol ?? 0, cs: creatorCount, s: [], h: undefined, f: undefined, last: -1, maxIn: 0 });
    stats.started++;
  }

  function finish(r, end) {
    tracked.delete(r.m);
    stats.finished++; stats.ends[end] = (stats.ends[end] ?? 0) + 1;
    // Nothing a SOL desk could trade, or never had enough buying for any rule to enter: not worth the disk.
    if (end === 'non_sol' || end === 'missing' || end === 'never_started' || r.maxIn < O.keep_min_inflow) return;
    log.research({ m: r.m, t0: r.t0, cb: r.cb, cbs: r.cbs, cs: r.cs, f: r.f ?? null, h: r.h ?? null, s: r.s, end });
  }

  async function tick() {
    if (!tracked.size) return;
    const t = now();
    let curves;
    try { curves = await rpc.curves([...tracked.values()].map((r) => r.k)); } catch { return; } // retry next tick
    for (const r of [...tracked.values()]) {
      const age = (t - r.t0) / 1000;
      const c = curves.get(r.k);
      if (!c) { if (age > 30) finish(r, 'missing'); continue; }
      if (!isSolQuotedCurve(c)) { finish(r, 'non_sol'); continue; }
      const price = spotPriceSol(c), realSol = Number(c.realSolReserves) / 1e9;
      r.maxIn = Math.max(r.maxIn, realSol - r.cbs);
      const dt = Math.round(age);
      // 5 s samples for the first 3 minutes, then every 15 s.
      if (dt <= O.dense_s || dt - r.last >= O.sparse_every_s) { r.s.push([dt, sig(price), sig(realSol, 4)]); r.last = dt; }
      // One-off facts once a token shows real buying: mint flags and holder distribution (as the desk would see them).
      if (r.h === undefined && age >= O.holders_from_s && realSol - r.cbs >= O.holders_min_sol) {
        r.h = null;
        Promise.all([rpc.mintInfo(r.m).catch(() => null), rpc.largestHolders(r.m).catch(() => null)]).then(([mi, hs]) => {
          r.f = mi ? { ma: Boolean(mi.mint_authority), fa: Boolean(mi.freeze_authority), rx: (mi.extensions ?? []).some((x) => RISKY_TOKEN_EXTENSIONS.includes(x)) } : null;
          if (hs) { const h = holderStats(hs, c); r.h = { t: dt, top10: h.top10_pct, big: h.largest_holder_pct }; }
        });
      }
      if (c.complete) finish(r, 'graduated');
      else if (age >= O.quiet_after_s && r.maxIn < O.quiet_sol) finish(r, 'never_started');
      else if (age >= O.max_age_s) finish(r, 'time');
      else if (age >= O.dead_after_s && realSol < O.dead_sol) finish(r, 'dead');
    }
  }

  return { onLaunch, tick, stats, get tracking() { return tracked.size; } };
}
