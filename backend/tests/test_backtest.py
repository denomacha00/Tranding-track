"""Backtester tests (deterministic, no network)."""
from __future__ import annotations

import pandas as pd

from app.backtest import run_backtest
from app.strategies import MovingAverageCrossStrategy


def _candles(prices: list[float]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "timestamp": range(len(prices)),
            "open": prices,
            "high": prices,
            "low": prices,
            "close": prices,
            "volume": [1.0] * len(prices),
        }
    )


def test_backtest_profits_on_uptrend():
    # Dip then strong uptrend: MA cross should buy low and ride up.
    prices = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] + list(range(2, 40))
    result = run_backtest(_candles(prices), MovingAverageCrossStrategy(3, 5),
                          starting_balance=1000, fee_pct=0.0, slippage_pct=0.0)
    assert result.num_trades >= 1
    assert result.ending_balance > result.starting_balance
    assert len(result.equity_curve) == len(prices)


def test_backtest_fees_and_slippage_reduce_return():
    prices = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] + list(range(2, 40))
    clean = run_backtest(_candles(prices), MovingAverageCrossStrategy(3, 5),
                         starting_balance=1000, fee_pct=0.0, slippage_pct=0.0)
    costed = run_backtest(_candles(prices), MovingAverageCrossStrategy(3, 5),
                          starting_balance=1000, fee_pct=0.1, slippage_pct=0.1)
    # Costs must eat into the return and be reported.
    assert costed.ending_balance < clean.ending_balance
    assert costed.total_fees > 0.0


def test_backtest_no_lookahead_executes_next_open():
    # Signal computed on a bar's close must NOT fill at that same close.
    # Distinct open != close lets us verify the fill uses the NEXT bar's open.
    df = pd.DataFrame(
        {
            "timestamp": range(8),
            "open": [10, 10, 10, 10, 20, 30, 40, 50],
            "high": [10, 10, 10, 10, 20, 30, 40, 50],
            "low": [10, 10, 10, 10, 20, 30, 40, 50],
            "close": [10, 10, 10, 15, 25, 35, 45, 55],
            "volume": [1.0] * 8,
        }
    )
    result = run_backtest(df, MovingAverageCrossStrategy(2, 3),
                          starting_balance=1000, fee_pct=0.0, slippage_pct=0.0)
    # Any entry price must match some bar's OPEN, never the close that triggered it.
    for t in result.trades:
        assert t.entry_price in set(df["open"].tolist())


def test_backtest_no_trades_flat_market():
    prices = [100.0] * 30
    result = run_backtest(_candles(prices), MovingAverageCrossStrategy(3, 5),
                          starting_balance=1000)
    assert result.num_trades == 0
    assert result.ending_balance == 1000
    assert result.max_drawdown_pct == 0.0


def test_backtest_drawdown_non_negative():
    prices = [10, 20, 5, 25, 3, 30, 2, 35]
    result = run_backtest(_candles(prices), MovingAverageCrossStrategy(2, 3),
                          starting_balance=1000)
    assert result.max_drawdown_pct >= 0.0
