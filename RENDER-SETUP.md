# MemeScout paper worker
One Render Background Worker runs the launch listener and main exit-only monitor. It never signs, broadcasts or accesses a private wallet key.

## Setup
1. In Render, New -> Blueprint. Connect GitHub and select the private mocertii4l/memescout-runner repository.
2. The render.yaml file defines one paid 0.5 CPU / 512 MB background worker in Frankfurt. Check the displayed price before creating the service.
3. Set DESK_ORIGIN to your published HTTPS Base44 app origin, e.g. https://YOUR-APP.base44.app (no editor URL or page path).
4. Render generates FAST_RUNNER_SECRET. Copy the value from the service Environment page into the Base44 backend secret of the same name. Do not paste it into chat, code or GitHub. Redeploy or restart the worker after saving the backend secret.
5. Verify logs: creation stream connected and successful paper cycles. A connected WebSocket alone does not prove a successful authenticated backend request. In Base44, Launch lab should show a recent connected listener heartbeat; the main fast monitor should show a recent exit-only heartbeat.

Authentication failures stop the launch listener and supervisor. The host can restart it once secrets match.
Run only one instance. No database, disk, public port or HTTP web service is needed. Upstream and Base44 request limits or credit allowances still apply. This is sampled processing of launch signals, not every coin or guaranteed first-block entry.

## Data and timing
The launch queue is bounded, has reconnect backoff and expires signals older than55 seconds. Only subscribeNewToken is used; no metered trade-event subscriptions. PUMPPORTAL_API_KEY can be added in Render Environment only if the creation feed requires it.
The worker posts up to10 events per sequential launch request, with15 seconds between requests. Backend launch checks and main exit checks can take longer; neither guarantees an exit at the exact stop. Missing sell quotes remain visible as stale positions.
Main and launch paper ledgers are separate. All trading remains simulated. Base44 stays the data store and dashboard.
