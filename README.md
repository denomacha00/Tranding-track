# Tranding-track

A professional crypto trading bot that turns TradingView alerts into real (or
paper) Binance orders, with a deterministic "smart" market analyzer, autonomous
trading, risk controls, and a clean React dashboard.

> **Trading risk.** No bot can guarantee profits or "never lose money." The goal
> here is disciplined risk management — small position sizing, stop-losses,
> exposure caps and a capital-preservation analyzer that would rather sit out
> than force a bad trade. **Paper mode is the default. Test on Binance testnet
> before ever going live.**

## How it works

```
TradingView alert ──▶ /webhook ──▶ risk checks ──▶ Binance order (or paper fill)
                                        │
           deterministic analyzer ──────┘ (autonomous mode: analyses & trades itself)
```

- **Execution path:** a TradingView alert hits the webhook, passes risk checks
  (sizing, max positions, daily loss limit, total-exposure cap), then either
  places a real Binance market order or a simulated paper fill. Paper is the
  default.
- **The "brain" is deterministic** (`app/analysis.py`): a transparent,
  multi-signal analyzer (EMA trend stack, RSI + MACD momentum, ATR/Bollinger
  volatility, recent return) that produces one confidence-scored verdict with a
  human-readable reason for every component. When signals disagree or
  volatility is extreme it returns **HOLD** — "no trade" is a valid decision.
- **Optional LLM narration + assessment** (`app/ai.py`) can *explain* the
  analysis and produce a deeper risk-first assessment (signal quality, risks,
  bull/bear scenarios, position-sizing sanity check), but it **never decides
  trades**. Works with either an OpenAI-compatible or an Anthropic-native
  (Claude) provider — pick via `AI_API_STYLE` (auto-detected by default).
- **Autonomous trading** is off by default, long-only, and confidence-gated.

## Features

- **Paper & live modes** — live places REAL Binance orders; testnet supported.
- **Risk management** — per-trade risk %, max open positions, daily loss limit,
  and a portfolio-wide **max total exposure %** cap across all open positions.
- **Exchange-side stop-loss orders** — in live mode a `stop_loss_limit` order is
  placed on Binance so the position is protected even if the bot process is
  down. The in-process SL/TP monitor is the fallback.
- **Trailing stops** — an open long's stop ratchets up as price makes new highs
  (never loosened), locking in gains.
- **Limit orders** — manual orders and TradingView alerts can carry a
  `limit_price`: the order rests until the market reaches it (a buy fills at or
  below, a sell at or above) instead of filling immediately at market. Pending
  orders reserve capital and a position slot, and can be cancelled from the
  dashboard.
- **Multi-timeframe confirmation** — in autonomous mode, set a higher
  "confirm timeframe" (e.g. `4h` while trading `1h`) and the bot refuses to buy
  when the higher timeframe reads bearish, or exit when it reads bullish.
- **Realistic backtesting** — event-driven, orders fill at the *next* bar's open
  (no look-ahead), with configurable fees and slippage; reports total fees.
- **Trainable** — grid-search optimiser with an in-sample/validation split to
  guard against overfitting.
- **Restart-safe** — settings overrides and paper balance persist across
  restarts; on startup in live mode positions are **auto-reconciled** against the
  exchange: a DB long the exchange no longer holds is closed, and a partial
  mismatch shrinks the tracked amount to match (every heal is logged and
  broadcast).
- **Schema migrations** — Alembic is set up (`backend/alembic`) for non-additive
  changes; the app also applies lightweight additive column migrations on startup
  so existing SQLite databases keep working out of the box.
- **API auth** — set `API_KEY` and all mutating endpoints require the
  `X-API-Key` header. Secrets are compared in constant time.
- **Structured logging** — `LOG_FORMAT=json` for log aggregators.
- **Retry/backoff** — transient Binance network errors are retried with
  exponential backoff; auth/insufficient-funds errors fail fast.
- **Telegram notifications** — optional trade/event alerts.

## Project layout

```
backend/    FastAPI + CCXT + SQLAlchemy trading engine and REST/WebSocket API
frontend/   React 18 + TypeScript + Vite dashboard
Dockerfile           Single-service image (builds UI + serves it from FastAPI) — used by Railway
railway.json         Railway build/deploy config (Dockerfile builder, healthcheck)
docker-compose.yml   Full stack (API on :8000, dashboard on :8080)
```

## Running locally

