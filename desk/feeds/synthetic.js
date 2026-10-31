// Synthetic market + wallet feed for shadow/paper runs without any network. Seeded, reproducible.
// Swap for a real read-only feed (order book websocket, indexer) behind the same shape.

export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

export function createMarketFeed({ market = 'SYN-USDC', start = 1, seed = 7, blockMs = 400, now = () => Date.now() } = {}) {
  const r = rng(seed);
  let price = start, regime = 'chop', regimeLeft = 200, drift = 0, t = now() - 200 * blockMs;
  const bars = [];
  function step() {
    if (--regimeLeft <= 0) { regime = r() < 0.4 ? 'trend' : 'chop'; drift = regime === 'trend' ? (r() < 0.5 ? -1 : 1) * 0.0004 : 0; regimeLeft = 100 + Math.floor(r() * 300); }
    const vol = regime === 'trend' ? 0.0012 : 0.0008;
    const pull = regime === 'chop' ? (start - price) / start * 0.01 : 0;
    price *= Math.exp(drift + pull + vol * gauss(r));
    t += blockMs;
    const hi = price * (1 + Math.abs(gauss(r)) * 0.0003), lo = price * (1 - Math.abs(gauss(r)) * 0.0003);
    bars.push({ ts: t, close: price, high: hi, low: lo, volume: 1000 + r() * 4000 * (regime === 'trend' ? 2 : 1) });
    if (bars.length > 600) bars.shift();
    const half = price * (0.0002 + r() * 0.0004);
    const skew = drift > 0 ? 1.5 : drift < 0 ? 0.6 : 1;
    const level = (side, i) => [side === 'b' ? price - half - i * half : price + half + i * half, (50 + r() * 100) * (side === 'b' ? skew : 1 / skew)];
    const book = { ts: t, bids: [0, 1, 2, 3, 4].map((i) => level('b', i)), asks: [0, 1, 2, 3, 4].map((i) => level('a', i)) };
    return { market, asOf: t + 1, book, bars: bars.slice(), regime };
  }
  for (let i = 0; i < 120; i++) step(); // warm-up history
  return { market, step };
}

/** Wallet moves on candidate tokens, with hidden ground truth so outcomes can be scored later. */
export function createWalletFeed({ seed = 11 } = {}) {
  const r = rng(seed);
  const wallets = Array.from({ length: 20 }, (_, i) => {
    const skilled = r() < 0.3;
    const trades = Math.floor(r() * 200);
    return { address: `W${String(i).padStart(3, '0')}`, skilled, win_rate: skilled ? 0.6 + r() * 0.2 : 0.3 + r() * 0.3, trades, median_hold_s: r() < 0.1 ? 3 : 300 + r() * 3000, size_cv: r(), early_count: Math.floor(r() * 15), pnl: (skilled ? 1 : -0.5) * r() * 50000 };
  });
  let n = 0;
  return {
    next() {
      const w = wallets[Math.floor(r() * wallets.length)];
      const rug = r() < 0.25;
      const token = {
        id: `TOK${++n}`, lead_id: `L-${Date.now().toString(36)}-${n}`,
        liquidity_usd: r() * 40000, volume_5m_usd: r() * 8000, age_s: Math.floor(r() * 3600),
        _truth: { rug, wallet_skilled: w.skilled },
      };
      return { wallet: w, token, move: { side: r() < 0.8 ? 'buy' : 'sell', size_usd: 50 + r() * 2000, vs_median: 0.3 + r() * 2 } };
    },
    async enrich(token) {
      const rug = token._truth.rug;
      return {
        top10_pct: rug ? 40 + r() * 55 : 10 + r() * 45,
        flags: { honeypot: rug && r() < 0.3, mint_authority_open: rug && r() < 0.3, freeze_authority_open: false, liquidity_locked: !(rug && r() < 0.3) },
      };
    },
  };
}
