// House policy: Avellaneda–Stoikov quotes stay in code; Jev only decides whether to quote at all.

/** Reservation price and optimal total spread (Avellaneda & Stoikov 2008). sigma in price units per sqrt(second). */
export function avellanedaStoikov({ mid, inventory, sigma, gamma, kappa, horizonS }) {
  const reservation = mid - inventory * gamma * sigma ** 2 * horizonS;
  const spread = gamma * sigma ** 2 * horizonS + (2 / gamma) * Math.log(1 + gamma / kappa);
  return { reservation, bid: reservation - spread / 2, ask: reservation + spread / 2, spread };
}

export function gridLevels({ center, levels, stepBps }) {
  const half = Math.floor(levels / 2);
  const out = [];
  for (let i = 1; i <= half; i++) {
    out.push({ side: 'buy', price: center * (1 - (i * stepBps) / 1e4) });
    out.push({ side: 'sell', price: center * (1 + (i * stepBps) / 1e4) });
  }
  return out;
}

export function housePolicy(answers, state, cfg) {
  const c = cfg.house;
  const a = answers ?? {};
  const breakout = a.range_state?.probs?.breaking_out;
  const toxic = a.toxic_flow?.p;
  const env = a.environment?.expected;
  const alive = a.volume_alive?.p;

  if (alive === null || alive === undefined) return { intent: 'pull', why: ['volume=unknown'] };
  if (alive < c.kill_volume_dead_prob) return { intent: 'kill', why: [`volume_alive=${alive.toFixed(2)}`] };
  if (breakout === undefined || breakout === null) return { intent: 'pause', why: ['range_state=unknown'] };
  if (breakout >= c.pause_breakout_prob) return { intent: 'pause', why: [`breakout=${breakout.toFixed(2)}`] };
  if (toxic === null || toxic === undefined || toxic >= c.pull_toxic_prob) return { intent: 'pull', why: [`toxic=${toxic ?? 'unknown'}`] };
  if (env === null || env === undefined || env < c.min_environment_score) return { intent: 'pause', why: [`environment=${env ?? 'unknown'}`] };
  // Unknown is its own consequence: a wider quote, not a guess.
  const widen = toxic >= c.widen_toxic_prob ? 2 : 1;
  return { intent: 'quote', step_bps: c.grid_step_bps * widen, level_size_usd: c.level_size_usd, levels: c.grid_levels, why: widen > 1 ? ['widened: toxic flow'] : ['quote'] };
}
