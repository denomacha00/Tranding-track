"""FastAPI application: REST + WebSocket API for Tranding-track."""
from __future__ import annotations

import asyncio
import json
import hmac
import logging
from contextlib import asynccontextmanager

import pandas as pd
from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import __version__
from app.backtest import run_backtest
from app.config import get_settings
from app.database import get_db, init_db
from app.engine import get_engine
from app.models import SignalLog, Trade, TradeStatus
from app.schemas import (
    BotStatus,
    ExecutionResult,
    ManualOrder,
    SettingsOut,
    SettingsUpdate,
    SignalOut,
    TickerOut,
    TradeOut,
    TradingViewSignal,
)
from app.learn import PARAM_GRIDS, train
from app.analysis import MarketAnalyzer
from app.ai import AICommentator
from app.strategies import STRATEGY_REGISTRY, build_strategy
from app.tasks import monitor_loop
from app.ws import Broadcaster
from app.logging_config import configure_logging

configure_logging(
    get_settings().log_format, get_settings().log_level
)
logger = logging.getLogger("tranding_track")

WEBHOOK_PATH = "/api/webhook/tradingview"

broadcaster = Broadcaster()
_analyzer = MarketAnalyzer()
_ai: AICommentator | None = None


def get_ai() -> AICommentator:
    global _ai
    if _ai is None:
        _ai = AICommentator(get_settings())
    return _ai


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """Guard control/mutating endpoints with an optional API key.

    If ``API_KEY`` is unset the API is open (fine for localhost-only dev). Once
    set, every protected endpoint requires the matching ``X-API-Key`` header —
    without this, anyone who can reach the port could place orders or flip the
    bot to live mode.
    """
    configured = get_engine().settings.api_key
    if not configured:
        return
    if not x_api_key or not hmac.compare_digest(x_api_key, configured):
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


def _analysis_for(symbol: str, timeframe: str = "1h", limit: int = 200):
    """Fetch candles and run the deterministic market analysis."""
    engine = get_engine()
    try:
        raw = engine.connector.fetch_ohlcv(symbol.upper(), timeframe, min(limit, 1000))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OHLCV unavailable: {exc}")
    if not raw:
        raise HTTPException(status_code=502, detail="No candle data returned")
    df = pd.DataFrame(
        raw, columns=["timestamp", "open", "high", "low", "close", "volume"]
    )
    return _analyzer.analyze(df, symbol.upper())


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    engine = get_engine()
    loop = asyncio.get_running_loop()
    engine.attach_broadcaster(broadcaster, loop)
    # Restore persisted settings + paper balance so a restart is not a reset.
    from app.database import SessionLocal

    _db = SessionLocal()
    try:
        engine.restore_state(_db)
    finally:
        _db.close()
    engine.running = True
    monitor_task = asyncio.create_task(monitor_loop(engine, broadcaster))
    logger.info("Tranding-track backend started (mode=%s, testnet=%s)",
                engine.settings.trading_mode, engine.settings.binance_testnet)
    try:
        yield
    finally:
        monitor_task.cancel()
        try:
            await monitor_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Tranding-track", version=__version__, lifespan=lifespan)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- Health ---------------------------------------------------------


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "version": __version__}


# ---- TradingView webhook -------------------------------------------


