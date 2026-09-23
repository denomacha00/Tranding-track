"""API smoke tests using FastAPI's TestClient (no network, no live server).

Exchange-dependent endpoints (ticker/ohlcv/backtest/train) are not exercised
here because they require Binance connectivity; those are covered by unit tests
on the underlying modules. These tests verify routing, validation, the
TradingView webhook security, manual orders in paper mode, and settings.
"""
from __future__ import annotations

import os

# Note: app.database builds its engine at import time from DATABASE_URL, and
# other test modules import it first during collection, so overriding the env
# here would not take effect. We therefore use the default file-based SQLite DB
# and just ensure the schema exists before exercising the API.
os.environ.setdefault("TRADINGVIEW_WEBHOOK_SECRET", "test-secret")
os.environ.setdefault("TRADING_MODE", "paper")

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app


@pytest.fixture(scope="module")
def client():
    from app.database import init_db

    init_db()  # ensure tables exist regardless of lifespan ordering
    with TestClient(app) as c:
        yield c


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_status_shape(client):
    r = client.get("/api/status")
    assert r.status_code == 200
    body = r.json()
    assert body["trading_mode"] == "paper"
    assert "equity" in body and "open_positions" in body


def test_webhook_rejects_bad_secret(client):
    r = client.post(
        "/api/webhook/tradingview",
        content=b'{"secret":"wrong","action":"buy","symbol":"BTC/USDT","amount":0.01}',
    )
    assert r.status_code == 401


def test_webhook_rejects_malformed(client):
    r = client.post("/api/webhook/tradingview", content=b"not json")
    assert r.status_code == 400


def test_bot_start_stop(client):
    assert client.post("/api/bot/stop").json()["running"] is False
    assert client.post("/api/bot/start").json()["running"] is True
    assert client.post("/api/bot/invalid").status_code == 400


def test_settings_roundtrip(client):
    r = client.patch("/api/settings", json={"max_open_positions": 7, "risk_per_trade_pct": 2.5})
    assert r.status_code == 200
    body = r.json()
    assert body["max_open_positions"] == 7
    assert body["risk_per_trade_pct"] == 2.5
    assert body["webhook_path"] == "/api/webhook/tradingview"


def test_settings_validation(client):
    # risk % out of allowed range must be rejected by pydantic.
    r = client.patch("/api/settings", json={"risk_per_trade_pct": 999})
    assert r.status_code == 422


def test_strategies_listed(client):
    r = client.get("/api/strategies")
    assert r.status_code == 200
    names = {s["name"] for s in r.json()}
    assert {"ma_cross", "rsi"}.issubset(names)


def test_ai_ask_requires_question(client):
    r = client.post("/api/ai/ask", json={})
    assert r.status_code == 400


def test_ai_ask_without_key_falls_back(client):
    # No AI_API_KEY configured -> graceful message, ai_enabled False, no crash.
    r = client.post("/api/ai/ask", json={"question": "what is the trend?"})
    assert r.status_code == 200
    body = r.json()
    assert body["ai_enabled"] is False
    assert "not configured" in body["answer"].lower()


def test_settings_expose_autonomous_fields(client):
    body = client.get("/api/settings").json()
    for key in ("auto_trade_enabled", "auto_symbols", "auto_timeframe",
                "min_signal_confidence", "ai_enabled"):
        assert key in body


def test_settings_update_autonomous(client):
    r = client.patch(
        "/api/settings",
        json={"auto_trade_enabled": True, "auto_symbols": "BTC/USDT,ETH/USDT",
              "min_signal_confidence": 0.6},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["auto_trade_enabled"] is True
    assert body["min_signal_confidence"] == 0.6
    # confidence out of [0,1] must be rejected.
    assert client.patch("/api/settings", json={"min_signal_confidence": 5}).status_code == 422


def test_settings_expose_new_fields(client):
    body = client.get("/api/settings").json()
    for key in ("trailing_stop_pct", "notifications_enabled", "api_key_set"):
        assert key in body


def test_trailing_stop_validation(client):
    assert client.patch("/api/settings", json={"trailing_stop_pct": 1.5}).status_code == 200
    assert client.patch("/api/settings", json={"trailing_stop_pct": 500}).status_code == 422


def test_trades_empty_initially(client):
    r = client.get("/api/trades")
    assert r.status_code == 200
    assert isinstance(r.json(), list)
