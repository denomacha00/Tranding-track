"""Execution-path tests: live short-sell guard, live close fill price, and
honest paper equity (free cash + open-position market value).

All fake-connector based — no network or credentials required.
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
    """Minimal connector: fixed spot price and a configurable market-order fill.

    ``market_fill`` lets a test make the executed average differ from the spot
    ticker, so we can prove a live close books PnL at the fill, not the quote.
    """

    def __init__(self, price: float = 100.0, has_credentials: bool = False,
                 market_fill: float | None = None):
        self._price = price
        self._market_fill = market_fill
        self.has_credentials = has_credentials

    @property
    def connected(self) -> bool:
        return True

    def reload(self, settings):
        pass

    def set_price(self, price: float):
        self._price = price

    def fetch_price(self, symbol):
        return self._price

    def fetch_ohlcv(self, symbol, timeframe, limit):
        return []

    def fetch_position_amounts(self):
        return {}

    def fetch_balance(self, quote="USDT"):
        return None

    def normalize_amount(self, symbol, amount, price):
        return amount, None

    def create_market_order(self, symbol, side, amount):
        avg = self._market_fill if self._market_fill is not None else self._price
        return {"id": "m1", "average": avg}

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


def test_live_sell_to_open_is_rejected(db):
    # Spot can't short: a live SELL with no long to close must be refused
    # before any order is attempted, rather than dumping unrelated holdings.
    conn = FakeConnector(price=100.0, has_credentials=True)
    eng = _engine(conn, trading_mode="live")
    ok, msg, trade = eng.execute_signal(
        db, action="sell", symbol="BTC/USDT", amount=1.0,
        stop_loss=None, take_profit=None, source="manual",
    )
    assert not ok
    assert "short" in msg.lower() or "not supported" in msg.lower()
    assert trade is None
    assert db.query(Trade).count() == 0


def test_paper_sell_to_open_still_allowed(db):
    # Paper keeps sell-to-open for symmetry/backtest-style exploration.
    conn = FakeConnector(price=100.0)
    eng = _engine(conn)  # paper
    ok, msg, trade = eng.execute_signal(
        db, action="sell", symbol="BTC/USDT", amount=1.0,
        stop_loss=None, take_profit=None, source="manual",
    )
    assert ok, msg
    assert trade is not None
    assert trade.status == TradeStatus.open.value


def test_live_close_books_pnl_at_fill_not_ticker(db):
    # Ticker says 110 but the market-close actually fills at 108; PnL must use
    # the fill (the money that changed hands), not the stale quote.
    conn = FakeConnector(price=110.0, has_credentials=True, market_fill=108.0)
    eng = _engine(conn, trading_mode="live")
    db.add(Trade(symbol="BTC/USDT", side="buy", amount=1.0, entry_price=100.0,
                 status=TradeStatus.open.value, mode="live"))
    db.commit()
    ok, msg, trade = eng.execute_signal(
        db, action="close", symbol="BTC/USDT", amount=None,
        stop_loss=None, take_profit=None, source="manual",
    )
    assert ok, msg
    assert trade.exit_price == pytest.approx(108.0)
    assert trade.pnl == pytest.approx(8.0)  # (108 - 100) * 1, not (110 - 100)


def test_paper_equity_counts_open_position_value(db):
    # Honest equity = free cash + open position's market value. Buy 1 @ 100
    # from 10k; price rises to 110: cash 9,900 + position worth 110 = 10,010.
    conn = FakeConnector(price=100.0)
    eng = _engine(conn)  # paper, 10k start
    ok, msg, _ = eng.execute_signal(
        db, action="buy", symbol="BTC/USDT", amount=1.0,
        stop_loss=None, take_profit=None, source="manual",
    )
    assert ok, msg
    assert eng.paper_balance == pytest.approx(9_900.0)  # 100 notional debited
    conn.set_price(110.0)
    st = eng.status(db)
    assert st["balance"] == pytest.approx(9_900.0)
    assert st["unrealized_pnl"] == pytest.approx(10.0)
    assert st["equity"] == pytest.approx(10_010.0)
    # Sanity: equity == starting balance + unrealized gain.
    assert st["equity"] == pytest.approx(10_000.0 + st["unrealized_pnl"])
