import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOG_DIR = process.env.DESK_LOG_DIR || fileURLToPath(new URL('../logs/data/', import.meta.url));

export function readStream(stream, { dir = LOG_DIR, day } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(stream + '-') && f.endsWith('.jsonl') && (!day || f.includes(day)))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
