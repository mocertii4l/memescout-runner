// Paper broker. Simulates fills against the last seen book. Never signs, never sends anything anywhere.
import { assertBroker } from './interface.js';

export function createPaperBroker({ feeBps = 10, minFeeUsd = 0, startingCashUsd = 1000, onFill = () => {} } = {}) {
  let seq = 0, cash = startingCashUsd, feesPaid = 0;
  const books = new Map();
  const pos = new Map(); // market -> { qty, avg }
  const resting = new Map(); // order_id -> order

  const fee = (notional) => Math.max(minFeeUsd, (notional * feeBps) / 1e4);

  function fill(order, price) {
    const qty = order.notional_usd / price;
    const signed = order.side === 'buy' ? qty : -qty;
    const p = pos.get(order.market) ?? { qty: 0, avg: 0, realized: 0 };
    let realized = 0;
    if (p.qty !== 0 && Math.sign(p.qty) !== Math.sign(signed)) {
      const closing = Math.min(Math.abs(p.qty), Math.abs(signed));
      realized = closing * (price - p.avg) * Math.sign(p.qty);
    }
    const nq = p.qty + signed;
    const avg = nq === 0 ? 0 : Math.sign(nq) === Math.sign(p.qty) && Math.abs(nq) > Math.abs(p.qty) ? (p.avg * p.qty + price * signed) / nq : Math.sign(nq) !== Math.sign(p.qty) ? price : p.avg;
    const f = fee(order.notional_usd);
    cash -= signed * price + f;
    feesPaid += f;
    pos.set(order.market, { qty: nq, avg, realized: p.realized + realized });
    const res = { order_id: order.order_id, status: 'filled', fill_price: price, qty, fee_usd: f, realized_usd: realized - f };
    onFill({ ...order, ...res });
    return res;
  }

  return assertBroker({
    async place(req) {
      const order = { ...req, order_id: `paper-${++seq}` };
      const book = books.get(req.market);
      if (!book) return { order_id: order.order_id, status: 'rejected', reason: 'no_book' };
      const bid = book.bids?.[0]?.[0], ask = book.asks?.[0]?.[0];
      if (req.type === 'market') return fill(order, req.side === 'buy' ? ask : bid);
      const crosses = req.side === 'buy' ? req.price >= ask : req.price <= bid;
      if (crosses && req.post_only) return { order_id: order.order_id, status: 'rejected', reason: 'post_only_would_cross' };
      if (crosses) return fill(order, req.side === 'buy' ? ask : bid);
      resting.set(order.order_id, order);
      return { order_id: order.order_id, status: 'resting' };
    },
    async cancel(id) { return resting.delete(id); },
    async cancelAll(market) { let n = 0; for (const [id, o] of resting) if (!market || o.market === market) { resting.delete(id); n++; } return n; },
    position: (m) => ({ ...(pos.get(m) ?? { qty: 0, avg: 0, realized: 0 }) }),
    positions: () => Object.fromEntries([...pos].filter(([, p]) => p.qty !== 0).map(([m, p]) => [m, { ...p }])),
    restingOrders: () => [...resting.values()],
    onBook(market, book) {
      books.set(market, book);
      const fills = [];
      const bid = book.bids?.[0]?.[0], ask = book.asks?.[0]?.[0];
      for (const [id, o] of resting) {
        if (o.market !== market) continue;
        if ((o.side === 'buy' && ask <= o.price) || (o.side === 'sell' && bid >= o.price)) { resting.delete(id); fills.push(fill(o, o.price)); }
      }
      return fills;
    },
    equity(marks = {}) {
      let e = cash;
      for (const [m, p] of pos) e += p.qty * (marks[m] ?? p.avg);
      return e;
    },
    get feesPaid() { return feesPaid; },
  });
}
