// Minimal read-only Solana JSON-RPC client. No keypairs, no sendTransaction — by construction.
import { decodeCurve } from './pumpcurve.js';

const READ_ONLY = new Set(['getAccountInfo', 'getMultipleAccounts', 'getTokenLargestAccounts', 'getTokenSupply', 'getHealth', 'getSlot']);

export function createRpc({ url = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', fetchImpl = fetch, timeoutMs = 8000, retries = 2 } = {}) {
  let id = 0;
  async function call(method, params = []) {
    if (!READ_ONLY.has(method)) throw new Error(`RPC method ${method} not allowed: this client is read-only`);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 429) { lastErr = new Error('rpc rate limited'); await sleep(500 * 2 ** attempt); continue; }
        if (!res.ok) throw new Error(`rpc HTTP ${res.status}`);
        const body = await res.json();
        if (body.error) throw new Error(`rpc error ${body.error.code}`);
        return body.result;
      } catch (e) { lastErr = e; if (attempt < retries) await sleep(300 * 2 ** attempt); }
    }
    throw lastErr;
  }

  return {
    call,
    /** Mint authority, freeze authority, supply — parsed by the node. */
    async mintInfo(mint) {
      const r = await call('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const info = r?.value?.data?.parsed?.info;
      if (!info) return null;
      return { mint_authority: info.mintAuthority ?? null, freeze_authority: info.freezeAuthority ?? null, supply: Number(info.supply) / 10 ** info.decimals, decimals: info.decimals };
    },
    async curve(bondingCurve) {
      const r = await call('getAccountInfo', [bondingCurve, { encoding: 'base64', commitment: 'confirmed' }]);
      const b64 = r?.value?.data?.[0];
      return b64 ? decodeCurve(Buffer.from(b64, 'base64')) : null;
    },
    /** Top token accounts as whole-token balances, largest first. */
    async largestHolders(mint) {
      const r = await call('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
      return (r?.value ?? []).map((a) => ({ address: a.address, amount: Number(a.uiAmount ?? 0) }));
    },
  };
}

/** SOL/USD from Jupiter's public price API, with a config fallback. The source is always reported. */
export async function solUsd({ fallback, fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl('https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112', { signal: AbortSignal.timeout(5000) });
    const b = await r.json();
    const p = Number(b?.So11111111111111111111111111111111111111112?.usdPrice);
    if (Number.isFinite(p) && p > 0) return { price: p, source: 'jupiter' };
  } catch {}
  return { price: fallback, source: 'config_fallback' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
