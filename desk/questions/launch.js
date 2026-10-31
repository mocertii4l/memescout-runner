import { choice, noul, score, validateBattery } from './types.js';

// Spy, Solana launch-scanner variant. Runs on real pump.fun launches after hard facts have already vetoed.
// No name/symbol/URI in the state: that text is attacker-controlled and can move the answer.
export default validateBattery({
  name: 'launch',
  reads: ['age_s', 'market_cap_usd', 'curve_progress_pct', 'sol_inflow', 'inflow_sol_per_min', 'creator_initial_buy_pct', 'largest_holder_pct', 'top10_pct', 'holders_seen'],
  questions: [
    choice('launch_kind', 'What does the early flow on this launch look like?', ['organic', 'bundled', 'creator_dump_risk', 'bot_farm', 'unknown']),
    noul('rug', 'Given the holder distribution, does this token look like a rug pull?'),
    noul('momentum', 'Is buying still arriving into the bonding curve right now?'),
    score('quality', 'Is this launch worth a small speculative position at all?', ['avoid', 'marginal', 'decent', 'strong']),
  ],
  pairs: [{ choice: 'launch_kind', gate: 'quality' }],
});
