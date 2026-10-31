import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier, fmt } from '../alerts/notify.js';

function fakeFetch() {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  return { f, calls };
}

test('alerts are off unless configured', async () => {
  const n = createNotifier({ env: {} });
  assert.equal(n.enabled, false);
  assert.equal(await n.send('x'), false);
});

test('telegram + discord delivery, plain text, no mentions', async () => {
  const { f, calls } = fakeFetch();
  const n = createNotifier({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '42', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' }, fetchImpl: f });
  assert.deepEqual(n.channels, ['telegram', 'discord']);
  await n.send(fmt.entry({ profile: 'strict', symbol: '@everyone', mint: 'M1', usdIn: 20 }));
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /api\.telegram\.org\/botT\/sendMessage/);
  assert.equal(calls[0].body.chat_id, '42');
  assert.equal(calls[0].body.parse_mode, undefined, 'plain text: token names cannot inject formatting');
  assert.deepEqual(calls[1].body.allowed_mentions, { parse: [] }, 'a token named @everyone pings nobody');
});

test('non-discord webhook URLs are ignored; rate limit and dedupe hold', async () => {
  const { f, calls } = fakeFetch();
  assert.equal(createNotifier({ env: { DISCORD_WEBHOOK_URL: 'https://evil.example/api/webhooks/1' }, fetchImpl: f }).enabled, false);
  let t = 0;
  const n = createNotifier({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1' }, fetchImpl: f, now: () => t, maxPerMinute: 3 });
  for (let i = 0; i < 5; i++) await n.send('m' + i);
  assert.equal(calls.length, 3);
  t += 61_000;
  assert.equal(await n.send('halt', { key: 'h', dedupeMs: 3600_000 }), true);
  assert.equal(await n.send('halt', { key: 'h', dedupeMs: 3600_000 }), false);
});
