// The risk engine never delegates. Deterministic vetoes checked before every order. No model gets a vote.
// "Confidence is not permission": nothing here reads a probability.

export function createRiskEngine(cfg, { now = () => Date.now(), onVeto = () => {} } = {}) {
  const R = cfg.risk;
  let dayKey = null, realizedToday = 0, halted = null;

  function rollDay() {
    const k = new Date(now()).toISOString().slice(0, 10);
    if (k !== dayKey) { dayKey = k; realizedToday = 0; if (halted === 'daily_loss') halted = null; }
  }

  /**
   * @param order  { market, side, notional_usd, leverage, price, expected_edge_bps }
   * @param ctx    { positions: {market: notional_usd}, model_version, range?: {low, high}, mid }
   */
  function check(order, ctx) {
    rollDay();
    const vetoes = [];
    if (halted) vetoes.push(`desk_halted:${halted}`);
    if (ctx.model_version !== cfg.model_version_pin) vetoes.push(`model_version:${ctx.model_version ?? 'missing'}!=${cfg.model_version_pin}`);
    const lev = order.leverage ?? 1;
    if (lev > R.max_leverage) vetoes.push(`leverage:${lev}>${R.max_leverage}`);
    const current = Math.abs(ctx.positions?.[order.market] ?? 0);
    const total = Object.values(ctx.positions ?? {}).reduce((s, v) => s + Math.abs(v), 0);
    if (current + order.notional_usd > R.max_position_usd_per_market) vetoes.push(`max_position_market:${current + order.notional_usd}>${R.max_position_usd_per_market}`);
    if (total + order.notional_usd > R.max_position_usd_total) vetoes.push(`max_position_total:${total + order.notional_usd}>${R.max_position_usd_total}`);
    if (ctx.range && Number.isFinite(ctx.mid) && (ctx.mid < ctx.range.low || ctx.mid > ctx.range.high)) vetoes.push('range_guard:price_outside_band');
    const cost = costBps(order.notional_usd, R);
    if ((order.expected_edge_bps ?? -Infinity) < cost + R.min_edge_over_costs_bps) vetoes.push(`economics:edge ${fmt(order.expected_edge_bps)}bps < costs ${cost.toFixed(1)}+${R.min_edge_over_costs_bps}bps`);
    if (vetoes.length) onVeto({ order, vetoes });
    return { allowed: vetoes.length === 0, vetoes, cost_bps: cost };
  }

  function recordPnl(pnlUsd) {
    rollDay();
    realizedToday += pnlUsd;
    if (realizedToday <= -R.daily_loss_limit_usd && !halted) { halted = 'daily_loss'; onVeto({ halt: 'daily_loss', realizedToday }); }
  }

  return {
    check, recordPnl,
    halt(reason) { halted = reason; },
    resume() { halted = null; }, // only a human calls this
    get halted() { return halted; },
    get realizedToday() { rollDay(); return realizedToday; },
  };
}

/** Round-trip cost in bps: fees both sides (with minimum fee) + gas both sides. Small tickets get hit hardest. */
export function costBps(notionalUsd, R) {
  if (!(notionalUsd > 0)) return Infinity;
  const feeOneSide = Math.max(R.min_fee_usd, (notionalUsd * R.fee_bps) / 1e4);
  return ((2 * feeOneSide + 2 * R.gas_usd_per_order) / notionalUsd) * 1e4;
}

/** Exit on a number: volume pace collapse closes the position. Unmeasurable after retries → close anyway. */
export function exitRule({ volume6hUsd, dailyVolumeUsd, dataOk, retries }, R) {
  if (!dataOk) return retries >= R.exit_data_retries ? { exit: true, reason: 'no_data_after_retries' } : { exit: false, retry: true };
  const pace = dailyVolumeUsd > 0 ? volume6hUsd / (dailyVolumeUsd / 4) : 0;
  return pace < R.exit_volume_pace_ratio ? { exit: true, reason: `volume_pace=${pace.toFixed(2)}` } : { exit: false };
}

/** Rough gas-burn check for cancel-replace quoting. Run it before any live order. */
export function cancelReplaceBurn({ blocksPerHour, gasUsdPerCancelReplace, expectedFillsPerHour, spreadCaptureUsdPerFill }) {
  const burn = blocksPerHour * gasUsdPerCancelReplace;
  const earn = expectedFillsPerHour * spreadCaptureUsdPerFill;
  return { burnUsdPerHour: burn, earnUsdPerHour: earn, viable: earn > burn };
}

const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
