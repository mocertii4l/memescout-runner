// pump.fun bonding curve: account decoding and constant-product math. Pure functions, no network.
// Account layout (after the 8-byte Anchor discriminator), all u64 little-endian:
//   virtualTokenReserves, virtualSolReserves, realTokenReserves, realSolReserves, tokenTotalSupply, then bool complete.
// Tokens have 6 decimals, SOL 9 (lamports). Re-check this layout against the pump.fun program before trusting it.

export const TOKEN_DECIMALS = 6;
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000n * 10n ** 6n;
export const VIRTUAL_SOL_OFFSET_LAMPORTS = 30n * 10n ** 9n;

export function decodeCurve(buf) {
  if (!buf || buf.length < 8 + 8 * 5 + 1) throw new Error('bonding curve account too short');
  const u = (i) => buf.readBigUInt64LE(8 + i * 8);
  return {
    virtualTokenReserves: u(0),
    virtualSolReserves: u(1),
    realTokenReserves: u(2),
    realSolReserves: u(3),
    tokenTotalSupply: u(4),
    complete: buf[8 + 40] === 1,
  };
}

/** Spot price in SOL per whole token. */
export function spotPriceSol(c) {
  const vs = Number(c.virtualSolReserves) / 1e9;
  const vt = Number(c.virtualTokenReserves) / 10 ** TOKEN_DECIMALS;
  return vt > 0 ? vs / vt : null;
}

/** Fraction of the curve sold, 0..1. Graduation at 1. */
export function curveProgress(c) {
  if (c.complete) return 1;
  const left = Number(c.realTokenReserves) / Number(INITIAL_REAL_TOKEN_RESERVES);
  return Math.min(1, Math.max(0, 1 - left));
}

/** Tokens out (whole tokens) for `solIn` SOL, after a fee in bps taken from the input. */
export function quoteBuy(c, solIn, feeBps) {
  const vs = Number(c.virtualSolReserves) / 1e9, vt = Number(c.virtualTokenReserves) / 10 ** TOKEN_DECIMALS;
  const net = solIn * (1 - feeBps / 1e4);
  const out = vt - (vt * vs) / (vs + net);
  return { tokensOut: out, avgPriceSol: out > 0 ? solIn / out : null, feeSol: solIn - net };
}

/** SOL out for `tokensIn` whole tokens, after a fee in bps taken from the output. */
export function quoteSell(c, tokensIn, feeBps) {
  const vs = Number(c.virtualSolReserves) / 1e9, vt = Number(c.virtualTokenReserves) / 10 ** TOKEN_DECIMALS;
  const gross = vs - (vt * vs) / (vt + tokensIn);
  const fee = gross * (feeBps / 1e4);
  return { solOut: gross - fee, feeSol: fee, avgPriceSol: tokensIn > 0 ? (gross - fee) / tokensIn : null };
}

/** Build a curve-like object from a PumpPortal event's virtual reserves (SOL and whole tokens). */
export function curveFromEvent(vSolInBondingCurve, vTokensInBondingCurve) {
  return {
    virtualSolReserves: BigInt(Math.round(vSolInBondingCurve * 1e9)),
    virtualTokenReserves: BigInt(Math.round(vTokensInBondingCurve * 10 ** TOKEN_DECIMALS)),
    realTokenReserves: null, realSolReserves: BigInt(Math.max(0, Math.round((vSolInBondingCurve - 30) * 1e9))), tokenTotalSupply: null, complete: false,
  };
}
