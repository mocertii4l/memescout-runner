import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate, saveSettings, currentSettings } from '../config/settings.js';
import { loadConfig } from '../config/index.js';
import { createDashboard } from '../dashboard/server.js';
import { createAuth } from '../dashboard/auth.js';
import { createSolanaDesk } from '../solana-runner.js';
import { createLocalJudge } from '../judge/client.js';
import { batteries } from '../questions/index.js';
import { createLogger } from '../logs/logger.js';

test('validation: bounds, unknown keys and cross-field rules', () => {
  assert.equal(validate({ strict: { stop_pct: 20 } }).ok, true);
  assert.match(validate({ strict: { stop_pct: 95 } }).errors[0], /between 3 and 90/);
  assert.match(validate({ strict: { model_version_pin: 1 } }).errors[0], /can't be changed/);
  assert.match(validate({ hacker: { stop_pct: 20 } }).errors[0], /unknown desk/);
  assert.match(validate({ loose: { trail_activate_pct: 10, trail_pct: 12 } }).errors[0], /smaller than where it starts/);
  assert.match(validate({ strict: { stop_pct: '' } }).errors[0], /must be a number/);
});

test('save: strict and loose stay independent; ticket moves position caps; diff reported', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'set-')), 'local.json');
  const { diff } = saveSettings(validate({ strict: { stop_pct: 25, ticket_usd: 40 }, loose: { stop_pct: 35 } }).clean, { settingsFile: file });
  assert.equal(diff.length, 3);
  const cfg = loadConfig({}, { settingsFile: file, local: true });
  assert.equal(cfg.solana.stop_bps, 2500);
  assert.equal(cfg.solana.risk_overrides.max_position_usd_total, 50);
  assert.equal(cfg.solana_profiles.loose.stop_bps, 3500);
  const cur = currentSettings({ settingsFile: file });
  assert.equal(cur.profiles.strict.stop_pct.value, 25);
  assert.equal(cur.profiles.loose.stop_pct.value, 35);
  assert.equal(cur.profiles.loose.ticket_usd.value, 20, 'changing strict never moves loose');
  saveSettings({}, { settingsFile: file, reset: true });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
});

test('a running desk applies new settings in place (exit rules and daily limit)', () => {
  const w = { curve: async () => null, curves: async () => new Map(), mintInfo: async () => null, largestHolders: async () => [] };
  const desk = createSolanaDesk({ cfg: loadConfig(), judge: createLocalJudge({ ask: async () => ({}), model: 'jev-1.13.0', batteries }), rpc: w, logger: createLogger({ dir: mkdtempSync(join(tmpdir(), 'set-')) }), getSolUsd: async () => ({ price: 150 }) });
  const file = join(mkdtempSync(join(tmpdir(), 'set-')), 'local.json');
  saveSettings(validate({ strict: { stop_pct: 22, daily_loss_limit_usd: 120 } }).clean, { settingsFile: file });
  desk.reconfigure(loadConfig({}, { settingsFile: file, local: true }));
  assert.equal(desk.cfg.solana.stop_bps, 2200);
  desk.risk.recordPnl(-100);
  assert.equal(desk.risk.halted, null, 'the raised daily limit is live');
});

test('settings API: needs login, the custom header and JSON; logs who changed what', async () => {
  const { hashPassword } = await import('../dashboard/auth.js');
  const dir = mkdtempSync(join(tmpdir(), 'set-'));
  const settingsFile = join(dir, 'local.json');
  const srv = createDashboard({ auth: createAuth({ user: 'mo', passwordHash: hashPassword('long password 1') }), dir, settingsFile });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/settings')).status, 401);
    const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=mo&password=long+password+1' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = await (await fetch(base + '/api/settings', { headers: { cookie } })).json();
    assert.ok(get.fields.length > 10 && get.profiles.strict.stop_pct.value === 15);
    const post = (body, headers = {}) => fetch(base + '/api/settings', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-desk-settings': '1', ...headers }, body: JSON.stringify(body) });
    assert.equal((await fetch(base + '/api/settings', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403, 'no custom header → refused');
    assert.equal((await post({ changes: { strict: { stop_pct: 500 } } })).status, 400);
    const ok = await (await post({ changes: { strict: { stop_pct: 20 } } })).json();
    assert.deepEqual(ok.diff, [{ desk: 'strict', setting: 'Stop-loss', from: 15, to: 20 }]);
    const ev = readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith('events'))), 'utf8');
    assert.match(ev, /settings_changed/); assert.match(ev, /"by":"mo"/);
  } finally { srv.close(); }
});
import { readdirSync } from 'node:fs';
