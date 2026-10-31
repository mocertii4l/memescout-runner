// Spy policy. Hard contract flags have already vetoed in the funnel before Jev was asked.
// Missing is not neutral: an "unknown" wallet gets its own consequence — a smaller ticket, never a full one.
export function spyPolicy(answers, state, cfg) {
  const c = cfg.spy;
  const a = answers ?? {};
  const why = [];
  const kind = a.wallet_kind?.pick ?? 'unknown';
  const rug = a.rug?.p;
  if (rug === null || rug === undefined) why.push('rug=unknown');
  else if (rug > c.max_rug_prob) why.push(`rug=${rug.toFixed(2)}`);
  if (kind !== 'unknown') {
    if (!c.mirror_labels.includes(kind)) why.push(`wallet=${kind}`);
    else if ((a.wallet_kind.p ?? 0) < c.min_skilled_prob) why.push(`skilled_p=${a.wallet_kind.p.toFixed(2)}`);
  }
  if ((a.consistent?.p ?? 0) < c.min_consistent_prob) why.push('inconsistent_move');
  const mirror = a.mirror?.pick;
  if (!mirror || mirror === 'skip' || mirror === 'other') why.push(`mirror=${mirror ?? 'unknown'}`);
  if (why.length) return { intent: 'skip', why };

  let notional = kind === 'unknown' ? c.partial_ticket_usd * c.unknown_ticket_scale : mirror === 'full' ? c.full_ticket_usd : c.partial_ticket_usd;
  return { intent: 'enter', side: state.move_side === 'sell' ? 'sell' : 'buy', notional_usd: notional, why: [`wallet=${kind}`, `mirror=${mirror}`] };
}
