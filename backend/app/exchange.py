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
                    "options": {
                        "defaultType": "spot",
                        # Auto-sync our request timestamp to the exchange clock so
                        # a skewed local/host clock doesn't trigger Binance -1021
                        # "Timestamp outside recvWindow" rejections on private calls.
                        "adjustForTimeDifference": True,
                        "recvWindow": 10000,
                    },
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

    def create_limit_order(
        self, symbol: str, side: str, amount: float, price: float
    ) -> dict[str, Any]:
        """Place a REAL resting limit order. Only called in live mode.

        The order sits on the book until price crosses it (or it is cancelled).
        Caller polls fetch_order() to detect the fill.
        """
        if not self._client:
            raise RuntimeError("Exchange client not available")
        if not self.has_credentials:
            raise RuntimeError("Binance API credentials are not configured")
        try:
            limit = float(self._client.price_to_precision(symbol, price))
        except Exception:
            limit = price
        return _with_retry(
            lambda: self._client.create_order(symbol, "limit", side, amount, limit)
        )

    def fetch_order(self, order_id: str, symbol: str) -> Optional[dict[str, Any]]:
        """Fetch a single order's current state (status, filled, average price).

        Best-effort: returns None if unavailable so the caller can retry next
        tick rather than crashing the monitor loop.
        """
        if not self._client or not self.has_credentials or not order_id:
            return None
        try:
            return _with_retry(lambda: self._client.fetch_order(order_id, symbol))
        except Exception as exc:
            logger.warning("fetch_order %s failed: %s", order_id, exc)
            return None

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

    # ---- health / permissions ---------------------------------------

    def check_trading_access(self) -> dict[str, Any]:
        """Probe whether the configured key can actually TRADE, not just read.

        Returns a dict: {ok, can_read_public, can_read_account, can_trade,
        testnet, detail}. This makes the common -2015 failure (key with no Spot
        trading permission, wrong site, or IP restriction) obvious at startup
        instead of only when the first order silently fails.

        It never places an order: it reads public data, then reads the private
        account balance (which requires a valid, permissioned key). Trading
        permission is inferred from the account's reported permissions when the
        exchange exposes them, otherwise from a successful private read.
        """
        result: dict[str, Any] = {
            "ok": False,
            "can_read_public": False,
            "can_read_account": False,
            "can_trade": False,
            "testnet": self._settings.binance_testnet,
            "detail": "",
        }
        if not self._client:
            result["detail"] = "exchange client not available"
            return result
        # 1) public read — run this BEFORE the credentials check so a regional
        #    geo-block (HTTP 451) is surfaced clearly even for paper users with no
        #    keys, who would otherwise only see opaque 502s on market data.
        try:
            self._client.fetch_time()
            result["can_read_public"] = True
        except Exception as exc:
            msg = str(exc)
            low = msg.lower()
            if "451" in msg or "restricted location" in low or "eligibility" in low:
                result["detail"] = (
                    "Binance is geo-blocking this server's region (HTTP 451). "
                    "Neither live trading nor market data will work from here — "
                    "deploy in a Binance-supported region or route through a proxy."
                )
            else:
                result["detail"] = f"public data unreachable: {exc}"
            return result
        if not self.has_credentials:
            result["detail"] = "no API credentials configured (paper mode is fine)"
            return result
        # 2) private account read (this is what fails with -2015)
        try:
            balance = self._client.fetch_balance()
            result["can_read_account"] = True
        except Exception as exc:
            msg = str(exc)
            if "-2015" in msg or "Invalid API-key" in msg:
                result["detail"] = (
                    "account access denied (-2015): the key is invalid for this "
                    "endpoint, lacks permission, or is IP-restricted. For testnet, "
                    "create the key at testnet.binance.vision with Spot trading "
                    "enabled and no/matching IP restriction."
                )
            else:
                result["detail"] = f"account read failed: {msg}"
            return result
        # 3) infer trading permission from reported account permissions
        perms = self._account_permissions(balance)
        if perms is None:
            # Exchange didn't expose permissions; a successful private read means
            # the key works, so treat trading as available (best-effort).
            result["can_trade"] = True
            result["ok"] = True
            result["detail"] = "account readable; trading permission not reported (assumed enabled)"
            return result
        if any(p.lower() in ("spot", "trd_grp_002", "trd_grp_003") or "spot" in p.lower() for p in perms):
            result["can_trade"] = True
            result["ok"] = True
            result["detail"] = f"trading enabled (permissions: {', '.join(perms)})"
        else:
            result["detail"] = (
                f"key can read the account but Spot trading is NOT enabled "
                f"(permissions: {', '.join(perms) or 'none'}). Enable Spot trading "
                f"on the API key to place orders."
            )
        return result

    def _account_permissions(self, balance: dict[str, Any]) -> Optional[list[str]]:
        """Best-effort extraction of the account's trading permissions."""
        try:
            info = (balance or {}).get("info", {}) or {}
            perms = info.get("permissions")
            if isinstance(perms, list) and perms:
                return [str(p) for p in perms]
            # Some responses expose canTrade instead of a permissions list.
            if "canTrade" in info:
                return ["spot"] if info.get("canTrade") else []
        except Exception:
            pass
        return None
