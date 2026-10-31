import { choice, noul, validateBattery } from './types.js';

// Bot 3 — The Spy. Copies wallets with an existing edge. Hard contract flags veto in code before this runs.
export default validateBattery({
  name: 'spy',
  reads: ['wallet_win_rate', 'wallet_realized_pnl_usd', 'wallet_median_hold_s', 'wallet_size_cv', 'wallet_early_count', 'wallet_trades', 'move_size_usd', 'move_vs_median_size', 'move_side', 'token_top10_pct', 'token_liquidity_usd', 'token_age_s', 'token_flags'],
  questions: [
    choice('wallet_kind', "This wallet's track record looks:", ['skilled', 'lucky', 'bot_like', 'insider_like', 'unknown']),
    noul('consistent', "Is this move consistent with how this wallet usually trades?"),
    choice('mirror', 'How should we mirror this move?', ['full', 'partial', 'skip']),
    noul('rug', 'Given the token flags, does this token look like a rug pull?'),
  ],
  pairs: [{ choice: 'mirror', gate: 'consistent' }],
});
