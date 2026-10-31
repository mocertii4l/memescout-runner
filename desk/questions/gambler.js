import { choice, noul, score, validateBattery } from './types.js';

// Bot 1 — The Gambler. Bets on direction. One call per bar.
export default validateBattery({
  name: 'gambler',
  reads: ['mid', 'spread_bps', 'imbalance', 'ret_bps', 'rvol_bps', 'funding_bps', 'to_high_bps', 'to_low_bps', 'inventory_usd', 'rulebook_setup'],
  questions: [
    choice('regime', 'What regime is this market in right now?', ['trending', 'mean_reverting', 'chaotic']),
    noul('buy_pressure', 'Is buying pressure building right now?'),
    score('setup', 'How well does this state match the setup described in rulebook_setup?', [
      'no match', 'weak match', 'clear match', 'textbook match',
    ]),
    choice('action', 'What is the best action for a directional trader here?', ['long', 'short', 'hold']),
    noul('exec_degraded', 'Has execution quality degraded over the last few minutes?'),
  ],
  pairs: [{ choice: 'action', gate: 'setup' }],
});
