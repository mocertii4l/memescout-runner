// Backtest entry/exit rules on recorded launch price paths (research-*.jsonl).
//   npm run backtest                 (uses logs/data)
//   node tools/backtest.mjs <dir>    (any folder with research-*.jsonl, searched recursively)
// Honest by construction:
//   - fills happen at the NEXT sample after a decision (~5 s later), never at the decision price
//   - stops fill at the sample price where they are seen, so gaps cost what they really cost
//   - costs: constant-product price impact, 1.25% fee each side, 1% slippage each side, 0.0015 SOL per tx
//   - rules are ranked on the first 70% of tokens (by time) and reported on the last 30% they never saw
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../config/main.js';

const K = 30 * 1073e6; // virtual SOL * virtual tokens at launch (constant product, in SOL·tokens)
const FEE = 0.0125, SLIP = 0.01, TX_SOL = 0.0015, TICKET_SOL = 20 / 95;

function files(dir) {
  const out = [];
  for (const f of readdirSync(dir)) { const p = join(dir, f); const st = statSync(p); if (st.isDirectory()) out.push(...files(p)); else if (/^research-.*\.jsonl$/.test(f)) out.push(p); }
  return out;
}
export function loadTokens(dir) {
  const seen = new Set(), toks = [];
  for (const f of files(dir)) for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; }
    if (seen.has(r.m) || !r.s?.length) continue; seen.add(r.m); toks.push(r);
  }
  return toks.sort((a, b) => a.t0 - b.t0);
}
const progress = (rs) => { const vs = 30 + rs; const vt = K / vs; return Math.max(0, Math.min(1, (1073e6 - vt) / 793.1e6)); };
function buyTokens(rs, sol) { const vs = 30 + rs, vt = K / vs; const net = sol * (1 - FEE) * (1 - SLIP); return vt - K / (vs + net); }
function sellSol(rs, tokens) { const vs = 30 + rs, vt = K / vs; const gross = vs - K / (vt + tokens); return gross * (1 - FEE) * (1 - SLIP); }

/** Simulate one strategy on one token. Returns return on ticket (e.g. -0.12) or null if no entry. */
export function simulate(tok, S) {
  const s = tok.s; let i = s.findIndex((x) => x[0] >= S.age);
  if (i < 0) return null;
  const ok = (j) => { const [, , rs] = s[j]; return rs - (tok.cbs ?? 0) >= S.minInflow && progress(rs) * 100 <= S.maxProg; };
  if (!ok(i)) return null;
  if (S.holders && tok.h && (tok.h.top10 > 35 || tok.h.big > 10)) return null;
  if (S.holders && !tok.h) return null;
  if (tok.f && (tok.f.ma || tok.f.fa || tok.f.rx)) return null;
  if (S.confirm) { const p0 = s[i][1]; const j = s.findIndex((x) => x[0] >= s[i][0] + S.confirm); if (j < 0 || s[j][1] < p0 * 0.95 || !ok(j)) return null; i = j; }
  const e = i + 1; if (e >= s.length) return null; // fill at the next sample
  const entryPx = s[e][1]; let tokens = buyTokens(s[e][2], TICKET_SOL); let solBack = 0, txs = 1, peak = 0, partial = false;
  for (let k = e + 1; k < s.length; k++) {
    const [dt, px, rs] = s[k]; const mv = px / entryPx - 1; peak = Math.max(peak, mv);
    const last = k === s.length - 1;
    if (mv <= -S.stop || dt - s[e][0] >= S.hold || last || (peak >= S.trailAct && peak - mv >= S.trail * (1 + peak))) { solBack += sellSol(rs, tokens); txs++; tokens = 0; break; }
    if (!partial && mv >= S.take) { const t = tokens * 0.5; solBack += sellSol(rs, t); tokens -= t; txs++; partial = true; }
  }
  return (solBack - txs * TX_SOL - TICKET_SOL) / TICKET_SOL;
}

export function grid() {
  const out = [];
  for (const age of [45, 60, 90, 120, 180]) for (const minInflow of [1, 2, 4]) for (const maxProg of [55, 70, 100]) for (const confirm of [0, 15]) for (const holders of [false, true])
    for (const stop of [0.15, 0.3]) for (const take of [0.3, 0.6]) for (const [trailAct, trail] of [[0.15, 0.1], [0.3, 0.2]]) for (const hold of [600, 1200])
      out.push({ age, minInflow, maxProg, confirm, holders, stop, take, trailAct, trail, hold });
  return out;
}
export const CURRENT = { age: 60, minInflow: 2, maxProg: 55, confirm: 15, holders: true, stop: 0.15, take: 0.3, trailAct: 0.15, trail: 0.1, hold: 600 };

function stats(rets) {
  const n = rets.length; if (!n) return { n: 0 };
  const avg = rets.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(rets.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, n - 1));
  return { n, avg, se: sd / Math.sqrt(n), win: rets.filter((r) => r > 0).length / n, total20: avg * 20 * n };
}
export function backtest(tokens, { minTrades = 40 } = {}) {
  const cut = Math.floor(tokens.length * 0.7), train = tokens.slice(0, cut), test = tokens.slice(cut);
  const run = (S, set) => stats(set.map((t) => simulate(t, S)).filter((r) => r !== null));
  const ranked = grid().map((S) => ({ S, train: run(S, train) })).filter((x) => x.train.n >= minTrades).sort((a, b) => b.train.avg - a.train.avg);
  const top = ranked.slice(0, 10).map((x) => ({ ...x, test: run(x.S, test) }));
  return { tokens: tokens.length, train: train.length, test: test.length, span_h: tokens.length ? (tokens.at(-1).t0 - tokens[0].t0) / 3.6e6 : 0,
    current: { train: run(CURRENT, train), test: run(CURRENT, test) }, top, strategies_tested: grid().length };
}

if (isMain(import.meta.url)) {
  const dir = process.argv[2] || process.env.DESK_LOG_DIR || fileURLToPath(new URL('../logs/data/', import.meta.url));
  const toks = loadTokens(dir);
  if (toks.length < 100) { console.log(`only ${toks.length} recorded tokens in ${dir}; let the recorder run longer (a few hundred minimum).`); process.exit(0); }
  const r = backtest(toks);
  const pct = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
  const row = (st) => (st.n ? `n=${String(st.n).padStart(4)}  avg ${pct(st.avg).padStart(7)} ±${(st.se * 100).toFixed(1)}  win ${(st.win * 100).toFixed(0).padStart(3)}%  on $20: ${st.total20 >= 0 ? '+' : '-'}$${Math.abs(st.total20).toFixed(0)}` : 'no trades');
  console.log(`\n${r.tokens} tokens over ${r.span_h.toFixed(1)} h · ${r.strategies_tested} rule sets · ranked on the first ${r.train}, checked on the last ${r.test}\n`);
  console.log('CURRENT RULES  train', row(r.current.train)); console.log('               test ', row(r.current.test), '\n');
  r.top.forEach((x, i) => { const S = x.S; console.log(`#${i + 1} age ${S.age}s inflow≥${S.minInflow} prog≤${S.maxProg}% confirm ${S.confirm}s holders ${S.holders ? 'on' : 'off'} stop ${S.stop * 100}% take ${S.take * 100}% trail ${S.trailAct * 100}/${S.trail * 100} hold ${S.hold / 60}m`); console.log('     train', row(x.train)); console.log('     test ', row(x.test)); });
  console.log('\nA rule set is only interesting if TEST avg is clearly above 0 (more than about 2× its ± error) on a decent n.');
  writeFileSync(join(dir, 'backtest-latest.json'), JSON.stringify(r, null, 1));
}
