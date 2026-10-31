// Append-only JSONL logs: every snapshot, every question, every answer and every outcome.
// Secrets never reach a log: values under sensitive-looking keys are redacted before writing.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = fileURLToPath(new URL('./data/', import.meta.url));
const SENSITIVE = /(key|secret|token|password|authorization|private)/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) && typeof v === 'string' ? '[redacted]' : redact(v);
    return out;
  }
  return value;
}

export function createLogger({ dir = process.env.DESK_LOG_DIR || DEFAULT_DIR, now = () => Date.now() } = {}) {
  mkdirSync(dir, { recursive: true });
  const day = () => new Date(now()).toISOString().slice(0, 10);
  function write(stream, record) {
    const line = JSON.stringify(redact({ ts: now(), ...record }));
    appendFileSync(join(dir, `${stream}-${day()}.jsonl`), line + '\n');
  }
  return {
    dir,
    decision: (r) => write('decisions', r), // snapshot + questions + raw answers + policy result
    outcome: (r) => write('outcomes', r), // resolved truth for each labelled question
    trade: (r) => write('trades', r),
    veto: (r) => write('vetoes', r),
    rejection: (r) => write('rejections', r), // funnel: every no, with the check that fired
    event: (r) => write('events', r), // fallback ladder, halts, mode changes
  };
}
