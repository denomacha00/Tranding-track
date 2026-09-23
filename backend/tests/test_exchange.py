"""Tests for exchange-side stop orders, order cancel, and retry logic.

These use a fake ccxt-like client injected into BinanceConnector so no network
or real credentials are involved.
"""
from __future__ import annotations

import ccxt
import pytest

from app.config import Settings
from app.exchange import BinanceConnector, _with_retry


class FakeClient:
    """Minimal stand-in for ccxt.binance capturing the calls made."""

    def __init__(self):
        self.orders = []
        self.canceled = []

    def price_to_precision(self, symbol, price):
        return round(float(price), 2)

    def create_order(self, symbol, type_, side, amount, price=None, params=None):
        order = {
            "id": f"ord-{len(self.orders) + 1}",
            "symbol": symbol,
            "type": type_,
            "side": side,
            "amount": amount,
            "price": price,
            "params": params or {},
        }
        self.orders.append(order)
        return order

    def cancel_order(self, order_id, symbol):
        self.canceled.append((order_id, symbol))


def _conn_with_creds() -> BinanceConnector:
    conn = BinanceConnector(Settings(binance_api_key="k", binance_api_secret="s"))
    conn._client = FakeClient()
    return conn


def test_stop_loss_order_placed_with_stop_price():
    conn = _conn_with_creds()
    order = conn.create_stop_loss_order("BTC/USDT", "sell", 0.5, 40_000.0)
    assert order is not None
    assert order["type"] == "stop_loss_limit"
    assert order["params"]["stopPrice"] == 40_000.0
    # Protective sell limit is set BELOW the stop so it still fills on a fast drop.
    assert order["price"] < 40_000.0


def test_stop_loss_order_none_without_credentials():
    conn = BinanceConnector(Settings(binance_api_key="", binance_api_secret=""))
    conn._client = FakeClient()  # client present but no creds
    assert conn.create_stop_loss_order("BTC/USDT", "sell", 0.5, 40_000.0) is None


def test_stop_loss_order_swallows_exchange_error():
    conn = _conn_with_creds()

    def boom(*a, **k):
        raise ccxt.ExchangeError("not supported")

    conn._client.create_order = boom
    # Must degrade to None (fall back to in-process monitor), not raise.
    assert conn.create_stop_loss_order("BTC/USDT", "sell", 0.5, 40_000.0) is None


def test_cancel_order_calls_client():
    conn = _conn_with_creds()
    conn.cancel_order("ord-1", "BTC/USDT")
    assert conn._client.canceled == [("ord-1", "BTC/USDT")]


def test_cancel_order_noop_without_id():
    conn = _conn_with_creds()
    conn.cancel_order("", "BTC/USDT")
    assert conn._client.canceled == []


def test_retry_recovers_after_transient_error():
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ccxt.NetworkError("blip")
        return "ok"

    assert _with_retry(flaky, attempts=3, base_delay=0.0) == "ok"
    assert calls["n"] == 3


def test_retry_does_not_retry_non_transient():
    calls = {"n": 0}

    def bad():
        calls["n"] += 1
        raise ccxt.InsufficientFunds("no money")

    with pytest.raises(ccxt.InsufficientFunds):
        _with_retry(bad, attempts=3, base_delay=0.0)
    assert calls["n"] == 1  # raised immediately, no retries


def test_retry_exhausts_and_raises():
    def always_fail():
        raise ccxt.RequestTimeout("slow")

    with pytest.raises(ccxt.RequestTimeout):
        _with_retry(always_fail, attempts=2, base_delay=0.0)
