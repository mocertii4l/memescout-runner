// Settings the dashboard may change, with hard bounds. Anything not listed here can't be changed from the web.
// Values are shown in friendly units (% / seconds / $) and stored in the desk's own units.
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, readLocalSettings, SETTINGS_FILE, deepMerge } from './index.js';

// [key, label, group, path inside the profile's solana config, unit, min, max, toStored, fromStored]
const pct = (bps) => [(v) => Math.round(v * 100), (s) => s / 100];
const secs = [(v) => Math.round(v * 1000), (s) => s / 1000];
const mins = [(v) => Math.round(v * 60000), (s) => s / 60000];
const same = [(v) => v, (s) => s];
export const FIELDS = [
  ['ticket_usd', 'Ticket size', 'Size & limits', ['ticket_usd'], '$', 5, 100, ...same],
  ['daily_loss_limit_usd', 'Daily loss limit', 'Size & limits', ['risk_overrides', 'daily_loss_limit_usd'], '$', 5, 1000, ...same],
  ['min_inflow_sol', 'Min real buying', 'Entry filters', ['min_inflow_sol'], 'SOL', 0, 50, ...same],
  ['max_curve_progress_pct', 'Max curve progress', 'Entry filters', ['max_curve_progress_pct'], '%', 5, 100, ...same],
  ['min_market_cap_usd', 'Min market cap', 'Entry filters', ['min_market_cap_usd'], '$', 0, 200000, ...same],
  ['max_top10_pct', 'Max top-10 holders', 'Entry filters', ['max_top10_pct'], '%', 5, 100, ...same],
  ['max_largest_holder_pct', 'Max single holder', 'Entry filters', ['max_largest_holder_pct'], '%', 1, 100, ...same],
  ['max_creator_initial_buy_pct', 'Max creator buy', 'Entry filters', ['max_creator_initial_buy_pct'], '%', 0, 100, ...same],
  ['confirm_s', 'Confirm wait', 'Entry filters', ['confirm_ms'], 's', 0, 120, ...secs],
  ['confirm_max_drop_pct', 'Max drop while confirming', 'Entry filters', ['confirm_max_drop_bps'], '%', 0, 50, ...pct()],
  ['stop_pct', 'Stop-loss', 'Exits', ['stop_bps'], '%', 3, 90, ...pct()],
  ['take_pct', 'Take-profit at', 'Exits', ['take_bps'], '%', 5, 1000, ...pct()],
  ['partial_pct', 'Portion sold at take-profit', 'Exits', ['partial_fraction'], '%', 0, 100, (v) => v / 100, (s) => Math.round(s * 100)],
  ['trail_activate_pct', 'Trailing stop starts at', 'Exits', ['trail_activate_bps'], '%', 3, 1000, ...pct()],
  ['trail_pct', 'Trailing stop distance', 'Exits', ['trail_bps'], '%', 2, 90, ...pct()],
  ['max_hold_min', 'Max hold time', 'Exits', ['max_hold_ms'], 'min', 1, 120, ...mins],
  ['max_rug_pct', 'Max rug risk', 'Judge thresholds', ['policy', 'max_rug_prob'], '%', 0, 100, (v) => v / 100, (s) => Math.round(s * 100)],
  ['min_momentum_pct', 'Min momentum', 'Judge thresholds', ['policy', 'min_momentum_prob'], '%', 0, 100, (v) => v / 100, (s) => Math.round(s * 100)],
  ['min_quality', 'Min quality (0-3)', 'Judge thresholds', ['policy', 'min_quality'], '', 0, 3, ...same],
].map(([key, label, group, path, unit, min, max, toStored, fromStored]) => ({ key, label, group, path, unit, min, max, toStored, fromStored }));

const get = (o, p) => p.reduce((x, k) => x?.[k], o);
const set = (o, p, v) => { let x = o; for (const k of p.slice(0, -1)) x = x[k] ??= {}; x[p.at(-1)] = v; };
const mergeDeep = (a, b) => deepMerge(a ?? {}, b ?? {});

/** Effective per-profile solana config, exactly as the desks compute it. */
export function profileSolana(cfg, profile) { return profile === 'strict' ? cfg.solana : mergeDeep(cfg.solana, cfg.solana_profiles?.[profile] ?? {}); }

