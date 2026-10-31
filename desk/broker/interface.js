// The broker contract. Paper and (future) live implement the same methods so the desk never branches on mode.
/**
 * @typedef {{ market:string, side:'buy'|'sell', notional_usd:number, type:'market'|'limit', price?:number, post_only?:boolean, client_id:string }} OrderRequest
 * @typedef {{ order_id:string, status:'filled'|'resting'|'rejected', fill_price?:number, qty?:number, fee_usd?:number, reason?:string }} OrderResult
 * Broker: { place(OrderRequest): Promise<OrderResult>, cancel(order_id), cancelAll(market), position(market), positions(), onBook(market, book), equity(marks) }
 */
export const BROKER_METHODS = ['place', 'cancel', 'cancelAll', 'position', 'positions', 'onBook', 'equity'];

export function assertBroker(b) {
  for (const m of BROKER_METHODS) if (typeof b[m] !== 'function') throw new Error(`broker missing ${m}()`);
  return b;
}

// Deliberately not implemented. A live broker needs: your explicit approval, a trading-only key with
// withdrawals disabled, and a bot that has climbed the trust ladder. See desk/README.md.
export function createLiveBroker() {
  throw new Error('Live broker is disabled in this skeleton. Paper trading only.');
}
