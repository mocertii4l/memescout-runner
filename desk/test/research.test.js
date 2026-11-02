import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../research/recorder.js';
import { simulate, backtest, CURRENT } from '../tools/backtest.mjs';

const curveAt = (realSol, complete = false) => {
  const vs = 30 + realSol, vt = (30 * 1073e6) / vs;
  return { virtualSolReserves: BigInt(Math.round(vs * 1e9)), virtualTokenReserves: BigInt(Math.round(vt * 1e6)), realSolReserves: BigInt(Math.round(realSol * 1e9)), realTokenReserves: BigInt(Math.round((793.1e6 - (1073e6 - vt)) * 1e6)), tokenTotalSupply: 10n ** 15n, complete };
};

test('recorder: free cuts, sampling, holder snapshot, finish reasons', async () => {
  let t = 0; const lines = [];
  let rs = { A: 0, B: 0, C: 0 };
  const rpc = {
    async curves(keys) { return new Map(keys.map((k) => [k, k === 'cX' ? { ...curveAt(1), realSolReserves: 0n } : curveAt(rs[k.slice(1)] ?? 0, k === 'cB' && rs.B > 80)])); },
    async mintInfo() { return { mint_authority: null, freeze_authority: null, extensions: ['metadataPointer'] }; },
    async largestHolders() { return [{ amount: 900_000_000 }, { amount: 20_000_000 }]; },
  };
  const rec = createRecorder({ rpc, log: { research: (r) => lines.push(r) }, now: () => t });
  rec.onLaunch({ mint: 'A', bonding_curve: 'cA', received_at: 0, pool: 'pump', creator: 'c1' });
  rec.onLaunch({ mint: 'B', bonding_curve: 'cB', received_at: 0, pool: 'pump', creator: 'c2' });
  rec.onLaunch({ mint: 'C', bonding_curve: 'cC', received_at: 0, pool: 'pump', creator: 'c3' });
  rec.onLaunch({ mint: 'X', bonding_curve: 'cX', received_at: 0, pool: 'pump' });
  rec.onLaunch({ mint: 'M', bonding_curve: 'cM', received_at: 0, pool: 'pump', mayhem: true });
  rec.onLaunch({ mint: 'Z', bonding_curve: 'cZ', received_at: 0, pool: 'bonk' });
  assert.equal(rec.tracking, 4, 'mayhem and non-pump launches are not recorded');
  for (t = 5000; t <= 60000; t += 5000) { rs.A = 0.1; rs.C = 3; rs.B = t / 1000 / 5; await rec.tick(); await new Promise((r) => setImmediate(r)); }
  assert.equal(rec.stats.ends.non_sol, 1, 'other-quote curves dropped');
  rs.B = 90; t += 5000; await rec.tick(); // graduates
  rs.C = 0.1; // C pumped to 3 SOL, then was dumped
  for (t += 5000; t <= 200_000; t += 5000) await rec.tick();
  const a = lines.find((l) => l.m === 'A'), b = lines.find((l) => l.m === 'B'), c = lines.find((l) => l.m === 'C');
  assert.equal(b.end, 'graduated'); assert.equal(c.end, 'dead', 'pump-then-dump tokens are kept: they are the losses a strategy must avoid');
  assert.equal(a, undefined, 'tokens that never had buying are not written');
  assert.equal(rec.stats.ends.never_started, 1);
  assert.ok(b.s.length >= 12 && b.s[0][0] === 5);
  assert.ok(b.h && b.h.big === 2, 'holder snapshot taken once B had real buying');
  assert.ok(c.h, 'holder snapshot for the token that had buying');
});

// A sample from real SOL in the curve: price follows from the constant product, as on chain.
const at = (dt, rs) => { const vs = 30 + rs; return [dt, (vs * vs) / (30 * 1073e6), rs]; };
const tok = (path, extra = {}) => ({ m: 'T', t0: 0, cbs: 0, cb: 0, cs: 1, f: { ma: false, fa: false, rx: false }, h: { top10: 20, big: 5 }, s: path, ...extra });

test('backtest: fills a sample late, stops at the gap price, charges costs', () => {
  const S = { ...CURRENT, confirm: 0 };
  // flat: still loses the round-trip costs (~5-6%)
  const flat = tok(Array.from({ length: 200 }, (_, i) => at(i * 5, 10)));
  const r0 = simulate(flat, S);
  assert.ok(r0 < -0.03 && r0 > -0.09, `flat round trip costs ${r0}`);
  // crash through the stop between samples: loss is the gap, not -15%
  const crash = tok([at(55, 10), at(60, 10), at(65, 10), at(70, 2), at(75, 2)]); // 10 → 2 SOL ≈ -36% price
  assert.ok(simulate(crash, S) < -0.35, 'the stop fills at the gap price, not at -15%');
  // filters: too little inflow → no trade; bad holders → no trade
  assert.equal(simulate(tok([at(60, 0.5), at(65, 0.5)]), S), null);
  assert.equal(simulate({ ...flat, h: { top10: 60, big: 5 } }, S), null);
});

test('backtest ranks on train and reports on unseen test tokens', () => {
  const tokens = Array.from({ length: 300 }, (_, i) => tok(Array.from({ length: 100 }, (_, j) => at(j * 5, j > 14 ? (i % 3 === 0 ? 20 : 4) : 10)), { m: 'T' + i, t0: i }));
  const r = backtest(tokens, { minTrades: 10 });
  assert.equal(r.train + r.test, 300);
  assert.ok(r.top.length > 0 && r.top[0].test.n > 0);
});
