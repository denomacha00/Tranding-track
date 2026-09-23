"""Tests for restart-safe state persistence and exchange amount normalization."""
from __future__ import annotations

from app.config import Settings
from app.database import SessionLocal, init_db
from app.exchange import BinanceConnector
from app.models import KeyValue
from app.state import (
    PAPER_BALANCE_KEY,
    SETTINGS_KEY,
    load_paper_balance,
    load_settings_overrides,
    save_paper_balance,
    save_settings_overrides,
)


def _clear_kv():
    """Remove KV rows so persistence tests don't leak state into other tests
    (they share the default file DB, and the app restores overrides on start)."""
    db = SessionLocal()
    try:
        for key in (SETTINGS_KEY, PAPER_BALANCE_KEY):
            row = db.get(KeyValue, key)
            if row is not None:
                db.delete(row)
        db.commit()
    finally:
        db.close()


def test_kv_settings_roundtrip():
    init_db()
    db = SessionLocal()
    try:
        save_settings_overrides(db, {"trading_mode": "live", "max_open_positions": 9})
        loaded = load_settings_overrides(db)
        assert loaded["trading_mode"] == "live"
        assert loaded["max_open_positions"] == 9
    finally:
        db.close()
        _clear_kv()


def test_kv_paper_balance_roundtrip_and_default():
    init_db()
    db = SessionLocal()
    try:
        # Default returned when nothing saved yet for a fresh key.
        save_paper_balance(db, 12345.67)
        assert load_paper_balance(db, 10_000.0) == 12345.67
    finally:
        db.close()
        _clear_kv()


def test_normalize_amount_passthrough_without_markets():
    # No credentials/markets -> pass through unchanged, no error.
    conn = BinanceConnector(Settings(binance_api_key="", binance_api_secret=""))
    conn._markets = {}  # force empty metadata
    amt, err = conn.normalize_amount("BTC/USDT", 0.01, 50_000.0)
    assert err is None
    assert amt == 0.01


def test_normalize_amount_rejects_nonpositive():
    conn = BinanceConnector(Settings())
    amt, err = conn.normalize_amount("BTC/USDT", 0.0, 50_000.0)
    assert err is not None
    assert amt == 0.0


def test_normalize_amount_enforces_min_notional():
    conn = BinanceConnector(Settings())
    # Inject fake market metadata with a min cost of 10 USDT.
    conn._markets = {
        "BTC/USDT": {
            "limits": {"amount": {"min": 0.0}, "cost": {"min": 10.0}},
        }
    }
    # 0.0001 BTC * 50000 = 5 USDT -> below min notional of 10.
    amt, err = conn.normalize_amount("BTC/USDT", 0.0001, 50_000.0)
    assert err is not None
    assert "cost" in err.lower()