@app.post(WEBHOOK_PATH, response_model=ExecutionResult)
async def tradingview_webhook(request: Request, db: Session = Depends(get_db)):
    """Receive a TradingView alert and execute it on Binance (or paper).

    TradingView sends the alert message body as raw text; we parse JSON. The
    payload MUST include the shared secret to be accepted.
    """
    engine = get_engine()
    raw = (await request.body()).decode("utf-8", errors="replace")

    # Parse + validate.
    try:
        data = json.loads(raw)
        signal = TradingViewSignal(**data)
    except Exception as exc:
        _log_signal(db, "tradingview", None, None, raw, False, f"parse error: {exc}")
        raise HTTPException(status_code=400, detail=f"Invalid signal payload: {exc}")

    if not hmac.compare_digest(signal.secret, engine.settings.tradingview_webhook_secret):
        _log_signal(db, "tradingview", signal.symbol, signal.action, raw, False, "bad secret")
        raise HTTPException(status_code=401, detail="Invalid webhook secret")

    accepted, message, trade = await asyncio.to_thread(
        engine.execute_signal,
        db,
        action=signal.action,
        symbol=signal.symbol,
        amount=signal.amount,
        stop_loss=signal.stop_loss,
        take_profit=signal.take_profit,
        source="tradingview",
        note=signal.note,
        limit_price=signal.limit_price,
    )
    _log_signal(db, "tradingview", signal.symbol, signal.action, raw, accepted, message)
    await broadcaster.broadcast(
        {"event": "signal", "data": {"source": "tradingview", "action": signal.action,
                                     "symbol": signal.symbol, "accepted": accepted,
                                     "message": message}}
    )
    return ExecutionResult(
        accepted=accepted, message=message,
        trade=TradeOut.model_validate(trade) if trade else None,
    )


def _log_signal(db, source, symbol, action, raw, accepted, message) -> None:
    db.add(
        SignalLog(
            source=source, symbol=symbol, action=action, raw=raw,
            accepted=1 if accepted else 0, message=message,
        )
    )
    db.commit()


# ---- Manual orders -------------------------------------------------


@app.post("/api/order", response_model=ExecutionResult)
async def manual_order(
    order: ManualOrder,
    db: Session = Depends(get_db),
    _: None = Depends(require_api_key),
):
    engine = get_engine()
    accepted, message, trade = await asyncio.to_thread(
        engine.execute_signal,
        db,
        action=order.action,
        symbol=order.symbol,
        amount=order.amount,
        stop_loss=order.stop_loss,
        take_profit=order.take_profit,
        source="manual",
        note="manual order",
        limit_price=order.limit_price,
    )
    await broadcaster.broadcast(
        {"event": "signal", "data": {"source": "manual", "action": order.action,
                                     "symbol": order.symbol, "accepted": accepted,
                                     "message": message}}
    )
    return ExecutionResult(
        accepted=accepted, message=message,
        trade=TradeOut.model_validate(trade) if trade else None,
    )


@app.post("/api/trades/{trade_id}/close", response_model=ExecutionResult)
async def close_trade(
    trade_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(require_api_key),
):
    engine = get_engine()
    trade = db.get(Trade, trade_id)
    if not trade or trade.status not in (
        TradeStatus.open.value,
        TradeStatus.pending.value,
    ):
        raise HTTPException(status_code=404, detail="Open trade not found")
    accepted, message, updated = await asyncio.to_thread(
        engine.execute_signal,
        db,
        action="close",
        symbol=trade.symbol,
        amount=None,
        stop_loss=None,
        take_profit=None,
        source="manual",
        note="manual close",
    )
    return ExecutionResult(
        accepted=accepted, message=message,
        trade=TradeOut.model_validate(updated) if updated else None,
    )


# ---- Trades & signals ----------------------------------------------


@app.get("/api/trades", response_model=list[TradeOut])
def list_trades(status: str | None = None, limit: int = 100, db: Session = Depends(get_db)):
    stmt = select(Trade).order_by(Trade.opened_at.desc()).limit(min(limit, 500))
    if status:
        stmt = select(Trade).where(Trade.status == status).order_by(
            Trade.opened_at.desc()
        ).limit(min(limit, 500))
    return list(db.scalars(stmt).all())


@app.get("/api/signals", response_model=list[SignalOut])
def list_signals(limit: int = 50, db: Session = Depends(get_db)):
    stmt = select(SignalLog).order_by(SignalLog.created_at.desc()).limit(min(limit, 200))
    return list(db.scalars(stmt).all())


# ---- Status & settings ---------------------------------------------


@app.get("/api/status", response_model=BotStatus)
def status(db: Session = Depends(get_db)):
    return get_engine().status(db)


@app.post("/api/bot/{state}")
def set_bot_state(state: str, _: None = Depends(require_api_key)):
    engine = get_engine()
    if state == "start":
        engine.running = True
    elif state == "stop":
        engine.running = False
    else:
        raise HTTPException(status_code=400, detail="state must be 'start' or 'stop'")
    return {"running": engine.running}


