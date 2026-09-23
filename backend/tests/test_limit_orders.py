"""Tests for resting limit orders and auto-healing live reconciliation.

All paper-mode / fake-connector based so no network or credentials are needed.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.database import Base
from app.engine import TradingEngine
from app.models import Trade, TradeStatus


class FakeConnector:
    """Paper connector with a mutable spot price and optional held balances."""

    def __init__(self, price: float = 100.0, held: dict | None = None,
                 has_credentials: bool = False):
        self._price = price
        self._held = held or {}
        self.has_credentials = has_credentials

    def reload(self, settings):
        pass

    def set_price(self, price: float):
        self._price = price

    def fetch_price(self, symbol):
        return self._price

    def fetch_ohlcv(self, symbol, timeframe, limit):
        return []

    def fetch_position_amounts(self):
        return dict(self._held)

    # Live-only hooks (unused in paper tests but present for interface parity).
    def normalize_amount(self, symbol, amount, price):
        return amount, None

    def create_market_order(self, symbol, side, amount):
        return {"id": "m1", "average": self._price}

    def create_limit_order(self, symbol, side, amount, price):
        return {"id": "l1"}

    def create_stop_loss_order(self, symbol, side, amount, stop_price):
        return None

    def cancel_order(self, order_id, symbol):
        pass

    def fetch_order(self, order_id, symbol):
        return None


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


def test_limit_order_rests_pending_and_reserves_balance(db):
    conn = FakeConnector(price=100.0)
    eng = _engine(conn)
    ok, msg, trade = eng.execute_signal(
        db, action="buy", symbol="BTC/USDT", amount=1.0,
        stop_loss=None, take_profit=None, source="manual", limit_price=90.0,
    )
    assert ok, msg
    assert trade.status == TradeStatus.pending.value
    assert trade.order_type == "limit"
    assert trade.limit_price == 90.0
    # Notional reserved at the LIMIT price (1 * 90).
    assert eng.paper_balance == pytest.approx(10_000 - 90.0)


def test_pending_buy_does_not_fill_until_price_crosses(db):
    conn = FakeConnector(price=100.0)
    eng = _engine(conn)
    eng.execute_signal(
        db, action="buy", symbol="BTC/USDT", amount=1.0,
        stop_loss=None, take_profit=None, source="manual", limit_price=90.0,
    )
    # Still above the limit -> no fill.
    filled = eng.check_pending_orders(db)
    assert filled == []
    assert db.query(Trade).filter(Trade.status == TradeStatus.pending.value).count() == 1


def test_pending_buy_fills_when_price_drops_to_limit(db):
    conn = FakeConnector(price=100.0)
    eng = _engine(conn)
    eng.execute_signal(
        db, action="buy", symbol="BTC/USDT", amount=1.0,
        stop_loss=None, take_profit=None, source="manual", limit_price=90.0,
    )
    conn.set_price(89.0)  # market fell through the limit
    filled = eng.check_pending_orders(db)
    assert len(filled) == 1
    t = db.query(Trade).one()
    assert t.status == TradeStatus.open.value
    assert t.entry_price == 90.0  # paper fills at the limit, not the market price
    # Auto SL/TP applied on fill.
    assert t.stop_loss is not None and t.take_profit is not None


def test_cancel_pending_returns_reserved_balance(db):
    conn = FakeConnector(price=100.0)
    eng = _engine(conn)
    _, _, trade = eng.execute_signal(
        db, action="buy", symbol="BTC/USDT", amount=1.0,
        stop_loss=None, take_profit=None, source="manual", limit_price=90.0,
    )
    assert eng.paper_balance == pytest.approx(10_000 - 90.0)
    ok, msg, t = eng.execute_signal(
        db, action="close", symbol="BTC/USDT", amount=None,
        stop_loss=None, take_profit=None, source="manual",
    )
    assert ok, msg
    assert t.status == TradeStatus.canceled.value
    # Full reservation returned.
    assert eng.paper_balance == pytest.approx(10_000.0)


def test_pending_order_blocks_second_order_same_symbol(db):
    conn = FakeConnector(price=100.0)
    eng = _engine(conn)
    eng.execute_signal(
        db, action="buy", symbol="BTC/USDT", amount=1.0,
        stop_loss=None, take_profit=None, source="manual", limit_price=90.0,
    )
    ok, msg, _ = eng.execute_signal(
        db, action="buy", symbol="BTC/USDT", amount=1.0,
        stop_loss=None, take_profit=None, source="manual", limit_price=80.0,
    )
    assert not ok
    assert "already" in msg.lower()


def test_pending_sell_fills_when_price_rises_to_limit(db):
    # A resting sell (long-only semantics still allow a manual sell-to-open here
    # for symmetry of the crossing logic) fills when price >= limit.
    conn = FakeConnector(price=100.0)
    eng = _engine(conn)
    eng.execute_signal(
        db, action="sell", symbol="ETH/USDT", amount=1.0,
        stop_loss=None, take_profit=None, source="manual", limit_price=110.0,
    )
    conn.set_price(105.0)
    assert eng.check_pending_orders(db) == []  # not yet
    conn.set_price(111.0)
    filled = eng.check_pending_orders(db)
    assert len(filled) == 1
    assert db.query(Trade).one().status == TradeStatus.open.value


# ---- auto-healing reconciliation ------------------------------------


def test_reconcile_closes_stale_long_when_exchange_empty(db):
    # DB thinks we hold 1 BTC long, but the exchange holds none -> auto-close.
    conn = FakeConnector(price=95.0, held={}, has_credentials=True)
    eng = _engine(conn, trading_mode="live")
    db.add(Trade(symbol="BTC/USDT", side="buy", amount=1.0, entry_price=100.0,
                 status=TradeStatus.open.value, mode="live"))
    db.commit()
    eng._reconcile_live_positions(db)
    t = db.query(Trade).one()
    assert t.status == TradeStatus.closed.value
    assert t.exit_price == 95.0
    # Long closed below entry -> realized loss recorded.
    assert t.pnl == pytest.approx(-5.0)


def test_reconcile_adjusts_amount_on_partial_mismatch(db):
    # Exchange holds 0.4 of a 1.0 DB long (well above the 1% dust threshold) ->
    # shrink the tracked amount rather than closing.
    conn = FakeConnector(price=100.0, held={"BTC": 0.4}, has_credentials=True)
    eng = _engine(conn, trading_mode="live")
    db.add(Trade(symbol="BTC/USDT", side="buy", amount=1.0, entry_price=100.0,
                 status=TradeStatus.open.value, mode="live"))
    db.commit()
    eng._reconcile_live_positions(db)
    t = db.query(Trade).one()
    assert t.status == TradeStatus.open.value
    assert t.amount == pytest.approx(0.4)


def test_reconcile_leaves_matching_position_untouched(db):
    conn = FakeConnector(price=100.0, held={"BTC": 1.0}, has_credentials=True)
    eng = _engine(conn, trading_mode="live")
    db.add(Trade(symbol="BTC/USDT", side="buy", amount=1.0, entry_price=100.0,
                 status=TradeStatus.open.value, mode="live"))
    db.commit()
    eng._reconcile_live_positions(db)
    t = db.query(Trade).one()
    assert t.status == TradeStatus.open.value
    assert t.amount == pytest.approx(1.0)
