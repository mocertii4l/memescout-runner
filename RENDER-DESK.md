# Hosting the MemeScout desk dashboard on Render

This adds a **second** service, `memescout-desk`. It's a web service that runs the Solana paper scanner and the login-protected dashboard. Your existing `memescout-runner` worker is not changed.

It is paper-only. It holds no wallet keys, exchange keys or Jev key, and it cannot sign or send transactions.

## 1. Make your login (on your own computer)

```bash
git clone https://github.com/mocertii4l/memescout-runner && cd memescout-runner/desk
npm run dashboard:password
```

Choose a password of 10+ characters. It prints one line:

```
DASHBOARD_PASSWORD_HASH=scrypt$16384$8$1$…
```

Keep that line for step 3. The password itself is never stored anywhere; only this hash is. Don't paste the hash into chat, code or GitHub.

## 2. Create the service

1. Merge the desk PR into `main` (Render Blueprints deploy from `main`).
2. In Render, open the existing Blueprint for this repo and click **Sync** (or New → Blueprint and select the repo). Render will propose one new service, **memescout-desk**.
3. **Check the price shown before you approve.** It's one small web service plus a 1 GB disk. The disk keeps your trade history and equity curve across restarts and deploys. Without it, history resets on every deploy.

## 3. Set the secrets

In **memescout-desk → Environment**:

| key | value |
|---|---|
| `DASHBOARD_USER` | the username you want |
| `DASHBOARD_PASSWORD_HASH` | everything after `DASHBOARD_PASSWORD_HASH=` from step 1 |
| `SOLANA_RPC_URL` | **required for the strict desk to trade**: a free read-only RPC URL from Helius or similar. The public mainnet RPC refuses the holder lookup the strict filters need (verified live) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | optional phone alerts (see desk/README.md → Alerts) |
| `DISCORD_WEBHOOK_URL` | optional alerts to a Discord channel instead |
| `DESK_LOOSE` | `1` to also run the loose desk (kept out of account equity) |

The rest is already set by `render.yaml`: HTTPS-only cookies, proxy awareness, logs on the disk, paper mode.

Save. Render redeploys.

## 4. Open it

Go to `https://memescout-desk.onrender.com` (Render shows the exact URL) and sign in. It works on your phone too.

## Checking it's healthy

- **Logs** should show `desk supervisor: dashboard + solana`, `dashboard on http://0.0.0.0:… · login required`, and a minute-by-minute scanner line with `seen` going up.
- **Dashboard:** the Solana scanner card should say **LIVE**, not FEED DOWN, and "seen" should climb. SOL/USD should say JUPITER.
- If the deploy fails with "Binding beyond localhost requires DASHBOARD_USER and DASHBOARD_PASSWORD_HASH", step 3 is missing. That's deliberate: the dashboard refuses to go online without a login.

## Changing the password

Run `npm run dashboard:password` again, replace `DASHBOARD_PASSWORD_HASH` in Render, and save. Everyone gets signed out on the redeploy.

## Optional

- `DESK_RUN_SYNTHETIC=1` also runs the synthetic Gambler/House demo. It's off by default because its generated prices would mix into your account P/L.
- `JUDGE_URL` + `DESK_SECRET`: point at a judge service once you have a Jev key. Until then the desk uses the mock judge, and the dashboard says so.
