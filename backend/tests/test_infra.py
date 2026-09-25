"""Unit tests for previously-untested-but-wired infrastructure.

Covers the security primitives (password/JWT/Fernet/licence-key hashing), the
optional Telegram notifier, structured JSON logging, and the additive-migration
path. All pure/in-process — no network, no live server, no real DB.
"""
from __future__ import annotations

import json
import logging

import ccxt
import pytest

from app.config import Settings
from app.logging_config import JsonFormatter, configure_logging
from app.notifier import Notifier
from app.security import (
    create_access_token,
    decode_access_token,
    decrypt_secret,
    encrypt_secret,
    hash_license_key,
    hash_password,
    new_license_key,
    new_webhook_token,
    secrets_enabled,
    verify_password,
)

KEY = "unit-test-secret-key-abc123"


# ---- password hashing (PBKDF2) ---------------------------------------


def test_password_hash_roundtrip_and_rejects_wrong():
    h = hash_password("correct horse battery")
    assert h.startswith("pbkdf2_sha256$")
    assert verify_password("correct horse battery", h) is True
    assert verify_password("wrong-password", h) is False


def test_password_hash_is_salted_unique():
    assert hash_password("samepassword") != hash_password("samepassword")


def test_verify_password_malformed_returns_false():
    assert verify_password("x", "not-a-valid-hash") is False


def test_hash_password_rejects_short():
    with pytest.raises(ValueError):
        hash_password("short")


# ---- JWT (HS256) ------------------------------------------------------


def test_jwt_roundtrip_carries_claims():
    tok = create_access_token(KEY, user_id=7, email="a@b.co", role="user", ttl_minutes=60)
    payload = decode_access_token(KEY, tok)
    assert payload is not None
    assert payload["sub"] == "7"
    assert payload["email"] == "a@b.co"
    assert payload["role"] == "user"


def test_jwt_rejects_tampered_or_wrong_secret():
    tok = create_access_token(KEY, user_id=1, email="a@b.co", role="user", ttl_minutes=60)
    assert decode_access_token(KEY, tok + "x") is None       # tampered signature
    assert decode_access_token("other-secret", tok) is None  # wrong signing key
    assert decode_access_token(KEY, "a.b") is None            # malformed


def test_jwt_rejects_expired():
    tok = create_access_token(KEY, user_id=1, email="a@b.co", role="user", ttl_minutes=-1)
    assert decode_access_token(KEY, tok) is None


def test_jwt_requires_secret():
    with pytest.raises(ValueError):
        create_access_token("", user_id=1, email="a@b.co", role="user", ttl_minutes=60)
    assert decode_access_token("", "anything") is None


# ---- Fernet secret encryption (key derived from SECRET_KEY) ----------


def test_encrypt_decrypt_roundtrip():
    ct = encrypt_secret(KEY, "binance-api-secret")
    assert ct != "binance-api-secret"
    assert decrypt_secret(KEY, ct) == "binance-api-secret"


def test_decrypt_wrong_key_or_garbage_returns_none():
    ct = encrypt_secret(KEY, "s3cr3t")
    assert decrypt_secret("another-secret-key", ct) is None  # wrong key -> None, no raise
    assert decrypt_secret(KEY, "not-a-token") is None
    assert decrypt_secret(KEY, "") is None


def test_secrets_enabled_reflects_key_presence():
    assert secrets_enabled(KEY) is True
    assert secrets_enabled("") is False


# ---- licence keys & webhook tokens -----------------------------------


def test_license_key_prefix_and_hash_is_stable_and_unique():
    k = new_license_key()
    assert k.startswith("TT-")
    assert hash_license_key(k) == hash_license_key(f"  {k}  ")  # trims whitespace
    assert hash_license_key(k) != hash_license_key(new_license_key())


def test_webhook_tokens_are_unique():
    assert new_webhook_token() != new_webhook_token()


# ---- Telegram notifier (optional; never breaks the trading path) -----


def _settings(**over) -> Settings:
    s = Settings()
    for k, v in over.items():
        setattr(s, k, v)
    return s


def test_notifier_disabled_without_config():
    n = Notifier(_settings(telegram_bot_token="", telegram_chat_id=""))
    assert n.enabled is False
    assert n.send("hello") is False  # disabled -> no network attempted


