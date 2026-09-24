"""Market analysis "brain": a transparent, multi-signal decision engine.

This is what makes Tranding-track *think* about the market instead of reacting to
a single crossover. It computes a panel of classic indicators — trend (EMA
stack), momentum (RSI + MACD), volatility (ATR / Bollinger width), and recent
return — then combines them into ONE confidence-scored verdict with human-readable
reasons for every component.

Design principles (why this is the honest way to be "smart"):
- Explainable, not a black box: every point in the score has a stated reason.
- Capital-preservation first: when signals disagree or volatility is extreme, it
  returns HOLD with low confidence rather than forcing a trade. "No trade" is a
  valid, often correct, decision — that is how you avoid losing money.
- Confidence-gated: callers should only act above a confidence threshold.
- No look-ahead: every indicator uses only data up to the evaluated bar, so it
  behaves identically in backtest, training and live.

An AI/LLM layer (see app/ai.py) can *narrate* this analysis, but the decision
itself is deterministic and testable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import pandas as pd

Verdict = Literal["buy", "sell", "hold"]


@dataclass
class Factor:
    """One analysed component and its contribution to the decision."""

    name: str
    signal: Verdict
    weight: float
    detail: str


@dataclass
class MarketAnalysis:
    symbol: str
    verdict: Verdict
    confidence: float  # 0..1
    score: float  # signed: >0 bullish, <0 bearish
    price: float
    factors: list[Factor] = field(default_factory=list)
    summary: str = ""

    def as_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "verdict": self.verdict,
            "confidence": round(self.confidence, 3),
            "score": round(self.score, 3),
            "price": self.price,
            "summary": self.summary,
            "factors": [
                {
                    "name": f.name,
                    "signal": f.signal,
                    "weight": f.weight,
                    "detail": f.detail,
                }
                for f in self.factors
            ],
        }


# ---- indicator helpers (no look-ahead) ------------------------------


def ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    # Wilder's smoothing (RMA) so RSI matches TradingView / standard charting
    # tools rather than a plain rolling mean (which diverges from the chart).
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss
    out = 100 - (100 / (1 + rs))
    out = out.mask((avg_loss == 0) & (avg_gain > 0), 100.0)
    out = out.mask((avg_gain == 0) & (avg_loss > 0), 0.0)
    out = out.mask((avg_gain == 0) & (avg_loss == 0), 50.0)
    return out


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    macd_line = ema(close, fast) - ema(close, slow)
    signal_line = ema(macd_line, signal)
    hist = macd_line - signal_line
    return macd_line, signal_line, hist


def atr(candles: pd.DataFrame, period: int = 14) -> pd.Series:
    high, low, close = candles["high"], candles["low"], candles["close"]
    prev_close = close.shift(1)
    tr = pd.concat(
        [(high - low), (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    ).max(axis=1)
    # Wilder's smoothing (RMA), matching TradingView's ATR.
    return tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


# ---- the analyser ---------------------------------------------------


MIN_BARS = 60


class MarketAnalyzer:
    """Weighs several independent signals into a single confident verdict."""

    def __init__(
        self,
        *,
        buy_threshold: float = 0.25,
        min_confidence: float = 0.4,
        max_volatility_pct: float = 8.0,
    ) -> None:
        # Score above +threshold => buy, below -threshold => sell, else hold.
        self.buy_threshold = buy_threshold
        # Below this confidence the verdict is forced to HOLD (preserve capital).
        self.min_confidence = min_confidence
        # If a single bar's ATR exceeds this % of price, stand aside.
        self.max_volatility_pct = max_volatility_pct

    def min_bars(self) -> int:
        return MIN_BARS

    def analyze(self, candles: pd.DataFrame, symbol: str = "") -> MarketAnalysis:
        price = float(candles["close"].iloc[-1]) if len(candles) else 0.0
        if len(candles) < MIN_BARS:
            return MarketAnalysis(
                symbol=symbol,
                verdict="hold",
                confidence=0.0,
                score=0.0,
                price=price,
                summary="Not enough data to analyse (need ≥ %d bars)." % MIN_BARS,
            )

        close = candles["close"]
        factors: list[Factor] = []

        # 1) Trend via EMA stack (fast>mid>slow = uptrend).
        ema_fast = ema(close, 9).iloc[-1]
        ema_mid = ema(close, 21).iloc[-1]
        ema_slow = ema(close, 50).iloc[-1]
        if ema_fast > ema_mid > ema_slow:
            factors.append(Factor("trend", "buy", 0.30, "EMA 9>21>50 (uptrend)"))
        elif ema_fast < ema_mid < ema_slow:
            factors.append(Factor("trend", "sell", 0.30, "EMA 9<21<50 (downtrend)"))
        else:
            factors.append(Factor("trend", "hold", 0.30, "EMAs tangled (no clear trend)"))

        # 2) Momentum via RSI (with slope). A reversal signal requires RSI to be
        #    *actually turning* (strict), so a value pegged at 0/100 during a
        #    strong trend reads as momentum confirmation, not a reversal.
        rsi_series = rsi(close, 14)
        rsi_now = float(rsi_series.iloc[-1])
        rsi_prev = float(rsi_series.iloc[-2])
        if rsi_now < 30 and rsi_now > rsi_prev:
            factors.append(Factor("rsi", "buy", 0.20, f"RSI {rsi_now:.0f} oversold & turning up"))
        elif rsi_now > 70 and rsi_now < rsi_prev:
            factors.append(Factor("rsi", "sell", 0.20, f"RSI {rsi_now:.0f} overbought & turning down"))
        elif rsi_now > 50:
            factors.append(Factor("rsi", "buy", 0.10, f"RSI {rsi_now:.0f} above midline"))
        elif rsi_now < 50:
            factors.append(Factor("rsi", "sell", 0.10, f"RSI {rsi_now:.0f} below midline"))
        else:
            factors.append(Factor("rsi", "hold", 0.10, "RSI neutral"))

        # 3) MACD histogram (momentum acceleration / crossover).
        _, _, hist = macd(close)
        h_now, h_prev = float(hist.iloc[-1]), float(hist.iloc[-2])
        if h_now > 0 and h_now >= h_prev:
            factors.append(Factor("macd", "buy", 0.20, "MACD histogram positive & rising"))
        elif h_now < 0 and h_now <= h_prev:
            factors.append(Factor("macd", "sell", 0.20, "MACD histogram negative & falling"))
        else:
            factors.append(Factor("macd", "hold", 0.20, "MACD histogram flattening"))

        # 4) Recent return (short-term drift over ~10 bars).
        ret = (close.iloc[-1] / close.iloc[-11] - 1.0) * 100 if len(close) > 11 else 0.0
        if ret > 1.0:
            factors.append(Factor("momentum", "buy", 0.15, f"+{ret:.1f}% over last 10 bars"))
        elif ret < -1.0:
            factors.append(Factor("momentum", "sell", 0.15, f"{ret:.1f}% over last 10 bars"))
        else:
            factors.append(Factor("momentum", "hold", 0.15, "flat over last 10 bars"))

        # 5) Volatility gate (ATR%). Extreme volatility -> stand aside.
        atr_now = float(atr(candles, 14).iloc[-1])
        vol_pct = (atr_now / price * 100) if price else 0.0
        vol_gated = vol_pct > self.max_volatility_pct
        factors.append(
            Factor(
                "volatility",
                "hold",
                0.0,
                f"ATR {vol_pct:.1f}% of price" + (" — too high, standing aside" if vol_gated else ""),
            )
        )

        # ---- combine ----
        score = 0.0
        total_weight = 0.0
        for f in factors:
            total_weight += f.weight
            if f.signal == "buy":
                score += f.weight
            elif f.signal == "sell":
                score -= f.weight
        # Normalise to [-1, 1].
        norm = score / total_weight if total_weight else 0.0

        # Confidence = agreement strength (absolute normalised score), reduced
        # when factors conflict. Volatility gate zeroes confidence for action.
        confidence = abs(norm)
        if vol_gated:
            confidence = 0.0

        if confidence < self.min_confidence or vol_gated:
            verdict: Verdict = "hold"
        elif norm >= self.buy_threshold:
            verdict = "buy"
        elif norm <= -self.buy_threshold:
            verdict = "sell"
        else:
            verdict = "hold"

        summary = self._summarize(verdict, confidence, norm, vol_gated)
        return MarketAnalysis(
            symbol=symbol,
            verdict=verdict,
            confidence=confidence,
            score=norm,
            price=price,
            factors=factors,
            summary=summary,
        )

    @staticmethod
    def _summarize(verdict: Verdict, confidence: float, norm: float, vol_gated: bool) -> str:
        if vol_gated:
            return "Volatility too high to trade safely — standing aside to protect capital."
        bias = "bullish" if norm > 0 else "bearish" if norm < 0 else "neutral"
        if verdict == "hold":
            return (
                f"Signals are {bias} but weak/mixed (confidence {confidence:.0%}). "
                "Holding — no clear edge."
            )
        return (
            f"{verdict.upper()} with {confidence:.0%} confidence: overall {bias} "
            "across trend, momentum and MACD."
        )
