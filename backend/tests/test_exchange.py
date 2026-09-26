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

    def fetch_time(self):
        # Public-read probe in check_trading_access(); a plain int epoch (ms) is
        # enough. Individual tests override this to simulate a geo-block/451.
        return 1700000000000

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


def _live_conn_with_creds() -> BinanceConnector:
    # Real-binance, testnet OFF: exercises the key-level apiRestrictions probe
    # (sapi is real-binance only, so the testnet default would skip it).
    conn = BinanceConnector(
        Settings(binance_api_key="k", binance_api_secret="s", binance_testnet=False)
    )
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


# ---- trading-access self-check --------------------------------------


def test_access_paper_no_credentials():
    conn = BinanceConnector(Settings(binance_api_key="", binance_api_secret=""))
    conn._client = FakeClient()
    res = conn.check_trading_access()
    assert res["ok"] is False
    assert res["can_trade"] is False
    assert "no API credentials" in res["detail"]


def test_access_denied_2015_is_explained():
    conn = _conn_with_creds()
    conn._client.fetch_time = lambda: 123

    def boom():
        raise ccxt.AuthenticationError(
            'binance {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}'
        )

    conn._client.fetch_balance = boom
    res = conn.check_trading_access()
    assert res["can_read_public"] is True
    assert res["can_read_account"] is False
    assert res["can_trade"] is False
    assert "-2015" in res["detail"]
    assert "testnet.binance.vision" in res["detail"]


def test_access_reads_account_but_spot_disabled():
    conn = _conn_with_creds()
    conn._client.fetch_time = lambda: 123
    conn._client.fetch_balance = lambda: {"info": {"permissions": ["MARGIN"]}}
    res = conn.check_trading_access()
    assert res["can_read_account"] is True
    assert res["can_trade"] is False
    assert res["ok"] is False
    assert "NOT enabled" in res["detail"]


def test_access_ok_with_spot_permission():
    conn = _conn_with_creds()
    conn._client.fetch_time = lambda: 123
    conn._client.fetch_balance = lambda: {"info": {"permissions": ["SPOT"]}}
    res = conn.check_trading_access()
    assert res["ok"] is True
    assert res["can_trade"] is True


def test_access_ok_with_trade_group_permission():
    # Region/eligibility-scoped accounts report a trade-group tag ("TRD_GRP_NNN")
    # instead of a bare "SPOT" — but they ARE authorized to trade the group's
    # symbols. Any TRD_GRP_* must count as spot-tradeable (not just a hardcoded
    # few), so a real account like TRD_GRP_061 isn't falsely blocked from live.
    for perms in (["TRD_GRP_061"], ["LEVERAGED", "TRD_GRP_061"], ["TRD_GRP_250"]):
        conn = _conn_with_creds()
        conn._client.fetch_time = lambda: 123
        conn._client.fetch_balance = lambda perms=perms: {"info": {"permissions": perms}}
        res = conn.check_trading_access()
        assert res["can_trade"] is True, perms
        assert res["ok"] is True, perms


def test_access_ok_when_permissions_not_reported():
    conn = _conn_with_creds()
    conn._client.fetch_time = lambda: 123
    conn._client.fetch_balance = lambda: {"info": {}, "free": {"USDT": 100.0}}
    res = conn.check_trading_access()
    # Private read succeeded and no permission list exposed -> assume tradable.
    assert res["ok"] is True
    assert res["can_trade"] is True


def test_access_cantrade_flag_true():
    conn = _conn_with_creds()
    conn._client.fetch_time = lambda: 123
    conn._client.fetch_balance = lambda: {"info": {"canTrade": True}}
    res = conn.check_trading_access()
    assert res["can_trade"] is True
    assert res["ok"] is True


def test_access_cantrade_flag_false():
    conn = _conn_with_creds()
    conn._client.fetch_time = lambda: 123
    conn._client.fetch_balance = lambda: {"info": {"canTrade": False}}
    res = conn.check_trading_access()
    assert res["can_trade"] is False
    assert res["ok"] is False


# ---- key-level Spot-trading probe (apiRestrictions) -----------------
# On REAL binance the authoritative signal for "can THIS key place spot orders"
# is the key's OWN restrictions (GET /sapi/v1/account/apiRestrictions ->
# enableSpotAndMarginTrading), NOT the account's permissions: a read-only key on
# a spot-eligible account (e.g. TRD_GRP_061) reads balances fine but still can't
# trade. These use _live_conn_with_creds() (testnet OFF) so the probe runs.


def test_access_readonly_key_sees_account_but_cannot_trade():
    # Read-only key on a spot-eligible (TRD_GRP_061) account: the account reads
    # fine (real balances + market data), but the KEY has Spot trading OFF, so
    # can_trade is honestly False while can_read_account stays True.
    conn = _live_conn_with_creds()
    conn._client.fetch_time = lambda: 123
    conn._client.fetch_balance = lambda: {"info": {"permissions": ["TRD_GRP_061"]}}
    conn._client.sapiGetAccountApiRestrictions = lambda: {
        "enableReading": True,
        "enableSpotAndMarginTrading": False,
    }
    res = conn.check_trading_access()
    assert res["can_read_account"] is True
    assert res["can_trade"] is False
    assert res["ok"] is False
    assert "Spot" in res["detail"]


def test_access_key_with_spot_trading_can_trade():
    conn = _live_conn_with_creds()
    conn._client.fetch_time = lambda: 123
    conn._client.fetch_balance = lambda: {"info": {"permissions": ["TRD_GRP_061"]}}
    conn._client.sapiGetAccountApiRestrictions = lambda: {
        "enableReading": True,
        "enableSpotAndMarginTrading": True,
    }
    res = conn.check_trading_access()
    assert res["can_trade"] is True
    assert res["ok"] is True


# __MORE_KEY_TESTS__


def test_access_key_restrictions_override_account_permissions():
    # Even when the account reports plain "SPOT", a read-only KEY must still be
    # reported as unable to trade — the key-level signal is authoritative.
    conn = _live_conn_with_creds()
    conn._client.fetch_time = lambda: 123
    conn._client.fetch_balance = lambda: {"info": {"permissions": ["SPOT"]}}
    conn._client.sapiGetAccountApiRestrictions = lambda: {
        "enableSpotAndMarginTrading": False,
    }
    res = conn.check_trading_access()
    assert res["can_trade"] is False
    assert res["ok"] is False


def test_access_falls_back_to_permissions_when_apirestrictions_errors():
    # If the key-restrictions endpoint is unavailable (disabled/region-blocked),
    # fall back to the account's reported permissions rather than hard-failing.
    conn = _live_conn_with_creds()
    conn._client.fetch_time = lambda: 123
    conn._client.fetch_balance = lambda: {"info": {"permissions": ["SPOT"]}}

    def boom():
        raise ccxt.ExchangeError("apiRestrictions disabled")

    conn._client.sapiGetAccountApiRestrictions = boom
    res = conn.check_trading_access()
    assert res["can_trade"] is True
    assert res["ok"] is True
