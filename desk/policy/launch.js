// Launch-scanner policy. Size from config; the probability only gates and feeds the economics check.
export function launchPolicy(answers, state, S) {
  const P = S.policy;
  const a = answers ?? {};
  const why = [];
  const rug = a.rug?.p, q = a.quality?.expected, mom = a.momentum?.p;
  const kind = a.launch_kind?.pick ?? 'unknown';
  if (rug == null) why.push('rug=unknown'); else if (rug > P.max_rug_prob) why.push(`rug=${rug.toFixed(2)}`);
  if (q == null) why.push('quality=unknown'); else if (q < P.min_quality) why.push(`quality=${q.toFixed(2)}`);
  if (mom == null) why.push('momentum=unknown'); else if (mom < P.min_momentum_prob) why.push(`momentum=${mom.toFixed(2)}`);
  if (kind !== 'unknown' && !P.ok_kinds.includes(kind)) why.push(`kind=${kind}`);
  if (why.length) return { intent: 'skip', why };
  // Missing is not neutral: an unknown wallet mix or unknown holder distribution gets a smaller ticket, never a full one.
  const unknowns = (kind === 'unknown' ? 1 : 0) + (state.top10_pct == null ? 1 : 0);
  const ticket = S.ticket_usd * Math.pow(P.unknown_ticket_scale, unknowns);
  return { intent: 'enter', side: 'buy', notional_usd: ticket, expected_edge_bps: mom * S.take_bps - (1 - mom) * S.stop_bps, why: [`kind=${kind}`, ...(state.top10_pct == null ? ['holders=unknown (half ticket)'] : [])] };
}