### Backend

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate        # Windows;  source .venv/bin/activate on Unix
pip install -r requirements.txt
# Create backend/.env with your settings (see "Configuration" below).
uvicorn app.main:app --reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev        # dev server
npm run build      # production build
```

### Docker (full stack)

```bash
# Put your keys in backend/.env first.
docker compose up -d --build
# Dashboard: http://localhost:8080   API: http://localhost:8000
```

There is also a **root `Dockerfile`** that builds the dashboard and serves it
from the FastAPI process as ONE service (same origin, no CORS) — this is what
Railway uses (see below). Run it locally with:

```bash
docker build -t tranding-track . && docker run -p 8000:8000 --env-file backend/.env tranding-track
# Everything on http://localhost:8000
```

## Deploy on Railway

This repo deploys to [Railway](https://railway.app) as a **single service** —
the root `Dockerfile` builds the React dashboard and the FastAPI backend serves
it from the same process, so REST, WebSocket and the UI all share one domain
(no CORS, one always-warm container = no cold-start lag).

**Why the GitHub pull was failing:** Railway's default (Nixpacks) builder
inspects the repo root and finds *both* a Python backend and a Node frontend in
subfolders with **no root build config**, so it can't decide how to build and
errors out. The added root `Dockerfile` + `railway.json` tell Railway exactly
how to build, which fixes the pull/build.

Steps:

1. Push this repo to GitHub (already the `origin`).
2. Railway → **New Project → Deploy from GitHub repo** → pick this repo. It
   detects `railway.json` and builds the root `Dockerfile` (builder =
   `DOCKERFILE`). No root/subfolder selection needed.
3. In the service **Variables** tab set at least:
   - `TRADING_MODE` (`paper` to start; `live` only when ready)
   - `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `BINANCE_TESTNET`
   - `TRADINGVIEW_WEBHOOK_SECRET`, and `API_KEY` (**set this — the public URL is
     internet-facing**)
   - AI vars if used (`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_STYLE`)
   - Do **not** set `PORT` — Railway injects it and the app binds to it.
4. (Recommended) Add a **Volume** mounted at `/data` so the SQLite DB survives
   redeploys. The image already points `DATABASE_URL` there.
5. Deploy. Healthcheck is `GET /api/health`; the dashboard is the service root
   `/`. On startup in live mode the logs run the exchange trading-access
   self-check and warn loudly if the key can't trade.

Notes:
- The bot runs a **single worker** (in-process monitor loop + paper wallet are
  per-process state) — do not scale replicas without externalising that state.
- SQLite on a volume is fine for one instance; move `DATABASE_URL` to managed
  Postgres if you later need multiple instances.

## Configuration

All settings load from environment / `backend/.env`. Key variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRADING_MODE` | `paper` | `paper` (simulated) or `live` (REAL orders) |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | – | Binance credentials (live) |
| `BINANCE_TESTNET` | `true` | Use Binance testnet |
| `TRADINGVIEW_WEBHOOK_SECRET` | `change-me` | Shared secret required in every alert |
| `API_KEY` | – | If set, mutating endpoints require `X-API-Key` |
| `MAX_OPEN_POSITIONS` | `5` | Max concurrent positions |
| `RISK_PER_TRADE_PCT` | `1.0` | Equity risked per trade |
| `DAILY_LOSS_LIMIT_PCT` | `5.0` | Halt new trades after this daily loss |
| `DEFAULT_STOP_LOSS_PCT` / `DEFAULT_TAKE_PROFIT_PCT` | `2.0` / `4.0` | Default SL/TP |
| `MAX_TOTAL_EXPOSURE_PCT` | `0` (off) | Cap on total open notional vs equity |
| `TRAILING_STOP_PCT` | `0` (off) | Trailing-stop distance |
| `MIN_SIGNAL_CONFIDENCE` | `0.5` | Autonomous trades require this confidence |
| `AUTO_TRADE_ENABLED` | `false` | Enable autonomous trading |
| `AUTO_SYMBOLS` | `BTC/USDT` | Symbols the bot analyses/trades |
| `AUTO_TIMEFRAME` | `1h` | Timeframe for autonomous analysis |
| `AUTO_CONFIRM_TIMEFRAME` | – | Higher timeframe that must agree (blank = off) |
| `AI_API_KEY` | – | Enables the optional LLM commentary/assessment layer |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Provider base URL (OpenAI- or Anthropic-style) |
| `AI_MODEL` | `gpt-4o-mini` | Model name (e.g. `gpt-4o-mini` or `claude-opus-4-8`) |
| `AI_API_STYLE` | `auto` | `auto` / `openai` / `anthropic` — auto infers from the model/URL |
| `AI_MAX_TOKENS` | `1024` | Token budget for AI replies (more = deeper reasoning) |
| `LOG_FORMAT` / `LOG_LEVEL` | `text` / `INFO` | `json` for structured logs |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | – | Optional notifications |

## TradingView alert format

Set the alert webhook URL to `http(s)://<host>/webhook` and the message body to:

```json
{ "secret": "your-webhook-secret", "action": "buy", "symbol": "BTC/USDT", "amount": 0.001 }
```

`action` is `buy`, `sell`, or `close`. `amount` is optional (falls back to
risk-based sizing). Add `"limit_price": 61000` to rest a limit order that only
fills when the market reaches that price. The alert is rejected unless `secret`
matches `TRADINGVIEW_WEBHOOK_SECRET`.

## Database migrations (Alembic)

The app creates tables and applies additive column migrations automatically on
startup, so nothing is required for normal use. For schema changes that additive
migrations can't handle, use Alembic from the `backend` directory (it reads
`DATABASE_URL` from your `.env`):

```bash
cd backend
.venv/Scripts/python -m alembic upgrade head              # apply migrations
.venv/Scripts/python -m alembic revision --autogenerate -m change   # create one
```

## Testing

```bash
cd backend && .venv/Scripts/python -m pytest -q     # backend unit/API tests
cd frontend && npm run build                        # type-check + build
```

## Security notes

- The API is unauthenticated unless `API_KEY` is set — **set it before exposing
  the API on any network.** Webhook and API secrets are compared in constant
  time to avoid timing attacks.
- Never commit `backend/.env` or real API keys.
- Live mode places real orders — start on testnet and with small size.
