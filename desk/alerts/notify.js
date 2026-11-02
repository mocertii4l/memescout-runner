// Phone alerts: Telegram and/or a Discord webhook. Optional — with no env set, alerts are a no-op.
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID     (make a bot with @BotFather, then message it once)
//   DISCORD_WEBHOOK_URL                       (channel → Edit → Integrations → Webhooks)
// Tokens never reach the logs (logger redacts *_TOKEN / *_URL-with-key fields; we never log them anyway).
// Token names in alerts are attacker-controlled text: sent as plain text, Discord mentions disabled.

const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);

export function createNotifier({ env = process.env, fetchImpl = fetch, now = () => Date.now(), maxPerMinute = 20, log = () => {} } = {}) {
  const tg = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? { token: env.TELEGRAM_BOT_TOKEN.trim(), chat: env.TELEGRAM_CHAT_ID.trim() } : null;
  let discord = null;
  if (env.DISCORD_WEBHOOK_URL) {
    try { const u = new URL(env.DISCORD_WEBHOOK_URL.trim()); if (u.protocol === 'https:' && DISCORD_HOSTS.has(u.hostname) && u.pathname.startsWith('/api/webhooks/')) discord = u.href; else log('DISCORD_WEBHOOK_URL ignored: not a discord.com webhook'); }
    catch { log('DISCORD_WEBHOOK_URL ignored: not a URL'); }
  }
  const enabled = Boolean(tg || discord);
  let sent = [];
  const recent = new Map(); // dedupe key -> ts

  async function send(text, { key, dedupeMs = 0 } = {}) {
    if (!enabled) return false;
    const t = now();
    if (key && dedupeMs && t - (recent.get(key) ?? -Infinity) < dedupeMs) return false;
    sent = sent.filter((x) => t - x < 60_000);
    if (sent.length >= maxPerMinute) return false;
    sent.push(t); if (key) recent.set(key, t);
    const body = String(text).slice(0, 1800);
    const jobs = [];
    if (tg) jobs.push(fetchImpl(`https://api.telegram.org/bot${tg.token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: tg.chat, text: body, disable_web_page_preview: true }), signal: AbortSignal.timeout(8000) }));
    if (discord) jobs.push(fetchImpl(discord, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: body, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(8000) }));
    const res = await Promise.allSettled(jobs);
    const ok = res.some((r) => r.status === 'fulfilled' && r.value.ok);
    if (!ok) log('alert delivery failed'); // never include the token or URL
    return ok;
  }
  return { enabled, send, channels: [tg && 'telegram', discord && 'discord'].filter(Boolean) };
}

const usd = (x) => (x == null || !Number.isFinite(x) ? '—' : (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2));
export const fmt = {
  entry: ({ profile, symbol, mint, usdIn }) => `🟢 PAPER BUY (${profile})\n${symbol || '?'}  $${usdIn.toFixed(2)}\nhttps://pump.fun/coin/${mint}`,
  exit: ({ profile, symbol, mint, reason, pess, opt }) => `${pess >= 0 ? '✅' : '🔻'} PAPER SELL (${profile}) ${symbol || '?'}\nreason: ${reason.replaceAll('_', ' ')}\nP/L pessimistic ${usd(pess)} · optimistic ${usd(opt)}\nhttps://pump.fun/coin/${mint}`,
  halt: ({ profile, why }) => `⛔ DESK HALTED (${profile}): ${why}\nNothing new will be bought until you restart it.`,
  feed: (up) => (up ? '📡 Launch feed reconnected.' : '⚠️ Launch feed DOWN for 2+ minutes. The scanner is blind until it reconnects.'),
  daily: (lines) => `📊 Daily paper summary\n${lines.join('\n')}`,
};
