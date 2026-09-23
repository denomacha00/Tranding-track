"""The trading engine: executes signals (from TradingView or manual) with risk
checks, supports paper and live modes, tracks positions and PnL, and broadcasts
state to connected dashboard clients.

Thread-safety: order execution is guarded by a lock because signals can arrive
concurrently (webhook + manual + monitor loop).
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
import threading
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.exchange import BinanceConnector
from app.analysis import MarketAnalyzer
from app.models import Trade, TradeStatus
from app.risk import RiskManager
from app.notifier import Notifier
from app.state import (
    load_paper_balance,
    load_settings_overrides,
    save_paper_balance,
    save_settings_overrides,
)

logger = logging.getLogger(__name__)


def _utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class TradingEngine:
    """Coordinates market data, risk, execution and position bookkeeping."""

    def __init__(self, settings: Settings, connector: BinanceConnector) -> None:
        self.settings = settings
        self.connector = connector
        self.risk = RiskManager(settings)
        self.analyzer = MarketAnalyzer(min_confidence=settings.min_signal_confidence)
        self.notifier = Notifier(settings)
        self._lock = threading.Lock()
        self.running = False
        # Paper wallet (quote currency, e.g. USDT).
        self.paper_balance = settings.paper_starting_balance
        # Event broadcaster set by the app on startup.
        self._broadcaster: Optional[Any] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    # ---- wiring ------------------------------------------------------

    def attach_broadcaster(self, broadcaster: Any, loop: asyncio.AbstractEventLoop) -> None:
        self._broadcaster = broadcaster
        self._loop = loop

    def restore_state(self, db: Session) -> None:
        """Load persisted settings overrides + paper balance on startup.

        Called once at app start so a restart doesn't silently reset trading
        mode, auto-trade flags, risk params or the simulated wallet.
        """
        overrides = load_settings_overrides(db)
        if overrides:
            for key, value in overrides.items():
                if hasattr(self.settings, key):
                    setattr(self.settings, key, value)
            self.risk.update(self.settings)
            self.connector.reload(self.settings)
            self.analyzer.min_confidence = self.settings.min_signal_confidence
        # Paper wallet: restore or seed from configured starting balance.
        self.paper_balance = load_paper_balance(db, self.settings.paper_starting_balance)
        self._reconcile_live_positions(db)

    def _reconcile_live_positions(self, db: Session) -> None:
        """On startup in live mode, warn if the DB and exchange disagree.

        SL/TP monitoring trusts the DB as the source of truth. If the bot was
        down while a position changed on the exchange (manual trade, liquidation),
        the two can diverge. We can't safely auto-close, but we surface it so the
        operator can act instead of the bot silently managing a stale position.
        """
        if not self.settings.is_live or not self.connector.has_credentials:
            return
        open_trades = list(
            db.scalars(
                select(Trade).where(Trade.status == TradeStatus.open.value)
            ).all()
        )
        if not open_trades:
            return
        try:
            base_balances = self.connector.fetch_position_amounts()
        except Exception as exc:
            logger.warning("position reconciliation skipped: %s", exc)
            return
        for t in open_trades:
            base = t.symbol.split("/")[0]
            held = base_balances.get(base, 0.0)
            if t.side == "buy" and held + 1e-9 < t.amount:
                logger.warning(
                    "Reconciliation: DB shows open long %s %s but exchange holds "
                    "only %s — position may have changed while the bot was down.",
                    t.amount, t.symbol, held,
                )
                self._emit(
                    "reconcile_warning",
                    {"symbol": t.symbol, "db_amount": t.amount, "exchange_amount": held},
                )

    def persist_settings(self, db: Session, overrides: dict[str, Any]) -> None:
        """Merge and persist settings overrides so they survive restarts."""
        current = load_settings_overrides(db)
        current.update(overrides)
        save_settings_overrides(db, current)

    def apply_settings(self, settings: Settings) -> None:
        self.settings = settings
        self.risk.update(settings)
        self.connector.reload(settings)
        self.analyzer.min_confidence = settings.min_signal_confidence
        self.notifier.reload(settings)

    def _emit(self, event: str, payload: dict[str, Any]) -> None:
        if self._broadcaster and self._loop:
            asyncio.run_coroutine_threadsafe(
                self._broadcaster.broadcast({"event": event, "data": payload}),
                self._loop,
            )

    # ---- helpers -----------------------------------------------------

    def _price(self, symbol: str, fallback: float | None = None) -> float:
        try:
            return self.connector.fetch_price(symbol)
        except Exception as exc:
            if fallback is not None:
                return fallback
            raise RuntimeError(f"Could not fetch price for {symbol}: {exc}") from exc

    def _equity(self, db: Session) -> float:
        """Available equity used for sizing/limits."""
        if self.settings.is_live:
            bal = self.connector.fetch_balance("USDT")
            if bal is not None:
                return bal
            # If we cannot read the live balance, be conservative.
            return 0.0
        return self.paper_balance

    def _open_trade_for_symbol(self, db: Session, symbol: str) -> Optional[Trade]:
        stmt = select(Trade).where(
            Trade.symbol == symbol, Trade.status == TradeStatus.open.value
        )
        return db.scalars(stmt).first()

    # ---- core execution ---------------------------------------------

    def execute_signal(
        self,
        db: Session,
        *,
        action: str,
        symbol: str,
        amount: float | None,
        stop_loss: float | None,
        take_profit: float | None,
        source: str,
        note: str | None = None,
    ) -> tuple[bool, str, Optional[Trade]]:
        """Execute a buy/sell/close signal. Returns (accepted, message, trade)."""
        symbol = symbol.upper().strip()
        action = action.lower().strip()
        if action not in {"buy", "sell", "close"}:
            return False, f"Unknown action '{action}'", None

        with self._lock:
            existing = self._open_trade_for_symbol(db, symbol)

            # ---- CLOSE (or opposite-side signal that closes) ----------
            if action == "close":
                if not existing:
                    return False, f"No open position for {symbol} to close", None
                return self._close_trade(db, existing, note or "close signal")

            # A sell with an open long closes it; a buy with an open short closes it.
            if existing and existing.side != action:
                return self._close_trade(db, existing, note or f"{action} signal closed position")

            if existing and existing.side == action:
                return False, f"Already in a {action} position for {symbol}", None

            # ---- OPEN a new position ---------------------------------
            price = self._price(symbol)
            equity = self._equity(db)
            decision = self.risk.check(
                db,
                equity=equity,
                price=price,
                requested_amount=amount,
                is_opening=True,
            )
            if not decision.allowed:
                return False, f"Rejected by risk manager: {decision.reason}", None

            qty = decision.amount
            exchange_order_id: str | None = None

            if self.settings.is_live:
                adj_qty, err = self.connector.normalize_amount(symbol, qty, price)
                if err:
                    return False, f"Rejected: {err}", None
                qty = adj_qty
                try:
                    order = self.connector.create_market_order(symbol, action, qty)
                    exchange_order_id = str(order.get("id")) if order else None
                    filled_price = float(order.get("average") or order.get("price") or price)
                    price = filled_price
                except Exception as exc:
                    return False, f"Exchange order failed: {exc}", None
            else:
                # Paper: reserve notional from the paper wallet.
                self.paper_balance -= qty * price
                save_paper_balance(db, self.paper_balance)

            sl = stop_loss or self._auto_stop(price, action)
            tp = take_profit or self._auto_take(price, action)

            # Live: place an exchange-side stop-loss so the position is protected
            # even if this bot process is down. Best-effort; the in-process SL/TP
            # monitor remains the fallback.
            stop_order_id: str | None = None
            if self.settings.is_live and sl and action == "buy":
                stop_order = self.connector.create_stop_loss_order(
                    symbol, "sell", qty, sl
                )
                if stop_order:
                    stop_order_id = str(stop_order.get("id"))

            trade = Trade(
                symbol=symbol,
                side=action,
                amount=qty,
                entry_price=price,
                stop_loss=sl,
                take_profit=tp,
                status=TradeStatus.open.value,
                mode=self.settings.trading_mode,
                source=source,
                exchange_order_id=exchange_order_id,
                stop_order_id=stop_order_id,
                note=note,
                opened_at=_utcnow(),
            )
            db.add(trade)
            db.commit()
            db.refresh(trade)
            self._emit("trade_opened", {"id": trade.id, "symbol": symbol, "side": action})
            self.notifier.send(
                f"\U0001F4C8 Opened <b>{action.upper()}</b> {qty:.8f} {symbol} @ "
                f"{price:.2f} ({self.settings.trading_mode})"
            )
            return True, f"Opened {action} {qty:.8f} {symbol} @ {price:.2f}", trade

    def _auto_stop(self, price: float, side: str) -> float:
        pct = self.settings.default_stop_loss_pct / 100.0
        return price * (1 - pct) if side == "buy" else price * (1 + pct)

    def _auto_take(self, price: float, side: str) -> float:
        pct = self.settings.default_take_profit_pct / 100.0
        return price * (1 + pct) if side == "buy" else price * (1 - pct)

    def _close_trade(
        self, db: Session, trade: Trade, reason: str
    ) -> tuple[bool, str, Optional[Trade]]:
        """Close an open trade at current market price. Caller holds the lock."""
        price = self._price(trade.symbol, fallback=trade.entry_price)

        if self.settings.is_live:
            # Cancel any resting exchange-side stop before we market-close, so it
            # can't fire later against a position we no longer hold.
            if trade.stop_order_id:
                self.connector.cancel_order(trade.stop_order_id, trade.symbol)
                trade.stop_order_id = None
            close_side = "sell" if trade.side == "buy" else "buy"
            try:
                self.connector.create_market_order(trade.symbol, close_side, trade.amount)
            except Exception as exc:
                return False, f"Exchange close failed: {exc}", None

        pnl = self._realized_pnl(trade, price)
        if not self.settings.is_live:
            # Return notional + pnl to the paper wallet.
            self.paper_balance += trade.amount * trade.entry_price + pnl
            save_paper_balance(db, self.paper_balance)

        trade.exit_price = price
        trade.pnl = pnl
        trade.status = TradeStatus.closed.value
        trade.closed_at = _utcnow()
        trade.note = (trade.note + " | " if trade.note else "") + reason
        db.commit()
        db.refresh(trade)
        self._emit("trade_closed", {"id": trade.id, "symbol": trade.symbol, "pnl": pnl})
        self.notifier.send(
            f"\U0001F4B0 Closed {trade.symbol} @ {price:.2f} | PnL <b>{pnl:.2f}</b> "
            f"({reason})"
        )
        return True, f"Closed {trade.symbol} @ {price:.2f} (PnL {pnl:.2f})", trade

    @staticmethod
    def _realized_pnl(trade: Trade, exit_price: float) -> float:
        if trade.side == "buy":
            return (exit_price - trade.entry_price) * trade.amount
        return (trade.entry_price - exit_price) * trade.amount

    @staticmethod
    def unrealized_pnl(trade: Trade, price: float) -> float:
        if trade.side == "buy":
            return (price - trade.entry_price) * trade.amount
        return (trade.entry_price - price) * trade.amount

    # ---- monitoring (stop-loss / take-profit) ------------------------

    def check_open_positions(self, db: Session) -> list[tuple[Trade, str]]:
        """Check SL/TP for all open trades and close those that hit. Returns closed."""
        closed: list[tuple[Trade, str]] = []
        stmt = select(Trade).where(Trade.status == TradeStatus.open.value)
        for trade in list(db.scalars(stmt).all()):
            try:
                price = self._price(trade.symbol, fallback=trade.entry_price)
            except Exception:
                continue
            self._maybe_trail_stop(db, trade, price)
            hit: str | None = None
            if trade.side == "buy":
                if trade.stop_loss and price <= trade.stop_loss:
                    hit = "stop-loss"
                elif trade.take_profit and price >= trade.take_profit:
                    hit = "take-profit"
            else:  # sell / short
                if trade.stop_loss and price >= trade.stop_loss:
                    hit = "stop-loss"
                elif trade.take_profit and price <= trade.take_profit:
                    hit = "take-profit"
            if hit:
                with self._lock:
                    ok, _msg, _t = self._close_trade(db, trade, f"{hit} triggered")
                if ok:
                    closed.append((trade, hit))
        return closed

    def _maybe_trail_stop(self, db: Session, trade: Trade, price: float) -> None:
        """Ratchet a long position's stop-loss upward as price rises.

        Only tightens (raises) the stop, never loosens it, and only for longs.
        Disabled when trailing_stop_pct is 0.
        """
        pct = self.settings.trailing_stop_pct
        if pct <= 0 or trade.side != "buy":
            return
        candidate = price * (1 - pct / 100.0)
        # Only raise the stop, and never above the current price.
        if candidate < price and (trade.stop_loss is None or candidate > trade.stop_loss):
            trade.stop_loss = candidate
            # Live: move the exchange-side stop order too (cancel + replace).
            if self.settings.is_live and trade.side == "buy":
                if trade.stop_order_id:
                    self.connector.cancel_order(trade.stop_order_id, trade.symbol)
                    trade.stop_order_id = None
                new_stop = self.connector.create_stop_loss_order(
                    trade.symbol, "sell", trade.amount, candidate
                )
                if new_stop:
                    trade.stop_order_id = str(new_stop.get("id"))
            db.commit()
            self._emit(
                "stop_trailed",
                {"id": trade.id, "symbol": trade.symbol, "stop_loss": candidate},
            )

    # ---- autonomous analysis-driven trading --------------------------

    def analyze_symbol(self, symbol: str, timeframe: str = "1h", limit: int = 200):
        """Fetch candles and run the deterministic market analyzer."""
        import pandas as pd

        raw = self.connector.fetch_ohlcv(symbol.upper(), timeframe, min(limit, 1000))
        if not raw:
            raise RuntimeError(f"No candle data for {symbol}")
        df = pd.DataFrame(
            raw, columns=["timestamp", "open", "high", "low", "close", "volume"]
        )
        return self.analyzer.analyze(df, symbol.upper())

    def auto_trade_symbol(
        self, db: Session, symbol: str, timeframe: str = "1h"
    ) -> tuple[bool, str]:
        """Analyse one symbol and act only on a confident buy/sell verdict.

        Capital-preservation rules:
        - HOLD verdicts never open or close anything.
        - A confident SELL closes an existing long but does NOT open a short
          (spot, long-only autonomous mode) — avoids doubling risk on noise.
        """
        try:
            analysis = self.analyze_symbol(symbol, timeframe)
        except Exception as exc:
            return False, f"analysis failed for {symbol}: {exc}"

        if analysis.verdict == "hold":
            return False, f"{symbol}: hold ({analysis.confidence:.0%})"

        existing = None
        # Multi-timeframe confirmation: refuse to act against a higher timeframe.
        _confirm_tf = (self.settings.auto_confirm_timeframe or "").strip()
        if _confirm_tf and _confirm_tf != timeframe:
            try:
                _higher = self.analyze_symbol(symbol, _confirm_tf)
            except Exception as exc:
                return False, f"{symbol}: confirm timeframe {_confirm_tf} failed: {exc}"
            if analysis.verdict == "buy" and _higher.verdict == "sell":
                return False, f"{symbol}: buy blocked - {_confirm_tf} reads sell ({_higher.confidence:.0%})"
            if analysis.verdict == "sell" and _higher.verdict == "buy":
                return False, f"{symbol}: exit blocked - {_confirm_tf} reads buy ({_higher.confidence:.0%})"
        with self._lock:
            existing = self._open_trade_for_symbol(db, symbol.upper())

        if analysis.verdict == "buy":
            if existing:
                return False, f"{symbol}: already long"
            ok, msg, _ = self.execute_signal(
                db, action="buy", symbol=symbol, amount=None,
                stop_loss=None, take_profit=None, source="auto",
                note=f"auto: {analysis.summary}",
            )
            return ok, msg
        # sell verdict: close a long if we hold one, else stand aside.
        if existing and existing.side == "buy":
            ok, msg, _ = self.execute_signal(
                db, action="close", symbol=symbol, amount=None,
                stop_loss=None, take_profit=None, source="auto",
                note=f"auto exit: {analysis.summary}",
            )
            return ok, msg
        return False, f"{symbol}: sell signal, no long to close"

    # ---- status ------------------------------------------------------

    def status(self, db: Session) -> dict[str, Any]:
        open_trades = list(
            db.scalars(
                select(Trade).where(Trade.status == TradeStatus.open.value)
            ).all()
        )
        unrealized = 0.0
        for t in open_trades:
            try:
                price = self._price(t.symbol, fallback=t.entry_price)
            except Exception:
                price = t.entry_price
            unrealized += self.unrealized_pnl(t, price)

        realized = float(
            sum(
                t.pnl
                for t in db.scalars(
                    select(Trade).where(Trade.status == TradeStatus.closed.value)
                ).all()
            )
        )
        balance = self._equity(db)
        return {
            "running": self.running,
            "trading_mode": self.settings.trading_mode,
            "testnet": self.settings.binance_testnet,
            "exchange_connected": self.connector.connected,
            "open_positions": len(open_trades),
            "balance": balance,
            "equity": balance + unrealized,
            "realized_pnl": realized,
            "unrealized_pnl": unrealized,
            "day_pnl": self.risk.day_realized_pnl(db),
            "max_open_positions": self.settings.max_open_positions,
        }


# Singleton engine instance, created on app startup.
_engine: Optional[TradingEngine] = None


def get_engine() -> TradingEngine:
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = TradingEngine(settings, BinanceConnector(settings))
    return _engine