@app.get("/api/settings", response_model=SettingsOut)
def get_settings_endpoint():
    engine = get_engine()
    s = engine.settings
    return SettingsOut(
        trading_mode=s.trading_mode,
        binance_testnet=s.binance_testnet,
        max_open_positions=s.max_open_positions,
        risk_per_trade_pct=s.risk_per_trade_pct,
        daily_loss_limit_pct=s.daily_loss_limit_pct,
        default_stop_loss_pct=s.default_stop_loss_pct,
        default_take_profit_pct=s.default_take_profit_pct,
        trailing_stop_pct=s.trailing_stop_pct,
        max_total_exposure_pct=s.max_total_exposure_pct,
        min_signal_confidence=s.min_signal_confidence,
        auto_trade_enabled=s.auto_trade_enabled,
        auto_symbols=s.auto_symbols,
        auto_timeframe=s.auto_timeframe,
        auto_confirm_timeframe=s.auto_confirm_timeframe,
        ai_enabled=bool(s.ai_api_key),
        ai_model=s.ai_model,
        ai_style=get_ai()._style() if s.ai_api_key else "",
        notifications_enabled=engine.notifier.enabled,
        api_key_set=bool(s.api_key),
        webhook_path=WEBHOOK_PATH,
        webhook_secret_set=bool(s.tradingview_webhook_secret
                                and s.tradingview_webhook_secret != "change-me"),
    )


@app.patch("/api/settings", response_model=SettingsOut)
def update_settings(
    update: SettingsUpdate,
    db: Session = Depends(get_db),
    _: None = Depends(require_api_key),
):
    engine = get_engine()
    s = engine.settings
    data = update.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(s, key, value)
    engine.apply_settings(s)
    # Persist the overrides so they survive a restart.
    engine.persist_settings(db, data)
    return get_settings_endpoint()


# ---- Market data ----------------------------------------------------


@app.get("/api/ticker/{symbol:path}", response_model=TickerOut)
def ticker(symbol: str):
    engine = get_engine()
    try:
        t = engine.connector.fetch_ticker(symbol.upper())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Ticker unavailable: {exc}")
    return TickerOut(
        symbol=symbol.upper(),
        last=float(t.get("last") or t.get("close") or 0),
        bid=t.get("bid"),
        ask=t.get("ask"),
        percentage=t.get("percentage"),
    )


@app.get("/api/ohlcv/{symbol:path}")
def ohlcv(symbol: str, timeframe: str = "1h", limit: int = 200):
    engine = get_engine()
    try:
        raw = engine.connector.fetch_ohlcv(symbol.upper(), timeframe, min(limit, 1000))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OHLCV unavailable: {exc}")
    return [
        {"time": int(c[0] / 1000), "open": c[1], "high": c[2],
         "low": c[3], "close": c[4], "volume": c[5]}
        for c in raw
    ]


# ---- Backtesting ----------------------------------------------------


@app.get("/api/backtest")
def backtest(
    symbol: str,
    strategy: str = "ma_cross",
    timeframe: str = "1h",
    limit: int = 500,
    starting_balance: float = 10_000.0,
    fee_pct: float = 0.1,
    slippage_pct: float = 0.05,
):
    engine = get_engine()
    try:
        raw = engine.connector.fetch_ohlcv(symbol.upper(), timeframe, min(limit, 1000))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OHLCV unavailable: {exc}")
    if not raw:
        raise HTTPException(status_code=502, detail="No candle data returned")
    df = pd.DataFrame(
        raw, columns=["timestamp", "open", "high", "low", "close", "volume"]
    )
    try:
        strat = build_strategy(strategy)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    result = run_backtest(
        df,
        strat,
        starting_balance=starting_balance,
        fee_pct=fee_pct,
        slippage_pct=slippage_pct,
    )
    return {
        "symbol": symbol.upper(),
        "strategy": strategy,
        "timeframe": timeframe,
        "starting_balance": result.starting_balance,
        "ending_balance": round(result.ending_balance, 2),
        "total_return_pct": round(result.total_return_pct, 2),
        "num_trades": result.num_trades,
        "win_rate_pct": round(result.win_rate_pct, 2),
        "max_drawdown_pct": round(result.max_drawdown_pct, 2),
        "total_fees": result.total_fees,
        "equity_curve": [round(e, 2) for e in result.equity_curve],
    }


