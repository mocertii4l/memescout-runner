const TOTAL_SUPPLY = 1_000_000_000;
const MIGRATION_RESERVE = 206_900_000; // tokens the curve account keeps for migration

/** Holder stats excluding the bonding curve's own token account. */
export function holderStats(holders, curve) {
  if (!holders?.length) return { top10_pct: null, largest_holder_pct: null, holders_seen: 0, curve_account_found: false };
  const expectedCurve = curve?.realTokenReserves != null ? Number(curve.realTokenReserves) / 1e6 + MIGRATION_RESERVE : null;
  let idx = expectedCurve ? holders.findIndex((h) => Math.abs(h.amount - expectedCurve) / expectedCurve < 0.01) : -1;
  const found = idx >= 0;
  if (!found) idx = 0; // fall back: the curve is almost always the largest holder during bonding
  const rest = holders.filter((_, i) => i !== idx).filter((h) => h.amount > 0);
  const pct = (x) => Number(((x / TOTAL_SUPPLY) * 100).toFixed(2));
  return { top10_pct: pct(rest.slice(0, 10).reduce((s, h) => s + h.amount, 0)), largest_holder_pct: pct(rest[0]?.amount ?? 0), holders_seen: rest.length, curve_account_found: found };
}

