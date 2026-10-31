// Gambler policy. Jev's answers in, an intent out. Size comes from config, never from confidence.
export function gamblerPolicy(answers, state, cfg) {
  const c = cfg.gambler;
  const a = answers ?? {};
  const why = [];
  const regime = a.regime?.pick ?? 'unknown';
  if (!a.regime || !c.enter_regimes.includes(regime)) why.push(`regime=${regime}`);
  const setup = a.setup?.expected;
  if (setup === null || setup === undefined) why.push('setup=unknown');
  else if (setup < c.min_setup_score) why.push(`setup=${setup.toFixed(2)}<${c.min_setup_score}`);
  const action = a.action?.pick;
  if (!action || !['long', 'short'].includes(action)) why.push(`action=${action ?? 'unknown'}`);
  else if ((a.action.p ?? 0) < c.min_action_prob[action]) why.push(`action_p=${a.action.p.toFixed(2)}<${c.min_action_prob[action]}`);
  const degraded = a.exec_degraded?.p;
  if (degraded === null || degraded === undefined) why.push('exec_quality=unknown');
  else if (degraded > c.max_exec_degraded_prob) why.push(`exec_degraded=${degraded.toFixed(2)}`);
  if (action === 'long' && (a.buy_pressure?.p ?? 0) < c.min_buy_pressure_for_long) why.push('no_buy_pressure');

  if (why.length) return { intent: 'hold', why };
  return {
    intent: 'enter',
    side: action === 'long' ? 'buy' : 'sell',
    notional_usd: c.ticket_usd,
    stop_bps: c.stop_bps,
    take_bps: c.take_bps,
    why: ['all gates passed'],
  };
}
