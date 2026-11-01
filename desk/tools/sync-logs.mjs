// Share the desk's logs through the private GitHub repo, on a separate `desk-logs` branch, so they can be
// analysed without sending files by hand. Push-only, never touches your working branch.
//   npm run share-logs              (one sync now)
//   npm run start:both              (syncs automatically every hour; see start.mjs)
// What is shared: logs/data/*.jsonl and status-*.json. The RPC URL / keys are never written to these logs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { isMain } from '../config/main.js';

const BRANCH = process.env.DESK_LOG_BRANCH || 'desk-logs';
const REMOTE = process.env.DESK_LOG_REMOTE || 'origin';

export function syncLogs({ logDir = process.env.DESK_LOG_DIR || fileURLToPath(new URL('../logs/data/', import.meta.url)), log = console.log } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }; // never hang waiting for a password
  const git = (args, cwd) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const id = ['-c', 'user.name=memescout-desk', '-c', 'user.email=desk@localhost'];

  if (!existsSync(logDir)) { log('share-logs: no logs yet'); return { pushed: false, reason: 'no_logs' }; }
  const root = git(['rev-parse', '--show-toplevel'], fileURLToPath(new URL('.', import.meta.url)));
  const wt = resolve(root, '.desk-logs-worktree');

  if (!existsSync(join(wt, '.git'))) {
    let remoteHas = false;
    try { git(['fetch', REMOTE, `${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}`], root); remoteHas = true; } catch { /* first time: branch doesn't exist yet */ }
    try { git(['worktree', 'prune'], root); } catch {}
    if (remoteHas) git(['worktree', 'add', '-B', BRANCH, wt, `${REMOTE}/${BRANCH}`], root);
    else {
      git(['worktree', 'add', '--detach', wt], root);
      git(['checkout', '--orphan', BRANCH], wt);
      try { git(['rm', '-rf', '--quiet', '.'], wt); } catch {}
    }
  }

  // Copy logs into logs/<machine>/ so two machines (PC, Render) never overwrite each other.
  const dest = join(wt, 'logs', hostname().replace(/[^\w.-]/g, '_') || 'desk');
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const f of readdirSync(logDir)) {
    if (!/\.(jsonl|json)$/.test(f) || f.endsWith('.tmp')) continue;
    const src = join(logDir, f);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(dest, f)); copied++;
  }
  git(['add', '-A'], wt);
  const changed = git(['status', '--porcelain'], wt);
  if (!changed) { log(`share-logs: nothing new (${copied} files)`); return { pushed: false, reason: 'no_changes' }; }
  git([...id, 'commit', '-q', '-m', `desk logs ${new Date().toISOString()} (${copied} files)`], wt);
  git(['push', '-q', '-u', REMOTE, `${BRANCH}:${BRANCH}`], wt);
  log(`share-logs: pushed ${copied} files to ${REMOTE}/${BRANCH}`);
  return { pushed: true, files: copied };
}

if (isMain(import.meta.url)) {
  try { syncLogs(); }
  catch (e) {
    const msg = String(e.stderr || e.message || e).split('\n').filter(Boolean).slice(-3).join(' | ');
    console.error(`share-logs failed: ${msg}`);
    process.exit(1);
  }
}