def test_notifier_enabled_when_fully_configured():
    n = Notifier(_settings(telegram_bot_token="123:abc", telegram_chat_id="42"))
    assert n.enabled is True


def test_notifier_send_never_raises_on_failure(monkeypatch):
    class _BoomClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def post(self, *a, **k):
            raise RuntimeError("network down")

    monkeypatch.setattr("app.notifier.httpx.Client", _BoomClient)
    n = Notifier(_settings(telegram_bot_token="123:abc", telegram_chat_id="42"))
    assert n.send("will fail") is False  # swallowed -> False, never raises


# ---- structured JSON logging -----------------------------------------


@pytest.fixture
def _restore_root_logging():
    root = logging.getLogger()
    saved_handlers = list(root.handlers)
    saved_level = root.level
    try:
        yield
    finally:
        for h in list(root.handlers):
            root.removeHandler(h)
        for h in saved_handlers:
            root.addHandler(h)
        root.setLevel(saved_level)


def test_json_formatter_emits_valid_json_with_fields():
    rec = logging.LogRecord("app.x", logging.INFO, __file__, 10, "hello %s", ("world",), None)
    obj = json.loads(JsonFormatter().format(rec))
    assert obj["level"] == "INFO"
    assert obj["logger"] == "app.x"
    assert obj["message"] == "hello world"
    assert "time" in obj


def test_json_formatter_includes_extras_and_exception():
    import sys

    try:
        raise ValueError("boom")
    except ValueError:
        rec = logging.LogRecord("app.y", logging.ERROR, __file__, 20, "failed", (), sys.exc_info())
    rec.order_id = "OID-7"  # a structured extra=
    obj = json.loads(JsonFormatter().format(rec))
    assert obj["order_id"] == "OID-7"
    assert "ValueError: boom" in obj["exception"]


def test_configure_logging_switches_and_is_idempotent(_restore_root_logging):
    configure_logging("json", "DEBUG")
    root = logging.getLogger()
    assert root.level == logging.DEBUG
    assert len(root.handlers) == 1
    assert isinstance(root.handlers[0].formatter, JsonFormatter)
    # Re-configure: still exactly one handler (replaced, not stacked).
    configure_logging("text", "INFO")
    assert root.level == logging.INFO
    assert len(root.handlers) == 1
    assert not isinstance(root.handlers[0].formatter, JsonFormatter)


# ---- additive migrations (add missing columns to an existing DB) -----


def test_additive_migrations_add_missing_columns(tmp_path, monkeypatch):
    from sqlalchemy import create_engine, inspect, text

    import app.database as db

    eng = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}", future=True)
    # A pre-v2 database: old tables missing the newer columns.
    with eng.begin() as conn:
        conn.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(255))"))
        conn.execute(text("CREATE TABLE trades (id INTEGER PRIMARY KEY, symbol VARCHAR(20))"))
    monkeypatch.setattr(db, "engine", eng)

    db._apply_additive_migrations()

    insp = inspect(eng)
    user_cols = {c["name"] for c in insp.get_columns("users")}
    trade_cols = {c["name"] for c in insp.get_columns("trades")}
    assert {"username", "license_expires_at"} <= user_cols
    assert {"user_id", "order_type", "limit_price", "stop_order_id"} <= trade_cols
    assert "ix_users_username" in {i["name"] for i in insp.get_indexes("users")}

    # Idempotent: a second run is a no-op (no duplicate-column crash).
    db._apply_additive_migrations()


# ---- exchange retry: permanent geo-block (HTTP 451) fails fast -------


def test_geo_block_detected_by_message():
    from app.exchange import _is_geo_block

    assert _is_geo_block(Exception("binance GET ... 451 restricted location")) is True
    assert _is_geo_block(Exception("... 'b. Eligibility' in terms")) is True
    assert _is_geo_block(Exception("plain request timeout")) is False


def test_with_retry_does_not_retry_geo_block():
    import app.exchange as ex

    calls = {"n": 0}

    def boom():
        calls["n"] += 1
        raise ccxt.ExchangeNotAvailable("binance GET ... 451 restricted location")

    with pytest.raises(ccxt.ExchangeNotAvailable):
        ex._with_retry(boom, attempts=3, base_delay=0.0)
    assert calls["n"] == 1  # a permanent block is tried once, not 3x


