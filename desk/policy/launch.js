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
  const ticket = kind === 'unknown' ? S.ticket_usd * P.unknown_ticket_scale : S.ticket_usd;
  return { intent: 'enter', side: 'buy', notional_usd: ticket, expected_edge_bps: mom * S.take_bps - (1 - mom) * S.stop_bps, why: [`kind=${kind}`] };
}
