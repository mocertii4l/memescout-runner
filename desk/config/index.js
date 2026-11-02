import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('./desk.json', import.meta.url));
// Your own changes from the dashboard's Settings panel. Kept out of git, so `git pull` never overwrites them.
// On Render, point DESK_SETTINGS_FILE at the disk (e.g. /var/data/settings.json) so they survive deploys.
export const SETTINGS_FILE = process.env.DESK_SETTINGS_FILE || fileURLToPath(new URL('./local.json', import.meta.url));

export function readLocalSettings(file = SETTINGS_FILE) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; } catch { return {}; } // a broken file never stops the desk
}

// Tests (node --test sets NODE_TEST_CONTEXT) always use the committed defaults, never someone's local settings.
export function loadConfig(overrides = {}, { settingsFile = SETTINGS_FILE, local = !process.env.NODE_TEST_CONTEXT } = {}) {
  const base = JSON.parse(readFileSync(path, 'utf8'));
  return deepMerge(local ? deepMerge(base, readLocalSettings(settingsFile)) : base, overrides);
}

export function deepMerge(a, b) {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return b ?? a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = k in a ? deepMerge(a[k], v) : v;
  return out;
}
