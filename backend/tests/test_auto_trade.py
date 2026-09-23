"""Tests for autonomous trading, including multi-timeframe confirmation.

Use a fake connector so no network or credentials are needed: it returns a
different synthetic candle series per timeframe, letting us drive the analyzer
to a buy on one timeframe and a sell on another and assert the engine refuses
to trade against the higher timeframe.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.database import Base
from app.engine import TradingEngine
from app.models import Trade, TradeStatus


def _uptrend(n: int = 200) -> list[list[float]]:
    # timestamp, open, high, low, close, volume
    return [[i, 100 + i * 0.8, (100 + i * 0.8) * 1.001,
             (100 + i * 0.8) * 0.999, 100 + i * 0.8, 1.0] for i in range(n)]


def _downtrend(n: int = 200) -> list[list[float]]:
    return [[i, 300 - i * 0.8, (300 - i * 0.8) * 1.001,
             (300 - i * 0.8) * 0.999, 300 - i * 0.8, 1.0] for i in range(n)]


class FakeConnector:
    """Returns candles keyed by timeframe; supports paper execution only."""

    def __init__(self, by_timeframe: dict[str, list[list[float]]]):
        self._by_tf = by_timeframe
        self.has_credentials = False

    def reload(self, settings):  # noqa: D401 - matches connector interface
        pass

    def fetch_ohlcv(self, symbol, timeframe, limit):
        return self._by_tf[timeframe]

    def fetch_price(self, symbol):
        return float(self._by_tf["1h"][-1][4])


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        yield session
    finally:
        session.close()


def _engine(connector, **over) -> TradingEngine:
    base = dict(
        trading_mode="paper",
        max_open_positions=5,
        risk_per_trade_pct=1.0,
        daily_loss_limit_pct=50.0,
        default_stop_loss_pct=2.0,
        default_take_profit_pct=4.0,
        paper_starting_balance=10_000.0,
        min_signal_confidence=0.1,
    )
    base.update(over)
    return TradingEngine(Settings(**base), connector)


def test_confirm_timeframe_blocks_buy_when_higher_tf_bearish(db):
    # 1h says buy (uptrend) but 4h says sell (downtrend) -> buy must be blocked.
    conn = FakeConnector({"1h": _uptrend(), "4h": _downtrend()})
    eng = _engine(conn, auto_confirm_timeframe="4h")
    ok, msg = eng.auto_trade_symbol(db, "BTC/USDT", "1h")
    assert ok is False
    assert "blocked" in msg.lower()
    # No trade was opened.
    assert db.query(Trade).count() == 0


def test_confirm_timeframe_allows_buy_when_higher_tf_agrees(db):
    # Both timeframes bullish -> buy proceeds and a paper trade opens.
    conn = FakeConnector({"1h": _uptrend(), "4h": _uptrend()})
    eng = _engine(conn, auto_confirm_timeframe="4h")
    ok, msg = eng.auto_trade_symbol(db, "BTC/USDT", "1h")
    assert ok is True, msg
    open_trades = db.query(Trade).filter(
        Trade.status == TradeStatus.open.value
    ).all()
    assert len(open_trades) == 1
    assert open_trades[0].side == "buy"


def test_no_confirm_timeframe_uses_single_timeframe(db):
    # Disabled (blank) -> the higher timeframe is never consulted; 1h buy stands.
    conn = FakeConnector({"1h": _uptrend()})
    eng = _engine(conn, auto_confirm_timeframe="")
    ok, msg = eng.auto_trade_symbol(db, "BTC/USDT", "1h")
    assert ok is True, msg
    assert db.query(Trade).count() == 1
