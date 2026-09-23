"""Binance exchange connector built on CCXT.

Provides a thin, safe wrapper that supports both a real Binance account and the
Binance spot testnet. All network calls are guarded so the rest of the app can
run even when no API keys are configured (useful for paper trading and the UI).
"""
from __future__ import annotations

import logging
import time
from typing import Any, Callable, Optional, TypeVar

import ccxt

from app.config import Settings

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Transient network/exchange errors worth retrying (vs. auth/insufficient-funds).
_RETRYABLE = (
    ccxt.NetworkError,
    ccxt.ExchangeNotAvailable,
    ccxt.RequestTimeout,
    ccxt.DDoSProtection,
)


def _with_retry(fn: Callable[[], T], *, attempts: int = 3, base_delay: float = 0.5) -> T:
    """Call fn, retrying transient network errors with exponential backoff.

    Non-retryable errors (auth, insufficient funds, bad symbol) are raised
    immediately — retrying those just wastes time and hammers the exchange.
    """
    last_exc: Exception | None = None
    for i in range(attempts):
        try:
            return fn()
        except _RETRYABLE as exc:
            last_exc = exc
            if i == attempts - 1:
                break
            delay = base_delay * (2 ** i)
            logger.warning(
                "transient exchange error (attempt %d/%d): %s — retrying in %.1fs",
                i + 1, attempts, exc, delay,
            )
            time.sleep(delay)
    assert last_exc is not None
    raise last_exc


