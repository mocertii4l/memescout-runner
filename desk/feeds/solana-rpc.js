// Minimal read-only Solana JSON-RPC client. No keypairs, no sendTransaction — by construction.
import { decodeCurve } from './pumpcurve.js';

const READ_ONLY = new Set(['getAccountInfo', 'getMultipleAccounts', 'getTokenLargestAccounts', 'getTokenSupply', 'getHealth', 'getSlot', 'getSignaturesForAddress', 'getTransaction']);

// Token-2022 extensions that let someone else take, freeze, tax or block your tokens.
export const RISKY_TOKEN_EXTENSIONS = ['transferFeeConfig', 'transferHook', 'permanentDelegate', 'nonTransferable', 'defaultAccountState', 'pausableConfig', 'confidentialTransferMint', 'mintCloseAuthority'];

export function createRpc({ url = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', fetchImpl = fetch, timeoutMs = 8000, retries = 2, rps = Number(process.env.SOLANA_RPC_RPS) || (process.env.SOLANA_RPC_URL ? 8 : 4) /* Helius free plan allows ~10/s; raise SOLANA_RPC_RPS on a paid plan */ } = {}) {
  let id = 0;
  // Pace requests so a burst of candidates doesn't trip the provider's rate limit (the public RPC allows very little).
  let nextSlot = 0;
  const gap = 1000 / Math.max(0.5, rps);
  // Heavy methods get their own, slower lane: the public RPC throttles getTokenLargestAccounts hardest (seen live).
  const HEAVY = new Set(['getTokenLargestAccounts', 'getTransaction']);
  const heavyGap = Number(process.env.SOLANA_RPC_HEAVY_GAP_MS) || (process.env.SOLANA_RPC_URL ? 200 : 2500);
  let nextHeavy = 0;
  async function pace(method) {
    const now = Date.now();
    let at = Math.max(now, nextSlot);
    if (HEAVY.has(method)) { at = Math.max(at, nextHeavy); nextHeavy = at + heavyGap; }
    nextSlot = Math.max(nextSlot, at) + gap;
    if (at > now) await sleep(at - now);
  }
  async function call(method, params = []) {
    if (!READ_ONLY.has(method)) throw new Error(`RPC method ${method} not allowed: this client is read-only`);
    await pace(method);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 429) { lastErr = Object.assign(new Error('rpc rate limited'), { rateLimited: true }); await sleep(1000 * 2 ** attempt); continue; }
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
      return { mint_authority: info.mintAuthority ?? null, freeze_authority: info.freezeAuthority ?? null, supply: Number(info.supply) / 10 ** info.decimals, decimals: info.decimals,
        program: r.value.owner, extensions: (info.extensions ?? []).map((e) => e.extension) };
    },
    /** Many curves in one call (up to 100 per request). Returns Map(key -> decoded curve | null). */
    async curves(keys) {
      const out = new Map();
      for (let i = 0; i < keys.length; i += 100) {
        const chunk = keys.slice(i, i + 100);
        const r = await call('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }]);
        (r?.value ?? []).forEach((acc, j) => {
          let c = null;
          try { if (acc?.data?.[0]) c = decodeCurve(Buffer.from(acc.data[0], 'base64')); } catch {}
          out.set(chunk[j], c);
        });
      }
      return out;
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
