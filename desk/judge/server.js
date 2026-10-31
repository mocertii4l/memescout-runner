// The judge: the only process on the desk that holds the Jev key and talks to Jev.
// Bots authenticate with DESK_SECRET. The judge makes no trading decision: it returns answers raw,
// because the caller owns every threshold.
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { batteries } from '../questions/index.js';
import { loadConfig } from '../config/index.js';
import { createJevClient, createMockJev } from './jev-client.js';
import { JudgeError } from './errors.js';

const MAX_BODY = 64 * 1024;

function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function createJudge({ ask, deskSecret, model, maxTimeoutMs = 2000 }) {
  if (!deskSecret || deskSecret.length < 32) throw new Error('DESK_SECRET must be at least 32 characters');
  if (!model || /latest/i.test(model)) throw new Error('Pin an exact Jev model version; aliases like jev-latest move when a release ships');

  return createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, model });
    if (req.method !== 'POST' || req.url !== '/v1/ask') return send(404, { error: 'not_found' });
    if (!safeEqual(req.headers['x-desk-secret'] ?? '', deskSecret)) return send(401, { error: 'auth' });

    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) return send(413, { error: 'malformed', detail: 'body too large' }); }
    let body;
    try { body = JSON.parse(raw); } catch { return send(400, { error: 'malformed', detail: 'invalid json' }); }

    // Bots name a battery; they cannot send arbitrary questions. Questions are reviewed code.
    const battery = batteries[body.battery];
    if (!battery) return send(400, { error: 'malformed', detail: 'unknown battery' });
    if (!body.state || typeof body.state !== 'object') return send(400, { error: 'malformed', detail: 'state required' });
    const timeoutMs = Math.min(maxTimeoutMs, Math.max(50, Number(body.timeout_ms) || maxTimeoutMs));

    const started = Date.now();
    try {
      // One call per decision: the whole battery at once, answered in parallel and in isolation.
      const out = await ask({ state: body.state, questions: battery.questions, model, timeoutMs });
      return send(200, { battery: battery.name, model_requested: model, model_version: out.model_version, latency_ms: Date.now() - started, answers: out.answers });
    } catch (e) {
      const kind = e instanceof JudgeError ? e.kind : 'unavailable';
      const status = { malformed: 400, auth: 502, rate_limited: 429, overloaded: 503, timeout: 504 }[kind] ?? 502;
      if (e.retryAfterMs) res.setHeader('retry-after', Math.ceil(e.retryAfterMs / 1000));
      return send(status, { error: kind });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const useMock = process.env.JEV_MOCK === '1' || !process.env.JEV_API_KEY;
  const model = process.env.JEV_MODEL || cfg.model_version_pin;
  const ask = useMock
    ? createMockJev({ version: model })
    : createJevClient({ apiKey: process.env.JEV_API_KEY, baseUrl: process.env.JEV_BASE_URL || undefined });
  const port = Number(process.env.JUDGE_PORT || 8787);
  const host = process.env.JUDGE_HOST || '127.0.0.1';
  createJudge({ ask, deskSecret: process.env.DESK_SECRET, model }).listen(port, host, () => {
    console.log(`judge listening on ${host}:${port} model=${model} backend=${useMock ? 'MOCK' : 'jev'}`);
  });
}
