"""Tests for the training / parameter-optimisation module."""
from __future__ import annotations

import pandas as pd

from app.learn import train


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


def _trending_prices(n: int = 300) -> list[float]:
    # A wavy uptrend so crossovers actually fire and some configs beat others.
    import math

    return [100 + i * 0.5 + 8 * math.sin(i / 6.0) for i in range(n)]


def test_train_ma_cross_returns_best():
    report = train(_candles(_trending_prices()), "ma_cross", symbol="BTC/USDT")
    assert report.tested > 0
    assert report.best is not None
    # fast < slow constraint must hold for the chosen params.
    assert report.best.params["fast"] < report.best.params["slow"]
    assert report.best.num_trades > 0


def test_train_leaderboard_sorted_by_score():
    report = train(_candles(_trending_prices()), "ma_cross")
    scores = [c.score for c in report.leaderboard]
    assert scores == sorted(scores, reverse=True)


def test_train_flat_market_has_no_best():
    # Flat market -> no strategy trades -> best must be None, not a do-nothing win.
    report = train(_candles([100.0] * 200), "ma_cross")
    assert report.best is None
    assert report.leaderboard == []


def test_train_uses_holdout_split_by_default():
    # With enough candles, the optimiser fits in-sample and validates out-of-sample.
    report = train(_candles(_trending_prices(300)), "ma_cross")
    assert report.train_fraction < 1.0
    assert report.best is not None
    # Out-of-sample metrics must be populated when a split is used.
    assert report.best.validation_return_pct is not None
    assert report.best.overfit_gap_pct is not None


def test_train_small_dataset_skips_split_with_warning():
    # Too few candles for a meaningful split -> full-dataset fit + warning.
    report = train(_candles(_trending_prices(80)), "ma_cross")
    assert report.train_fraction == 1.0
    if report.best is not None:
        assert report.best.validation_return_pct is None
    assert report.warning is not None


def test_train_split_can_be_disabled():
    report = train(_candles(_trending_prices(300)), "ma_cross", train_fraction=1.0)
    assert report.train_fraction == 1.0
    assert report.best is not None
    assert report.best.validation_return_pct is None


def test_train_rsi_grid_respects_bounds():
    report = train(_candles(_trending_prices()), "rsi")
    assert report.tested > 0
    for c in report.leaderboard:
        assert c.params["oversold"] < c.params["overbought"]


def test_train_unknown_strategy():
    import pytest

    with pytest.raises(ValueError):
        train(_candles(_trending_prices()), "does_not_exist")
