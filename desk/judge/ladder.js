// Deadline rule + fallback ladder. Without this the bot is AI-powered until the first 2am outage.
//   decision late          → hold (never act on stale state)
//   API slow (timeout)     → hold
//   API down               → pull quotes / flatten to safe state
//   repeated errors        → halt and message the human
//   rate limited/overloaded→ back off and retry later (hold meanwhile)
//   malformed question     → never retry; halt this battery, the question is wrong
//   auth failure           → halt
import { JudgeError } from './errors.js';

export function createDecider({ judge, deadlineMs, haltAfter = 5, now = () => Date.now(), onEvent = () => {} }) {
  let consecutiveErrors = 0;
  let backoffUntil = 0;
  let backoffMs = 0;
  const brokenBatteries = new Set();
  let halted = null;

  async function decide(battery, state) {
    if (halted) return { ok: false, fallback: 'halt', kind: halted };
    if (brokenBatteries.has(battery)) return { ok: false, fallback: 'halt', kind: 'malformed' };
    if (now() < backoffUntil) return { ok: false, fallback: 'hold', kind: 'backoff' };

    const started = now();
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('__late__'), deadlineMs); });
    try {
      const res = await Promise.race([judge(battery, state, { deadlineMs }), deadline]);
      if (res === '__late__') { onEvent({ type: 'deadline_missed', battery, ms: now() - started }); return { ok: false, fallback: 'hold', kind: 'deadline' }; }
      consecutiveErrors = 0; backoffMs = 0;
      return { ok: true, response: res, latency_ms: now() - started };
    } catch (e) {
      const kind = e instanceof JudgeError ? e.kind : 'unavailable';
      consecutiveErrors++;
      onEvent({ type: 'judge_error', battery, kind, consecutiveErrors });
      if (kind === 'malformed') { brokenBatteries.add(battery); onEvent({ type: 'alert', msg: `battery ${battery} is malformed; fix the question, not the retry` }); return { ok: false, fallback: 'halt', kind }; }
      if (kind === 'auth') { halted = 'auth'; onEvent({ type: 'alert', msg: 'judge auth failed; desk halted' }); return { ok: false, fallback: 'halt', kind }; }
      if (consecutiveErrors >= haltAfter) { halted = 'repeated_errors'; onEvent({ type: 'alert', msg: `${consecutiveErrors} consecutive judge errors; desk halted, waiting for you` }); return { ok: false, fallback: 'halt', kind }; }
      if (kind === 'rate_limited' || kind === 'overloaded') {
        backoffMs = Math.min(60000, Math.max(e.retryAfterMs ?? 0, backoffMs ? backoffMs * 2 : 1000));
        backoffUntil = now() + backoffMs;
        return { ok: false, fallback: 'hold', kind };
      }
      if (kind === 'timeout') return { ok: false, fallback: 'hold', kind };
      return { ok: false, fallback: 'safe_state', kind }; // down: pull quotes, flatten
    } finally { clearTimeout(timer); }
  }

  return { decide, get halted() { return halted; }, resume() { halted = null; consecutiveErrors = 0; brokenBatteries.clear(); } };
}
