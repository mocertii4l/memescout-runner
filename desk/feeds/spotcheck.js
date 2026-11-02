// Spot-check: compare a paper fill against what real traders actually paid on the same bonding curve
// around the same moment. Read-only RPC: getSignaturesForAddress + getTransaction.

/** Parse one transaction into a real curve trade: { ts, side, price_sol, sol, tokens } or null. */
export function parseCurveTrade(tx, curveKey, mint) {
  if (!tx?.meta || tx.meta.err) return null;
  const keys = tx.transaction?.message?.accountKeys?.map((k) => (typeof k === 'string' ? k : k.pubkey)) ?? [];
  const i = keys.indexOf(curveKey);
  if (i < 0) return null;
  const dSol = (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
  const bal = (list) => (list ?? []).filter((b) => b.owner === curveKey && b.mint === mint).reduce((s, b) => s + Number(b.uiTokenAmount?.uiAmount ?? 0), 0);
  const dTok = bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances);
  if (!dSol || !dTok || Math.sign(dSol) === Math.sign(dTok)) return null;
  return { ts: (tx.blockTime ?? 0) * 1000, side: dSol > 0 ? 'buy' : 'sell', price_sol: Math.abs(dSol) / Math.abs(dTok), sol: Math.abs(dSol), tokens: Math.abs(dTok) };
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Optimism in bps: positive = the paper fill was BETTER than reality (paper is flattering you).
 * buy: paid less than real buyers; sell: received more than real sellers.
 */
export function optimismBps(side, paperPrice, realPrice) {
  if (!(paperPrice > 0) || !(realPrice > 0)) return null;
  return side === 'buy' ? ((realPrice - paperPrice) / realPrice) * 1e4 : ((paperPrice - realPrice) / realPrice) * 1e4;
}

export function compareFill(fill, realTrades, windowMs = 15000) {
  const near = realTrades.filter((t) => Math.abs(t.ts - fill.ts) <= windowMs);
  const same = near.filter((t) => t.side === fill.side);
  const ref = median(same.map((t) => t.price_sol)) ?? median(near.map((t) => t.price_sol));
  return {
    real_trades_in_window: near.length,
    same_side_trades: same.length,
    real_median_price_sol: ref,
    optimistic_bps: optimismBps(fill.side, fill.optimistic_price_sol, ref),
    pessimistic_bps: optimismBps(fill.side, fill.pessimistic_price_sol, ref),
  };
}

/** Fetch real trades on a curve within ±windowMs of `ts`. Pages back through signatures; caps tx fetches. */
export async function fetchRealTrades(rpc, { curveKey, mint, ts, windowMs = 15000, maxTx = 25, maxPages = 4 }) {
  const lo = (ts - windowMs) / 1000, hi = (ts + windowMs) / 1000;
  const sigs = [];
  let before;
  for (let page = 0; page < maxPages; page++) {
    const batch = await rpc.call('getSignaturesForAddress', [curveKey, { limit: 100, ...(before ? { before } : {}), commitment: 'confirmed' }]);
    if (!batch?.length) break;
    for (const s of batch) if (!s.err && s.blockTime >= lo && s.blockTime <= hi) sigs.push(s.signature);
    before = batch.at(-1).signature;
    if (batch.at(-1).blockTime < lo) break;
  }
  // Closest-in-time first would need blockTime per sig; signatures are newest-first, so sample evenly.
  const step = Math.max(1, Math.ceil(sigs.length / maxTx));
  const picked = sigs.filter((_, i) => i % step === 0).slice(0, maxTx);
  const out = [];
  for (const sig of picked) {
    // Solana now has v1 transactions; asking for v0 only makes the RPC refuse them (verified on mainnet, Oct 2026).
    const tx = await rpc.call('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]).catch(() => null);
    const t = parseCurveTrade(tx, curveKey, mint);
    if (t) out.push(t);
  }
  return out;
}
