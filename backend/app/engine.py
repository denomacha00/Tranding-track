"""The trading engine: executes signals (from TradingView or manual) with risk
checks, supports paper and live modes, tracks positions and PnL, and broadcasts
state to connected dashboard clients.

Thread-safety: order execution is guarded by a lock because signals can arrive
concurrently (webhook + manual + monitor loop).
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import threading
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.exchange import BinanceConnector
from app.analysis import MarketAnalyzer
from app.ai import AICommentator
from app.models import SignalLog, Trade, TradeStatus
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

    def __init__(self, settings: Settings, connector: BinanceConnector,
                 user_id: int | None = None) -> None:
        self.settings = settings
        self.connector = connector
        self.user_id = user_id
        self.risk = RiskManager(settings, user_id=user_id)
        self.analyzer = MarketAnalyzer(min_confidence=settings.min_signal_confidence)
        self.notifier = Notifier(settings)
        self.ai = AICommentator(settings)
        self._lock = threading.Lock()
        self.running = False
        # Last autonomous verdict per symbol, so a signal row is logged only when
        # the brain's decision CHANGES (not an identical row every ~5s tick).
        self._last_auto_verdict: dict[str, str] = {}
        # Paper wallet (quote currency, e.g. USDT).
        self.paper_balance = settings.paper_starting_balance
        # Event broadcaster set by the app on startup.
        self._broadcaster: Optional[Any] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def _scope(self, stmt):
        """Restrict a Trade query to this engine's user (multi-tenant isolation).

        In single-tenant mode (user_id is None) queries are unscoped, preserving
        the original global behaviour used by the tests.
        """
        if self.user_id is not None:
            stmt = stmt.where(Trade.user_id == self.user_id)
        return stmt

    # ---- wiring ------------------------------------------------------

    def attach_broadcaster(self, broadcaster: Any, loop: asyncio.AbstractEventLoop) -> None:
        self._broadcaster = broadcaster
        self._loop = loop

    def restore_state(self, db: Session) -> None:
        """Load persisted settings overrides + paper balance on startup.

        Called once at app start so a restart doesn't silently reset trading
        mode, auto-trade flags, risk params or the simulated wallet.
        """
        overrides = load_settings_overrides(db, self.user_id)
        if overrides:
            for key, value in overrides.items():
                if hasattr(self.settings, key):
                    setattr(self.settings, key, value)
            self.risk.update(self.settings)
            self.connector.reload(self.settings)
            self.analyzer.min_confidence = self.settings.min_signal_confidence
        # Paper wallet: restore or seed from configured starting balance.
        self.paper_balance = load_paper_balance(
            db, self.settings.paper_starting_balance, self.user_id
        )
        self._reconcile_live_positions(db)

    def _reconcile_live_positions(self, db: Session) -> None:
        """On startup in live mode, heal DB/exchange disagreements.

        SL/TP monitoring trusts the DB as the source of truth. If the bot was
        down while a position changed on the exchange (manual trade, liquidation,
        a stop that fired), the two can diverge and the bot would otherwise keep
        managing a position that no longer exists. We take the EXCHANGE as ground
        truth and auto-heal: when the exchange no longer holds enough of the base
        asset to back an open long, we mark that DB trade closed (at the last
        known price) so the bot stops acting on a stale position. Every heal is
        logged and broadcast so the operator can see what happened.
        """
        if not self.settings.is_live or not self.connector.has_credentials:
            return
        open_trades = list(
            db.scalars(
                self._scope(
                    select(Trade).where(Trade.status == TradeStatus.open.value)
                )
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
                # Exchange holds less than our DB long expects. If essentially
                # nothing is held, the position is gone — auto-close the record.
                logger.warning(
                    "Reconciliation: DB shows open long %s %s but exchange holds "
                    "only %s — position changed while the bot was down; healing.",
                    t.amount, t.symbol, held,
                )
                if held <= max(t.amount * 0.01, 1e-8):
                    # Cancel any orphaned protective stop, then close the record.
                    if t.stop_order_id:
                        self.connector.cancel_order(t.stop_order_id, t.symbol)
                        t.stop_order_id = None
                    price = self._price(t.symbol, fallback=t.entry_price)
                    t.exit_price = price
                    t.pnl = self._realized_pnl(t, price)
                    t.status = TradeStatus.closed.value
                    t.closed_at = _utcnow()
                    t.note = (t.note + " | " if t.note else "") + (
                        "auto-reconciled: exchange no longer holds this position"
                    )
                    db.commit()
                    self._emit(
                        "reconcile_closed",
                        {"symbol": t.symbol, "db_amount": t.amount,
                         "exchange_amount": held, "pnl": t.pnl},
                    )
                    self._notify(
                        f"\u2699\ufe0f Reconciled {t.symbol}: exchange no longer holds it; "
                        f"closed stale record (PnL {t.pnl:.2f})."
                    )
                else:
                    # Partial mismatch: shrink the DB amount to what's actually
                    # held rather than closing, and warn.
                    old = t.amount
                    t.amount = held
                    db.commit()
                    self._emit(
                        "reconcile_adjusted",
                        {"symbol": t.symbol, "db_amount": old,
                         "exchange_amount": held},
                    )
                    self._notify(
                        f"\u2699\ufe0f Reconciled {t.symbol}: adjusted tracked amount "
                        f"{old} → {held} to match the exchange."
                    )

    def persist_settings(self, db: Session, overrides: dict[str, Any]) -> None:
        """Merge and persist settings overrides so they survive restarts."""
        current = load_settings_overrides(db, self.user_id)
        current.update(overrides)
        save_settings_overrides(db, current, self.user_id)

    def apply_settings(self, settings: Settings) -> None:
        self.settings = settings
        self.risk.update(settings)
        self.connector.reload(settings)
        self.analyzer.min_confidence = settings.min_signal_confidence
        self.notifier.reload(settings)
        self.ai.reload(settings)

    def _emit(self, event: str, payload: dict[str, Any]) -> None:
        if self._broadcaster and self._loop:
            message: dict[str, Any] = {"event": event, "data": payload}
            if self.user_id is not None:
                message["user_id"] = self.user_id
            asyncio.run_coroutine_threadsafe(
                self._broadcaster.broadcast(message),
                self._loop,
            )

    def _notify(self, text: str) -> None:
        """Fire-and-forget Telegram notification.

        ``notifier.send`` makes a blocking HTTP call (up to its timeout) and
        several callers here hold ``self._lock``. Sending inline would stall the
        whole order path for that user on a slow/unreachable Telegram. Dispatch
        on a daemon thread instead so a notification can never block or break a
        trade; ``send`` swallows its own errors.
        """
        if not self.notifier.enabled:
            return
        threading.Thread(
            target=self.notifier.send, args=(text,), daemon=True
        ).start()

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
        # A resting (pending) limit order also occupies the symbol slot.
        stmt = self._scope(
            select(Trade).where(
                Trade.symbol == symbol,
                Trade.status.in_(
                    [TradeStatus.open.value, TradeStatus.pending.value]
                ),
            )
        )
        return db.scalars(stmt).first()

    def _open_unrealized(self, db: Session) -> float:
        """Sum current unrealized PnL across this account's OPEN positions.

        Fed into the daily-loss circuit breaker so a large *open* drawdown blocks
        NEW entries even before any losing trade is realized — capital
        preservation ("less loss") shouldn't wait for a stop to fire.
        """
        open_trades = db.scalars(
            self._scope(select(Trade).where(Trade.status == TradeStatus.open.value))
        ).all()
        total = 0.0
        for t in open_trades:
            try:
                price = self._price(t.symbol, fallback=t.entry_price)
            except Exception:
                price = t.entry_price
            total += self.unrealized_pnl(t, price)
        return total

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
        limit_price: float | None = None,
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
                if existing.status == TradeStatus.pending.value:
                    return self._cancel_pending(db, existing, note or "close signal")
                return self._close_trade(db, existing, note or "close signal")

            # A sell with an open long closes it; a buy with an open short closes it.
            if existing and existing.side != action:
                if existing.status == TradeStatus.pending.value:
                    return self._cancel_pending(
                        db, existing, note or f"{action} signal cancelled resting order"
                    )
                return self._close_trade(db, existing, note or f"{action} signal closed position")

            if existing and existing.side == action:
                state = (
                    "resting limit"
                    if existing.status == TradeStatus.pending.value
                    else action
                )
                return False, f"Already in a {state} position for {symbol}", None

            # ---- OPEN a new position ---------------------------------
            # Spot markets can't be shorted: a live SELL with no existing long to
            # close (all closing cases returned above) would attempt to sell base
            # currency we don't hold and be rejected by Binance — or, worse, sell
            # unrelated holdings. Refuse it explicitly on live. Paper still
            # simulates sell-to-open for symmetry/backtest-style exploration.
            if self.settings.is_live and action == "sell":
                return (
                    False,
                    f"{symbol}: short selling is not supported on live spot "
                    "(no open long to close).",
                    None,
                )
            price = self._price(symbol)
            # For a limit order, size and validate against the LIMIT price (the
            # intended fill), not the current market price.
            ref_price = limit_price if limit_price else price
            equity = self._equity(db)
            decision = self.risk.check(
                db,
                equity=equity,
                price=ref_price,
                requested_amount=amount,
                is_opening=True,
                stop_price=stop_loss,
                day_unrealized=self._open_unrealized(db),
            )
            if not decision.allowed:
                return False, f"Rejected by risk manager: {decision.reason}", None

            qty = decision.amount
            exchange_order_id: str | None = None

            # ---- LIMIT order: rest it, fill later when price crosses ----
            if limit_price:
                if self.settings.is_live:
                    adj_qty, err = self.connector.normalize_amount(
                        symbol, qty, limit_price
                    )
                    if err:
                        return False, f"Rejected: {err}", None
                    qty = adj_qty
                    try:
                        order = self.connector.create_limit_order(
                            symbol, action, qty, limit_price
                        )
                        exchange_order_id = str(order.get("id")) if order else None
                    except Exception as exc:
                        return False, f"Exchange limit order failed: {exc}", None
                else:
                    # Paper: reserve notional now so equity/exposure is honest
                    # while the order rests; released if cancelled, consumed on fill.
                    self.paper_balance -= qty * limit_price
                    save_paper_balance(db, self.paper_balance, self.user_id)

                trade = Trade(
                    symbol=symbol,
                    side=action,
                    amount=qty,
                    entry_price=limit_price,
                    status=TradeStatus.pending.value,
                    order_type="limit",
                    limit_price=limit_price,
                    stop_loss=stop_loss,
                    take_profit=take_profit,
                    mode=self.settings.trading_mode,
                    source=source,
                    exchange_order_id=exchange_order_id,
                    note=note,
                    opened_at=_utcnow(),
                    user_id=self.user_id,
                )
                db.add(trade)
                db.commit()
                db.refresh(trade)
                self._emit(
                    "order_pending",
                    {"id": trade.id, "symbol": symbol, "side": action,
                     "limit_price": limit_price},
                )
                self._notify(
                    f"\U0001F4DD Limit {action.upper()} {qty:.8f} {symbol} resting @ "
                    f"{limit_price:.2f} ({self.settings.trading_mode})"
                )
                return (
                    True,
                    f"Limit {action} {qty:.8f} {symbol} resting @ {limit_price:.2f}",
                    trade,
                )

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
                save_paper_balance(db, self.paper_balance, self.user_id)

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
                user_id=self.user_id,
            )
            db.add(trade)
            db.commit()
            db.refresh(trade)
            self._emit("trade_opened", {"id": trade.id, "symbol": symbol, "side": action})
            self._notify(
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

    # ---- resting limit orders ---------------------------------------

    def _cancel_pending(
        self, db: Session, trade: Trade, reason: str
    ) -> tuple[bool, str, Optional[Trade]]:
        """Cancel a resting (pending) limit order. Caller holds the lock.

        Releases the paper reservation and cancels the live exchange order.
        """
        if self.settings.is_live and trade.exchange_order_id:
            self.connector.cancel_order(trade.exchange_order_id, trade.symbol)
        else:
            # Paper: give back the notional we reserved when the order was placed.
            self.paper_balance += trade.amount * (trade.limit_price or trade.entry_price)
            save_paper_balance(db, self.paper_balance, self.user_id)

        trade.status = TradeStatus.canceled.value
        trade.closed_at = _utcnow()
        trade.note = (trade.note + " | " if trade.note else "") + reason
        db.commit()
        db.refresh(trade)
        self._emit(
            "order_canceled", {"id": trade.id, "symbol": trade.symbol}
        )
        return True, f"Cancelled resting {trade.side} {trade.symbol}", trade

    def _fill_pending(self, db: Session, trade: Trade, fill_price: float) -> None:
        """Promote a resting limit order to an open position once it fills.

        Caller holds the lock. Paper notional was already reserved at placement,
        so no wallet change happens here. Sets auto SL/TP if none were provided
        and (live) places the protective exchange stop.
        """
        trade.entry_price = fill_price
        trade.status = TradeStatus.open.value
        if trade.stop_loss is None:
            trade.stop_loss = self._auto_stop(fill_price, trade.side)
        if trade.take_profit is None:
            trade.take_profit = self._auto_take(fill_price, trade.side)
        if self.settings.is_live and trade.stop_loss and trade.side == "buy":
            stop_order = self.connector.create_stop_loss_order(
                trade.symbol, "sell", trade.amount, trade.stop_loss
            )
            if stop_order:
                trade.stop_order_id = str(stop_order.get("id"))
        trade.opened_at = _utcnow()
        db.commit()
        db.refresh(trade)
        self._emit(
            "trade_opened",
            {"id": trade.id, "symbol": trade.symbol, "side": trade.side},
        )
        self._notify(
            f"\U0001F4C8 Limit filled <b>{trade.side.upper()}</b> {trade.amount:.8f} "
            f"{trade.symbol} @ {fill_price:.2f} ({self.settings.trading_mode})"
        )

    def check_pending_orders(self, db: Session) -> list[Trade]:
        """Fill resting limit orders whose price has been reached. Returns filled.

        Paper: a buy fills when market <= limit, a sell fills when market >= limit.
        Live: we trust the exchange — poll the order and fill when it reports
        closed/filled, using the exchange's average fill price.
        """
        filled: list[Trade] = []
        stmt = self._scope(select(Trade).where(Trade.status == TradeStatus.pending.value))
        for trade in list(db.scalars(stmt).all()):
            limit = trade.limit_price or trade.entry_price
            filled_amt: float | None = None  # live: exchange-reported fill qty
            if self.settings.is_live:
                order = self.connector.fetch_order(
                    trade.exchange_order_id or "", trade.symbol
                )
                if not order:
                    continue
                status = (order.get("status") or "").lower()
                if status in {"canceled", "cancelled", "rejected", "expired"}:
                    with self._lock:
                        db.refresh(trade)
                        if trade.status == TradeStatus.pending.value:
                            self._cancel_pending(db, trade, f"exchange {status}")
                    continue
                # Only promote a resting order once the exchange reports it FULLY
                # filled. A partial fill ("open" with a nonzero filled amount) must
                # keep resting — booking it as a complete position would track base
                # we don't fully hold. Sync the tracked size to the actually-filled
                # quantity so venue rounding never leaves us over-reporting.
                if status not in {"closed", "filled"}:
                    continue
                filled_amt = float(order.get("filled") or 0) or trade.amount
                fill_price = float(
                    order.get("average") or order.get("price") or limit
                )
            else:
                try:
                    price = self._price(trade.symbol, fallback=limit)
                except Exception:
                    continue
                crossed = (
                    price <= limit if trade.side == "buy" else price >= limit
                )
                if not crossed:
                    continue
                fill_price = limit  # paper fills at the limit price
            with self._lock:
                # Re-read under the lock so a concurrent cancel/fill on another
                # session can't make us fill the same resting order twice.
                db.refresh(trade)
                if trade.status != TradeStatus.pending.value:
                    continue
                if filled_amt is not None:
                    trade.amount = filled_amt
                self._fill_pending(db, trade, fill_price)
            filled.append(trade)
        return filled

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
                close_order = self.connector.create_market_order(
                    trade.symbol, close_side, trade.amount
                )
            except Exception as exc:
                return False, f"Exchange close failed: {exc}", None
            # Book PnL at the price we ACTUALLY got, not the pre-trade ticker: a
            # market-close fill can differ from the last quote (slippage/spread).
            # Fall back to the ticker price if the venue reports no average.
            if close_order:
                price = float(
                    close_order.get("average") or close_order.get("price") or price
                )

        pnl = self._realized_pnl(trade, price)
        if not self.settings.is_live:
            # Return notional + pnl to the paper wallet.
            self.paper_balance += trade.amount * trade.entry_price + pnl
            save_paper_balance(db, self.paper_balance, self.user_id)

        trade.exit_price = price
        trade.pnl = pnl
        trade.status = TradeStatus.closed.value
        trade.closed_at = _utcnow()
        trade.note = (trade.note + " | " if trade.note else "") + reason
        db.commit()
        db.refresh(trade)
        self._emit("trade_closed", {"id": trade.id, "symbol": trade.symbol, "pnl": pnl})
        self._notify(
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
        stmt = self._scope(select(Trade).where(Trade.status == TradeStatus.open.value))
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
                    # Re-read under the lock: a manual close (on a different DB
                    # session) may have closed this trade between our SELECT and
                    # acquiring the lock. Closing again would double the order.
                    db.refresh(trade)
                    if trade.status != TradeStatus.open.value:
                        continue
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
        ok, msg = self._decide_and_act(db, symbol, timeframe, analysis)
        # Persist the brain's OWN verdict (deduped on change) so the Signals tab
        # shows an honest timeline of autonomous decisions, not just TradingView
        # alerts. Logging must never break the trading loop.
        try:
            self._log_auto_verdict(db, symbol.upper(), analysis, ok, msg)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("verdict logging failed for %s: %s", symbol, exc)
        return ok, msg

    def _decide_and_act(
        self, db: Session, symbol: str, timeframe: str, analysis
    ) -> tuple[bool, str]:
        """Decide and execute from a computed analysis. Returns (accepted, msg)."""
        if analysis.verdict == "hold":
            return False, f"{symbol}: hold ({analysis.confidence:.0%})"

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
            # Permission-gated AI review of the ENTRY. Risk-first and veto-only:
            # it can BLOCK new risk but never invent a trade, and if the AI is
            # unavailable it falls back to the deterministic decision. Governed by
            # ai_trade_confirm (off by default) — the risk manager still applies.
            if getattr(self.settings, "ai_trade_confirm", False) and self.ai.available:
                proceed, reason = self.ai.confirm_trade(analysis)
                if not proceed:
                    return False, f"{symbol}: {reason}"
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

    def _log_auto_verdict(
        self, db: Session, symbol: str, analysis, acted: bool, message: str
    ) -> None:
        """Record an autonomous verdict — but only when it CHANGES for a symbol.

        A stable trend would otherwise write a near-identical row every ~5s
        tick; de-duping on the verdict keeps the log a compact, readable
        timeline. These are the brain's real, already-made decisions (nothing
        fabricated), so persisting them honours the "nothing fake" rule.
        """
        prev = self._last_auto_verdict.get(symbol)
        if prev == analysis.verdict:
            return
        self._last_auto_verdict[symbol] = analysis.verdict
        detail = analysis.summary
        if message and message != analysis.summary:
            detail = f"{analysis.summary} — {message}"
        log = SignalLog(
            user_id=self.user_id,
            source="analyzer",
            symbol=symbol,
            action=analysis.verdict,
            raw=json.dumps(analysis.as_dict()),
            accepted=1 if acted else 0,
            message=detail,
        )
        db.add(log)
        db.commit()
        db.refresh(log)
        self._emit(
            "signal",
            {
                "id": log.id,
                "source": "analyzer",
                "symbol": symbol,
                "action": analysis.verdict,
                "accepted": bool(acted),
                "confidence": round(analysis.confidence, 3),
                "message": detail,
            },
        )

    def observe_symbol(
        self, db: Session, symbol: str, timeframe: str = "1h"
    ) -> tuple[bool, str]:
        """Analyse a symbol and LOG the verdict WITHOUT trading.

        Used when autonomous execution is off, so the Signals tab still shows the
        brain's live read of the market (honest, deduped on change). No order is
        ever placed here — this observes and records only.
        """
        try:
            analysis = self.analyze_symbol(symbol, timeframe)
        except Exception as exc:
            return False, f"analysis failed for {symbol}: {exc}"
        try:
            self._log_auto_verdict(
                db, symbol.upper(), analysis, False,
                "monitoring — autonomous execution off",
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("verdict logging failed for %s: %s", symbol, exc)
        return True, f"{symbol}: {analysis.verdict} ({analysis.confidence:.0%}) observed"

    # ---- status ------------------------------------------------------

    def status(self, db: Session) -> dict[str, Any]:
        open_trades = list(
            db.scalars(
                self._scope(
                    select(Trade).where(Trade.status == TradeStatus.open.value)
                )
            ).all()
        )
        unrealized = 0.0
        position_value = 0.0
        for t in open_trades:
            try:
                price = self._price(t.symbol, fallback=t.entry_price)
            except Exception:
                price = t.entry_price
            u = self.unrealized_pnl(t, price)
            unrealized += u
            # Current market value of an open position = its entry notional plus
            # its unrealized PnL. In BOTH modes `balance` is FREE cash *after* the
            # entry notional was taken out (paper: reserved on open; live: spent
            # on the real buy), so the position's value must be added back for an
            # honest total-equity figure instead of understating by the notional.
            position_value += t.entry_price * t.amount + u

        realized = float(
            sum(
                t.pnl
                for t in db.scalars(
                    self._scope(
                        select(Trade).where(Trade.status == TradeStatus.closed.value)
                    )
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
            "equity": balance + position_value,
            "realized_pnl": realized,
            "unrealized_pnl": unrealized,
            "day_pnl": self.risk.day_realized_pnl(db),
            "max_open_positions": self.settings.max_open_positions,
        }
