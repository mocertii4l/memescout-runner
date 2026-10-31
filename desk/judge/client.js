// What a bot uses to reach the judge. Bots hold the desk secret only — never the Jev key.
import { JudgeError, classifyStatus } from './errors.js';

export function createJudgeClient({ url = process.env.JUDGE_URL || 'http://127.0.0.1:8787', deskSecret = process.env.DESK_SECRET, fetchImpl = fetch } = {}) {
  return async function judge(battery, state, { deadlineMs }) {
    let res;
    try {
      res = await fetchImpl(url + '/v1/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-desk-secret': deskSecret },
        body: JSON.stringify({ battery, state, timeout_ms: deadlineMs }),
        signal: AbortSignal.timeout(deadlineMs),
      });
    } catch (e) {
      throw new JudgeError(e?.name === 'TimeoutError' ? 'timeout' : 'unavailable', 'judge unreachable');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      throw new JudgeError(body.error ?? classifyStatus(res.status), `judge HTTP ${res.status}`, { status: res.status, retryAfterMs: ra > 0 ? ra * 1000 : undefined });
    }
    return body;
  };
}

/** In-process judge for tests and single-process paper runs. Same contract as the HTTP judge. */
export function createLocalJudge({ ask, model, batteries }) {
  return async function judge(battery, state, { deadlineMs }) {
    const b = batteries[battery];
    if (!b) throw new JudgeError('malformed', 'unknown battery');
    const started = Date.now();
    const out = await ask({ state, questions: b.questions, model, timeoutMs: deadlineMs });
    return { battery, model_requested: model, model_version: out.model_version, latency_ms: Date.now() - started, answers: out.answers };
  };
}
