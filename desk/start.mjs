// Process supervisor for the hosted desk (Render web service).
// Runs the Solana paper scanner + the dashboard (+ the synthetic desk if DESK_RUN_SYNTHETIC=1).
// A crashed child is restarted with backoff; the dashboard is the web process Render health-checks.
// Never signs, never holds a key: same paper-only guarantees as the individual scripts.
import { spawn } from 'node:child_process';
import { mkdirSync, accessSync, constants } from 'node:fs';

const wanted = process.env.DESK_LOG_DIR || '/var/data/logs';
let logDir = wanted;
try { mkdirSync(wanted, { recursive: true }); accessSync(wanted, constants.W_OK); }
catch {
  logDir = '/tmp/desk-logs'; mkdirSync(logDir, { recursive: true });
  console.error(`WARNING: ${wanted} is not writable; using ${logDir}. History will be LOST on every restart or deploy. Attach a Render disk at /var/data.`);
}
const env = { ...process.env, DESK_LOG_DIR: logDir, DESK_MODE: process.env.DESK_MODE === 'shadow' ? 'shadow' : 'paper' };
if (!env.DASHBOARD_USER || !env.DASHBOARD_PASSWORD_HASH) {
  console.error('DASHBOARD_USER and DASHBOARD_PASSWORD_HASH must be set in Render → Environment. Generate the hash locally with: cd desk && npm run dashboard:password');
}

const jobs = [
  { name: 'dashboard', file: 'dashboard/server.js', critical: true },
  { name: 'solana', file: 'solana-runner.js' },
  ...(process.env.DESK_RUN_SYNTHETIC === '1' ? [{ name: 'synthetic', file: 'runner.js' }] : []),
];
let stopping = false;
const children = new Map();

function run(job, attempt = 0) {
  if (stopping) return;
  const child = spawn(process.execPath, [job.file], { stdio: 'inherit', env, cwd: new URL('.', import.meta.url).pathname });
  const started = Date.now();
  children.set(job.name, child);
  child.on('exit', (code, signal) => {
    children.delete(job.name);
    if (stopping) return;
    const healthy = Date.now() - started > 60_000;
    const next = healthy ? 0 : attempt + 1;
    // A dashboard that can't start (e.g. missing login config) should fail the deploy, not loop forever.
    if (job.critical && next >= 5) { console.error(`${job.name} keeps failing; exiting so Render shows the deploy as failed.`); return stop(1); }
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
console.log(`desk supervisor: ${jobs.map((j) => j.name).join(' + ')} · logs ${logDir} · mode ${env.DESK_MODE}`);
for (const j of jobs) run(j);