class BinanceConnector:
    """Wraps ccxt.binance with testnet support and defensive error handling."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: Optional[ccxt.binance] = None
        self._markets: Optional[dict[str, Any]] = None
        self._connect()

    def _connect(self) -> None:
        try:
            client = ccxt.binance(
                {
                    "apiKey": self._settings.binance_api_key or None,
                    "secret": self._settings.binance_api_secret or None,
                    "enableRateLimit": True,
                    "options": {"defaultType": "spot"},
                }
            )
            if self._settings.binance_testnet:
                # ccxt unified sandbox switch -> Binance spot testnet endpoints
                client.set_sandbox_mode(True)
            self._client = client
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Failed to initialise Binance client: %s", exc)
            self._client = None

    @property
    def connected(self) -> bool:
        return self._client is not None

    @property
    def has_credentials(self) -> bool:
        return bool(
            self._settings.binance_api_key and self._settings.binance_api_secret
        )

    def reload(self, settings: Settings) -> None:
        """Recreate the client, e.g. after settings change."""
        self._settings = settings
        self._markets: dict[str, Any] | None = None
        self._connect()

    # ---- markets / precision ----------------------------------------

    def _load_markets(self) -> dict[str, Any]:
        """Load and cache market metadata (precision, limits). Best-effort."""
        if self._markets is not None:
            return self._markets
        if not self._client:
            return {}
        try:
            self._markets = self._client.load_markets()
        except Exception as exc:
            logger.warning("load_markets failed: %s", exc)
            self._markets = {}
        return self._markets

    def normalize_amount(
        self, symbol: str, amount: float, price: float
    ) -> tuple[float, str | None]:
        """Round `amount` to the exchange's lot precision and validate limits.

        Returns (adjusted_amount, error). If error is not None the order should
        NOT be placed. This prevents Binance rejecting orders that violate
        lot-size / min-notional / min-amount rules — a common live-trading bug.
        """
        if amount <= 0:
            return 0.0, "amount must be positive"
        markets = self._load_markets()
        market = markets.get(symbol)
        if not market or not self._client:
            # No metadata available (e.g. offline/paper): pass through unchanged.
            return amount, None
        try:
            adjusted = float(self._client.amount_to_precision(symbol, amount))
        except Exception:
            adjusted = amount
        limits = market.get("limits", {}) or {}
        amt_limits = limits.get("amount", {}) or {}
        cost_limits = limits.get("cost", {}) or {}
        min_amt = amt_limits.get("min")
        if min_amt is not None and adjusted < float(min_amt):
            return adjusted, (
                f"amount {adjusted} below exchange minimum {min_amt} for {symbol}"
            )
        min_cost = cost_limits.get("min")
        if min_cost is not None and adjusted * price < float(min_cost):
            return adjusted, (
                f"notional {adjusted * price:.2f} below exchange minimum "
                f"cost {min_cost} for {symbol}"
            )
        if adjusted <= 0:
            return 0.0, "amount rounded to zero at exchange precision"
        return adjusted, None

    # ---- Market data -------------------------------------------------

    def fetch_ticker(self, symbol: str) -> dict[str, Any]:
        if not self._client:
            raise RuntimeError("Exchange client not available")
        return _with_retry(lambda: self._client.fetch_ticker(symbol))

    def fetch_price(self, symbol: str) -> float:
        ticker = self.fetch_ticker(symbol)
        last = ticker.get("last") or ticker.get("close")
        if last is None:
            raise RuntimeError(f"No price available for {symbol}")
        return float(last)

    def fetch_ohlcv(
        self, symbol: str, timeframe: str = "1h", limit: int = 200
    ) -> list[list[float]]:
        if not self._client:
            raise RuntimeError("Exchange client not available")
        return _with_retry(
            lambda: self._client.fetch_ohlcv(symbol, timeframe=timeframe, limit=limit)
        )

    # ---- Account -----------------------------------------------------

    def fetch_balance(self, quote: str = "USDT") -> Optional[float]:
        """Return free balance of the quote currency, or None if unavailable."""
        if not self._client or not self.has_credentials:
            return None
        try:
            balance = self._client.fetch_balance()
            free = balance.get("free", {})
            return float(free.get(quote, 0.0))
        except Exception as exc:
            logger.warning("fetch_balance failed: %s", exc)
            return None

    def fetch_position_amounts(self) -> dict[str, float]:
        """Return total held amount per base asset (for reconciliation).

        e.g. {"BTC": 0.5, "ETH": 2.0}. Empty dict if unavailable.
        """
        if not self._client or not self.has_credentials:
            return {}
        balance = self._client.fetch_balance()
        total = balance.get("total", {}) or {}
        return {asset: float(amt) for asset, amt in total.items() if amt}

    # ---- Orders ------------------------------------------------------

    def create_market_order(
        self, symbol: str, side: str, amount: float
    ) -> dict[str, Any]:
        """Place a REAL market order. Only called in live mode."""
        if not self._client:
            raise RuntimeError("Exchange client not available")
        if not self.has_credentials:
            raise RuntimeError("Binance API credentials are not configured")
        return _with_retry(lambda: self._client.create_order(symbol, "market", side, amount))

    def create_stop_loss_order(
        self, symbol: str, side: str, amount: float, stop_price: float
    ) -> Optional[dict[str, Any]]:
        """Place a REAL exchange-side stop order to protect a position.

        This is the safety net for when the bot process is down: the exchange
        itself triggers the exit. Best-effort — returns None (and logs) if the
        exchange/market doesn't support it, so the in-process SL/TP monitor stays
        the fallback rather than the app crashing.
        """
        if not self._client or not self.has_credentials:
            return None
        try:
            stop = float(self._client.price_to_precision(symbol, stop_price))
        except Exception:
            stop = stop_price
        # Binance spot STOP_LOSS_LIMIT needs a limit price. Set the limit slightly
        # THROUGH the stop (below it for a protective sell) so it still fills in a
        # fast drop instead of resting unfilled at exactly the stop.
        limit_price = stop * (0.995 if side == "sell" else 1.005)
        try:
            limit_price = float(self._client.price_to_precision(symbol, limit_price))
        except Exception:
            pass
        try:
            params = {"stopPrice": stop}
            return self._client.create_order(
                symbol, "stop_loss_limit", side, amount, limit_price, params
            )
        except Exception as exc:
            logger.warning("stop-loss order not placed for %s: %s", symbol, exc)
            return None

    def cancel_order(self, order_id: str, symbol: str) -> None:
        """Best-effort cancel of a resting order (e.g. a stop when we exit)."""
        if not self._client or not self.has_credentials or not order_id:
            return
        try:
            self._client.cancel_order(order_id, symbol)
        except Exception as exc:
            logger.warning("cancel_order %s failed: %s", order_id, exc)
