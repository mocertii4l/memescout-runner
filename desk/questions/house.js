import { choice, noul, score, validateBattery } from './types.js';

// Bot 2 — The House. Market making / grid. Doesn't care about direction; cares about chop vs breakout.
export default validateBattery({
  name: 'house',
  reads: ['mid', 'spread_bps', 'imbalance', 'ret_bps', 'rvol_bps', 'range_low', 'range_high', 'to_edge_bps', 'inventory_usd', 'fill_rate_per_min', 'volume_pace_ratio'],
  questions: [
    choice('range_state', 'Where is price relative to the trading range?', ['inside', 'testing_edge', 'breaking_out']),
    noul('toxic_flow', 'Is the incoming order flow toxic, meaning informed traders are picking off resting quotes?'),
    score('environment', 'Is this an environment worth quoting into at all?', [
      'avoid', 'marginal', 'decent', 'ideal',
    ]),
    noul('volume_alive', 'Is volume still flowing through this market?'),
  ],
  pairs: [],
});
