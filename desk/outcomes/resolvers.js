// Ground truth for calibration. Each resolver turns "what happened next" into the label a question
// should have had. Defined in code, before you look at results, so you can't tune the truth to the model.
// Choice answers become one-vs-rest rows (one per option); Noul answers one row; Scores are logged, not Brier'd.

const H = 20; // bars ahead

export function rowsFor(questionId, answer, label) {
  if (!answer || label === undefined || label === null) return [];
  if (answer.type === 'noul') return [{ question: questionId, p: answer.p, y: label ? 1 : 0 }];
  if (answer.type === 'choice') return Object.entries(answer.probs).map(([opt, p]) => ({ question: `${questionId}=${opt}`, p, y: label === opt ? 1 : 0 }));
  return [];
}

export const horizonBars = H;

/** labels for the Gambler given state at t and the feed snapshot at t+H */
export function gamblerLabels(stateT, snapT, snapTH, costBps) {
  const p0 = stateT.mid, p1 = snapTH.bars.at(-1).close;
  if (!p0 || !p1) return {};
  const ret = Math.log(p1 / p0) * 1e4;
  const band = 1.5 * (stateT.rvol_bps ?? 10) * Math.sqrt(H);
  const past = stateT.ret_bps?.b20 ?? 0;
  const spreadLater = spreadBpsOf(snapTH.book);
  return {
    regime: Math.abs(ret) > band ? 'trending' : Math.sign(ret) === -Math.sign(past) ? 'mean_reverting' : 'chaotic',
    buy_pressure: ret > 0,
    action: ret > costBps ? 'long' : ret < -costBps ? 'short' : 'hold',
    exec_degraded: spreadLater !== null && stateT.spread_bps !== null ? spreadLater > 1.5 * stateT.spread_bps : null,
  };
}

export function houseLabels(stateT, snapT, snapTH) {
  const future = snapTH.bars.slice(-H);
  const exited = future.some((b) => b.close < stateT.range_low || b.close > stateT.range_high);
  const p0 = stateT.mid, p1 = snapTH.bars.at(-1).close;
  const ret = Math.abs(Math.log(p1 / p0) * 1e4);
  const vol = future.reduce((s, b) => s + b.volume, 0) / Math.max(1, future.length);
  const volBefore = snapT.bars.slice(-60).reduce((s, b) => s + b.volume, 0) / 60;
  return {
    range_state: exited ? 'breaking_out' : (stateT.to_edge_bps ?? 999) < 10 ? 'testing_edge' : 'inside',
    toxic_flow: ret > 2 * (stateT.rvol_bps ?? 10) * Math.sqrt(H),
    volume_alive: vol >= 0.3 * volBefore,
  };
}

export function spyLabels(truth) {
  return { rug: truth.rug, wallet_kind: truth.wallet_skilled ? 'skilled' : null };
}

function spreadBpsOf(book) {
  const b = book?.bids?.[0]?.[0], a = book?.asks?.[0]?.[0];
  return b && a ? ((a - b) / ((a + b) / 2)) * 1e4 : null;
}
