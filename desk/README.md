# MemeScout desk: paper-only AI trading desk skeleton

**Code calculates. Jev judges. The risk engine vetoes. The paper broker executes. You sign anything irreversible.**

There is no live broker in this repo. `broker/interface.js#createLiveBroker` throws.

```
feed → state/ (code: mid, spread, imbalance, vol, returns, inventory, drawdown)
     → judge/ (one call per decision, whole battery, raw typed answers)
     → policy/ (thresholds + weights from config/desk.json)
     → risk/  (hard vetoes, no model vote)
     → broker/paper.js   (paper mode)   |  nothing (shadow mode)
     → logs/  (state, questions, answers, outcomes → reports/)
```

## Quick start (no keys, no network)

```bash
cd desk
npm test                                   # 17 tests
DESK_TICKS=500 npm run shadow              # Jev labels everything, nothing executes
DESK_TICKS=500 npm run paper               # policy executes against the paper broker
npm run report:daily                       # decisions, trades, PnL after fees, vetoes, fallbacks
npm run report:calibration                 # Brier, ECE, Platt fit, reliability SVGs → logs/data/reports/
```

Without `JUDGE_URL`, the runner uses an in-process **mock** judge. It's a set of deterministic heuristics, not a model, so the whole loop and the reports can run. Calibration numbers from the mock mean nothing.

### Running the judge as its own service

```bash
export DESK_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
JEV_MOCK=1 npm run judge                   # holds the Jev key; bots never see it
JUDGE_URL=http://127.0.0.1:8787 npm run shadow
```

Test the link from the bot's own host, not your laptop.

## Layout

| dir | owns |
|---|---|
| `config/desk.json` | every threshold, limit, ticket size and bench TTL. Edit numbers, not prompts |
| `state/` | deterministic snapshot builder. Uses only data stamped before `asOf`. Missing values stay `null`. `leanState` enforces the 400-token budget |
| `questions/` | the Gambler, House and Spy batteries. Validator enforces an `other` option on every Choice and one judgment per question |
| `judge/` | `server.js`: the only holder of the Jev key; auth by desk secret; refuses `*latest*` aliases; returns answers raw. `jev-client.js`: the only file that knows the wire format, plus the mock. `ladder.js`: deadline rule and fallback ladder |
| `policy/` | answers → intent. Size comes from config, never from confidence. Avellaneda–Stoikov quotes for the House |
| `risk/` | max position (per market and total), daily loss halt, leverage cap, range guard, fees+gas economics, model-version pin, volume-pace exit rule, cancel-replace gas burn check |
| `broker/` | paper broker behind the same interface a live one would use |
| `filter/` | funnel: bench → free cut → one enrichment call → hard facts → Jev (capped) → one pick |
| `book/` | one position at a time per bot (no scan while open; only EXIT/RISK frees it), plus the bench, where the reason sets the TTL |
| `outcomes/` | ground-truth resolvers, fixed in code before you look at results |
| `logs/` | JSONL streams: decisions, outcomes, trades, vetoes, rejections, events. Secret-looking keys are redacted |
| `reports/` | calibration report and daily summary |
| `seats/CHARTERS.md` | HEAD / SEARCH / RISK / EXIT charters and the approval line |

## Fallback ladder (`judge/ladder.js`)

| condition | action |
|---|---|
| decision not back before the deadline (`decision_deadline_ms` < `block_ms`) | hold; never act on stale state |
| timeout | hold |
| judge/Jev down | pull quotes, flatten to safe state |
| rate limited / overloaded | exponential back-off (honours `retry-after`), hold meanwhile |
| malformed question | **never retried**; that battery halts until you fix the question |
| auth failure, or N consecutive errors | desk halts and waits for a human |

## ⚠ Before connecting real Jev

The Jev request/response shape in `judge/jev-client.js` comes from third-party guides. The build sandbox couldn't reach TypeSafe's docs, so it hasn't been checked against them. Before you leave mock mode:

1. Check `toWire` / `fromWire` against TypeSafe's official docs, or swap in the official SDK (`@typesafe-ai/sdk`).
2. Confirm the exact version string the API returns, and set `model_version_pin` to it. The risk engine vetoes any other version.
3. Use a key you created yourself, and give it to the judge only.

## The trust ladder

A bot climbs one rung at a time. Never raise size and change strategy in the same week.

1. **Shadow.** Jev labels every decision, the policy logs what it would do, nothing executes. Exit test: at least 2 days and several hundred labelled outcomes per question. Every disagreement with your intuition reviewed (most will be your thresholds).
2. **Paper.** The policy executes against the paper broker. Exit test: positive PnL after fees over a meaningful sample, zero unexplained risk vetoes, calibration curve within tolerance on your venue (Brier and ECE in `report:calibration`; apply the Platt fit in the policy layer if needed).
3. **Live, tiny.** Not in this repo. Needs your explicit approval, a fresh wallet you're willing to lose, and a trading-only key with withdrawals disabled.
4. **Size up.** Fractional Kelly only after calibration is verified on your own data.

## What this does not do

It doesn't find an edge. The synthetic feed, the mock judge and the default thresholds are placeholders, so a positive paper PnL here proves only that the plumbing works.
