// Error kinds drive the fallback ladder. Never retry `malformed`: the question is wrong and stays wrong.
export class JudgeError extends Error {
  constructor(kind, message, { status, retryAfterMs } = {}) {
    super(message);
    this.kind = kind; // timeout | unavailable | rate_limited | overloaded | malformed | auth | version_mismatch
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function classifyStatus(status) {
  if (status === 400 || status === 422) return 'malformed';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status === 503 || status === 529) return 'overloaded';
  return 'unavailable';
}
