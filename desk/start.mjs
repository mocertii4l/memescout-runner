// Process supervisor for the hosted desk (Render web service).
// Runs the Solana paper scanner + the dashboard (+ the synthetic desk if DESK_RUN_SYNTHETIC=1).
// A crashed child is restarted with backoff; the dashboard is the web process Render health-checks.
// Never signs, never holds a key: same paper-only guarantees as the individual scripts.
import { spawn } from 'node:child_process';
import { mkdirSync, accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Local default: desk/logs/data. Render sets DESK_LOG_DIR=/var/data/logs (its persistent disk).
const wanted = process.env.DESK_LOG_DIR || fileURLToPath(new URL('./logs/data/', import.meta.url));
let logDir = wanted;
try { mkdirSync(wanted, { recursive: true }); accessSync(wanted, constants.W_OK); }
catch {
  logDir = '/tmp/desk-logs'; mkdirSync(logDir, { recursive: true });
  console.error(`WARNING: ${wanted} is not writable; using ${logDir}. History will be LOST on every restart. (On Render: attach the disk at /var/data.)`);
}
const args = process.argv.slice(2);
const env = { ...process.env, DESK_LOG_DIR: logDir, DESK_MODE: process.env.DESK_MODE === 'shadow' || args.includes('--shadow') ? 'shadow' : 'paper' };
if (args.includes('--loose')) env.DESK_LOOSE = '1';
if (args.includes('--synthetic')) env.DESK_RUN_SYNTHETIC = '1';
const publicHost = env.DASHBOARD_HOST && !['127.0.0.1', 'localhost', '::1'].includes(env.DASHBOARD_HOST);
if (publicHost && (!env.DASHBOARD_USER || !env.DASHBOARD_PASSWORD_HASH)) {
  console.error('DASHBOARD_USER and DASHBOARD_PASSWORD_HASH must be set in Render → Environment. Generate the hash locally with: cd desk && npm run dashboard:password');
}

const jobs = [
  { name: 'dashboard', file: 'dashboard/server.js', critical: true },
  { name: 'solana', file: 'solana-runner.js' },
  ...(env.DESK_RUN_SYNTHETIC === '1' ? [{ name: 'synthetic', file: 'runner.js' }] : []),
];
let stopping = false;
const children = new Map();

function run(job, attempt = 0) {
  if (stopping) return;
  const child = spawn(process.execPath, [job.file], { stdio: 'inherit', env, cwd: fileURLToPath(new URL('.', import.meta.url)) });
  const started = Date.now();
  children.set(job.name, child);
  child.on('exit', (code, signal) => {
    children.delete(job.name);
    if (stopping) return;
    // Port taken = another desk is already running: don't retry, and don't run a second scanner beside it.
    if (job.critical && code === 3) { console.error('Stopping this copy so two desks never run at once.'); return stop(1); }
    const healthy = Date.now() - started > 60_000;
    const next = healthy ? 0 : attempt + 1;
    // A dashboard that can't start (e.g. missing login config) should fail the deploy, not loop forever.
    if (job.critical && next >= 5) { console.error(`${job.name} keeps failing; stopping everything (on Render this marks the deploy as failed).`); return stop(1); }
    const wait = Math.min(60_000, 1000 * 2 ** next);
    console.error(`${job.name} exited (${signal ?? code}); restarting in ${wait / 1000}s`);
    setTimeout(() => run(job, next), wait);
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true; process.exitCode = code;
  for (const c of children.values()) c.kill('SIGTERM');
  setTimeout(() => { for (const c of children.values()) c.kill('SIGKILL'); process.exit(code); }, 8000).unref();
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
console.log(`desk supervisor: ${jobs.map((j) => j.name).join(' + ')}${env.DESK_LOOSE === '1' ? ' (strict + loose)' : ''} · logs ${logDir} · mode ${env.DESK_MODE}`);
if (!publicHost) console.log(`dashboard: open http://127.0.0.1:${env.PORT || env.DASHBOARD_PORT || 8080} in your browser (Ctrl+C here stops everything)`);
for (const j of jobs) run(j);

// Optional: share logs hourly through the private repo's desk-logs branch (--share-logs). A failure never
// stops trading; it is printed and retried next hour.
if (args.includes('--share-logs')) {
  const every = Math.max(10, Number(env.DESK_LOG_SYNC_MIN) || 60) * 60_000;
  const share = () => {
    if (stopping) return;
    const c = spawn(process.execPath, ['tools/sync-logs.mjs'], { stdio: 'inherit', env, cwd: fileURLToPath(new URL('.', import.meta.url)) });
    c.on('error', () => console.error('share-logs could not start'));
  };
  setTimeout(share, 120_000).unref(); // first sync 2 min after start, then hourly
  setInterval(share, every).unref();
  console.log(`logs are shared to the private repo's desk-logs branch every ${every / 60_000} min`);
}
