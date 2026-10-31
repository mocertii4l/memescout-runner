// Paper broker for pump.fun bonding curves. Fills at exact constant-product prices including the fee.
// Same interface as the order-book paper broker; `onBook(market, curve)` takes the latest decoded curve.
import { assertBroker } from './interface.js';
import { quoteBuy, quoteSell, spotPriceSol } from '../feeds/pumpcurve.js';

export function createCurvePaperBroker({ feeBps = 125, gasSol = 0.0005, onFill = () => {} } = {}) {
  let seq = 0;
  const curves = new Map(), pos = new Map();
  return assertBroker({
    /** req: { market, side, notional_usd, sol_usd, client_id } */
    async place(req) {
      const id = `paper-curve-${++seq}`;
      const c = curves.get(req.market);
      if (!c) return { order_id: id, status: 'rejected', reason: 'no_curve' };
      if (req.side === 'buy') {
        if (c.complete) return { order_id: id, status: 'rejected', reason: 'curve_complete' };
        const solIn = req.notional_usd / req.sol_usd;
        const q = quoteBuy(c, solIn, feeBps);
        const p = pos.get(req.market) ?? { tokens: 0, cost_sol: 0 };
        pos.set(req.market, { tokens: p.tokens + q.tokensOut, cost_sol: p.cost_sol + solIn + gasSol, entry_price_sol: q.avgPriceSol });
        const res = { order_id: id, status: 'filled', side: 'buy', fill_price_sol: q.avgPriceSol, qty: q.tokensOut, fee_sol: q.feeSol + gasSol, sol_in: solIn };
        onFill({ ...req, ...res });
        return res;
      }
      const p = pos.get(req.market);
      if (!p?.tokens) return { order_id: id, status: 'rejected', reason: 'no_position' };
      const q = quoteSell(c, p.tokens, feeBps);
      const pnlSol = q.solOut - gasSol - p.cost_sol;
      pos.delete(req.market);
      // A graduated curve can't really be sold into (liquidity moved to PumpSwap); paper closes at the final curve and flags it.
      const res = { order_id: id, status: 'filled', side: 'sell', graduated: c.complete || undefined, fill_price_sol: q.avgPriceSol, qty: p.tokens, fee_sol: q.feeSol + gasSol, sol_out: q.solOut, realized_sol: pnlSol, realized_usd: pnlSol * req.sol_usd };
      onFill({ ...req, ...res });
      return res;
    },
    async cancel() { return false; },
    async cancelAll() { return 0; },
    position: (m) => ({ ...(pos.get(m) ?? { tokens: 0, cost_sol: 0 }) }),
    positions: () => Object.fromEntries([...pos].map(([m, p]) => [m, { ...p }])),
    onBook(market, curve) { if (curve) curves.set(market, curve); return []; },
    equity() { let e = 0; for (const [m, p] of pos) { const c = curves.get(m); e += c ? p.tokens * spotPriceSol(c) : 0; } return e; },
  });
}