def test_with_retry_retries_true_transient_error():
    import app.exchange as ex

    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        raise ccxt.NetworkError("temporary blip")

    with pytest.raises(ccxt.NetworkError):
        ex._with_retry(flaky, attempts=3, base_delay=0.0)
    assert calls["n"] == 3  # a real transient error uses the full retry budget


# ---- public market-data fallback (works despite a geo-blocked primary) ----


class _FakeExchange:
    """Minimal stand-in for a ccxt client — no network, records call counts."""

    def __init__(self, *, ticker=None, ohlcv=None, raises: Exception | None = None):
        self._ticker = ticker
        self._ohlcv = ohlcv
        self._raises = raises
        self.ticker_calls = 0
        self.ohlcv_calls = 0

    def fetch_ticker(self, symbol):
        self.ticker_calls += 1
        if self._raises is not None:
            raise self._raises
        return self._ticker

    def fetch_ohlcv(self, symbol, timeframe="1h", limit=200):
        self.ohlcv_calls += 1
        if self._raises is not None:
            raise self._raises
        return self._ohlcv


def _connector(**over):
    """A BinanceConnector with no real fallback wired (we inject fakes)."""
    from app.exchange import BinanceConnector

    over.setdefault("market_data_fallback_id", "")
    return BinanceConnector(_settings(**over))


def test_build_data_fallback_selects_configured_venue():
    conn = _connector(market_data_fallback_id="kucoin", exchange_id="binance")
    assert conn._fallback_id == "kucoin"
    assert conn._fallback_client is not None  # constructed, keyless, offline


def test_build_data_fallback_disabled_when_empty_or_same_as_primary():
    assert _connector(market_data_fallback_id="")._fallback_client is None
    same = _connector(market_data_fallback_id="binance", exchange_id="binance")
    assert same._fallback_client is None


def test_market_data_falls_back_on_geo_block():
    conn = _connector()
    conn._exchange_id = "binance"
    conn._client = _FakeExchange(raises=ccxt.ExchangeNotAvailable("451 restricted location"))
    conn._fallback_client = _FakeExchange(
        ticker={"last": 123.0, "bid": 122.0, "ask": 124.0}, ohlcv=[[0, 1, 2, 0.5, 1.5, 10]]
    )
    conn._fallback_id = "kucoin"

    t = conn.fetch_ticker("BTC/USDT")
    assert t["last"] == 123.0
    assert conn.last_data_source == "kucoin"  # honestly labelled as the fallback

    ohlcv = conn.fetch_ohlcv("BTC/USDT")
    assert ohlcv[0][4] == 1.5
    assert conn.last_data_source == "kucoin"


def test_market_data_uses_primary_when_healthy():
    conn = _connector()
    conn._exchange_id = "binance"
    conn._client = _FakeExchange(ticker={"last": 99.0})
    fallback = _FakeExchange(ticker={"last": 1.0})
    conn._fallback_client = fallback
    conn._fallback_id = "kucoin"

    t = conn.fetch_ticker("BTC/USDT")
    assert t["last"] == 99.0
    assert conn.last_data_source == "binance"
    assert fallback.ticker_calls == 0  # a healthy primary never touches the fallback


def test_market_data_bad_symbol_is_not_masked_by_fallback():
    conn = _connector()
    conn._client = _FakeExchange(raises=ccxt.BadSymbol("no such market"))
    fallback = _FakeExchange(ticker={"last": 1.0})
    conn._fallback_client = fallback
    conn._fallback_id = "kucoin"

    with pytest.raises(ccxt.BadSymbol):
        conn.fetch_ticker("NOPE/USDT")
    assert fallback.ticker_calls == 0  # a genuine data error surfaces, not hidden


def test_geo_block_without_fallback_reraises_honestly():
    conn = _connector()
    conn._client = _FakeExchange(raises=ccxt.ExchangeNotAvailable("451 restricted location"))
    conn._fallback_client = None
    with pytest.raises(ccxt.ExchangeNotAvailable):
        conn.fetch_ticker("BTC/USDT")  # no fallback -> the real 451 still surfaces
