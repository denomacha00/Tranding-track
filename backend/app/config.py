"""Application configuration loaded from environment / .env file."""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # Trading mode: "paper" (simulated) or "live" (real orders)
    trading_mode: str = Field(default="paper")

    # Binance
    binance_api_key: str = Field(default="")
    binance_api_secret: str = Field(default="")
    binance_testnet: bool = Field(default=True)

    # Exchange selection & networking. Default is Binance global — nothing
    # changes unless you set these. Binance legally geo-blocks some server
    # regions (HTTP 451): from a blocked region NO Binance call works (not even
    # public market data), which looks like "everything fails". Two real levers:
    #   * exchange_id="binanceus" if your server is in the US (ccxt `binanceus`;
    #     note: US spot markets, no testnet), or another ccxt exchange id.
    #   * exchange_http_proxy=<url> to route requests through an HTTP/HTTPS proxy
    #     that sits in a Binance-supported region.
    # Empty proxy = direct connection. This is honest infra config: it does not
    # fake data, it changes where/what the app actually talks to.
    exchange_id: str = Field(default="binance")
    exchange_http_proxy: str = Field(default="")

    # TradingView webhook
    tradingview_webhook_secret: str = Field(default="change-me")

    # Optional AI/LLM commentary. Works with EITHER an OpenAI-compatible
    # chat-completions API OR an Anthropic-native messages API. Leave
    # ai_api_key empty to disable — the bot works fully without it.
    ai_api_key: str = Field(default="")
    ai_base_url: str = Field(default="https://api.openai.com/v1")
    ai_model: str = Field(default="gpt-4o-mini")
    ai_timeout_seconds: float = Field(default=45.0)
    # Provider API style: "auto" (infer from model/base_url), "openai", or
    # "anthropic". Auto picks Anthropic when the model looks like a Claude model
    # or the base URL is anthropic-flavoured; otherwise OpenAI chat-completions.
    ai_api_style: str = Field(default="auto")
    # Token budget for AI replies. Higher = more room to reason/research.
    ai_max_tokens: int = Field(default=1024)

    # Risk management
    max_open_positions: int = Field(default=5)
    risk_per_trade_pct: float = Field(default=1.0)
    daily_loss_limit_pct: float = Field(default=5.0)
    default_stop_loss_pct: float = Field(default=2.0)
    default_take_profit_pct: float = Field(default=4.0)
    # Cap on TOTAL open notional across ALL positions, as a % of equity. This is
    # portfolio-level exposure control on top of per-trade sizing: it stops many
    # "small" positions from adding up to an oversized book. 0 disables.
    max_total_exposure_pct: float = Field(default=0.0)
    # Trailing stop (percent). 0 disables. When > 0, an open long's stop-loss is
    # ratcheted up as price makes new highs, locking in gains while letting
    # winners run. Never loosened.
    trailing_stop_pct: float = Field(default=0.0)

    # Autonomous trading: only act on analysis at/above this confidence (0..1).
    min_signal_confidence: float = Field(default=0.5)
    # When true, the bot analyses `auto_symbols` on each monitor tick and trades
    # confident signals itself (paper or live per trading_mode). Default off.
    auto_trade_enabled: bool = Field(default=False)
    auto_symbols: str = Field(default="BTC/USDT")
    auto_timeframe: str = Field(default="1h")
    # Multi-timeframe confirmation for autonomous trading. When set to a higher
    # timeframe (e.g. "4h"), a buy is only taken if that higher timeframe does
    # NOT read as a sell, and a confident-sell exit is only taken if the higher
    # timeframe is not a buy. Empty = single-timeframe (disabled).
    auto_confirm_timeframe: str = Field(default="")

    # AI trade review (permission gate). When true AND an AI key is configured
    # AND autonomous trading is on, the AI layer reviews each ENTRY the
    # deterministic brain proposes and may VETO it (risk-first). It can only
    # BLOCK new risk — never invent a trade, never block an exit — and if the AI
    # is unavailable it falls back to the deterministic decision (never
    # fabricates a veto/approval). Off by default; paper-test before enabling live.
    ai_trade_confirm: bool = Field(default=False)

    # Live market-news sources for the AI assistant + News panel. Comma-separated
    # public RSS/Atom feed URLs (crypto/markets). Real headlines only — if a feed
    # is unreachable it's reported as unavailable, never faked. No user data is
    # sent to fetch these (plain GETs to public feeds).
    news_feeds: str = Field(
        default=(
            "https://www.coindesk.com/arc/outboundfeeds/rss/,"
            "https://cointelegraph.com/rss"
        )
    )

    # Paper trading
    paper_starting_balance: float = Field(default=10_000.0)

    # Server
    cors_origins: str = Field(default="http://localhost:5173")
    database_url: str = Field(default="sqlite:///./tranding_track.db")

    # Logging: "text" (human) or "json" (structured, one JSON object per line —
    # good for shipping to a log aggregator). Level is the root log level.
    log_format: str = Field(default="text")
    log_level: str = Field(default="INFO")

    # API auth: if set, all mutating/control endpoints require this key via the
    # `X-API-Key` header. Empty = open (fine for localhost-only dev). Set this
    # before exposing the API on any network.
    api_key: str = Field(default="")

    # ---- Multi-user auth & licensing --------------------------------
    # Master secret used to (a) sign JWT access tokens and (b) derive the
    # Fernet key that encrypts each user's Binance/AI API keys at rest. MUST be
    # set in any real deployment. If empty, login still works but per-user key
    # storage is disabled (fail-safe) because we refuse to store secrets we
    # cannot encrypt.
    secret_key: str = Field(default="")
    # Access-token lifetime (minutes).
    access_token_ttl_minutes: int = Field(default=60 * 24 * 7)
    # The email that is auto-promoted to admin on signup/startup. The admin
    # grants licenses to other users. If empty, the very first registered user
    # becomes the admin.
    admin_email: str = Field(default="")
    # When true, new signups start with an ACTIVE license (open access). When
    # false (default), new users are PENDING until the admin grants a license —
    # this is the "users need a licence from me" gate.
    auto_license_new_users: bool = Field(default=False)

    # Telegram notifications (optional). Set both to receive trade/alert pings.
    telegram_bot_token: str = Field(default="")
    telegram_chat_id: str = Field(default="")

    # Abuse protection: in-process rate limiting on auth + webhook endpoints.
    # Enabled by default; set RATE_LIMIT_ENABLED=false only for tests/local dev.
    rate_limit_enabled: bool = Field(default=True)

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def auto_symbol_list(self) -> list[str]:
        return [s.strip().upper() for s in self.auto_symbols.split(",") if s.strip()]

    @property
    def news_feed_list(self) -> list[str]:
        return [u.strip() for u in self.news_feeds.split(",") if u.strip()]

    @property
    def is_live(self) -> bool:
        return self.trading_mode.lower() == "live"


@lru_cache
def get_settings() -> Settings:
    return Settings()