# ---- Market analysis ("the brain") & AI ----------------------------


@app.get("/api/analyze/{symbol:path}")
def analyze(symbol: str, timeframe: str = "1h", explain: bool = False, assess: bool = False):
    """Run the multi-indicator analyzer and return a confidence-scored verdict.

    Set explain=true to also get a natural-language narration, or assess=true for
    a deeper risk-first assessment (signal quality, risks, scenarios, sizing).
    Both use the AI layer if configured, otherwise the deterministic summary.
    """
    analysis = _analysis_for(symbol, timeframe)
    result = analysis.as_dict()
    if explain:
        result["narration"] = get_ai().narrate(analysis)
        result["ai_enabled"] = get_ai().available
    if assess:
        result["assessment"] = get_ai().assess(analysis)
        result["ai_enabled"] = get_ai().available
    return result


@app.post("/api/ai/ask")
def ai_ask(payload: dict, db: Session = Depends(get_db)):
    """Ask a free-form market question, grounded in current analysis if a symbol
    is provided. Requires AI_API_KEY to be configured."""
    question = str(payload.get("question", "")).strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")
    symbol = payload.get("symbol")
    timeframe = payload.get("timeframe", "1h")
    analysis = _analysis_for(symbol, timeframe) if symbol else None
    answer = get_ai().ask(question, analysis)
    return {"answer": answer, "ai_enabled": get_ai().available}


# ---- Strategies & training -----------------------------------------


@app.get("/api/strategies")
def strategies():
    """List available strategies and their tunable parameter grids."""
    return [
        {"name": name, "params": PARAM_GRIDS.get(name, {})}
        for name in STRATEGY_REGISTRY
    ]


@app.post("/api/train")
def train_strategy(
    symbol: str,
    strategy: str = "ma_cross",
    timeframe: str = "1h",
    limit: int = 500,
    starting_balance: float = 10_000.0,
    fee_pct: float = 0.1,
    slippage_pct: float = 0.05,
    _: None = Depends(require_api_key),
):
    """Teach the bot: grid-search a strategy's parameters on real candles and
    return the best-performing configuration plus a leaderboard."""
    engine = get_engine()
    if strategy not in STRATEGY_REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown strategy '{strategy}'")
    try:
        raw = engine.connector.fetch_ohlcv(symbol.upper(), timeframe, min(limit, 1000))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OHLCV unavailable: {exc}")
    if not raw:
        raise HTTPException(status_code=502, detail="No candle data returned")
    df = pd.DataFrame(
        raw, columns=["timestamp", "open", "high", "low", "close", "volume"]
    )
    try:
        report = train(
            df, strategy, symbol=symbol.upper(), timeframe=timeframe,
            starting_balance=starting_balance, fee_pct=fee_pct,
            slippage_pct=slippage_pct,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "symbol": report.symbol,
        "strategy": report.strategy,
        "timeframe": report.timeframe,
        "candles": report.candles,
        "tested": report.tested,
        "train_fraction": report.train_fraction,
        "warning": report.warning,
        "best": report.best.__dict__ if report.best else None,
        "leaderboard": [c.__dict__ for c in report.leaderboard],
    }


# ---- WebSocket ------------------------------------------------------


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await broadcaster.connect(ws)
    try:
        # Send an immediate status snapshot on connect.
        from app.database import SessionLocal

        db = SessionLocal()
        try:
            await ws.send_json({"event": "status", "data": get_engine().status(db)})
        finally:
            db.close()
        while True:
            # Keep the connection alive; ignore inbound messages (ping/pong).
            await ws.receive_text()
    except WebSocketDisconnect:
        await broadcaster.disconnect(ws)
    except Exception:
        await broadcaster.disconnect(ws)
