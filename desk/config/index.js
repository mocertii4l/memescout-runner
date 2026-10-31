import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('./desk.json', import.meta.url));

export function loadConfig(overrides = {}) {
  const base = JSON.parse(readFileSync(path, 'utf8'));
  return deepMerge(base, overrides);
}

function deepMerge(a, b) {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return b ?? a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = k in a ? deepMerge(a[k], v) : v;
  return out;
}
