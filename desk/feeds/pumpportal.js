// Read-only PumpPortal creation stream (subscribeNewToken only — no metered trade-event subscriptions).
// Name, symbol and URI are attacker-controlled text: kept for logs, NEVER put into a judge state.
const URL_DEFAULT = 'wss://pumpportal.fun/api/data';

export function parseCreateEvent(m, receivedAt = Date.now()) {
  if (!m || m.txType !== 'create' || typeof m.mint !== 'string') return null;
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
  return {
    id: m.mint,
    mint: m.mint,
    creator: typeof m.traderPublicKey === 'string' ? m.traderPublicKey : null,
    bonding_curve: typeof m.bondingCurveKey === 'string' ? m.bondingCurveKey : null,
    signature: m.signature ?? null,
    pool: m.pool ?? 'pump',
    creator_initial_buy_tokens: num(m.initialBuy),
    creator_initial_buy_sol: num(m.solAmount),
    v_sol: num(m.vSolInBondingCurve),
    v_tokens: num(m.vTokensInBondingCurve),
    market_cap_sol: num(m.marketCapSol),
    mayhem: m.is_mayhem_mode === true, // pump.fun's own bot trades these at first: artificial flow
    received_at: receivedAt,
    _display: { symbol: String(m.symbol ?? '').slice(0, 16), name: String(m.name ?? '').slice(0, 40) }, // logs only
  };
}

export function connectPumpPortal({ onLaunch, onStatus = () => {}, url = URL_DEFAULT, apiKey = process.env.PUMPPORTAL_API_KEY, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!WebSocketImpl) throw new Error('WebSocket not available (Node ≥22 required)');
  let socket, stopping = false, backoff = 1000, lastMessage = Date.now(), connected = false, everMessage = null;
  function connect() {
    if (stopping) return;
    const u = new URL(url);
    if (apiKey) u.searchParams.set('api-key', apiKey);
    socket = new WebSocketImpl(u);
    socket.addEventListener('open', () => { connected = true; backoff = 1000; lastMessage = Date.now(); socket.send(JSON.stringify({ method: 'subscribeNewToken' })); onStatus({ type: 'feed_connected' }); });
    socket.addEventListener('message', (ev) => {
      lastMessage = Date.now(); everMessage = lastMessage;
      try { const l = parseCreateEvent(JSON.parse(ev.data)); if (l) onLaunch(l); } catch { /* ignore non-JSON */ }
    });
    socket.addEventListener('error', () => { try { socket.close(); } catch {} });
    socket.addEventListener('close', () => {
      connected = false;
      onStatus({ type: 'feed_closed', retry_ms: backoff });
      if (!stopping) { setTimeout(connect, backoff + Math.random() * 500); backoff = Math.min(60000, backoff * 2); }
    });
  }
  const watchdog = setInterval(() => { if (Date.now() - lastMessage > 90000) { onStatus({ type: 'feed_stale' }); try { socket?.close(); } catch {} } }, 10000);
  watchdog.unref?.();
  connect();
  return { stop() { stopping = true; clearInterval(watchdog); try { socket?.close(); } catch {} }, get lastMessageAt() { return everMessage; }, get connected() { return connected; } };
}
