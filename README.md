# Orayan II

A Bybit USDT-perpetual futures trading engine. Structure-based signals, an explicit and
individually testable gate stack, honest paper accounting, and hard risk limits.

Built as a clean rewrite. Nothing is carried over from the previous codebase except the lessons
— which are recorded in `docs/EVIDENCE.md` and encoded directly in the defaults.

---

## Running it

### Option A — Docker (recommended if you're not setting up Node yourself)

Requires only [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed —
nothing else.

```bash
cp .env.example .env          # open .env and add your Bybit key/secret (optional for paper mode)
docker compose up -d          # builds and starts it in the background
```

Open **http://localhost:8080**. That's the whole setup.

Useful commands:
```bash
docker compose logs -f        # watch the engine log
docker compose down           # stop it (does NOT close open positions — see Safety controls)
docker compose up -d --build  # rebuild after you pull code changes
```

Settings and trade history are saved to a `data/` folder next to `docker-compose.yml`, on your
machine, not inside the container — so `docker compose down` and rebuilds never lose them.

### Option B — Node directly

Node 18 or newer. **No dependencies to install** — the backend uses only Node built-ins.

```bash
cp .env.example .env          # add your Bybit key/secret (optional for paper mode)
cd backend
node server.js
```

Open **http://localhost:8080**.

Either way: to run without any credentials at all, just start it — paper mode works fully. Only
live trading and the account-balance panel need API keys.

---

## The one environment variable rule

`BYBIT_API_KEY` and `BYBIT_API_SECRET` are the only environment configuration. Every other knob —
mode, timeframe, universe, all nine gates, sizing, leverage, circuit breakers — is set in the
Settings tab and stored server-side in `backend/data/settings.json`.

**Settings store only what you have actually changed**, not a full snapshot. Effective config =
built-in defaults + your overrides. This matters: with a full-snapshot design, a value saved once
is frozen forever, and shipping an improved default silently does nothing on an existing install.
Here, new defaults propagate automatically, and any value you have pinned by hand is marked with
an amber dot in the UI so you can see exactly what is diverging.

---

## Layout

```
backend/
  server.js              zero-dependency HTTP server, serves API + frontend
  routes/api.js          route table
  lib/
    settings.js          schema, defaults, validation, override tracking
    bybit.js             v5 REST client — signing, rate limit queue, retries
    marketData.js        klines / tickers / instrument specs, TTL cached
    indicators.js        EMA, RSI (Wilder), ATR (Wilder), volume ratio
    structure.js         swing pivots, BOS/CHoCH, clustered S/R levels
    signals.js           BTC regime, scoring, trade plan construction
    gates.js             the gate stack — one named predicate each
    risk.js              position sizing, circuit breakers
    executor.js          paper fill simulation + live order placement
    engine.js            scan loop, funnel, trade lifecycle
frontend/
  index.html  styles.css  app.js
```

---

## How a trade happens

1. **Universe** — linear USDT perps, ranked by 24h turnover, capped at your limit.
2. **Signal** — confirmed swing pivots give structure (BOS / CHoCH) and support/resistance.
   Direction comes from the structural event. Entry is placed **at the level**, not at market:
   the plan is "wait for price to come back", which is the fill path that preserves reward:risk.
3. **Score** — five transparent components out of 100 (trend 25, structure 25, momentum 15,
   location 20, reward:risk 15), scaled by a BTC-regime multiplier. Every component is visible
   per-signal in the UI. A score you cannot decompose is one you cannot debug.
4. **Gates** — each runs independently and records a pass/fail with a reason.
5. **Sizing** — `qty = riskUSDT / stopDistance`. Wide stop, small position. If the exchange
   minimum lot would exceed your configured risk, the trade is **refused**, not rounded up.
6. **Execution** — paper simulates against 1-minute candles; live sends a limit order with stop
   and target attached to the order itself, so a crashed process cannot leave a naked position.

---

## Paper accounting rules

These exist because their absence manufactures profit that does not survive contact with a real
exchange:

- P&L books off the **actual fill price**, never the planned price.
- A take-profit must **trade through** the level. An exact touch is not a fill.
- If one candle contains both the stop and the target, the true order is unknowable at 1-minute
  resolution — it is resolved as a **loss**.
- Fees are charged on every closed trade (maker in, taker out, both configurable).
- Missed-move chasing is **off by default** and should stay off.

---

## Gate defaults, and why

**On by default** — held up when tested against real trade outcomes:

| Gate | Default |
|---|---|
| `SCORE_BAND` | 40 ≤ score < 80 |
| `TURNOVER_GATE` | ≥ 3,000,000 USDT / 24h |
| `RR_BOUNDS` | 2.0 – 6.0 |
| `COST_FLOOR` | target must clear round-trip fees × 2.5 |
| `SL_DISTANCE` | 0.40% – 2.50% |
| `BTC_REGIME` | longs in bullish regimes only, shorts in bearish |
| `SPREAD` | ≤ 0.06% |

**Off by default** — kept because they are cheap to re-test, not because they are believed to work:

- `VOLUME_GATE` — failed four independent tests. It cuts trade volume hard and does not improve
  results.
- `FUNDING_GATE` — the strongest gate on the real execution ledger, and a complete no-op in a
  fresh backtest over nearly the same weeks. That contradiction is unresolved, so it is opt-in.

Portfolio limits (`MAX_POSITIONS`, `MAX_PER_DIRECTION`, `NO_DUPLICATE_SYMBOL`, `SYMBOL_LOCKOUT`)
are always on. They are exposure limits, not strategy opinions.

---

## Read this before risking money

**The edge is not proven.** The gate defaults come from one ~20-day window on one dataset,
producing roughly +0.11R per trade over 437 simulated trades. That is directional evidence and
nothing more. It has not passed multi-month walk-forward validation, Monte Carlo, or a
pair-concentration robustness check — and in the prior codebase, nearly every hypothesis that
looked this good collapsed on exactly those tests.

**The signal engine here is new code.** It was rebuilt from scratch, so it has *not* been
backtested at all. The gate thresholds were validated against a different signal generator. Treat
the whole thing as unproven until you have run your own paper period.

Sensible sequence: run paper for several weeks → check the funnel to see which gates are actually
doing work → backtest the real signal engine properly → testnet → mainnet at minimum size.

The defaults ship deliberately safe: `tradingEnabled = false`, `mode = paper`, `testnet = true`,
risk 0.25 USDT/trade. Going live and turning off testnet both require confirming a dialog.

---

## Safety controls

- **Close everything** — cancels all pending orders and market-closes all open positions, then
  blocks new entries until you release it.
- **Circuit breakers** — halt on consecutive losses or a daily loss limit, with a cooldown. A
  symbol that loses gets locked out for a configurable period.
- **Stop button** stops scanning. It deliberately does **not** close positions — use Close
  everything for that.

Stopping the process does not close open positions. In live mode the stop and target are attached
to the exchange order, so they remain active on Bybit whether or not this app is running.

---

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness, whether keys are set |
| GET | `/api/status` | engine state, funnel, summary |
| GET | `/api/settings` | schema, effective values, pinned keys |
| POST | `/api/settings` | patch settings |
| POST | `/api/settings/reset` | reset one key or all |
| GET | `/api/signals` | last scan's signals with gate verdicts |
| GET | `/api/trades` | trade history + summary |
| GET | `/api/logs?after=N` | incremental log tail |
| GET | `/api/account` | Bybit wallet balance |
| POST | `/api/control/{start,stop,scan,panic,release-kill,clear-halt,reset-trades,clear-cache}` | control |

The server binds all interfaces and has **no authentication**. Do not expose it to the internet.
Run it locally, or behind a VPN or an authenticating reverse proxy.
