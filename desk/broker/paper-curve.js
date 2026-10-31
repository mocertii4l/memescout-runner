// Paper broker for pump.fun bonding curves. Fills at exact constant-product prices including the fee.
// Same interface as the order-book paper broker; `onBook(market, curve)` takes the latest decoded curve.
//
// Two fill models:
//   optimistic  — instant fill at the curve you just read. A ceiling: real trading does worse.
//   pessimistic — a sniper buys `front_run_sol` ahead of you, extra slippage on top, a priority fee per
//                 transaction, and a `fail_rate` chance the transaction doesn't land (fee still paid).
//                 (The decision→fill delay is applied by the runner, which re-reads the curve after waiting.)
import { assertBroker } from './interface.js';
import { quoteBuy, quoteSell, spotPriceSol, applyBuy } from '../feeds/pumpcurve.js';
import { rng } from '../feeds/synthetic.js';

export function createCurvePaperBroker({ feeBps = 125, gasSol = 0.0005, model = 'optimistic', pess = {}, rand = rng(1234), onFill = () => {} } = {}) {
  const P = { front_run_sol: 0.5, extra_slippage_bps: 300, fail_rate: 0.15, priority_fee_sol: 0.001, ...pess };
  const pessimistic = model === 'pessimistic';
  let seq = 0;
  const curves = new Map(), pos = new Map();
  const txCost = () => gasSol + (pessimistic ? P.priority_fee_sol : 0);

  function failed(id, req, side) {
    // The transaction didn't land. You still pay the network + priority fee.
    const res = { order_id: id, status: 'failed', side, ledger: model, fee_sol: txCost(), realized_usd: -txCost() * req.sol_usd };
    const p = pos.get(req.market);
    if (p) p.cost_sol += txCost(); // a failed exit's fee is part of the position's cost
    onFill({ ...req, ...res });
    return res;
  }

  return assertBroker({
    model,
    /** req: { market, side, notional_usd, sol_usd, client_id } */
    async place(req) {
      const id = `paper-curve-${model}-${++seq}`;
      const c0 = curves.get(req.market);
      if (!c0) return { order_id: id, status: 'rejected', reason: 'no_curve', ledger: model };
      if (req.side === 'buy') {
        if (c0.complete) return { order_id: id, status: 'rejected', reason: 'curve_complete', ledger: model };
        if (pessimistic && rand() < P.fail_rate) return failed(id, req, 'buy');
        const c = pessimistic ? applyBuy(c0, P.front_run_sol) : c0;
        const solIn = req.notional_usd / req.sol_usd;
        const q = quoteBuy(c, solIn, feeBps);
        const tokens = q.tokensOut * (pessimistic ? 1 - P.extra_slippage_bps / 1e4 : 1);
        const p = pos.get(req.market) ?? { tokens: 0, cost_sol: 0 };
        pos.set(req.market, { tokens: p.tokens + tokens, cost_sol: p.cost_sol + solIn + txCost(), entry_price_sol: solIn / tokens });
        const res = { order_id: id, status: 'filled', side: 'buy', ledger: model, fill_price_sol: solIn / tokens, curve_price_sol: spotPriceSol(c0), qty: tokens, fee_sol: q.feeSol + txCost(), sol_in: solIn };
        onFill({ ...req, ...res });
        return res;
      }
      const p = pos.get(req.market);
      if (!p?.tokens) return { order_id: id, status: 'rejected', reason: 'no_position', ledger: model };
      if (pessimistic && rand() < P.fail_rate) return failed(id, req, 'sell');
      const q = quoteSell(c0, p.tokens, feeBps);
      const solOut = q.solOut * (pessimistic ? 1 - P.extra_slippage_bps / 1e4 : 1);
      const pnlSol = solOut - txCost() - p.cost_sol;
      pos.delete(req.market);
      // A graduated curve can't really be sold into (liquidity moved to PumpSwap); paper closes at the final curve and flags it.
      const res = { order_id: id, status: 'filled', side: 'sell', ledger: model, graduated: c0.complete || undefined, fill_price_sol: solOut / p.tokens, curve_price_sol: spotPriceSol(c0), qty: p.tokens, fee_sol: q.feeSol + txCost(), sol_out: solOut, realized_sol: pnlSol, realized_usd: pnlSol * req.sol_usd };
      onFill({ ...req, ...res });
      return res;
    },
    /** Pessimistic give-up: a position that can't be exited after N tries is written off at zero. */
    writeOff(market, solUsd) {
      const p = pos.get(market);
      if (!p) return null;
      pos.delete(market);
      const res = { status: 'written_off', side: 'sell', ledger: model, market, realized_sol: -p.cost_sol, realized_usd: -p.cost_sol * solUsd };
      onFill(res);
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
