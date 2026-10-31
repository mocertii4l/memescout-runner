// The funnel: kill in order of cost. Every pass must kill harder than the one after it.
//   0 bench      — free: already rejected, reason still valid
//   1 free cut   — data already in hand (liquidity, volume, age)
//   2 one-call   — a single enrichment call per survivor (contract/holder data)
//   3 hard facts — plain comparisons in code: honeypot, mint/freeze authority, unlocked LP, concentration
//   4 Jev        — judgment only, on the few that remain (capped)
//   5 final pick — one winner by sort key, or nothing. No trade is a result.

export function createFunnel({ cfg, bench, enrich, judgeCandidate, logRejection = () => {} }) {
  const F = cfg.funnel;

  function reject(c, stage, check, extra = {}) {
    bench.bench(c.id, check);
    logRejection({ lead_id: c.lead_id, id: c.id, stage, check, ...extra });
  }

  async function run(candidates) {
    const stats = { in: candidates.length, bench: 0, free: 0, enrich: 0, facts: 0, jev: 0, picked: 0 };

    // 0 + 1: free
    let pool = [];
    for (const c of candidates) {
      const b = bench.isBenched(c.id);
      if (b) { stats.bench++; continue; } // already logged when benched
      if (c.liquidity_usd == null || c.liquidity_usd < F.min_liquidity_usd) { reject(c, 'free', 'low_liquidity'); stats.free++; continue; }
      if (c.volume_5m_usd == null || c.volume_5m_usd < F.min_volume_5m_usd) { reject(c, 'free', 'low_volume'); stats.free++; continue; }
      if (c.age_s == null || c.age_s < F.min_age_s) { reject(c, 'free', 'too_young'); stats.free++; continue; }
      pool.push(c);
    }

    // 2: one enrichment call each
    const enriched = [];
    for (const c of pool) {
      try { enriched.push({ ...c, ...(await enrich(c)) }); }
      catch { reject(c, 'enrich', 'enrich_failed'); stats.enrich++; }
    }

    // 3: hard facts kill before judgments
    pool = [];
    for (const c of enriched) {
      const f = c.flags ?? {};
      const check = f.honeypot ? 'honeypot'
        : f.mint_authority_open ? 'mint_authority_open'
        : f.freeze_authority_open ? 'freeze_authority_open'
        : f.liquidity_locked === false ? 'liquidity_unlocked'
        : (c.top10_pct ?? 100) > F.max_top10_holder_pct ? 'concentration'
        : null;
      if (check) { reject(c, 'facts', check); stats.facts++; continue; }
      pool.push(c);
    }

    // 4: Jev on the few that remain. Cheapest-first ordering, then capped.
    pool.sort((a, b) => b.volume_5m_usd - a.volume_5m_usd);
    for (const c of pool.slice(F.max_jev_candidates)) { reject(c, 'jev', 'over_jev_cap'); stats.jev++; }
    pool = pool.slice(0, F.max_jev_candidates);
    const judged = [];
    for (const c of pool) {
      const v = await judgeCandidate(c); // { pass:boolean, sort_key:number, reason?:string, answers }
      if (!v.pass) { reject(c, 'jev', v.reason ?? 'jev_not_worth_it', { answers: v.answers }); stats.jev++; continue; }
      judged.push({ ...c, verdict: v });
    }

    // 5: one final pick. The Choice/Score orders; the per-candidate Noul gate already said "worth it at all".
    judged.sort((a, b) => b.verdict.sort_key - a.verdict.sort_key);
    const pick = judged[0] ?? null;
    if (pick) stats.picked = 1;
    return { pick, stats };
  }

  return { run };
}
