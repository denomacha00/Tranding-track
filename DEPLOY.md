# Deployment Guide — Tranding-track (Railway, single service)

Operator checklist to take the app live. The FastAPI backend serves the built
React UI from **one** Railway service, so there is a single public URL and no
CORS to fight. Every setting below was taken from `backend/app/config.py`.

> **This is a real-money app.** Two items are unforgiving: the persistent
> **volume** (§1) and **`SECRET_KEY`** (§2). Get either wrong and you lose user
> data or make every stored API key undecryptable.

---

## 1. Add a persistent volume — do this FIRST

Railway → your service → **Volumes** → add a volume with mount path:

```
/data
```

SQLite lives on this volume. The container filesystem is ephemeral, so without
the volume **every redeploy wipes all users, trades, and encrypted keys.**

---

## 2. Environment variables

Railway → **Variables** → **Raw Editor**, then paste the blocks below.

### Tier 1 — Required (the authenticated app 503s without `SECRET_KEY`)

```
SECRET_KEY=<paste your existing key — DO NOT rotate it>
ADMIN_EMAIL=<the email you will log in with>
DATABASE_URL=sqlite:////data/tranding_track.db
AUTO_LICENSE_NEW_USERS=false
TRADING_MODE=paper
```

- `SECRET_KEY` signs logins **and** derives the Fernet key that encrypts every
  user's Binance keys. **Never rotate on a live deploy** — it logs everyone out
  and makes stored keys undecryptable. Need a fresh one for a brand-new deploy?
  `python -c "import secrets; print(secrets.token_urlsafe(48))"`
- `ADMIN_EMAIL` — sign up with this exact email → you become admin → the
  **Admin** tab appears, where you Grant/Revoke user licenses.
- `DATABASE_URL` — the four slashes = absolute `/data` path (the volume in §1).
- `AUTO_LICENSE_NEW_USERS=false` keeps the "users need my approval" gate.
- `TRADING_MODE=paper` for testing. New users start in paper regardless.

### Tier 2 — TradingView webhook (set before wiring TradingView)

```
TRADINGVIEW_WEBHOOK_SECRET=<a long random string, NOT "change-me">
CORS_ORIGINS=https://<your-app>.up.railway.app
```

The default secret is literally `change-me`; change it before exposing the
webhook. Single-service means same-origin, but set `CORS_ORIGINS` to your real
URL for correctness.

### Tier 3 — AI (app-wide "inbuilt": users never enter an AI key)

One operator key powers everyone; it is **advisory-only and never trades**.

```
AI_API_KEY=<your one operator key>
AI_API_STYLE=auto
```

- **OpenAI key** → done. Defaults apply (`AI_MODEL=gpt-4o-mini`,
  `AI_BASE_URL=https://api.openai.com/v1`).
- **Anthropic/Claude key** → also add `AI_BASE_URL=https://api.anthropic.com/v1`
  and `AI_MODEL=<a current Claude model>`.
- Omit `AI_API_KEY` entirely and the bot still works — it falls back to the
  deterministic analysis instead of narration.

### Do NOT set these

- **`BINANCE_API_KEY` / `BINANCE_API_SECRET`** — leave unset. Each user enters
  their own keys in the Settings tab, stored encrypted per-user. Global keys
  are ignored per-user.
- **`API_KEY`** — leave unset. Legacy single-user guard; JWT auth protects the
  app in multi-user mode.

### Optional (sensible defaults; also editable per-user in the Settings tab)

Risk: `RISK_PER_TRADE_PCT`, `DEFAULT_STOP_LOSS_PCT`, `DEFAULT_TAKE_PROFIT_PCT`,
`DAILY_LOSS_LIMIT_PCT`, `MAX_OPEN_POSITIONS`, `MAX_TOTAL_EXPOSURE_PCT`,
`TRAILING_STOP_PCT`, `MIN_SIGNAL_CONFIDENCE`.
Autonomous: `AUTO_TRADE_ENABLED` (keep `false` for now), `AUTO_SYMBOLS`,
`AUTO_TIMEFRAME`, `AUTO_CONFIRM_TIMEFRAME`.
Other: `LOG_FORMAT=json`, `LOG_LEVEL=INFO`, `PAPER_STARTING_BALANCE`,
`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, `ACCESS_TOKEN_TTL_MINUTES`.

---

## 3. Deploy & verify (order matters)

1. Add the `/data` volume (§1).
2. Set the Tier 1 variables (§2), plus Tier 2/3 as needed.
3. Redeploy.
4. Open the site → **Sign up** with the exact `ADMIN_EMAIL` → confirm the
   **Admin** tab appears.
5. Create a second test account → in **Admin**, click **Grant** on its row.
6. Log in as the test account → Settings → add Binance **testnet** keys →
   place a **paper** trade and confirm it opens/closes with real prices.

## 4. Licensing model (there are no license "keys")

Licensing is admin approval, not redeemable codes:

- New signup → `pending` (can log in, cannot trade).
- Admin → **Admin** tab → **Grant** → `active` (can add keys and trade).
- **Revoke** → access withdrawn.

If `ADMIN_EMAIL` is blank, the **first** account to sign up becomes admin.

## 5. Going live (per user, later)

Live trading is an explicit per-user opt-in in Settings — no one trades real
funds just by being licensed. Before a user flips to live, the app runs a
trading-access self-check (surfaces geo-block / key-permission problems). Keep
`TRADING_MODE=paper` at the server level while validating.

