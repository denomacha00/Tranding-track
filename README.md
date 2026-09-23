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
- **Optional LLM narration** (`app/ai.py`) can *explain* the analysis, but it
  **never decides trades**.
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
- **Multi-timeframe confirmation** — in autonomous mode, set a higher
  "confirm timeframe" (e.g. `4h` while trading `1h`) and the bot refuses to buy
  when the higher timeframe reads bearish, or exit when it reads bullish.
- **Realistic backtesting** — event-driven, orders fill at the *next* bar's open
  (no look-ahead), with configurable fees and slippage; reports total fees.
- **Trainable** — grid-search optimiser with an in-sample/validation split to
  guard against overfitting.
- **Restart-safe** — settings overrides and paper balance persist across
  restarts; live positions are reconciled (warn-only) on startup.
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
| `LOG_FORMAT` / `LOG_LEVEL` | `text` / `INFO` | `json` for structured logs |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | – | Optional notifications |

## TradingView alert format

Set the alert webhook URL to `http(s)://<host>/webhook` and the message body to:

```json
{ "secret": "your-webhook-secret", "action": "buy", "symbol": "BTC/USDT", "amount": 0.001 }
```

`action` is `buy`, `sell`, or `close`. `amount` is optional (falls back to
risk-based sizing). The alert is rejected unless `secret` matches
`TRADINGVIEW_WEBHOOK_SECRET`.

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
