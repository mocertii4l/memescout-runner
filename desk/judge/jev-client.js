// The ONLY file that knows Jev's wire format. Runs inside the judge service, nowhere else.
//
// ⚠ Wire format not verified against TypeSafe's official docs (unreachable from the build sandbox).
// Third-party guides describe: native POST /v1/decisions (also /v1/systemone compat), typed questions
// noul/choice/score, model ids like "jev-1.13.0", and official SDKs `typesafe-sdk` (py) / `@typesafe-ai/sdk` (js).
// Before going past shadow mode: check the request/response shape below against the official docs or swap in the SDK.
import { JudgeError, classifyStatus } from './errors.js';

export function toWire(state, questions, model) {
  return {
    model,
    state,
    questions: questions.map((q) => ({
      name: q.id,
      type: q.type,
      question: q.text,
      ...(q.type === 'choice' ? { options: q.options } : {}),
      ...(q.type === 'score' ? { rubric: q.rubric } : {}),
    })),
  };
}

/** Normalize a Jev response into { model_version, answers: { [id]: typed answer } }. */
export function fromWire(body, questions) {
  const version = body.model_version ?? body.model ?? null;
  const list = Array.isArray(body.answers) ? body.answers : Object.entries(body.answers ?? {}).map(([name, a]) => ({ name, ...a }));
  const byName = Object.fromEntries(list.map((a) => [a.name ?? a.id, a]));
  const answers = {};
  for (const q of questions) {
    const a = byName[q.id];
    if (!a) { answers[q.id] = null; continue; } // missing stays missing
    if (q.type === 'noul') answers[q.id] = { type: 'noul', p: num(a.probability ?? a.p ?? a.value) };
    else if (q.type === 'choice') {
      const probs = normalizeProbs(a.probabilities ?? a.probs, q.options);
      const pick = Object.entries(probs).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
      answers[q.id] = { type: 'choice', probs, pick, p: pick ? probs[pick] : null };
    } else {
      const probs = Array.isArray(a.probabilities) ? a.probabilities.map(num) : null;
      const expected = num(a.expected ?? a.score ?? (probs ? probs.reduce((s, p, i) => s + p * i, 0) : null));
      answers[q.id] = { type: 'score', probs, expected, max: q.rubric.length - 1 };
    }
  }
  return { model_version: version, answers };
}

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
function normalizeProbs(raw, options) {
  const out = {};
  if (Array.isArray(raw)) options.forEach((o, i) => (out[o] = num(raw[i]) ?? 0));
  else for (const o of options) out[o] = num(raw?.[o]) ?? 0;
  return out;
}

export function createJevClient({ apiKey, baseUrl = 'https://api.typesafe.ai/v1', path = '/decisions', fetchImpl = fetch }) {
  if (!apiKey) throw new Error('JEV_API_KEY missing');
  return async function ask({ state, questions, model, timeoutMs }) {
    let res;
    try {
      res = await fetchImpl(baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(toWire(state, questions, model)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new JudgeError(e?.name === 'TimeoutError' ? 'timeout' : 'unavailable', 'jev request failed');
    }
    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      throw new JudgeError(classifyStatus(res.status), `jev HTTP ${res.status}`, { status: res.status, retryAfterMs: ra > 0 ? ra * 1000 : undefined });
    }
    return fromWire(await res.json(), questions);
  };
}

// ---------------------------------------------------------------------------------------------
// Mock backend for shadow/paper development. Deterministic, crude heuristics — NOT a model.
// Lets the full loop, the logs and the calibration report run end to end without a key.
export function createMockJev({ version = 'jev-1.13.0', latencyMs = 80 } = {}) {
  return async function ask({ state, questions }) {
    await new Promise((r) => setTimeout(r, latencyMs));
    const answers = {};
    for (const q of questions) answers[q.id] = mockAnswer(q, state);
    return { model_version: version, answers };
  };
}

const clamp = (x, lo = 0.02, hi = 0.98) => Math.min(hi, Math.max(lo, x));
const sig = (x) => 1 / (1 + Math.exp(-x));

function mockAnswer(q, s) {
  const trend = (s.ret_bps?.b20 ?? 0) / Math.max(1, s.rvol_bps ?? 50);
  if (q.type === 'noul') {
    const p = {
      buy_pressure: sig(3 * (s.imbalance ?? 0) + 0.5 * trend),
      exec_degraded: sig(((s.spread_bps ?? 10) - 20) / 5),
      toxic_flow: sig(Math.abs(s.imbalance ?? 0) * 4 - 2.5),
      volume_alive: sig(((s.volume_pace_ratio ?? 1) - 0.3) * 6),
      consistent: sig(2 - Math.abs((s.move_vs_median_size ?? 1) - 1) * 2),
      rug: sig((s.token_top10_pct ?? 50) / 10 - 6 + (s.token_flags?.length ?? 0)),
    }[q.id] ?? 0.5;
    return { type: 'noul', p: clamp(p) };
  }
  if (q.type === 'score') {
    const n = q.rubric.length;
    const center = q.id === 'setup' ? Math.min(n - 1, Math.abs(trend) * 2) : q.id === 'environment' ? (n - 1) * sig(1 - Math.abs(trend)) : (n - 1) / 2;
    const w = q.rubric.map((_, i) => Math.exp(-((i - center) ** 2)));
    const z = w.reduce((a, b) => a + b, 0);
    const probs = w.map((x) => x / z);
    return { type: 'score', probs, expected: probs.reduce((acc, p, i) => acc + p * i, 0), max: n - 1 };
  }
  const logits = Object.fromEntries(q.options.map((o) => [o, 0]));
  if (q.id === 'regime') { logits.trending = Math.abs(trend) * 2; logits.mean_reverting = 1 - Math.abs(trend); logits.chaotic = (s.rvol_bps ?? 0) / 100 - 1; logits.other = -2; }
  else if (q.id === 'action') { logits.long = trend * 1.5; logits.short = -trend * 1.5; logits.hold = 0.8; logits.other = -3; }
  else if (q.id === 'range_state') { const e = s.to_edge_bps ?? 100; logits.inside = e / 50; logits.testing_edge = 1 - Math.abs(e - 10) / 20; logits.breaking_out = -e / 20 + Math.abs(trend); logits.other = -3; }
  else if (q.id === 'wallet_kind') { const wr = s.wallet_win_rate ?? 0.5, n = s.wallet_trades ?? 0; logits.skilled = (wr - 0.5) * 8 * Math.min(1, n / 50); logits.lucky = n < 20 ? 1 : -1; logits.bot_like = (s.wallet_median_hold_s ?? 600) < 10 ? 2 : -1; logits.insider_like = (s.wallet_early_count ?? 0) > 10 ? 1.5 : -1; logits.unknown = n === 0 ? 3 : -2; logits.other = -3; }
  else if (q.id === 'mirror') { const wr = s.wallet_win_rate ?? 0.5; logits.full = (wr - 0.6) * 10; logits.partial = 0.5; logits.skip = 1 - (wr - 0.5) * 5; logits.other = -3; }
  const z = Object.values(logits).reduce((a, l) => a + Math.exp(l), 0);
  const probs = Object.fromEntries(Object.entries(logits).map(([k, l]) => [k, Math.exp(l) / z]));
  const pick = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
  return { type: 'choice', probs, pick, p: probs[pick] };
}
