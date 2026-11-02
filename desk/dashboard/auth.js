// Username + password login for the dashboard.
// - The password is never stored: only a salted scrypt hash (DASHBOARD_PASSWORD_HASH).
// - Sessions are random 256-bit tokens in an HttpOnly, SameSite=Strict cookie (Secure behind HTTPS).
// - Failed logins are rate-limited per client and globally.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { isMain, flag } from '../config/main.js';

const N = 16384, R = 8, P = 1, KEYLEN = 32;

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) throw new Error('Use a password of at least 10 characters.');
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, n, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const got = scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return timingSafeEqual(got, expected);
  } catch { return false; }
}

const sameText = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());

export function createAuth({ user, passwordHash, ttlMs = 12 * 3600_000, maxFailures = 5, windowMs = 15 * 60_000, now = () => Date.now() } = {}) {
  const enabled = Boolean(user && passwordHash);
  const sessions = new Map(); // token -> { user, expires }
  const failures = new Map(); // client -> [timestamps]
  let globalFailures = [];

  function prune(list) { const t = now(); return list.filter((x) => t - x < windowMs); }

  return {
    enabled,
    /** @returns {{ ok: true, token } | { ok: false, reason: 'locked' | 'invalid' }} */
    login(username, password, client = 'unknown') {
      const f = prune(failures.get(client) ?? []);
      globalFailures = prune(globalFailures);
      if (f.length >= maxFailures || globalFailures.length >= maxFailures * 10) return { ok: false, reason: 'locked' };
      // Always run the hash, even for a wrong username, so timing doesn't reveal which part was wrong.
      const passOk = verifyPassword(password ?? '', passwordHash);
      const userOk = sameText(username ?? '', user);
      if (!(enabled && passOk && userOk)) {
        f.push(now()); failures.set(client, f); globalFailures.push(now());
        return { ok: false, reason: 'invalid' };
      }
      failures.delete(client);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { user, expires: now() + ttlMs });
      return { ok: true, token };
    },
    check(token) {
      if (!token) return null;
      const s = sessions.get(token);
      if (!s) return null;
      if (now() > s.expires) { sessions.delete(token); return null; }
      return s;
    },
    logout(token) { sessions.delete(token); },
    ttlMs,
  };
}

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// CLI: print a hash to put in DASHBOARD_PASSWORD_HASH.  Usage:  npm run dashboard:password
if (isMain(import.meta.url)) {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (!rl.muted) rl.output.write(s); };
  const ask = (q) => new Promise((res) => { rl.output.write(q); rl.muted = true; rl.question('', (a) => { rl.muted = false; rl.output.write('\n'); res(a); }); });
  const a = await ask('New dashboard password: ');
  const b = await ask('Repeat password: ');
  rl.close();
  if (a !== b) { console.error('Passwords did not match.'); process.exit(1); }
  console.log('\nDASHBOARD_PASSWORD_HASH=' + hashPassword(a));
  console.log('\nPut that line (and DASHBOARD_USER=<your username>) in the environment. Never commit it.');
}
