// Self-test for the machine the desk runs on. Read-only: touches nothing, buys nothing.
//   npm run check     (Windows: npm.cmd run check)
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRpc, solUsd } from '../feeds/solana-rpc.js';
import { decodeCurve, spotPriceSol, isSolQuotedCurve } from '../feeds/pumpcurve.js';
import { parseCreateEvent } from '../feeds/pumpportal.js';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const results = [];
const ok = (name, detail) => { results.push(['PASS', name, detail]); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); };
const bad = (name, detail, fix) => { results.push(['FAIL', name, detail]); console.log(`  ✗ ${name} — ${detail}${fix ? `\n      fix: ${fix}` : ''}`); };
const warn = (name, detail) => { results.push(['WARN', name, detail]); console.log(`  ! ${name} — ${detail}`); };

console.log('\nMemeScout desk self-test (read-only)\n');

const major = Number(process.versions.node.split('.')[0]);
major >= 22 ? ok('Node.js', `v${process.versions.node}`) : bad('Node.js', `v${process.versions.node} is too old`, 'install Node 22 LTS or newer from nodejs.org');

try {
  const dir = process.env.DESK_LOG_DIR || fileURLToPath(new URL('../logs/data/', import.meta.url));
  mkdirSync(dir, { recursive: true }); const f = join(dir, '.write-test'); writeFileSync(f, 'x'); rmSync(f);
  ok('Log folder writable', dir);
} catch (e) { bad('Log folder writable', e.message, 'run from a folder you own, e.g. Documents'); }

const p = await solUsd({ fallback: null });
p.source === 'jupiter' ? ok('SOL price (Jupiter)', `$${p.price.toFixed(2)}`) : bad('SOL price (Jupiter)', 'unreachable', 'check internet / firewall for lite-api.jup.ag');

const rpc = createRpc();
const custom = Boolean(process.env.SOLANA_RPC_URL);
try {
  const sigs = await rpc.call('getSignaturesForAddress', [PUMP, { limit: 20 }]);
  ok('Solana RPC', `${custom ? 'custom URL' : 'public mainnet'} · ${sigs.length} recent pump.fun txs`);
  let checked = false;
  for (const s of sigs) {
    const tx = await rpc.call('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]).catch(() => null);
    const pb = tx?.meta?.postTokenBalances ?? [];
    const mint = [...new Set(pb.map((b) => b.mint))].find((m) => m.endsWith('pump'));
    if (!mint) continue;
    const owner = pb.filter((b) => b.mint === mint).sort((a, b) => (b.uiTokenAmount.uiAmount ?? 0) - (a.uiTokenAmount.uiAmount ?? 0))[0].owner;
    const curve = await rpc.curve(owner).catch(() => null);
    if (!curve) continue;
    const info = await rpc.mintInfo(mint);
    ok('Bonding curve decode', `${mint.slice(0, 8)}… price ${spotPriceSol(curve)?.toExponential(3)} SOL · ${isSolQuotedCurve(curve) ? 'SOL-priced' : 'other-quote (desk skips these)'} · supply ${Number(curve.tokenTotalSupply) / 1e6}`);
    ok('Mint read', `authorities ${info.mint_authority ?? 'none'}/${info.freeze_authority ?? 'none'} · extensions ${info.extensions?.join(', ') || 'none'}`);
    try { const h = await rpc.largestHolders(mint); ok('Holder lookup', `${h.length} accounts`); }
    catch (e) { (custom ? bad : warn)('Holder lookup', e.message, custom ? 'check your SOLANA_RPC_URL plan' : undefined); if (!custom) console.log('      the public RPC throttles this call; a free Helius URL in SOLANA_RPC_URL fixes it'); }
    checked = true; break;
  }
  if (!checked) warn('Bonding curve decode', 'no recent pump.fun token found in the sample; run the check again');
} catch (e) { bad('Solana RPC', e.message, custom ? 'check SOLANA_RPC_URL' : 'check internet / firewall for api.mainnet-beta.solana.com'); }

await new Promise((resolve) => {
  if (!globalThis.WebSocket) { bad('Launch feed', 'WebSocket not available', 'update Node.js to 22+'); return resolve(); }
  const ws = new WebSocket('wss://pumpportal.fun/api/data');
  let got = 0;
  const done = (fn) => { clearTimeout(timer); try { ws.close(); } catch {} fn(); resolve(); };
  const timer = setTimeout(() => done(() => (got ? ok('Launch feed', `${got} launches in 30 s`) : bad('Launch feed', 'connected but no launches in 30 s', 'try again; if it repeats, PumpPortal may be down'))), 30_000);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ method: 'subscribeNewToken' })));
  ws.addEventListener('message', (e) => { try { if (parseCreateEvent(JSON.parse(e.data))) got++; } catch {} if (got >= 3) done(() => ok('Launch feed (PumpPortal)', `${got} live launches received`)); });
  ws.addEventListener('error', () => done(() => bad('Launch feed (PumpPortal)', 'could not connect', 'check internet / firewall / VPN for pumpportal.fun')));
});

const fails = results.filter((r) => r[0] === 'FAIL').length, warns = results.filter((r) => r[0] === 'WARN').length;
console.log(`\n${fails ? `${fails} problem(s) to fix above.` : warns ? 'Ready, with warnings above.' : 'All good — the desk can paper-trade live launches on this machine.'}\n`);
process.exit(fails ? 1 : 0);
