"""API smoke tests using FastAPI's TestClient (no network, no live server).

Multi-user mode: every protected endpoint requires a Bearer token, so the
fixtures sign up an admin (auto-licensed) and attach the token to the client.
Exchange-dependent endpoints (ticker/ohlcv/backtest/train) are not exercised
here because they require Binance connectivity; those are covered by unit tests
on the underlying modules.
"""
from __future__ import annotations

import os

os.environ.setdefault("TRADING_MODE", "paper")

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app

ADMIN_EMAIL = "admin@example.com"
ADMIN_PASSWORD = "supersecret123"


@pytest.fixture(scope="module")
def client():
    from app.database import init_db

    # Enable multi-user auth on the cached settings singleton. Env overrides may
    # not take effect (config is import-cached), so we set attributes directly.
    s = get_settings()
    s.secret_key = "unit-test-secret-key"
    s.auto_license_new_users = True  # signups start licensed for these tests
    s.admin_email = ADMIN_EMAIL
    s.rate_limit_enabled = False  # don't throttle the many signups in this suite

    init_db()  # ensure tables exist regardless of lifespan ordering
    with TestClient(app) as c:
        # First user matching admin_email becomes the licensed admin.
        r = c.post(
            "/api/auth/signup",
            json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        )
        if r.status_code == 409:
            r = c.post(
                "/api/auth/login",
                json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
            )
        token = r.json()["access_token"]
        c.headers.update({"Authorization": f"Bearer {token}"})
        yield c


def _webhook_path(client) -> str:
    return client.get("/api/auth/me").json()["webhook_path"]


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_requires_auth(client):
    # A bare request with no bearer token must be rejected.
    r = TestClient(app).get("/api/status")
    assert r.status_code == 401


def test_me_shape(client):
    body = client.get("/api/auth/me").json()
    assert body["email"] == ADMIN_EMAIL
    assert body["role"] == "admin"
    assert body["license_status"] == "active"
    assert body["webhook_path"].startswith("/api/webhook/tradingview/")


def test_login_bad_password(client):
    r = client.post(
        "/api/auth/login", json={"email": ADMIN_EMAIL, "password": "wrong"}
    )
    assert r.status_code == 401


def test_status_shape(client):
    r = client.get("/api/status")
    assert r.status_code == 200
    body = r.json()
    assert body["trading_mode"] == "paper"
    assert "equity" in body and "open_positions" in body


def test_exchange_access_shape(client):
    r = client.get("/api/exchange/access")
    assert r.status_code == 200
    body = r.json()
    for key in ("ok", "can_read_public", "can_read_account", "can_trade", "detail"):
        assert key in body
    assert body["ok"] is False
    assert isinstance(body["detail"], str) and body["detail"]


def test_webhook_unknown_token(client):
    r = client.post(
        "/api/webhook/tradingview/nope-not-a-real-token",
        content=b'{"action":"buy","symbol":"BTC/USDT","amount":0.01}',
    )
    assert r.status_code == 404


def test_webhook_rejects_malformed(client):
    path = _webhook_path(client)
    r = client.post(path, content=b"not json")
    assert r.status_code == 400


def test_bot_start_stop(client):
    assert client.post("/api/bot/stop").json()["running"] is False
    assert client.post("/api/bot/start").json()["running"] is True
    assert client.post("/api/bot/invalid").status_code == 400


def test_settings_roundtrip(client):
    r = client.patch(
        "/api/settings", json={"max_open_positions": 7, "risk_per_trade_pct": 2.5}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["max_open_positions"] == 7
    assert body["risk_per_trade_pct"] == 2.5
    assert body["webhook_path"].startswith("/api/webhook/tradingview/")


def test_settings_validation(client):
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
    # Force the current user's engine AI off so the fallback path is exercised
    # regardless of any real key in the environment.
    from app.usermgr import get_manager
    from app.database import SessionLocal
    from app.models import User
    from sqlalchemy import select

    db = SessionLocal()
    try:
        user = db.scalars(select(User).where(User.email == ADMIN_EMAIL)).first()
        engine = get_manager().get(db, user)
        engine.ai._settings.ai_api_key = ""
    finally:
        db.close()
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


# ---- multi-user, licensing & admin ---------------------------------


def _signup(client, email, password="password123"):
    return client.post(
        "/api/auth/signup", json={"email": email, "password": password}
    )


def test_admin_can_list_and_license_users(client):
    # Create a second user (tolerate re-runs against the persistent dev DB),
    # then flip their licence via the admin endpoint.
    r = _signup(client, "trader1@example.com")
    assert r.status_code in (200, 409)
    users = client.get("/api/admin/users").json()
    target = next(u for u in users if u["email"] == "trader1@example.com")

    revoke = client.patch(
        f"/api/admin/users/{target['id']}/license", json={"status": "revoked"}
    )
    assert revoke.status_code == 200
    assert revoke.json()["license_status"] == "revoked"

    grant = client.patch(
        f"/api/admin/users/{target['id']}/license", json={"status": "active"}
    )
    assert grant.status_code == 200
    assert grant.json()["license_status"] == "active"
    assert grant.json()["licensed_at"] is not None


def test_non_admin_forbidden_from_admin_routes(client):
    _signup(client, "trader2@example.com", "password123")
    login = client.post(
        "/api/auth/login",
        json={"email": "trader2@example.com", "password": "password123"},
    )
    token = login.json()["access_token"]
    r = TestClient(app).get(
        "/api/admin/users", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 403


def test_pending_user_cannot_trade(client):
    # Temporarily require admin approval so this signup is PENDING.
    s = get_settings()
    s.auto_license_new_users = False
    try:
        _signup(client, "pending@example.com", "password123")
    finally:
        s.auto_license_new_users = True
    login = client.post(
        "/api/auth/login",
        json={"email": "pending@example.com", "password": "password123"},
    )
    token = login.json()["access_token"]
    hdr = {"Authorization": f"Bearer {token}"}
    tc = TestClient(app)
    # Pending users can see their own status but not place orders.
    assert tc.get("/api/auth/me", headers=hdr).json()["license_status"] == "pending"
    r = tc.post(
        "/api/order",
        headers=hdr,
        json={"action": "buy", "symbol": "BTC/USDT", "amount": 0.01},
    )
    assert r.status_code == 403


def test_trades_isolated_per_user(client):
    # Admin places a paper order; a fresh user must not see it.
    order = client.post(
        "/api/order",
        json={"action": "buy", "symbol": "BTC/USDT", "amount": 0.01},
    )
    assert order.status_code == 200
    _signup(client, "trader3@example.com", "password123")
    login = client.post(
        "/api/auth/login",
        json={"email": "trader3@example.com", "password": "password123"},
    )
    token = login.json()["access_token"]
    other = TestClient(app).get(
        "/api/trades", headers={"Authorization": f"Bearer {token}"}
    )
    assert other.status_code == 200
    assert other.json() == []


def test_duplicate_signup_rejected(client):
    _signup(client, "dup-check@example.com")
    assert _signup(client, "dup-check@example.com").status_code == 409


def test_signup_weak_password_rejected(client):
    r = client.post(
        "/api/auth/signup", json={"email": "weak@example.com", "password": "short"}
    )
    assert r.status_code == 422