export function currentSettings({ settingsFile = SETTINGS_FILE } = {}) {
  const cfg = loadConfig({}, { settingsFile, local: true }), defaults = loadConfig({}, { local: false });
  const out = { fields: FIELDS.map(({ key, label, group, unit, min, max }) => ({ key, label, group, unit, min, max })), profiles: {} };
  for (const profile of ['strict', 'loose']) {
    const S = profileSolana(cfg, profile), D = profileSolana(defaults, profile);
    out.profiles[profile] = Object.fromEntries(FIELDS.map((f) => [f.key, { value: f.fromStored(get(S, f.path)), default: f.fromStored(get(D, f.path)) }]));
  }
  return out;
}

/** Validate a change set { strict: {key: value}, loose: {...} }. Returns { ok, errors, clean }. */
export function validate(changes) {
  const errors = [], clean = {};
  if (!changes || typeof changes !== 'object') return { ok: false, errors: ['body must be an object'] };
  for (const [profile, vals] of Object.entries(changes)) {
    if (!['strict', 'loose'].includes(profile)) { errors.push(`unknown desk ${profile}`); continue; }
    if (!vals || typeof vals !== 'object') { errors.push(`${profile}: values must be an object`); continue; }
    for (const [key, raw] of Object.entries(vals)) {
      const f = FIELDS.find((x) => x.key === key);
      if (!f) { errors.push(`${profile}: ${key} can't be changed here`); continue; }
      const v = Number(raw);
      if (raw === '' || raw === null || !Number.isFinite(v)) { errors.push(`${profile}: ${f.label} must be a number`); continue; }
      if (v < f.min || v > f.max) { errors.push(`${profile}: ${f.label} must be between ${f.min} and ${f.max}${f.unit === '%' ? '%' : f.unit ? ' ' + f.unit : ''}`); continue; }
      (clean[profile] ??= {})[key] = v;
    }
  }
  for (const [profile, v] of Object.entries(clean)) {
    // Cross-field sanity: a trailing stop must start above where it trails to.
    const tAct = v.trail_activate_pct, tr = v.trail_pct;
    if (tAct != null && tr != null && tr >= tAct) errors.push(`${profile}: trailing stop distance must be smaller than where it starts`);
  }
  return { ok: errors.length === 0, errors, clean };
}

/** Apply validated changes to the settings file. Strict values go under solana.*, loose under solana_profiles.loose.* (so the desks stay independent). */
export function saveSettings(clean, { settingsFile = SETTINGS_FILE, reset = false } = {}) {
  const local = reset ? {} : readLocalSettings(settingsFile);
  const before = currentSettings({ settingsFile });
  // Independence: a strict change must not drift loose's value through inheritance. Pin loose to what it was.
  for (const key of Object.keys(clean?.strict ?? {})) {
    if (clean.loose && key in clean.loose) continue;
    const f = FIELDS.find((x) => x.key === key);
    const looseLocal = ((local.solana_profiles ??= {}).loose ??= {});
    if (get(looseLocal, f.path) === undefined) set(looseLocal, f.path, f.toStored(before.profiles.loose[key].value));
    if (key === 'ticket_usd' && get(looseLocal, ['risk_overrides', 'max_position_usd_total']) === undefined) { const t = before.profiles.loose.ticket_usd.value; set(looseLocal, ['risk_overrides', 'max_position_usd_per_market'], Math.ceil(t * 1.25)); set(looseLocal, ['risk_overrides', 'max_position_usd_total'], Math.ceil(t * 1.25)); }
  }
  for (const [profile, vals] of Object.entries(clean ?? {})) {
    const base = profile === 'strict' ? (local.solana ??= {}) : ((local.solana_profiles ??= {}).loose ??= {});
    for (const [key, v] of Object.entries(vals)) {
      const f = FIELDS.find((x) => x.key === key);
      set(base, f.path, f.toStored(v));
      // Position caps follow the ticket so a bigger ticket isn't silently vetoed by an old cap.
      if (key === 'ticket_usd') { set(base, ['risk_overrides', 'max_position_usd_per_market'], Math.ceil(v * 1.25)); set(base, ['risk_overrides', 'max_position_usd_total'], Math.ceil(v * 1.25)); }
    }
  }
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile + '.tmp', JSON.stringify(local, null, 2));
  renameSync(settingsFile + '.tmp', settingsFile);
  const after = currentSettings({ settingsFile });
  const diff = [];
  for (const p of ['strict', 'loose']) for (const f of FIELDS) { const a = before.profiles[p][f.key].value, b = after.profiles[p][f.key].value; if (a !== b) diff.push({ desk: p, setting: f.label, from: a, to: b }); }
  return { diff, settings: after };
}
