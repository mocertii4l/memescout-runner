import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOG_DIR = process.env.DESK_LOG_DIR || fileURLToPath(new URL('../logs/data/', import.meta.url));

// Parsed-file cache keyed by path + size + mtime. Days of logs are re-read every 5 s by the dashboard;
// only files that changed get parsed again (today's files), older days come from memory.
const cache = new Map();
const MAX_CACHED_FILES = 400;

function parseFile(path) {
  let st;
  try { st = statSync(path); } catch { return []; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(path);
  if (hit && hit.key === key) return hit.rows;
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a half-written last line during a crash: skip it */ }
  }
  cache.set(path, { key, rows });
  if (cache.size > MAX_CACHED_FILES) cache.delete(cache.keys().next().value);
  return rows;
}

export function readStream(stream, { dir = LOG_DIR, day } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(stream + '-') && f.endsWith('.jsonl') && (!day || f.includes(day)))
    .sort()
    .flatMap((f) => parseFile(join(dir, f)));
}
